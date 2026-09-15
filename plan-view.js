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
  function fmt(t) { return t ? new Date(t * 1000).toLocaleString() : ''; }
  function short(h) { return h.slice(0, 8) + '…' + h.slice(-6); }

  async function load() {
    if (!/^[a-f0-9]{32}$/.test(id)) { $('plan').innerHTML = '<p class="warn">No plan id.</p>'; return; }
    var p;
    try { p = await fetch(API + '/api/plans/' + id).then(function (x) { return x.json(); }); } catch (e) { $('plan').innerHTML = '<p class="warn">API unreachable.</p>'; return; }
    if (p.error) { $('plan').innerHTML = '<p class="warn">' + p.error + '</p>'; return; }
    render(p);
  }

  function render(p) {
    var buys = p.txs.filter(function (t) { return t.kind === 'buy'; });
    var done = buys.filter(function (t) { return t.status === 'success'; }).length;
    var totalXlm = buys.reduce(function (s, t) { return s + Number(t.receivedXlm || 0); }, 0);
    var now = Math.floor(Date.now() / 1000);
    var next = buys.find(function (t) { return t.status === 'pending'; });
    var head = '<div class="plan-head">'
      + '<div><span class="tag ' + p.network + '">' + p.network + '</span> <span class="tag st-' + p.status + '">' + p.status + '</span></div>'
      + '<h1>' + p.amount + ' USDC → XLM, ' + ({ minute: 'every minute', daily: 'daily', weekly: 'weekly', monthly: 'every 30 days' }[p.period] || p.period) + ' × ' + p.count + '</h1>'
      + '<div class="kv">'
      + '<div><span>Bought</span><b>' + done + ' / ' + p.count + '</b></div>'
      + '<div><span>XLM received</span><b>' + totalXlm.toFixed(4) + '</b></div>'
      + '<div><span>Floor per purchase</span><b>' + Number(buys[0].destMin).toFixed(4) + ' XLM</b> <i>(' + Number(p.quoteXlm).toFixed(4) + ' at signing, ceiling +' + p.ceiling + '%)</i></div>'
      + '<div><span>Next</span><b>' + (next ? (next.minTime > now ? 'opens ' + fmt(next.minTime) : 'window open') : '—') + '</b></div>'
      + '<div><span>Wallet</span><b class="mono">' + p.user + '</b></div>'
      + '<div><span>Channel</span><b class="mono"><a href="' + p.explorer + '/account/' + p.channel + '" target="_blank" rel="noopener">' + p.channel + '</a></b> <i>' + (p.channelKeyDestroyed ? 'key destroyed after signing' : 'key held until activation') + '</i></div>'
      + '</div></div>';

    var rows = buys.map(function (t) {
      var s = STATUS[t.status] || [t.status, ''];
      var when = t.status === 'success' ? fmt(t.executedAt) : fmt(t.minTime) + ' → ' + fmt(t.maxTime);
      var res = t.status === 'success' ? '<b>' + Number(t.receivedXlm).toFixed(4) + ' XLM</b> · ledger ' + t.ledger + ' · <a href="' + p.explorer + '/tx/' + t.hash + '" target="_blank" rel="noopener">' + short(t.hash) + '</a>'
        : (t.note || (t.status === 'pending' && t.minTime > now ? 'not yet: protocol rejects it before ' + fmt(t.minTime) : ''));
      return '<tr><td>' + t.idx + '</td><td><span class="pill ' + s[1] + '">' + s[0] + '</span></td><td>' + when + '</td><td>' + res + '</td></tr>';
    }).join('');

    var actions = '';
    if (mine && mine.cancelToken && (p.status === 'active')) actions += '<button class="mini" id="btn-cancel">Stop this plan</button> ';
    actions += '<a class="mini" href="' + API + '/api/plans/' + p.id + '/export" target="_blank" rel="noopener">Export signed envelopes</a>';

    $('plan').innerHTML = head
      + '<table class="txs"><thead><tr><th>#</th><th>Status</th><th>Window / time</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="actions">' + actions + '</div>'
      + '<p class="dim small">Stopping only tells this service to stop submitting. The envelopes stay valid inside their windows; the hard stop is moving your USDC. Export keeps a copy you can submit yourself if this service ever disappears.</p>';

    var c = $('btn-cancel');
    if (c) c.addEventListener('click', async function () {
      c.disabled = true;
      var r = await fetch(API + '/api/plans/' + p.id + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: mine.cancelToken }) }).then(function (x) { return x.json(); });
      if (r.error) alert(r.error); else render(r);
    });
  }

  load();
  setInterval(load, 8000);
})();
