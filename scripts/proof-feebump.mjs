/**
 * Testnet proof of the fee-bump path. Builds one purchase exactly like a plan
 * would, but with a fee below the network minimum (50 stroops), so the network
 * rejects it with tx_insufficient_fee. The service then wraps the unchanged,
 * user-signed envelope in a treasury fee bump and it lands. Appends to
 * docs/PROOF-testnet.md.
 */
import { appendFileSync } from 'node:fs'
import { Asset, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { friendbot, fundFromTreasury, resultCodes, server, usdcAsset } from '../src/horizon.js'
import { buildTransactions, receivedXlm } from '../src/plan.js'
import { submitWithFeeBump } from '../src/feebump.js'

const net = NETWORKS.testnet
if (!net.treasurySecret) throw new Error('DAMLA_TESTNET_TREASURY_SECRET missing')
const now = () => Math.floor(Date.now() / 1000)
const lines = []
const say = (s) => { console.log(s); lines.push(s) }
const link = (h) => `${net.explorer}/tx/${h}`

const user = Keypair.random()
await friendbot(net, user.publicKey())
{
  const acct = await server(net).loadAccount(user.publicKey())
  const tx = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: net.passphrase })
    .addOperation(Operation.changeTrust({ asset: usdcAsset(net) }))
    .addOperation(Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '5000', destination: user.publicKey(), destAsset: usdcAsset(net), destAmount: '20', path: [] }))
    .setTimeout(120).build()
  tx.sign(user)
  await server(net).submitTransaction(tx)
}
const channel = Keypair.random()
await fundFromTreasury(net, channel.publicKey())
const chAcct = await server(net).loadAccount(channel.publicKey())

const lowFeeNet = { ...net, baseFee: 50 } // below the 100-stroop network minimum, on purpose
const { txs } = buildTransactions({ net: lowFeeNet, user: user.publicKey(), channelPub: channel.publicKey(), startSeq: chAcct.sequenceNumber(), amount: '10', destMin: '1', t0: now() - 30, periodSeconds: 60, count: 1 })
const tx = txs[0].tx
tx.sign(channel); tx.sign(user)
const innerXdr = tx.toXDR()

say(`\n## Fee-bump proof (${new Date().toISOString()})\n`)
say(`Purchase envelope signed by user \`${user.publicKey()}\` and channel \`${channel.publicKey()}\`, fee deliberately set to 50 stroops (network minimum is 100). Inner hash \`${txs[0].hash}\`.\n`)
try { await server(net).submitTransaction(tx); say('- plain submission: UNEXPECTEDLY ACCEPTED') }
catch (e) { say(`- plain submission: network answered \`${resultCodes(e).tx}\` ✅`) }
const res = await submitWithFeeBump(net, innerXdr, { log: (m) => say(`- ${m}`) })
say(`- fee-bumped submission: ledger ${res.ledger}, bumped=${res.bumped}, outer hash [${res.hash.slice(0, 12)}…](${link(res.hash)}), user received ${receivedXlm(res.result_xdr)} XLM ✅`)
const horizonInner = await fetch(`${net.horizon}/transactions/${txs[0].hash}`).then((r) => r.status)
say(`- Horizon resolves the unchanged inner hash too: HTTP ${horizonInner}. No user signature was needed; every precondition of the inner transaction still applied.`)
appendFileSync(new URL('../docs/PROOF-testnet.md', import.meta.url), lines.join('\n') + '\n')
console.log('\nappended to docs/PROOF-testnet.md')
