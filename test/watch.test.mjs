import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeLog, describeCall, instrumentChanges, classifyMarket, jumpStats, upcomingEvents, KNOWN_OPERATIONS, GOVERNANCE } from '../src/watch.mjs';
import { lpDrainRisk } from '../src/model.mjs';
import { scanGovernance, mergeBlockRanges, relabelCall } from '../src/watch.mjs';

const { multisigSubmittedBatch: [submittedBatch], timelockCancelled: [cancelled], timelockExecuted: [operationExecuted] } = JSON.parse(readFileSync(new URL('./fixtures/governance-logs.json', import.meta.url), 'utf8'));
const readWord = (data, offset) => Number(BigInt('0x' + data.slice(offset, offset + 64)));
const batchLengthOffset = 2 + readWord(submittedBatch.data, 2 + 64) * 2;
const batchStart = batchLengthOffset + 64;
const batchData = submittedBatch.data.slice(batchStart, batchStart + readWord(submittedBatch.data, batchLengthOffset) * 2);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const dynamicBytes = data => word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, '0');
const replaceWord = (data, i, value) => data.slice(0, 8 + i * 64) + word(value) + data.slice(8 + (i + 1) * 64);
const scheduleCall = data => 'b0e58bc9' + word(GOVERNANCE.timelock) + word(0) + word(128) + word(0) + dynamicBytes(data);
const singleBatch = data => '8b07f62b' + [128, 192, 256, 0, 1, GOVERNANCE.timelock, 1, 0, 1, 32].map(word).join('') + dynamicBytes(data);

// 2026-10-11 区块 48191335 的真实日志：多签执行 timelock.schedule，timelock 发出排程事件。
const scheduled = { address: '0xb915fa41e824d6aa31bb833ee81220c0f2c8ea0f', blockNumber: '0x2df5767', transactionHash: '0xad38ffd14ec3032301199d3af3388599c483c963b1ce478e9e78d3bb36ac2f3d',
  topics: ['0x78f3bc93d9f0e2beb7fc8fe3192b142c5e70b8813403674aff3f81fc83af5b39', '0x51142366b8d5ae8d41322de14a7627f265e2ab54ee65828bbbaa14f6090cb578', '0x00000000000000000000000075174549dbbd44497d31a47e2e2d7406408d63d9'],
  data: '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080a03fa922a8a4d9781c3c74ece5e4b12827eecd4f12aa7f5b9981bc3657bb2332000000000000000000000000000000000000000000000000000000006ad3c282000000000000000000000000000000000000000000000000000000000000008412baae3b00000000000000000000000000000000000000000001a784379d99db42000000000000000000000000000000000000000000000000084595161401484a0000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000006342fd08f00f637800000000000000000000000000000000000000000000000000000000000000' };
const executed = { address: '0x696292762fd5ac3677a45edbe54eaece4194d1f6', blockNumber: '0x2df5767', transactionHash: scheduled.transactionHash,
  topics: ['0xd3fb8b9f824d81f0fe695808b7b28faf553f5e7d8ff92fb5f25e210eb9134aec', '0x0000000000000000000000000000000000000000000000000000000000000001', '0x0000000000000000000000009028f3b5b6b0d69e4e84ff555ade17114c3d1e72', '0x000000000000000000000000b915fa41e824d6aa31bb833ee81220c0f2c8ea0f'],
  data: '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000144b0e58bc900000000000000000000000075174549dbbd44497d31a47e2e2d7406408d63d900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080a03fa922a8a4d9781c3c74ece5e4b12827eecd4f12aa7f5b9981bc3657bb2332000000000000000000000000000000000000000000000000000000000000008412baae3b00000000000000000000000000000000000000000001a784379d99db42000000000000000000000000000000000000000000000000084595161401484a0000000000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000006342fd08f00f63780000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' };

test('timelock schedule log decodes target, 7-day ready time and curve arguments', () => {
  const e = decodeLog(scheduled);
  assert.equal(e.kind, 'scheduled'); assert.equal(e.id, KNOWN_OPERATIONS[0].id); assert.equal(e.target, GOVERNANCE.tokenomics);
  assert.equal(e.readyAt, KNOWN_OPERATIONS[0].readyAt); assert.deepEqual(e.args, ['2000000', '10000000', '100', '120000000']); assert.equal(e.selector, '12baae3b');
});
test('multisig execution reveals the nested schedule target before the timelock event is read', () => {
  const e = decodeLog(executed);
  assert.equal(e.kind, 'multisigExecuted'); assert.equal(e.call.selector, 'b0e58bc9');
  assert.equal(e.call.inner.target, GOVERNANCE.tokenomics); assert.deepEqual(e.call.inner.args, ['2000000', '10000000', '100', '120000000']);
  assert.match(describeCall(GOVERNANCE.exchange, 'deadbeef').label, /未知函数 0xdeadbeef/);
});

test('real multisig batch decodes all six builder approvals in order', () => {
  const event = decodeLog(submittedBatch);
  assert.equal(event.kind, 'multisigSubmitted');
  assert.equal(event.call.selector, '8b07f62b');
  assert.equal(event.call.label, 'timelock 批量排程 scheduleBatch');
  assert.equal(event.call.args.length, 6);
  assert.deepEqual(event.call.args.slice(0, 3), ['128', '352', '576']);
  assert.equal(event.call.args[4], '6');
  assert.ok(event.call.batch.every(c => c.target === '0xfdc6550436dd75ce8a0b145f935b7d3a64f53248' && c.selector === '54dc2a02'));
  const labeled = relabelCall(event.call);
  assert.equal(labeled.batchSize, 6);
  assert.deepEqual(labeled.batch.map(c => c.display[0]), [
    '0x22d91e1295e733a0723b1cc0e7e946020f5f2a8f', '0x38a013a8267ff13858e3da037a140d7313db829e',
    '0x71b09a08257078a4d642f7dd7315e656c837329a', '0xfeefee73ab3bee914108f61c647420372b488fee',
    '0xacad4f2a00a3c31ca33d08928c2b59f15d6c013e', '0x0ea2347089df73e234674d4031248d1d21f49d6e',
  ]);
  assert.equal(event.call.batchSize, undefined);
  assert.equal(event.call.batch[0].display, undefined);
  const reordered = replaceWord(replaceWord(batchData, 19, 288), 20, 192);
  const calls = describeCall(GOVERNANCE.timelock, reordered).batch;
  assert.deepEqual(calls.slice(0, 2).map(c => c.args), [event.call.batch[1].args, event.call.batch[0].args]);
});

test('malformed batch calldata falls back to bounded raw arguments', () => {
  const huge = 2n ** 256n - 1n;
  const cases = [
    ['truncated header', batchData.slice(0, 8 + 64)],
    ['truncated final payload', batchData.slice(0, -64)],
    ['truncated final padding', batchData.slice(0, -2)],
    ['unsafe array offset', replaceWord(batchData, 0, huge)],
    ['out-of-range array offset', replaceWord(batchData, 2, 65536)],
    ['empty array', replaceWord(batchData, 4, 0)],
    ['over-limit array', replaceWord(batchData, 4, 65)],
    ['unsafe array length', replaceWord(batchData, 4, huge)],
    ['mismatched lengths', replaceWord(batchData, 11, 5)],
    ['self-referencing bytes offset', replaceWord(batchData, 19, 0)],
    ['shared bytes offset', replaceWord(batchData, 20, 192)],
    ['unsafe bytes offset', replaceWord(batchData, 19, huge)],
    ['unsafe bytes length', replaceWord(batchData, 25, huge)],
    ['invalid hex', batchData.slice(0, 8) + 'zz' + batchData.slice(10)],
  ];
  for (const [name, data] of cases) {
    const call = describeCall(GOVERNANCE.timelock, data);
    assert.equal(call.selector, '8b07f62b', name);
    assert.equal(call.batch, undefined, name);
    assert.ok(call.args.length <= 6 && call.args.every(v => /^\d+$/.test(v)), name);
  }
});

test('nested scheduling stops at depth two and handles short or malformed calldata', () => {
  const describe = data => describeCall(GOVERNANCE.timelock, data);
  const empty = describe(singleBatch('abcd')).batch[0];
  assert.deepEqual(empty, { target: GOVERNANCE.timelock, selector: '', label: '空调用', where: empty.where, args: [] });
  const nested = describe(singleBatch(scheduleCall(singleBatch('deadbeef')))).batch[0].inner;
  assert.equal(nested.selector, '8b07f62b');
  assert.equal(nested.batch, undefined);
  const single = scheduleCall('deadbeef');
  for (const data of [single.slice(0, -64), replaceWord(single, 2, 0), replaceWord(single, 2, 2n ** 255n), replaceWord(single, 4, 2n ** 255n)]) {
    const call = describe(data);
    assert.equal(call.inner, undefined);
    assert.ok(Array.isArray(call.args));
  }
});

test('a batch inside a batch is not expanded, so one event cannot multiply the stored state', () => {
  const [inner] = describeCall(GOVERNANCE.timelock, singleBatch(singleBatch('deadbeef'))).batch;
  assert.equal(inner.selector, '8b07f62b');
  assert.equal(Object.hasOwn(inner, 'batch'), false);
});

test('legacy batch size is inferred only from a matching selector and plausible ABI arguments', () => {
  const args = ['128', '352', '576', '0', '6'];
  const old = { selector: '8b07f62b', label: '未知函数 0x8b07f62b', args };
  assert.equal(relabelCall(old).batchSize, 6);
  assert.equal(relabelCall(old).label, 'timelock 批量排程 scheduleBatch');
  assert.equal(old.batchSize, undefined);
  assert.equal(relabelCall({ ...old, selector: '8f2a0bb0' }).batchSize, undefined);
  assert.equal(relabelCall({ ...old, args: ['160', ...args.slice(1)] }).batchSize, undefined);
  for (const size of ['0', '1.5', '65', '9007199254740993']) {
    assert.equal(relabelCall({ ...old, args: [...args.slice(0, 4), size] }).batchSize, undefined);
  }
});

test('scheduled operations keep args without storing batch details or raw calldata', () => {
  const log = { ...scheduled, data: scheduled.data.slice(0, 2 + 4 * 64) + dynamicBytes(batchData) };
  const event = decodeLog(log);
  assert.equal(event.selector, '8b07f62b');
  assert.equal(event.args[4], '6');
  assert.equal(event.batch, undefined);
  assert.equal(event.data, undefined);
});
const inst = (symbol, id, assetIndex, extra = {}) => ({ symbol, id, assetIndex, baseRate: .1, rateMultiplier: 15000, positionMultiplier: symbol === 'ETH' ? 483.979 : 814.598, referenceNotional: 100000, maxLeverage: 1000, maxPositionNotional: 1e7, active: true, paused: false, terminal: false, longOi: 0, shortOi: 0, ...extra });
const trading = instruments => ({ instruments, minimumOpenNotional: 10000, minimumMargin: 10, paused: false });
test('baseline markets raise no alert; a HIP-3 listing is critical and parameter edits are flagged', () => {
  assert.deepEqual(instrumentChanges(trading([inst('BTC', 0, 0), inst('ETH', 1, 1)])).alerts, []);
  const hip3 = instrumentChanges(trading([inst('BTC', 0, 0), inst('ETH', 1, 1), inst('xyz:XYZ100', 2, 110000)]));
  assert.equal(hip3.alerts[0].level, 'critical'); assert.equal(hip3.alerts[0].kind, 'newMarket');
  assert.equal(classifyMarket(inst('HYPE', 3, 159)).level, 'high');
  const edited = instrumentChanges(trading([inst('BTC', 0, 0, { baseRate: .05 }), inst('ETH', 1, 1, { paused: true })]));
  assert.ok(edited.alerts.some(a => a.detail.includes('baseRate'))); assert.ok(edited.alerts.some(a => a.kind === 'status'));
  assert.equal(instrumentChanges(null), null);
});
test('jump stats measure 1-second and 10-second moves and refuse short samples', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 * (i >= 30 ? 1.002 : 1));
  const j = jumpStats(closes); assert.ok(Math.abs(j.max1s - .002) < 1e-12); assert.ok(Math.abs(j.max10s - .002) < 1e-12);
  assert.equal(jumpStats([100, 101]), null); assert.equal(jumpStats(Array(20).fill(0)), null);
});
test('event calendar flags the ±30 minute window and reports exhaustion', () => {
  const cpi = Date.parse('2026-10-14T12:30:00Z');
  assert.equal(upcomingEvents(cpi - 10 * 60000).events[0].inWindow, true);
  assert.equal(upcomingEvents(cpi - 2 * 3600000).events[0].inWindow, false);
  assert.equal(upcomingEvents(Date.parse('2027-06-01T00:00:00Z')).calendarExhausted, true);
});
test('LP drain risk solves the move that pushes tracked LP to the flat-rate threshold', () => {
  const s = { paper: { trackedLp: 5e6, cliff: 2e6 }, trading: trading([inst('BTC', 0, 0, { longOi: 10000, shortOi: 5000 })]), markets: [{ coin: 'BTC', paperMid: 80000 }] };
  const r = lpDrainRisk(s);
  assert.equal(r.netNotional, 4e8); assert.ok(r.up.toCliff > 0.008 && r.up.toCliff < 0.0095, String(r.up.toCliff)); assert.ok(r.up.toZero > r.up.toCliff);
  assert.equal(r.down.toCliff, null, 'net long traders lose when price falls');
  assert.equal(lpDrainRisk({ paper: { trackedLp: 1e6, cliff: 2e6 }, trading: trading([]), markets: [] }).flatRateActive, true);
  assert.equal(lpDrainRisk({ paper: null }), null);
});

test('governance coverage heals oldest gaps without forgetting more than ten ranges', async () => {
  const gaps = Array.from({ length: 12 }, (_, i) => [i * 2000, i * 2000 + 1500]);
  const calls = [];
  const s = await scanGovernance({ previous: { lastScannedBlock: 30000, gaps }, maxChunks: 3, archiveUrl: null, fetcher: async (_url, options) => {
    const q = JSON.parse(options.body);
    if (q.method === 'eth_blockNumber') return Response.json({ result: '0x' + (30300).toString(16) });
    calls.push(q.params[0]); return Response.json({ result: [] });
  } });
  assert.equal(calls.length, 3); assert.equal(Number(calls[0].fromBlock), 30001);
  assert.equal(Number(calls[1].fromBlock), 0); assert.equal(Number(calls[2].fromBlock), 1000);
  assert.equal(s.gaps.length, 11); assert.equal(s.gaps[0][0], 2000); assert.equal(s.coverageComplete, false);
  assert.deepEqual(mergeBlockRanges([[5, 10], [0, 4], [8, 15], [25, 30]]), [[0, 15], [25, 30]]);
});

test('archive RPC heals large gap ranges first; a failing archive falls back to official chunks', async () => {
  const gaps = [[0, 120000], [200000, 210000]];
  const seen = [];
  const s = await scanGovernance({ previous: { lastScannedBlock: 300000, gaps }, maxChunks: 2, archiveUrl: 'https://archive.test', fetcher: async (url, options) => {
    const q = JSON.parse(options.body);
    if (q.method === 'eth_blockNumber') return Response.json({ result: '0x' + (300100).toString(16) });
    seen.push([url.includes('archive') ? 'archive' : 'official', Number(q.params[0].fromBlock), Number(q.params[0].toBlock)]); return Response.json({ result: [] });
  } });
  assert.deepEqual(seen.filter(c => c[0] === 'archive').map(c => [c[1], c[2]]), [[0, 49999], [50000, 99999], [100000, 120000], [200000, 210000]]);
  assert.equal(s.gaps.length, 0); assert.equal(s.readErrors.length, 0);
  const fallback = await scanGovernance({ previous: { lastScannedBlock: 300000, gaps: [[0, 5000]] }, maxChunks: 2, archiveUrl: 'https://archive.test', fetcher: async (url, options) => {
    const q = JSON.parse(options.body);
    if (q.method === 'eth_blockNumber') return Response.json({ result: '0x' + (300100).toString(16) });
    if (url.includes('archive')) return Response.json({ error: { code: -32005, message: 'rate limited' } });
    return Response.json({ result: [] });
  } });
  assert.deepEqual(fallback.gaps, [[1000, 5000]]); assert.equal(fallback.readErrors.length, 0);
});

test('failed governance chunks remain pending while successful live coverage is retained', async () => {
  const s = await scanGovernance({ previous: { lastScannedBlock: 2000, gaps: [[0, 500]] }, fetcher: async (_url, options) => {
    const q = JSON.parse(options.body);
    if (q.method === 'eth_blockNumber') return Response.json({ result: '0x834' });
    return Number(q.params[0].fromBlock) === 0 ? Response.json({ error: { code: -32602, message: 'invalid params' } }) : Response.json({ result: [] });
  } });
  assert.equal(s.lastScannedBlock, 2100); assert.deepEqual(s.gaps, [[0, 500]]); assert.equal(s.readErrors.length, 1);
  assert.equal(s.coverageComplete, false);
});

const blockHex = n => '0x' + n.toString(16);
const atBlock = (log, block) => ({ ...log, blockNumber: blockHex(block) });
function scanLogs(logs, head, previous) {
  return scanGovernance({ previous, archiveUrl: null, fetcher: async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    if (method === 'eth_blockNumber') return Response.json({ result: blockHex(head) });
    const { fromBlock, toBlock } = params[0];
    return Response.json({ result: logs.filter(log => Number(log.blockNumber) >= Number(fromBlock) && Number(log.blockNumber) <= Number(toBlock)) });
  } });
}

test('timelock end events preserve their explicit kind and operation ID', () => {
  for (const [log, kind] of [[operationExecuted, 'operationExecuted'], [cancelled, 'operationCancelled']]) {
    assert.equal(decodeLog(log).kind, kind);
    assert.equal(decodeLog(log).topic1, log.topics[1]);
    assert.equal(decodeLog({ ...log, address: GOVERNANCE.multisig }).kind, 'unknown');
  }
});

test('scan records executed, cancelled and unknown endings and keeps the highest resolution block', async () => {
  const [executedId, cancelledId] = [operationExecuted.topics[1], cancelled.topics[1]];
  const unknownTopic = '0x' + 'aa'.repeat(32), unknownId = '0x' + 'bb'.repeat(32);
  const unknown = { ...cancelled, topics: [unknownTopic, unknownId] };
  const earlierCancellation = { ...cancelled, topics: [cancelled.topics[0], executedId] };
  const previous = { lastScannedBlock: 10, operations: [executedId, cancelledId, unknownId].map(id => ({ id, scheduledBlock: 10 })) };
  const logs = [atBlock(operationExecuted, 25), atBlock(earlierCancellation, 20), atBlock(cancelled, 23), atBlock(unknown, 26)];
  const state = await scanLogs(logs, 30, previous);
  const [done, stopped, unclassified] = state.operations;
  assert.deepEqual([done.resolvedBlock, done.resolvedTopic, done.outcome], [25, operationExecuted.topics[0], 'executed']);
  assert.deepEqual([stopped.resolvedBlock, stopped.resolvedTopic, stopped.outcome], [23, cancelled.topics[0], 'cancelled']);
  assert.deepEqual([unclassified.resolvedBlock, unclassified.resolvedTopic], [26, unknownTopic]);
  assert.equal(Object.hasOwn(unclassified, 'outcome'), false);

  const rescanned = await scanLogs([atBlock(earlierCancellation, 20)], 31, { ...state, gaps: [[20, 20]] });
  assert.deepEqual(rescanned.gaps, []);
  assert.deepEqual(rescanned.operations, state.operations);
  const laterUnknown = { ...unknown, topics: [unknownTopic, executedId] };
  const updated = await scanLogs([atBlock(laterUnknown, 31)], 31, state);
  assert.equal(updated.operations[0].resolvedBlock, 31);
  assert.equal(updated.operations[0].resolvedTopic, unknownTopic);
  assert.equal(Object.hasOwn(updated.operations[0], 'outcome'), false);
});

test('a new schedule after cancellation clears the ending and older rescans keep it pending', async () => {
  const initial = { lastScannedBlock: 10, operations: [{ ...KNOWN_OPERATIONS[0], scheduledBlock: 10 }] };
  const oldCancellation = atBlock(cancelled, 20);
  const stopped = await scanLogs([oldCancellation], 30, initial);
  assert.equal(stopped.operations[0].outcome, 'cancelled');

  const pending = await scanLogs([atBlock(scheduled, 31), oldCancellation], 31, { ...stopped, gaps: [[20, 20]] });
  const op = pending.operations[0];
  assert.equal(op.scheduledBlock, 31);
  assert.equal(op.description, KNOWN_OPERATIONS[0].description);
  for (const field of ['resolvedBlock', 'resolvedTopic', 'outcome']) assert.equal(Object.hasOwn(op, field), false);
  assert.deepEqual(pending.gaps, []);

  const rescanned = await scanLogs([atBlock(scheduled, 10), oldCancellation], 32, { ...pending, gaps: [[10, 20]] });
  assert.deepEqual(rescanned.operations, pending.operations);
});

test('events in one block follow their log order', async () => {
  const at = (log, block, logIndex) => ({ ...atBlock(log, block), logIndex: '0x' + logIndex.toString(16) });
  const initial = { lastScannedBlock: 10, operations: [{ ...KNOWN_OPERATIONS[0], scheduledBlock: 10 }] };
  const logs = [at(cancelled, 25, 0), at(scheduled, 25, 1)];
  const pending = await scanLogs(logs, 30, initial);
  assert.equal(pending.operations[0].scheduledBlock, 25);
  for (const field of ['resolvedBlock', 'resolvedTopic', 'resolvedLogIndex', 'outcome']) assert.equal(Object.hasOwn(pending.operations[0], field), false);
  // Rescanning the same block, or only the older cancellation, must not resolve it again.
  for (const again of [logs, [logs[0]], [...logs].reverse()]) {
    const state = await scanLogs(again, 31, { ...pending, gaps: [[25, 25]] });
    assert.deepEqual(state.operations, pending.operations);
  }
  const resolved = await scanLogs([at(scheduled, 25, 0), at(cancelled, 25, 1)], 30, initial);
  assert.equal(resolved.operations[0].outcome, 'cancelled');
  const unresolved = await scanLogs([at(scheduled, 25, 0)], 31, { ...resolved, gaps: [[25, 25]] });
  assert.deepEqual(unresolved.operations, resolved.operations);
});

test('an unrecognised event in the same block never downgrades a known outcome', async () => {
  const id = operationExecuted.topics[1], unknown = { ...cancelled, topics: ['0x' + 'aa'.repeat(32), id] };
  const previous = { lastScannedBlock: 10, operations: [{ id, scheduledBlock: 10 }] };
  for (const logs of [[operationExecuted, unknown], [unknown, operationExecuted]]) {
    const indexed = logs.map((l, i) => ({ ...atBlock(l, 25), logIndex: '0x' + i }));
    for (const order of [indexed, [...indexed].reverse()]) {
      const state = await scanLogs(order, 30, previous);
      assert.equal(state.operations[0].outcome, 'executed');
      assert.equal(state.operations[0].resolvedTopic, operationExecuted.topics[0]);
    }
  }
  const legacy = { lastScannedBlock: 30, operations: [{ id, scheduledBlock: 10, resolvedBlock: 25, resolvedTopic: operationExecuted.topics[0] }], gaps: [[25, 25]] };
  const kept = await scanLogs([atBlock(unknown, 25)], 31, legacy);
  assert.equal(kept.operations[0].resolvedTopic, operationExecuted.topics[0]);
});

test('rescanned events replace older stored ones', async () => {
  const id = operationExecuted.topics[1], log = atBlock(operationExecuted, 25);
  const state = await scanLogs([log], 31, { lastScannedBlock: 30, gaps: [[25, 25]], operations: [], recentEvents: [{ kind: 'unknown', tx: log.transactionHash, topic0: log.topics[0], topic1: id, block: 25 }] });
  assert.deepEqual(state.recentEvents.map(e => e.kind), ['operationExecuted']);
});

test('a malformed batch log still allows its block range to be marked covered', async () => {
  const data = replaceWord(batchData, 19, 2n ** 255n);
  const log = atBlock({ ...submittedBatch, data: '0x' + word(0) + word(64) + dynamicBytes(data) }, 11);
  const state = await scanLogs([log], 12, { lastScannedBlock: 12, gaps: [[11, 12]] });
  assert.equal(state.coverageComplete, true);
  assert.deepEqual(state.gaps, []);
  assert.deepEqual(state.readErrors, []);
  assert.equal(state.recentEvents[0].kind, 'multisigSubmitted');
  assert.equal(state.recentEvents[0].call.selector, '8b07f62b');
  assert.equal(state.recentEvents[0].call.batch, undefined);
});
