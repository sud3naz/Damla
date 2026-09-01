// shared header behavior: network toggle + wallet connect
(function () {
  var NET_KEY = 'damla-net';

  var netBtn = document.getElementById('net-toggle');
  var net = 'mainnet';
  try { net = localStorage.getItem(NET_KEY) || 'mainnet'; } catch (e) {}

  function renderNet() {
    if (!netBtn) return;
    netBtn.textContent = net === 'mainnet' ? 'Mainnet' : 'Testnet';
    netBtn.classList.toggle('testnet', net === 'testnet');
    netBtn.title = 'Switch to ' + (net === 'mainnet' ? 'Testnet' : 'Mainnet');
  }

  if (netBtn) {
    netBtn.addEventListener('click', function () {
      net = net === 'mainnet' ? 'testnet' : 'mainnet';
      try { localStorage.setItem(NET_KEY, net); } catch (e) {}
      renderNet();
    });
    renderNet();
  }

  var walletBtn = document.getElementById('wallet-connect');
  var connectedAddr = null;

  window.damlaWallet = {
    get address() { return connectedAddr; },
    get network() { return net; }
  };

  function shortAddr(a) { return a.slice(0, 4) + '…' + a.slice(-4); }

  async function connect() {
    if (connectedAddr) return;
    if (!window.freighterApi) {
      window.open('https://freighter.app', '_blank', 'noopener');
      return;
    }
    try {
      var access = await window.freighterApi.requestAccess();
      var addr = typeof access === 'string' ? access : access.address;
      if (!addr) return;
      connectedAddr = addr;
      walletBtn.textContent = shortAddr(addr);
      walletBtn.classList.add('connected');
      document.dispatchEvent(new CustomEvent('damla:connected', { detail: { address: addr } }));
    } catch (e) { /* user declined */ }
  }

  if (walletBtn) walletBtn.addEventListener('click', connect);
})();
