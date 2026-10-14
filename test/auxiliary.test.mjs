import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runScheduled } from '../src/worker.mjs';
import { loadAuxiliary, latestSnapshot } from '../src/storage.mjs';
import { attachAuxiliary, collectAuxiliary } from '../src/auxiliary.mjs';

function database() {
  const native = new DatabaseSync(':memory:');
  for (const file of ['0001_snapshots.sql', '0002_auxiliary.sql']) native.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  return { native, prepare(sql) { let args = []; return {
    bind(...values) { args = values; return this; },
    async run() { return native.prepare(sql).run(...args); },
    async first() { return native.prepare(sql).get(...args) ?? null; },
  }; } };
}
const logger = { log() {}, error() {} };

test('failed auxiliary invocation cannot remove a saved core minute or invoke heavyweight core work', async () => {
  const db = database(), now = Date.now();
  const snapshot = { collectedAt: now, markets: [{ coin: 'BTC', mid: 80000 }], sources: { summary: { ok: true, at: now } } };
  await runScheduled({ cron: '* * * * *', scheduledTime: now }, db, { logger, coreCollector: async options => {
    assert.equal(options.auxiliary, false); assert.equal(options.deriveRisk, false); return snapshot;
  }, auxiliaryCollector: () => { throw new Error('must not run'); } });
  await assert.rejects(runScheduled({ cron: '*/5 * * * *', scheduledTime: now }, db, { logger, auxiliaryCollector: () => { throw new Error('RPC unavailable'); } }), /RPC unavailable/);
  assert.deepEqual(await latestSnapshot(db), snapshot);
});

test('migration seeds known operations and inventories gaps omitted by the latest old snapshot', () => {
  const db = database();
  for (const [at, gaps] of [[60000, [[0, 100], [500, 600]]], [120000, [[500, 600]]]]) {
    db.native.prepare('INSERT INTO snapshots (collected_at, payload) VALUES (?, ?)').run(at, JSON.stringify({ collectedAt: at, completedAt: at + 1, governance: { lastScannedBlock: 1000, operations: [{ id: 'known' }], gaps }, sources: { governance: { ok: true, at } } }));
  }
  db.native.exec(readFileSync(new URL('../migrations/0002_auxiliary.sql', import.meta.url), 'utf8'));
  const seeded = JSON.parse(db.native.prepare('SELECT payload FROM auxiliary_state').get().payload);
  assert.deepEqual(seeded.governance.gaps, [[0, 100], [500, 600]]);
  assert.equal(seeded.governance.operations[0].id, 'known'); assert.equal(seeded.collectedAt, 120000);
});

test('auxiliary state updates independently and never rewrites archived snapshot payload', async () => {
  const db = database(), now = Date.now();
  const snapshot = { collectedAt: now, markets: [], sources: {} }, state = { collectedAt: now, completedAt: now + 1, governance: { at: now, gaps: [] }, protocolHours: [], web: null, sources: { governance: { ok: true, at: now } } };
  await runScheduled({ cron: '* * * * *', scheduledTime: now }, db, { logger, coreCollector: async () => snapshot });
  await runScheduled({ cron: '*/5 * * * *', scheduledTime: now }, db, { logger, auxiliaryCollector: async () => state });
  assert.deepEqual(await latestSnapshot(db), snapshot);
  assert.deepEqual(await loadAuxiliary(db), state);
  const view = attachAuxiliary(snapshot, state);
  assert.equal(view.auxiliaryAt, now + 1); assert.equal(view.sources.governance.retained, true);
  assert.equal(snapshot.governance, undefined);
});

test('auxiliary failure keeps governance gaps and source failure without zero-filling', async () => {
  const previous = { governance: { lastScannedBlock: 100, gaps: [[0, 50]], operations: [] }, web: { at: 10, docs: 'd', app: 'a' }, sources: { web: { ok: true, at: 10 } } };
  const s = await collectAuxiliary({ previous, checkWeb: false, fetcher: async () => Response.json({}, { status: 403 }) });
  assert.equal(s.protocolHours, null); assert.equal(s.governance.stale, true); assert.deepEqual(s.governance.gaps, [[0, 50]]);
  assert.equal(s.sources.governance.ok, false); assert.equal(s.sources.web.retained, true);
});
