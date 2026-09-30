import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Account, Keypair } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { openDb } from '../src/db.js'
import { server } from '../src/horizon.js'
import { abandonDraft, buildTransactions, cancelPlan, createDraft, hashToken, newCancelToken, newPlanId } from '../src/plan.js'
import { createTrigger } from '../src/trigger.js'

const net = NETWORKS.testnet

function mockedNetwork(user, { channelLoadFails = false } = {}) {
  const horizon = server(net)
  const old = { fetch: globalThis.fetch, loadAccount: horizon.loadAccount, submitTransaction: horizon.submitTransaction, transactions: horizon.transactions, treasurySecret: net.treasurySecret }
  const treasury = Keypair.random()
  net.treasurySecret = channelLoadFails ? treasury.secret() : null
  globalThis.fetch = async (url) => {
    if (String(url).includes('/paths/strict-send')) return Response.json({ _embedded: { records: [{ path: [], destination_amount: '5.0000000' }] } })
    if (String(url).includes('friendbot')) return new Response('ok')
    throw new Error(`unexpected fetch: ${url}`)
  }
  horizon.loadAccount = async (address) => {
    const acct = new Account(address, '4096')
    if (address === user.publicKey()) acct.balances = [{ asset_code: net.usdc.code, asset_issuer: net.usdc.issuer, balance: '100' }]
    else if (address !== treasury.publicKey() && channelLoadFails) throw new Error('channel load failed')
    return acct
  }
  horizon.submitTransaction = async () => ({ hash: 'test-hash', ledger: 1 })
  return {
    horizon,
    restore() {
      globalThis.fetch = old.fetch
      horizon.loadAccount = old.loadAccount
      horizon.submitTransaction = old.submitTransaction
      horizon.transactions = old.transactions
      net.treasurySecret = old.treasurySecret
    },
  }
}

test('a new draft cannot abandon an existing draft for the same public address', async () => {
  const db = openDb(':memory:')
  const user = Keypair.random()
  const mock = mockedNetwork(user)
  try {
    const params = { network: 'testnet', user: user.publicKey(), amount: '5', every: 1, unit: 'minutes', count: 2, ceiling: 25 }
    const first = await createDraft(db, params)
    const second = await createDraft(db, params)
    assert.notEqual(first.id, second.id)
    assert.equal(db.prepare('SELECT status FROM plans WHERE id = ?').get(first.id).status, 'draft')
    assert.equal(cancelPlan(db, first.id, first.cancelToken).status, 'cleanup')
    await abandonDraft(db, first.id)
    const cleaned = db.prepare('SELECT status, channel_secret FROM plans WHERE id = ?').get(first.id)
    assert.equal(cleaned.status, 'abandoned')
    assert.equal(cleaned.channel_secret, null)
  } finally { mock.restore(); db.close() }
})

test('a post-funding failure retains the channel key until merge retry succeeds', async () => {
  const db = openDb(':memory:')
  const user = Keypair.random()
  const mock = mockedNetwork(user, { channelLoadFails: true })
  try {
    const params = { network: 'testnet', user: user.publicKey(), amount: '5', every: 1, unit: 'minutes', count: 2, ceiling: 25 }
    await assert.rejects(createDraft(db, params), /channel load failed/)
    const failed = db.prepare('SELECT id, status, channel_secret FROM plans').get()
    assert.equal(failed.status, 'cleanup')
    assert.ok(failed.channel_secret, 'the recovery key must survive the failed merge')
    mock.horizon.loadAccount = async (address) => new Account(address, '4096')
    await abandonDraft(db, failed.id, Math.floor(Date.now() / 1000) + 60)
    const recovered = db.prepare('SELECT status, channel_secret FROM plans WHERE id = ?').get(failed.id)
    assert.equal(recovered.status, 'abandoned')
    assert.equal(recovered.channel_secret, null)
  } finally { mock.restore(); db.close() }
})

test('cancelling a treasury-funded unsigned draft recovers the channel immediately', async () => {
  const db = openDb(':memory:')
  const user = Keypair.random()
  const mock = mockedNetwork(user)
  net.treasurySecret = Keypair.random().secret()
  let submissions = 0
  mock.horizon.submitTransaction = async () => { submissions += 1; return { hash: 'test-hash', ledger: 1 } }
  try {
    const params = { network: 'testnet', user: user.publicKey(), amount: '5', every: 1, unit: 'minutes', count: 2, ceiling: 25 }
    const draft = await createDraft(db, params)
    assert.equal(submissions, 1, 'the treasury funded one channel')
    assert.equal(cancelPlan(db, draft.id, draft.cancelToken).status, 'cleanup')
    await abandonDraft(db, draft.id)
    assert.equal(submissions, 2, 'cleanup submitted an immediate merge')
    const plan = db.prepare('SELECT status, channel_secret FROM plans WHERE id = ?').get(draft.id)
    assert.equal(plan.status, 'abandoned')
    assert.equal(plan.channel_secret, null)
  } finally { mock.restore(); db.close() }
})

test('advanced channel sequence reconciles a submitted hash before classifying the buy', async () => {
  const db = openDb(':memory:')
  const user = Keypair.random(), channel = Keypair.random()
  const mock = mockedNetwork(user)
  try {
    const t0 = Math.floor(Date.now() / 1000) - 180
    const startSeq = '4096'
    const built = buildTransactions({ net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq, amount: '5', destMin: '1', t0, periodSeconds: 60, count: 2 })
    const id = newPlanId(), token = newCancelToken()
    db.prepare(`INSERT INTO plans (id, network, user, channel, channel_secret, cancel_hash, amount, period, period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at)
      VALUES (?, 'testnet', ?, ?, NULL, ?, '5', '1 minutes', 60, 2, 25, '5', ?, ?, 'active', ?)`).run(id, user.publicKey(), channel.publicKey(), hashToken(token), startSeq, t0, t0 - 60)
    const ins = db.prepare(`INSERT INTO txs (plan_id, idx, kind, hash, seq, min_time, max_time, min_seq_age, dest_min, xdr, signed, status, attempts)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, '1', ?, 1, ?, ?)`)
    for (const tx of built.txs) ins.run(id, tx.idx, tx.hash, tx.seq, tx.minTime, tx.maxTime, tx.minSeqAge, tx.tx.toXDR(), tx.idx === 1 ? 'pending' : 'cancelled', tx.idx === 1 ? 1 : 0)
    mock.horizon.loadAccount = async (address) => new Account(address, built.txs[0].seq)
    globalThis.fetch = async (url) => {
      if (String(url).includes('/transactions/')) return Response.json({ successful: true, ledger: 123, created_at: new Date().toISOString(), result_xdr: null })
      throw new Error(`unexpected fetch: ${url}`)
    }
    const trigger = createTrigger(db, { log: () => {} })
    await trigger.tick()
    const result = db.prepare('SELECT status, ledger FROM txs WHERE plan_id = ? AND idx = 1').get(id)
    assert.equal(result.status, 'success')
    assert.equal(result.ledger, 123)
  } finally { mock.restore(); db.close() }
})

test('an absent attempted hash is superseded after its window and finality grace', async () => {
  const db = openDb(':memory:')
  const user = Keypair.random(), channel = Keypair.random()
  const mock = mockedNetwork(user)
  const t0 = 2000000000
  let clock = t0 + 10
  try {
    const built = buildTransactions({ net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq: '4096', amount: '5', destMin: '1', t0, periodSeconds: 60, count: 2 })
    const id = newPlanId(), token = newCancelToken()
    db.prepare(`INSERT INTO plans (id, network, user, channel, channel_secret, cancel_hash, amount, period, period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at)
      VALUES (?, 'testnet', ?, ?, NULL, ?, '5', '1 minutes', 60, 2, 25, '5', '4096', ?, 'active', ?)`)
      .run(id, user.publicKey(), channel.publicKey(), hashToken(token), t0, t0 - 60)
    const ins = db.prepare(`INSERT INTO txs (plan_id, idx, kind, hash, seq, min_time, max_time, min_seq_age, dest_min, xdr, signed, status, attempts)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, '1', ?, 1, ?, ?)`)
    for (const tx of built.txs) ins.run(id, tx.idx, tx.hash, tx.seq, tx.minTime, tx.maxTime, tx.minSeqAge, tx.tx.toXDR(), tx.idx === 1 ? 'pending' : 'cancelled', tx.idx === 1 ? 1 : 0)
    mock.horizon.loadAccount = async (address) => new Account(address, built.txs[1].seq)
    globalThis.fetch = async (url) => {
      if (String(url).includes('/transactions/')) return new Response('missing', { status: 404 })
      throw new Error(`unexpected fetch: ${url}`)
    }
    const trigger = createTrigger(db, { log: () => {}, now: () => clock })
    await trigger.tick()
    assert.equal(db.prepare('SELECT status FROM txs WHERE plan_id = ? AND idx = 1').get(id).status, 'pending')
    clock = built.txs[0].maxTime + 121
    await trigger.tick()
    assert.equal(db.prepare('SELECT status FROM txs WHERE plan_id = ? AND idx = 1').get(id).status, 'superseded')
  } finally { mock.restore(); db.close() }
})

test('mainnet limits unsigned treasury exposure to one draft and requires one approval', async () => {
  const db = openDb(':memory:')
  const user = Keypair.random(), treasury = Keypair.random()
  const mainnet = NETWORKS.mainnet
  const horizon = server(mainnet)
  const old = { fetch: globalThis.fetch, loadAccount: horizon.loadAccount, submitTransaction: horizon.submitTransaction, enabled: mainnet.enabled, treasurySecret: mainnet.treasurySecret, pilotUsers: mainnet.pilotUsers }
  let fundingCalls = 0
  mainnet.enabled = true
  mainnet.treasurySecret = treasury.secret()
  mainnet.pilotUsers = [user.publicKey()]
  globalThis.fetch = async (url) => {
    if (String(url).includes('/paths/strict-send')) return Response.json({ _embedded: { records: [{ path: [], destination_amount: '5.0000000' }] } })
    throw new Error(`unexpected fetch: ${url}`)
  }
  horizon.loadAccount = async (address) => {
    const acct = new Account(address, '4096')
    if (address === user.publicKey()) {
      acct.signers = [{ key: address, weight: 1 }]
      acct.thresholds = { high_threshold: 1, med_threshold: 1 }
      acct.balances = [{ asset_type: 'native', balance: '5' }, { asset_code: 'USDC', asset_issuer: mainnet.usdc.issuer, balance: '5' }]
    }
    return acct
  }
  horizon.submitTransaction = async () => { fundingCalls++; return { hash: 'test-hash', ledger: 1 } }
  try {
    const params = { network: 'mainnet', user: user.publicKey(), amount: '1', every: 1, unit: 'hours', count: 2, ceiling: 25, mode: 'single' }
    await assert.rejects(createDraft(db, { ...params, mode: 'individual' }), /requires single approval/)
    const first = await createDraft(db, params)
    assert.equal(fundingCalls, 1)
    await assert.rejects(createDraft(db, params), /unsigned draft/)
    assert.equal(fundingCalls, 1, 'a second unsigned draft never gets treasury funding')
    assert.equal(cancelPlan(db, first.id, first.cancelToken).status, 'cleanup')
    await abandonDraft(db, first.id)
    const next = await createDraft(db, params)
    assert.ok(next.id)
    assert.equal(fundingCalls, 3, 'the first channel merged and the next was funded')
  } finally {
    globalThis.fetch = old.fetch
    horizon.loadAccount = old.loadAccount
    horizon.submitTransaction = old.submitTransaction
    mainnet.enabled = old.enabled
    mainnet.treasurySecret = old.treasurySecret
    mainnet.pilotUsers = old.pilotUsers
    db.close()
  }
})

test('stopping during a quote cannot submit or overwrite the cancelled plan', async () => {
  const db = openDb(':memory:')
  const user = Keypair.random(), channel = Keypair.random()
  const mock = mockedNetwork(user)
  const t0 = 2_000_000_000
  let releaseQuote, quoteStarted
  const started = new Promise((resolve) => { quoteStarted = resolve })
  let submissions = 0
  try {
    const built = buildTransactions({ net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq: '4096', amount: '5', destMin: '1', t0, periodSeconds: 60, count: 2 })
    const id = newPlanId(), token = newCancelToken()
    db.prepare(`INSERT INTO plans (id, network, user, channel, channel_secret, cancel_hash, amount, period, period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at)
      VALUES (?, 'testnet', ?, ?, NULL, ?, '5', '1 minutes', 60, 2, 25, '5', '4096', ?, 'active', ?)`)
      .run(id, user.publicKey(), channel.publicKey(), hashToken(token), t0, t0 - 60)
    const ins = db.prepare(`INSERT INTO txs (plan_id, idx, kind, hash, seq, min_time, max_time, min_seq_age, dest_min, xdr, signed, status)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, '1', ?, 1, 'pending')`)
    for (const tx of built.txs) ins.run(id, tx.idx, tx.hash, tx.seq, tx.minTime, tx.maxTime, tx.minSeqAge, tx.tx.toXDR())
    globalThis.fetch = async (url) => {
      if (String(url).includes('/paths/strict-send')) {
        quoteStarted()
        await new Promise((resolve) => { releaseQuote = resolve })
        return Response.json({ _embedded: { records: [{ path: [], destination_amount: '5.0000000' }] } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
    mock.horizon.submitTransaction = async () => { submissions++; return { hash: 'unexpected', ledger: 1 } }
    const trigger = createTrigger(db, { log: () => {}, now: () => t0 + 7 })
    const ticking = trigger.tick()
    await started
    assert.equal(cancelPlan(db, id, token).status, 'cancelled')
    releaseQuote()
    await ticking
    assert.equal(submissions, 0)
    assert.equal(db.prepare('SELECT status FROM plans WHERE id = ?').get(id).status, 'cancelled')
    assert.equal(db.prepare('SELECT status FROM txs WHERE plan_id = ? AND idx = 1').get(id).status, 'cancelled')
  } finally { mock.restore(); db.close() }
})

test('stop reports an in-flight purchase instead of claiming it was cancelled', async () => {
  const db = openDb(':memory:')
  const user = Keypair.random(), channel = Keypair.random()
  const mock = mockedNetwork(user)
  const t0 = 2_000_000_000
  let releaseSubmit, submitStarted
  const started = new Promise((resolve) => { submitStarted = resolve })
  try {
    const built = buildTransactions({ net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq: '4096', amount: '5', destMin: '1', t0, periodSeconds: 60, count: 2 })
    const id = newPlanId(), token = newCancelToken()
    db.prepare(`INSERT INTO plans (id, network, user, channel, channel_secret, cancel_hash, amount, period, period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at)
      VALUES (?, 'testnet', ?, ?, NULL, ?, '5', '1 minutes', 60, 2, 25, '5', '4096', ?, 'active', ?)`)
      .run(id, user.publicKey(), channel.publicKey(), hashToken(token), t0, t0 - 60)
    const ins = db.prepare(`INSERT INTO txs (plan_id, idx, kind, hash, seq, min_time, max_time, min_seq_age, dest_min, xdr, signed, status)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, '1', ?, 1, 'pending')`)
    for (const tx of built.txs) ins.run(id, tx.idx, tx.hash, tx.seq, tx.minTime, tx.maxTime, tx.minSeqAge, tx.tx.toXDR())
    mock.horizon.submitTransaction = async () => {
      submitStarted()
      await new Promise((resolve) => { releaseSubmit = resolve })
      return { hash: 'test-hash', ledger: 1, result_xdr: null }
    }
    const trigger = createTrigger(db, { log: () => {}, now: () => t0 + 7 })
    const ticking = trigger.tick()
    await started
    assert.equal(trigger.isSubmitting(id), true)
    assert.throws(() => cancelPlan(db, id, token, { isSubmitting: trigger.isSubmitting }), /being submitted/)
    assert.equal(db.prepare('SELECT status FROM plans WHERE id = ?').get(id).status, 'active')
    releaseSubmit()
    await ticking
    assert.equal(trigger.isSubmitting(id), false)
    assert.equal(cancelPlan(db, id, token, { isSubmitting: trigger.isSubmitting }).status, 'cancelled')
  } finally { mock.restore(); db.close() }
})
