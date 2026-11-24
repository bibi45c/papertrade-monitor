// Listing and parameter alerts: short title, readable detail with explorer links, severity badge.
import { translateMessage } from './i18n.mjs';
const EXPLORER = 'https://hyperevmscan.io/';
const TOKENS = Object.freeze({ '0xb88339cb7199b77e23db6e890353e22632ba630f': 'USDC' });
const PARAMS = Object.freeze({
  minimumOpenNotional: ['最小开仓名义金额', 'Minimum open notional'], minimumMargin: ['最小保证金', 'Minimum margin'], minimumPaperStake: ['最小质押 PAPER', 'Minimum PAPER stake'],
  maxLeverage: ['最高杠杆', 'Maximum leverage'], maxPositionNotional: ['单仓名义上限', 'Maximum position notional'], rateMultiplier: ['费率乘数', 'Rate multiplier'],
  positionMultiplier: ['仓位乘数', 'Position multiplier'], baseRate: ['基础费率', 'Base rate'], referenceNotional: ['参考名义金额', 'Reference notional'], bustBuffer: ['爆仓缓冲', 'Bust buffer'],
});
const short = a => a.slice(0, 6) + '…' + a.slice(-4);
const link = (path, label, title) => { const a = document.createElement('a'); a.href = EXPLORER + path; a.target = '_blank'; a.rel = 'noreferrer'; a.className = 'addr'; a.textContent = label; if (title) a.title = title; return a; };
const fmt = v => { const n = Number(v); return Number.isFinite(n) && String(v).trim() !== '' ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(v); };

function listingAlert(a, L) {
  // Parameter alerts are produced as "[SYMBOL ]field: from → to[（note）]".
  const m = /^(?:([A-Z]+) )?([A-Za-z]+): (.+?) → (.+?)(?:（(.*)）)?$/.exec(a.detail ?? '');
  if (a.kind === 'parameter' && m) {
    const [, sym, field, from, to, note] = m, name = PARAMS[field];
    return { level: a.level, title: L(`参数变化：${name?.[0] ?? field}`, `Parameter change: ${name?.[1] ?? field}`) + (sym ? ` · ${sym}` : ''),
      parts: [`${fmt(from)} → ${fmt(to)}`, note ? L(`；${note}`, field && a.symbol === '*' ? '; the market keeper can change it at any time' : '') : ''] };
  }
  const titles = { newMarket: ['新品种上线', 'New market listed'], status: ['交易状态变化', 'Trading status change'], removed: ['品种下架', 'Market removed'] };
  return { level: a.level, title: titles[a.kind] ? L(...titles[a.kind]) : L('交易参数预警', 'Trading parameter alert'), parts: [a.detail] };
}

function builderAddress(call) {
  if (/^0x[\da-f]{40}$/i.test(call.display?.[0])) return call.display[0];
  const arg = call.args?.[0];
  if (!/^\d{1,49}$/.test(arg)) return null;
  const hex = BigInt(arg).toString(16);
  return hex.length <= 40 ? '0x' + hex.padStart(40, '0') : null;
}

function batchDetails(batch, L, lang) {
  const groups = new Map();
  for (const call of batch) {
    const key = call.target + ':' + call.selector;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call);
  }
  const parts = [];
  let remaining = 6;
  for (const calls of groups.values()) {
    const { label, where, target, selector } = calls[0];
    if (parts.length) parts.push(L('；', ' | '));
    parts.push(`${translateMessage(label, lang)} ×${calls.length}`);
    if (selector === '54dc2a02') {
      const builders = calls.map(builderAddress).filter(Boolean);
      const shown = builders.slice(0, remaining), extra = builders.length - shown.length;
      shown.forEach((addr, i) => parts.push(i ? ', ' : ' ', link('address/' + addr, short(addr), addr)));
      if (extra) parts.push(shown.length ? L(` 等 ${extra} 个`, ` and ${extra} more`) : L('（地址见交易）', ' (addresses in the transaction)'));
      remaining -= shown.length;
      const unread = calls.length - builders.length;
      if (unread) parts.push(L(`（${unread} 项参数无法解析，见交易）`, ` (${unread} with unreadable arguments, see the transaction)`));
    }
    const targetLabel = where && where !== target ? translateMessage(where, lang) : short(target);
    parts.push(L('（目标 ', ' (target '), link('address/' + target, targetLabel, target), L('）', ')'));
  }
  return parts;
}

function multisigAlert(e, L, lang) {
  const c = e.call?.inner ?? e.call, executed = e.kind === 'multisigExecuted';
  const verb = executed ? L('多签执行', 'Multisig executed') : L('多签提交', 'Multisig submitted');
  const parts = [];
  let title;
  const sep = L('：', ': ');
  if (['8b07f62b', '8f2a0bb0'].includes(c?.selector)) {
    const size = c.batch?.length || c.batchSize;
    const operations = size === 1 ? 'operation' : 'operations';
    title = `${verb}${sep}${size ? L(`批量排程 ${size} 项`, `batch schedule of ${size} ${operations}`) : L('批量排程', 'batch schedule')}`;
    if (c.batch?.length) parts.push(...batchDetails(c.batch, L, lang));
    else parts.push(size ? L(`共 ${size} 项，明细没存或解不出，见交易`, `${size} ${operations}; details not stored or not decoded, see the transaction`) : L('明细没存或解不出，见交易', 'Details not stored or not decoded, see the transaction'));
  } else if (['a9059cbb', '095ea7b3'].includes(c?.selector) && TOKENS[c.target]) {
    const to = c.display?.[0] ?? '', amount = c.display?.[1] ?? '', approve = c.selector === '095ea7b3';
    title = `${verb}${sep}${approve ? L('授权', 'approval of') : L('转出', 'transfer of')} ${amount}`;
    parts.push(approve ? L('被授权地址 ', 'Spender ') : L('收款 ', 'To '), link('address/' + to, short(to), to));
  } else if (c?.selector === '17938e13') {
    title = `${verb}${sep}${L('向 HyperCore 发指令', 'action sent to HyperCore')}`;
    parts.push(L('经 CoreWriter 发到 Hyperliquid Core（转账、下单等），原始编码没列', 'Submitted from EVM to Hyperliquid Core via CoreWriter (e.g. transfer or order); raw encoding hidden'));
  } else if (['a6cc2c8c', 'e38335e5', '134008d3', '88aa4c12'].includes(c?.selector)) {
    title = `${verb}${sep}${L('执行到期的 timelock 排程', 'executed matured timelock operations')}`;
    parts.push(L('具体操作见上方排程表', 'See the timelock table above for the operations'));
  } else if (c) {
    title = `${verb}${sep}${translateMessage(c.label, lang)}`;
    parts.push(`${translateMessage(c.where, lang)}${c.display ? ' · ' + c.display.join(', ') : ''}`);
  } else title = `${verb}${sep}${L('未解析调用', 'undecoded call')}`;
  if (!executed) parts.push(L(' · 已扫日志里没有执行记录', ' · no execution seen in scanned logs'));
  parts.push(' · ', link('tx/' + e.tx, L(`区块 ${e.block}`, `block ${e.block}`), e.tx));
  return { level: 'high', title, parts };
}

export function buildAlerts({ listing, web, events, lang, time, now }) {
  const L = (a, b) => lang === 'zh' ? a : b, out = (listing?.alerts ?? []).map(a => listingAlert(a, L));
  if (web?.changedAt && now - web.changedAt < 7 * 86400000) out.push({ level: 'info', title: L('官方文档或前端已更新', 'Official docs or frontend updated'), parts: [L(`${time(web.changedAt)} 更新，看看有没有上新或改规则`, `Updated ${time(web.changedAt)}; review manually for listings or rule changes`)] });
  // A submission that was later executed (same multisig transaction id) is shown once, as executed.
  const ms = (events ?? []).filter(e => e.kind === 'multisigSubmitted' || e.kind === 'multisigExecuted');
  const executedIds = new Set(ms.filter(e => e.kind === 'multisigExecuted').map(e => e.topic1));
  for (const e of ms.filter(e => e.kind === 'multisigExecuted' || !executedIds.has(e.topic1)).slice(0, 5)) out.push(multisigAlert(e, L, lang));
  const rank = { critical: 0, high: 1, info: 2 };
  return out.sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
}

export function renderAlerts(body, alerts, { lang, emptyText }) {
  const L = (a, b) => lang === 'zh' ? a : b;
  if (!alerts.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 2; td.textContent = emptyText; tr.append(td); body.replaceChildren(tr); return; }
  const names = { critical: L('严重', 'Critical'), high: L('高', 'High'), info: L('提示', 'Info') };
  body.replaceChildren(...alerts.map(a => {
    const tr = document.createElement('tr'), cell = document.createElement('td'), title = document.createElement('div'), detail = document.createElement('div');
    title.className = 'op-title'; title.textContent = a.title; detail.className = 'op-detail';
    for (const p of a.parts) if (p) detail.append(typeof p === 'string' ? document.createTextNode(p) : p);
    cell.append(title, detail);
    const level = document.createElement('td'), badge = document.createElement('span');
    badge.className = 'badge sev-' + a.level; badge.textContent = names[a.level] ?? a.level; level.append(badge);
    tr.append(cell, level); return tr;
  }));
}
