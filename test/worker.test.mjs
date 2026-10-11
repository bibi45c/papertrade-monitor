import test from 'node:test';
import assert from 'node:assert/strict';
import { liveSnapshot } from '../src/worker.mjs';

test('a hung live collection times out and does not block the next request', async () => {
  const hung = liveSnapshot({ collector: () => new Promise(() => {}), deadlineMs: 50 });
  const fresh = await liveSnapshot({ collector: async () => ({ completedAt: Date.now(), marker: 'fresh' }), deadlineMs: 1000 });
  assert.equal(fresh.marker, 'fresh');
  await assert.rejects(hung, /实时采集超时/);
  const cached = await liveSnapshot({ collector: () => { throw new Error('should reuse the 8-second result'); } });
  assert.equal(cached.marker, 'fresh');
});
