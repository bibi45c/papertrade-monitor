import test from 'node:test';
import assert from 'node:assert/strict';
import { dividendWindow48 } from '../src/model.mjs';
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
