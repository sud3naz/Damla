// Plan builder: quote, checks, build draft, sign each purchase with Freighter, activate.
(function () {
  var W = window.damlaWallet;
  var API = W.apiBase;
  var state = { ceiling: 25, account: null, busy: false, quote: null, enabled: null, signing: 0 };
  var UNIT_S = { minutes: 60, hours: 3600, days: 86400, weeks: 7 * 86400 };
  var MIN_PERIOD = { testnet: 60, mainnet: 3600 };
  var MAX_PERIOD = 90 * 86400;
  var $ = function (id) { return document.getElementById(id); };

  var PLANS_KEY = 'damla-plans';

  function savedPlans() { try { return JSON.parse(localStorage.getItem(PLANS_KEY) || '[]'); } catch (e) { return []; } }
  function savePlan(p) {
    var all = savedPlans().filter(function (x) { return x.id !== p.id; });
    all.unshift(p);
    try { localStorage.setItem(PLANS_KEY, JSON.stringify(all.slice(0, 50))); } catch (e) {}
  }

  function amount() { return Number($('amount').value) || 0; }
  function every() { return Math.max(0, Math.floor(Number($('every').value) || 0)); }
  function unit() { return $('unit').value; }
  function count() { return Math.max(0, Math.floor(Number($('count').value) || 0)); }
  function periodS() { return every() * (UNIT_S[unit()] || 0); }
  function label() {
    var e = every(), u = unit();
    if (!e) return 'pick a cadence';
    return e === 1 ? 'every ' + u.replace(/s$/, '') : 'every ' + e + ' ' + u;
  }
  function startTs() {
    var v = $('start').value;
    if (!v) return null;
    var t = Math.floor(new Date(v).getTime() / 1000);
    return isFinite(t) ? t : null;
  }
  function firstTs() {
    var soon = Math.floor(Date.now() / 1000) + 60;
    var s = startTs();
    return s && s > soon ? s : soon;
  }
  function problem() {
    var P = periodS(), n = count(), amt = amount();
    if (!amt || amt < 1) return 'Amount must be at least 1 USDC.';
    if (!every()) return 'Cadence: enter a whole number of ' + unit() + '.';
    var minP = MIN_PERIOD[W.network] || 3600;
    if (P < minP) return 'The shortest cadence on ' + W.network + ' is every ' + (minP >= 3600 ? (minP / 3600) + ' hour' : (minP / 60) + ' minute') + '.';
    if (P > MAX_PERIOD) return 'The longest cadence is every 90 days.';
    if (n < 2 || n > 52) return 'Between 2 and 52 purchases.';
    var s = startTs();
    if (s && s > Math.floor(Date.now() / 1000) + 60 * 86400) return 'The first purchase can be at most 60 days out.';
    return null;
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function refresh() {
    var amt = amount(), n = count();
    $('total').textContent = (amt * n).toLocaleString('en-US') + ' USDC';
    $('cadence').textContent = label();
    var minuteOpt = $('unit').querySelector('[value="minutes"]');
    if (minuteOpt) minuteOpt.hidden = W.network !== 'testnet';
    if (W.network !== 'testnet' && unit() === 'minutes') $('unit').value = 'days';
    var pr = problem();
    $('every-hint').textContent = pr && /cadence/i.test(pr) ? pr : (periodS() ? 'One purchase ' + label() + '. Windows are two periods long, so a late submission is never lost.' : '');
    $('every-hint').classList.toggle('err', Boolean(pr && /cadence/i.test(pr)));
    renderNetwork();
    renderPreview();
    updateQuote();
  }

  function netEnabled() { return !state.enabled || state.enabled.indexOf(W.network) >= 0; }

  function renderNetwork() {
    var b = $('net-banner');
    if (!b) return;
    if (netEnabled()) { b.hidden = true; $('sign').disabled = Boolean(problem()); return; }
    b.hidden = false;
    b.innerHTML = '<b>Mainnet is not open yet.</b> Damla runs on Stellar testnet today, with free test USDC so you can try the whole flow. Switch to <b>Testnet</b> at the top right.';
    $('sign').disabled = true;
  }

  function fmtDate(t) {
    var d = new Date(t * 1000);
    var P = periodS();
    if (P < 86400) return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: (P * count() > 300 * 86400) ? 'numeric' : undefined });
  }

  function renderPreview() {
    var pv = $('preview'), sc = $('schedule');
    if (!pv || !sc) return;
    var amt = amount(), n = count(), P = periodS();
    var xlm = state.quote ? Number(state.quote) : null;
    var floor = xlm ? xlm / (1 + state.ceiling / 100) : null;
    var each = xlm ? 'about <b>' + xlm.toFixed(2) + ' XLM</b> (never less than ' + floor.toFixed(2) + ')' : '<b>XLM at market price</b>';
    var connected = Boolean(W.address);
    pv.innerHTML = [
      '<li class="' + (connected ? 'done' : '') + '"><span class="k">1</span><div><b>Connect Freighter.</b> ' + (connected ? 'Done.' : 'Top of the form.') + '</div></li>',
      '<li><span class="k">2</span><div><b>Sign ' + n + ' transactions</b>, one per purchase. Freighter asks ' + n + ' times, in one sitting. Each one: <b>' + amt + ' USDC</b> → ' + each + '. Only the date differs.</div></li>',
      '<li><span class="k">3</span><div><b>Walk away.</b> On each date the swap runs on Stellar\'s exchange and the XLM lands in your wallet. USDC leaves only at that moment.</div></li>',
      '<li><span class="k">4</span><div><b>Follow or stop</b> from your plan page. Stopping costs nothing; moving your USDC also stops it.</div></li>'
    ].join('');
    var t0 = firstTs();
    var rows = [];
    if (!P || n < 2) { sc.innerHTML = '<li class="more">' + esc(problem() || '') + '</li>'; renderStepper(); return; }
    var show = Math.min(n, 5);
    for (var i = 0; i < show; i++) {
      var t = t0 + i * P;
      rows.push('<li><span>#' + (i + 1) + (i === 0 && !startTs() ? ' · right after signing' : '') + '</span><b>' + fmtDate(t) + '</b></li>');
    }
    if (n > show) rows.push('<li class="more">+ ' + (n - show) + ' more, ' + esc(label()) + ', last one ' + fmtDate(t0 + (n - 1) * P) + '</li>');
    sc.innerHTML = rows.join('');
    renderStepper();
  }

  function renderStepper() {
    var st = $('stepper');
    if (!st) return;
    var items = st.querySelectorAll('li');
    var step = state.signing ? 3 : (W.address ? 2 : 1);
    items.forEach(function (li, i) {
      li.classList.toggle('done', i + 1 < step);
      li.classList.toggle('on', i + 1 === step);
    });
  }

  function select(boxId, attr, value) {
    $(boxId).querySelectorAll('.opt').forEach(function (o) { o.classList.toggle('on', o.dataset[attr] === value); });
  }

  function bindOpts(id, cb) {
    $(id).addEventListener('click', function (e) {
      var el = e.target.closest('.opt');
      if (!el) return;
      $(id).querySelectorAll('.opt').forEach(function (o) { o.classList.remove('on'); });
      el.classList.add('on');
      cb(el);
    });
  }

  var quoteTimer = null;
  function updateQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async function () {
      var amt = amount();
      if (!amt) return;
      try {
        var r = await fetch(API + '/api/quote?network=' + W.network + '&amount=' + amt).then(function (x) { return x.json(); });
        state.quote = r.xlm;
        renderPreview();
        if (r.xlm) {
          var floor = Number(r.xlm) / (1 + state.ceiling / 100);
          $('quote').innerHTML = 'Buys about <b>' + Number(r.xlm).toFixed(2) + ' XLM</b> at today\'s price · at least <b>' + floor.toFixed(2) + ' XLM</b> guaranteed per purchase';
        } else if (r.error) {
          $('quote').textContent = netEnabled() ? String(r.error) : '';
        } else {
          $('quote').textContent = 'no direct XLM/USDC market right now';
        }
      } catch (e) { $('quote').textContent = 'API unreachable'; }
    }, 250);
  }

  async function loadAccount() {
    if (!W.address) { state.account = null; renderAccount(); return; }
    try {
      state.account = await fetch(API + '/api/account?network=' + W.network + '&address=' + W.address).then(function (x) { return x.json(); });
    } catch (e) { state.account = { error: true }; }
    renderAccount();
  }

  function renderAccount() {
    var box = $('acct');
    var a = state.account;
    var who = $('who');
    if (!W.address) { box.innerHTML = ''; if (who) who.textContent = 'Connect your Freighter wallet to begin.'; return; }
    if (who) who.innerHTML = 'Connected<b>' + esc(W.address) + '</b>';
    if (!a || a.error) { box.innerHTML = '<span class="warn">Could not read your account from Horizon.</span>'; return; }
    if (!a.exists) {
      box.innerHTML = '<span class="warn">This account does not exist on ' + W.network + ' yet.</span>'
        + (W.network === 'testnet' ? ' <a href="https://lab.stellar.org/account/fund?$=network$id=testnet" target="_blank" rel="noopener">Fund it with friendbot</a>.' : '');
      return;
    }
    var html = 'Balance: <b>' + (Number(a.usdc) || 0).toFixed(2) + ' USDC</b> · ' + (Number(a.xlm) || 0).toFixed(2) + ' XLM';
    if (!a.usdcTrustline) html += '<br><span class="warn">No USDC trustline.</span> <button class="mini" id="btn-trust">Add USDC trustline</button>';
    else if (W.network === 'testnet' && Number(a.usdc) < amount()) html += '<br><button class="mini" id="btn-usdc">Get 100 test USDC</button> <span class="dim">(buys on the testnet DEX with test XLM)</span>';
    box.innerHTML = html;
    var t = $('btn-trust'); if (t) t.addEventListener('click', function () { helper('trustline'); });
    var u = $('btn-usdc'); if (u) u.addEventListener('click', function () { helper('test-usdc'); });
  }

  async function helper(kind) {
    setNote('Preparing transaction…');
    try {
      var r = await fetch(API + '/api/helper/' + kind + '?network=' + W.network + '&address=' + W.address).then(function (x) { return x.json(); });
      if (r.error) throw new Error(r.error);
      var s = await W.api.signTransaction(r.xdr, { networkPassphrase: r.networkPassphrase, address: W.address });
      if (s.error) throw new Error(s.error.message || 'signing declined');
      setNote('Submitting…');
      var sub = await fetch(API + '/api/helper/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: W.network, xdr: s.signedTxXdr }) }).then(function (x) { return x.json(); });
      if (sub.error) throw new Error(sub.error + ' ' + (sub.tx || '') + ' ' + (sub.ops || []).join(','));
      setNote('Done.');
      await loadAccount();
    } catch (e) { setNote(e.message || String(e), true); }
  }

  function setNote(msg, isErr) {
    var n = $('wallet-note');
    n.textContent = msg;
    n.classList.toggle('err', Boolean(isErr));
  }

  async function checkFreighterNetwork() {
    try {
      var r = await W.api.getNetwork();
      var want = W.network === 'mainnet' ? 'PUBLIC' : 'TESTNET';
      if (r && r.network && r.network.toUpperCase() !== want) {
        throw new Error('Freighter is on ' + r.network + ', switch it to ' + want + ' (top right of Freighter).');
      }
    } catch (e) { if (/switch it/.test(e.message)) throw e; }
  }

  async function signPlan() {
    if (state.busy) return;
    if (!W.address) { await W.connect(); if (!W.address) { setNote('Connect your Freighter wallet first.', true); return; } }
    var btn = $('sign');
    state.busy = true; btn.disabled = true; state.signing = 1; renderStepper();
    try {
      await checkFreighterNetwork();
      setNote('Building your plan…');
      var pr = problem();
      if (pr) throw new Error(pr);
      var body = { network: W.network, user: W.address, amount: String(amount()), every: every(), unit: unit(), count: count(), ceiling: state.ceiling, start: startTs() };
      var draft = await fetch(API + '/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (x) { return x.json(); });
      if (draft.error) throw new Error(draft.error);
      var signed = [];
      for (var i = 0; i < draft.txs.length; i++) {
        var t = draft.txs[i];
        setNote('Freighter: sign purchase ' + (i + 1) + ' of ' + draft.txs.length + '. Same amount each time, only the date differs.');
        var s = await W.api.signTransaction(t.xdr, { networkPassphrase: W.passphrase(draft.network), address: W.address });
        if (s.error) throw new Error('Purchase ' + (i + 1) + ': ' + (s.error.message || 'signing declined'));
        signed.push({ idx: t.idx, xdr: s.signedTxXdr });
      }
      setNote('Activating…');
      var plan = await fetch(API + '/api/plans/' + draft.id + '/finalize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed: signed }) }).then(function (x) { return x.json(); });
      if (plan.error) throw new Error(plan.error);
      savePlan({ id: plan.id, network: plan.network, user: plan.user, cancelToken: draft.cancelToken, createdAt: plan.createdAt });
      location.href = 'plan.html?id=' + plan.id;
    } catch (e) {
      setNote(e.message || String(e), true);
    } finally { state.busy = false; btn.disabled = false; state.signing = 0; renderStepper(); }
  }

  function renderMyPlans() {
    var box = $('my-plans');
    if (!box) return;
    var all = savedPlans().filter(function (p) { return !W.address || p.user === W.address; });
    if (!all.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<h2>Your plans</h2>' + all.map(function (p) {
      if (!/^[a-f0-9]{32}$/.test(String(p.id))) return '';
      var tag = p.network === 'mainnet' ? 'mainnet' : 'testnet';
      return '<a class="plan-link" href="plan.html?id=' + p.id + '"><span class="tag ' + tag + '">' + tag + '</span> ' + p.id.slice(0, 8) + '… <span class="dim">' + esc(new Date(p.createdAt * 1000).toLocaleString()) + '</span></a>';
    }).join('');
  }

  ['every', 'count', 'start'].forEach(function (id) { $(id).addEventListener('input', refresh); $(id).addEventListener('change', refresh); });
  $('unit').addEventListener('change', refresh);
  bindOpts('ceiling', function (el) { state.ceiling = Number(el.dataset.s); var l = $('ceil-label'); if (l) l.textContent = state.ceiling + '%'; refresh(); });
  $('amount').addEventListener('input', function () { refresh(); renderAccount(); });
  $('sign').addEventListener('click', signPlan);
  document.addEventListener('damla:connected', function () { setNote(''); loadAccount(); renderMyPlans(); renderPreview(); });
  document.addEventListener('damla:network', function () { refresh(); loadAccount(); renderMyPlans(); });

  fetch(API + '/api/health').then(function (x) { return x.json(); }).then(function (h) {
    state.enabled = h.networks || [];
    var ms = document.querySelector('#net-switch [data-net="mainnet"]');
    if (ms && state.enabled.indexOf('mainnet') < 0) { ms.title = 'Mainnet is not open yet'; ms.classList.add('off'); }
    refresh();
  }).catch(function () { setNote('API unreachable: ' + API, true); });

  refresh();
  renderMyPlans();
})();
