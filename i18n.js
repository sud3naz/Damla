(function () {
  var all = window.DAMLA_TRANSLATIONS || {};
  var allowed = ['en', 'tr', 'fr', 'es', 'de'];
  var current = 'en';
  var applied = false;
  var key = 'damla-language';
  var locales = { en: 'en-GB', tr: 'tr-TR', fr: 'fr-FR', es: 'es-ES', de: 'de-DE' };

  function t(name, vars) {
    var value = (all[current] && all[current][name]) || (all.en && all.en[name]) || name;
    return String(value).replace(/\{(\w+)\}/g, function (_, field) {
      return vars && vars[field] != null ? String(vars[field]) : '';
    });
  }

  function apply() {
    applied = true;
    document.documentElement.lang = current;
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    });
    var titleKey = document.body && document.body.dataset.titleKey;
    if (titleKey) document.title = t(titleKey);
    var description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', t('meta.description'));
    var picker = document.getElementById('language-select');
    if (picker) picker.value = current;
    document.dispatchEvent(new CustomEvent('damla:language', { detail: { language: current } }));
  }

  function setLanguage(language, remember) {
    if (!allowed.includes(language)) language = 'en';
    var changed = current !== language;
    current = language;
    if (remember) {
      try { localStorage.setItem(key, language); } catch (e) {}
    }
    if (document.readyState !== 'loading' && (changed || !applied)) apply();
  }

  window.damlaI18n = {
    t: t,
    get language() { return current; },
    get locale() { return locales[current]; },
    setLanguage: setLanguage
  };

  var saved = null;
  try { saved = localStorage.getItem(key); } catch (e) {}
  if (allowed.includes(saved)) current = saved;
  else {
    fetch('/api/locale', { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('locale unavailable');
      return response.json();
    }).then(function (geo) {
      // A manual choice made while this request was in flight always wins.
      var selected = null;
      try { selected = localStorage.getItem(key); } catch (e) {}
      setLanguage(allowed.includes(selected) ? selected : geo.language, false);
    }).catch(function () {
      var selected = null;
      try { selected = localStorage.getItem(key); } catch (e) {}
      setLanguage(allowed.includes(selected) ? selected : 'en', false);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    apply();
    var picker = document.getElementById('language-select');
    if (picker) picker.addEventListener('change', function () { setLanguage(picker.value, true); });
  });
})();
