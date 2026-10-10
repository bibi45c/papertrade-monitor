import test from 'node:test';
import assert from 'node:assert/strict';
import { emissionRate, paperPnl, makePlan, vwap, roundSize } from '../src/model.mjs';
const instrument = { id: 0, symbol: 'BTC', rateMultiplier: 15000, positionMultiplier: 814.598, referenceNotional: 100000, baseRate: .1, bustBuffer: .0005, openable: true, maxLeverage: 1000, maxPositionNotional: 1e7, longOi: 100, shortOi: 100, longCap: 1e6, shortCap: 1e6 };
function sample() { const now = Date.now(); return { paper: { rate: 100, trackedLp: 1e6, cliff: 2e6, decay: 120e6, tailProgress: 0 }, sources: Object.fromEntries(['summary', 'queue', 'trading', 'context'].map(k => [k, { ok: true, at: now }])),
  trading: { block: 100, paused: false, blockedActions: [], instruments: [instrument], minimumMargin: 10, minimumOpenNotional: 1000, minimumPaperStake: 1000, maximumNetOpenInterest: 25e6 }, queue: { count: 0, total: 0 },
  markets: [{ coin: 'BTC', paperMid: 100000, paperAt: now, paperBlock: '0x64', bookAt: now, szDecimals: 5, maxLeverage: 40, mark: 100000, funding: .0000125, bids: [{ px: '99999', sz: '10' }], asks: [{ px: '100001', sz: '10' }] }] }; }

test('mint curve depends on high-water tail progress and does not reset at LP cap', () => {
  assert.equal(emissionRate({ rate: 100, trackedLp: 1e6, cliff: 2e6, decay: 120e6, tailProgress: 0 }), 100);
  assert.equal(emissionRate({ rate: 100, trackedLp: 5e6, cliff: 2e6, decay: 120e6, tailProgress: 120e6 }), 25);
  assert.equal(emissionRate(null), null);
});
test('loss mint basis differs from liquidation and queued debt', () => {
  assert.equal(paperPnl({ notional: 10000, priceMove: -.05, instrument, mintRate: 100, queueEmpty: true }).mintedPaper, 49000);
  assert.equal(paperPnl({ notional: 10000, priceMove: -.05, instrument, mintRate: 100, queueEmpty: false }).mintedPaper, 50000);
  assert.equal(paperPnl({ notional: 10000, priceMove: -.001, instrument, liquidation: true, margin: 1000, mintRate: 100 }).payout, -1000);
});
test('profitable Paper close applies deadband, nonlinear haircut and win fee', () => {
  const p = paperPnl({ notional: 10000, priceMove: .05, instrument, mintRate: 100 });
  assert.ok(Math.abs(p.payout - 439.159468659) < .001);
  assert.equal(p.mintedPaper, 0);
  assert.equal(paperPnl({ notional: 10000, priceMove: .00001, instrument }).payout, 0);
});
test('VWAP uses actual depth; shortage is unavailable rather than a zero quote', () => {
  assert.equal(vwap([{ px: '100', sz: '1' }, { px: '102', sz: '2' }], 2), 101);
  assert.equal(vwap([{ px: '100', sz: '1' }], 2), null);
  assert.equal(vwap([{ px: '100', sz: '-1' }], 2), null);
  assert.equal(roundSize(.123459, 5), .12345);
});
test('hedge has matched asset quantity and separately required HL collateral', () => {
  const p = makePlan(sample(), 'BTC', { exitSlippageBps: 0, holdingHours: 0, lossBudget: 500 });
  assert.equal(p.ready, true); assert.equal(p.quantity, .2); assert.equal(p.notional, 20000);
  assert.equal(p.marginMinimum, 2000); assert.ok(p.scenarios[0].pnl < 0); assert.ok(p.scenarios[1].pnl < p.scenarios[0].pnl);
  assert.equal(p.scenarios[0].mintedPaper, 49000);
});
test('positive funding benefits HL short and costs HL long', () => {
  const s = sample(), short = makePlan(s, 'BTC'), long = makePlan(s, 'BTC', { paperLong: false });
  assert.ok(short.scenarios[0].funding > 0); assert.ok(long.scenarios[0].funding < 0);
});
test('stale quotes, unknown queue, paused actions and unsupported HYPE block plans', () => {
  const s = sample(); s.markets[0].paperAt -= 31000; assert.equal(makePlan(s, 'BTC').ready, false);
  const q = sample(); q.queue = null; assert.equal(makePlan(q, 'BTC').ready, false);
  const t = sample(); t.trading.blockedActions = ['closePositions']; assert.equal(makePlan(t, 'BTC').ready, false);
  assert.equal(makePlan(sample(), 'HYPE').ready, false);
});
test('high leverage liquidation proximity blocks suggested execution', () => {
  const p = makePlan(sample(), 'BTC', { paperLeverage: 1000, lossBudget: 500 });
  assert.equal(p.ready, false); assert.ok(p.reasons.some(r => r.includes('清算')));
});
test('OI capacity uses base asset units for the side cap', () => {
  const s = sample(); s.trading.instruments = [{ ...instrument, longCap: 100.1 }];
  assert.equal(makePlan(s, 'BTC').ready, false);
  const pass = sample(); pass.trading.instruments = [{ ...instrument, longCap: 101 }];
  assert.equal(makePlan(pass, 'BTC').ready, true);
});
test('fractional leverage is rejected because both venues require integer leverage', () => {
  assert.equal(makePlan(sample(), 'BTC', { paperLeverage: 20.5 }).ready, false);
});
