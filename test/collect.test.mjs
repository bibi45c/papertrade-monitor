import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, parseSummary, parseTrading, parseQueue, parseBbo, parseProtocolHistory } from '../src/collect.mjs';
const units = n => String(BigInt(n) * 10n ** 18n);
function summary() { return { ok: true, source: { block: '123', at: Date.now(), genesis: 0 }, balances: Object.fromEntries(['tvl', 'margin', 'lp', 'reserve', 'queue'].map(k => [k, units(0)])), paper: Object.fromEntries(['supply', 'staked', 'trackedLp', 'accumulator', 'reserve', 'unallocated', 'pendingRewards', 'cliff', 'cap', 'rate', 'decay', 'tailProgress'].map(k => [k, units(100)])), fees: { pending: units(1), lifetime: units(2) }, activity: { volume: units(1), open: 2 } }; }
function trading(format, at = Date.now(), instruments = []) {
  return { schemaVersion: 1, tradingPaused: false, indexedThroughBlock: 123, minimumTradeSizeRaw: units(10), minimumOpenNotionalRaw: units(1000), instruments,
    ...(format === 'legacy' ? { intake: [at, units(1000), units(25000000), ['openPosition']] } : { intakeControls: [at, units(1000), ['openPosition']] }) };
}

test('both trading formats preserve controls and raw values without inventing a missing limit', () => {
  for (const format of ['legacy', 'current']) {
    const source = trading(format), parsed = parseTrading(source);
    assert.equal(parsed.minimumPaperStake, 1000);
    assert.equal(parsed.maximumNetOpenInterest, format === 'legacy' ? 25000000 : null);
    assert.deepEqual(parsed.blockedActions, ['openPosition']); assert.equal(parsed.raw, source);
  }
});

test('ambiguous, malformed and unknown trading formats fail closed', () => {
  const source = trading('current');
  for (const invalid of [
    { ...source, schemaVersion: 2 }, { ...source, intake: trading('legacy').intake },
    { ...source, intakeControls: null }, { ...source, intakeControls: [1, units(1000), units(25000000), []] },
    { ...source, intakeControls: [1, units(1000), null] }, { ...source, intakeControls: [1, units(1000), [null]] },
    { ...source, intakeControls: [1, null, []] }, { ...source, intakeControls: [1, [], units(1000)] },
    { ...trading('legacy'), intake: [1, units(1000), null, []] },
  ]) assert.throws(() => parseTrading(invalid));
  const missing = { ...source }; delete missing.intakeControls; assert.throws(() => parseTrading(missing));
});
test('raw 18-decimal values are normalized while original strings are retained', () => { const s = summary(), parsed = parseSummary(s); assert.equal(parsed.paper.supply, 100); assert.equal(parsed.raw.paper.supply, units(100)); });
test('unknown schema and missing amount cannot become successful zero values', () => {
  const s = summary(); delete s.paper.supply; assert.throws(() => parseSummary(s));
  assert.throws(() => parseTrading({ schemaVersion: 2 }));
  assert.throws(() => parseQueue({ ok: true, source: {}, total: '0' }));
});
test('BBO decoding reads two ABI words with the per-instrument scale', () => {
  const hex = '0x' + (800000n).toString(16).padStart(64, '0') + (800010n).toString(16).padStart(64, '0');
  assert.equal(parseBbo(hex, 10).paperMid, 80000.5); assert.throws(() => parseBbo('0x', 10));
});
test('network failures are recorded per source, with null protocol metrics', async () => {
  const s = await collect({ pressureReader: async () => { throw new Error('Disconnected'); }, fetcher: async () => { throw new Error('Disconnected'); } });
  assert.equal(s.paper, null); assert.equal(s.queue, null); assert.equal(s.sources.summary.ok, false);
  assert.equal(s.sources.paperBbo.ok, false); assert.equal(s.paperMarketPrice.value, null);
  assert.equal(s.executionQueue.available, false); assert.equal(s.sources.executionQueue.ok, false);
});
for (const format of ['legacy', 'current']) test(`complete ${format} collection pins BBO reads and retries one transient RPC error`, async () => {
  const at = Date.now(), seenBlocks = [], requests = []; let batches = 0;
  const tuple = [0, 'BTC', 0, '10', true, false, false, false, false, null, null, null, units(15000), units(814), 1000, units(10000000), '500000000000000', units(0), units(100000), units(0), units(0), units(1000000), units(1000000)];
  const s = await collect({ auxiliary: false, deriveRisk: false, pressureReader: async () => ({ available: true, sourceAt: at, block: '123', queuedIntents: 0 }), fetcher: async (url, request) => {
    requests.push([url, request.body]);
    const body = request.body ? JSON.parse(request.body) : null; let payload;
    if (url.endsWith('/query/protocol/summary')) payload = summary();
    else if (url.endsWith('/state/trading')) payload = trading(format, at, [tuple]);
    else if (url.endsWith('/queue-summary')) payload = { ok: true, source: { at, block: '123' }, total: '0', count: 0, largest: null, front: null };
    else if (url.endsWith('/paper/activity')) payload = { items: [], latestDistribution: null };
    else if (body?.type === 'metaAndAssetCtxs') payload = [{ universe: ['BTC', 'ETH', 'HYPE'].map(name => ({ name, szDecimals: 5, maxLeverage: 40 })), marginTables: [] }, [1, 2, 3].map(() => ({ midPx: '80000.5', markPx: '80000.5', oraclePx: '80000.5', funding: '.00001', openInterest: '10', dayNtlVlm: '1000' }))];
    else if (body?.type === 'l2Book') payload = { time: at, levels: [[{ px: '80000', sz: '10' }], [{ px: '80001', sz: '10' }]] };
    else if (body?.method === 'eth_getBlockByNumber') payload = { result: { number: '0x7b', timestamp: '0x' + Math.floor(at / 1000).toString(16) } };
    else if (Array.isArray(body)) { seenBlocks.push(body[0].params[1]); batches++; payload = batches === 1 ? [{ id: 1, error: { message: 'Block temporarily unavailable' } }] : [{ id: 1, result: '0x' + (800000n).toString(16).padStart(64, '0') + (800010n).toString(16).padStart(64, '0') }]; }
    else throw new Error('Unexpected API request');
    return new Response(JSON.stringify(payload));
  } });
  assert.equal(s.markets[0].paperMid, 80000.5); assert.equal(s.sources.paperBbo.ok, true);
  assert.equal(s.sources.trading.ok, true); assert.deepEqual(s.trading.blockedActions, ['openPosition']);
  assert.equal(s.trading.maximumNetOpenInterest, format === 'legacy' ? 25000000 : null);
  assert.equal(s.rewardAccumulatorRaw, units(100)); assert.deepEqual(seenBlocks, ['0x7b', '0x7b']);
  assert.equal(s.executionQueue.available, true); assert.equal(s.sources.executionQueue.at, at);
  assert.deepEqual(s.markets.map(m => m.coin), ['BTC', 'ETH']); assert.equal(s.lpRiskDeferred, true);
  assert.equal(s.sources.jumps.disabled, true);
  assert.ok(!requests.some(([url, body]) => /binance|protocol\/history/.test(url) || body?.includes('"coin":"HYPE"')));
});
test('protocol hourly history derives per-hour minted PAPER and flags the running hour', () => {
  const h = { startMs: 0, intervalMs: 3600000, source: { asOfMs: 3 * 3600000 + 1000, revision: '9' }, columns: {
    paperRevenue: [0, 0, 10, 20], traderPnl: [0, 0, -50, -80], liquidation: [0, 0, 100, 160], paperSupply: [0, 0, 1000, 5000], paperStaked: [0, 0, 800, 4800], trades: [0, 0, 5, 9] } };
  const p = parseProtocolHistory(h);
  assert.equal(p.hours.length, 2); assert.equal(p.hours[0].minted, 1000); assert.equal(p.hours[1].minted, 4000);
  assert.equal(p.hours[1].revenuePerNewPaper, 0.005); assert.equal(p.hours[1].traderPnl, -30); assert.equal(p.hours[1].partial, true); assert.equal(p.hours[0].partial, false);
  assert.throws(() => parseProtocolHistory({ ...h, intervalMs: 60000 }));
  assert.throws(() => parseProtocolHistory({ ...h, columns: { ...h.columns, trades: [0] } }));
});
