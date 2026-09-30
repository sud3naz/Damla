/**
 * Trigger loop. For every active plan, submit the lowest-index purchase whose
 * window is open and whose preconditions will pass. Never more than one
 * submission per plan per tick. Predictable failures (no USDC, price above the
 * user's ceiling) are not submitted, because a failed transaction still
 * consumes its sequence slot; the purchase simply waits until its window ends.
 */
import { NETWORKS } from './config.js'
import { balances, loadAccountOrNull, quoteStrictSend, resultCodes, server, transactionOrNull } from './horizon.js'
import { submitWithFeeBump } from './feebump.js'
import { abandonDraft, receivedXlm } from './plan.js'
import { recoverAuthorization } from './single.js'

const CLOCK_MARGIN = 6 // seconds
const TERMINAL = new Set(['success', 'failed', 'expired', 'superseded', 'cancelled'])

export function createTrigger(db, { log = console.log, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const setTx = db.prepare('UPDATE txs SET status = ?, note = ?, result_code = ?, ledger = ?, received_xlm = ?, executed_at = ?, attempts = attempts + ? WHERE plan_id = ? AND idx = ?')
  const noteTx = db.prepare('UPDATE txs SET note = ? WHERE plan_id = ? AND idx = ?')
  const setPlanIfActive = db.prepare("UPDATE plans SET status = ?, note = ?, ended_at = ? WHERE id = ? AND status = 'active'")
  const setPlanIfRunning = db.prepare("UPDATE plans SET status = ?, note = ?, ended_at = ? WHERE id = ? AND status IN ('active', 'completed')")
  const setPlanIfCancelled = db.prepare("UPDATE plans SET status = ?, note = ?, ended_at = ? WHERE id = ? AND status = 'cancelled'")
  const setNext = db.prepare("UPDATE plans SET next_check_at = ? WHERE id = ? AND status <> 'cancelled'")
  const liveBuy = db.prepare('SELECT p.status AS plan_status, t.status AS tx_status FROM plans p JOIN txs t ON t.plan_id = p.id WHERE p.id = ? AND t.idx = ?')
  const planStatus = db.prepare('SELECT status FROM plans WHERE id = ?')
  const submitting = new Set()
  const WAIT_RETRY = 30 // seconds between re-checks while a purchase waits on funds or price

  function mark(planId, idx, status, note, extra = {}) {
    setTx.run(status, note ?? null, extra.code ?? null, extra.ledger ?? null, extra.received ?? null, extra.executedAt ?? null, extra.attempt ? 1 : 0, planId, idx)
  }

  async function reconcile(net, plan, tx) {
    const record = await transactionOrNull(net, tx.hash)
    if (!record) return null
    const success = record.successful === true
    const received = success ? receivedXlm(record.result_xdr) : null
    const confirmedAt = record.created_at ? Math.floor(Date.parse(record.created_at) / 1000) : NaN
    mark(plan.id, tx.idx, success ? 'success' : 'failed', 'confirmed from Horizon by transaction hash', {
      ledger: record.ledger, received,
      executedAt: Number.isFinite(confirmedAt) ? confirmedAt : now(),
    })
    log(`[${plan.id.slice(0, 8)}] #${tx.idx} reconciled ${success ? 'success' : 'failed'} ledger ${record.ledger}`)
    return success ? 'success' : 'failed'
  }

  async function submit(net, plan, tx) {
    try {
      const res = await submitWithFeeBump(net, tx.xdr, { log: (m) => log(`[${plan.id.slice(0, 8)}] #${tx.idx} ${m}`) })
      const received = receivedXlm(res.result_xdr)
      const note = res.bumped ? `fee bumped by the treasury (${res.feePerOp} stroops/op), outer hash ${res.hash}` : null
      mark(plan.id, tx.idx, 'success', note, { ledger: res.ledger, received, executedAt: now(), attempt: true })
      log(`[${plan.id.slice(0, 8)}] #${tx.idx} success ledger ${res.ledger} received ${received} XLM hash ${res.hash}${res.bumped ? ' (fee bumped)' : ''}`)
      return 'success'
    } catch (err) {
      const rc = resultCodes(err)
      const opCode = rc.ops[0] || null
      if (rc.tx === 'tx_failed') {
        // sequence slot consumed, fee paid, operation failed
        mark(plan.id, tx.idx, 'failed', `operation failed: ${opCode}`, { code: opCode, executedAt: now(), attempt: true })
        log(`[${plan.id.slice(0, 8)}] #${tx.idx} FAILED ${opCode}`)
        return 'failed'
      }
      if (rc.tx === 'tx_bad_seq') {
        const confirmed = await reconcile(net, plan, tx)
        if (confirmed) return confirmed
        mark(plan.id, tx.idx, 'pending', 'sequence changed; checking transaction hash on Horizon', { code: rc.tx, attempt: true })
        return 'wait'
      }
      if (rc.tx === 'tx_too_late') {
        mark(plan.id, tx.idx, 'expired', 'window closed', { code: rc.tx, attempt: true })
        return 'expired'
      }
      if (rc.tx === 'tx_too_early') {
        mark(plan.id, tx.idx, 'pending', 'protocol says too early (minSeqAge or time bounds), retrying', { code: rc.tx, attempt: true })
        return 'wait'
      }
      mark(plan.id, tx.idx, 'pending', `submit error: ${rc.tx || rc.message}`, { code: rc.tx, attempt: true })
      log(`[${plan.id.slice(0, 8)}] #${tx.idx} submit error ${rc.tx || rc.message} ${JSON.stringify(rc.ops)}`)
      return 'wait'
    }
  }

  /** Earliest moment at which this plan can need a Horizon call: a window opening or closing, or the merge. */
  function nextDue(plan, buys, merge) {
    let due = Infinity
    for (const tx of buys) {
      if (TERMINAL.has(tx.status)) continue
      due = Math.min(due, tx.min_time + CLOCK_MARGIN, tx.max_time + 1)
    }
    if (due === Infinity && merge && merge.status === 'pending') due = merge.min_time
    return due
  }

  async function tickPlan(plan) {
    const net = NETWORKS[plan.network]
    const t = now()
    const txs = db.prepare('SELECT * FROM txs WHERE plan_id = ? ORDER BY idx').all(plan.id)
    const buys = txs.filter((x) => x.kind === 'buy')
    const merge = txs.find((x) => x.kind === 'merge') || null

    // no Horizon traffic while nothing can happen yet
    if (t < (plan.next_check_at || 0)) return
    const due = nextDue(plan, buys, merge)
    if (due === Infinity) { if (plan.status === 'active') setPlanIfActive.run('completed', null, null, plan.id); return }
    if (t < due) { setNext.run(due, plan.id); return }
    let nextCheck = 0

    const chan = await loadAccountOrNull(net, plan.channel)
    if (!chan) {
      // channel already merged away (or never existed): nothing more can run
      setPlanIfRunning.run('done', 'channel account merged', t, plan.id)
      return
    }
    const seq = BigInt(chan.sequenceNumber())
    const seqTime = Number(chan.sequence_time || 0)

    for (const tx of buys) {
      if (TERMINAL.has(tx.status)) continue
      if (seq >= BigInt(tx.seq)) {
        if (await reconcile(net, plan, tx)) continue
        // A missing record may still be indexing, but after the signed time
        // window and a finality grace it cannot become a new purchase.
        if (tx.attempts > 0 && t <= tx.max_time + 120) {
          noteTx.run('sequence consumed; awaiting transaction record on Horizon', plan.id, tx.idx)
          nextCheck = t + WAIT_RETRY
          continue
        }
        mark(plan.id, tx.idx, 'superseded', 'a later purchase already ran')
        continue
      }
      if (plan.status === 'cancelled') { mark(plan.id, tx.idx, 'cancelled', 'plan stopped'); continue }
      if (t > tx.max_time) { mark(plan.id, tx.idx, 'expired', tx.note ? `window closed (${tx.note})` : 'window closed'); continue }
      // ledger close time can trail wall-clock by a few seconds; leave a small margin so a
      // submission is never rejected as tx_too_early just because the next ledger has not closed
      if (t < tx.min_time + CLOCK_MARGIN) break
      if (tx.min_seq_age > 0 && seqTime && t < seqTime + tx.min_seq_age + CLOCK_MARGIN) {
        noteTx.run(`waiting: channel sequence must be ${tx.min_seq_age}s old (${seqTime + tx.min_seq_age - t}s left)`, plan.id, tx.idx)
        nextCheck = seqTime + tx.min_seq_age + CLOCK_MARGIN
        break
      }
      const user = await loadAccountOrNull(net, plan.user)
      if (!user) { noteTx.run('waiting: user account missing', plan.id, tx.idx); nextCheck = t + WAIT_RETRY; break }
      const bal = balances(user, net)
      if (!bal.usdcTrustline || Number(bal.usdc) < Number(plan.amount)) {
        noteTx.run(`waiting: user has ${bal.usdc} USDC, needs ${plan.amount}`, plan.id, tx.idx)
        nextCheck = t + WAIT_RETRY
        break
      }
      const quote = await quoteStrictSend(net, plan.amount)
      if (!quote) { noteTx.run('waiting: no direct XLM/USDC market', plan.id, tx.idx); nextCheck = t + WAIT_RETRY; break }
      if (Number(quote) < Number(tx.dest_min)) {
        noteTx.run(`waiting: market gives ${quote} XLM, floor is ${tx.dest_min} (XLM above your ceiling)`, plan.id, tx.idx)
        nextCheck = t + WAIT_RETRY
        break
      }
      // Network checks above yielded to the API, so a stop may have landed.
      // Mark the actual submission in flight before yielding again; the API
      // returns 409 instead of claiming that an in-flight buy has stopped.
      const live = liveBuy.get(plan.id, tx.idx)
      if (live?.plan_status !== 'active' || live.tx_status !== 'pending') break
      submitting.add(plan.id)
      let submitted
      try { submitted = await submit(net, plan, tx) }
      finally { submitting.delete(plan.id) }
      if (submitted === 'wait') nextCheck = t + WAIT_RETRY
      break // one submission per plan per tick
    }

    const fresh = db.prepare("SELECT status FROM txs WHERE plan_id = ? AND kind = 'buy'").all(plan.id)
    const allDone = fresh.every((x) => TERMINAL.has(x.status))
    if (allDone && plan.status === 'active') setPlanIfActive.run('completed', null, null, plan.id)
    setNext.run(nextCheck, plan.id)

    if (merge && merge.status === 'pending' && t >= merge.min_time && (allDone || planStatus.get(plan.id)?.status === 'cancelled')) {
      const r = await submit(net, { ...plan }, merge)
      if (r === 'success' || r === 'superseded') {
        const note = net.treasurySecret ? 'channel merged back to treasury' : 'unused authorizations cleared'
        if (planStatus.get(plan.id)?.status === 'cancelled') setPlanIfCancelled.run('cancelled', note, t, plan.id)
        else setPlanIfRunning.run('done', note, t, plan.id)
      }
    }
  }

  async function expireDrafts(ttlSeconds) {
    const t = now()
    const authorizing = db.prepare("SELECT id FROM plans WHERE status = 'authorizing' AND next_check_at <= ?").all(t)
    for (const { id } of authorizing) {
      try { await recoverAuthorization(db, id) } catch (err) { log(`[${id.slice(0, 8)}] authorization recovery: ${err.message}`) }
    }
    const stale = db.prepare("SELECT id FROM plans WHERE ((status = 'draft' OR status = 'funding') AND created_at < ?) OR (status = 'cleanup' AND next_check_at <= ?)").all(t - ttlSeconds, t)
    for (const { id } of stale) {
      await abandonDraft(db, id, t)
      log(`[${id.slice(0, 8)}] draft cleanup checked`)
    }
  }

  let pausedUntil = 0
  async function tick() {
    if (now() < pausedUntil) return
    const plans = db.prepare("SELECT * FROM plans WHERE status IN ('active', 'completed', 'cancelled')").all()
    for (const plan of plans) {
      try { await tickPlan(plan) } catch (err) {
        if (err?.response?.status === 429) { pausedUntil = now() + 60; log('horizon rate limit, pausing the trigger for 60s'); return }
        log(`[${plan.id.slice(0, 8)}] tick error: ${err.message}`)
      }
    }
  }

  let timer = null
  function start(intervalMs, draftTtl) {
    const loop = async () => {
      try { await expireDrafts(draftTtl); await tick() } catch (err) { log(`tick error: ${err.message}`) }
      timer = setTimeout(loop, intervalMs)
    }
    loop()
  }
  function stop() { if (timer) clearTimeout(timer) }

  return { tick, tickPlan, expireDrafts, start, stop, isSubmitting: (id) => submitting.has(id) }
}

export { server }
