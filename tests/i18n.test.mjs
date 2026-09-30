import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { GET, languageForCountry } from '../api/locale.js';

const root = resolve(import.meta.dirname, '..');
const scope = { window: {} };
runInNewContext(await readFile(resolve(root, 'i18n-data.js'), 'utf8'), scope);
const translations = scope.window.DAMLA_TRANSLATIONS;
const keys = Object.keys(translations.en);

test('IP country chooses the four local languages and defaults to English', async () => {
  for (const [country, expected] of [['TR', 'tr'], ['FR', 'fr'], ['ES', 'es'], ['DE', 'de'], ['GB', 'en'], ['US', 'en'], [null, 'en']]) {
    assert.equal(languageForCountry(country), expected);
    const request = new Request('https://damla.example/api/locale', { headers: country ? { 'x-vercel-ip-country': country } : {} });
    const response = GET(request);
    assert.equal((await response.json()).language, expected);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('all five languages cover each interface string and keep interpolation fields', () => {
  for (const language of ['en', 'tr', 'fr', 'es', 'de']) {
    assert.deepEqual(Object.keys(translations[language]), keys);
    for (const key of keys) {
      const fields = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.ok(translations[language][key].trim(), `${language}: ${key} is empty`);
      assert.deepEqual(fields(translations[language][key]), fields(translations.en[key]), `${language}: ${key} variables differ`);
    }
  }
});

test('every translated HTML label resolves in all languages', async () => {
  for (const page of ['index.html', 'app.html', 'plan.html', 'docs.html', 'faq.html']) {
    const html = await readFile(resolve(root, page), 'utf8');
    for (const [, key] of html.matchAll(/data-i18n(?:-aria|-placeholder)?="([^"]+)"/g)) {
      assert.ok(translations.en[key], `${page} has missing translation ${key}`);
    }
    assert.match(html, /id="language-select"/);
  }
});

test('dynamic planner and plan labels resolve in all languages', async () => {
  for (const page of ['app.js', 'plan-view.js']) {
    const code = await readFile(resolve(root, page), 'utf8');
    for (const [, key] of code.matchAll(/\bT\('([^']+)'/g)) {
      if (key.endsWith('.')) continue; // Variable suffixes are checked below.
      assert.ok(translations.en[key], `${page} has missing translation ${key}`);
    }
  }
  for (const unit of ['minutes', 'hours', 'days', 'weeks']) {
    for (const key of [`app.unit.${unit}`, `app.unit.${unit}.one`, `dyn.cadence.${unit}`]) {
      assert.ok(translations.en[key], `missing derived key ${key}`);
    }
  }
  for (const status of ['pending', 'success', 'failed', 'expired', 'cancelled', 'active', 'done', 'draft', 'funding', 'authorizing', 'cleanup', 'abandoned']) {
    assert.ok(translations.en[`plan.status.${status}`], `missing plan status ${status}`);
  }
});
