/**
 * End-to-end check against a deployed Damla API (default: the VPS).
 * Creates a throwaway testnet user with USDC, builds a 2-purchase minute plan
 * through the HTTP API, signs like Freighter would, activates, and polls the
 * plan page until both purchases have run.  API=... node scripts/e2e-remote.mjs
 */
import { Asset, Keypair, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { friendbot, server, usdcAsset } from '../src/horizon.js'

const API = process.env.API || 'https://damla-api.103-244-227-82.sslip.io'
const net = NETWORKS.testnet
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const j = async (path, opts) => { const r = await fetch(API + path, opts); const b = await r.json(); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(b)}`); return b }

const user = Keypair.random()
await friendbot(net, user.publicKey())
const acct = await server(net).loadAccount(user.publicKey())
const setup = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: net.passphrase })
  .addOperation(Operation.changeTrust({ asset: usdcAsset(net) }))
  .addOperation(Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: '5000', destination: user.publicKey(), destAsset: usdcAsset(net), destAmount: '30', path: [] }))
  .setTimeout(120).build()
setup.sign(user)
await server(net).submitTransaction(setup)
console.log('user', user.publicKey(), 'funded with 30 test USDC')

console.log(await j('/api/health'))
console.log(await j(`/api/account?network=testnet&address=${user.publicKey()}`))
const draft = await j('/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'testnet', user: user.publicKey(), amount: '5', every: 1, unit: 'minutes', count: 2, ceiling: 25 }) })
console.log('draft', draft.id, 'channel', draft.channel, 'quote', draft.quoteXlm, 'floor', draft.destMin)
const signed = draft.txs.map((t) => { const tx = new Transaction(t.xdr, net.passphrase); tx.sign(user); return { idx: t.idx, xdr: tx.toXDR() } })
const plan = await j(`/api/plans/${draft.id}/finalize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed }) })
console.log('active', plan.status, 'key destroyed', plan.channelKeyDestroyed)

const deadline = Date.now() + 6 * 60 * 1000
while (Date.now() < deadline) {
  const p = await j(`/api/plans/${draft.id}`)
  const buys = p.txs.filter((t) => t.kind === 'buy')
  console.log(new Date().toISOString().slice(11, 19), buys.map((t) => `#${t.idx}:${t.status}${t.receivedXlm ? ' ' + t.receivedXlm + ' XLM' : ''}${t.note ? ' (' + t.note + ')' : ''}`).join(' | '), 'plan:', p.status)
  if (buys.every((t) => t.status !== 'pending')) { console.log('hashes', buys.map((t) => t.hash)); break }
  await sleep(10000)
}
const ex = await j(`/api/plans/${draft.id}/export`)
console.log('export ok:', ex.txs.length, 'envelopes')
const cancel = await j(`/api/plans/${draft.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: draft.cancelToken }) })
console.log('cancel with token ->', cancel.status)
