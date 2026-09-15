# Damla

**Non-custodial recurring XLM purchases on Stellar. No smart contract. Sign in one sitting.**

🌐 **Live (testnet):** [damla-lake.vercel.app](https://damla-lake.vercel.app) · 📖 **Docs:** [damla-lake.vercel.app/docs.html](https://damla-lake.vercel.app/docs.html) · ❓ **FAQ:** [damla-lake.vercel.app/faq.html](https://damla-lake.vercel.app/faq.html) · ✅ **Testnet proof:** [docs/PROOF-testnet.md](docs/PROOF-testnet.md)

> *"Damlaya damlaya göl olur."* — Turkish proverb: drop by drop, a lake is formed.

Damla lets a user say **"buy 25 USDC worth of XLM every week"** and walk away. The user signs the plan in one sitting; after that, USDC→XLM purchases execute automatically on Stellar's DEX. Funds never leave the user's account until each purchase settles, and no smart contract ever holds custody or authority.

## Why

Recurring buys (DCA) are one of the most used retail features on Coinbase and Binance, yet there is no self-custodial, on-chain equivalent. On most chains small weekly purchases are uneconomical because of gas; on Stellar a transaction costs a fraction of a cent, so small and frequent buying is economical for the first time. A scan of the Stellar ecosystem directory (900+ projects) found scheduled *payments* and generic automation primitives, but no product doing recurring *purchases*.

## How it works (no contract, by design)

Damla uses **pre-signed transaction chains** on classic Stellar (CAP-21 preconditions, Protocol 19). No Soroban, no C-address; it works today with Freighter and a regular G-address.

Each plan gets a **fresh channel account** `C` with starting sequence `S0`. For purchase `i` of `N`, period `P`, start `t0`:

| field | value | why |
|---|---|---|
| source | `C` | pays the fee, owns the sequence clock; the user's own wallet activity can never delay or invalidate the chain |
| seqNum | `S0 + i` | one slot per purchase |
| `minSeqNum` | `S0` | valid for any channel sequence in `[S0, S0+i)`: a skipped purchase never blocks the next |
| `minSeqAge` | `P` (0 for `i = 1`) | invalid until the channel's sequence has been untouched for a full period: two purchases can never land closer than `P` |
| timeBounds | `[t0 + (i-1)P, t0 + (i+1)P]` | the calendar window; two periods long so a late submission is not lost |
| operation | `PathPaymentStrictSend`, **source = user**, `amount` USDC → XLM, `destMin` = floor | the only thing the user's signature authorises |

Plus one pre-signed `AccountMerge` (`seq S0+N+1`, valid after the last window) that returns the channel's 1 XLM reserve to the service.

Signing flow: the server builds the envelopes and signs them with `C`; the browser hands each one to Freighter for the user's signature; the server verifies every returned envelope (hash unchanged, exactly two valid signatures) and **destroys the channel's secret key**. From then on the only transactions that can ever exist on `C` are the ones the user co-signed.

The **floor** is not a slippage setting: DCA buyers want to keep buying as the price moves. It is a *ceiling*: the user chooses how far above today's price they are still willing to buy (+10 / +25 / +50%), and `destMin` = today's quote divided by that factor. Falling prices never block a purchase.

### Security model

There is no contract to audit because there is no contract. Even a fully compromised trigger service:

- cannot submit early (time bounds + `minSeqAge`; the protocol rejects it with `tx_too_early`),
- cannot run two purchases inside one period (`minSeqAge`),
- cannot change the amount, asset, destination or floor (`tx_bad_auth`),
- cannot touch anything else in the account (one operation per signature),
- cannot build new transactions on the channel (its key no longer exists),
- can at worst *not* submit, or pick a bad moment inside a window bounded by the user's floor.

Every claim above is exercised against the real testnet in [`scripts/proof.mjs`](scripts/proof.mjs); the latest run with hashes is [docs/PROOF-testnet.md](docs/PROOF-testnet.md). Users can **export** their signed envelopes from the plan page and submit them themselves if the service ever disappears.

## Components

| path | what |
|---|---|
| `index.html`, `app.js` | planner: quote, account checks (trustline, test USDC helper), Freighter signing, activation |
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
```

API: `GET /api/health`, `GET /api/quote`, `GET /api/account`, `POST /api/plans` (draft), `POST /api/plans/:id/finalize`, `GET /api/plans/:id`, `GET /api/plans/:id/export`, `POST /api/plans/:id/cancel`, `GET /api/helper/trustline`, `GET /api/helper/test-usdc`, `POST /api/helper/submit`.

## Status

Testnet: planner, signing, trigger, plan page, export, 1-minute demo cadence, test-USDC helper. Channel accounts are funded by a per-network treasury (`DAMLA_TESTNET_TREASURY_SECRET`, friendbot-fed; `DAMLA_MAINNET_TREASURY_SECRET`, 2.5 XLM per plan, merged back when the plan ends or the draft is abandoned). Mainnet needs only that key; the code path is identical. Security controls and residual risks: [SECURITY.md](SECURITY.md).

## Open question

A floor fixed for 12 weeks is crude. A monthly re-sign cadence ("sign once a month, buy every week") is the likely next step; it changes nothing in the protocol layer.

## License

MIT
