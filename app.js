// Plan builder: quote, checks, build draft, sign each purchase with Freighter, activate.
(function () {
  var W = window.damlaWallet;
  var API = W.apiBase;
  var state = { count: 4, freq: 'weekly', ceiling: 25, account: null, busy: false, quote: null };
  var $ = function (id) { return document.getElementById(id); };

  var CADENCE = { minute: 'every minute (testnet demo)', daily: 'every day', weekly: 'every week', monthly: 'every 30 days' };
  var PLANS_KEY = 'damla-plans';

  function savedPlans() { try { return JSON.parse(localStorage.getItem(PLANS_KEY) || '[]'); } catch (e) { return []; } }
  function savePlan(p) {
    var all = savedPlans().filter(function (x) { return x.id !== p.id; });
    all.unshift(p);
    try { localStorage.setItem(PLANS_KEY, JSON.stringify(all.slice(0, 50))); } catch (e) {}
  }

  function amount() { return Number($('amount').value) || 0; }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function refresh() {
    var amt = amount();
    $('total').textContent = (amt * state.count).toLocaleString('en-US') + ' USDC';
    $('cadence').textContent = CADENCE[state.freq];
    var demo = $('freq').querySelector('[data-f="minute"]');
    if (demo) demo.hidden = W.network !== 'testnet';
    if (W.network !== 'testnet' && state.freq === 'minute') { state.freq = 'weekly'; select('freq', 'f', 'weekly'); }
    updateQuote();
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
        if (r.xlm) {
          var floor = Number(r.xlm) / (1 + state.ceiling / 100);
          $('quote').innerHTML = 'Buys about <b>' + Number(r.xlm).toFixed(2) + ' XLM</b> at today\'s price · at least <b>' + floor.toFixed(2) + ' XLM</b> guaranteed per purchase';
        } else if (r.error) {
          $('quote').textContent = String(r.error);
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
    state.busy = true; btn.disabled = true;
    try {
      await checkFreighterNetwork();
      setNote('Building your plan…');
      var body = { network: W.network, user: W.address, amount: String(amount()), period: state.freq, count: state.count, ceiling: state.ceiling };
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
    } finally { state.busy = false; btn.disabled = false; }
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

  bindOpts('freq', function (el) { state.freq = el.dataset.f; refresh(); });
  bindOpts('count', function (el) { state.count = Number(el.dataset.c); refresh(); });
  bindOpts('ceiling', function (el) { state.ceiling = Number(el.dataset.s); var l = $('ceil-label'); if (l) l.textContent = state.ceiling + '%'; refresh(); });
  $('amount').addEventListener('input', function () { refresh(); renderAccount(); });
  $('sign').addEventListener('click', signPlan);
  document.addEventListener('damla:connected', function () { setNote(''); loadAccount(); renderMyPlans(); });
  document.addEventListener('damla:network', function () { refresh(); loadAccount(); renderMyPlans(); });

  fetch(API + '/api/health').then(function (x) { return x.json(); }).then(function (h) {
    var ms = document.querySelector('#net-switch [data-net="mainnet"]');
    if (ms && h.networks.indexOf('mainnet') < 0) { ms.title = 'Mainnet is not enabled on this server yet'; ms.classList.add('off'); }
  }).catch(function () { setNote('API unreachable: ' + API, true); });

  refresh();
  renderMyPlans();
})();
