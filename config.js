// Where the Damla API lives. Same origin when the API serves the site itself (local dev).
window.DAMLA_API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? ''
  : 'https://damla-api.103-244-227-82.sslip.io';
