import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { saveSnapshot, purgeExpired } from '../src/storage.mjs';
import { collect } from '../src/collect.mjs';
import { api } from '../src/worker.mjs';

function database() {
  const native = new DatabaseSync(':memory:'); native.exec(readFileSync(new URL('../migrations/0001_snapshots.sql', import.meta.url), 'utf8'));
  const statement = sql => { let args = []; return { bind(...values) { args = values; return this; }, async run() { return native.prepare(sql).run(...args); },
    async first() { return native.prepare(sql).get(...args); }, async all() { return { results: native.prepare(sql).all(...args) }; } }; };
  return { native, prepare: statement, async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}

test('purge keeps 14 days of minutes, first row per hour until 90 days, nothing older', async () => {
  const db = database(), now = Date.parse('2026-11-19T00:17:00Z'), day = 86400000, hour = 3600000;
  const times = [];
  for (const base of [now - 100 * day, now - 30 * day, now - 15 * day, now - 2 * day]) {
    const h = Math.floor(base / hour) * hour;
    for (const m of [1, 2, 30]) times.push(h + m * 60000);
  }
  for (const at of times) await saveSnapshot(db, { collectedAt: at, markets: [], sources: {} });
  await purgeExpired(db, now);
  const left = db.native.prepare('SELECT collected_at FROM snapshots ORDER BY collected_at').all().map(r => r.collected_at);
  const at = (base, m) => Math.floor(base / hour) * hour + m * 60000;
  assert.deepEqual(left, [at(now - 30 * day, 1), at(now - 15 * day, 1), at(now - 2 * day, 1), at(now - 2 * day, 2), at(now - 2 * day, 30)]);
});

test('core minute rows keep a governance summary without recentEvents or gaps', async () => {
  const previous = { governance: { at: 1, lastScannedBlock: 9, operations: [{ id: 'op' }], recentEvents: [{ tx: '0x1' }], gaps: [[1, 2]], stale: false } };
  const fetcher = async () => { throw new Error('offline'); };
  const s = await collect({ previous, auxiliary: false, deriveRisk: false, fetcher });
  assert.deepEqual(s.governance, { at: 1, lastScannedBlock: 9, operations: [{ id: 'op' }], stale: false });
  assert.equal(previous.governance.recentEvents.length, 1);
});

test('public JSON responses allow cross-origin reads', async () => {
  const response = await api(new Request('https://test/api/health'), database());
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('archive pages report the row count between the cursor and the upper bound', async () => {
  const { exportSnapshots } = await import('../src/storage.mjs');
  const db = database(), start = Date.parse('2026-11-19T00:00:00Z');
  for (let i = 0; i < 5; i++) await saveSnapshot(db, { collectedAt: start + i * 60000, markets: [], sources: {} });
  const page = await exportSnapshots(db, { after: start + 60000, through: start + 3 * 60000, limit: 1 });
  assert.deepEqual(page.window, { after: start + 60000, count: 2 });
  assert.equal(page.available.count, 4);
});
