/** One Freighter approval installs transaction-specific preAuthTx signers. */
import { Keypair, Transaction } from '@stellar/stellar-sdk'
import { NETWORKS } from './config.js'
import { resultCodes, submitXdr, transactionOrNull } from './horizon.js'
import { PlanError, abandonDraft, publicPlan, sigBytes } from './plan.js'

function activate(db, plan) {
  db.exec('BEGIN')
  try {
    db.prepare("UPDATE txs SET signed = 1 WHERE plan_id = ? AND kind = 'buy'").run(plan.id)
    db.prepare("UPDATE plans SET status = 'active', channel_secret = NULL, finalized_at = ?, next_check_at = 0 WHERE id = ? AND status = 'authorizing'")
      .run(Math.floor(Date.now() / 1000), plan.id)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return publicPlan(db, plan.id)
}

/** Check whether the signed setup landed; retry it after an ambiguous network response. */
export async function recoverAuthorization(db, planId, { submit = true } = {}) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan || plan.status !== 'authorizing' || plan.mode !== 'single') return plan ? publicPlan(db, planId) : null
  const net = NETWORKS[plan.network]
  const record = await transactionOrNull(net, plan.setup_hash)
  if (record) {
    if (record.successful) return activate(db, plan)
    db.prepare("UPDATE plans SET status = 'cleanup', next_check_at = 0, note = 'wallet authorization failed on-chain' WHERE id = ?").run(planId)
    await abandonDraft(db, planId)
    throw new PlanError('wallet authorization failed on-chain; no plan was activated')
  }
  const setup = new Transaction(plan.setup_xdr, net.passphrase)
  const deadline = Number(setup.timeBounds?.maxTime || 0)
  const now = Math.floor(Date.now() / 1000)
  if (deadline && now > deadline + 60) {
    db.prepare("UPDATE plans SET status = 'cleanup', next_check_at = 0, note = 'wallet authorization expired' WHERE id = ?").run(planId)
    await abandonDraft(db, planId)
    throw new PlanError('wallet authorization expired; please create the plan again')
  }
  if (!submit) return publicPlan(db, planId)
  db.prepare('UPDATE plans SET next_check_at = ? WHERE id = ?').run(now + 30, planId)
  try {
    const submitted = await submitXdr(net, plan.setup_xdr)
    if (submitted.hash !== plan.setup_hash) throw new Error('Horizon returned a different authorization hash')
    return activate(db, plan)
  } catch (err) {
    // A timeout or duplicate submission may have succeeded; the next retry
    // reconciles by hash before attempting to submit again.
    const rc = resultCodes(err)
    if (rc.tx === 'tx_failed') {
      const found = await transactionOrNull(net, plan.setup_hash)
      if (found) return recoverAuthorization(db, planId, { submit: false })
    }
    throw new PlanError(`authorization not yet confirmed (${rc.tx || rc.message}); retry activation`, 503)
  }
}

export async function authorizeSingle(db, planId, signedXdr) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan) throw new PlanError('plan not found', 404)
  if (plan.mode !== 'single' || !['draft', 'authorizing'].includes(plan.status)) throw new PlanError('plan does not await single authorization')
  if (typeof signedXdr !== 'string') throw new PlanError('signed authorization XDR required')
  const net = NETWORKS[plan.network]
  let tx
  try { tx = new Transaction(signedXdr, net.passphrase) } catch { throw new PlanError('bad authorization XDR') }
  const hash = Buffer.from(tx.hash())
  if (hash.toString('hex') !== plan.setup_hash) throw new PlanError('authorization transaction was altered')
  const user = Keypair.fromPublicKey(plan.user)
  const signatures = tx.signatures.map(sigBytes)
  if (signatures.length !== 1 || !user.verify(hash, signatures[0])) throw new PlanError('authorization needs exactly one valid wallet signature')
  if (plan.status === 'authorizing' && plan.setup_xdr !== tx.toXDR()) throw new PlanError('a different authorization is already pending')
  if (plan.status === 'draft') {
    db.prepare("UPDATE plans SET status = 'authorizing', setup_xdr = ?, next_check_at = 0 WHERE id = ? AND status = 'draft'")
      .run(tx.toXDR(), planId)
  }
  return recoverAuthorization(db, planId)
}
