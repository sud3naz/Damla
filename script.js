// shared header behavior: network toggle + wallet connect (Freighter)
(function () {
  var NET_KEY = 'damla-net';
  var API = window.DAMLA_API || '';

  var netSwitch = document.getElementById('net-switch');
  var net = 'testnet';
  try { net = localStorage.getItem(NET_KEY) || 'testnet'; } catch (e) {}
  if (net !== 'testnet' && net !== 'mainnet') net = 'testnet';

  function renderNet() {
    if (!netSwitch) return;
    netSwitch.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.net === net);
    });
    document.dispatchEvent(new CustomEvent('damla:network', { detail: { network: net } }));
  }

  if (netSwitch) {
    netSwitch.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.dataset.net === net) return;
      net = b.dataset.net;
      try { localStorage.setItem(NET_KEY, net); } catch (e2) {}
      renderNet();
    });
    renderNet();
  }

  var walletBtn = document.getElementById('wallet-connect');
  var connectedAddr = null;
  var api = window.freighterApi || null;

  window.damlaWallet = {
    get address() { return connectedAddr; },
    get network() { return net; },
    get api() { return api; },
    apiBase: API,
    connect: connect,
    passphrase: function (n) {
      return (n || net) === 'mainnet'
        ? 'Public Global Stellar Network ; September 2015'
        : 'Test SDF Network ; September 2015';
    }
  };

  function shortAddr(a) { return a.slice(0, 4) + '…' + a.slice(-4); }

  async function connect() {
    if (connectedAddr) return connectedAddr;
    if (!api) { window.open('https://freighter.app', '_blank', 'noopener'); return null; }
    try {
      var c = await api.isConnected();
      if (!c || !c.isConnected) { window.open('https://freighter.app', '_blank', 'noopener'); return null; }
      var access = await api.requestAccess();
      if (access && access.error) throw new Error(access.error.message || 'declined');
      var addr = access && access.address;
      if (!addr) return null;
      connectedAddr = addr;
      walletBtn.textContent = shortAddr(addr);
      walletBtn.classList.add('connected');
      walletBtn.title = addr;
      walletBtn.disabled = true;
      document.dispatchEvent(new CustomEvent('damla:connected', { detail: { address: addr } }));
      return addr;
    } catch (e) { return null; }
  }

  if (walletBtn) walletBtn.addEventListener('click', connect);

  // silently restore a previously allowed connection
  if (api && walletBtn) {
    api.isAllowed().then(function (r) {
      if (r && r.isAllowed) return api.getAddress();
    }).then(function (r) {
      if (r && r.address) {
        connectedAddr = r.address;
        walletBtn.textContent = shortAddr(r.address);
        walletBtn.classList.add('connected');
        walletBtn.title = r.address;
        walletBtn.disabled = true;
        document.dispatchEvent(new CustomEvent('damla:connected', { detail: { address: r.address } }));
      }
    }).catch(function () {});
  }
})();
