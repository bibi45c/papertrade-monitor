import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLog, describeCall, instrumentChanges, classifyMarket, jumpStats, upcomingEvents, KNOWN_OPERATIONS, GOVERNANCE } from '../src/watch.mjs';
import { lpDrainRisk } from '../src/model.mjs';
import { scanGovernance, mergeBlockRanges } from '../src/watch.mjs';

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
  const s = await scanGovernance({ previous: { lastScannedBlock: 30000, gaps }, maxChunks: 3, fetcher: async (_url, options) => {
    const q = JSON.parse(options.body);
    if (q.method === 'eth_blockNumber') return Response.json({ result: '0x' + (30300).toString(16) });
    calls.push(q.params[0]); return Response.json({ result: [] });
  } });
  assert.equal(calls.length, 3); assert.equal(Number(calls[0].fromBlock), 30001);
  assert.equal(Number(calls[1].fromBlock), 0); assert.equal(Number(calls[2].fromBlock), 1000);
  assert.equal(s.gaps.length, 11); assert.equal(s.gaps[0][0], 2000); assert.equal(s.coverageComplete, false);
  assert.deepEqual(mergeBlockRanges([[5, 10], [0, 4], [8, 15], [25, 30]]), [[0, 15], [25, 30]]);
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
