import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { saveSnapshot, getHistory, getDividendHistory, exportDay, purgeExpired } from '../src/storage.mjs';
function database() { const native = new DatabaseSync(':memory:'); native.exec(readFileSync(new URL('../migrations/0001_snapshots.sql', import.meta.url), 'utf8')); return { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async run() { return native.prepare(sql).run(...args); }, async all() { return { results: native.prepare(sql).all(...args) }; } }; } }; }
const snapshot = at => ({ collectedAt: at, paperSourceAt: at, paper: { supply: 100, staked: 10, pendingRewards: 20 }, rewardAccumulatorRaw: '1000000000000000000000000001', balances: { lp: 100 }, queue: { total: 0, count: 0 }, markets: [] });
test('compact dividend history retains hourly boundaries and the latest exact index', async()=>{
  const db=database(), end=1000*3600000, now=end+59*60000;
  for(const offset of [-3,-2,-1,0,1,2,3,58,59]) await saveSnapshot(db,snapshot(end+offset*60000));
  const result=await getDividendHistory(db,now);
  assert.deepEqual(result.rows.map(r=>(r.collected_at-end)/60000),[-2,-1,0,1,2,59]);
  assert.equal(result.rows[0].reward_accumulator,'1000000000000000000000000001');
  assert.deepEqual(Object.keys(result.rows[0]),['collected_at','reward_accumulator']);
});
test('minute snapshots deduplicate and retain exact reward accumulator strings', async () => {
  const db = database(), now = Date.parse('2026-10-10T14:00:00Z');
  await saveSnapshot(db, snapshot(now)); await saveSnapshot(db, snapshot(now + 1000));
  const h = await getHistory(db, 1, now + 60000); assert.equal(h.rows.length, 1); assert.equal(h.rows[0].reward_accumulator, '1000000000000000000000000001');
});
test('CSV exports nulls as empty and uses a validated UTC date', async () => {
  const db = database(); await saveSnapshot(db, snapshot(Date.parse('2026-10-10T14:00:00Z')));
  const csv = await exportDay(db, '2026-10-10'); assert.ok(csv.includes('reward_accumulator')); assert.ok(csv.includes(',"0","0"' + ','.repeat(19) + '\n')); assert.ok(!csv.includes('undefined'));
  await assert.rejects(() => exportDay(db, '2026-02-30')); await assert.rejects(() => exportDay(db, '"evil'));
});
test('execution queue history is extracted from existing JSON with old and failed samples kept null', async () => {
  const db = database(), now = Date.parse('2026-10-10T14:00:00Z');
  await saveSnapshot(db, snapshot(now));
  await saveSnapshot(db, { ...snapshot(now + 60000), executionQueue: { available: true, sourceAt: now + 60000, queuedIntents: 123, submittedIntents: 2, capacityBlocks: 20, saturationPct: 10 } });
  await saveSnapshot(db, { ...snapshot(now + 120000), executionQueue: { available: false, queuedIntents: 0 } });
  const h = await getHistory(db, 1, now + 180000);
  assert.equal(h.rows[0].execution_queued, null); assert.equal(h.rows[1].execution_queued, 123); assert.equal(h.rows[2].execution_queued, null);
  assert.equal(h.rows[1].execution_source_at, now + 60000); assert.ok((await exportDay(db, '2026-10-10')).includes('execution_queued'));
});
test('retention deletes only records outside the 90-day window', async () => {
  const db = database(), now = Date.parse('2026-10-10T14:00:00Z');
  await saveSnapshot(db, snapshot(now - 91 * 86400000)); await saveSnapshot(db, snapshot(now - 89 * 86400000));
  await purgeExpired(db, now); assert.equal((await getHistory(db, 2160, now)).rows.length, 1);
});
