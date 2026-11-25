import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { saveSnapshot, purgeExpired } from '../src/storage.mjs';
import { collect, minuteOperations } from '../src/collect.mjs';
import { api } from '../src/worker.mjs';
import { attachAuxiliary } from '../src/auxiliary.mjs';

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

test('core minute rows keep batch counts while auxiliary retains the full governance state', async () => {
  const previous = { governance: {
    at: 1, lastScannedBlock: 9, operations: [{ id: 'op', selector: '8b07f62b', batchSize: 1, batch: [{ selector: 'deadbeef' }] }],
    recentEvents: [{ tx: '0x1' }], gaps: [[1, 2]], orphanEndings: [{ id: 'missing' }], batchBackfill: 1, stale: false,
  } };
  const saved = structuredClone(previous);
  const fetcher = async () => { throw new Error('offline'); };
  const s = await collect({ previous, auxiliary: false, deriveRisk: false, fetcher });
  assert.deepEqual(s.governance, { at: 1, lastScannedBlock: 9, operations: [{ id: 'op', selector: '8b07f62b', batchSize: 1 }], stale: false });
  assert.deepEqual(previous, saved);
  const attached = attachAuxiliary(s, previous).governance;
  assert.equal(attached.operations[0].batch[0].selector, 'deadbeef');
  assert.deepEqual(attached.orphanEndings, saved.governance.orphanEndings);
  assert.equal(attached.batchBackfill, 1);
});

test('minute rows stay small however long the governance history grows', () => {
  const id = n => '0x' + n.toString(16).padStart(64, '0');
  const ended = Array.from({ length: 200 }, (_, n) => ({ kind: 'batchScheduled', id: id(n), salt: id(n), target: id(1).slice(0, 42), selector: '8b07f62b', label: 'timelock 批量排程 scheduleBatch', where: 'Timelock（最短延迟 1 天）',
    batchSize: 64, batch: [{}], readyAt: 1, scheduledBlock: n, scheduledTx: id(n), resolvedBlock: 1000 + n, resolvedTopic: id(7), outcome: 'executed' }));
  const legacy = { id: id(900), selector: '12baae3b', readyAt: 1, scheduledBlock: 5, resolvedBlock: 5000, resolvedTopic: id(8) };
  const pending = { kind: 'batchScheduled', id: id(999), selector: '8b07f62b', batchSize: 2, batch: [{}, {}], readyAt: 2, scheduledBlock: 3000, scheduledTx: id(3) };
  const all = [...ended, legacy, pending], saved = structuredClone(all), rows = minuteOperations(all);
  assert.deepEqual(all, saved);
  assert.equal(rows.length, 21);
  assert.deepEqual(rows.at(-1), { kind: 'batchScheduled', id: id(999), selector: '8b07f62b', batchSize: 2, readyAt: 2, scheduledBlock: 3000, scheduledTx: id(3) });
  assert.deepEqual(rows.at(-2), legacy);
  assert.deepEqual(rows[0], { id: id(181), selector: '8b07f62b', readyAt: 1, scheduledBlock: 181, resolvedBlock: 1181, outcome: 'executed' });
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 5000);
  const sameBlock = Array.from({ length: 21 }, (_, n) => ({ id: id(n), resolvedBlock: 9, resolvedLogIndex: n === 20 ? 99 : n, outcome: 'executed' }));
  assert.ok(minuteOperations(sameBlock).some(o => o.id === id(20)));
});

test('public JSON responses allow cross-origin reads', async () => {
  const response = await api(new Request('https://test/api/health'), database());
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('archive pages report the row count between the cursor and the upper bound', async () => {
  const { exportSnapshots } = await import('../src/storage.mjs');
  const db = database(), start = Date.parse('2026-11-19T00:00:00Z');
  for (let i = 0; i < 5; i++) await saveSnapshot(db, { collectedAt: start + i * 60000, markets: [], sources: {} });
  const page = await exportSnapshots(db, { after: start + 60000, through: start + 3 * 60000, limit: 1, withWindow: true });
  assert.deepEqual(page.window, { after: start + 60000, count: 2 });
  assert.deepEqual(page.available, { oldestAt: start, latestAt: start + 3 * 60000, count: null });
  assert.equal('window' in await exportSnapshots(db, { after: start + 60000, through: start + 3 * 60000, limit: 1 }), false);
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
  const res = await api(new Request('https://test/api/exposure?days=14'), db);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const { getExposure } = await import('../src/storage.mjs');
  const { points } = await getExposure(db, 1, now);
  assert.equal(points.length, 2);
  assert.equal((await getExposure(db, 1, now, now - 50 * 60000)).points.length, 1); // since skips older buckets
  assert.deepEqual(points[1].slice(1, 9), [4.9e6, 2e7, 1, 2, 3, 4, 60000, 2000]); assert.equal(points[1][11], -5);
});

test('hour-boundary lookups walk the hours first and never scan the stored minutes once per hour', async () => {
  const { getDividendHistory } = await import('../src/storage.mjs'), { missingHours } = await import('../src/chain-index.mjs');
  const db = database(); db.native.exec(readFileSync(new URL('../migrations/0003_chain_hourly.sql', import.meta.url), 'utf8'));
  const hour = 3600000, end = 1000 * hour, now = end + 90000;
  const insert = db.native.prepare("INSERT INTO snapshots (collected_at, reward_accumulator, payload) VALUES (?, ?, '{}')");
  for (let t = end - 60 * hour; t <= now + 120000; t += 60000) insert.run(t, String(t));
  const queries = [], spy = { prepare(sql) { queries.push(sql); return db.prepare(sql); } };
  const { rows } = await getDividendHistory(spy, now);
  const want = [];
  for (let h = end - 48 * hour; h <= end; h += hour) for (let t = h - 120000; t <= h + 120000; t += 60000) if (t <= now) want.push(t);
  assert.deepEqual(rows.map(r => r.collected_at), want);
  assert.deepEqual((await getDividendHistory(spy, end + 30 * 60000)).rows.at(-1).collected_at, now + 90000);
  assert.deepEqual(await missingHours(spy, now, end - 60 * hour), []);
  const joins = queries.filter(sql => sql.includes('WITH RECURSIVE'));
  assert.equal(joins.length, 3);
  for (const sql of joins) {
    const plan = db.native.prepare('EXPLAIN QUERY PLAN ' + sql).all(...Array(Math.max(...[...sql.matchAll(/\?(\d)/g)].map(m => +m[1]))).fill(0)).map(r => r.detail);
    const lookup = plan.findIndex(d => /^SEARCH s USING/.test(d));
    assert.ok(lookup > 0 && plan.findLastIndex(d => d === 'SCAN hours') < lookup, plan.join(' | '));
  }
});
