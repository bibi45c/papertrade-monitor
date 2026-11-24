import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { english } from '../public/translations.mjs';
import { savedLanguage, translateMessage } from '../public/i18n.mjs';

test('English is the default, while explicit Chinese preference survives storage reads', () => {
  assert.equal(savedLanguage(null), 'en');
  assert.equal(savedLanguage({ getItem: () => 'zh' }), 'zh');
  assert.equal(savedLanguage({ getItem: () => 'fr' }), 'en');
  assert.equal(savedLanguage({ getItem() { throw new Error('Storage denied'); } }), 'en');
});

test('translated financial messages preserve numbers, units and estimate qualifiers', () => {
  const message = '估算，缺的用小时统计补 · 实测 28 / 估算 20 小时 · 不加权均值 0.28 U/小时，历史不代表以后';
  assert.equal(translateMessage(message, 'zh'), message);
  assert.equal(translateMessage(message, 'en'), 'Estimated (includes hourly-statistic fallback) · Measured 28 / Estimated 20 hours · Mean across valid hours 0.28 U/hour; not a future return forecast');
  assert.equal(translateMessage('回本门槛过高（>100 倍）', 'en'), 'Break-even threshold too high (>100×)');
  assert.equal(translateMessage('US CPI（9 月）', 'en'), 'US CPI (Sep)');
  assert.equal(translateMessage('统计窗口：10:00 — 10:00 · 有效 0/48 小时 · 加权覆盖 0.0% · 已过期，上次更新 08:00', 'en'), 'Completed-hour window: 10:00 — 10:00 · Valid 0/48 hours · Weighted coverage 0.0% · Stale data, last updated 08:00');
});

test('English HTML is usable before scripts and every static locale key has a translation', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /id="languageToggle"/);
  assert.match(html, /Hourly dividends per 10,000 PAPER/);
  const keys = [...html.matchAll(/data-i18n(?:-aria-label|-content)?="([^"]+)"/g)]
    .map(m => m[1].replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
  assert.ok(keys.length > 100);
  for (const key of keys) assert.equal(typeof english[key], 'string', key);
});

test('known model and governance messages do not leak Chinese into English alerts', () => {
  for (const relative of ['../src/model.mjs', '../src/watch.mjs']) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    for (const match of source.matchAll(/(['"])([^'"\n]*)\1/g)) {
      assert.doesNotMatch(translateMessage(match[2], 'en'), /\p{Script=Han}/u, match[2]);
    }
  }
});
