# Damla

**Non-custodial recurring XLM purchases on Stellar. No smart contract. Sign in one sitting.**

🌐 **Live (testnet):** [damla-lake.vercel.app](https://damla-lake.vercel.app) · 📖 **Docs:** [damla-lake.vercel.app/docs.html](https://damla-lake.vercel.app/docs.html) · ❓ **FAQ:** [damla-lake.vercel.app/faq.html](https://damla-lake.vercel.app/faq.html) · ✅ **Testnet proof:** [docs/PROOF-testnet.md](docs/PROOF-testnet.md)

An additional four-purchase run with a deliberately skipped second purchase is recorded in [docs/PROOF-skip-testnet.md](docs/PROOF-skip-testnet.md). The application now uses one Freighter approval to install exact-hash pre-authorizations; [docs/PROOF-single-testnet.md](docs/PROOF-single-testnet.md) records the new path.

> *"Damlaya damlaya göl olur."* — Turkish proverb: drop by drop, a lake is formed.

Damla lets a user say **"buy 25 USDC worth of XLM every 3 days, 12 times, starting Monday"** and walk away. The user approves the plan once in Freighter; after that, USDC→XLM purchases execute automatically on Stellar's DEX. Funds never leave the user's account until each purchase settles, and no smart contract ever holds custody or authority.

## Why

Recurring buys (DCA) are one of the most used retail features on Coinbase and Binance, yet there is no self-custodial, on-chain equivalent. On most chains small weekly purchases are uneconomical because of gas; on Stellar a transaction costs a fraction of a cent, so small and frequent buying is economical for the first time. A scan of the Stellar ecosystem directory (900+ projects) found scheduled *payments* and generic automation primitives, but no product doing recurring *purchases*.

## How it works (no contract, by design)

Damla uses **pre-authorized transaction chains** on classic Stellar (CAP-21 preconditions, Protocol 19). The channel signs each future transaction and one wallet-signed setup authorizes their exact hashes. No Soroban or C-address is needed; it works with Freighter and a regular G-address.

Each plan gets a **fresh channel account** `C` with starting sequence `S0`. For purchase `i` of `N`, period `P`, start `t0`:

| field | value | why |
|---|---|---|
| source | `C` | pays the fee, owns the sequence clock; the user's own wallet activity can never delay or invalidate the chain |
| seqNum | `S0 + i` | one slot per purchase |
| `minSeqNum` | `S0` | valid for any channel sequence in `[S0, S0+i)`: a skipped purchase never blocks the next |
| `minSeqAge` | `P` (0 for `i = 1`) | invalid until the channel's sequence has been untouched for a full period: two purchases can never land closer than `P` |
| timeBounds | `[t0 + (i-1)P, t0 + (i+1)P]` | the calendar window; two periods long so a late submission is not lost |
| operation | `PathPaymentStrictSend`, **source = user**, `amount` USDC → XLM, `destMin` = floor | the exact hash the user's setup signature pre-authorizes |

Plus one cleanup transaction (`seq S0+N+1`) that removes any unused pre-authorized signers. When the service has a treasury, it also merges the channel back to the treasury. The cleanup can run immediately if the user stops the plan.

Signing flow: the server builds the envelopes and signs them with `C`; the static browser code independently decodes each purchase, cleanup and setup XDR, checks their hash linkage, terms and channel signature, and compares the floor with a direct Horizon quote. It then shows the verified terms for confirmation. One Freighter-signed setup transaction installs each exact hash as a temporary `preAuthTx` signer on the user's account. The server verifies and submits that setup, then **clears the channel key from the active database row**. Purchases need no additional wallet prompt. The user temporarily reserves 0.5 XLM per purchase plus cleanup, and single-approval plans are capped at 18 purchases by the Stellar signer limit. Freighter displays signer hashes in the setup prompt, not the full future swap details. Historical SQLite pages and backups can retain older channel keys; see [SECURITY.md](SECURITY.md).

The **floor** is not a slippage setting: DCA buyers want to keep buying as the price moves. It is a *ceiling*: the user chooses how far above today's price they are still willing to buy (+10 / +25 / +50%), and `destMin` = today's quote divided by that factor. Falling prices never block a purchase.

### Security model

There is no contract to audit because there is no contract. Even a fully compromised trigger service:

- cannot submit early (time bounds + `minSeqAge`; the protocol rejects it with `tx_too_early`),
- cannot run two purchases inside one period (`minSeqAge`),
- cannot change the amount, asset, destination or floor (`tx_bad_auth`),
- cannot touch anything else in the account (the authorized hashes contain only the reviewed purchase and cleanup operations),
- cannot build new channel transactions using the active database row after activation; retained backup copies of a draft key remain a residual risk,
- can at worst *not* submit, or pick a bad moment inside a window bounded by the user's floor.

The timing and sequence behavior is exercised against the real testnet in [`scripts/proof.mjs`](scripts/proof.mjs); the run with hashes is [docs/PROOF-testnet.md](docs/PROOF-testnet.md). The deliberate-skip run is [docs/PROOF-skip-testnet.md](docs/PROOF-skip-testnet.md). The one-approval path is tested by [`scripts/proof-single.mjs`](scripts/proof-single.mjs). Users can **export** their authorized envelopes from the plan page and submit them themselves if the service disappears.

## Components

| path | what |
|---|---|
| `index.html`, `app.js`, `review.js` | planner, independent XDR/quote review, Freighter signing and activation |
| `plan.html`, `plan-view.js` | plan page: every purchase with window, status, result hash; stop; export |
| `docs.html`, `faq.html` | documentation |
| `src/plan.js` | builds, channel-signs, verifies and stores plans (pure protocol logic) |
| `src/trigger.js` | submits each purchase when its window opens; never burns a slot on a predictable failure |
| `src/server.js` | small JSON API (`/api/*`), CORS allowlist, rate limit; optional static serving for local dev |
| `src/db.js` | SQLite via `node:sqlite` (Node ≥ 22.13, no native deps) |
| `scripts/proof.mjs` | end-to-end testnet proof |
| `tests/` | unit + API tests (`npm test`) |
| `deployment/` | systemd unit, Caddy snippet, deploy script |

## Run it

```bash
npm install
cp .env.example .env            # DAMLA_TESTNET_TREASURY_SECRET=S... (a friendbot-funded testnet key; it funds the channel accounts)
npm run dev                     # API + trigger + site on http://localhost:8944
npm test
set -a; . ./.env; set +a; npm run proof   # ~6 min, writes docs/PROOF-testnet.md
npm run proof:skip                        # ~5 min, uses Friendbot, writes docs/PROOF-skip-testnet.md
npm run proof:single                      # ~5 min, uses one simulated wallet signature, writes docs/PROOF-single-testnet.md
```

API: `GET /api/health`, `GET /api/quote`, `GET /api/account`, `POST /api/plans` (draft: `{network, user, amount, every, unit, count, ceiling, start?, mode: 'single'}`), `POST /api/plans/:id/authorize`, `POST /api/plans/:id/finalize` (legacy), `GET /api/plans/:id`, `POST /api/plans/:id/export` (requires the plan token), `POST /api/plans/:id/cancel`, `GET /api/helper/trustline`, `GET /api/helper/test-usdc`, `POST /api/helper/submit`.

## Status

Testnet: planner, signing, trigger, plan page, export, 1-minute demo cadence, test-USDC helper. Channel accounts are funded by a per-network treasury (`DAMLA_TESTNET_TREASURY_SECRET`, friendbot-fed; `DAMLA_MAINNET_TREASURY_SECRET`, 2.5 XLM per plan, merged back when the plan ends or the draft is abandoned). Mainnet also needs `DAMLA_MAINNET_ENABLED=1` and an explicit `DAMLA_MAINNET_PILOT_USERS` wallet allowlist; an empty list denies all mainnet drafts. Mainnet requires single approval and currently allows one unsigned funded draft at a time. The code defaults to a 250 USDC per-purchase beta cap; the pilot server is configured for 1 USDC. Surge pricing is handled with treasury-paid fee bumps, no user signature needed. Public opening requires an abuse-resistant draft-creation gate beyond the pilot address list. Security controls and residual risks: [SECURITY.md](SECURITY.md).

## Open question

A floor fixed for 12 weeks is crude. A monthly re-sign cadence ("sign once a month, buy every week") is the likely next step; it changes nothing in the protocol layer.

## License

MIT
