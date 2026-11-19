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

test('chain hours fill dividend history and history buckets without snapshots, never replacing a snapshot', async () => {
  const { getDividendHistory, getHistory } = await import('../src/storage.mjs');
  const db = database(); db.native.exec(readFileSync(new URL('../migrations/0003_chain_hourly.sql', import.meta.url), 'utf8'));
  const end = 1000 * 3600000, now = end + 30 * 60000, e18 = v => (BigInt(v) * 10n ** 18n).toString();
  await saveSnapshot(db, { collectedAt: end, markets: [], sources: {}, rewardAccumulatorRaw: '200', paper: { supply: 5 } });
  for (const [h, acc] of [[end - 3600000, '100'], [end, '999']]) db.native.prepare('INSERT INTO chain_hourly (hour_at, block, block_at, paper_supply, staked_supply, accumulator, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(h, 1, h + 2000, e18(7), e18(6), acc, now);
  const rows = (await getDividendHistory(db, now)).rows;
  assert.deepEqual(rows.map(r => [r.collected_at - end, r.reward_accumulator, r.source ?? 'snapshot']), [[-3598000, '100', 'chain'], [0, '200', 'snapshot']]);
  const h = (await getHistory(db, 2, now)).rows;
  assert.deepEqual(h.map(r => [r.collected_at - end, r.paper_supply, r.source ?? 'snapshot']), [[-3598000, 7, 'chain'], [0, 5, 'snapshot']]);
});

test('exposure endpoint returns the first snapshot per 15 minutes with legs matched by symbol', async () => {
  const db = database(), now = Date.parse('2026-11-19T06:00:00Z');
  const snap = (at, swap) => ({ collectedAt: at, markets: [{ coin: 'BTC', mid: 60000 }, { coin: 'ETH', mid: 2000 }], sources: { traderBook: { ok: true } }, traderBook: { unrealizedPnl: -5 },
    balances: { lp: 4.9e6, tvl: 2e7 }, trading: { instruments: swap ? [{ symbol: 'ETH', longOi: 3, shortOi: 4 }, { symbol: 'BTC', longOi: 1, shortOi: 2 }] : [{ symbol: 'BTC', longOi: 1, shortOi: 2 }, { symbol: 'ETH', longOi: 3, shortOi: 4 }] } });
  for (const [m, swap] of [[0, false], [5, false], [15, true]]) await saveSnapshot(db, snap(now - 60 * 60000 + m * 60000, swap));
  const res = await api(new Request('https://test/api/exposure?days=1'), db);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const { points } = await res.json();
  assert.equal(points.length, 2);
  assert.deepEqual(points[1].slice(1, 9), [4.9e6, 2e7, 1, 2, 3, 4, 60000, 2000]); assert.equal(points[1][11], -5);
});
