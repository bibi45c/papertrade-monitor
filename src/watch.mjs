// 风险与规则变更监控：治理排程、上新与参数变化、宏观事件、秒级跳动。
// 只读公开接口与公开链上日志；不保存钱包地址以外的任何个人数据，合约与多签地址是协议公开配置。
import { readJson, ReadError, checkRpcError } from './read-retry.mjs';

export const GOVERNANCE = Object.freeze({
  timelock: '0xb915fa41e824d6aa31bb833ee81220c0f2c8ea0f',   // Exchange / PAPER / Staking / Tokenomics / ProxyAdmin 的 owner，minDelay 7 天
  multisig: '0x696292762fd5ac3677a45edbe54eaece4194d1f6',   // timelock 的 owner，同时是 pause guardian
  exchange: '0x6cd5661646289fb6e65ea5c032310fded797d0a2',
  tokenomics: '0x75174549dbbd44497d31a47e2e2d7406408d63d9',
  proxyAdmin: '0xe79c91cc682f1bb401a9cab74c900470190f0f8f',
  marketKeeper: '0x3721476de31190dc1af8908026abe20efe25cf99',
  minDelaySeconds: 604800,
});
// 合约源码未验证；以下事件和函数名由 2026-10-11 的链上交易反推。
const TOPICS = Object.freeze({
  scheduled: '0x78f3bc93d9f0e2beb7fc8fe3192b142c5e70b8813403674aff3f81fc83af5b39',
  submitted: '0xbe411f0729ceed75',
  executed: '0xd3fb8b9f824d81f0',
  signersSet: '0xddfe9ff988d8830e',
});
const SELECTORS = Object.freeze({
  '12baae3b': 'PaperTokenomics 曲线参数（平坦区阈值、质押者分配上限、平坦铸币率、衰减尺度，按调用参数位置推断）',
  'b0e58bc9': 'timelock.schedule(target, value, data, salt)',
  '79301c0f': '多签签名人配置',
});
// 已知的排程操作：2026-10-11 01:26 新加坡时间由多签确认，只改质押者分配上限 5M → 10M。
export const KNOWN_OPERATIONS = Object.freeze([{
  id: '0x51142366b8d5ae8d41322de14a7627f265e2ab54ee65828bbbaa14f6090cb578', target: GOVERNANCE.tokenomics, selector: '12baae3b',
  args: ['2000000', '10000000', '100', '120000000'], readyAt: 1792262786000, scheduledBlock: 48191335,
  scheduledTx: '0xad38ffd14ec3032301199d3af3388599c483c963b1ce478e9e78d3bb36ac2f3d',
  description: '质押者分配上限（LP 超过该值才把超额推给质押者）5,000,000 → 10,000,000 U；其余三个参数与现值相同',
}]);

const word = (hex, i) => hex.slice(i * 64, i * 64 + 64);
const toAddress = w => '0x' + w.slice(24);
const big = w => BigInt('0x' + (w || '0'));
const usd = w => (big(w) / 10n ** 18n).toString();

export function describeCall(target, data) {
  const selector = data.slice(0, 8), body = data.slice(8), words = [];
  for (let i = 0; i * 64 < body.length; i++) words.push(word(body, i));
  const label = SELECTORS[selector] ?? `未知函数 0x${selector}`;
  const where = target === GOVERNANCE.exchange ? 'Exchange（交易、市场、费率）' : target === GOVERNANCE.tokenomics ? 'PaperTokenomics（铸币与分配曲线）' : target === GOVERNANCE.proxyAdmin ? 'ProxyAdmin（合约升级）' : target === GOVERNANCE.timelock ? 'Timelock（7 天延迟）' : target === GOVERNANCE.multisig ? '多签自身' : target;
  // 多签提交给 timelock 的 schedule：再解一层，提前约半小时看到将要排程的目标与函数。
  if (selector === 'b0e58bc9' && words.length >= 5) {
    const innerTarget = toAddress(words[0]), offset = Number(big(words[2])) * 2, len = Number(big(body.slice(offset, offset + 64)));
    return { selector, label, where, inner: { target: innerTarget, ...describeCall(innerTarget, body.slice(offset + 64, offset + 64 + len * 2)) } };
  }
  return { selector, label, where, args: selector === '12baae3b' ? words.slice(0, 4).map(usd) : words.slice(0, 6).map(w => big(w).toString()) };
}

// timelock 排程事件：topics[1]=操作 ID，topics[2]=目标；data = value, offset, salt, readyAt(秒), len, calldata
export function decodeScheduled(log) {
  const d = log.data.slice(2), len = Number(big(word(d, 4))), calldata = d.slice(5 * 64, 5 * 64 + len * 2);
  const target = toAddress(log.topics[2].slice(2));
  return { id: log.topics[1], target, readyAt: Number(big(word(d, 3))) * 1000, scheduledBlock: Number(BigInt(log.blockNumber)), scheduledTx: log.transactionHash, ...describeCall(target, calldata) };
}

export function decodeLog(log) {
  const t0 = log.topics[0];
  if (log.address.toLowerCase() === GOVERNANCE.timelock && t0 === TOPICS.scheduled) return { kind: 'scheduled', ...decodeScheduled(log) };
  const kind = t0.startsWith(TOPICS.submitted) ? 'multisigSubmitted' : t0.startsWith(TOPICS.executed) ? 'multisigExecuted' : t0.startsWith(TOPICS.signersSet) ? 'signersSet' : 'unknown';
  let call = null;
  if (kind === 'multisigSubmitted' || kind === 'multisigExecuted') {
    const target = log.topics[3] ? toAddress(log.topics[3].slice(2)) : null, d = log.data.slice(2);
    const offset = Number(big(word(d, 1))) * 2, len = Number(big(d.slice(offset, offset + 64))), data = d.slice(offset + 64, offset + 64 + len * 2);
    if (target && data.length >= 8) call = { target, ...describeCall(target, data) };
  }
  return { kind, address: log.address.toLowerCase(), topic0: t0, topic1: log.topics[1] ?? null, block: Number(BigInt(log.blockNumber)), tx: log.transactionHash, call };
}

export function mergeBlockRanges(ranges) {
  const sorted = (ranges ?? []).filter(r => Array.isArray(r) && r.length === 2 && r.every(Number.isSafeInteger) && r[0] >= 0 && r[1] >= r[0]).map(r => [...r]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function subtractRange(ranges, from, through) {
  return ranges.flatMap(([a, b]) => b < from || a > through ? [[a, b]] : [...(a < from ? [[a, from - 1]] : []), ...(b > through ? [[through + 1, b]] : [])]);
}

// One recent chunk, then oldest pending chunks. Successful ranges alone are removed.
export async function scanGovernance({ fetcher = fetch, previous = null, maxChunks = 3 } = {}) {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 10) throw new RangeError('Invalid governance chunk budget');
  const rpc = (method, params) => readJson('https://rpc.hyperliquid.xyz/evm', { jsonrpc: '2.0', id: 1, method, params }, fetcher, { validate: v => { checkRpcError(v); if (!('result' in v)) throw new ReadError('Missing RPC result', true); return v.result; } });
  const head = Number(BigInt(await rpc('eth_blockNumber', [])));
  const last = Number.isSafeInteger(previous?.lastScannedBlock) ? previous.lastScannedBlock : Math.max(0, head - 300);
  if (head < last) throw new Error('Governance head moved behind cursor');
  const from = Math.max(last + 1, head - 999, 0), logs = [], readErrors = [];
  let gaps = mergeBlockRanges([...(previous?.gaps ?? []), ...(from > last + 1 ? [[last + 1, from - 1]] : [])]);
  const read = async (start, end) => {
    try {
      const result = await rpc('eth_getLogs', [{ address: [GOVERNANCE.timelock, GOVERNANCE.multisig], fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }]);
      if (!Array.isArray(result)) throw new Error('Invalid governance log response');
      // Decode before marking a range covered: malformed logs must remain recoverable.
      result.forEach(decodeLog);
      logs.push(...result); gaps = subtractRange(gaps, start, end); return true;
    } catch (error) {
      gaps = mergeBlockRanges([...gaps, [start, end]]);
      readErrors.push({ from: start, through: end, error: String(error.message ?? error).slice(0, 180) }); return false;
    }
  };
  let used = 0;
  if (from <= head) { await read(from, head); used++; }
  while (used < maxChunks && gaps.length) {
    const [start, lastBlock] = gaps[0], end = Math.min(lastBlock, start + 999);
    used++;
    if (!await read(start, end)) break;
  }
  const events = logs.map(decodeLog);
  const ops = new Map((previous?.operations ?? KNOWN_OPERATIONS).map(o => [o.id, o]));
  for (const e of events) if (e.kind === 'scheduled') ops.set(e.id, { ...ops.get(e.id), ...e });
  // timelock 的执行/取消事件未识别具体签名：同一操作 ID 再次出现即标记为已执行或已取消。
  for (const e of events) if (e.kind === 'unknown' && e.address === GOVERNANCE.timelock && ops.has(e.topic1)) ops.set(e.topic1, { ...ops.get(e.topic1), resolvedBlock: e.block, resolvedTopic: e.topic0 });
  const recent = [...new Map([...events.filter(e => e.kind !== 'scheduled'), ...(previous?.recentEvents ?? [])].map(e => [e.tx + ':' + e.topic0 + ':' + e.topic1, e])).values()].sort((a, b) => b.block - a.block).slice(0, 20);
  return { at: Date.now(), block: '0x' + head.toString(16), lastScannedBlock: head, scannedFrom: from, operations: [...ops.values()], recentEvents: recent, gaps, readErrors, coverageComplete: gaps.length === 0 && readErrors.length === 0 };
}

// 上新、退市与参数变化：和上线时的 BTC/ETH 基线比较；任何新品种都按跳空风险分级。
export const INSTRUMENT_BASELINE = Object.freeze({
  BTC: { id: 0, assetIndex: 0, baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 814.598, referenceNotional: 100000, maxLeverage: 1000, maxPositionNotional: 1e7 },
  ETH: { id: 1, assetIndex: 1, baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 483.979, referenceNotional: 100000, maxLeverage: 1000, maxPositionNotional: 1e7 },
});
export const TRADING_BASELINE = Object.freeze({ minimumOpenNotional: 10000, minimumMargin: 10 });

export function classifyMarket(instrument) {
  if (instrument.assetIndex >= 100000) return { level: 'critical', reason: 'HIP-3 市场：标的可能有休市或外部预言机跳变，开盘跳空会让多空双开（合成跨式）变成正期望，LP 可能被持续抽走' };
  if (!['BTC', 'ETH'].includes(instrument.symbol)) return { level: 'high', reason: '新的 HL 原生永续：波动和插针通常大于 BTC/ETH，跳空套利空间更大；先看 1 秒跳动与盘口深度' };
  return { level: 'info', reason: '基线市场' };
}

export function instrumentChanges(trading) {
  if (!trading?.instruments) return null;
  const alerts = [], close = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-12;
  for (const i of trading.instruments) {
    const base = INSTRUMENT_BASELINE[i.symbol];
    if (!base) { alerts.push({ level: classifyMarket(i).level, kind: 'newMarket', symbol: i.symbol, detail: `新品种 ${i.symbol}（id ${i.id}，HL 资产编号 ${i.assetIndex}）· ${classifyMarket(i).reason}` }); continue; }
    for (const [k, v] of Object.entries(base)) if (!close(i[k], v)) alerts.push({ level: 'high', kind: 'parameter', symbol: i.symbol, detail: `${i.symbol} ${k}: ${v} → ${i[k]}` });
    if (!i.active || i.paused || i.terminal) alerts.push({ level: 'high', kind: 'status', symbol: i.symbol, detail: `${i.symbol} 状态：active=${i.active} paused=${i.paused} terminal=${i.terminal}` });
  }
  for (const s of Object.keys(INSTRUMENT_BASELINE)) if (!trading.instruments.some(i => i.symbol === s)) alerts.push({ level: 'high', kind: 'removed', symbol: s, detail: `${s} 不在交易参数中` });
  for (const [k, v] of Object.entries(TRADING_BASELINE)) if (!close(trading[k], v)) alerts.push({ level: 'info', kind: 'parameter', symbol: '*', detail: `${k}: ${v} → ${trading[k]}（market keeper 可随时调整）` });
  if (trading.paused) alerts.push({ level: 'high', kind: 'status', symbol: '*', detail: '全局开仓暂停' });
  return { symbols: trading.instruments.map(i => i.symbol), alerts };
}

// 宏观事件（UTC）。来源：federalreserve.gov FOMC 日历、bls.gov 2026 发布日程；日期会调整，过期后需手动续表。
export const EVENT_CALENDAR = Object.freeze([
  ['2026-10-14T12:30:00Z', 'US CPI（9 月）'], ['2026-10-15T12:30:00Z', 'US PPI（9 月）'], ['2026-10-28T18:00:00Z', 'FOMC 利率决议（18:30 记者会）'],
  ['2026-11-06T13:30:00Z', '非农就业（10 月）'], ['2026-11-10T13:30:00Z', 'US CPI（10 月）'], ['2026-12-04T13:30:00Z', '非农就业（11 月）'],
  ['2026-12-09T19:00:00Z', 'FOMC 利率决议 + 经济预测（19:30 记者会）'], ['2026-12-10T13:30:00Z', 'US CPI（11 月）'], ['2027-01-13T13:30:00Z', 'US CPI（12 月）'],
].map(([at, name]) => ({ at: Date.parse(at), name })));

export function upcomingEvents(now = Date.now(), count = 3, windowMs = 30 * 60000) {
  const future = EVENT_CALENDAR.filter(e => e.at + windowMs >= now);
  return { events: future.slice(0, count).map(e => ({ ...e, inWindow: Math.abs(e.at - now) <= windowMs })), calendarExhausted: future.length === 0, lastListed: EVENT_CALENDAR.at(-1).at };
}

// 秒级跳动：HL 不提供秒级历史，使用 Binance 现货 1 秒 K 线作为 BTC/ETH 价格跳动的代理。
export function jumpStats(closes) {
  if (!Array.isArray(closes) || closes.length < 11 || closes.some(x => !(x > 0))) return null;
  let max1s = 0, max10s = 0;
  for (let i = 1; i < closes.length; i++) max1s = Math.max(max1s, Math.abs(closes[i] / closes[i - 1] - 1));
  for (let i = 10; i < closes.length; i++) max10s = Math.max(max10s, Math.abs(closes[i] / closes[i - 10] - 1));
  return { max1s, max10s, samples: closes.length };
}

// 文档与官方前端版本：资源文件名变化即页面有更新，提示人工核对上新或规则变化。
export async function readWebVersions({ fetcher = fetch } = {}) {
  const version = async url => {
    const response = await fetcher(url, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const names = [...(await response.text()).matchAll(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/g)].map(m => m[1]);
    if (!names.length) throw new Error('No bundle reference');
    return names.sort().join(',');
  };
  const [docs, app] = await Promise.all([version('https://docs.papertrade.xyz/'), version('https://exchange.papertrade.xyz/trade/btc')]);
  return { at: Date.now(), docs, app };
}
