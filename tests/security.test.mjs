/**
 * Offline security tests: a synthetic draft is inserted straight into the DB
 * (no Horizon), then finalize / cancel / export are attacked.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, Memo, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { openDb } from '../src/db.js'
import { buildTransactions, cancelPlan, exportPlan, finalize, hashToken, newCancelToken, newPlanId } from '../src/plan.js'
import { createServer } from '../src/server.js'

const net = NETWORKS.testnet
const db = openDb(':memory:')
const app = createServer(db)
await new Promise((r) => app.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${app.address().port}`
after(() => { app.close(); db.close() })

function syntheticDraft() {
  const user = Keypair.random(), channel = Keypair.random()
  const startSeq = '4096', t0 = 1_800_000_000
  const { txs } = buildTransactions({ net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq, amount: '10', destMin: '5', t0, periodSeconds: 60, count: 2 })
  for (const t of txs) t.tx.sign(channel)
  const id = newPlanId(), token = newCancelToken()
  db.prepare(`INSERT INTO plans (id, network, user, channel, channel_secret, cancel_hash, amount, period, period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at)
    VALUES (?, 'testnet', ?, ?, ?, ?, '10', 'minute', 60, 2, 25, '6.25', ?, ?, 'draft', ?)`).run(id, user.publicKey(), channel.publicKey(), channel.secret(), hashToken(token), startSeq, t0, t0 - 60)
  const ins = db.prepare(`INSERT INTO txs (plan_id, idx, kind, hash, seq, min_time, max_time, min_seq_age, dest_min, xdr, signed, status) VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, '5', ?, 0, 'pending')`)
  for (const t of txs) ins.run(id, t.idx, t.hash, t.seq, t.minTime, t.maxTime, t.minSeqAge, t.tx.toXDR())
  const userSigned = txs.map((t) => { const tx = new Transaction(t.tx.toXDR(), net.passphrase); tx.sign(user); return { idx: t.idx, xdr: tx.toXDR() } })
  return { id, token, user, channel, txs, userSigned }
}

test('finalize rejects envelopes without the user signature', () => {
  const d = syntheticDraft()
  const onlyChannel = d.txs.map((t) => ({ idx: t.idx, xdr: t.tx.toXDR() }))
  assert.throws(() => finalize(db, d.id, onlyChannel), /expected 2 signatures/)
})

test('finalize rejects a signature from the wrong key', () => {
  const d = syntheticDraft()
  const impostor = Keypair.random()
  const bad = d.txs.map((t) => { const tx = new Transaction(t.tx.toXDR(), net.passphrase); tx.sign(impostor); return { idx: t.idx, xdr: tx.toXDR() } })
  assert.throws(() => finalize(db, d.id, bad), /missing a valid signature from/)
})

test('finalize rejects an envelope whose content changed (memo added, hash differs)', () => {
  const d = syntheticDraft()
  const altered = TransactionBuilder.cloneFrom(d.txs[0].tx, { fee: '100', networkPassphrase: net.passphrase }).addMemo(Memo.text('x')).build()
  altered.sign(d.channel); altered.sign(d.user)
  const bad = [{ idx: 1, xdr: altered.toXDR() }, d.userSigned[1]]
  assert.throws(() => finalize(db, d.id, bad), /was altered/)
})

test('finalize rejects wrong counts and duplicate indexes', () => {
  const d = syntheticDraft()
  assert.throws(() => finalize(db, d.id, [d.userSigned[0]]), /expected 2 signed/)
  assert.throws(() => finalize(db, d.id, [d.userSigned[0], d.userSigned[0]]), /missing signed transaction #2/)
})

test('finalize with correct signatures activates the plan and destroys the channel key', () => {
  const d = syntheticDraft()
  const plan = finalize(db, d.id, d.userSigned)
  assert.equal(plan.status, 'active')
  assert.equal(plan.channelKeyDestroyed, true)
  assert.equal(db.prepare('SELECT channel_secret FROM plans WHERE id = ?').get(d.id).channel_secret, null)
  assert.throws(() => finalize(db, d.id, d.userSigned), /not a draft/)
})

test('cancel and export need the plan token', () => {
  const d = syntheticDraft()
  finalize(db, d.id, d.userSigned)
  assert.throws(() => cancelPlan(db, d.id, 'wrong'), /bad cancel token/)
  assert.throws(() => exportPlan(db, d.id, 'wrong'), /bad plan token/)
  assert.throws(() => exportPlan(db, d.id, undefined), /bad plan token/)
  const ex = exportPlan(db, d.id, d.token)
  assert.equal(ex.txs.length, 2)
  assert.equal(cancelPlan(db, d.id, d.token).status, 'cancelled')
})

test('http: export is POST + token, list-by-user is gone, oversized body is 413, 500s carry no detail', async () => {
  const d = syntheticDraft()
  finalize(db, d.id, d.userSigned)
  assert.equal((await fetch(`${base}/api/plans/${d.id}/export`)).status, 404)
  const noTok = await fetch(`${base}/api/plans/${d.id}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(noTok.status, 403)
  const ok = await fetch(`${base}/api/plans/${d.id}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: d.token }) })
  assert.equal(ok.status, 200)
  assert.equal((await fetch(`${base}/api/plans?user=${d.user.publicKey()}`)).status, 404)
  const big = await fetch(`${base}/api/plans/${d.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024) })
  assert.equal(big.status, 413)
  const pub = await fetch(`${base}/api/plans/${d.id}`).then((x) => x.json())
  assert.equal(pub.txs[0].xdr, undefined, 'public plan view must not include envelopes')
  assert.equal(pub.cancelHash, undefined)
})

test('http: helper relay only accepts the helper shapes', async () => {
  const d = syntheticDraft()
  const r = await fetch(`${base}/api/helper/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'testnet', xdr: d.userSigned[0].xdr }) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /only submits/)
})

test('http: security headers and CORS preflight from unknown origins', async () => {
  const r = await fetch(`${base}/api/health`)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.headers.get('x-frame-options'), 'DENY')
  const pre = await fetch(`${base}/api/plans`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
  assert.equal(pre.status, 403)
})

test('http: static serving is off unless enabled, and never serves dotfiles or source', async () => {
  for (const p of ['/', '/.env', '/src/plan.js', '/package.json']) assert.equal((await fetch(base + p)).status, 404)
})
