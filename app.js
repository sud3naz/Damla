// Plan builder: one Freighter approval installs exact-hash purchase authorizations.
(function () {
  var W = window.damlaWallet;
  var L = window.damlaI18n;
  var T = function (key, vars) { return L.t(key, vars); };
  var API = W.apiBase;
  var state = { ceiling: 25, account: null, busy: false, quote: null, enabled: null, mainnetPilot: false, signing: 0 };
  var UNIT_S = { minutes: 60, hours: 3600, days: 86400, weeks: 7 * 86400 };
  var MIN_PERIOD = { testnet: 60, mainnet: 3600 };
  var MAX_PERIOD = 90 * 86400;
  var $ = function (id) { return document.getElementById(id); };

  var PLANS_KEY = 'damla-plans';
  var PENDING_KEY = 'damla-pending-authorization';
  var UNSIGNED_KEY = 'damla-unsigned-draft';

  function savedPlans() { try { return JSON.parse(localStorage.getItem(PLANS_KEY) || '[]'); } catch (e) { return []; } }
  function savePlan(p) {
    var all = savedPlans().filter(function (x) { return x.id !== p.id; });
    all.unshift(p);
    try { localStorage.setItem(PLANS_KEY, JSON.stringify(all.slice(0, 50))); } catch (e) {}
  }
  function pendingAuthorization() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (e) { return null; } }
  function savePending(p) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch (e) {} }
  function clearPending() { try { localStorage.removeItem(PENDING_KEY); } catch (e) {} }
  function unsignedDraft() { try { return JSON.parse(localStorage.getItem(UNSIGNED_KEY) || 'null'); } catch (e) { return null; } }
  function saveUnsignedDraft(p) { try { localStorage.setItem(UNSIGNED_KEY, JSON.stringify(p)); } catch (e) {} }
  function clearUnsignedDraft() { try { localStorage.removeItem(UNSIGNED_KEY); } catch (e) {} }

  async function cancelUnsignedDraft(p) {
    if (!p || !/^[a-f0-9]{32}$/.test(p.id) || !p.cancelToken) { clearUnsignedDraft(); return; }
    var url = API + '/api/plans/' + p.id;
    var statusResponse = await fetch(url);
    var status = await statusResponse.json();
    if (statusResponse.status === 404) { clearUnsignedDraft(); return; }
    if (!statusResponse.ok) throw new Error(status.error || 'Could not check the previous draft');
    if (['draft', 'funding', 'cleanup'].indexOf(status.status) < 0) { clearUnsignedDraft(); return; }
    var response = await fetch(url + '/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: p.cancelToken, unsignedOnly: true })
    });
    var result = await response.json();
    if (!response.ok || result.status !== 'abandoned') throw new Error(result.error || 'Draft cleanup is still pending; retry shortly');
    clearUnsignedDraft();
  }

  async function activateAuthorization(p) {
    var response = await fetch(API + '/api/plans/' + p.id + '/authorize', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedXdr: p.signedXdr })
    });
    var plan = await response.json();
    if (plan.error) throw new Error(plan.error);
    savePlan({ id: plan.id, network: plan.network, user: plan.user, cancelToken: p.cancelToken, createdAt: plan.createdAt });
    clearPending();
    location.href = 'plan.html?id=' + plan.id;
  }

  function amount() { return Number($('amount').value) || 0; }
  function every() { return Math.max(0, Math.floor(Number($('every').value) || 0)); }
  function unit() { return $('unit').value; }
  function count() { return Math.max(0, Math.floor(Number($('count').value) || 0)); }
  function periodS() { return every() * (UNIT_S[unit()] || 0); }
  function label() {
    var e = every(), u = unit();
    if (!e) return T('dyn.cadence.pick');
    return e === 1 ? T('dyn.cadence.' + u) : T('dyn.cadence.many', { count: e, unit: T('app.unit.' + u) });
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
    if (!amt || amt < 1) return T('dyn.amount.min');
    if (!every()) return T('dyn.cadence.integer');
    var minP = MIN_PERIOD[W.network] || 3600;
    if (P < minP) return T('dyn.cadence.min', { network: W.network, count: minP >= 3600 ? minP / 3600 : minP / 60, unit: minP >= 3600 ? T('dyn.hour') : T('dyn.minute') });
    if (P > MAX_PERIOD) return T('dyn.cadence.max');
    if (n < 2 || n > 18) return T('dyn.count.range');
    var s = startTs();
    if (s && s > Math.floor(Date.now() / 1000) + 60 * 86400) return T('dyn.start.max');
    return null;
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function refresh() {
    var amt = amount(), n = count();
    $('total').textContent = (amt * n).toLocaleString(L.locale) + ' USDC';
    $('cadence').textContent = label();
    $('unit').querySelectorAll('option').forEach(function (option) {
      option.textContent = T('app.unit.' + option.value + (every() === 1 ? '.one' : ''));
    });
    var minuteOpt = $('unit').querySelector('[value="minutes"]');
    if (minuteOpt) minuteOpt.hidden = W.network !== 'testnet';
    if (W.network !== 'testnet' && unit() === 'minutes') $('unit').value = 'days';
    var pr = problem();
    var cadenceError = !every() || periodS() < (MIN_PERIOD[W.network] || 3600) || periodS() > MAX_PERIOD;
    $('every-hint').textContent = pr && cadenceError ? pr : (periodS() ? T('dyn.cadence.hint', { cadence: label() }) : '');
    $('every-hint').classList.toggle('err', Boolean(pr && cadenceError));
    var ceilingExplain = $('ceiling-explain');
    if (ceilingExplain) ceilingExplain.textContent = T('app.ceiling.hint', { percent: state.ceiling });
    renderNetwork();
    renderPreview();
    if (state.quote) {
      $('quote').textContent = T('dyn.quote', {
        xlm: Number(state.quote).toFixed(2),
        floor: (Number(state.quote) / (1 + state.ceiling / 100)).toFixed(2)
      });
    } else $('quote').textContent = '';
    updateQuote();
  }

  function netEnabled() { return !state.enabled || state.enabled.indexOf(W.network) >= 0; }

  function renderNetwork() {
    var b = $('net-banner');
    if (!b) return;
    if (netEnabled()) {
      b.hidden = !(W.network === 'mainnet' && state.mainnetPilot);
      if (!b.hidden) b.textContent = T('app.net.pilot');
      $('sign').disabled = Boolean(problem()) || state.busy;
      return;
    }
    b.hidden = false;
    b.textContent = T('app.net.closed');
    $('sign').disabled = true;
    var mainnetButton = document.querySelector('#net-switch [data-net="mainnet"]');
    if (mainnetButton) mainnetButton.title = T('app.net.closed');
  }

  function fmtDate(t) {
    var d = new Date(t * 1000);
    var P = periodS();
    if (P < 86400) return d.toLocaleDateString(L.locale, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(L.locale, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(L.locale, { weekday: 'short', day: 'numeric', month: 'short', year: (P * count() > 300 * 86400) ? 'numeric' : undefined });
  }

  function renderPreview() {
    var pv = $('preview'), sc = $('schedule');
    if (!pv || !sc) return;
    var n = count(), P = periodS();
    var connected = Boolean(W.address);
    pv.innerHTML = [
      '<li class="' + (connected ? 'done' : '') + '"><span class="k">1</span><div>' + esc(T('dyn.preview.connect')) + '</div></li>',
      '<li><span class="k">2</span><div>' + esc(T('dyn.preview.approve', { count: n })) + '<br>' + esc(T('dyn.preview.reserve', { reserve: ((n + 1) * 0.5).toFixed(1) })) + '</div></li>',
      '<li><span class="k">3</span><div>' + esc(T('dyn.preview.run')) + '</div></li>'
    ].join('');
    var t0 = firstTs();
    var rows = [];
    if (!P || n < 2) { sc.innerHTML = '<li class="more">' + esc(problem() || '') + '</li>'; renderStepper(); return; }
    var show = Math.min(n, 5);
    for (var i = 0; i < show; i++) {
      var t = t0 + i * P;
      rows.push('<li><span>#' + (i + 1) + (i === 0 && !startTs() ? ' · ' + esc(T('dyn.schedule.soon')) : '') + '</span><b>' + esc(fmtDate(t)) + '</b></li>');
    }
    if (n > show) rows.push('<li class="more">' + esc(T('dyn.schedule.more', { count: n - show, date: fmtDate(t0 + (n - 1) * P) })) + '</li>');
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
  var quoteVersion = 0;
  function updateQuote() {
    clearTimeout(quoteTimer);
    var version = ++quoteVersion;
    quoteTimer = setTimeout(async function () {
      var amt = amount();
      if (!amt) return;
      try {
        var r = await fetch(API + '/api/quote?network=' + W.network + '&amount=' + amt).then(function (x) { return x.json(); });
        if (version !== quoteVersion) return;
        state.quote = r.xlm;
        renderPreview();
        if (r.xlm) {
          var floor = Number(r.xlm) / (1 + state.ceiling / 100);
          $('quote').textContent = T('dyn.quote', { xlm: Number(r.xlm).toFixed(2), floor: floor.toFixed(2) });
        } else if (r.error) {
          $('quote').textContent = netEnabled() ? T('dyn.quote.unavailable') : '';
        } else {
          $('quote').textContent = T('dyn.quote.none');
        }
      } catch (e) { if (version === quoteVersion) $('quote').textContent = T('dyn.api.unavailable'); }
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
    if (!W.address) { box.innerHTML = ''; if (who) who.textContent = T('app.connect.prompt'); return; }
    if (who) who.innerHTML = esc(T('dyn.connected')) + '<b>' + esc(W.address) + '</b>';
    if (!a || a.error) { box.innerHTML = '<span class="warn">' + esc(T('dyn.account.unavailable')) + '</span>'; return; }
    if (!a.exists) {
      box.innerHTML = '<span class="warn">' + esc(T('dyn.account.missing', { network: W.network })) + '</span>'
        + (W.network === 'testnet' ? ' <a href="https://lab.stellar.org/account/fund?$=network$id=testnet" target="_blank" rel="noopener">' + esc(T('dyn.account.fund')) + '</a>' : '');
      return;
    }
    var html = esc(T('dyn.account.balance', { usdc: (Number(a.usdc) || 0).toFixed(2), xlm: (Number(a.xlm) || 0).toFixed(2) }));
    if (!a.usdcTrustline) html += '<br><span class="warn">' + esc(T('dyn.account.trustline')) + '</span> <button class="mini" id="btn-trust">' + esc(T('dyn.account.addtrust')) + '</button>';
    else if (W.network === 'testnet' && Number(a.usdc) < amount()) html += '<br><button class="mini" id="btn-usdc">' + esc(T('dyn.account.gettest')) + '</button> <span class="dim">(' + esc(T('dyn.account.testnote')) + ')</span>';
    box.innerHTML = html;
    var t = $('btn-trust'); if (t) t.addEventListener('click', function () { helper('trustline'); });
    var u = $('btn-usdc'); if (u) u.addEventListener('click', function () { helper('test-usdc'); });
  }

  async function helper(kind) {
    setNote(T('dyn.action.preparing'));
    try {
      var r = await fetch(API + '/api/helper/' + kind + '?network=' + W.network + '&address=' + W.address).then(function (x) { return x.json(); });
      if (r.error) throw new Error(r.error);
      var s = await W.api.signTransaction(r.xdr, { networkPassphrase: r.networkPassphrase, address: W.address });
      if (s.error) throw new Error(s.error.message || T('dyn.sign.declined'));
      setNote(T('dyn.action.submitting'));
      var sub = await fetch(API + '/api/helper/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: W.network, xdr: s.signedTxXdr }) }).then(function (x) { return x.json(); });
      if (sub.error) throw new Error(sub.error + ' ' + (sub.tx || '') + ' ' + (sub.ops || []).join(','));
      setNote(T('dyn.action.done'));
      await loadAccount();
    } catch (e) { setNote(e.message || String(e), true); }
  }

  function setNote(msg, isErr) {
    var n = $('wallet-note');
    n.textContent = msg;
    n.classList.toggle('err', Boolean(isErr));
  }

  async function checkFreighterNetwork() {
    var r;
    try { r = await W.api.getNetwork(); } catch (e) { return; }
    var want = W.network === 'mainnet' ? 'PUBLIC' : 'TESTNET';
    if (r && r.network && r.network.toUpperCase() !== want) {
      throw new Error(T('dyn.freighter.network', { current: r.network, wanted: want }));
    }
  }

  async function signPlan() {
    if (state.busy) return;
    if (!W.address) { await W.connect(); if (!W.address) { setNote(T('dyn.action.connect'), true); return; } }
    var btn = $('sign');
    state.busy = true; btn.disabled = true; state.signing = 1; renderStepper();
    var draft = null;
    var signed = false;
    try {
      await checkFreighterNetwork();
      var pending = pendingAuthorization();
      if (pending && pending.user === W.address && pending.network === W.network) {
        setNote(T('dyn.action.recover'));
        try { await activateAuthorization(pending); return; }
        catch (e) {
          if (/expired|not found|does not await/.test(e.message || '')) clearPending();
          else throw e;
        }
      }
      var previous = unsignedDraft();
      if (previous && previous.user === W.address && previous.network === W.network) {
        setNote(T('dyn.action.recover'));
        await cancelUnsignedDraft(previous);
      }
      setNote(T('dyn.action.build'));
      var pr = problem();
      if (pr) throw new Error(pr);
      var body = { network: W.network, user: W.address, amount: String(amount()), every: every(), unit: unit(), count: count(), ceiling: state.ceiling, start: startTs(), mode: 'single' };
      draft = await fetch(API + '/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (x) { return x.json(); });
      if (draft.error) throw new Error(draft.error);
      saveUnsignedDraft({ id: draft.id, cancelToken: draft.cancelToken, network: W.network, user: W.address });
      if (!draft.authorization) throw new Error(T('dyn.action.noauth'));
      setNote(T('dyn.action.check'));
      var trustedQuote = await window.damlaReview.trustedQuote(body.network, body.amount);
      var checked = window.damlaReview.verifyDraft(draft, body, { quoteXlm: trustedQuote.amount, now: trustedQuote.now });
      var approved = window.confirm(T('dyn.review', {
        count: checked.count, amount: checked.amount, wallet: checked.user,
        floor: checked.floorXlm, first: new Date(checked.firstTime * 1000).toLocaleString(L.locale),
        minutes: checked.periodSeconds / 60, reserve: checked.reserveXlm
      }));
      if (!approved) throw new Error(T('dyn.action.cancelled'));
      setNote(T('dyn.action.sign'));
      var s = await W.api.signTransaction(draft.authorization.xdr, { networkPassphrase: W.passphrase(draft.network), address: W.address });
      if (s.error || !s.signedTxXdr) throw new Error(s.error ? (s.error.message || T('dyn.sign.declined')) : T('dyn.sign.noresponse'));
      signed = true;
      clearUnsignedDraft();
      setNote(T('dyn.action.activate'));
      var authorization = { id: draft.id, network: draft.network, user: W.address, signedXdr: s.signedTxXdr, cancelToken: draft.cancelToken };
      savePending(authorization);
      await activateAuthorization(authorization);
    } catch (e) {
      var message = e.message || String(e);
      if (draft && draft.id && !signed) {
        try { await cancelUnsignedDraft(draft); }
        catch (cleanupError) { message += ' · ' + (cleanupError.message || String(cleanupError)); }
      }
      setNote(message, true);
    } finally { state.busy = false; btn.disabled = Boolean(problem()) || !netEnabled(); state.signing = 0; renderStepper(); }
  }

  function renderMyPlans() {
    var box = $('my-plans');
    if (!box) return;
    var all = savedPlans().filter(function (p) { return !W.address || p.user === W.address; });
    if (!all.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<h2>' + esc(T('app.myplans')) + '</h2>' + all.map(function (p) {
      if (!/^[a-f0-9]{32}$/.test(String(p.id))) return '';
      var tag = p.network === 'mainnet' ? 'mainnet' : 'testnet';
      return '<a class="plan-link" href="plan.html?id=' + p.id + '"><span class="tag ' + tag + '">' + esc(T('common.' + tag)) + '</span> ' + p.id.slice(0, 8) + '… <span class="dim">' + esc(new Date(p.createdAt * 1000).toLocaleString(L.locale)) + '</span></a>';
    }).join('');
  }

  ['every', 'count', 'start'].forEach(function (id) { $(id).addEventListener('input', refresh); $(id).addEventListener('change', refresh); });
  $('unit').addEventListener('change', refresh);
  bindOpts('ceiling', function (el) { state.ceiling = Number(el.dataset.s); var l = $('ceil-label'); if (l) l.textContent = state.ceiling + '%'; refresh(); });
  $('amount').addEventListener('input', function () { state.quote = null; refresh(); renderAccount(); });
  $('sign').addEventListener('click', signPlan);
  document.addEventListener('damla:connected', function () { setNote(''); loadAccount(); renderMyPlans(); renderPreview(); });
  document.addEventListener('damla:network', function () { state.quote = null; refresh(); loadAccount(); renderMyPlans(); });
  document.addEventListener('damla:language', function () {
    var mainnetButton = document.querySelector('#net-switch [data-net="mainnet"]');
    if (mainnetButton && mainnetButton.classList.contains('off')) mainnetButton.title = T('app.net.closed');
    refresh(); renderAccount(); renderMyPlans();
  });

  fetch(API + '/api/health').then(function (x) { return x.json(); }).then(function (h) {
    state.enabled = h.networks || [];
    state.mainnetPilot = Boolean(h.mainnetPilot);
    var ms = document.querySelector('#net-switch [data-net="mainnet"]');
    if (ms && state.enabled.indexOf('mainnet') < 0) { ms.title = T('app.net.closed'); ms.classList.add('off'); }
    refresh();
  }).catch(function () { setNote(T('dyn.api.unavailable'), true); });

  refresh();
  renderMyPlans();
})();
