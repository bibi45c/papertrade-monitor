import test from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_KEY, FIELDS, TABLES, MAX_AGE, validProfitCache, readProfitCache, writeProfitCache } from '../public/profit-cache.mjs';
const now = 1791966000000;
const value = () => ({ version: 2, sampleAt: now - 60000, savedAt: now,
  fields: Object.fromEntries(FIELDS.map(id => [id, '有效值'])),
  tables: Object.fromEntries(Object.entries(TABLES).map(([id, count]) => [id, [{ className: id === 'pathTable' ? 'inactive-path' : '', cells: Array.from({length:count}, () => ({text:'测算值',title:'原始倍数'})) }]])) });
test('profit cache survives a reload with timestamps, values and HL strike-through', () => {
  const map = new Map(), storage = { getItem:k=>map.get(k), setItem:(k,v)=>map.set(k,v) };
  assert.equal(writeProfitCache(storage, value(), now), true);
  assert.deepEqual(readProfitCache(storage, now + 30000), value());
});
test('expired sample cannot become fresh through a new save timestamp', () => {
  const old = { ...value(), sampleAt: now - MAX_AGE - 1 };
  assert.equal(validProfitCache(old, now), false);
  assert.equal(validProfitCache({...value(), sampleAt:now+6000,savedAt:now+6000}, now), false);
});
test('an unavailable auxiliary table does not discard valid profit metrics', () => {
  const cache = value(); cache.tables.protocolHours = [{className:'',cells:[{text:'官方小时统计不可用',title:'',span:7}]}];
  assert.equal(validProfitCache(cache,now),true);
  cache.tables.protocolHours[0].cells[0].span=6;
  assert.equal(validProfitCache(cache,now),false);
});
test('malformed cache is discarded and storage denial never breaks the page', () => {
  assert.equal(readProfitCache({ getItem:()=>'{bad' }, now), null);
  const blocked = { getItem:()=>{throw new Error('blocked');}, setItem:()=>{throw new Error('full');} };
  assert.equal(readProfitCache(blocked, now), null);
  assert.equal(writeProfitCache(blocked, value(), now), false);
  const bad = value(); bad.tables.pathTable[0].className = 'unexpected';
  assert.equal(readProfitCache({getItem:k=>k===CACHE_KEY?JSON.stringify(bad):null},now), null);
});
