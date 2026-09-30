/**
 * Real-testnet skip proof. Run the production trigger code locally, pause it
 * deliberately through purchase #2's window, then show #3 and #4 still land.
 * No real funds or private keys are written to the evidence document.
 */
import { writeFileSync } from 'node:fs'
import { Asset, Keypair, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { openDb } from '../src/db.js'
import { friendbot, server, transactionOrNull, usdcAsset } from '../src/horizon.js'
import { createDraft, finalize, publicPlan } from '../src/plan.js'
import { createTrigger } from '../src/trigger.js'

const net = NETWORKS.testnet
net.treasurySecret = null // use Friendbot; this proof does not need a treasury secret
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => Math.floor(Date.now() / 1000)
const db = openDb(':memory:')
const user = Keypair.random()
const lines = []
const say = (line) => { console.log(line); lines.push(line) }
const txLink = (hash) => `${net.explorer}/tx/${hash}`

try {
  say(`# Four-purchase skip proof on Stellar testnet\n\nRun: ${new Date().toISOString()}  \nUser: \`${user.publicKey()}\` (throwaway testnet account)\n`)
  await friendbot(net, user.publicKey())
  const account = await server(net).loadAccount(user.publicKey())
  const setup = new TransactionBuilder(account, { fee: '1000', networkPassphrase: net.passphrase })
    .addOperation(Operation.changeTrust({ asset: usdcAsset(net) }))
    .addOperation(Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '5000', destination: user.publicKey(), destAsset: usdcAsset(net), destAmount: '30', path: [] }))
    .setTimeout(120).build()
  setup.sign(user)
  const setupResult = await server(net).submitTransaction(setup)
  say(`Setup trustline + 30 test USDC: [${setupResult.hash}](${txLink(setupResult.hash)})`)

  const draft = await createDraft(db, { network: 'testnet', user: user.publicKey(), amount: '5', every: 1, unit: 'minutes', count: 4, ceiling: 50 })
  say(`\nPlan: \`${draft.id}\`, channel \`${draft.channel}\`, 5 test USDC every minute, four purchases. Floor: ${draft.destMin} XLM.\n`)
  const signed = draft.txs.map((item) => {
    const tx = new Transaction(item.xdr, net.passphrase)
    tx.sign(user)
    return { idx: item.idx, xdr: tx.toXDR() }
  })
  finalize(db, draft.id, signed)
  const trigger = createTrigger(db, { log: (message) => say(`- ${new Date().toISOString()} ${message}`) })

  async function until(predicate, deadline) {
    while (now() < deadline) {
      await trigger.tick()
      const buys = publicPlan(db, draft.id).txs.filter((tx) => tx.kind === 'buy')
      if (predicate(buys)) return buys
      await sleep(5000)
    }
    throw new Error(`timed out: ${JSON.stringify(publicPlan(db, draft.id).txs.map((tx) => [tx.idx, tx.status, tx.note]))}`)
  }

  await until((buys) => buys[0].status === 'success', draft.txs[0].maxTime)
  say(`\nPaused the trigger after #1. Purchase #2 closes at ${new Date(draft.txs[1].maxTime * 1000).toISOString()}; no submission is made during its window.`)
  const resumeAt = draft.txs[1].maxTime + 8
  if (now() < resumeAt) await sleep((resumeAt - now()) * 1000)
  say(`Resumed at ${new Date().toISOString()}.`)
  const final = await until((buys) => buys.every((tx) => tx.status !== 'pending'), draft.txs[3].maxTime)
  const actual = final.map((tx) => tx.status)
  if (JSON.stringify(actual) !== JSON.stringify(['success', 'expired', 'success', 'success'])) throw new Error(`unexpected statuses: ${actual.join(', ')}`)

  say('\n## Result\n\n| Purchase | Status | Hash / network evidence | Ledger | XLM received |\n|---|---|---|---:|---:|')
  for (const tx of final) {
    if (tx.status === 'success') {
      const res = await transactionOrNull(net, tx.hash)
      if (!res.successful) throw new Error(`Horizon reports failed transaction ${tx.hash}`)
      say(`| #${tx.idx} | ${tx.status} | [${tx.hash}](${txLink(tx.hash)}) | ${res.ledger} | ${tx.receivedXlm ?? 'see explorer'} |`)
    } else say(`| #${tx.idx} | ${tx.status}; window closed with no submission | signed hash \`${tx.hash}\` (not an on-chain transaction) | — | — |`)
  }
  if (await transactionOrNull(net, final[1].hash)) throw new Error('skipped purchase unexpectedly appeared on-chain')
  say(`\nHorizon transaction lookup for skipped #2 signed hash \`${final[1].hash}\` returned HTTP 404; no on-chain purchase exists for that slot.`)
  say('\nThe local trigger used the same `createTrigger` implementation as the service. #2 was deliberately not submitted; #3 and #4 succeeded despite its gap. The three successful hash links can be checked on a public testnet explorer. This is an accelerated testnet run, not a recording of the deployed service or a Freighter UI session.\n')
  writeFileSync(new URL('../docs/PROOF-skip-testnet.md', import.meta.url), lines.join('\n'))
  console.log('wrote docs/PROOF-skip-testnet.md')
} finally { db.close() }
