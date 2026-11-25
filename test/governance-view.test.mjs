import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAlerts } from '../public/alerts-view.mjs';
import { isPending, operationOutcome, renderGovernanceTable } from '../public/governance-view.mjs';
import { decodeLog, describeCall, GOVERNANCE, KNOWN_OPERATIONS, relabelCall } from '../src/watch.mjs';

const { multisigSubmittedBatch: [submitted], timelockExecuted: [executed], timelockCancelled: [cancelled] } = JSON.parse(readFileSync(new URL('./fixtures/governance-logs.json', import.meta.url), 'utf8'));
const { call, ...event } = decodeLog(submitted);

test('operation outcome prefers the explicit result and recognizes legacy topics', () => {
  assert.equal(operationOutcome({ outcome: 'cancelled', resolvedTopic: executed.topics[0] }), 'cancelled');
  assert.equal(operationOutcome({ resolvedTopic: executed.topics[0] }), 'executed');
  assert.equal(operationOutcome({ resolvedTopic: cancelled.topics[0] }), 'cancelled');
  assert.equal(operationOutcome({ resolvedBlock: 10, resolvedTopic: '0xunknown' }), 'unknown');
  assert.equal(operationOutcome({ resolvedBlock: 10 }), 'unknown');
  assert.equal(operationOutcome({}), null);
  // Older records keep no log order: a schedule and an ending in one block cannot be told apart.
  assert.equal(operationOutcome({ scheduledBlock: 25, resolvedBlock: 25, resolvedTopic: cancelled.topics[0] }), 'unknown');
  assert.equal(operationOutcome({ scheduledBlock: 25, resolvedBlock: 25, resolvedLogIndex: 1, outcome: 'cancelled', resolvedTopic: cancelled.topics[0] }), 'cancelled');
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
    op,
  ];
  const render = lang => {
    renderGovernanceTable({ ops, lang, now: op.readyAt, time: String, number: String, cap: Number(op.args[1]), available: true });
    return table.children.map(row => row.children[3].children[0].textContent);
  };
  assert.deepEqual(render('zh'), ['已取消', '已执行', '已执行或取消', '已生效']);
  assert.equal(table.children[0].children[0].children[1].children[0], op.description);
  assert.deepEqual(render('en'), ['Cancelled', 'Executed', 'Executed or cancelled', 'In effect']);
});

function governanceTable(t) {
  const table = createElement();
  globalThis.document = { createElement, createTextNode: value => value, getElementById: () => table };
  t.after(() => { delete globalThis.document; });
  return (ops, lang, cap) => {
    renderGovernanceTable({ ops, lang, cap, now: 1000, time: String, number: String, available: true });
    return table.children;
  };
}

const batchOperation = batch => ({ kind: 'batchScheduled', batch, batchSize: batch.length, readyAt: 1000, scheduledTx: event.tx });
const content = node => typeof node === 'string' ? node : node.textContent ?? node.children.map(content).join('');
const linksIn = node => typeof node === 'string' ? [] : node.href ? [node] : node.children.flatMap(linksIn);

test('governance shows builder counts, limited address links and a scheduling transaction in both languages', t => {
  const render = governanceTable(t), calls = relabelCall(call).batch;
  const op = batchOperation([...calls, ...calls.slice(0, 2), { ...calls[0], args: [String(2n ** 200n)], display: { 0: calls[0].display[0] } }]);
  for (const lang of ['zh', 'en']) {
    const [row] = render([op], lang), [description, target, , status] = row.children;
    assert.equal(description.children[0].textContent, lang === 'zh' ? '批量排程 9 项' : 'Batch of 9 operations');
    const detail = description.children[1];
    assert.match(content(detail), lang === 'zh' ? /批准 Hyperliquid builder ×9：.*等 2 个.*1 项参数无法解析/ : /Approve Hyperliquid builder ×9: .*and 2 more.*1 with unreadable arguments/);
    assert.deepEqual(linksIn(detail).map(a => a.href), calls.map(c => 'https://hyperevmscan.io/address/' + c.display[0]));
    assert.equal(linksIn(target)[0].href, 'https://hyperevmscan.io/address/' + calls[0].target);
    assert.equal(linksIn(status)[0].href, 'https://hyperevmscan.io/tx/' + event.tx);
  }
});

test('batch details show every upgrade and group translated or unknown functions by target and selector', t => {
  const render = governanceTable(t);
  const proxy = '0x233ff29b239abc1d7748605da9b205c3e008626e', implementation = GOVERNANCE.exchange;
  const upgrade = { target: GOVERNANCE.proxyAdmin, selector: '99a88ec4', args: [String(BigInt(proxy)), implementation] };
  const delay = { target: GOVERNANCE.timelock, ...describeCall(GOVERNANCE.timelock, '8a99d586' + '3c'.padStart(64, '0')) };
  const curve = { target: GOVERNANCE.tokenomics, ...describeCall(GOVERNANCE.tokenomics, '12baae3b'), args: ['120', '240'] };
  const unknown = { target: GOVERNANCE.exchange, selector: '7759e487', args: ['47500', '1000'] };
  for (const lang of ['zh', 'en']) {
    const [row] = render([batchOperation([upgrade, upgrade, delay, curve, unknown, { ...unknown, args: ['85'] }])], lang);
    const [description, target] = row.children, detail = description.children[1], text = content(detail);
    assert.equal(content(target), lang === 'zh' ? '多个合约' : 'Multiple contracts');
    assert.match(text, lang === 'zh' ? /合约升级 ×2/ : /Contract upgrades ×2/);
    assert.equal(text.split(lang === 'zh' ? '升级 0x233f…626e → Exchange' : 'Upgrade 0x233f…626e → Exchange').length, 3);
    assert.equal(linksIn(detail).filter(a => a.href.endsWith(proxy)).length, 2);
    assert.match(text, lang === 'zh' ? /修改 timelock 最短延迟 updateMinDelay\(秒\) ×1/ : /Change timelock minimum delay updateMinDelay\(seconds\) ×1/);
    assert.match(text, lang === 'zh' ? /未知函数 0x7759e487 ×2/ : /Unknown function 0x7759e487 ×2/);
    assert.match(text, /47500, 1000, 85/);
    assert.match(text, /120, 240/);
    assert.doesNotMatch(text, /5,000,000|原 7 天|was 7 days/);
  }
});

test('batch details cap groups and parameter lengths, validate addresses and tolerate missing or malformed fields', t => {
  const render = governanceTable(t), invalid = 'javascript:alert(1)', long = '<b>' + 'x'.repeat(999);
  const calls = [
    { target: invalid, selector: '12345678', args: [long], display: invalid },
    { selector: '99a88ec4', args: { 0: GOVERNANCE.timelock }, display: [invalid, null] },
    ...Array.from({ length: 12 }, (_, i) => ({ selector: (i + 400).toString(16).padStart(8, '0'), args: [null, {}] })),
  ];
  for (const lang of ['zh', 'en']) {
    const [row] = render([{ ...batchOperation(calls), scheduledTx: invalid }], lang);
    const [description] = row.children, detail = description.children[1];
    assert.ok(content(detail).includes(long.slice(0, 120) + '…'));
    assert.ok(!content(detail).includes(long));
    assert.match(content(detail), lang === 'zh' ? /等 2 组$/ : /and 2 more groups$/);
    assert.deepEqual(linksIn(row), []);
    const [fallback] = render([{ ...batchOperation([]), batchSize: 1, batch: invalid }], lang);
    assert.equal(content(fallback.children[0].children[0]), lang === 'zh' ? '批量排程 1 项' : 'Batch of 1 operation');
    assert.equal(content(fallback.children[0].children[1]), lang === 'zh' ? '明细没存或解不出，见交易' : 'Details not stored or not decoded, see the transaction');
    assert.equal(content(fallback.children[1]), 'Timelock');
    assert.equal(linksIn(fallback.children[3]).length, 1);
  }
});

test('the table and pending counter class batches, cap changes and missing ready times consistently', t => {
  const render = governanceTable(t), batch = batchOperation([call.batch[0]]), curve = { ...KNOWN_OPERATIONS[0], readyAt: 1200 };
  const ended = { ...batch, resolvedBlock: 10, resolvedTopic: '0xaa1510acf32db51981a900a90589bafbf6f442c657a0b916fd3afe22c1474bcd' };
  const records = [batch, curve, ended, { ...batch, readyAt: null }];
  for (const [cap, expected] of [[9999999, ['wait', 'ready', 'done']], [10000000, ['ready', 'done', 'done']]]) {
    const rows = render(records, 'en', cap);
    const badges = rows.map(row => row.children[3].children[0]);
    assert.deepEqual(badges.map(badge => badge.className), expected.map(key => 'badge ' + key));
    assert.equal(records.filter(o => isPending(o, cap)).length, expected.filter(key => key !== 'done').length);
    assert.equal(badges.at(-1).textContent, 'Executed');
  }
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
  assert.ok(zh.parts.includes(' · 已扫日志里没有执行记录'));
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

test('builders that cannot be read are reported, never invented', t => {
  const build = alerts(t);
  const broken = { ...call.batch[0], args: [], display: [] }, oversized = { ...call.batch[0], args: [String(2n ** 200n)] };
  const [alert] = build([{ ...event, call: relabelCall({ ...call, batch: [call.batch[0], broken, oversized] }) }], 'en');
  assert.equal(alert.parts[0], 'Approve Hyperliquid builder approveBuilder(address) ×3');
  assert.equal(alert.parts.filter(p => p.href?.includes('/address/')).length, 2); // one builder + the target
  assert.ok(alert.parts.includes(' (2 with unreadable arguments, see the transaction)'));
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
  assert.equal(zh.parts[0], '共 6 项，明细没存或解不出，见交易');
  const [en] = build([{ ...event, call: relabelCall({ selector: call.selector, args: call.args }) }], 'en');
  assert.equal(en.parts[0], '6 operations; details not stored or not decoded, see the transaction');
  const [unknown] = build([{ ...event, call: { selector: '8f2a0bb0' } }], 'en');
  assert.equal(unknown.title, 'Multisig submitted: batch schedule');
  assert.equal(unknown.parts.at(-1).href, 'https://hyperevmscan.io/tx/' + event.tx);
});
