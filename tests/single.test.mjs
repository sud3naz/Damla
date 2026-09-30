import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, Transaction } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { openDb } from '../src/db.js'
import { buildSingleSetup, buildTransactions, exportPlan, hashToken } from '../src/plan.js'
import { authorizeSingle } from '../src/single.js'

function fixture(count = 4) {
  const net = NETWORKS.testnet
  const user = Keypair.random()
  const channel = Keypair.random()
  const built = buildTransactions({
    net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq: '1000',
    amount: '10', destMin: '1', t0: 2000000000, periodSeconds: 60, count, mode: 'single',
  })
  const hashes = [...built.txs, built.merge].map((t) => t.hash)
  const setup = buildSingleSetup({ net, user: user.publicKey(), userSeq: '2000', hashes, weight: 1, now: 1999999000 })
  return { net, user, channel, built, setup, hashes }
}

test('one setup envelope binds every exact purchase hash and an immediate cleanup', () => {
  const f = fixture()
  assert.equal(f.setup.tx.operations.length, 5)
  assert.deepEqual(f.setup.tx.operations.map((o) => Buffer.from(o.signer.preAuthTx).toString('hex')), f.hashes)
  assert.deepEqual(f.setup.tx.operations.map((o) => o.signer.weight), [1, 1, 1, 1, 1])
  assert.equal(f.built.merge.minTime, 0)
  assert.deepEqual(f.built.merge.tx.operations.map((o) => Buffer.from(o.signer.preAuthTx).toString('hex')), f.hashes.slice(0, -1))
  assert.ok(f.built.merge.tx.operations.every((o) => o.source === f.user.publicKey() && o.signer.weight === 0))
  assert.equal(f.built.txs[0].tx.operations[0].type, 'pathPaymentStrictSend')
})

test('authorization rejects altered XDR and wrong signatures before network submission', async () => {
  const f = fixture()
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO plans (id, network, user, channel, channel_secret, cancel_hash, amount, period, period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at, mode, setup_hash, setup_xdr)
    VALUES (?, 'testnet', ?, ?, ?, 'x', '10', '1 minutes', 60, 4, 25, '1', '1000', 2000000000, 'draft', 1999999000, 'single', ?, ?)`).run('a'.repeat(32), f.user.publicKey(), f.channel.publicKey(), f.channel.secret(), f.setup.hash, f.setup.tx.toXDR())
  const wrong = new Transaction(f.setup.tx.toXDR(), f.net.passphrase)
  wrong.sign(Keypair.random())
  await assert.rejects(authorizeSingle(db, 'a'.repeat(32), wrong.toXDR()), /one valid wallet signature/)
  const changed = buildSingleSetup({ net: f.net, user: f.user.publicKey(), userSeq: '2000', hashes: f.hashes.slice(0, -1), weight: 1, now: 1999999000 }).tx
  changed.sign(f.user)
  await assert.rejects(authorizeSingle(db, 'a'.repeat(32), changed.toXDR()), /was altered/)
  assert.equal(db.prepare('SELECT status FROM plans WHERE id = ?').get('a'.repeat(32)).status, 'draft')
  db.close()
})

test('single-plan export includes the preauthorized cleanup envelope', () => {
  const f = fixture()
  const db = openDb(':memory:')
  const id = 'b'.repeat(32), token = 'export-token'
  db.prepare(`INSERT INTO plans (id, network, user, channel, channel_secret, cancel_hash, amount, period, period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at, mode)
    VALUES (?, 'testnet', ?, ?, NULL, ?, '10', '1 minutes', 60, 4, 25, '1', '1000', 2000000000, 'active', 1999999000, 'single')`)
    .run(id, f.user.publicKey(), f.channel.publicKey(), hashToken(token))
  const ins = db.prepare(`INSERT INTO txs (plan_id, idx, kind, hash, seq, min_time, max_time, min_seq_age, xdr, signed, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending')`)
  for (const tx of [...f.built.txs, f.built.merge])
    ins.run(id, tx.idx, tx.kind, tx.hash, tx.seq, tx.minTime, tx.maxTime, tx.minSeqAge, tx.tx.toXDR())
  const exported = exportPlan(db, id, token)
  assert.equal(exported.txs.length, 4)
  assert.equal(exported.cleanup.hash, f.built.merge.hash)
  assert.equal(Buffer.from(new Transaction(exported.cleanup.xdr, f.net.passphrase).hash()).toString('hex'), f.built.merge.hash)
  db.close()
})
