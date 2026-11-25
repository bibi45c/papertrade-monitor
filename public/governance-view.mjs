// Timelock operations table: plain-language title, readable parameters with explorer links, named targets, status badges.
import { translateMessage } from './i18n.mjs';
const EXPLORER = 'https://hyperevmscan.io/';
const NAMES = Object.freeze({
  '0x6cd5661646289fb6e65ea5c032310fded797d0a2': ['Exchange', 'Exchange'],
  '0x75174549dbbd44497d31a47e2e2d7406408d63d9': ['PaperTokenomics（铸币与分配曲线）', 'PaperTokenomics (mint and allocation curve)'],
  '0xe79c91cc682f1bb401a9cab74c900470190f0f8f': ['ProxyAdmin（合约升级）', 'ProxyAdmin (contract upgrades)'],
  '0xb915fa41e824d6aa31bb833ee81220c0f2c8ea0f': ['Timelock', 'Timelock'],
  '0x696292762fd5ac3677a45edbe54eaece4194d1f6': ['多签', 'Multisig'],
  '0xfdc6550436dd75ce8a0b145f935b7d3a64f53248': ['Hyperliquid 交易账户合约（owner = timelock）', 'Hyperliquid trading-account contract (owner = timelock)'],
  '0x8326eb8896e358717f10502ec73ce8d28e37b108': ['代理合约（owner = timelock，用途未确认）', 'Proxy (owner = timelock, purpose unconfirmed)'],
});
const short = a => a.slice(0, 6) + '…' + a.slice(-4);
const isAddress = a => typeof a === 'string' && /^0x[\da-fA-F]{40}$/.test(a);
const array = value => Array.isArray(value) ? value : [];
const scalar = v => typeof v === 'string' || typeof v === 'number';
const numeric = v => scalar(v) ? Number(v) : NaN;

function explorerLink(path, label, title) {
  const a = document.createElement('a');
  a.href = EXPLORER + path; a.target = '_blank'; a.rel = 'noreferrer'; a.className = 'addr'; a.title = title;
  a.textContent = label;
  return a;
}

function addressLink(addr, lang) {
  if (!isAddress(addr)) return document.createTextNode('—');
  const name = NAMES[addr.toLowerCase()];
  return explorerLink('address/' + addr, name ? name[lang === 'zh' ? 0 : 1] : short(addr), addr);
}
function describe(o, lang) {
  const zh = lang === 'zh', L = (a, b) => zh ? a : b, args = array(o.args);
  switch (o.selector) {
    case '12baae3b': return { title: L('调整 Tokenomics 分配曲线', 'Adjust the Tokenomics allocation curve'), parts: [zh ? (o.description ?? args.filter(scalar).join(', ')) : `Staker allocation cap (LP above it is pushed to stakers) 5,000,000 → ${numeric(args[1] ?? 0).toLocaleString('en-US')} U; the other three parameters equal current values`] };
    case '8a99d586': { const sec = numeric(args[0]); return { title: L('缩短 timelock 最短延迟', 'Shorten the timelock minimum delay'), parts: [L(`改为 ${sec.toLocaleString('en-US')} 秒（${sec / 86400} 天，原 7 天），以后上新、改参数、升级只要提前 ${sec / 86400} 天排程`, `Set to ${sec.toLocaleString('en-US')} s = ${sec / 86400} day (was 7 days); listings, parameter changes and upgrades now need only ${sec / 86400} day notice`)], warn: true }; }
    case '99a88ec4': return { title: L('升级代理合约', 'Upgrade a proxy contract'), parts: [L('代理 ', 'Proxy '), { addr: addressArg(o, 0) }, L(' → 新实现 ', ' → new implementation '), { addr: addressArg(o, 1) }] };
    case '54dc2a02': return { title: L('批准 Hyperliquid builder', 'Approve a Hyperliquid builder'), parts: [L('builder ', 'Builder '), { addr: addressArg(o, 0) }, L('，可对该账户的 Hyperliquid 下单收取 builder 费', ' may charge builder fees on this account\'s Hyperliquid orders')] };
    default: return { title: o.label ?? L('未知操作', 'Unknown operation'), parts: [(Array.isArray(o.display) ? o.display : args).filter(scalar).join(', ')] };
  }
}

function addressArg(call, index) {
  const display = array(call.display)[index], raw = array(call.args)[index];
  if (isAddress(display)) return display;
  if (isAddress(raw)) return raw;
  if (typeof raw !== 'string' || !/^\d{1,49}$/.test(raw)) return null;
  const address = '0x' + BigInt(raw).toString(16).padStart(40, '0');
  return isAddress(address) ? address : null;
}

function batchParams(calls) {
  let text = '';
  for (const call of calls) {
    const values = array(call.display);
    for (const v of values.some(scalar) ? values : array(call.args)) {
      if (!scalar(v)) continue;
      text += (text ? ', ' : '') + String(v).slice(0, 121);
      if (text.length > 120) return text.slice(0, 120) + '…';
    }
  }
  return text;
}

function describeBatch(o, lang) {
  const L = (a, b) => lang === 'zh' ? a : b;
  const calls = array(o.batch).filter(call => call && typeof call === 'object');
  const size = o.batchSize ?? calls.length;
  const title = L(`批量排程 ${size} 项`, `Batch of ${size} ${size === 1 ? 'operation' : 'operations'}`);
  if (!calls.length) return { title, target: 'Timelock', parts: [L('明细没存或解不出，见交易', 'Details not stored or not decoded, see the transaction')] };
  const groups = new Map(), targets = new Set();
  for (const call of calls) {
    const target = isAddress(call.target) ? call.target.toLowerCase() : null;
    const selector = typeof call.selector === 'string' && /^[\da-f]{8}$/i.test(call.selector) ? call.selector.toLowerCase() : '';
    const key = target + ':' + selector;
    if (!groups.has(key)) groups.set(key, { target, selector, members: [] });
    groups.get(key).members.push(call);
    targets.add(target);
  }
  const parts = [], sep = L('；', ' | ');
  let builderLinks = 6;
  for (const { target, selector, members } of [...groups.values()].slice(0, 12)) {
    if (parts.length) parts.push(sep);
    if (selector === '99a88ec4') {
      if (members.length > 1) parts.push(L('合约升级', 'Contract upgrades') + ` ×${members.length}` + L('：', ': '));
      members.forEach((call, i) => {
        if (i) parts.push(sep);
        parts.push(L('升级 ', 'Upgrade '), { addr: addressArg(call, 0) }, ' → ', { addr: addressArg(call, 1) });
      });
    } else if (selector === '54dc2a02') {
      parts.push(L('批准 Hyperliquid builder', 'Approve Hyperliquid builder') + ` ×${members.length}`);
      const builders = members.map(call => addressArg(call, 0)).filter(Boolean), shown = builders.slice(0, builderLinks);
      shown.forEach((addr, i) => parts.push(i ? ', ' : L('：', ': '), { addr }));
      const extra = builders.length - shown.length, unread = members.length - builders.length;
      if (extra) parts.push(L(` 等 ${extra} 个`, ` and ${extra} more`));
      if (unread) parts.push(L(`（${unread} 项参数无法解析，见交易）`, ` (${unread} with unreadable arguments, see the transaction)`));
      if (targets.size > 1) parts.push(' · ', { addr: target });
      builderLinks -= shown.length;
    } else {
      const label = typeof members[0].label === 'string' && members[0].label
        ? members[0].label : selector ? `未知函数 0x${selector}` : '空调用';
      const params = batchParams(members);
      parts.push(`${translateMessage(label, lang)} ×${members.length}`, ' · ', { addr: target });
      if (params) parts.push(' · ' + params);
    }
  }
  if (groups.size > 12) parts.push(sep, L(`等 ${groups.size - 12} 组`, `and ${groups.size - 12} more groups`));
  const target = targets.size === 1 ? { addr: targets.values().next().value } : L('多个合约', 'Multiple contracts');
  return { title, target, parts };
}

export function operationOutcome(o) {
  if (['executed', 'cancelled', 'unknown'].includes(o.outcome)) return o.outcome;
  if (o.resolvedBlock != null && o.resolvedBlock === o.scheduledBlock) return 'unknown'; // older record without log order
  if (o.resolvedTopic === '0x2a08801cf3674ab09756ae78a3a4833813465af6af958136b360eab6b71c8952'
    || o.resolvedTopic === '0xaa1510acf32db51981a900a90589bafbf6f442c657a0b916fd3afe22c1474bcd') return 'executed';
  if (o.resolvedTopic === '0xcf0f63b97f3387253cbc0bde884f975df77e39184dc3280c2c81be495f58eef4') return 'cancelled';
  return o.resolvedBlock == null ? null : 'unknown';
}

export function isPending(o, cap) {
  const intendedCap = o.selector === '12baae3b' ? numeric(array(o.args)[1]) : NaN;
  return Number.isFinite(o.readyAt) && !operationOutcome(o) && !(intendedCap > 0 && cap >= intendedCap);
}

export function renderGovernanceTable({ ops, now, time, cap, lang, number, available }) {
  const zh = lang === 'zh', L = (a, b) => zh ? a : b, body = document.getElementById('govTable');
  const scheduled = ops.filter(o => Number.isFinite(o.readyAt));
  if (!scheduled.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 4; td.textContent = available ? L('没有排程操作', 'No scheduled operations') : L('治理数据拿不到，不等于没有排程', 'Governance data unavailable; this does not mean nothing is scheduled');
    tr.append(td); body.replaceChildren(tr); return;
  }
  const state = o => !isPending(o, cap) ? 2 : o.readyAt <= now ? 1 : 0;
  const done = { executed: L('已执行', 'Executed'), cancelled: L('已取消', 'Cancelled'), unknown: L('已执行或取消', 'Executed or cancelled') };
  const sorted = scheduled.sort((a, b) => state(a) - state(b) || b.readyAt - a.readyAt);
  body.replaceChildren(...sorted.map(o => {
    const tr = document.createElement('tr'); tr.className = 'gov-row';
    const batch = o.kind === 'batchScheduled', d = batch ? describeBatch(o, lang) : describe(o, lang);
    const op = document.createElement('td'), title = document.createElement('div'), detail = document.createElement('div');
    title.className = 'op-title' + (d.warn ? ' warn' : ''); title.textContent = d.title;
    detail.className = 'op-detail';
    for (const p of d.parts) detail.append(typeof p === 'string' ? document.createTextNode(p) : addressLink(p.addr, lang));
    op.append(title, detail);
    const target = document.createElement('td');
    target.append(typeof d.target === 'string' ? document.createTextNode(d.target) : addressLink(d.target ? d.target.addr : o.target, lang));
    const when = document.createElement('td'); when.textContent = time(o.readyAt);
    const status = document.createElement('td'), badge = document.createElement('span'), s = state(o);
    badge.className = 'badge ' + ['wait', 'ready', 'done'][s];
    badge.textContent = s === 2 ? (done[operationOutcome(o)] ?? L('已生效', 'In effect')) : s === 1 ? L('可执行 · 等多签', 'Executable · awaiting multisig') : L(`排程中 · ${number((o.readyAt - now) / 86400000, 1)} 天后`, `Scheduled · in ${number((o.readyAt - now) / 86400000, 1)} days`);
    status.append(badge);
    if (o.resolvedBlock != null) { const blk = document.createElement('div'); blk.className = 'op-detail'; blk.textContent = L('区块 ', 'Block ') + o.resolvedBlock; status.append(blk); }
    if (batch && typeof o.scheduledTx === 'string' && /^0x[\da-f]{64}$/i.test(o.scheduledTx)) {
      const tx = document.createElement('div'); tx.className = 'op-detail';
      tx.append(explorerLink('tx/' + o.scheduledTx, L('排程交易', 'Scheduling transaction'), o.scheduledTx));
      status.append(tx);
    }
    tr.append(op, target, when, status);
    return tr;
  }));
}
