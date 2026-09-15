import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

const servers = new Map()

export function server(net) {
  if (!servers.has(net.key)) servers.set(net.key, new Horizon.Server(net.horizon))
  return servers.get(net.key)
}

export function usdcAsset(net) {
  return new Asset(net.usdc.code, net.usdc.issuer)
}

export async function loadAccountOrNull(net, publicKey) {
  try {
    return await server(net).loadAccount(publicKey)
  } catch (err) {
    if (err?.response?.status === 404) return null
    throw err
  }
}

export function balances(account, net) {
  const xlm = account.balances.find((b) => b.asset_type === 'native')
  const usdc = account.balances.find(
    (b) => b.asset_code === net.usdc.code && b.asset_issuer === net.usdc.issuer,
  )
  return {
    xlm: xlm ? xlm.balance : '0',
    usdcTrustline: Boolean(usdc),
    usdc: usdc ? usdc.balance : '0',
  }
}

export async function friendbot(net, publicKey) {
  const res = await fetch(`${net.friendbot}?addr=${encodeURIComponent(publicKey)}`)
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`)
}

/**
 * Direct-market quote: how much XLM does `amount` USDC buy right now on the
 * XLM/USDC pair (order book + liquidity pool), with no intermediate hops.
 * Returns a 7-decimal string, or null when the pair has no liquidity.
 */
export async function quoteStrictSend(net, amount) {
  const u = new URL('/paths/strict-send', net.horizon)
  u.searchParams.set('source_asset_type', 'credit_alphanum4')
  u.searchParams.set('source_asset_code', net.usdc.code)
  u.searchParams.set('source_asset_issuer', net.usdc.issuer)
  u.searchParams.set('source_amount', amount)
  u.searchParams.set('destination_assets', 'native')
  const res = await fetch(u)
  if (!res.ok) throw new Error(`horizon paths ${res.status}`)
  const data = await res.json()
  const direct = data._embedded.records.find((r) => r.path.length === 0)
  return direct ? direct.destination_amount : null
}

export function resultCodes(err) {
  const extras = err?.response?.data?.extras
  return {
    tx: extras?.result_codes?.transaction || null,
    ops: extras?.result_codes?.operations || [],
    status: err?.response?.status || null,
    message: err?.message || String(err),
  }
}

export async function submitXdr(net, xdr) {
  const tx = TransactionBuilder.fromXDR(xdr, net.passphrase)
  return server(net).submitTransaction(tx)
}

/** Mainnet: create and fund a channel account from the treasury. */
export async function fundFromTreasury(net, destination) {
  const treasury = Keypair.fromSecret(net.treasurySecret)
  const acct = await server(net).loadAccount(treasury.publicKey())
  const tx = new TransactionBuilder(acct, { fee: String(net.baseFee * 10), networkPassphrase: net.passphrase })
    .addOperation(Operation.createAccount({ destination, startingBalance: net.channelFunding }))
    .setTimeout(120)
    .build()
  tx.sign(treasury)
  return server(net).submitTransaction(tx)
}

export function treasuryPublic(net) {
  return net.treasurySecret ? Keypair.fromSecret(net.treasurySecret).publicKey() : null
}
