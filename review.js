// Independent browser check before the single Freighter authorization.
// The static site pins network and asset identities and decodes every XDR.
(function (root) {
  'use strict';
  var NETS = {
    testnet: { passphrase: 'Test SDF Network ; September 2015', horizon: 'https://horizon-testnet.stellar.org', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    mainnet: { passphrase: 'Public Global Stellar Network ; September 2015', horizon: 'https://horizon.stellar.org', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }
  };
  var UNITS = { minutes: 60, hours: 3600, days: 86400, weeks: 604800 };
  function insist(ok, message) { if (!ok) throw new Error('Plan verification failed: ' + message); }
  function stroops(value) {
    var s = String(value);
    insist(/^\d+(\.\d{1,7})?$/.test(s), 'invalid amount');
    var p = s.split('.');
    return BigInt(p[0]) * 10000000n + BigInt((p[1] || '').padEnd(7, '0'));
  }
  function hex(bytes) { return Array.from(bytes, function (v) { return v.toString(16).padStart(2, '0'); }).join(''); }
  function signatureBytes(sig) {
    var s = typeof sig.signature === 'function' ? sig.signature() : sig.signature;
    return s instanceof Uint8Array ? s : (typeof s.toBytes === 'function' ? s.toBytes() : s.value);
  }
  function isPlainSignerOp(op, source, hash, weight) {
    if (op.type !== 'setOptions' || (op.source || source) !== source || !op.signer ||
        hex(op.signer.preAuthTx || []) !== hash || op.signer.weight !== weight) return false;
    return Object.keys(op).every(function (key) {
      return key === 'type' || key === 'source' || key === 'signer' || op[key] == null;
    });
  }
  function cleanPreconditions(tx) {
    return !tx.ledgerBounds && !tx.minAccountSequenceLedgerGap && !(tx.extraSigners || []).length;
  }
  function txFromXdr(sdk, xdr, net) { return new sdk.Transaction(xdr, net.passphrase); }
  function verifyDraft(draft, intent, options) {
    options = options || {};
    var sdk = options.sdk || root.StellarSdk;
    insist(sdk && sdk.Transaction && sdk.Keypair, 'Stellar verifier unavailable');
    var net = NETS[intent.network];
    insist(net && draft.network === intent.network, 'wrong network');
    insist(draft.mode === 'single' && draft.user === intent.user, 'wrong plan owner or mode');
    insist(sdk.StrKey.isValidEd25519PublicKey(draft.channel), 'invalid channel');
    var count = Number(intent.count), period = Number(intent.every) * UNITS[intent.unit];
    insist(Number.isInteger(count) && count >= 2 && count <= 18, 'invalid purchase count');
    insist(Number.isSafeInteger(period) && period >= (intent.network === 'testnet' ? 60 : 3600), 'invalid cadence');
    insist(Number(draft.count) === count && Number(draft.periodSeconds) === period && Number(draft.ceiling) === Number(intent.ceiling), 'plan terms changed');
    insist(stroops(draft.amount) === stroops(intent.amount), 'purchase amount changed');
    var t0 = Number(draft.t0), now = Number(options.now || Math.floor(Date.now() / 1000));
    var intendedFirst = intent.start ? Math.max(now, Number(intent.start)) : now;
    insist(Number.isSafeInteger(t0) && t0 >= intendedFirst - 120 && t0 <= intendedFirst + 180, 'first purchase time changed');
    insist(Array.isArray(draft.txs) && draft.txs.length === count && draft.cleanup && draft.authorization, 'incomplete transaction set');
    var quote = stroops(options.quoteXlm);
    var floor = stroops(draft.destMin);
    var expectedFloor = quote * 100n / BigInt(100 + Number(intent.ceiling));
    insist(quote > 0n && floor > 0n && floor >= expectedFloor, 'price floor is lower than the independent Horizon quote allows; retry if the market moved');
    var startSeq = BigInt(draft.startSeq);
    var channel = sdk.Keypair.fromPublicKey(draft.channel);
    var hashes = [];
    draft.txs.forEach(function (item, i) {
      var tx = txFromXdr(sdk, item.xdr, net);
      var hash = hex(tx.hash());
      var min = t0 + i * period, max = t0 + (i + 2) * period;
      insist(item.idx === i + 1 && item.hash === hash && tx.source === draft.channel, 'purchase source or hash changed');
      insist(BigInt(tx.sequence) === startSeq + BigInt(i + 1) && BigInt(item.seq) === BigInt(tx.sequence), 'purchase sequence changed');
      insist(BigInt(tx.minAccountSequence || -1) === startSeq && BigInt(tx.minAccountSequenceAge || 0) === BigInt(i === 0 ? 0 : period) && cleanPreconditions(tx), 'purchase preconditions changed');
      insist(Number(tx.timeBounds.minTime) === min && Number(tx.timeBounds.maxTime) === max && Number(item.minTime) === min && Number(item.maxTime) === max && Number(item.minSeqAge) === (i === 0 ? 0 : period), 'purchase window changed');
      insist(tx.operations.length === 1, 'unexpected purchase operation');
      var op = tx.operations[0];
      insist(op.type === 'pathPaymentStrictSend' && op.source === intent.user && op.destination === intent.user, 'payment direction changed');
      insist(op.sendAsset.code === 'USDC' && op.sendAsset.issuer === net.issuer && op.destAsset.isNative() && op.path.length === 0, 'payment asset or route changed');
      insist(stroops(op.sendAmount) === stroops(intent.amount) && stroops(op.destMin) === floor, 'payment amount or floor changed');
      insist(tx.signatures.length === 1 && channel.verify(tx.hash(), signatureBytes(tx.signatures[0])), 'channel signature missing');
      hashes.push(hash);
    });
    var cleanup = txFromXdr(sdk, draft.cleanup.xdr, net);
    var cleanupHash = hex(cleanup.hash());
    insist(draft.cleanup.hash === cleanupHash && cleanup.source === draft.channel, 'cleanup source or hash changed');
    insist(BigInt(cleanup.sequence) === startSeq + BigInt(count + 1) && BigInt(cleanup.minAccountSequence || -1) === startSeq && !cleanup.minAccountSequenceAge && cleanPreconditions(cleanup), 'cleanup preconditions changed');
    insist(Number(cleanup.timeBounds.minTime) === 0 && Number(cleanup.timeBounds.maxTime) === 0, 'cleanup cannot run immediately');
    insist(cleanup.operations.length === count || cleanup.operations.length === count + 1, 'unexpected cleanup operation');
    hashes.forEach(function (hash, i) { insist(isPlainSignerOp(cleanup.operations[i], intent.user, hash, 0), 'cleanup does not remove an exact purchase signer'); });
    if (cleanup.operations.length === count + 1) {
      var merge = cleanup.operations[count];
      insist(merge.type === 'accountMerge' && (!merge.source || merge.source === draft.channel) && sdk.StrKey.isValidEd25519PublicKey(merge.destination), 'unexpected cleanup operation');
    }
    insist(cleanup.signatures.length === 1 && channel.verify(cleanup.hash(), signatureBytes(cleanup.signatures[0])), 'cleanup channel signature missing');
    hashes.push(cleanupHash);
    var setup = txFromXdr(sdk, draft.authorization.xdr, net);
    insist(setup.source === intent.user && draft.authorization.hash === hex(setup.hash()), 'setup hash or source changed');
    insist(setup.operations.length === count + 1 && setup.signatures.length === 0 && !setup.minAccountSequence && !setup.minAccountSequenceAge && cleanPreconditions(setup), 'unexpected setup authorization');
    insist(BigInt(setup.fee) === BigInt(count + 1) * BigInt(intent.network === 'testnet' ? 100 : 1000), 'unexpected wallet setup fee');
    insist(Number(setup.timeBounds.minTime) === 0 && Number(setup.timeBounds.maxTime) <= now + 1200 && Number(setup.timeBounds.maxTime) > now, 'unexpected setup expiry');
    var weight = setup.operations[0].signer && setup.operations[0].signer.weight;
    insist(Number.isInteger(weight) && weight >= 1 && weight <= 255, 'invalid signer weight');
    hashes.forEach(function (hash, i) { insist(isPlainSignerOp(setup.operations[i], intent.user, hash, weight), 'setup does not authorize an exact reviewed transaction'); });
    return { network: intent.network, user: intent.user, count: count, amount: String(intent.amount), firstTime: t0, periodSeconds: period, floorXlm: String(draft.destMin), quoteXlm: String(options.quoteXlm), reserveXlm: (count + 1) * 0.5, setupHash: hex(setup.hash()) };
  }
  async function trustedQuote(network, amount) {
    var net = NETS[network];
    insist(net, 'wrong network');
    var u = new URL('/paths/strict-send', net.horizon);
    u.searchParams.set('source_asset_type', 'credit_alphanum4');
    u.searchParams.set('source_asset_code', 'USDC');
    u.searchParams.set('source_asset_issuer', net.issuer);
    u.searchParams.set('source_amount', String(amount));
    u.searchParams.set('destination_assets', 'native');
    var response = await fetch(u.toString());
    insist(response.ok, 'independent Horizon quote unavailable');
    var data = await response.json();
    var direct = data._embedded.records.find(function (r) { return Array.isArray(r.path) && r.path.length === 0; });
    insist(direct && direct.destination_amount, 'direct USDC/XLM market unavailable');
    var networkTime = Date.parse(response.headers.get('Date') || '');
    return { amount: direct.destination_amount, now: Number.isFinite(networkTime) ? Math.floor(networkTime / 1000) : Math.floor(Date.now() / 1000) };
  }
  root.damlaReview = { verifyDraft: verifyDraft, trustedQuote: trustedQuote };
})(typeof window !== 'undefined' ? window : globalThis);
