# Four-purchase skip proof on Stellar testnet

Run: 2026-09-30T03:10:44.563Z
User: `GA5VNXDB6DXR7G2LPNA3VWNW3T2NU6CQEHKKDZN26EN5FHLYF2RGGJEI` (throwaway testnet account)

Setup trustline + 30 test USDC: [61995c47044359ffdf5adc756b2d4ee6fafebbaba9392b8a783b6078d0e67704](https://stellar.expert/explorer/testnet/tx/61995c47044359ffdf5adc756b2d4ee6fafebbaba9392b8a783b6078d0e67704)

Plan: `b5911bf6bb95d13a5f33ed7cfe969a20`, channel `GCW7AQ6UXGSEQBZDX4HIEYD6F2COTFYMQ5SKBITJONJPE5EEWSVGQQML`, 5 test USDC every minute, four purchases. Floor: 30.8641974 XLM.

- 2026-09-30T03:12:07.733Z [b5911bf6] #1 success ledger 4942868 received 46.2962962 XLM hash f52cd4782d9fb5bd3a6bbfd72651387a13d1bd0d5a0eae0ab1aaaaa6e0c2e405

Paused the trigger after #1. Purchase #2 closes at 2026-09-30T03:14:52.000Z; no submission is made during its window.
Resumed at 2026-09-30T03:15:00.750Z.
- 2026-09-30T03:15:07.204Z [b5911bf6] #3 success ledger 4942904 received 46.2962962 XLM hash 6279eef12ea418720c085c3e3160099c80a579bb344ad7e032af9074a57bde25
- 2026-09-30T03:16:22.693Z [b5911bf6] #4 success ledger 4942919 received 46.2962962 XLM hash 434aaba384449673017dba78742a121b6943328a055e3022acf7abe648503112

## Result

| Purchase | Status | Hash / network evidence | Ledger | XLM received |
|---|---|---|---:|---:|
| #1 | success | [f52cd4782d9fb5bd3a6bbfd72651387a13d1bd0d5a0eae0ab1aaaaa6e0c2e405](https://stellar.expert/explorer/testnet/tx/f52cd4782d9fb5bd3a6bbfd72651387a13d1bd0d5a0eae0ab1aaaaa6e0c2e405) | 4942868 | 46.2962962 |
| #2 | expired; window closed with no submission | signed hash `6105d77fb7d5b7e297209d3a7f276d28d795b8f6e6b4c7f81623d6e0829d04cf` (not an on-chain transaction) | — | — |
| #3 | success | [6279eef12ea418720c085c3e3160099c80a579bb344ad7e032af9074a57bde25](https://stellar.expert/explorer/testnet/tx/6279eef12ea418720c085c3e3160099c80a579bb344ad7e032af9074a57bde25) | 4942904 | 46.2962962 |
| #4 | success | [434aaba384449673017dba78742a121b6943328a055e3022acf7abe648503112](https://stellar.expert/explorer/testnet/tx/434aaba384449673017dba78742a121b6943328a055e3022acf7abe648503112) | 4942919 | 46.2962962 |

Horizon transaction lookup for skipped #2 signed hash `6105d77fb7d5b7e297209d3a7f276d28d795b8f6e6b4c7f81623d6e0829d04cf` returned HTTP 404; no on-chain purchase exists for that slot.

The local trigger used the same `createTrigger` implementation as the service. #2 was deliberately not submitted; #3 and #4 succeeded despite its gap. The three successful hash links can be checked on a public testnet explorer. This is an accelerated testnet run, not a recording of the deployed service or a Freighter UI session.
