# Damla single-signature testnet proof

Run: 2026-09-30T03:29:43.115Z
User: `GBHYWXIKUFYFPI2HS7ZNXQJN2SLKNZJG3AAKHP3PM4JQIAZX6YUQ23BS` (throwaway test wallet)

Wallet funded with 100 test USDC: [e70a355136f3c8967a7b55d06adf3b9ea7502ad2bfe875b086de0315a06c9b41](https://stellar.expert/explorer/testnet/tx/e70a355136f3c8967a7b55d06adf3b9ea7502ad2bfe875b086de0315a06c9b41)

Channel: `GB7F7X7NN6D5GMJIMOKQQMQQ4CRSGGKHDD2ZFNTNLC6HQMAIITEBQSAP`
Reserve temporarily locked: 2.5 XLM
Wallet signing calls: **1**
Purchases: four × 10 USDC, one minute apart, destination = same user wallet, floor = 61.7283950 XLM

Authorization setup: [f95e054321eef9755ffd9040f3191cb9ba5b515b4e4717534467bde8ab59853e](https://stellar.expert/explorer/testnet/tx/f95e054321eef9755ffd9040f3191cb9ba5b515b4e4717534467bde8ab59853e)
Channel key cleared from active DB row: true

On-chain preAuthTx signers after setup: 5 (4 purchases + cleanup).
Purchase #2 before its window: `tx_too_early`.
- 03:31:07 [1fa5835f] #1 success ledger 4943096 received 92.5925925 XLM hash 80da2dcfbecefff615597fc2939bcafc70c9e2d9eabb34d3e6218fa08d81d673
- 03:32:17 [1fa5835f] #2 success ledger 4943110 received 92.5925925 XLM hash 51de5d92dfe5534fb98a599826b10549aec04ae2319d4dafc0309a374e4fa84d
- 03:33:27 [1fa5835f] #3 success ledger 4943124 received 92.5925925 XLM hash e21335d82eaf94fd5ca45b19403f73137347d1ba1696f6a7f74fd3c6051f197a
- 03:34:37 [1fa5835f] #4 success ledger 4943138 received 92.5925925 XLM hash 8657bfe6cdfd31400b8a94e9ba9faecc8afee98f3878864c7906ed9a06d2ac45
- 03:34:42 [1fa5835f] #5 success ledger 4943139 received null XLM hash 22de8d208c19de1a2793b89a83dddfeb6fec235c4451b8fbfd890b5ae3e9c7a3

| Purchase | Status | On-chain transaction |
|---|---|---|
| 1 | success | [80da2dcfbecefff615597fc2939bcafc70c9e2d9eabb34d3e6218fa08d81d673](https://stellar.expert/explorer/testnet/tx/80da2dcfbecefff615597fc2939bcafc70c9e2d9eabb34d3e6218fa08d81d673) |
| 2 | success | [51de5d92dfe5534fb98a599826b10549aec04ae2319d4dafc0309a374e4fa84d](https://stellar.expert/explorer/testnet/tx/51de5d92dfe5534fb98a599826b10549aec04ae2319d4dafc0309a374e4fa84d) |
| 3 | success | [e21335d82eaf94fd5ca45b19403f73137347d1ba1696f6a7f74fd3c6051f197a](https://stellar.expert/explorer/testnet/tx/e21335d82eaf94fd5ca45b19403f73137347d1ba1696f6a7f74fd3c6051f197a) |
| 4 | success | [8657bfe6cdfd31400b8a94e9ba9faecc8afee98f3878864c7906ed9a06d2ac45](https://stellar.expert/explorer/testnet/tx/8657bfe6cdfd31400b8a94e9ba9faecc8afee98f3878864c7906ed9a06d2ac45) |

Cleanup: success, [22de8d208c19de1a2793b89a83dddfeb6fec235c4451b8fbfd890b5ae3e9c7a3](https://stellar.expert/explorer/testnet/tx/22de8d208c19de1a2793b89a83dddfeb6fec235c4451b8fbfd890b5ae3e9c7a3)
Remaining preAuthTx signers: 0.
