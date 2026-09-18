/**
 * Testnet proof of the Damla pattern. Creates a throwaway user, gives it test
 * USDC from the testnet DEX, builds a 4-purchase "every minute" plan through
 * the real code path, signs it the way Freighter would, and then:
 *   1. shows the protocol rejecting purchase #2 before its time (tx_too_early)
 *   2. shows a tampered envelope being rejected (tx_bad_auth)
 *   3. runs the trigger until all four purchases have landed
 *   4. shows that a consumed sequence slot invalidates the earlier envelope (tx_bad_seq)
 * Writes docs/PROOF-testnet.md with every hash.
 */
import { writeFileSync } from 'node:fs'
import { Account, Asset, Keypair, Memo, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORKS, LIMITS } from '../src/config.js'
import { openDb } from '../src/db.js'
import { balances, friendbot, loadAccountOrNull, resultCodes, server, submitXdr, usdcAsset } from '../src/horizon.js'
import { createDraft, finalize, publicPlan } from '../src/plan.js'
import { createTrigger } from '../src/trigger.js'

const net = NETWORKS.testnet
if (!net.treasurySecret) throw new Error('DAMLA_TESTNET_TREASURY_SECRET missing')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
const lines = []
const say = (s) => { console.log(s); lines.push(s) }
const link = (h) => `${net.explorer}/tx/${h}`

const db = openDb(':memory:')
const user = Keypair.random()
say(`# Damla testnet proof\n\nRun: ${new Date().toISOString()}  \nUser: \`${user.publicKey()}\` (throwaway, created for this run)\n`)

await friendbot(net, user.publicKey())
{
  const acct = await server(net).loadAccount(user.publicKey())
  const tx = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: net.passphrase })
    .addOperation(Operation.changeTrust({ asset: usdcAsset(net) }))
    .addOperation(Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '5000', destination: user.publicKey(), destAsset: usdcAsset(net), destAmount: '100', path: [] }))
    .setTimeout(120).build()
  tx.sign(user)
  const r = await server(net).submitTransaction(tx)
  say(`Setup: USDC trustline + bought 100 test USDC on the testnet DEX: [${r.hash}](${link(r.hash)})`)
}

const draft = await createDraft(db, { network: 'testnet', user: user.publicKey(), amount: '10', every: 1, unit: 'minutes', count: 4, ceiling: 50 })
say(`\n## Plan\n\n- 10 USDC -> XLM, every minute, 4 purchases, ceiling +50%\n- quote at signing: ${draft.quoteXlm} XLM for 10 USDC, floor (destMin): ${draft.destMin} XLM\n- channel account: \`${draft.channel}\` (fresh, funded by friendbot), start sequence ${draft.startSeq}\n- t0 = ${draft.t0} (${new Date(draft.t0 * 1000).toISOString()})\n`)
say('| # | seq | minSeqNum | minSeqAge | window (unix) | hash |\n|---|---|---|---|---|---|')
for (const t of draft.txs) say(`| ${t.idx} | ${t.seq} | ${draft.startSeq} | ${t.minSeqAge}s | ${t.minTime} .. ${t.maxTime} | \`${t.hash}\` |`)

// sign like Freighter would: the user adds a signature to each channel-signed envelope
const signed = draft.txs.map((t) => { const tx = new Transaction(t.xdr, net.passphrase); tx.sign(user); return { idx: t.idx, xdr: tx.toXDR() } })

say('\n## Negative checks (before the plan is activated)\n')
{
  const tx2 = new Transaction(signed[1].xdr, net.passphrase)
  try { await server(net).submitTransaction(tx2); say('- purchase #2 submitted early: UNEXPECTEDLY ACCEPTED') }
  catch (e) { const rc = resultCodes(e); say(`- purchase #2 submitted at ${now()} (window opens ${draft.txs[1].minTime}): network answered \`${rc.tx}\` ✅`) }
}
{
  // tamper: rebuild purchase #1 with the amount changed 10 -> 50 and an open window, reuse the original signatures
  const orig = new Transaction(signed[0].xdr, net.passphrase)
  const t = new TransactionBuilder(new Account(draft.channel, draft.startSeq), { fee: orig.fee, networkPassphrase: net.passphrase })
    .setMinAccountSequence(draft.startSeq)
    .setTimebounds(0, now() + 300)
    .addOperation(Operation.pathPaymentStrictSend({ source: user.publicKey(), sendAsset: usdcAsset(net), sendAmount: '50', destination: user.publicKey(), destAsset: Asset.native(), destMin: '0.0000001', path: [] }))
    .build()
  for (const sg of orig.signatures) t.signatures.push(sg)
  try { await server(net).submitTransaction(t); say('- tampered envelope (amount 10 -> 50, original signatures): UNEXPECTEDLY ACCEPTED') }
  catch (e) { const rc = resultCodes(e); say(`- tampered envelope (amount 10 -> 50, original signatures reused): network answered \`${rc.tx}\` ✅`) }
}
{
  // verifier rejects an altered envelope too
  const bad = signed.map((s, i) => i === 0 ? { idx: 1, xdr: signed[1].xdr } : s)
  try { finalize(db, draft.id, bad); say('- finalize with a swapped envelope: UNEXPECTEDLY ACCEPTED') }
  catch (e) { say(`- finalize with a swapped envelope: server answered \`${e.message}\` ✅`) }
}

// Keep a second, different envelope for slot #1 (same sequence, extra memo) signed by both keys,
// to show later that a consumed slot rejects any other envelope for good. Only possible now,
// because the channel key is destroyed at activation.
const channelSecret = db.prepare('SELECT channel_secret FROM plans WHERE id = ?').get(draft.id).channel_secret
const replay = new TransactionBuilder(new Account(draft.channel, draft.startSeq), { fee: String(net.baseFee), networkPassphrase: net.passphrase })
  .setMinAccountSequence(draft.startSeq)
  .setTimebounds(0, now() + 1800) // window kept open on purpose, so only the sequence check can reject it later
  .addMemo(Memo.text('replay'))
  .addOperation(Operation.pathPaymentStrictSend({ source: user.publicKey(), sendAsset: usdcAsset(net), sendAmount: '10', destination: user.publicKey(), destAsset: Asset.native(), destMin: draft.destMin, path: [] }))
  .build()
replay.sign(Keypair.fromSecret(channelSecret)); replay.sign(user)

const active = finalize(db, draft.id, signed)
say(`\nPlan activated at ${active.finalizedAt}. Channel key destroyed: ${active.channelKeyDestroyed}.\n`)

say('## Execution log\n')
const trigger = createTrigger(db, { log: (s) => say(`- ${new Date().toISOString().slice(11, 19)} ${s}`) })
const deadline = now() + 8 * 60
while (now() < deadline) {
  await trigger.tick()
  const p = publicPlan(db, draft.id)
  const buys = p.txs.filter((t) => t.kind === 'buy')
  if (buys.every((t) => ['success', 'failed', 'expired', 'superseded'].includes(t.status))) break
  await sleep(5000)
}

const final = publicPlan(db, draft.id)
say('\n## Result\n\n| # | status | ledger | received XLM | note | hash |\n|---|---|---|---|---|---|')
for (const t of final.txs.filter((x) => x.kind === 'buy')) say(`| ${t.idx} | ${t.status} | ${t.ledger ?? ''} | ${t.receivedXlm ?? ''} | ${t.note ?? ''} | [${t.hash.slice(0, 12)}…](${link(t.hash)}) |`)
{
  // the consumed slot rejects any other envelope for good (a fully co-signed variant of #1, same sequence)
  try { await server(net).submitTransaction(replay); say('\n- a second co-signed envelope for slot #1, submitted after the slot was consumed: UNEXPECTEDLY ACCEPTED') }
  catch (e) { const rc = resultCodes(e); say(`\n- a second co-signed envelope for slot #1 (same sequence S0+1, open time window, different memo), submitted after the slot was consumed: network answered \`${rc.tx}\` ✅`) }
  // note: re-submitting the *identical* envelope returns the original result from Horizon (deduplicated by hash), it is not re-applied
}
const acct = await loadAccountOrNull(net, user.publicKey())
say(`\nUser balances at the end: ${JSON.stringify(balances(acct, net))}\n`)
say(`Plan status: ${final.status}. Merge tx (returns channel reserve to treasury) becomes valid at ${final.txs.find((t) => t.kind === 'merge')?.minTime}.`)
writeFileSync(new URL('../docs/PROOF-testnet.md', import.meta.url), lines.join('\n') + '\n')
console.log('\nwrote docs/PROOF-testnet.md')
db.close()
