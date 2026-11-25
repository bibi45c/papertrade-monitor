import test from 'node:test';
import assert from 'node:assert/strict';
import { lpThresholds } from '../public/exposure.mjs';

test('LP thresholds prefer the chain read and fall back to the official API value', () => {
  const paper = { cliff: 1, cap: 2 }, tokenomics = { cliff: 3, cap: 4 };
  assert.deepEqual(lpThresholds({ sources: { tokenomics: { ok: true } }, tokenomics, paper }), { cliff: 3, cap: 4 });
  assert.deepEqual(lpThresholds({ sources: { tokenomics: { ok: false } }, tokenomics, paper }), { cliff: 1, cap: 2 });
  assert.deepEqual(lpThresholds({ sources: { tokenomics: { ok: true } }, tokenomics: { cliff: 3, cap: null }, paper }), { cliff: 3, cap: 2 });
  assert.deepEqual(lpThresholds({ sources: {}, tokenomics: null, paper: null }), { cliff: null, cap: null });
  assert.deepEqual(lpThresholds(null), { cliff: null, cap: null });
});
