import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { saveSnapshot, exportSnapshots } from '../src/storage.mjs';
import { api } from '../src/worker.mjs';
function database() {
  const native = new DatabaseSync(':memory:'); native.exec(readFileSync(new URL('../migrations/0001_snapshots.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { let args = []; return { bind(...values) { args = values; return this; }, async run() { return native.prepare(sql).run(...args); }, async first() { return native.prepare(sql).get(...args); }, async all() { return { results: native.prepare(sql).all(...args) }; } }; } };
}
test('archive pages preserve exact payloads and failures without holes or duplicates', async () => {
  const db = database(), start = Date.parse('2026-10-10T14:00:00Z'), original = [];
  for (let i = 0; i < 5; i++) {
    const s = { collectedAt: start + i * 60000 + 123, markets: [], rawSummary: { amount: '10000000000000000000000001' }, sources: { paperBbo: { ok: false, at: null, error: 'Missing EVM block' } } };
    original.push(s); await saveSnapshot(db, s);
  }
  const rows = []; let after = 0;
  for (;;) { const page = await exportSnapshots(db, { after, through: start + 4 * 60000, limit: 2 }); rows.push(...page.rows); after = page.nextAfter; assert.equal(page.available.count, 5); if (page.complete) break; }
  assert.equal(rows.length, 5); assert.equal(new Set(rows.map(r => r.collectedAt)).size, 5);
  assert.deepEqual(rows.map(r => r.snapshot), original);
  assert.equal((await exportSnapshots(db, { after, through: start + 4 * 60000 })).rows.length, 0);
});
test('archive rejects invalid pagination and remains GET-only', async () => {
  const db = database();
  for (const query of ['limit=121', 'limit=0', 'after=-1', 'after=1.5', 'after=9&through=8', 'through=oops', 'after=9007199254740992']) {
    assert.equal((await api(new Request('https://test/api/archive?' + query), db)).status, 400);
  }
  assert.equal((await api(new Request('https://test/api/archive', { method: 'POST' }), db)).status, 405);
  assert.equal((await api(new Request('https://test/api/archive'), null)).status, 503);
  const response = await api(new Request('https://test/api/archive?limit=1'), db);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
