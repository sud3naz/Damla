/**
 * Fee bumps. A pre-signed purchase carries a fixed fee. When the network's
 * minimum fee rises above it (surge pricing) the transaction is rejected with
 * tx_insufficient_fee. Stellar's fee-bump wrapper lets the treasury pay a
 * higher fee for the unchanged inner transaction: no user signature, no
 * change to any precondition, the inner hash stays the same.
 */
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk'
import { server, resultCodes } from './horizon.js'

export const FEE_CAP_STROOPS = 1_000_000 // 0.1 XLM per operation, hard ceiling for a bumped purchase

/** Per-operation fee to offer during a surge: the 80th percentile of recent max fees, at least 10x base, capped. */
export async function surgeFeePerOp(net) {
  try {
    const res = await fetch(new URL('/fee_stats', net.horizon))
    if (!res.ok) throw new Error(String(res.status))
    const s = await res.json()
    const p80 = Number(s.max_fee?.p80 || 0)
    const base = Number(s.last_ledger_base_fee || net.baseFee)
    return Math.min(FEE_CAP_STROOPS, Math.max(p80, base * 10, net.baseFee * 10))
  } catch {
    return Math.min(FEE_CAP_STROOPS, net.baseFee * 100)
  }
}

export function buildBump(net, innerXdr, feePerOp) {
  const treasury = Keypair.fromSecret(net.treasurySecret)
  const inner = TransactionBuilder.fromXDR(innerXdr, net.passphrase)
  const bump = TransactionBuilder.buildFeeBumpTransaction(treasury, String(feePerOp), inner, net.passphrase)
  bump.sign(treasury)
  return bump
}

/**
 * Submit the envelope; on tx_insufficient_fee retry once wrapped in a treasury
 * fee bump. Resolves with Horizon's response plus `bumped` and `feePerOp`;
 * rejects with the original error otherwise.
 */
export async function submitWithFeeBump(net, innerXdr, { log = () => {} } = {}) {
  try {
    const res = await server(net).submitTransaction(TransactionBuilder.fromXDR(innerXdr, net.passphrase))
    return { ...res, bumped: false }
  } catch (err) {
    const rc = resultCodes(err)
    if (rc.tx !== 'tx_insufficient_fee' || !net.treasurySecret) throw err
    const feePerOp = await surgeFeePerOp(net)
    log(`tx_insufficient_fee, retrying with a treasury fee bump at ${feePerOp} stroops/op`)
    const bump = buildBump(net, innerXdr, feePerOp)
    const res = await server(net).submitTransaction(bump)
    return { ...res, bumped: true, feePerOp }
  }
}
