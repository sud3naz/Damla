import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as sdk from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { buildSingleSetup, buildTransactions } from '../src/plan.js'

const context = { StellarSdk: sdk, URL }
vm.runInNewContext(readFileSync(new URL('../review.js', import.meta.url), 'utf8'), context)
const verify = context.damlaReview.verifyDraft

function fixture(network = 'testnet') {
  const net = NETWORKS[network]
  const period = network === 'mainnet' ? 3600 : 60
  const user = sdk.Keypair.random()
  const channel = sdk.Keypair.random()
  const built = buildTransactions({
    net, user: user.publicKey(), channelPub: channel.publicKey(), startSeq: '1000',
    amount: '10', destMin: '1', t0: 2000000000, periodSeconds: period, count: 2, mode: 'single',
  })
  for (const entry of [...built.txs, built.merge]) entry.tx.sign(channel)
  const setup = buildSingleSetup({
    net, user: user.publicKey(), userSeq: '2000',
    hashes: [...built.txs, built.merge].map((t) => t.hash), weight: 1, now: 1999999000,
  })
  const intent = { network, user: user.publicKey(), amount: '10', count: 2, every: 1, unit: network === 'mainnet' ? 'hours' : 'minutes', ceiling: 25, start: null }
  const draft = {
    network, user: user.publicKey(), channel: channel.publicKey(), mode: 'single',
    amount: '10', count: 2, periodSeconds: period, ceiling: 25, t0: 2000000000,
    startSeq: '1000', destMin: '1',
    txs: built.txs.map((t) => ({ idx: t.idx, hash: t.hash, seq: t.seq, minTime: t.minTime, maxTime: t.maxTime, minSeqAge: t.minSeqAge, xdr: t.tx.toXDR() })),
    cleanup: { hash: built.merge.hash, xdr: built.merge.tx.toXDR() },
    authorization: { hash: setup.hash, xdr: setup.tx.toXDR() },
  }
  return { draft, intent, options: { now: 1999999900, quoteXlm: '1.20' }, user, channel, net, built }
}

test('browser verifier accepts exact purchases, cleanup and one setup', () => {
  const f = fixture()
  const result = verify(f.draft, f.intent, f.options)
  assert.equal(result.count, 2)
  assert.equal(result.reserveXlm, 1.5)
  assert.equal(result.floorXlm, '1')
})

test('mainnet XDR uses Circle USDC, public-network passphrase and an hourly minimum cadence', () => {
  const f = fixture('mainnet')
  const checked = verify(f.draft, f.intent, f.options)
  assert.equal(checked.network, 'mainnet')
  assert.equal(checked.periodSeconds, 3600)
  assert.equal(f.built.txs[0].tx.operations[0].sendAsset.issuer, NETWORKS.mainnet.usdc.issuer)
  assert.equal(f.built.txs[0].tx.networkPassphrase, NETWORKS.mainnet.passphrase)
})

test('shipped browser SDK bundle can decode and verify the plan', () => {
  const browser = { TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, BigInt, Event, EventTarget, URL, URLSearchParams, Headers, Request, Response, AbortController, atob, btoa, setTimeout, clearTimeout, crypto: globalThis.crypto }
  browser.globalThis = browser
  browser.self = browser
  vm.createContext(browser)
  vm.runInContext(readFileSync(new URL('../vendor/stellar-sdk.min.js', import.meta.url), 'utf8'), browser)
  vm.runInContext(readFileSync(new URL('../review.js', import.meta.url), 'utf8'), browser)
  const f = fixture()
  assert.equal(browser.damlaReview.verifyDraft(f.draft, f.intent, f.options).count, 2)
})

test('browser verifier rejects altered terms before a Freighter call', () => {
  const f = fixture()
  f.draft.destMin = '0.1'
  assert.throws(() => verify(f.draft, f.intent, f.options), /price floor/)
  f.draft.destMin = '1'
  f.draft.txs[0].hash = '0'.repeat(64)
  assert.throws(() => verify(f.draft, f.intent, f.options), /hash changed/)
  f.draft.txs[0].hash = f.built.txs[0].hash
  f.draft.cleanup = null
  assert.throws(() => verify(f.draft, f.intent, f.options), /incomplete transaction set/)
})

test('browser verifier rejects setup signer substitution even with a matching claimed setup hash', () => {
  const f = fixture()
  const altered = buildSingleSetup({
    net: f.net, user: f.user.publicKey(), userSeq: '2000',
    hashes: ['0'.repeat(64), f.built.txs[1].hash, f.built.merge.hash], weight: 1, now: 1999999000,
  })
  f.draft.authorization = { hash: altered.hash, xdr: altered.tx.toXDR() }
  assert.throws(() => verify(f.draft, f.intent, f.options), /exact reviewed transaction/)
})

test('browser verifier rejects a redirected user-sourced payment', () => {
  const f = fixture()
  const attacker = sdk.Keypair.random()
  const bad = new sdk.TransactionBuilder(new sdk.Account(f.channel.publicKey(), '1000'), { fee: '100', networkPassphrase: f.net.passphrase })
    .setMinAccountSequence('1000').setTimebounds(2000000000, 2000000120)
    .addOperation(sdk.Operation.pathPaymentStrictSend({
      source: f.user.publicKey(), sendAsset: new sdk.Asset('USDC', f.net.usdc.issuer), sendAmount: '10',
      destination: attacker.publicKey(), destAsset: sdk.Asset.native(), destMin: '1', path: [],
    })).build()
  bad.sign(f.channel)
  f.draft.txs[0].xdr = bad.toXDR()
  f.draft.txs[0].hash = Buffer.from(bad.hash()).toString('hex')
  assert.throws(() => verify(f.draft, f.intent, f.options), /payment direction changed/)
})

test('independent quote uses pinned Horizon host and USDC issuer', async () => {
  let requested
  context.fetch = async (url) => {
    requested = new URL(url)
    return Response.json({ _embedded: { records: [{ path: [], destination_amount: '92.5925925' }] } }, { headers: { Date: 'Wed, 30 Sep 2026 03:45:19 GMT' } })
  }
  const result = await context.damlaReview.trustedQuote('testnet', '10')
  assert.equal(requested.origin, 'https://horizon-testnet.stellar.org')
  assert.equal(requested.searchParams.get('source_asset_issuer'), NETWORKS.testnet.usdc.issuer)
  assert.equal(requested.searchParams.get('destination_assets'), 'native')
  assert.equal(result.amount, '92.5925925')
  assert.equal(result.now, 1790739919)
  delete context.fetch
})
