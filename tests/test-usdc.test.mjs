import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Account, Keypair, TransactionBuilder } from '@stellar/stellar-sdk'
import { NETWORKS } from '../src/config.js'
import { server as horizon } from '../src/horizon.js'
import { createServer, testUsdcSendMax } from '../src/server.js'

function account(xlm, liabilities = '0') {
  return {
    subentry_count: 1,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [{ asset_type: 'native', balance: xlm, selling_liabilities: liabilities }],
  }
}

test('100 test USDC helper caps a 1,000 XLM wallet at 10% over the live quote', () => {
  assert.equal(testUsdcSendMax(account('1000.0000000'), '106.3720640', 1000), '117.0092704')
})

test('100 test USDC helper cannot offer more than spendable XLM', () => {
  assert.equal(testUsdcSendMax(account('110.0000000'), '106.3720640', 1000), '107.4999000')
  assert.throws(() => testUsdcSendMax(account('100.0000000'), '106.3720640', 1000), /not enough test XLM/)
  assert.throws(() => testUsdcSendMax(account('1000.0000000', '900.0000000'), '106.3720640', 1000), /not enough test XLM/)
})

test('helper builds a direct, quote-capped testnet swap for the requested wallet', async () => {
  const net = NETWORKS.testnet
  const address = Keypair.random().publicKey()
  const accountResponse = Object.assign(new Account(address, '1'), account('1000.0000000'), {
    balances: [
      ...account('1000.0000000').balances,
      { asset_type: 'credit_alphanum4', asset_code: net.usdc.code, asset_issuer: net.usdc.issuer, balance: '0' },
    ],
  })
  const h = horizon(net)
  const originalLoad = h.loadAccount
  const originalFetch = globalThis.fetch
  h.loadAccount = async () => accountResponse
  globalThis.fetch = async (input) => {
    const url = new URL(input)
    assert.equal(url.pathname, '/paths/strict-receive')
    assert.equal(url.searchParams.get('source_assets'), 'native')
    assert.equal(url.searchParams.get('destination_asset_issuer'), net.usdc.issuer)
    assert.equal(url.searchParams.get('destination_amount'), '100')
    return new Response(JSON.stringify({ _embedded: { records: [{ source_amount: '106.3720640', path: [] }] } }), { status: 200 })
  }
  const app = createServer(null)
  try {
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${app.address().port}/api/helper/test-usdc?network=testnet&address=${address}`, (response) => {
        let data = ''
        response.on('data', (chunk) => { data += chunk })
        response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(data) }))
      }).on('error', reject)
    })
    assert.equal(body.status, 200)
    const tx = TransactionBuilder.fromXDR(body.data.xdr, net.passphrase)
    assert.equal(tx.source, address)
    assert.equal(tx.operations.length, 1)
    const op = tx.operations[0]
    assert.equal(op.type, 'pathPaymentStrictReceive')
    assert.equal(op.sendAsset.isNative(), true)
    assert.equal(op.sendMax, '117.0092704')
    assert.equal(op.destination, address)
    assert.equal(op.destAsset.code, net.usdc.code)
    assert.equal(op.destAsset.issuer, net.usdc.issuer)
    assert.equal(op.destAmount, '100.0000000')
    assert.deepEqual(op.path, [])
  } finally {
    await new Promise((resolve) => app.close(resolve))
    h.loadAccount = originalLoad
    globalThis.fetch = originalFetch
  }
})
