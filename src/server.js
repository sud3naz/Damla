import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { StrKey, TransactionBuilder, Operation, Asset } from '@stellar/stellar-sdk'
import { LIMITS, NETWORKS, PERIODS, SERVER, enabledNetworks } from './config.js'
import { PlanError, cancelPlan, createDraft, exportPlan, finalize, publicPlan } from './plan.js'
import { balances, loadAccountOrNull, quoteStrictSend, resultCodes, server as horizon, submitXdr, usdcAsset } from './horizon.js'

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' }

function json(res, status, body, origin) {
  const h = { 'content-type': 'application/json', 'cache-control': 'no-store' }
  if (origin) Object.assign(h, cors(origin))
  res.writeHead(status, h)
  res.end(JSON.stringify(body))
}

function cors(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

function allowedOrigin(req) {
  const o = req.headers.origin
  if (!o) return null
  return SERVER.corsOrigins.includes(o) ? o : null
}

async function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new PlanError('body too large', 413)); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { reject(new PlanError('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

// tiny fixed-window rate limiter per IP
const buckets = new Map()
function rateLimited(ip, limit = 120, windowMs = 60_000) {
  const t = Date.now()
  const b = buckets.get(ip) || { n: 0, reset: t + windowMs }
  if (t > b.reset) { b.n = 0; b.reset = t + windowMs }
  b.n += 1
  buckets.set(ip, b)
  if (buckets.size > 10000) buckets.clear()
  return b.n > limit
}

function netFrom(q) {
  const net = NETWORKS[q.get('network') || '']
  if (!net) throw new PlanError('unknown network')
  if (!enabledNetworks().includes(net.key)) throw new PlanError('network not enabled on this server', 503)
  return net
}

export function createServer(db, { webRoot } = {}) {
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const origin = allowedOrigin(req)
    const ip = req.headers['x-forwarded-for']?.split(',').pop().trim() || req.socket.remoteAddress

    if (req.method === 'OPTIONS') {
      res.writeHead(origin ? 204 : 403, origin ? cors(origin) : {})
      return res.end()
    }

    if (url.pathname.startsWith('/api/')) {
      if (rateLimited(ip)) return json(res, 429, { error: 'slow down' }, origin)
      try {
        return await api(req, res, url, origin)
      } catch (err) {
        if (err instanceof PlanError) return json(res, err.status, { error: err.message }, origin)
        const rc = resultCodes(err)
        console.error('api error', req.method, url.pathname, err?.stack || err)
        return json(res, 500, { error: 'internal error', detail: rc.tx || rc.message }, origin)
      }
    }

    if (webRoot && req.method === 'GET') return serveStatic(res, url.pathname)
    res.writeHead(404); res.end('not found')
  }

  async function api(req, res, url, origin) {
    const p = url.pathname
    const q = url.searchParams

    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, networks: enabledNetworks(), now: Math.floor(Date.now() / 1000) }, origin)

    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, {
        networks: enabledNetworks(),
        periods: Object.fromEntries(Object.entries(PERIODS).map(([k, v]) => [k, v])),
        limits: LIMITS,
        usdc: Object.fromEntries(Object.entries(NETWORKS).map(([k, v]) => [k, v.usdc])),
      }, origin)
    }

    if (req.method === 'GET' && p === '/api/quote') {
      const net = netFrom(q)
      const amount = q.get('amount') || '1'
      if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) throw new PlanError('bad amount')
      const xlm = await quoteStrictSend(net, amount)
      return json(res, 200, { network: net.key, amount, xlm, priceUsdcPerXlm: xlm ? (Number(amount) / Number(xlm)).toFixed(7) : null }, origin)
    }

    if (req.method === 'GET' && p === '/api/account') {
      const net = netFrom(q)
      const address = q.get('address') || ''
      if (!StrKey.isValidEd25519PublicKey(address)) throw new PlanError('bad address')
      const acct = await loadAccountOrNull(net, address)
      if (!acct) return json(res, 200, { exists: false }, origin)
      return json(res, 200, { exists: true, ...balances(acct, net) }, origin)
    }

    // helper transactions the user signs and submits themselves (fees paid by the user)
    if (req.method === 'GET' && p === '/api/helper/trustline') {
      const net = netFrom(q)
      const address = q.get('address') || ''
      if (!StrKey.isValidEd25519PublicKey(address)) throw new PlanError('bad address')
      const acct = await horizon(net).loadAccount(address)
      const tx = new TransactionBuilder(acct, { fee: String(net.baseFee * 10), networkPassphrase: net.passphrase })
        .addOperation(Operation.changeTrust({ asset: usdcAsset(net) }))
        .setTimeout(300).build()
      return json(res, 200, { xdr: tx.toXDR(), networkPassphrase: net.passphrase }, origin)
    }
    if (req.method === 'GET' && p === '/api/helper/test-usdc') {
      const net = netFrom(q)
      if (net.key !== 'testnet') throw new PlanError('testnet only')
      const address = q.get('address') || ''
      if (!StrKey.isValidEd25519PublicKey(address)) throw new PlanError('bad address')
      const acct = await horizon(net).loadAccount(address)
      const tx = new TransactionBuilder(acct, { fee: String(net.baseFee * 10), networkPassphrase: net.passphrase })
        .addOperation(Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(), sendMax: '5000', destination: address, destAsset: usdcAsset(net), destAmount: '100', path: [],
        }))
        .setTimeout(300).build()
      return json(res, 200, { xdr: tx.toXDR(), networkPassphrase: net.passphrase, note: 'buys 100 test USDC on the testnet DEX with up to 5000 test XLM' }, origin)
    }
    if (req.method === 'POST' && p === '/api/helper/submit') {
      const body = await readJson(req)
      const net = netFrom(new URLSearchParams({ network: body.network || '' }))
      if (typeof body.xdr !== 'string' || body.xdr.length > 20000) throw new PlanError('bad xdr')
      try {
        const r = await submitXdr(net, body.xdr)
        return json(res, 200, { hash: r.hash, ledger: r.ledger }, origin)
      } catch (err) {
        const rc = resultCodes(err)
        return json(res, 400, { error: 'submit failed', tx: rc.tx, ops: rc.ops }, origin)
      }
    }

    if (req.method === 'POST' && p === '/api/plans') {
      const body = await readJson(req)
      netFrom(new URLSearchParams({ network: body.network || '' }))
      const draft = await createDraft(db, body)
      return json(res, 201, draft, origin)
    }

    const m = p.match(/^\/api\/plans\/([a-f0-9]{32})(?:\/(finalize|export|cancel))?$/)
    if (m) {
      const [, id, action] = m
      if (req.method === 'GET' && !action) {
        const plan = publicPlan(db, id)
        if (!plan) throw new PlanError('plan not found', 404)
        return json(res, 200, plan, origin)
      }
      if (req.method === 'GET' && action === 'export') {
        const ex = exportPlan(db, id)
        if (!ex) throw new PlanError('plan not found', 404)
        return json(res, 200, ex, origin)
      }
      if (req.method === 'POST' && action === 'finalize') {
        const body = await readJson(req, 1024 * 1024)
        return json(res, 200, finalize(db, id, body.signed), origin)
      }
      if (req.method === 'POST' && action === 'cancel') {
        const body = await readJson(req)
        return json(res, 200, cancelPlan(db, id, body.token), origin)
      }
    }

    if (req.method === 'GET' && p === '/api/plans') {
      const user = q.get('user') || ''
      if (!StrKey.isValidEd25519PublicKey(user)) throw new PlanError('bad user')
      const rows = db.prepare("SELECT id FROM plans WHERE user = ? AND status != 'draft' ORDER BY created_at DESC LIMIT 50").all(user)
      return json(res, 200, { plans: rows.map((r) => publicPlan(db, r.id)) }, origin)
    }

    throw new PlanError('not found', 404)
  }

  async function serveStatic(res, pathname) {
    let file = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '')
    // only the public site: top-level pages/assets and vendor/, never dotfiles, src/, scripts/, tests/, db files
    if (!/^\/(vendor\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*\.(html|css|js|svg|png|md)$/.test(file)) { res.writeHead(404); return res.end('not found') }
    const full = join(webRoot, file)
    if (!full.startsWith(webRoot)) { res.writeHead(403); return res.end() }
    try {
      const st = await stat(full)
      if (!st.isFile()) throw new Error('nf')
      const body = await readFile(full)
      res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404); res.end('not found')
    }
  }

  return http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); try { res.writeHead(500); res.end() } catch {} }) })
}
