import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAlerts } from '../public/alerts-view.mjs';
import { operationOutcome, renderGovernanceTable } from '../public/governance-view.mjs';
import { decodeLog, GOVERNANCE, KNOWN_OPERATIONS, relabelCall } from '../src/watch.mjs';

const { multisigSubmittedBatch: [submitted], timelockExecuted: [executed], timelockCancelled: [cancelled] } = JSON.parse(readFileSync(new URL('./fixtures/governance-logs.json', import.meta.url), 'utf8'));
const { call, ...event } = decodeLog(submitted);

test('operation outcome prefers the explicit result and recognizes legacy topics', () => {
  assert.equal(operationOutcome({ outcome: 'cancelled', resolvedTopic: executed.topics[0] }), 'cancelled');
  assert.equal(operationOutcome({ resolvedTopic: executed.topics[0] }), 'executed');
  assert.equal(operationOutcome({ resolvedTopic: cancelled.topics[0] }), 'cancelled');
  assert.equal(operationOutcome({ resolvedBlock: 10, resolvedTopic: '0xunknown' }), 'unknown');
  assert.equal(operationOutcome({ resolvedBlock: 10 }), 'unknown');
  assert.equal(operationOutcome({}), null);
});

function createElement() {
  return { children: [], append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; } };
}

test('the governance table shows result badges alongside the original cancellation description', t => {
  const table = createElement();
  const doc = { createElement, createTextNode: value => value, getElementById: () => table };
  globalThis.document = doc;
  t.after(() => { delete globalThis.document; });
  const op = KNOWN_OPERATIONS[0], ops = [
    { ...op, resolvedBlock: 10, resolvedTopic: cancelled.topics[0] },
    { ...op, resolvedBlock: 11, outcome: 'executed' },
    { ...op, resolvedBlock: 12, resolvedTopic: '0xunknown' },
    { ...op, applied: true },
  ];
  const render = lang => {
    renderGovernanceTable({ ops, lang, now: op.readyAt, time: String, number: String, applied: o => o.applied, available: true });
    return table.children.map(row => row.children[3].children[0].textContent);
  };
  assert.deepEqual(render('zh'), ['已取消', '已执行', '已执行或取消', '已生效']);
  assert.equal(table.children[0].children[0].children[1].children[0], op.description);
  assert.deepEqual(render('en'), ['Cancelled', 'Executed', 'Executed or cancelled', 'In effect']);
});

function alerts(t) {
  globalThis.document = { createElement };
  t.after(() => { delete globalThis.document; });
  return (events, lang) => buildAlerts({ events, lang });
}

test('multisig batch alerts group builder approvals and link the builders and transaction', t => {
  const build = alerts(t);
  const [zh] = build([{ ...event, call }], 'zh');
  assert.equal(zh.title, '多签提交：批量排程 6 项');
  assert.equal(zh.parts[0], '批准 Hyperliquid builder approveBuilder(地址) ×6');
  assert.ok(zh.parts.includes(' · 扫描到的日志中未见执行记录'));
  const [en] = build([{ ...event, call }], 'en');
  assert.equal(en.title, 'Multisig submitted: batch schedule of 6 operations');
  assert.equal(en.parts[0], 'Approve Hyperliquid builder approveBuilder(address) ×6');
  const links = en.parts.filter(part => part.href);
  assert.deepEqual(links.slice(0, 6).map(a => a.href), relabelCall(call).batch.map(item => 'https://hyperevmscan.io/address/' + item.display[0]));
  assert.equal(links[3].textContent, '0xfeef…8fee');
  assert.equal(links.at(-1).href, 'https://hyperevmscan.io/tx/' + event.tx);
  assert.equal(links.at(-1).textContent, `block ${event.block}`);
});

test('batch alerts separate targets, limit builder links and prefer the multisig execution', t => {
  const build = alerts(t);
  const second = { ...call.batch[0], target: GOVERNANCE.timelock, where: 'Timelock（最短延迟 1 天）' };
  const details = { ...call, batch: [...call.batch, second, second] };
  const [alert] = build([{ ...event, call }, { ...event, kind: 'multisigExecuted', call: details }], 'en');
  assert.equal(alert.title, 'Multisig executed: batch schedule of 8 operations');
  assert.ok(alert.parts.includes('Approve Hyperliquid builder approveBuilder(address) ×6'));
  assert.ok(alert.parts.includes('Approve Hyperliquid builder approveBuilder(address) ×2'));
  assert.ok(alert.parts.includes(' (addresses in the transaction)'));
  assert.ok(!alert.parts.some(p => / more$/.test(p)));
  assert.ok(!alert.parts.includes(' · no execution seen in scanned logs'));
  assert.equal(alert.parts.filter(p => p.href?.includes('/address/')).length, 8);
  assert.ok(alert.parts.some(p => p.textContent === 'Timelock (1-day minimum delay)'));
});

test('builder links beyond the first six are counted', t => {
  const build = alerts(t);
  const [alert] = build([{ ...event, call: { ...call, batch: [...call.batch, ...call.batch.slice(0, 2)] } }], 'en');
  assert.ok(alert.parts.includes(' and 2 more'));
});

test('older batch alerts show the inferred count or omit it and keep the transaction link', t => {
  const build = alerts(t);
  const [zh] = build([{ ...event, call: relabelCall({ selector: call.selector, args: call.args }) }], 'zh');
  assert.equal(zh.title, '多签提交：批量排程 6 项');
  assert.equal(zh.parts[0], '共 6 项，明细未存或未能解出，见交易');
  const [en] = build([{ ...event, call: relabelCall({ selector: call.selector, args: call.args }) }], 'en');
  assert.equal(en.parts[0], '6 operations; details not stored or not decoded, see the transaction');
  const [unknown] = build([{ ...event, call: { selector: '8f2a0bb0' } }], 'en');
  assert.equal(unknown.title, 'Multisig submitted: batch schedule');
  assert.equal(unknown.parts.at(-1).href, 'https://hyperevmscan.io/tx/' + event.tx);
});
