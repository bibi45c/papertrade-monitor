import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExecutionQueue, readExecutionQueue } from '../src/execution-queue.mjs';
function publication() {
  const now = Date.now();
  return { queueRevision: 'epoch:123', snapshot: { schemaVersion: 1, source: 'relayer-postgres', ok: true, stale: false, ts: now,
    blockGasLimit: '3000000', totalQueuedGas: '335000', totalSubmittedGas: '0', totalPendingGas: '335000', saturationPct: 0,
    pendingCount: 1, activeIntents: 1, queuedIntents: 1, submittedIntents: 0,
    queuePreview: [{ intentId: 'private-not-retained', action: 'openPosition', priorityClass: 0, estimatedGas: '335000', acceptedAtMs: now - 1000 }],
    chain: { source: 'state-postgres', ok: true, stale: false, latestBlockNumber: 123, latestBlockTimestampMs: now, blocks: [{ number: 123 }] } } };
}
test('public execution queue differs from payout debt and keeps gas strings without intent IDs', () => {
  const p = publication(), q = parseExecutionQueue(p);
  assert.equal(q.queuedIntents, 1); assert.equal(q.capacityBlocks, 1); assert.equal(q.saturationPct, 0);
  assert.equal(q.preview[0].estimatedGas, '335000'); assert.equal('intentId' in q.preview[0], false); assert.equal(q.personalRank, null);
});
test('stale, unknown or internally inconsistent publications are rejected rather than zeroed', () => {
  for (const mutate of [p => p.snapshot.ts -= 6000, p => p.snapshot.stale = true, p => p.snapshot.chain.latestBlockTimestampMs -= 16000, p => p.snapshot.totalPendingGas = '0', p => delete p.snapshot.queuedIntents, p => p.snapshot.queuePreview = null, p => p.snapshot.queuePreview[0].action = 'unknown', p => p.snapshot.blockGasLimit = '0']) {
    const p = publication(); mutate(p); assert.throws(() => parseExecutionQueue(p));
  }
});

test('current public schema without preview preserves aggregate counts but cannot imply zero waiting', () => {
  const p = publication(); delete p.snapshot.queuePreview;
  const q = parseExecutionQueue(p);
  assert.equal(q.available, true); assert.equal(q.queuedIntents, 1); assert.equal(q.previewAvailable, false); assert.deepEqual(q.preview, []);
  p.snapshot.queuePreview = []; assert.equal(parseExecutionQueue(p).previewAvailable, false);
  p.snapshot.queuedIntents = 0; p.snapshot.totalQueuedGas = '0'; p.snapshot.totalPendingGas = '0';
  assert.equal(parseExecutionQueue(p).previewAvailable, true);
  p.snapshot.chain.blocks = [{ number: 122 }]; assert.throws(() => parseExecutionQueue(p), /latest block/);
});
class Socket extends EventTarget {
  readyState = 1;
  closed = false;
  constructor(mode) { super(); this.mode = mode; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(data) {
    this.commands = data.split('\n').map(x => JSON.parse(x));
    if (this.mode === 'timeout') return;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(this.mode === 'error' ? { id: 2, error: { code: 103 } } : { push: { channel: 'pressure:current', pub: { data: publication() } } }) })));
  }
  close() { this.closed = true; }
}
test('one read-only subscription resolves and closes; rejection and timeout remain unavailable', async () => {
  let socket;
  const q = await readExecutionQueue({ socketFactory: () => socket = new Socket('ok') });
  assert.equal(q.available, true); assert.deepEqual(socket.commands[1], { id: 2, subscribe: { channel: 'pressure:current' } }); assert.equal(socket.closed, true);
  await assert.rejects(() => readExecutionQueue({ socketFactory: () => new Socket('error') }), /rejected/);
  await assert.rejects(() => readExecutionQueue({ socketFactory: () => new Socket('timeout'), timeoutMs: 10 }), /timed out/);
});
test('Workers fetch upgrade accepts its socket and stores the same public snapshot', async () => {
  globalThis.WebSocketPair = class {};
  const socket = new Socket('timeout');
  socket.accept = () => { socket.accepted = true; socket.mode = 'ok'; };
  try {
    const q = await readExecutionQueue({ fetcher: async (url, options) => {
      assert.equal(url, 'https://stream.papertrade.xyz/connection/websocket'); assert.equal(options.headers.Upgrade, 'websocket');
      return { status: 101, webSocket: socket };
    } });
    assert.equal(q.available, true); assert.equal(socket.accepted, true); assert.equal(socket.closed, true);
  } finally { delete globalThis.WebSocketPair; }
});
