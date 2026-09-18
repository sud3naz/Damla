import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
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
