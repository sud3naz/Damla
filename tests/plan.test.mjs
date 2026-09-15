import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, Transaction } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { buildTransactions, floorFromQuote, schedule, validateParams, sigBytes, stroopsToAmount } from '../src/plan.js'

const net = NETWORKS.testnet
const user = Keypair.random()
const channel = Keypair.random()

test('floor = quote / (1 + ceiling%)', () => {
  assert.equal(floorFromQuote('100.0000000', 25), '80.0000000')
  assert.equal(floorFromQuote('13.5200000', 50), '9.0133333')
  assert.equal(stroopsToAmount(1n), '0.0000001')
})

test('schedule: windows are two periods long, one period apart, first has no minSeqAge', () => {
  const { windows, mergeMinTime } = schedule({ t0: 1000, periodSeconds: 60, count: 3 })
  assert.deepEqual(windows.map((w) => [w.minTime, w.maxTime, w.minSeqAge]), [[1000, 1120, 0], [1060, 1180, 60], [1120, 1240, 60]])
  assert.ok(mergeMinTime > windows[2].maxTime)
})

test('built transactions carry the preconditions and a single user-sourced path payment', () => {
  const { txs } = buildTransactions({ net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq: '4096', amount: '10', destMin: '5', t0: 1000, periodSeconds: 60, count: 3 })
  assert.equal(txs.length, 3)
  txs.forEach((t, i) => {
    assert.equal(t.tx.source, channel.publicKey())
    assert.equal(t.tx.sequence, String(4097 + i))
    assert.equal(t.tx.minAccountSequence, '4096')
    assert.equal(t.tx.minAccountSequenceAge, i === 0 ? 0n : 60n)
    assert.equal(t.tx.operations.length, 1)
    const op = t.tx.operations[0]
    assert.equal(op.type, 'pathPaymentStrictSend')
    assert.equal(op.source, user.publicKey())
    assert.equal(op.destination, user.publicKey())
    assert.equal(op.sendAmount, '10.0000000')
    assert.equal(op.destMin, '5.0000000')
    assert.equal(op.sendAsset.getCode(), 'USDC')
    assert.equal(op.destAsset.isNative(), true)
  })
})

test('a re-signed envelope keeps the hash; signatures verify against both keys', () => {
  const { txs } = buildTransactions({ net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq: '4096', amount: '10', destMin: '5', t0: 1000, periodSeconds: 60, count: 1 })
  const t = txs[0].tx
  t.sign(channel)
  const round = new Transaction(t.toXDR(), net.passphrase)
  round.sign(user)
  const hash = Buffer.from(round.hash())
  assert.equal(hash.toString('hex'), txs[0].hash)
  const sigs = round.signatures.map(sigBytes)
  assert.ok(sigs.some((s) => Keypair.fromPublicKey(channel.publicKey()).verify(hash, s)))
  assert.ok(sigs.some((s) => Keypair.fromPublicKey(user.publicKey()).verify(hash, s)))
  assert.ok(!sigs.some((s) => Keypair.random().verify(hash, s)))
})

test('validateParams rejects bad input', () => {
  const ok = { network: 'testnet', user: user.publicKey(), amount: '25', period: 'weekly', count: 4, ceiling: 25 }
  assert.equal(validateParams(ok).count, 4)
  assert.throws(() => validateParams({ ...ok, network: 'nope' }), /unknown network/)
  assert.throws(() => validateParams({ ...ok, user: 'GABC' }), /invalid user/)
  assert.throws(() => validateParams({ ...ok, period: 'minute', network: 'mainnet' }), /testnet-only/)
  assert.throws(() => validateParams({ ...ok, amount: '0.5' }), /amount/)
  assert.throws(() => validateParams({ ...ok, amount: '1.12345678' }), /decimals/)
  assert.throws(() => validateParams({ ...ok, count: 1 }), /count/)
  assert.throws(() => validateParams({ ...ok, ceiling: 7 }), /ceiling/)
})
