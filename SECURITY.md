# Security model

Damla has no smart contract. The guarantees below come from Stellar protocol rules (CAP-21 preconditions, signature checks) and from what the service deliberately cannot do. Each claim is exercised on testnet in [`scripts/proof.mjs`](scripts/proof.mjs) (latest run: [docs/PROOF-testnet.md](docs/PROOF-testnet.md)) and offline in [`tests/security.test.mjs`](tests/security.test.mjs).

## What the user signs

The application creates one `PathPaymentStrictSend` per purchase, sourced by the user, inside a transaction sourced by a fresh per-plan channel account. Amount, asset, destination, `destMin`, sequence, `minSeqNum`, `minSeqAge` and time bounds are covered by each transaction hash. Before asking Freighter to sign, the static `review.js` decodes every XDR, checks the exact signer hashes and payment terms, verifies channel signatures and compares the floor against a direct Horizon quote; it shows these decoded terms for confirmation. One Freighter-signed setup transaction installs those exact hashes as `preAuthTx` signers on the user's account. Freighter shows the signer hashes in that one prompt, **not** the details of each future swap. The setup also pre-authorizes a cleanup transaction that removes unused signers. Each signer requires 0.5 XLM of temporary user reserve until consumed or removed. Single-approval plans support 2–18 purchases and require enough free signer slots and XLM.

## What a fully compromised service can and cannot do

| attempt | result | enforced by |
|---|---|---|
| submit a purchase before its window | `tx_too_early` | validators, time bounds |
| submit two purchases inside one period | `tx_too_early` | validators, `minSeqAge = P` |
| change amount, asset, destination, floor, window | `tx_bad_auth` | setup authorizes only the original transaction hash |
| re-use a consumed slot with any other envelope | `tx_bad_seq` | sequence numbers |
| build a new transaction on the channel | possible only if an older key copy is recovered | live database key cleared; historical SQLite pages or backups are a residual key-exposure risk; this cannot alter user-signed payment terms |
| touch anything else in the user's account | impossible through the installed signers | every pre-authorized hash covers exactly one purchase or cleanup transaction |
| not submit at all | purchase waits, then expires | nothing lost, USDC never moved |
| submit at a bad moment inside a window | fill no worse than `destMin` | user's floor |

The last row is the residual risk. It is bounded by the ceiling the user picks (+10 / +25 / +50% above the price at signing) and, for an honest service, reduced further because the trigger only submits when the live market already gives at least the floor.

## Service-side controls

- **Verification at activation.** The returned setup envelope must hash to exactly what the service built and carry exactly one valid wallet signature. The service submits it, confirms it on-chain, then activates the plan. The legacy individual-signature API still verifies two signatures per purchase for existing tests and plans.
- **Channel key lifetime.** A recoverable draft key is persisted before channel funding. It is cleared from the active SQLite row on activation. Expired or cancelled drafts attempt an immediate treasury merge; if Horizon cannot confirm it, cleanup retries every minute and keeps the key until recovery is confirmed. SQLite WAL pages and backups may retain historical key material, so row deletion is not secure erasure.
- **Plan token.** Stop and export need a random 192-bit token that only the creating browser receives. Exports contain channel-signed, hash-authorized envelopes: whoever holds them can choose the moment inside each window, so they are never served without the token. There is no list-plans-by-address endpoint.
- **Treasury protection.** Draft creation funds a channel from the treasury (5 XLM on testnet, 2.5 XLM on mainnet), recovered on draft cleanup or after the last window. It requires a valid plan request, an existing account with a USDC trustline and a balance covering the first purchase before the scarce draft budget is charged (6/hour/IP, 60/hour globally). Mainnet permits only one unsigned funded draft at a time. Multiple testnet drafts for one public address remain allowed; creating a new draft cannot invalidate another caller's signing flow. Friendbot-only testnet runs have no treasury to merge back to.
- **Stopping a plan.** The trigger re-reads plan and purchase state immediately before submitting. If a purchase is already in flight, the stop endpoint returns 409 so the browser can retry after its outcome is known; it does not claim that the purchase was stopped.
- **Relay.** `/api/helper/submit` forwards signed transactions containing one or two operations of the `changeTrust` or `pathPaymentStrictReceive` types, with no operation-level source. It does not constrain their assets, amounts or destinations to the two helper builders; the submitting wallet still signs and pays.
- **HTTP.** Bound to 127.0.0.1 behind Caddy (TLS, `X-Forwarded-For` rewritten), CORS allowlist, 256 KB body limit (1 MB for finalize), `nosniff` / `DENY` / CSP `default-src 'none'` on API responses, no internal error details. Static serving is opt-in for local development and only serves the public site files.
- **Process.** systemd: dedicated user, `ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, `PrivateTmp`, umask 077, database writable only by the service user. Secrets live in `/etc/damla/env` (root, 640), read by systemd, not by the code from disk.
- **Surge pricing.** The signed fee is fixed. On `tx_insufficient_fee` the trigger re-submits the unchanged envelope inside a treasury-paid fee bump (per-op fee = p80 of recent max fees, capped at 0.1 XLM). Preconditions and signatures are untouched; Horizon resolves the inner hash as before. Proven on testnet (see the fee-bump section of the proof).
- **Beta caps.** The code defaults to 250 USDC per mainnet purchase, overridable by `DAMLA_MAINNET_MAX_AMOUNT`; the pilot deployment is configured for 1 USDC. Mainnet stays off until `DAMLA_MAINNET_ENABLED=1`. Even then, `DAMLA_MAINNET_PILOT_USERS` must contain the creating wallet; an empty list denies all and `*` admits public addresses. Mainnet requires the single-approval mode.
- **Horizon budget.** The trigger only calls Horizon when a plan has something due (a window opening or closing, a merge), re-checks waiting purchases every 30 s, retries once on 429 and pauses for a minute if Horizon keeps rate-limiting. Draft creation returns 503 instead of failing silently when Horizon is throttling.
- **Dependencies.** One runtime dependency (`@stellar/stellar-sdk`), SQLite via `node:sqlite`, no native modules. `npm audit --omit=dev` is clean.

## Known limits

- **A failed on-chain purchase burns its slot.** The trigger avoids predictable failures (no USDC, price above ceiling) by checking before submitting, but a market move between the check and the ledger can still fail an operation. The plan continues; the purchase is marked failed.
- **A compromised signing page can misrepresent future swaps.** Freighter displays the `SetOptions` signer hashes, not the full transactions behind them. The independent browser verifier limits a compromised API but cannot defend against a compromised static page, altered shipped SDK or an untrusted Horizon quote. This remains weaker human review than seeing every future swap inside Freighter.
- **Unused signer reserve needs cleanup.** The pre-authorized cleanup removes unused purchase signers on plan completion or service-side cancellation. The authenticated export includes that cleanup XDR for use if the service disappears. Without an export, the user must manually remove the signers with a wallet/utility transaction to release the reserved XLM. An exported purchase envelope can be submitted by anyone within its window until its signer is removed.
- **The floor is fixed at signing.** Weeks-old floors are crude. Monthly re-signing is the planned answer.
- **Draft window and backups.** A database leak while a draft is open or cleanup is pending exposes its channel key. Backups made during that time retain copies for up to 14 days under the supplied backup policy. This key can spend the channel's own reserve or bump its sequence, but cannot sign for the user's USDC. Keep database and backups private and rotate/delete retained backups according to host policy.
- **Public pilot addresses are not authentication.** Anyone who knows an allowlisted public address and its public on-chain balances can request the one unsigned mainnet draft and temporarily occupy 2.5 treasury XLM until cleanup. They cannot activate a purchase without the wallet signature. The one-draft cap and small pilot treasury bound exposure, but this design must gain an abuse-resistant creation gate before broad public access.
- **Cancellation cannot revoke an envelope already sent to Stellar.** The service rejects a stop while its own purchase submission is in flight and prevents later service submissions after a successful stop. A previously exported envelope may still be submitted by its holder until its signer is removed.
- **Mainnet pilot only.** Mainnet currently has a funded treasury and is limited to one approved pilot wallet with a 1 USDC per-purchase cap. The allowlist is not wallet authentication; a public opening still needs an abuse-resistant draft-creation gate.

Report issues to the repository's issue tracker.
