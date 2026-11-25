import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BATCH_BACKFILL_RANGES, GAP_RPC, GOVERNANCE, KNOWN_OPERATIONS, decodeLog, scanGovernance } from '../src/watch.mjs';
import { isPending } from '../public/governance-view.mjs';

const history = JSON.parse(readFileSync(new URL('./fixtures/governance-history.json', import.meta.url), 'utf8'));
const START = 48000000, HEAD = 52170222;
const BATCH_SCHEDULED = '0x0b9c64b5b18792c995334aa1e837673c5a9cdb8f004ab10fb652f4eecb8d551f';
const BATCH_EXECUTED = '0xaa1510acf32db51981a900a90589bafbf6f442c657a0b916fd3afe22c1474bcd';
const CANCELLED = '0xcf0f63b97f3387253cbc0bde884f975df77e39184dc3280c2c81be495f58eef4';
const DELAY = '0x25cd0ae91e995bc58ea33869249d0bcf40f2b2c8331ec976c96096bf7d27f464';
const hex = n => '0x' + n.toString(16);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const hash = n => '0x' + word(n);
const words = (...values) => values.map(word).join('');
const bytes = data => word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, '0');

function fixtureFetcher(logs, { head = HEAD, fail = () => false, reads = [] } = {}) {
  return async (url, options) => {
    const { method, params } = JSON.parse(options.body);
    if (method === 'eth_blockNumber') return Response.json({ result: hex(head) });
    assert.equal(method, 'eth_getLogs');
    const [from, through] = [Number(params[0].fromBlock), Number(params[0].toBlock)];
    reads.push({ url, from, through });
    if (fail(from, through)) return Response.json({ error: { code: -32602, message: 'Unavailable range' } });
    return Response.json({ result: logs.filter(log => Number(log.blockNumber) >= from && Number(log.blockNumber) <= through) });
  };
}

const initial = { lastScannedBlock: START - 1, operations: KNOWN_OPERATIONS };
const fullHistory = () => scanGovernance({ previous: initial, gapChunkBlocks: HEAD - START, fetcher: fixtureFetcher(history) });
const batches = state => state.operations.filter(op => op.kind === 'batchScheduled');
const singles = state => state.operations.filter(op => op.kind === 'scheduled');
const results = ({ operations, recentEvents, gaps, orphanEndings, batchBackfill, coverageComplete }) =>
  ({ operations, recentEvents, gaps, orphanEndings, batchBackfill, coverageComplete });

test('full on-chain replay finds the two pending batches and preserves all single-operation results', async () => {
  const state = await fullHistory();
  assert.equal(history.length, 185);
  assert.equal(state.coverageComplete, true);
  assert.equal(batches(state).length, 12);
  assert.equal(batches(state).filter(o => o.outcome === 'executed').length, 10);
  assert.ok(batches(state).every(o => o.batch?.length === o.batchSize));
  const [builders, upgrades] = batches(state).filter(o => isPending(o));
  assert.deepEqual(batches(state).filter(o => isPending(o)).map(o => o.id), [
    '0x8303461a8bc3a40fe78d576c73a28fa7cb21a92a0b7417517987a4eda59ba0c8',
    '0x60a9027caf4e559ed7ef9eef62c8402b7ddbb2efa0867a3ae5402926a63b6df8',
  ]);
  const builderLog = history.find(log => log.topics[0] === BATCH_SCHEDULED && log.topics[1] === builders.id);
  assert.equal(builders.readyAt, Number(BigInt('0x' + builderLog.data.slice(130))) * 1000);
  assert.equal(builders.scheduledBlock, 52134998);
  assert.deepEqual(builders.batch.map(c => c.selector), Array(6).fill('54dc2a02'));
  assert.equal(upgrades.scheduledBlock, 52146150);
  assert.deepEqual(upgrades.batch.map(c => [c.selector, c.target]), [
    ...Array(3).fill(['99a88ec4', GOVERNANCE.proxyAdmin]), ['7759e487', GOVERNANCE.exchange],
  ]);
  assert.deepEqual(upgrades.batch.at(-1).args, ['47500', '1000']);
  assert.equal(singles(state).length, 7);
  assert.equal(singles(state).filter(o => o.outcome === 'executed').length, 6);
  assert.equal(singles(state).filter(o => o.outcome === 'cancelled').length, 1);
  assert.equal(state.recentEvents.some(e => e.kind === 'batchScheduled' || e.topic0 === BATCH_SCHEDULED), false);
});

test('forward, reverse and repeated range replays converge on the full-history state', async () => {
  const expected = results(await fullHistory());
  const ranges = [];
  for (let from = START; from <= HEAD; from += 400000) ranges.push([from, Math.min(from + 399999, HEAD)]);
  for (const order of [ranges, [...ranges].reverse(), ranges.flatMap(range => [range, range])]) {
    const outstanding = [HEAD + 1, HEAD + 1];
    const fetcher = fixtureFetcher([...history].reverse());
    let state = { ...initial, lastScannedBlock: HEAD, batchBackfill: 1 };
    for (const range of order) {
      // Select the next range while leaving coverage open until all ranges have been tested.
      state = await scanGovernance({ previous: { ...state, gaps: [range, outstanding] }, fetcher, gapChunkBlocks: 400000, maxGapChunks: 1 });
    }
    state = await scanGovernance({ previous: state, fetcher: fixtureFetcher(history, { head: HEAD + 1 }) });
    assert.deepEqual(results(state), expected);
  }
});

test('one-time gap backfill recovers batches from the pre-deployment state without changing the seven singles', async () => {
  const priorLogs = history.filter(e => ![BATCH_SCHEDULED, BATCH_EXECUTED].includes(e.topics[0]));
  const legacy = await scanGovernance({ previous: initial, fetcher: fixtureFetcher(priorLogs), gapChunkBlocks: HEAD - START });
  const oldUnknowns = history.filter(e => [BATCH_SCHEDULED, BATCH_EXECUTED].includes(e.topics[0])).slice(-4).map(e => ({
    kind: 'unknown', address: e.address, tx: e.transactionHash, block: Number(e.blockNumber),
    logIndex: Number(e.logIndex), topic0: e.topics[0], topic1: e.topics[1],
  }));
  let state = { lastScannedBlock: HEAD, gaps: [], operations: singles(legacy), recentEvents: oldUnknowns };
  const reads = [], fetcher = fixtureFetcher(history, { reads });
  assert.equal(state.operations.length, 7);
  for (let run = 0; run < 4; run++) {
    const firstRead = reads.length;
    state = await scanGovernance({ previous: state, fetcher });
    assert.equal(state.batchBackfill, 1);
    assert.ok(reads.length - firstRead <= 8);
    if (!state.gaps.length) break;
  }
  assert.equal(state.coverageComplete, true);
  const expected = await fullHistory();
  assert.deepEqual(batches(state), batches(expected));
  assert.deepEqual(singles(state), singles(legacy));
  assert.equal(state.recentEvents.some(e => e.topic0 === BATCH_SCHEDULED || (e.topic0 === BATCH_EXECUTED && e.kind === 'unknown')), false);
  assert.ok(reads.every(r => r.url === GAP_RPC));
  assert.deepEqual(reads.slice(0, 13).map(r => [r.from, r.through]), BATCH_BACKFILL_RANGES.slice(0, 13));
  assert.equal(reads[13].from, 52099293);
  assert.equal(reads.at(-1).through, HEAD);
  const count = reads.length;
  await scanGovernance({ previous: state, fetcher });
  assert.equal(reads.length, count);
});

test('backfill is clipped to the old cursor and committed with its failed ranges', async () => {
  const head = 49407798;
  const old = { lastScannedBlock: head, gaps: [[100, 101]], operations: [] };
  const failed = await scanGovernance({ previous: old, fetcher: fixtureFetcher([], { head, fail: () => true }) });
  assert.equal(failed.batchBackfill, 1);
  assert.deepEqual(failed.gaps, [[100, 101], [49080037, 49080037], [49169385, 49169385], [49407792, head]]);
  assert.equal(failed.readErrors.length, 1);
  assert.equal(Object.hasOwn(old, 'batchBackfill'), false);
  const fresh = await scanGovernance({ fetcher: fixtureFetcher([], { head }) });
  assert.equal(fresh.batchBackfill, 1);
  assert.deepEqual(fresh.gaps, []);
});

function schedule({ id = 1, block = 11, index = 1, tx = 1, size = 1, salt = 7, seconds = 1795623741 } = {}) {
  return { address: GOVERNANCE.timelock, blockNumber: hex(block), ...(index == null ? {} : { logIndex: hex(index) }),
    transactionHash: hash(tx), topics: [BATCH_SCHEDULED, hash(id)], data: '0x' + words(size, salt, seconds) };
}

function ending({ id = 1, block = 11, index = 2, tx = 2, topic = BATCH_EXECUTED } = {}) {
  return { ...schedule({ block, index, tx }), topics: [topic, hash(id)], data: topic === CANCELLED ? '0x' : hash(1) };
}

function batchCall({ salt = 7, count = 1, payload = '54dc2a02' + word(15) } = {}) {
  const stride = (count + 1) * 32;
  const encoded = bytes(payload);
  return '8b07f62b' + words(128, 128 + stride, 128 + 2 * stride, salt)
    + word(count) + word(GOVERNANCE.tokenomics).repeat(count) + word(count) + word(0).repeat(count)
    + word(count) + Array.from({ length: count }, (_, i) => word(count * 32 + i * encoded.length / 2)).join('') + encoded.repeat(count);
}

function companion({ block = 11, index = 2, tx = 1, msId = 1, target = GOVERNANCE.timelock, calldata = batchCall() } = {}) {
  const e = schedule({ block, index, tx });
  return { ...e, address: GOVERNANCE.multisig, data: '0x' + words(0, 64) + bytes(calldata),
    topics: ['0xd3fb8b9f824d81f0fe695808b7b28faf553f5e7d8ff92fb5f25e210eb9134aec', hash(msId), hash(0), hash(target)] };
}

const empty = { lastScannedBlock: 10, operations: [], batchBackfill: 1 };
function scan(logs, { head = 11, previous = empty, ...options } = {}) {
  return scanGovernance({ fetcher: fixtureFetcher(logs, { head }), archiveUrl: null, maxChunks: 1, previous, ...options });
}

test('batch execution and shared cancellation obey schedule order within a block and across a reschedule', async () => {
  const order = [ending({ index: 0, topic: CANCELLED }), schedule(), ending({ index: 3 })];
  const state = await scan([...order].reverse());
  assert.equal(state.operations[0].outcome, 'executed');
  assert.equal(state.operations[0].resolvedLogIndex, 3);
  const cancelled = await scan([schedule(), ending({ index: 2, topic: CANCELLED })]);
  assert.equal(cancelled.operations[0].outcome, 'cancelled');
  const pending = await scan([ending({ index: 2, topic: CANCELLED }), schedule({ index: 3, tx: 3 })], {
    previous: { ...cancelled, gaps: [[11, 11]] },
  });
  assert.equal(pending.operations[0].scheduledLogIndex, 3);
  assert.equal(pending.operations[0].resolvedBlock, undefined);
  assert.equal(pending.operations[0].outcome, undefined);
  const minDelay = { ...ending({ index: 4, topic: DELAY }), topics: [DELAY] };
  const resumed = await scan([minDelay, schedule({ index: 5, tx: 4 })], { previous: { ...state, gaps: [[11, 11]] } });
  assert.equal(resumed.operations[0].scheduledLogIndex, 5);
  assert.equal(resumed.operations[0].resolvedBlock, undefined);
});

test('batch detail requires the closest matching execution, including order, target, salt and count', async () => {
  const mismatches = [
    [companion({ index: 0 })],
    [companion({ tx: 2 })],
    [companion({ target: GOVERNANCE.exchange }), companion({ index: 3, msId: 2 })],
    [companion({ calldata: batchCall({ salt: 8 }) })],
    [companion({ calldata: batchCall({ count: 2 }) })],
    [companion({ calldata: 'deadbeef' })],
    [companion({ calldata: batchCall().slice(0, -2) })],
  ];
  for (const logs of mismatches) {
    const state = await scan([schedule(), ...logs]);
    assert.equal(state.operations[0].batchSize, 1);
    assert.equal(state.operations[0].batch, undefined);
    assert.equal(state.coverageComplete, true);
  }
  const queued = await scan([schedule(), companion()]);
  assert.equal(queued.operations[0].batch[0].args[0], '15');
  const missing = await scan([schedule()], { previous: { ...queued, gaps: [[11, 11]] } });
  assert.deepEqual(missing.operations, queued.operations);
  const sizeOnly = await scan([schedule()]);
  const filled = await scan([schedule(), companion()], { previous: { ...sizeOnly, gaps: [[11, 11]] } });
  assert.deepEqual(filled.operations, queued.operations);
  const companionOnly = await scan([companion()], { previous: { ...sizeOnly, gaps: [[11, 11]] } });
  assert.deepEqual(companionOnly.operations, queued.operations);
});

test('two batches in one transaction match their own executions, and missing indices need a unique candidate', async () => {
  const second = schedule({ id: 2, index: 3, salt: 8 });
  const secondCall = companion({ index: 4, msId: 2, calldata: batchCall({ salt: 8, payload: 'deadbeef' }) });
  const state = await scan([secondCall, second, companion(), schedule()]);
  assert.deepEqual(state.operations.map(o => o.batch?.[0].selector), ['54dc2a02', 'deadbeef']);
  const shared = await scan([schedule(), schedule({ id: 2, index: 2 }), companion({ index: 3 })]);
  assert.deepEqual(shared.operations.map(o => o.batch?.[0].selector), [undefined, '54dc2a02']);
  for (const [scheduled, executed] of [[schedule({ index: null }), companion()], [schedule(), companion({ index: null })]]) {
    assert.equal((await scan([scheduled, executed])).operations[0].batch?.length, 1);
    assert.equal((await scan([scheduled, executed, secondCall])).operations[0].batch, undefined);
  }
  const ambiguous = await scan([schedule({ index: null }), schedule({ id: 2, index: null }), companion()]);
  assert.ok(ambiguous.operations.every(o => o.batch === undefined));
});

test('oversized batches keep their count while malformed timelock events leave a recoverable gap', async () => {
  const oversized = await scan([schedule({ size: 65 }), companion({ calldata: batchCall({ count: 65 }) })]);
  assert.equal(oversized.coverageComplete, true);
  assert.equal(oversized.operations[0].batchSize, 65);
  assert.equal(oversized.operations[0].batch, undefined);
  const broken = [
    { ...schedule(), data: '0x12' },
    { ...schedule(), data: hash(1) },
    { ...schedule(), data: schedule().data.replace(/.$/, 'z') },
    schedule({ size: 0 }), schedule({ size: 2n ** 53n }), schedule({ seconds: 2n ** 53n }),
    schedule({ seconds: Number.MAX_SAFE_INTEGER }),
    { ...ending(), data: '0x' }, { ...ending({ topic: CANCELLED }), data: hash(1) }, { ...schedule(), topics: [BATCH_SCHEDULED] },
  ];
  for (const log of broken) {
    assert.throws(() => decodeLog(log), /Malformed timelock event/);
    const failed = await scan([log]);
    assert.deepEqual(failed.gaps, [[11, 11]]);
    assert.equal(failed.operations.length, 0);
    const fixed = await scan([schedule(), ending()], { previous: failed });
    assert.equal(fixed.coverageComplete, true);
    assert.equal(fixed.operations[0].outcome, 'executed');
  }
});

test('missing schedules retain at most the newest 100 known endings until coverage catches up', async () => {
  const logs = Array.from({ length: 105 }, (_, i) => ending({
    id: i + 1, block: 14, tx: i + 1, index: i, topic: i === 103 ? CANCELLED : BATCH_EXECUTED,
  }));
  const unknown = ending({ id: 200, block: 14, index: 105, topic: hash(172) });
  const previous = { ...empty, lastScannedBlock: 13, gaps: [[11, 11], [13, 13]] };
  const state = await scan([unknown, ...logs], { previous, head: 14 });
  assert.equal(state.orphanEndings.length, 100);
  assert.deepEqual(state.orphanEndings[0], { id: hash(105), block: 14, logIndex: 104, topic0: BATCH_EXECUTED });
  assert.equal(state.orphanEndings.at(-1).id, hash(6));
  const repeated = await scan([...logs].reverse(), { previous: { ...state, lastScannedBlock: 13 }, head: 14 });
  assert.deepEqual(repeated.orphanEndings, state.orphanEndings);
  const recovered = await scan([schedule({ id: 105 }), schedule({ id: 104, index: 2 })], { previous: repeated, head: 14 });
  assert.deepEqual(recovered.gaps, [[13, 13]]);
  assert.deepEqual(recovered.operations.map(o => o.outcome), ['executed', 'cancelled']);
  assert.equal(recovered.orphanEndings.length, 98);
  assert.equal(recovered.orphanEndings[0].id, hash(103));
  const covered = await scan([], { previous: recovered, head: 14 });
  assert.equal(covered.coverageComplete, true);
  assert.deepEqual(covered.orphanEndings, []);
});

test('maximal decoded batches share a 300 KB budget and only the newest 200 ended operations remain', async () => {
  const calldata = batchCall({ count: 64, payload: 'deadbeef' + word(2n ** 256n - 1n).repeat(6) });
  const logs = [];
  for (let id = 1; id <= 235; id++) {
    const block = id + 10;
    logs.push(schedule({ id, block, tx: id, size: 64 }), companion({ block, tx: id, msId: id, calldata }));
    if (id > 30) logs.push(ending({ id, block, tx: id + 1000, index: 3 }));
  }
  const seeded = { ...empty, operations: [{ ...KNOWN_OPERATIONS[0], resolvedBlock: 10, outcome: 'executed' }] };
  const state = await scan(logs, { head: 245, previous: seeded });
  const pending = state.operations.filter(o => o.resolvedBlock == null), ended = state.operations.filter(o => o.resolvedBlock != null);
  assert.deepEqual(pending.map(o => o.id), Array.from({ length: 30 }, (_, i) => hash(i + 1)));
  assert.deepEqual(ended.map(o => o.id), Array.from({ length: 200 }, (_, i) => hash(i + 36)));
  assert.ok(pending.at(-1).batch?.length === 64 && pending[0].batch === undefined);
  assert.ok(ended.every(o => o.batch === undefined && o.batchSize === 64));
  const alerts = state.recentEvents.filter(e => e.call).map(e => e.call);
  assert.ok(alerts.length > 0 && alerts.every(c => c.batchSize === 64 && c.batch === undefined));
  const bytes = [...state.operations, ...alerts].reduce((sum, o) => sum + (o.batch ? Buffer.byteLength(JSON.stringify(o.batch)) + ',"batch":'.length : 0), 0);
  assert.ok(bytes > 250000 && bytes <= 300000, String(bytes));
  const { gaps, ...row } = state;
  const rowBytes = Buffer.byteLength(JSON.stringify(row));
  assert.ok(rowBytes < 600000, String(rowBytes));
});
