// Plan status page: polls the API, renders every purchase with its window and result.
(function () {
  var W = window.damlaWallet;
  var API = W.apiBase;
  var id = new URLSearchParams(location.search).get('id') || '';
  var $ = function (id) { return document.getElementById(id); };
  var PLANS_KEY = 'damla-plans';
  function saved() { try { return JSON.parse(localStorage.getItem(PLANS_KEY) || '[]'); } catch (e) { return []; } }
  var mine = saved().find(function (p) { return p.id === id; }) || null;

  var STATUS = {
    pending: ['Scheduled', 'wait'], success: ['Bought', 'ok'], failed: ['Failed on-chain', 'bad'], expired: ['Skipped', 'dim'],
    superseded: ['Skipped', 'dim'], cancelled: ['Cancelled', 'dim']
  };
  function fmt(t) { return t ? esc(new Date(t * 1000).toLocaleString()) : ''; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?$/.test(u) ? u : '#'; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n.toFixed(d) : '?'; }
  function short(h) { return h.slice(0, 8) + '…' + h.slice(-6); }

  async function load() {
    if (!/^[a-f0-9]{32}$/.test(id)) { $('plan').innerHTML = '<p class="warn">No plan id.</p>'; return; }
    var p;
    try { p = await fetch(API + '/api/plans/' + id).then(function (x) { return x.json(); }); } catch (e) { $('plan').innerHTML = '<p class="warn">API unreachable.</p>'; return; }
    if (p.error) { $('plan').innerHTML = '<p class="warn">' + esc(p.error) + '</p>'; return; }
    render(p);
  }

  function render(p) {
    var buys = p.txs.filter(function (t) { return t.kind === 'buy'; });
    var done = buys.filter(function (t) { return t.status === 'success'; }).length;
    var totalXlm = buys.reduce(function (s, t) { return s + (Number(t.receivedXlm) || 0); }, 0);
    var now = Math.floor(Date.now() / 1000);
    var next = buys.find(function (t) { return t.status === 'pending'; });
    var explorer = safeUrl(p.explorer);
    var netTag = p.network === 'mainnet' ? 'mainnet' : 'testnet';
    var head = '<div class="plan-head">'
      + '<div><span class="tag ' + netTag + '">' + esc(p.network) + '</span> <span class="tag st-' + esc(p.status) + '">' + esc(p.status) + '</span></div>'
      + '<h1>' + esc(p.amount) + ' USDC → XLM, ' + esc({ minute: 'every minute', daily: 'daily', weekly: 'weekly', monthly: 'every 30 days' }[p.period] || p.period) + ' × ' + esc(p.count) + '</h1>'
      + '<div class="kv">'
      + '<div><span>Bought</span><b>' + done + ' / ' + esc(p.count) + '</b></div>'
      + '<div><span>XLM received</span><b>' + totalXlm.toFixed(4) + '</b></div>'
      + '<div><span>Floor per purchase</span><b>' + num(buys[0] && buys[0].destMin, 4) + ' XLM</b> <i>(' + num(p.quoteXlm, 4) + ' at signing, ceiling +' + esc(p.ceiling) + '%)</i></div>'
      + '<div><span>Next</span><b>' + (next ? (next.minTime > now ? 'opens ' + fmt(next.minTime) : 'window open') : '—') + '</b></div>'
      + '<div><span>Wallet</span><b class="mono">' + esc(p.user) + '</b></div>'
      + '<div><span>Channel</span><b class="mono"><a href="' + explorer + '/account/' + esc(p.channel) + '" target="_blank" rel="noopener">' + esc(p.channel) + '</a></b> <i>' + (p.channelKeyDestroyed ? 'key destroyed after signing' : 'key held until activation') + '</i></div>'
      + '</div></div>';

    var rows = buys.map(function (t) {
      var s = STATUS[t.status] || [t.status, ''];
      var when = t.status === 'success' ? fmt(t.executedAt) : fmt(t.minTime) + ' → ' + fmt(t.maxTime);
      var res = t.status === 'success'
        ? '<b>' + num(t.receivedXlm, 4) + ' XLM</b> · ledger ' + esc(t.ledger) + ' · <a href="' + explorer + '/tx/' + esc(t.hash) + '" target="_blank" rel="noopener">' + esc(short(String(t.hash))) + '</a>' + (t.note ? '<br><span class="dim small">' + esc(t.note) + '</span>' : '')
        : esc(t.note || (t.status === 'pending' && t.minTime > now ? 'not yet: protocol rejects it before ' + new Date(t.minTime * 1000).toLocaleString() : ''));
      return '<tr><td>' + esc(t.idx) + '</td><td><span class="pill ' + s[1] + '">' + esc(s[0]) + '</span></td><td>' + when + '</td><td>' + res + '</td></tr>';
    }).join('');

    var actions = '';
    if (mine && mine.cancelToken && p.status === 'active') actions += '<button class="mini" id="btn-cancel">Stop this plan</button> ';
    if (mine && mine.cancelToken && p.status !== 'draft') actions += '<button class="mini" id="btn-export">Export signed envelopes</button> ';
    if (!mine) actions += '<span class="dim small">Stop and export are only available on the device that created this plan.</span>';

    $('plan').innerHTML = head
      + '<table class="txs"><thead><tr><th>#</th><th>Status</th><th>Window / time</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="actions">' + actions + '</div>'
      + '<p class="dim small">Stopping only tells this service to stop submitting. The envelopes stay valid inside their windows; the hard stop is moving your USDC. Export keeps a copy you can submit yourself if this service ever disappears. Keep the export private: whoever holds it can choose the moment inside each window.</p>';

    var c = $('btn-cancel');
    if (c) c.addEventListener('click', async function () {
      c.disabled = true;
      var r = await fetch(API + '/api/plans/' + p.id + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: mine.cancelToken }) }).then(function (x) { return x.json(); });
      if (r.error) alert(r.error); else render(r);
    });
    var e = $('btn-export');
    if (e) e.addEventListener('click', async function () {
      e.disabled = true;
      var r = await fetch(API + '/api/plans/' + p.id + '/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: mine.cancelToken }) }).then(function (x) { return x.json(); });
      e.disabled = false;
      if (r.error) { alert(r.error); return; }
      var blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'damla-plan-' + p.id.slice(0, 8) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
    });
  }

  load();
  setInterval(load, 8000);
})();
