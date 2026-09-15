# Damla testnet proof

Run: 2026-09-15T14:43:36.818Z  
User: `GAJX2UFEXT6YJAZTYA63XGACV42KIDIJ3PWHBKTJBEORZCRW43UCEA6Y` (throwaway, created for this run)

Setup: USDC trustline + bought 100 test USDC on the testnet DEX: [a6a21010fcc1f12eee9bcb0eff34f2cba94b45ae507bdca756b297f23e0f574d](https://stellar.expert/explorer/testnet/tx/a6a21010fcc1f12eee9bcb0eff34f2cba94b45ae507bdca756b297f23e0f574d)

## Plan

- 10 USDC -> XLM, every minute, 4 purchases, ceiling +50%
- quote at signing: 10.0000000 XLM for 10 USDC, floor (destMin): 6.6666666 XLM
- channel account: `GBZSC2DEIIXFXCQXNFPLXDPKFLGXKDPTRHNH3APTYXM3SZNLTJTT25MA` (fresh, funded by friendbot), start sequence 20151853408845824
- t0 = 1789483487 (2026-09-15T14:44:47.000Z)

| # | seq | minSeqNum | minSeqAge | window (unix) | hash |
|---|---|---|---|---|---|
| 1 | 20151853408845825 | 20151853408845824 | 0s | 1789483487 .. 1789483607 | `a24fb55d9597989511e01b1392c60c3d6e4d2eb02ced8ff3f12b11027f9df1c7` |
| 2 | 20151853408845826 | 20151853408845824 | 60s | 1789483547 .. 1789483667 | `5fd59d694239539c6bace1be20255ecce1daa5162d37d9e6c0cb1d10d6aa17aa` |
| 3 | 20151853408845827 | 20151853408845824 | 60s | 1789483607 .. 1789483727 | `35ae1760ae8eb37f37a1e6f2925fee16952f0b1ce211f92712ec8743e53929f3` |
| 4 | 20151853408845828 | 20151853408845824 | 60s | 1789483667 .. 1789483787 | `36e218db8efac6394f05cb72785e231e9df68b29035dcf0c8221d43cb04933da` |

## Negative checks (before the plan is activated)

- purchase #2 submitted at 1789483434 (window opens 1789483547): network answered `tx_too_early` ✅
- tampered envelope (amount 10 -> 50, original signatures reused): network answered `tx_bad_auth` ✅
- finalize with a swapped envelope: server answered `transaction #1 was altered` ✅

Plan activated at 1789483435. Channel key destroyed: true.

## Execution log

- 14:45:02 [5eaa6a97] #1 success ledger 4691983 received 10.0000000 XLM hash a24fb55d9597989511e01b1392c60c3d6e4d2eb02ced8ff3f12b11027f9df1c7
- 14:46:12 [5eaa6a97] #2 success ledger 4691997 received 10.0000000 XLM hash 5fd59d694239539c6bace1be20255ecce1daa5162d37d9e6c0cb1d10d6aa17aa
- 14:47:22 [5eaa6a97] #3 success ledger 4692011 received 10.0000000 XLM hash 35ae1760ae8eb37f37a1e6f2925fee16952f0b1ce211f92712ec8743e53929f3
- 14:48:32 [5eaa6a97] #4 success ledger 4692025 received 10.0000000 XLM hash 36e218db8efac6394f05cb72785e231e9df68b29035dcf0c8221d43cb04933da

## Result

| # | status | ledger | received XLM | note | hash |
|---|---|---|---|---|---|
| 1 | success | 4691983 | 10.0000000 |  | [a24fb55d9597…](https://stellar.expert/explorer/testnet/tx/a24fb55d9597989511e01b1392c60c3d6e4d2eb02ced8ff3f12b11027f9df1c7) |
| 2 | success | 4691997 | 10.0000000 |  | [5fd59d694239…](https://stellar.expert/explorer/testnet/tx/5fd59d694239539c6bace1be20255ecce1daa5162d37d9e6c0cb1d10d6aa17aa) |
| 3 | success | 4692011 | 10.0000000 |  | [35ae1760ae8e…](https://stellar.expert/explorer/testnet/tx/35ae1760ae8eb37f37a1e6f2925fee16952f0b1ce211f92712ec8743e53929f3) |
| 4 | success | 4692025 | 10.0000000 |  | [36e218db8efa…](https://stellar.expert/explorer/testnet/tx/36e218db8efac6394f05cb72785e231e9df68b29035dcf0c8221d43cb04933da) |

- a second co-signed envelope for slot #1 (same sequence S0+1, open time window, different memo), submitted after the slot was consumed: network answered `tx_bad_seq` ✅

User balances at the end: {"xlm":"9955.6319499","usdcTrustline":true,"usdc":"60.0000000"}

Plan status: completed. Merge tx (returns channel reserve to treasury) becomes valid at 1789483847.

## Fee-bump proof (2026-09-15T15:28:23.026Z)

Purchase envelope signed by user `GCNWGTWOHOFVITDVJG7KKJ6BPJPMUXU75CB3PXBHYYX6AXEMJVN47D2I` and channel `GCCBAVD4Q64U4FF7Q3AK6LE7BS4ZZOU3TLEZQ4O6HWOLNCPWJICKG4N5`, fee deliberately set to 50 stroops (network minimum is 100). Inner hash `4a06c412b2a6ee5f9bd681c159b1065ae1ebe5d5dd7225fe3c2745113fd918d8`.

- plain submission: network answered `tx_insufficient_fee` ✅
- tx_insufficient_fee, retrying with a treasury fee bump at 1000000 stroops/op
- fee-bumped submission: ledger 4692504, bumped=true, outer hash [c71e502375d8…](https://stellar.expert/explorer/testnet/tx/c71e502375d8773a5b75855d7bf1cca216dec3a13090579348c91517ee524cb8), user received 10.0000000 XLM ✅
- Horizon resolves the unchanged inner hash too: HTTP 200. No user signature was needed; every precondition of the inner transaction still applied.
