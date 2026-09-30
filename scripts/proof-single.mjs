/** Live Stellar testnet proof of the one-Freighter-signature protocol path. */
import { writeFileSync } from 'node:fs'
import { Account, Asset, Keypair, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { openDb } from '../src/db.js'
import { friendbot, resultCodes, server, usdcAsset } from '../src/horizon.js'
import { createDraft, publicPlan } from '../src/plan.js'
import { authorizeSingle } from '../src/single.js'
import { createTrigger } from '../src/trigger.js'

const net = NETWORKS.testnet
const db = openDb(':memory:')
const user = Keypair.random()
const lines = []
const say = (s) => { console.log(s); lines.push(s) }
const link = (hash) => `${net.explorer}/tx/${hash}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => Math.floor(Date.now() / 1000)

say(`# Damla single-signature testnet proof\n\nRun: ${new Date().toISOString()}  \nUser: \`${user.publicKey()}\` (throwaway test wallet)\n`)
await friendbot(net, user.publicKey())
const acct = await server(net).loadAccount(user.publicKey())
const seed = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: net.passphrase })
  .addOperation(Operation.changeTrust({ asset: usdcAsset(net) }))
  .addOperation(Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '5000', destination: user.publicKey(), destAsset: usdcAsset(net), destAmount: '100', path: [] }))
  .setTimeout(120).build()
seed.sign(user)
const seedResult = await server(net).submitTransaction(seed)
say(`Wallet funded with 100 test USDC: [${seedResult.hash}](${link(seedResult.hash)})`)

const draft = await createDraft(db, { network: 'testnet', user: user.publicKey(), amount: '10', every: 1, unit: 'minutes', count: 4, ceiling: 50, mode: 'single' })
say(`\nChannel: \`${draft.channel}\`  \nReserve temporarily locked: ${draft.authorization.reserveXlm} XLM  \nWallet signing calls: **1**  \nPurchases: four × 10 USDC, one minute apart, destination = same user wallet, floor = ${draft.destMin} XLM\n`)
const setup = new Transaction(draft.authorization.xdr, net.passphrase)
setup.sign(user) // exactly the one signature Freighter would add
const active = await authorizeSingle(db, draft.id, setup.toXDR())
say(`Authorization setup: [${draft.authorization.hash}](${link(draft.authorization.hash)})  \nChannel key cleared from active DB row: ${active.channelKeyDestroyed}\n`)
const signers = (await server(net).loadAccount(user.publicKey())).signers.filter((s) => s.type === 'preauth_tx')
if (signers.length !== 5) throw new Error(`expected 5 preAuthTx signers, got ${signers.length}`)
say(`On-chain preAuthTx signers after setup: ${signers.length} (4 purchases + cleanup).`)

try {
  await server(net).submitTransaction(new Transaction(draft.txs[1].xdr, net.passphrase))
  throw new Error('purchase #2 unexpectedly accepted early')
} catch (e) {
  const code = resultCodes(e).tx
  if (code !== 'tx_too_early') throw e
  say(`Purchase #2 before its window: \`${code}\`.`)
}
const channelSecret = db.prepare('SELECT channel_secret FROM plans WHERE id = ?').get(draft.id).channel_secret
if (channelSecret) throw new Error('channel secret was not burned')

const trigger = createTrigger(db, { log: (s) => say(`- ${new Date().toISOString().slice(11, 19)} ${s}`) })
const deadline = now() + 8 * 60
while (now() < deadline) {
  await trigger.tick()
  const p = publicPlan(db, draft.id)
  if (p.txs.filter((t) => t.kind === 'buy').every((t) => ['success', 'failed', 'expired', 'superseded'].includes(t.status)) && p.txs.find((t) => t.kind === 'merge')?.status === 'success') break
  await sleep(5000)
}
const final = publicPlan(db, draft.id)
say('\n| Purchase | Status | On-chain transaction |\n|---|---|---|')
for (const t of final.txs.filter((t) => t.kind === 'buy')) say(`| ${t.idx} | ${t.status} | [${t.hash}](${link(t.hash)}) |`)
const cleanup = final.txs.find((t) => t.kind === 'merge')
say(`\nCleanup: ${cleanup.status}, [${cleanup.hash}](${link(cleanup.hash)})`)
const remaining = (await server(net).loadAccount(user.publicKey())).signers.filter((s) => s.type === 'preauth_tx')
say(`Remaining preAuthTx signers: ${remaining.length}.`)
if (final.txs.filter((t) => t.kind === 'buy').some((t) => t.status !== 'success') || cleanup.status !== 'success' || remaining.length !== 0)
  throw new Error('single-signature testnet proof incomplete')
writeFileSync(new URL('../docs/PROOF-single-testnet.md', import.meta.url), lines.join('\n') + '\n')
db.close()
