# Damla demo-video plan: testnet transaction evidence

This is the **same plan shown in the [demo video](https://drive.google.com/file/d/17pF-nRlQNNm7dYPFDPRGXMSTNCf5jGws/view?usp=sharing)**. The recording shows plan creation, the single wallet approval, the plan page, and the first purchase's Stellar explorer page. The later transactions below were executed by the trigger after the recording; the video does not depict all ten settlements.

- Network: Stellar Testnet (test assets; no real USDC)
- Plan: `49c8fb93a76f5e06e82be374e103cba7` ([live plan page](https://damla.website/plan.html?id=49c8fb93a76f5e06e82be374e103cba7))
- User wallet: `GBZDEZ2BVJPYNRPWFC4YTPBRVWE4CRDQFAMBCKHXLHVN7UFTWVTVKXJF`
- Channel account: `GCDRFDN4APFQIUDO4NJE5HG33IMGGER57NB2F7VAU7UOP64RA3VIB4RH`
- Terms: 10 scheduled purchases, 25 test USDC each, one-minute cadence, +10% price ceiling, one wallet approval
- [Single-approval setup transaction](https://stellar.expert/explorer/testnet/tx/82fece486c0f735e857c6f17def6c8dbd3c6ffc414eecb7370be87e806dd0ab9)

| Slot | Result | Signed transaction hash / on-chain proof |
| --- | --- | --- |
| #1 | Settled, ledger 5080381 | [469219c0226db94bfa7d8d14d6f910e5a88b0cc9ff654aaadf1cf075a3f60689](https://stellar.expert/explorer/testnet/tx/469219c0226db94bfa7d8d14d6f910e5a88b0cc9ff654aaadf1cf075a3f60689) |
| #2 | Settled, ledger 5080396 | [e5fab34ecb86bf6a53265de0685c06bf56f1d8b7d99eb37c555cf10f54837dda](https://stellar.expert/explorer/testnet/tx/e5fab34ecb86bf6a53265de0685c06bf56f1d8b7d99eb37c555cf10f54837dda) |
| #3 | Settled, ledger 5080410 | [e695fc6956f05add2871bccc591e4a2743e3351ad1952f37c4fc89a80577c334](https://stellar.expert/explorer/testnet/tx/e695fc6956f05add2871bccc591e4a2743e3351ad1952f37c4fc89a80577c334) |
| #4 | Settled, ledger 5080425 | [d18e6890172c6c7bcf63a450c760fe36a5c2dd992b68f17f3e6bc76226b7a1f0](https://stellar.expert/explorer/testnet/tx/d18e6890172c6c7bcf63a450c760fe36a5c2dd992b68f17f3e6bc76226b7a1f0) |
| #5 | Settled, ledger 5080440 | [d5abe0d90ddd99d5feee4af0ddb5dbd58f03dc50d4aa7c26aa9e2b935da4bbe2](https://stellar.expert/explorer/testnet/tx/d5abe0d90ddd99d5feee4af0ddb5dbd58f03dc50d4aa7c26aa9e2b935da4bbe2) |
| #6 | Settled, ledger 5080455 | [d2040129deed64b0c797dea0bdc65b5a8bc403fe887fb9e0ad4288854abda36f](https://stellar.expert/explorer/testnet/tx/d2040129deed64b0c797dea0bdc65b5a8bc403fe887fb9e0ad4288854abda36f) |
| #7 | Settled, ledger 5080469 | [2e0dc770960c2a1f72665f2dbfd3dab96f047545f55a005c0cf18fecced316ec](https://stellar.expert/explorer/testnet/tx/2e0dc770960c2a1f72665f2dbfd3dab96f047545f55a005c0cf18fecced316ec) |
| #8 | Settled, ledger 5080484 | [dde6ddf82559cb2113d7dbd3d9772c3719b16fa1505f6586c2c6e004dc4bf1a9](https://stellar.expert/explorer/testnet/tx/dde6ddf82559cb2113d7dbd3d9772c3719b16fa1505f6586c2c6e004dc4bf1a9) |
| #9 | Expired; one submission attempt returned `tx_too_late`; **not on chain** | Pre-signed hash `a4dcced751459e6f451f5f337d5aea0192375023d37b77fb635e1f9934006490` ([Horizon lookup: 404](https://horizon-testnet.stellar.org/transactions/a4dcced751459e6f451f5f337d5aea0192375023d37b77fb635e1f9934006490)) |
| #10 | Settled **after #9 expired**, ledger 5080499 | [76f6c9f6e3f42c6ffd60868b35521990e68cdce358db1614f4880a1fed33aa72](https://stellar.expert/explorer/testnet/tx/76f6c9f6e3f42c6ffd60868b35521990e68cdce358db1614f4880a1fed33aa72) |

The [cleanup transaction](https://stellar.expert/explorer/testnet/tx/fa03462d1cb017c703da8accd2bb4d046ad172cfec0ca2f08ae614dd871c6c88) succeeded in ledger 5080500, merging the channel back to the treasury. The plan is `done`. The nine settled purchases and the missed window were independently checked against Stellar Testnet Horizon on 2026-10-08. The expired slot has a pre-signed hash but no transaction recorded on chain; the successful #10 proves that its failure did not block the chain.
