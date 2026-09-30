// Plan status page: polls the API, renders every purchase with its window and result.
(function () {
  var W = window.damlaWallet;
  var L = window.damlaI18n;
  var T = function (key, vars) { return L.t(key, vars); };
  var API = W.apiBase;
  var id = new URLSearchParams(location.search).get('id') || '';
  var $ = function (id) { return document.getElementById(id); };
  var PLANS_KEY = 'damla-plans';
  function saved() { try { return JSON.parse(localStorage.getItem(PLANS_KEY) || '[]'); } catch (e) { return []; } }
  var mine = saved().find(function (p) { return p.id === id; }) || null;
  var currentPlan = null;

  var STATUS = {
    pending: ['pending', 'wait'], success: ['success', 'ok'], failed: ['failed', 'bad'], expired: ['expired', 'dim'],
    superseded: ['expired', 'dim'], cancelled: ['cancelled', 'dim']
  };
  function fmt(t) { return t ? esc(new Date(t * 1000).toLocaleString(L.locale)) : ''; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeUrl(u) { return /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?$/.test(u) ? u : '#'; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n.toFixed(d) : '?'; }
  function short(h) { return h.slice(0, 8) + '…' + h.slice(-6); }

  async function load() {
    if (!/^[a-f0-9]{32}$/.test(id)) { $('plan').innerHTML = '<p class="warn">' + esc(T('plan.noid')) + '</p>'; return; }
    var p;
    try { p = await fetch(API + '/api/plans/' + id).then(function (x) { return x.json(); }); } catch (e) { $('plan').innerHTML = '<p class="warn">' + esc(T('dyn.api.unavailable')) + '</p>'; return; }
    if (p.error) { $('plan').innerHTML = '<p class="warn">' + esc(/not found/i.test(p.error) ? T('plan.notfound') : T('dyn.api.unavailable')) + '</p>'; return; }
    currentPlan = p;
    render(p);
  }

  function cadence(p) {
    var match = String(p.period || '').match(/^(\d+) (minutes|hours|days|weeks)$/);
    if (!match) return esc(p.periodLabel || p.period);
    return esc(Number(match[1]) === 1 ? T('dyn.cadence.' + match[2]) : T('dyn.cadence.many', { count: match[1], unit: T('app.unit.' + match[2]) }));
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
      + '<div><span class="tag ' + netTag + '">' + esc(T('common.' + netTag)) + '</span> <span class="tag st-' + esc(p.status) + '">' + esc(T('plan.status.' + p.status)) + '</span></div>'
      + '<h1>' + esc(p.amount) + ' USDC → XLM, ' + cadence(p) + ' × ' + esc(p.count) + '</h1>'
      + '<div class="kv">'
      + '<div><span>' + esc(T('plan.bought')) + '</span><b>' + done + ' / ' + esc(p.count) + '</b></div>'
      + '<div><span>' + esc(T('plan.received')) + '</span><b>' + totalXlm.toFixed(4) + '</b></div>'
      + '<div><span>' + esc(T('plan.floor')) + '</span><b>' + num(buys[0] && buys[0].destMin, 4) + ' XLM</b> <i>' + esc(T('plan.floor.detail', { quote: num(p.quoteXlm, 4), ceiling: p.ceiling })) + '</i></div>'
      + '<div><span>' + esc(T('plan.next')) + '</span><b>' + (next ? (next.minTime > now ? esc(T('plan.opens', { date: new Date(next.minTime * 1000).toLocaleString(L.locale) })) : esc(T('plan.open'))) : '—') + '</b></div>'
      + '<div><span>' + esc(T('common.wallet')) + '</span><b class="mono">' + esc(p.user) + '</b></div>'
      + '<div><span>' + esc(T('plan.channel')) + '</span><b class="mono"><a href="' + explorer + '/account/' + esc(p.channel) + '" target="_blank" rel="noopener">' + esc(p.channel) + '</a></b> <i>' + esc(T(p.channelKeyDestroyed ? 'plan.key.cleared' : 'plan.key.held')) + '</i></div>'
      + '</div></div>';

    var rows = buys.map(function (t) {
      var s = STATUS[t.status] || [t.status, ''];
      var when = t.status === 'success' ? fmt(t.executedAt) : fmt(t.minTime) + ' → ' + fmt(t.maxTime);
      var res = t.status === 'success'
        ? '<b>' + num(t.receivedXlm, 4) + ' XLM</b> · ' + esc(T('plan.ledger')) + ' ' + esc(t.ledger) + ' · <a href="' + explorer + '/tx/' + esc(t.hash) + '" target="_blank" rel="noopener">' + esc(short(String(t.hash))) + '</a>' + (t.note ? '<br><span class="dim small">' + esc(t.note) + '</span>' : '')
        : esc(t.note || (t.status === 'pending' && t.minTime > now ? T('plan.early', { date: new Date(t.minTime * 1000).toLocaleString(L.locale) }) : ''));
      return '<tr><td>' + esc(t.idx) + '</td><td><span class="pill ' + s[1] + '">' + esc(T('plan.status.' + s[0])) + '</span></td><td>' + when + '</td><td>' + res + '</td></tr>';
    }).join('');

    var actions = '';
    if (mine && mine.cancelToken && p.status === 'active') actions += '<button class="mini" id="btn-cancel">' + esc(T('plan.stop')) + '</button> ';
    if (mine && mine.cancelToken && p.status !== 'draft') actions += '<button class="mini" id="btn-export">' + esc(T('plan.export')) + '</button> ';
    if (!mine) actions += '<span class="dim small">' + esc(T('plan.device')) + '</span>';

    $('plan').innerHTML = head
      + '<table class="txs"><thead><tr><th>#</th><th>' + esc(T('plan.col.status')) + '</th><th>' + esc(T('plan.col.window')) + '</th><th>' + esc(T('plan.col.result')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="actions">' + actions + '</div>'
      + '<p class="dim small">' + esc(T('plan.disclosure')) + '</p>';

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
  document.addEventListener('damla:language', function () { if (currentPlan) render(currentPlan); });
  setInterval(load, 8000);
})();
