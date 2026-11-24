// Timelock operations table: plain-language title, readable parameters with explorer links, named targets, status badges.
const EXPLORER = 'https://hyperevmscan.io/address/';
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
const toAddress = v => { try { return '0x' + BigInt(v).toString(16).padStart(40, '0'); } catch { return String(v); } };

function addressLink(addr, lang) {
  const a = document.createElement('a');
  a.href = EXPLORER + addr; a.target = '_blank'; a.rel = 'noreferrer'; a.className = 'addr'; a.title = addr;
  const name = NAMES[addr.toLowerCase()];
  a.textContent = name ? name[lang === 'zh' ? 0 : 1] : short(addr);
  return a;
}
function describe(o, lang) {
  const zh = lang === 'zh', L = (a, b) => zh ? a : b, args = o.args ?? [];
  switch (o.selector) {
    case '12baae3b': return { title: L('调整 Tokenomics 分配曲线', 'Adjust the Tokenomics allocation curve'), parts: [zh ? (o.description ?? args.join(', ')) : `Staker allocation cap (LP above it is pushed to stakers) 5,000,000 → ${Number(args[1] ?? 0).toLocaleString('en-US')} U; the other three parameters equal current values`] };
    case '8a99d586': { const sec = Number(args[0]); return { title: L('缩短 timelock 最短延迟', 'Shorten the timelock minimum delay'), parts: [L(`改为 ${sec.toLocaleString('en-US')} 秒 = ${sec / 86400} 天（原 7 天）；之后上新、改参数、升级只需提前 ${sec / 86400} 天排程`, `Set to ${sec.toLocaleString('en-US')} s = ${sec / 86400} day (was 7 days); listings, parameter changes and upgrades now need only ${sec / 86400} day notice`)], warn: true }; }
    case '99a88ec4': return { title: L('升级代理合约', 'Upgrade a proxy contract'), parts: [L('代理 ', 'Proxy '), { addr: toAddress(args[0]) }, L(' → 新实现 ', ' → new implementation '), { addr: toAddress(args[1]) }] };
    case '54dc2a02': return { title: L('批准 Hyperliquid builder', 'Approve a Hyperliquid builder'), parts: [L('builder ', 'Builder '), { addr: toAddress(args[0]) }, L('，可对该账户的 Hyperliquid 下单收取 builder 费', ' may charge builder fees on this account\'s Hyperliquid orders')] };
    default: return { title: o.label ?? L('未知操作', 'Unknown operation'), parts: [(o.display ?? args).join(', ')] };
  }
}

export function operationOutcome(o) {
  if (['executed', 'cancelled', 'unknown'].includes(o.outcome)) return o.outcome;
  if (o.resolvedBlock != null && o.resolvedBlock === o.scheduledBlock) return 'unknown'; // older record without log order
  if (o.resolvedTopic === '0x2a08801cf3674ab09756ae78a3a4833813465af6af958136b360eab6b71c8952') return 'executed';
  if (o.resolvedTopic === '0xcf0f63b97f3387253cbc0bde884f975df77e39184dc3280c2c81be495f58eef4') return 'cancelled';
  return o.resolvedBlock == null ? null : 'unknown';
}

export function renderGovernanceTable({ ops, now, time, applied, lang, number, available }) {
  const zh = lang === 'zh', L = (a, b) => zh ? a : b, body = document.getElementById('govTable');
  if (!ops.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 4; td.textContent = available ? L('没有排程操作', 'No scheduled operations') : L('治理数据不可用，不能当作没有排程', 'Governance data unavailable; this does not mean nothing is scheduled');
    tr.append(td); body.replaceChildren(tr); return;
  }
  const state = o => operationOutcome(o) || applied(o) ? 2 : o.readyAt <= now ? 1 : 0;
  const done = { executed: L('已执行', 'Executed'), cancelled: L('已取消', 'Cancelled'), unknown: L('已执行或取消', 'Executed or cancelled') };
  const sorted = [...ops].sort((a, b) => state(a) - state(b) || b.readyAt - a.readyAt);
  body.replaceChildren(...sorted.map(o => {
    const tr = document.createElement('tr'); tr.className = 'gov-row';
    const d = describe(o, lang);
    const op = document.createElement('td'), title = document.createElement('div'), detail = document.createElement('div');
    title.className = 'op-title' + (d.warn ? ' warn' : ''); title.textContent = d.title;
    detail.className = 'op-detail';
    for (const p of d.parts) detail.append(typeof p === 'string' ? document.createTextNode(p) : addressLink(p.addr, lang));
    op.append(title, detail);
    const target = document.createElement('td'); target.append(addressLink(o.target, lang));
    const when = document.createElement('td'); when.textContent = time(o.readyAt);
    const status = document.createElement('td'), badge = document.createElement('span'), s = state(o);
    badge.className = 'badge ' + ['wait', 'ready', 'done'][s];
    badge.textContent = s === 2 ? (done[operationOutcome(o)] ?? L('已生效', 'In effect')) : s === 1 ? L('可执行 · 等多签', 'Executable · awaiting multisig') : L(`排程中 · ${number((o.readyAt - now) / 86400000, 1)} 天后`, `Scheduled · in ${number((o.readyAt - now) / 86400000, 1)} days`);
    status.append(badge);
    if (o.resolvedBlock != null) { const blk = document.createElement('div'); blk.className = 'op-detail'; blk.textContent = L('区块 ', 'Block ') + o.resolvedBlock; status.append(blk); }
    tr.append(op, target, when, status);
    return tr;
  }));
}
