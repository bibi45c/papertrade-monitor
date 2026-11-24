import test from 'node:test';
import assert from 'node:assert/strict';
import { dividendWindow48, profitWindowSources, pickNewer, PROFIT_INDEX_MAX_AGE } from '../src/model.mjs';
const H = 3600000, now = 1000 * H + 30 * 60000, end = 1000 * H, start = end - 48 * H;
const hours = () => Array.from({length:48},(_,i)=>({startMs:start+i*H,partial:false,revenuePerPaperHour:.01,revenue:100,minted:1000,paperSupply:1e6+(i+1)*1000}));
const rows = () => Array.from({length:49},(_,i)=>({collected_at:start+i*H,reward_accumulator:String(BigInt(i)*10n**25n)}));
test('48h measured dividends prefer exact indices and preserve zero hours', () => {
  const w = dividendWindow48(rows(),hours(),now);
  assert.equal(w.measuredHours,48); assert.equal(w.estimatedHours,0); assert.equal(w.available,true);
  assert.ok(Math.abs(w.weightedPerPaperHour-.01)<1e-12);
  const zero = rows().map(r=>({...r,reward_accumulator:'0'}));
  assert.equal(dividendWindow48(zero,hours(),now).weightedPerPaperHour,0);
});
test('12h half-life gives the recent 12 completed hours 53.33% of weight', () => {
  const h = hours().map((h,i)=>({...h,revenuePerPaperHour:i>=36?1:0}));
  const w = dividendWindow48([],h,now);
  assert.equal(w.estimatedHours,48); assert.ok(Math.abs(w.weightedPerPaperHour-8/15)<1e-12);
  assert.equal(w.meanPerPaperHour,.25);
});
test('missing boundaries use estimates; partial and unknown hours are not zeros', () => {
  const h = hours(); h[47].partial=true;
  const w = dividendWindow48(rows().slice(0,48),h,now);
  assert.equal(w.validHours,47); assert.equal(w.bins[47].kind,'missing');
  assert.equal(dividendWindow48([],h.slice(0,36),now).available,false);
  assert.equal(dividendWindow48([],hours().slice(12),now).available,true);
});
test('negative or malformed index changes cannot create measured dividends', () => {
  const r = rows(); r[20].reward_accumulator='invalid'; r[21].reward_accumulator='0';
  const w = dividendWindow48(r,hours(),now);
  assert.ok(w.estimatedHours>=2); assert.ok(w.bins.every(b=>b.rate===null||b.rate>=0));
});
test('income ratio is weighted total income / weighted minted, not mean hourly ratios', () => {
  const h = hours(); h[47]={...h[47],revenue:100,minted:1};
  const w = dividendWindow48([],h,now);
  const weights=w.bins.map(b=>b.weight), expected=h.reduce((n,h,i)=>n+h.revenue*weights[i],0)/h.reduce((n,h,i)=>n+h.minted*weights[i],0);
  assert.ok(Math.abs(w.incomePerNewPaper-expected)<1e-12);
  assert.ok(w.incomePerNewPaper<1);
});
test('profitWindowSources accepts normal 5m edge cache plus 5m poll age as measured 48h', () => {
  const sampleNow = end + 30 * 60000;
  for (const ageMs of [360000, 660000, PROFIT_INDEX_MAX_AGE]) {
    const r = [...rows(), { collected_at: sampleNow - ageMs, reward_accumulator: String(48n * 10n ** 25n) }];
    const src = profitWindowSources({ dividendRows: r, profitHistoryState: 'ready', protocolHours: hours(), hourlySource: { ok: true, at: sampleNow - 60000 }, now: sampleNow });
    assert.equal(src.indexFresh, true);
    assert.equal(src.hourlyFresh, true);
    assert.equal(src.sampleAt, sampleNow - ageMs);
    assert.equal(src.staleAt, null);
    const w = dividendWindow48(src.rows, src.protocolHours, sampleNow);
    assert.equal(w.measuredHours, 48);
    assert.equal(w.estimatedHours, 0);
    assert.equal(w.available, true);
  }
});
test('right after the hour boundary, cached dividend history keeps 47 measured hours', () => {
  const afterHour = end + 8 * 60000;
  const cachedRows = [...rows().slice(0, 48), { collected_at: end - 4 * 60000, reward_accumulator: String(47n * 10n ** 25n) }];
  const partialHours = hours(); partialHours[47] = { ...partialHours[47], partial: true };
  const srcPartial = profitWindowSources({ dividendRows: cachedRows, profitHistoryState: 'ready', protocolHours: partialHours, hourlySource: { ok: true, at: end + 5 * 60000 }, now: afterHour });
  assert.equal(srcPartial.indexFresh, true);
  assert.equal(srcPartial.sampleAt, end - 4 * 60000);
  const wPartial = dividendWindow48(srcPartial.rows, srcPartial.protocolHours, afterHour);
  assert.equal(wPartial.measuredHours, 47);
  assert.equal(wPartial.estimatedHours, 0);
  assert.equal(wPartial.validHours, 47);
  assert.equal(wPartial.bins[47].kind, 'missing');
  assert.equal(wPartial.available, true);
  const srcFinalized = profitWindowSources({ dividendRows: cachedRows, profitHistoryState: 'ready', protocolHours: hours(), hourlySource: { ok: true, at: end + 5 * 60000 }, now: afterHour });
  const wFinalized = dividendWindow48(srcFinalized.rows, srcFinalized.protocolHours, afterHour);
  assert.equal(wFinalized.measuredHours, 47);
  assert.equal(wFinalized.estimatedHours, 1);
  assert.equal(wFinalized.validHours, 48);
  assert.equal(wFinalized.bins[47].kind, 'estimated');
  assert.equal(wFinalized.available, true);
});
test('stopped collection rejects stale dividend history and exposes honest staleAt', () => {
  const staleAt = now - 2 * H;
  const staleRows = [...rows().slice(0, 46), { collected_at: staleAt, reward_accumulator: String(45n * 10n ** 25n) }];
  const src = profitWindowSources({ dividendRows: staleRows, profitHistoryState: 'ready', protocolHours: hours(), hourlySource: { ok: true, at: staleAt }, now });
  assert.equal(src.indexFresh, false);
  assert.equal(src.hourlyFresh, false);
  assert.equal(src.sampleAt, null);
  assert.equal(src.staleAt, staleAt);
  assert.equal(src.rows.length, 0);
  assert.equal(src.protocolHours.length, 0);
  assert.equal(dividendWindow48(src.rows, src.protocolHours, now).available, false);
  const overLimit = profitWindowSources({ dividendRows: [{ collected_at: now - PROFIT_INDEX_MAX_AGE - 1, reward_accumulator: '0' }], profitHistoryState: 'ready', now });
  assert.equal(overLimit.indexFresh, false);
  const future = profitWindowSources({ dividendRows: [{ collected_at: now + 6000, reward_accumulator: '0' }], profitHistoryState: 'ready', now });
  assert.equal(future.indexFresh, false);
  const failed = profitWindowSources({ dividendRows: [{ collected_at: now - 60000, reward_accumulator: '0' }], profitHistoryState: 'failed', protocolHours: hours(), hourlySource: { ok: true, at: now - 60000 }, now });
  assert.equal(failed.indexFresh, false);
  assert.equal(failed.hourlyFresh, true);
  assert.equal(failed.sampleAt, now - 60000);
});
test('a snapshot without an index keeps the measured window but never refreshes the data time', () => {
  const sampleNow = end + 30 * 60000, failedAt = sampleNow - 6 * 60000;
  const src = profitWindowSources({ dividendRows: [...rows(), { collected_at: failedAt, reward_accumulator: null }], now: sampleNow });
  assert.equal(src.indexFresh, true);
  assert.equal(src.sampleAt, Math.max(...rows().map(r => r.collected_at)));
  assert.equal(dividendWindow48(src.rows, [], sampleNow).measuredHours, 48);
  const none = profitWindowSources({ dividendRows: [{ collected_at: failedAt, reward_accumulator: null }], now: sampleNow });
  assert.equal(none.indexFresh, false); assert.equal(none.sampleAt, null); assert.equal(none.staleAt, null);
});
test('pickNewer selects the record with the newer finite timestamp and handles nulls', () => {
  assert.equal(pickNewer(null, null), null);
  assert.equal(pickNewer(undefined, null), null);
  const older = { at: 1000, id: 'old' }, newer = { at: 2000, id: 'new' }, tie = { at: 2000, id: 'tie' }, noAt = { id: 'noAt' };
  assert.equal(pickNewer(older, null), older);
  assert.equal(pickNewer(null, older), older);
  assert.equal(pickNewer(older, newer), newer);
  assert.equal(pickNewer(newer, older), newer);
  assert.equal(pickNewer(newer, tie), newer);
  assert.equal(pickNewer(noAt, older), older);
  assert.equal(pickNewer(older, noAt), older);
  assert.equal(pickNewer(noAt, { at: NaN, id: 'nan' }), noAt);
});
