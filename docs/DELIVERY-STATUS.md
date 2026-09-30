# Damla teslim denetimi — 30 Eylül 2026

Paylaşılan Instawards SOW ekran görüntülerindeki 4.1, 5.1 ve 6.1 maddelerine göre **tek onaylı sürüm testnet API'sine ve canlı siteye dağıtıldı; gerçek Freighter videosu tamamlanmadığı için teslim koşullu**. Mainnet üretim trafiği bu SOW'un dışında ve henüz açık değil.

| SOW kalemi | Doğrulanan durum | Kalan teslim işi |
|---|---|---|
| 1. Plan oluşturma ve tek cüzdan onayı | `app.js`, `review.js` ve `src/plan.js` miktar, sıklık, 2–18 alım, fiyat tabanı, kanal hesabı, `PathPaymentStrictSend`, `minSeqNum`/`minSeqAge` ve tek Freighter `SetOptions` onayı kuruyor. Tarayıcı XDR'leri ve yetki hash'lerini bağımsız çözüp Horizon fiyatıyla denetliyor. [Dört alımlık tek imza testnet kanıtı](PROOF-single-testnet.md) var. Canlı sayfa yeni sürümü yüklüyor ve API'den fiyat alıyor. | Gerçek Freighter eklentisiyle baştan sona ekran kaydı yok. SOW'un “tüm işlemleri tek Freighter oturumunda önceden imzalama” ifadesiyle teknik farkın kabulü alınmalı: burada kullanıcı tek kurulum işlemini imzalıyor, sonraki XDR'ler onun `preAuthTx` imzacı hash'leriyle yetkilendiriliyor. Takvim ayı seçeneği yok; 30 günlük dönem kurulabilir. |
| 2. Zamanlanmış tetikleyici | `src/trigger.js` XDR'leri saklıyor, zamanında gönderiyor, hata sınıflandırıyor, yeniden deniyor ve plan sonunda kullanılmayan imzacıları temizliyor. Tek onaylı dört alımın tümü gerçek testnet üzerinde otomatik çalıştı. Bu sürüm canlı VPS'de `damla` servisi olarak etkin. | Yeni canlı dağıtımdan gerçek Freighter ile kurulmuş bir planın hash'leri henüz yok. |
| 3. Atlama/hata ve dört alımlık kanıt | [Dört başarılı alım](PROOF-testnet.md), [ikinci alımı kasıtlı atlayan dört alımlık plan](PROOF-skip-testnet.md) ve [tek onaylı dört alım + temizlik](PROOF-single-testnet.md) testnet hash'leriyle kayıtlı. | SOW'daki hızlandırılmış demo, gerçek zamanlı çalışma ve atlama kanıtını anlaşılır bir kısa video/dokümanda birleştir; canlı VPS üzerinden kanıt şartsa kontrollü testi ayrıca çalıştır. |

## Doğrulama

- `npm test`: 34/34 geçti. Gerçek tarayıcı SDK paketiyle XDR çözme, bağımsız Horizon fiyat sorgusu, mainnet USDC/ağ doğrulaması, sahte imzacı hash'i, yönlendirilmiş ödeme, geç kalan Horizon sonucu, rezerv temizliği ve kurtarma dışa aktarımı test edildi.
- Canlı `https://damla-lake.vercel.app/` tanıtım sayfası, `/app.html`, `review.js` ve Stellar SDK HTTP 200 verdi. Üretim arayüzü canlı testnet API fiyatını gösterdi. `https://damla-api.103-244-227-82.sslip.io/api/health` HTTP 200 ve yalnız `testnet` döndürdü.
- `npm audit --omit=dev --audit-level=high`: sıfır bilinen güvenlik açığı bildirdi.
- Codex Security tek onay akışı taramasında üç bulgu (bir orta, iki düşük) raporladı. Tarama anındaki kodda olan tarayıcı XDR doğrulaması, belirsiz sonuçtan sonra temizlik ve export eksiği yerel olarak düzeltildi; düzeltmeler test edildi. Tarama raporu düzeltme öncesi anlık görüntüyü anlatır.
- Dört alımlık canlı testnet kanıtı SDK ile **tek kullanıcı imzası** üretiyor; gerçek Freighter uzantısının onay penceresi henüz test edilmedi.

## Teslimden önce

1. Gerçek testnet Freighter cüzdanıyla tek onay penceresinden dört alımlık plan kur; tek cüzdan imzasını, dört otomatik alımı ve cleanup hash'ini gösteren kısa video kaydet. Gizli anahtar veya kurtarma sözcüklerini gösterme.
2. SOW sahibine tek `preAuthTx` kurulum imzasının “her işlemi önceden imzalama” şartını karşılayıp karşılamadığını ve aylık sıklığın takvim ayı mı 30 gün mü olduğunu yazılı olarak teyit ettir.
3. Canlı sürümde plan export, iptal, yeniden deneme ve atlama akışını tekrarla; SOW kanıt tablosuna canlı URL, depo sürümü, video ve testnet hash'lerini ekle.

## Mainnet geçiş kapısı

Mainnet treasury adresi `GBX7JD3TBBGRLBPV5IV4ENB4TLDZ6GPJYY4R5KS4HT4GYPFHY2WBHPXM` henüz Stellar Public Network üzerinde oluşturulmamış (Horizon 404). Adres, servis kanallarını fonlamak içindir; kullanıcı ödeme/ödül adresi değildir. Kaynak cüzdan ve XLM fonlama tutarı netleşip işlem zincirde doğrulanmadan `DAMLA_MAINNET_ENABLED=1` açılmamalı. İlk küçük USDC denemesi ve gerçek Freighter akışı da zincir hash'leriyle doğrulanmalı. Dağıtım öncesi VPS kaynak ve veritabanı yedeği `/var/backups/damla/pre-single-20260930/` altında alındı; anahtar içeren `env` kopyası yalnız sunucuda root erişimindedir.

Test hesapları Stellar **testnet** üzerindedir; kullanıcı ödül/ödeme cüzdanı değildir.
