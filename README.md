# Damla

**Non-custodial recurring XLM purchases on Stellar. No smart contract. One signature.**

🌐 **Live:** [damla-lake.vercel.app](https://damla-lake.vercel.app) · 📖 **Docs:** [damla-lake.vercel.app/docs.html](https://damla-lake.vercel.app/docs.html) · ❓ **FAQ:** [damla-lake.vercel.app/faq.html](https://damla-lake.vercel.app/faq.html)

> *"Damlaya damlaya göl olur."* — Turkish proverb: drop by drop, a lake is formed.

Damla lets a user say **"buy 100 USDC worth of XLM every week"** and walk away. The user signs once; after that, weekly USDC→XLM purchases execute automatically on Stellar's DEX. Funds never leave the user's account until each purchase settles, and no smart contract ever holds custody or authority.

## Why

Recurring buys (DCA) are one of the most used retail features on Coinbase and Binance, yet there is no self-custodial, on-chain equivalent. On most chains small weekly purchases are uneconomical because of gas; on Stellar a transaction costs a fraction of a cent, so small and frequent buying is economical for the first time. A scan of the Stellar ecosystem directory (900+ projects) found scheduled *payments* and generic automation primitives, but no product doing recurring *purchases*.

## How it works (no contract, by design)

Damla uses **pre-signed transaction chains** on classic Stellar. No Soroban, no C-address, works today with Freighter and a regular G-address.

The user signs a 12-week plan in one sitting. Each weekly transaction is a `PathPaymentStrictSend` (fixed USDC in, XLM out, `destMin` floor) wrapped in protocol-level timing constraints:

- **`minSeqAge`** makes each transaction invalid until enough time has passed since the source account's sequence number last moved. The weekly cadence is enforced by the protocol, not by our code.
- **`minSeqNum`** defines a sequence range so that a skipped week does not break the chain; executing any transaction in the chain automatically invalidates the earlier ones.
- **Channel account:** the transaction's *source* is a service-owned channel account, while the *operation's* source is the user. The channel account is used for nothing else, so its sequence clock stays clean; the user's own activity can never delay their DCA. The channel pays fees and never holds user funds.

### Security model

There is no contract to audit because there is no contract. Even a fully compromised trigger service:

- cannot submit early (`minSeqAge` + time bounds; the protocol rejects it),
- cannot change the amount, asset, or destination (they are inside the signed hash),
- cannot touch anything else in the account,
- can at worst *not* submit, in which case no purchase happens and no funds are lost.

The only residual risk is unfavorable timing within the allowed window, bounded by the user's own `destMin`.

## Components

1. **Planner UI** — builds the weekly plan and collects the pre-signatures (Freighter).
2. **Trigger service** — stores the signed XDRs and submits each one when its window opens.
3. **Skip/failure logic** — handles missed and failed weeks (e.g. `destMin` not met) without breaking the chain.

## Status

Early development. Target proof: a user signs once, and four consecutive weekly USDC→XLM purchases execute automatically on **testnet**, with all four transaction hashes published.

## Open problem

`destMin` (slippage floor) must be fixed at signing time, weeks in advance. Too loose risks bad fills; too tight skips purchases. Candidate designs: a wide band derived from the price at signing with skipped-week rollover, or a monthly re-sign cadence ("sign once a month, buy every week"). This is the core engineering question of the project.

## License

MIT
