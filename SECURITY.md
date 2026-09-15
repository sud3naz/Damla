# Security model

Damla has no smart contract. The guarantees below come from Stellar protocol rules (CAP-21 preconditions, signature checks) and from what the service deliberately cannot do. Each claim is exercised on testnet in [`scripts/proof.mjs`](scripts/proof.mjs) (latest run: [docs/PROOF-testnet.md](docs/PROOF-testnet.md)) and offline in [`tests/security.test.mjs`](tests/security.test.mjs).

## What the user signs

One `PathPaymentStrictSend` per purchase, sourced by the user, inside a transaction sourced by a fresh per-plan channel account. Amount, asset, destination, `destMin`, sequence, `minSeqNum`, `minSeqAge` and time bounds are all covered by the signature. Freighter shows the transaction; the source account it displays is the channel, the operation is the user's.

## What a fully compromised service can and cannot do

| attempt | result | enforced by |
|---|---|---|
| submit a purchase before its window | `tx_too_early` | validators, time bounds |
| submit two purchases inside one period | `tx_too_early` | validators, `minSeqAge = P` |
| change amount, asset, destination, floor, window | `tx_bad_auth` | signature covers the hash |
| re-use a consumed slot with any other envelope | `tx_bad_seq` | sequence numbers |
| build a new transaction on the channel | impossible | channel key destroyed at activation |
| touch anything else in the user's account | impossible | one operation per signature, user-sourced |
| not submit at all | purchase waits, then expires | nothing lost, USDC never moved |
| submit at a bad moment inside a window | fill no worse than `destMin` | user's floor |

The last row is the residual risk. It is bounded by the ceiling the user picks (+10 / +25 / +50% above the price at signing) and, for an honest service, reduced further because the trigger only submits when the live market already gives at least the floor.

## Service-side controls

- **Verification at activation.** Every returned envelope must hash to exactly what the service built and carry exactly two valid signatures (user + channel). Anything else is rejected before storage.
- **Channel key lifetime.** Held only between draft and activation (≤ 30 min). Destroyed on activation. An abandoned draft is merged back to the treasury immediately, while the key still exists.
- **Plan token.** Stop and export need a random 192-bit token that only the creating browser receives. Exports contain fully signed envelopes: whoever holds them can choose the moment inside each window, so they are never served without the token. There is no list-plans-by-address endpoint.
- **Treasury protection.** Draft creation funds a channel from the treasury (5 XLM on testnet, 2.5 XLM on mainnet), merged back on abandonment or after the last window. It requires an existing account with a USDC trustline and a balance covering the first purchase, allows one open draft per user (older ones are merged back), and is budgeted per IP (6/hour) and globally (60/hour) on top of the general 120 req/min limit.
- **Relay.** `/api/helper/submit` only forwards the two helper shapes (trustline, testnet USDC purchase), unsourced operations, at most two per transaction.
- **HTTP.** Bound to 127.0.0.1 behind Caddy (TLS, `X-Forwarded-For` rewritten), CORS allowlist, 256 KB body limit (1 MB for finalize), `nosniff` / `DENY` / CSP `default-src 'none'` on API responses, no internal error details. Static serving is opt-in for local development and only serves the public site files.
- **Process.** systemd: dedicated user, `ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, `PrivateTmp`, umask 077, database writable only by the service user. Secrets live in `/etc/damla/env` (root, 640), read by systemd, not by the code from disk.
- **Horizon budget.** The trigger only calls Horizon when a plan has something due (a window opening or closing, a merge), re-checks waiting purchases every 30 s, retries once on 429 and pauses for a minute if Horizon keeps rate-limiting. Draft creation returns 503 instead of failing silently when Horizon is throttling.
- **Dependencies.** One runtime dependency (`@stellar/stellar-sdk`), SQLite via `node:sqlite`, no native modules. `npm audit --omit=dev` is clean.

## Known limits

- **A failed on-chain purchase burns its slot.** The trigger avoids predictable failures (no USDC, price above ceiling) by checking before submitting, but a market move between the check and the ledger can still fail an operation. The plan continues; the purchase is marked failed.
- **The floor is fixed at signing.** Weeks-old floors are crude. Monthly re-signing is the planned answer.
- **Draft window.** A database leak during the ≤ 30-minute draft window exposes the channel key. With it an attacker can only spend the channel's own reserve or bump its sequence (which kills the plan, equivalent to "not submitting"). User funds are never reachable.
- **Testnet only today.** Mainnet needs a funded treasury; the code path is identical.

Report issues to the repository's issue tracker.
