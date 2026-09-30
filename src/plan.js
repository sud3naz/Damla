/**
 * Plan builder + verifier. Pure protocol logic, no HTTP.
 *
 * A plan is N pre-signed PathPaymentStrictSend transactions plus one cleanup
 * AccountMerge, all sourced by a fresh per-plan channel account C:
 *
 *   tx_i (i = 1..N):
 *     source        = C            (fees, sequence clock)
 *     seqNum        = S0 + i
 *     minSeqNum     = S0           -> valid while S0 <= C.seq < S0+i, so a skipped
 *                                     purchase never blocks the ones after it
 *     minSeqAge     = P (i >= 2)   -> C's sequence must be at least one period old:
 *                                     two purchases can never land closer than P
 *     timeBounds    = [t0 + (i-1)P, t0 + (i+1)P]  -> the calendar window for buy i
 *     operation     = PathPaymentStrictSend(source = user, USDC amount -> XLM, destMin)
 *
 *   tx_merge:
 *     seqNum = S0 + N + 1, minSeqNum = S0, minTime = after the last window,
 *     AccountMerge(C -> treasury). Returns the channel's reserve to the service.
 *
 * C's secret key is used once, to co-sign these transactions, then destroyed
 * (`burnChannel`). After that nothing can ever be built from C again.
 */
import { randomBytes, createHash } from 'node:crypto'
import { Account, Asset, Keypair, Operation, StrKey, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk'
import { LIMITS, NETWORKS, UNITS } from './config.js'
import { friendbot, fundFromTreasury, loadAccountOrNull, quoteStrictSend, resultCodes, server, treasuryPublic, usdcAsset } from './horizon.js'

export class PlanError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

export function requirePilotAccess(net, user) {
  if (net.key !== 'mainnet') return
  const allowed = net.pilotUsers || []
  if (!allowed.includes('*') && !allowed.includes(user))
    throw new PlanError('mainnet is limited to approved pilot wallets', 403)
}

export function periodLabel(every, unit) {
  const word = every === 1 ? unit.replace(/s$/, '') : unit
  return every === 1 ? `every ${word}` : `every ${every} ${word}`
}

export function validateParams(p, now = Math.floor(Date.now() / 1000)) {
  const net = Object.hasOwn(NETWORKS, p.network) ? NETWORKS[p.network] : null
  if (!net) throw new PlanError('unknown network')
  if (!StrKey.isValidEd25519PublicKey(p.user || '')) throw new PlanError('invalid user address')
  const unit = Object.hasOwn(UNITS, p.unit) ? UNITS[p.unit] : null
  if (!unit) throw new PlanError('unit must be one of minutes, hours, days, weeks')
  if (unit.testnetOnly && net.key !== 'testnet') throw new PlanError('minute cadence is testnet-only')
  const every = Number(p.every)
  if (!Number.isInteger(every) || every < 1 || every > 1000) throw new PlanError('"every" must be a whole number between 1 and 1000')
  const periodSeconds = every * unit.seconds
  if (!Number.isSafeInteger(periodSeconds)) throw new PlanError('invalid cadence')
  const minP = LIMITS.minPeriodSeconds[net.key]
  if (periodSeconds < minP) throw new PlanError(`the shortest cadence on ${net.key} is every ${minP >= 3600 ? minP / 3600 + ' hour' : minP / 60 + ' minute'}`)
  if (periodSeconds > LIMITS.maxPeriodSeconds) throw new PlanError('the longest cadence is every 90 days')
  const amount = Number(p.amount)
  const maxAmount = Math.min(LIMITS.maxAmount, net.maxAmount || LIMITS.maxAmount)
  if (!Number.isFinite(amount) || amount < LIMITS.minAmount || amount > maxAmount)
    throw new PlanError(`amount must be between ${LIMITS.minAmount} and ${maxAmount} USDC on ${net.key}`)
  if (!/^\d+(\.\d{1,7})?$/.test(String(p.amount))) throw new PlanError('amount: at most 7 decimals')
  const count = Number(p.count)
  if (!Number.isInteger(count) || count < LIMITS.minCount || count > LIMITS.maxCount)
    throw new PlanError(`count must be between ${LIMITS.minCount} and ${LIMITS.maxCount}`)
  const ceiling = Number(p.ceiling)
  if (!LIMITS.ceilings.includes(ceiling)) throw new PlanError(`ceiling must be one of ${LIMITS.ceilings.join(', ')}`)
  let t0 = now + LIMITS.signingAllowanceSeconds
  if (p.start != null && p.start !== '') {
    const start = Number(p.start)
    if (!Number.isInteger(start)) throw new PlanError('start must be a unix timestamp')
    if (start > now + LIMITS.maxStartDelaySeconds) throw new PlanError('the first purchase can be at most 60 days out')
    t0 = Math.max(t0, start)
  }
  return { net, every, unit: p.unit, periodSeconds, label: periodLabel(every, p.unit), amount: String(p.amount), count, ceiling, t0 }
}

/** XLM floor: the quote at signing, divided by (1 + ceiling%). 7 decimals, rounded down. */
export function floorFromQuote(quoteXlm, ceilingPct) {
  const q = BigInt(Math.round(Number(quoteXlm) * 1e7)) // stroops
  const floor = (q * 100n) / BigInt(100 + ceilingPct)
  return stroopsToAmount(floor)
}

export function stroopsToAmount(stroops) {
  const s = BigInt(stroops)
  const whole = s / 10000000n
  const frac = (s % 10000000n).toString().padStart(7, '0')
  return `${whole}.${frac}`
}

export function schedule({ t0, periodSeconds, count }) {
  const P = periodSeconds
  const windows = []
  for (let i = 1; i <= count; i++) {
    windows.push({
      idx: i,
      minTime: t0 + (i - 1) * P,
      maxTime: t0 + (i + 1) * P,
      minSeqAge: i === 1 ? 0 : P,
    })
  }
  return { windows, mergeMinTime: t0 + (count + 1) * P + 60 }
}

/** Build (unsigned) transactions for a plan. Pure: no network access. */
export function buildTransactions({ net, user, channelPub, startSeq, amount, destMin, t0, periodSeconds, count, mode = 'individual' }) {
  const { windows, mergeMinTime } = schedule({ t0, periodSeconds, count })
  const usdc = usdcAsset(net)
  const S0 = BigInt(startSeq)
  const txs = windows.map((w) => {
    const src = new Account(channelPub, (S0 + BigInt(w.idx) - 1n).toString())
    const b = new TransactionBuilder(src, { fee: String(net.baseFee), networkPassphrase: net.passphrase })
      .setMinAccountSequence(S0.toString())
      .setTimebounds(w.minTime, w.maxTime)
      .addOperation(Operation.pathPaymentStrictSend({
        source: user,
        sendAsset: usdc,
        sendAmount: amount,
        destination: user,
        destAsset: Asset.native(),
        destMin,
        path: [],
      }))
    if (w.minSeqAge > 0) b.setMinAccountSequenceAge(BigInt(w.minSeqAge))
    const tx = b.build()
    return { ...w, kind: 'buy', seq: tx.sequence, hash: Buffer.from(tx.hash()).toString('hex'), tx }
  })
  const treasury = treasuryPublic(net)
  let merge = null
  if (treasury || mode === 'single') {
    const src = new Account(channelPub, (S0 + BigInt(count)).toString())
    const b = new TransactionBuilder(src, { fee: String(net.baseFee), networkPassphrase: net.passphrase })
      .setMinAccountSequence(S0.toString())
      .setTimebounds(mode === 'single' ? 0 : mergeMinTime, 0)
    // A pre-authorized cleanup can run immediately on cancellation. It removes
    // unused purchase signers, releasing the user's XLM reserve. Signers for
    // purchases that ran already are absent; SetOptions(weight=0) is a no-op.
    if (mode === 'single') {
      for (const buy of txs) b.addOperation(Operation.setOptions({
        source: user, signer: { preAuthTx: buy.hash, weight: 0 },
      }))
    }
    if (treasury) b.addOperation(Operation.accountMerge({ destination: treasury }))
    const tx = b.build()
    merge = { idx: count + 1, kind: 'merge', minTime: mode === 'single' ? 0 : mergeMinTime, maxTime: 0, minSeqAge: 0, seq: tx.sequence, hash: Buffer.from(tx.hash()).toString('hex'), tx }
  }
  return { txs, merge }
}

/** One wallet signature authorizes the exact hashes of every purchase and cleanup. */
export function buildSingleSetup({ net, user, userSeq, hashes, weight, now }) {
  const expiresAt = now + 20 * 60
  const b = new TransactionBuilder(new Account(user, userSeq), { fee: String(net.baseFee), networkPassphrase: net.passphrase })
    .setTimebounds(0, expiresAt)
  for (const hash of hashes) b.addOperation(Operation.setOptions({ signer: { preAuthTx: hash, weight } }))
  const tx = b.build()
  return { tx, hash: Buffer.from(tx.hash()).toString('hex'), expiresAt }
}

/** raw 64-byte ed25519 signature from a DecoratedSignature (SDK 17 wraps it) */
export function sigBytes(decorated) {
  const s = typeof decorated.signature === 'function' ? decorated.signature() : decorated.signature
  const raw = s instanceof Uint8Array ? s : (typeof s.toBytes === 'function' ? s.toBytes() : s.value)
  return Buffer.from(raw)
}

export function newPlanId() { return randomBytes(16).toString('hex') }
export function newCancelToken() { return randomBytes(24).toString('base64url') }
export function hashToken(t) { return createHash('sha256').update(t).digest('hex') }

/**
 * Create a draft plan: fund a fresh channel, quote the market, build and
 * channel-sign every transaction, persist. Returns what the browser needs.
 */
export async function createDraft(db, params, now = Math.floor(Date.now() / 1000), beforeFunding = null) {
  const { net, every, unit, periodSeconds, label, amount, count, ceiling, t0 } = validateParams(params, now)
  requirePilotAccess(net, params.user)
  const mode = params.mode === 'single' ? 'single' : 'individual'
  if (net.key === 'mainnet' && mode !== 'single') throw new PlanError('mainnet requires single approval')
  if (mode === 'single' && count > 18) throw new PlanError('single-approval plans support at most 18 purchases (Stellar signer limit)')
  const user = params.user

  const userAcct = await loadAccountOrNull(net, user)
  if (!userAcct) throw new PlanError('user account does not exist on this network')
  let signerWeight = 0
  let reserveXlm = 0
  if (mode === 'single') {
    if ((userAcct.signers?.length || 0) + count + 1 > 20) throw new PlanError('not enough free signer slots for a single-approval plan (20 maximum)')
    const master = userAcct.signers?.find((s) => s.key === user)
    const high = Number(userAcct.thresholds?.high_threshold || 0)
    const medium = Number(userAcct.thresholds?.med_threshold || 0)
    if (!master || Number(master.weight) < high) throw new PlanError('this wallet cannot authorize the signer setup alone; use a standard single-key Stellar account')
    signerWeight = Math.max(1, high, medium)
    reserveXlm = 0.5 * (count + 1)
    const native = userAcct.balances.find((b) => b.asset_type === 'native')
    const currentReserve = 0.5 * (2 + Number(userAcct.subentry_count || 0) + Number(userAcct.num_sponsoring || 0) - Number(userAcct.num_sponsored || 0))
    if (Number(native?.balance || 0) - Number(native?.selling_liabilities || 0) < currentReserve + reserveXlm + 0.01)
      throw new PlanError(`single approval needs ${reserveXlm.toFixed(1)} XLM of temporary signer reserve in the wallet; add XLM or reduce purchases`)
  }
  const trust = userAcct.balances.find((b) => b.asset_code === net.usdc.code && b.asset_issuer === net.usdc.issuer)
  if (!trust) throw new PlanError('user account has no USDC trustline')
  if (Number(trust.balance) < Number(amount)) throw new PlanError(`user holds ${trust.balance} USDC, the first purchase needs ${amount}`)
  const quote = await quoteStrictSend(net, amount)
  if (!quote) throw new PlanError('no direct XLM/USDC market for this amount right now', 503)
  const destMin = floorFromQuote(quote, ceiling)

  // A pilot address is public information, not proof of wallet ownership.
  // Keep unsigned mainnet exposure to one treasury-funded channel.
  if (net.key === 'mainnet') {
    const outstanding = db.prepare("SELECT COUNT(*) AS n FROM plans WHERE network = 'mainnet' AND status IN ('funding', 'draft', 'authorizing', 'cleanup')").get().n
    if (outstanding >= net.maxPendingDrafts)
      throw new PlanError('mainnet pilot already has an unsigned draft; finish or wait for cleanup', 429)
  }
  // Charge the scarce budget only after validation, immediately before funding.
  if (beforeFunding) beforeFunding()

  const id = newPlanId()
  const cancelToken = newCancelToken()
  const channel = Keypair.random()
  const ins = db.prepare(`INSERT INTO plans (id, network, user, channel, channel_secret, cancel_hash, amount, period, period_seconds, count, ceiling, quote_xlm, start_seq, t0, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'funding', ?)`)
  const insTx = db.prepare(`INSERT INTO txs (plan_id, idx, kind, hash, seq, min_time, max_time, min_seq_age, dest_min, xdr, signed, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  // Persist the recovery key before the network funds the channel. A crash or
  // failed build after funding must not strand an account whose key lived only
  // in this request's memory.
  ins.run(id, net.key, user, channel.publicKey(), channel.secret(), hashToken(cancelToken), amount, `${every} ${unit}`, periodSeconds, count, ceiling, quote, '', t0, now)
  db.prepare('UPDATE plans SET mode = ? WHERE id = ?').run(mode, id)
  let funded = false
  let inTransaction = false
  try {
    if (net.treasurySecret) await fundFromTreasury(net, channel.publicKey())
    else if (net.friendbot) await friendbot(net, channel.publicKey())
    else throw new PlanError('network not enabled on this server', 503)
    funded = true
    const chAcct = await server(net).loadAccount(channel.publicKey())
    const startSeq = chAcct.sequenceNumber()
    const built = buildTransactions({
      net, user, channelPub: channel.publicKey(), startSeq, amount, destMin, t0, periodSeconds, count, mode,
    })
    const all = built.merge ? [...built.txs, built.merge] : built.txs
    for (const t of all) t.tx.sign(channel)
    const setup = mode === 'single' ? buildSingleSetup({
      net, user, userSeq: userAcct.sequenceNumber(), hashes: all.map((t) => t.hash), weight: signerWeight, now,
    }) : null
    db.exec('BEGIN')
    inTransaction = true
    for (const t of all) {
      insTx.run(id, t.idx, t.kind, t.hash, t.seq, t.minTime, t.maxTime, t.minSeqAge, t.kind === 'buy' ? destMin : null, t.tx.toXDR(), t.kind === 'merge' ? 1 : 0, 'pending')
    }
    db.prepare("UPDATE plans SET status = 'draft', start_seq = ? WHERE id = ?").run(startSeq, id)
    if (setup) db.prepare('UPDATE plans SET setup_hash = ?, setup_xdr = ? WHERE id = ?').run(setup.hash, setup.tx.toXDR(), id)
    db.exec('COMMIT')
    inTransaction = false
    return {
      id, cancelToken, network: net.key, user, channel: channel.publicKey(),
      amount, period: `${every} ${unit}`, periodLabel: label, periodSeconds, count, ceiling,
      quoteXlm: quote, destMin, t0, startSeq,
      mode, authorization: setup ? { xdr: setup.tx.toXDR(), hash: setup.hash, expiresAt: setup.expiresAt, reserveXlm } : null,
      txs: built.txs.map((t) => ({ idx: t.idx, hash: t.hash, seq: t.seq, minTime: t.minTime, maxTime: t.maxTime, minSeqAge: t.minSeqAge, xdr: t.tx.toXDR() })),
      cleanup: mode === 'single' ? { hash: built.merge.hash, xdr: built.merge.tx.toXDR() } : null,
    }
  } catch (e) {
    if (inTransaction) { try { db.exec('ROLLBACK') } catch {} }
    db.prepare("UPDATE plans SET status = 'cleanup', next_check_at = ? WHERE id = ?").run(now + (funded ? 0 : 60), id)
    if (funded) await abandonDraft(db, id, now)
    throw e
  }
}

/**
 * Abandon a draft: merge its channel back to the treasury while we still hold
 * the key (nothing was activated, so no user signature exists on it), then
 * forget the key.
 */
export async function abandonDraft(db, planId, now = Math.floor(Date.now() / 1000)) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan || !['draft', 'funding', 'cleanup'].includes(plan.status)) return
  const net = NETWORKS[plan.network]
  const treasury = treasuryPublic(net)
  let note = treasury ? 'channel merged back to treasury' : 'friendbot-funded draft abandoned'
  if (plan.channel_secret && treasury) {
    try {
      const kp = Keypair.fromSecret(plan.channel_secret)
      const acct = await loadAccountOrNull(net, kp.publicKey())
      if (!acct && now - plan.created_at < 300) {
        // A funding request can time out after Horizon accepts it. Give the
        // account time to appear before discarding its only recovery key.
        db.prepare("UPDATE plans SET status = 'cleanup', next_check_at = ?, note = ? WHERE id = ?")
          .run(now + 60, 'waiting for channel funding to settle', planId)
        return
      }
      if (acct) {
        const tx = new TransactionBuilder(acct, { fee: String(net.baseFee * 10), networkPassphrase: net.passphrase })
          .addOperation(Operation.accountMerge({ destination: treasury }))
          .setTimeout(120).build()
        tx.sign(kp)
        await server(net).submitTransaction(tx)
      } else note = 'channel account absent after cleanup window'
    } catch (err) {
      console.error(`[${planId.slice(0, 8)}] abandon merge failed: ${resultCodes(err).tx || err.message}`)
      db.prepare("UPDATE plans SET status = 'cleanup', next_check_at = ?, note = ? WHERE id = ?")
        .run(now + 60, 'channel merge pending retry', planId)
      return
    }
  }
  db.exec('BEGIN')
  try {
    db.prepare("UPDATE plans SET status = 'abandoned', channel_secret = NULL, note = ?, ended_at = ? WHERE id = ?").run(note, now, planId)
    db.prepare("UPDATE txs SET status = 'cancelled' WHERE plan_id = ? AND kind = 'buy'").run(planId)
    db.prepare("UPDATE txs SET status = 'superseded', note = 'channel merged during draft cleanup' WHERE plan_id = ? AND kind = 'merge' AND status = 'pending'").run(planId)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

/**
 * Verify the browser-returned envelopes: same transaction (hash unchanged),
 * exactly two valid signatures (channel + user). Then activate and burn the key.
 */
export function finalize(db, planId, signed) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan) throw new PlanError('plan not found', 404)
  if (plan.mode === 'single') throw new PlanError('use the single-authorization endpoint for this plan')
  if (plan.status !== 'draft') throw new PlanError(`plan is ${plan.status}, not a draft`)
  const net = NETWORKS[plan.network]
  const rows = db.prepare("SELECT * FROM txs WHERE plan_id = ? AND kind = 'buy' ORDER BY idx").all(planId)
  if (!Array.isArray(signed) || signed.length !== rows.length) throw new PlanError(`expected ${rows.length} signed transactions`)
  const userKp = Keypair.fromPublicKey(plan.user)
  const chanKp = Keypair.fromPublicKey(plan.channel)
  const upd = db.prepare('UPDATE txs SET xdr = ?, signed = 1 WHERE plan_id = ? AND idx = ?')
  const verified = []
  for (const row of rows) {
    const s = signed.find((x) => Number(x.idx) === row.idx)
    if (!s || typeof s.xdr !== 'string') throw new PlanError(`missing signed transaction #${row.idx}`)
    let tx
    try { tx = new Transaction(s.xdr, net.passphrase) } catch { throw new PlanError(`transaction #${row.idx}: bad XDR`) }
    const hash = Buffer.from(tx.hash())
    if (hash.toString('hex') !== row.hash) throw new PlanError(`transaction #${row.idx} was altered`)
    const sigs = tx.signatures.map(sigBytes)
    if (sigs.length !== 2) throw new PlanError(`transaction #${row.idx}: expected 2 signatures, got ${sigs.length}`)
    const okUser = sigs.some((sg) => userKp.verify(hash, sg))
    const okChan = sigs.some((sg) => chanKp.verify(hash, sg))
    if (!okUser) throw new PlanError(`transaction #${row.idx}: missing a valid signature from ${plan.user}`)
    if (!okChan) throw new PlanError(`transaction #${row.idx}: missing the channel signature`)
    verified.push({ idx: row.idx, xdr: tx.toXDR() })
  }
  const now = Math.floor(Date.now() / 1000)
  db.exec('BEGIN')
  try {
    for (const v of verified) upd.run(v.xdr, planId, v.idx)
    db.prepare("UPDATE plans SET status = 'active', channel_secret = NULL, finalized_at = ? WHERE id = ?").run(now, planId)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return publicPlan(db, planId)
}

function labelFromStored(period) {
  const m = /^(\d+) (minutes|hours|days|weeks)$/.exec(period || '')
  if (m) return periodLabel(Number(m[1]), m[2])
  return { minute: 'every minute', daily: 'every day', weekly: 'every week', monthly: 'every 30 days' }[period] || period
}

export function publicPlan(db, planId) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan) return null
  const txs = db.prepare('SELECT * FROM txs WHERE plan_id = ? ORDER BY idx').all(planId)
  const net = NETWORKS[plan.network]
  return {
    id: plan.id,
    network: plan.network,
    explorer: net.explorer,
    user: plan.user,
    channel: plan.channel,
    channelKeyDestroyed: plan.channel_secret === null,
    mode: plan.mode,
    authorizationHash: plan.mode === 'single' ? plan.setup_hash : null,
    amount: plan.amount,
    period: plan.period,
    periodLabel: labelFromStored(plan.period),
    periodSeconds: plan.period_seconds,
    count: plan.count,
    ceiling: plan.ceiling,
    quoteXlm: plan.quote_xlm,
    startSeq: plan.start_seq,
    t0: plan.t0,
    status: plan.status,
    note: plan.note,
    createdAt: plan.created_at,
    finalizedAt: plan.finalized_at,
    endedAt: plan.ended_at,
    txs: txs.map((t) => ({
      idx: t.idx, kind: t.kind, hash: t.hash, seq: t.seq, minTime: t.min_time, maxTime: t.max_time, minSeqAge: t.min_seq_age,
      destMin: t.dest_min, signed: Boolean(t.signed), status: t.status, note: t.note, resultCode: t.result_code,
      ledger: t.ledger, receivedXlm: t.received_xlm, executedAt: t.executed_at, attempts: t.attempts,
    })),
  }
}

export function exportPlan(db, planId, token) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan || plan.status === 'draft') return null
  if (typeof token !== 'string' || hashToken(token) !== plan.cancel_hash) throw new PlanError('bad plan token', 403)
  const txs = db.prepare("SELECT * FROM txs WHERE plan_id = ? AND kind = 'buy' ORDER BY idx").all(planId)
  const cleanup = plan.mode === 'single'
    ? db.prepare("SELECT hash, xdr, status FROM txs WHERE plan_id = ? AND kind = 'merge'").get(planId)
    : null
  const net = NETWORKS[plan.network]
  return {
    damla: 'plan-export-v1',
    network: plan.network,
    networkPassphrase: net.passphrase,
    horizon: net.horizon,
    user: plan.user,
    channel: plan.channel,
    note: plan.mode === 'single'
      ? 'Each envelope has the channel signature and is authorized by its exact preAuthTx hash on the user account. Anyone holding it may submit it within its window; nobody can change it.'
      : 'Each envelope is fully signed. Anyone can submit it, only inside its time window; nobody can change it.',
    txs: txs.map((t) => ({ idx: t.idx, hash: t.hash, minTime: t.min_time, maxTime: t.max_time, status: t.status, xdr: t.xdr })),
    cleanup: cleanup ? { hash: cleanup.hash, xdr: cleanup.xdr, status: cleanup.status } : null,
  }
}

export function cancelPlan(db, planId, token, { isSubmitting = () => false, unsignedOnly = false } = {}) {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId)
  if (!plan) throw new PlanError('plan not found', 404)
  if (typeof token !== 'string' || hashToken(token) !== plan.cancel_hash) throw new PlanError('bad cancel token', 403)
  if (unsignedOnly && plan.status === 'abandoned') return publicPlan(db, planId)
  if (unsignedOnly && !['draft', 'funding', 'cleanup'].includes(plan.status))
    throw new PlanError('plan is no longer an unsigned draft', 409)
  if (isSubmitting(planId)) throw new PlanError('a purchase is being submitted; retry stopping this plan shortly', 409)
  if (['done', 'cancelled'].includes(plan.status)) return publicPlan(db, planId)
  if (plan.status === 'authorizing') throw new PlanError('wallet authorization is being reconciled; retry cancellation shortly', 409)
  const now = Math.floor(Date.now() / 1000)
  db.exec('BEGIN')
  try {
    const draft = ['draft', 'funding', 'cleanup'].includes(plan.status)
    db.prepare("UPDATE plans SET status = ?, next_check_at = 0, ended_at = ? WHERE id = ?").run(draft ? 'cleanup' : 'cancelled', now, planId)
    db.prepare("UPDATE txs SET status = 'cancelled' WHERE plan_id = ? AND kind = 'buy' AND status = 'pending' AND attempts = 0").run(planId)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return publicPlan(db, planId)
}

/** Parse the XLM the user received from a successful path payment result. */
export function receivedXlm(resultXdrB64) {
  try {
    const r = xdr.TransactionResult.fromXDR(resultXdrB64, 'base64')
    const j = typeof r.toJSON === 'function' ? r.toJSON() : null
    if (j) {
      const ops = j.result.tx_success || j.result.tx_fee_bump_inner_success?.result?.result?.tx_success
      const amt = ops?.[0]?.op_inner?.path_payment_strict_send?.success?.last?.amount
      return amt != null ? stroopsToAmount(String(amt)) : null
    }
    const op = r.result().results()[0].tr().pathPaymentStrictSendResult().success().last()
    return stroopsToAmount(op.amount().toString())
  } catch {
    return null
  }
}

export { NETWORKS }
