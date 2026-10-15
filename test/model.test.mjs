import test from 'node:test';
import { breakEvenGrowthLabel } from '../src/model.mjs';
import assert from 'node:assert/strict';
import { emissionRate, paperPnl, makePlan, vwap, roundSize, stakerIncomeWindow, breakEvenGrowth, pairHedgeCost, burnEstimate } from '../src/model.mjs';
const instrument = { id: 0, symbol: 'BTC', rateMultiplier: 15000, positionMultiplier: 814.598, referenceNotional: 100000, baseRate: .1, bustBuffer: .0005, openable: true, maxLeverage: 1000, maxPositionNotional: 1e7, longOi: 100, shortOi: 100, longCap: 1e6, shortCap: 1e6 };
function sample() { const now = Date.now(); return { paper: { rate: 100, trackedLp: 1e6, cliff: 2e6, decay: 120e6, tailProgress: 0 }, sources: Object.fromEntries(['summary', 'queue', 'trading', 'context', 'executionQueue'].map(k => [k, { ok: true, at: now }])),
  trading: { block: 100, paused: false, blockedActions: [], instruments: [instrument], minimumMargin: 10, minimumOpenNotional: 1000, minimumPaperStake: 1000, maximumNetOpenInterest: 25e6 }, queue: { count: 0, total: 0 },
  executionQueue: { available: true, sourceAt: now, capacityBlocks: 0, saturationPct: 0, preview: [] },
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
test('missing global net OI limit blocks plans without reporting a false capacity breach', () => {
  const s = sample(); s.trading.maximumNetOpenInterest = null;
  const p = makePlan(s, 'BTC');
  assert.equal(p.ready, false); assert.equal(p.scenarios.length, 2);
  assert.ok(p.reasons.includes('Paper 全局净 OI 上限未提供，手动方案保持阻止'));
  assert.ok(!p.reasons.includes('当前 Paper 净 OI 容量不足'));
  s.trading.maximumNetOpenInterest = 100;
  assert.ok(makePlan(s, 'BTC').reasons.includes('当前 Paper 净 OI 容量不足'));
});
test('fractional leverage is rejected because both venues require integer leverage', () => {
  assert.equal(makePlan(sample(), 'BTC', { paperLeverage: 20.5 }).ready, false);
});
test('execution queue gates crowded or stale plans while retaining both financial branches', () => {
  const s = sample(); s.executionQueue.capacityBlocks = 4;
  const busy = makePlan(s, 'BTC'); assert.equal(busy.ready, false); assert.equal(busy.scenarios.length, 2); assert.equal(busy.latencyExposurePerBps, 2);
  const stale = sample(); stale.executionQueue.sourceAt -= 16000; assert.equal(makePlan(stale, 'BTC').ready, false);
  const unknown = sample(); unknown.executionQueue = { available: false }; assert.equal(makePlan(unknown, 'BTC').ready, false);
  const oldPreview = sample(); oldPreview.executionQueue.preview = [{ acceptedAt: Date.now() - 31000 }]; assert.equal(makePlan(oldPreview, 'BTC').ready, false);
});
const acc = x => String(BigInt(Math.round(x * 1e9)) * 10n ** 18n); // U/PAPER with 1e27 precision
const row = (min, index, supply, staked, pending) => ({ collected_at: min * 60000, paper_supply: supply, staked_supply: staked, pending_rewards: pending, reward_accumulator: acc(index) });
test('staker income per new PAPER combines distributions and pending changes, never zero-fills', () => {
  const rows = [row(0, 0, 1000, 1000, 0), row(30, 0.001, 1500, 1000, 0), row(60, 0.001, 2000, 1500, 0.5)];
  const w = stakerIncomeWindow(rows, 60);
  assert.ok(Math.abs(w.income - 1.5) < 1e-9); assert.equal(w.minted, 1000); assert.ok(Math.abs(w.incomePerNewPaper - 0.0015) < 1e-12);
  assert.ok(Math.abs(w.yieldPerPaperHour - 0.001) < 1e-12); assert.equal(w.supplyGrowth, 2);
  assert.equal(stakerIncomeWindow(rows.slice(0, 1), 60), null);
  assert.equal(stakerIncomeWindow([row(0, 0, 1, 1, 0), row(20, 0, 2, 1, 0)], 60), null, 'coverage below 80% is unavailable');
  assert.equal(stakerIncomeWindow([{ ...rows[0], reward_accumulator: null }, rows[1]], 60), null);
});
test('break-even supply growth is exp(cost / income per new PAPER)', () => {
  assert.ok(Math.abs(breakEvenGrowth(0.002, 0.002) - Math.E) < 1e-12);
  assert.equal(breakEvenGrowth(0.002, 0), null); assert.equal(breakEvenGrowth(NaN, 0.01), null);
});

test('excessive and overflowing growth is distinct from missing data', () => {
  assert.equal(breakEvenGrowthLabel(100), '×100.00');
  assert.equal(breakEvenGrowthLabel(100.01), '回本门槛过高（>100 倍）');
  assert.equal(breakEvenGrowthLabel(Infinity), '回本门槛过高（>100 倍）');
  assert.equal(breakEvenGrowthLabel(null), '样本不足 / 不可用');
});
test('Paper long+short hedge costs only the win haircut and mints on the losing leg', () => {
  const h = pairHedgeCost(instrument, 100, 0.01);
  const win = paperPnl({ notional: 10000, priceMove: 0.01, instrument, mintRate: 100 }).payout;
  assert.ok(Math.abs(h.cost - (100 - win)) < 1e-9); assert.equal(h.mintedPaper, 9800);
  assert.ok(h.keep > 0.85 && h.keep < 0.882);
});
test('50% win-rate burn estimate matches the hedge cost and penalises hard liquidation', () => {
  const b = burnEstimate({ instrument, mintRate: 100, notional: 10000, leverage: 50, move: 0.01 });
  assert.ok(Math.abs(b.costPerPaper - pairHedgeCost(instrument, 100, 0.01).costPerPaper) < 1e-12);
  assert.ok(Math.abs(b.expectedPaper - 1000 / b.costPerPaper) < 1e-6);
  const bust = burnEstimate({ instrument, mintRate: 100, notional: 10000, leverage: 1000, move: null });
  assert.equal(bust.lose, -10); assert.equal(bust.mintPerLoss, 1000); assert.ok(bust.costPerPaper > 3 * b.costPerPaper);
  assert.equal(burnEstimate({ instrument, mintRate: 100, notional: 10000, leverage: 100, move: 0.02 }), null, 'stop beyond bust is rejected');
});
