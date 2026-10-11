import { appendFile, mkdir } from 'node:fs/promises';
import { collect } from '../src/collect.mjs';
import { makePlan, emissionRate } from '../src/model.mjs';

await mkdir(new URL('../data', import.meta.url), { recursive: true });
const once = process.argv.includes('--once');
do {
  const s = await collect(), plan = makePlan(s, 'BTC');
  await appendFile(new URL('../data/monitor.jsonl', import.meta.url), JSON.stringify(s) + '\n');
  console.log(new Date(s.collectedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' }), '| 仅测算，不下单');
  console.table(s.markets.map(m => ({ asset: m.coin, HL: m.mid ?? '不可用', Paper: m.paperMid ?? '不可用', '差价bps': m.paperMid && m.mid ? ((m.paperMid / m.mid - 1) * 10000).toFixed(3) : '不可用', '小时资金费': m.funding ?? '不可用' })));
  console.log('兑付队列:', s.queue ? `${s.queue.count} 笔 / ${s.queue.total.toFixed(2)} U` : '不可用', '| 供应:', s.paper?.supply ?? '不可用', '| 铸币率:', emissionRate(s.paper) ?? '不可用');
  console.log('下单队列:', s.executionQueue.available ? `等待 ${s.executionQueue.queuedIntents} / 已提交 ${s.executionQueue.submittedIntents}；Gas 容量折算 ${s.executionQueue.capacityBlocks} 块（不是成交时间）` : s.executionQueue.reason);
  console.log('BTC 方案:', plan.ready ? `${plan.quantity} BTC；Paper ${plan.notional.toFixed(2)}U，HL 最低保证金估计 ${plan.marginMinimum.toFixed(2)}U` : plan.reasons.join('；'));
  if (plan.scenarios) console.table(plan.scenarios.map(b => ({ branch: b.name, '组合盈亏U': b.pnl?.toFixed(4), 'PAPER数量': b.mintedPaper.toFixed(2), '每1万枚PAPER成本U': b.costPerPaper === null ? '未铸币' : Number.isFinite(b.costPerPaper) ? (b.costPerPaper * 10000).toFixed(2) : '不可用' })));
  if (!once) await new Promise(resolve => setTimeout(resolve, 15000));
} while (!once);
