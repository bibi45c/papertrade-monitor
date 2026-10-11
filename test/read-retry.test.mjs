import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, ReadError, checkRpcError } from '../src/read-retry.mjs';
const fast = { wait: async () => {}, random: () => 0 };

test('network failure, HTTP 503 and then success recover within three requests', async () => {
  let calls = 0;
  const result = await readJson('https://example.test', undefined, async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return calls === 2 ? new Response('', { status: 503 }) : Response.json({ amount: '1000000000000000000000001' });
  }, fast);
  assert.equal(calls, 3); assert.equal(result.amount, '1000000000000000000000001');
});
test('permanent status and malformed JSON are not retried', async () => {
  for (const response of [new Response('', { status: 403 }), new Response('{')]) {
    let calls = 0;
    await assert.rejects(readJson('https://example.test', undefined, async () => { calls++; return response; }, fast));
    assert.equal(calls, 1);
  }
});
test('429 respects Retry-After and a delay longer than the budget stops retries', async () => {
  let calls = 0; const delays = [];
  await readJson('https://example.test', undefined, async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : Response.json({}), { ...fast, wait: async ms => delays.push(ms) });
  assert.deepEqual(delays, [1000]);
  calls = 0;
  await assert.rejects(readJson('https://example.test', undefined, async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '60' } }); }, fast), /HTTP 429/);
  assert.equal(calls, 1);
});
test('null latest EVM block is retried; exhaustion remains a failure', async () => {
  const validate = reply => { checkRpcError(reply); if (!reply.result) throw new ReadError('Missing EVM block', true); return reply; };
  let calls = 0;
  const result = await readJson('https://example.test', { method: 'eth_getBlockByNumber' }, async () => Response.json({ result: ++calls === 1 ? null : { number: '0x7b' } }), { ...fast, validate });
  assert.equal(calls, 2); assert.equal(result.result.number, '0x7b');
  calls = 0;
  await assert.rejects(readJson('https://example.test', {}, async () => { calls++; return Response.json({ result: null }); }, { ...fast, validate }), /Missing EVM block/);
  assert.equal(calls, 3);
});
test('RPC invalid params fail once while temporary block failures retry', async () => {
  for (const [error, expected] of [[{ code: -32602, message: 'Invalid params' }, 1], [{ code: -32000, message: 'Block temporarily unavailable' }, 3], [{ code: -32000, message: 'invalid block height: 48223822' }, 3]]) {
    let calls = 0;
    await assert.rejects(readJson('https://example.test', {}, async () => { calls++; return Response.json({ error }); }, { ...fast, validate: checkRpcError }));
    assert.equal(calls, expected);
  }
});
