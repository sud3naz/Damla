import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { openDb } from '../src/db.js'
import { server as horizon } from '../src/horizon.js'
import { hashToken, newCancelToken, newPlanId } from '../src/plan.js'
import { createServer } from '../src/server.js'

const db = openDb(':memory:')
const app = createServer(db)
await new Promise((r) => app.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${app.address().port}`
after(() => { app.close(); db.close() })

test('health lists enabled networks', async () => {
  const r = await fetch(`${base}/api/health`).then((x) => x.json())
  assert.equal(r.ok, true)
  assert.ok(r.networks.includes('testnet'))
})

test('unknown plan is 404, bad ids do not match', async () => {
  assert.equal((await fetch(`${base}/api/plans/${'a'.repeat(32)}`)).status, 404)
  assert.equal((await fetch(`${base}/api/plans/zzz`)).status, 404)
})

test('unsigned cleanup cannot stop a plan that became active', async () => {
  const id = newPlanId(), token = newCancelToken(), wallet = Keypair.random().publicKey()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`INSERT INTO plans (id, network, user, channel, cancel_hash, amount, period,
    period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'testnet', wallet, Keypair.random().publicKey(), hashToken(token), '1', '1 hours', 3600, 2, 10, '4', '1', now, 'active', now)
  const response = await fetch(`${base}/api/plans/${id}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, unsignedOnly: true }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /no longer an unsigned draft/)
  assert.equal(db.prepare('SELECT status FROM plans WHERE id = ?').get(id).status, 'active')
})

test('cors: unknown origins get no allow header, known ones do', async () => {
  const a = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } })
  assert.equal(a.headers.get('access-control-allow-origin'), null)
  const b = await fetch(`${base}/api/health`, { headers: { origin: 'https://damla-lake.vercel.app' } })
  assert.equal(b.headers.get('access-control-allow-origin'), 'https://damla-lake.vercel.app')
})

test('plan creation validates before touching the network', async () => {
  const r = await fetch(`${base}/api/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: 'testnet', user: 'nope', amount: '1', every: 1, unit: 'weeks', count: 4, ceiling: 25 }) })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /invalid user/)
})

test('invalid drafts cannot consume the shared funding budget', async () => {
  const endpoint = `${base}/api/plans`
  const body = { network: 'testnet', user: 'nope', amount: '1', every: 1, unit: 'weeks', count: 2, ceiling: 25 }
  for (let i = 0; i < 60; i++) {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${1 + Math.floor(i / 6)}` }, body: JSON.stringify(body) })
    assert.equal(r.status, 400)
  }
  const netServer = horizon(NETWORKS.testnet)
  const original = netServer.loadAccount
  netServer.loadAccount = async () => { throw { response: { status: 404 } } }
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.250' }, body: JSON.stringify({ ...body, user: Keypair.random().publicKey(), mode: 'single' }) })
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /user account does not exist/)
  } finally { netServer.loadAccount = original }
})
