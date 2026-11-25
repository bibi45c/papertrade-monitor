// 风险与规则变更监控：治理排程、上新与参数变化、宏观事件、秒级跳动。
// 只读公开接口与公开链上日志；不保存钱包地址以外的任何个人数据，合约与多签地址是协议公开配置。
import { readJson, ReadError, checkRpcError } from './read-retry.mjs';

export const GOVERNANCE = Object.freeze({
  timelock: '0xb915fa41e824d6aa31bb833ee81220c0f2c8ea0f',   // Exchange / PAPER / Staking / Tokenomics / ProxyAdmin 的 owner；minDelay 原为 7 天，2026-10-20 的排程 updateMinDelay(86400) 执行后为 1 天（2026-11-19 链上 minDelay() 核对）
  multisig: '0x696292762fd5ac3677a45edbe54eaece4194d1f6',   // timelock 的 owner，同时是 pause guardian
  exchange: '0x6cd5661646289fb6e65ea5c032310fded797d0a2',
  tokenomics: '0x75174549dbbd44497d31a47e2e2d7406408d63d9',
  proxyAdmin: '0xe79c91cc682f1bb401a9cab74c900470190f0f8f',
  marketKeeper: '0x3721476de31190dc1af8908026abe20efe25cf99',
  minDelaySeconds: 86400,
});
// 合约源码未验证；以下事件和函数名由 2026-10-11 的链上交易反推。
const TOPICS = Object.freeze({
  scheduled: '0x78f3bc93d9f0e2beb7fc8fe3192b142c5e70b8813403674aff3f81fc83af5b39',
  batchScheduled: '0x0b9c64b5b18792c995334aa1e837673c5a9cdb8f004ab10fb652f4eecb8d551f',
  operationExecuted: '0x2a08801cf3674ab09756ae78a3a4833813465af6af958136b360eab6b71c8952',
  batchExecuted: '0xaa1510acf32db51981a900a90589bafbf6f442c657a0b916fd3afe22c1474bcd',
  operationCancelled: '0xcf0f63b97f3387253cbc0bde884f975df77e39184dc3280c2c81be495f58eef4',
  minDelayUpdated: '0x25cd0ae91e995bc58ea33869249d0bcf40f2b2c8331ec976c96096bf7d27f464',
  submitted: '0xbe411f0729ceed75',
  executed: '0xd3fb8b9f824d81f0',
  signersSet: '0xddfe9ff988d8830e',
});
const SELECTORS = Object.freeze({
  '12baae3b': 'PaperTokenomics 曲线参数（平坦区阈值、质押者分配上限、平坦铸币率、衰减尺度，按调用参数位置推断）',
  'b0e58bc9': 'timelock.schedule(target, value, data, salt)',
  '79301c0f': '多签签名人配置',
  // 2026-11-19 按公开函数签名库（openchain）与链上调用核对的标准函数名。
  'a9059cbb': 'ERC20 转账 transfer(收款地址, 数量)',
  '095ea7b3': 'ERC20 授权 approve(被授权地址, 数量)',
  '99a88ec4': '合约升级 upgrade(代理合约, 新实现合约)',
  '8a99d586': '修改 timelock 最短延迟 updateMinDelay(秒)',
  '54dc2a02': '批准 Hyperliquid builder approveBuilder(地址)',
  '17938e13': '向 HyperCore 发送动作 sendRawAction(编码动作)',
  'a6cc2c8c': 'timelock 批量执行已到期排程 executeBatch',
  'e38335e5': 'timelock 批量执行已到期排程 executeBatch',
  '8f2a0bb0': 'timelock 批量排程 scheduleBatch',
  '8b07f62b': 'timelock 批量排程 scheduleBatch',
  '134008d3': 'timelock 执行已到期排程 execute',
  '88aa4c12': 'timelock 执行已到期排程 execute',
});
// 地址参数位置（按函数签名）；数量参数按已知代币精度换算，未知代币保留原始整数。
const ADDRESS_ARGS = Object.freeze({ a9059cbb: [0], '095ea7b3': [0], '99a88ec4': [0, 1], '54dc2a02': [0] });
const TOKENS = Object.freeze({ '0xb88339cb7199b77e23db6e890353e22632ba630f': { symbol: 'USDC', decimals: 6 } });
const PLACES = Object.freeze({ '0x3333333333333333333333333333333333333333': 'HyperCore CoreWriter（EVM → Hyperliquid Core）', '0xb88339cb7199b77e23db6e890353e22632ba630f': 'USDC 代币合约' });
const MAX_BATCH_SIZE = 64;
const MAX_CALL_DEPTH = 2;
const fromDecimal = v => { try { return '0x' + BigInt(v).toString(16).padStart(40, '0'); } catch { return v; } };
// 把旧记录里的十进制参数整理成可读形式，保留已保存的原始 args。
export function relabelCall(call) {
  if (!call?.selector) return call;
  const selector = call.selector, label = SELECTORS[selector] ?? call.label, out = { ...call, label };
  if (PLACES[call.target] && (call.where === call.target || !call.where)) out.where = PLACES[call.target];
  if (call.target === GOVERNANCE.timelock) out.where = 'Timelock（最短延迟 1 天）';
  if (Array.isArray(call.args)) {
    const shown = call.args.map((v, i) => ADDRESS_ARGS[selector]?.includes(i) ? fromDecimal(v) : v);
    const token = TOKENS[call.target];
    if (['a9059cbb', '095ea7b3'].includes(selector) && token && shown[1] !== undefined) shown[1] = (Number(BigInt(shown[1])) / 10 ** token.decimals).toLocaleString('en-US', { maximumFractionDigits: token.decimals }) + ' ' + token.symbol;
    out.display = shown;
  }
  if (call.inner) out.inner = relabelCall(call.inner);
  if (Array.isArray(call.batch)) {
    out.batch = call.batch.map(relabelCall);
    out.batchSize = out.batch.length;
  } else if (selector === '8b07f62b' && call.args?.[0] === '128') {
    const size = Number(call.args[4]);
    if (Number.isInteger(size) && size >= 1 && size <= MAX_BATCH_SIZE) out.batchSize = size;
  }
  return out;
}
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

function abiSize(body, position) {
  const encoded = body.slice(position, position + 64);
  if (!/^[\da-f]{64}$/i.test(encoded)) return null;
  const size = Number(big(encoded));
  return Number.isSafeInteger(size) ? size : null;
}

// ABI offsets count bytes, while the slices below count hex characters.
function abiOffset(body, position, minimum) {
  const size = abiSize(body, position);
  if (size === null || size % 32 !== 0 || size > (body.length - 64) / 2) return null;
  const offset = size * 2;
  return offset >= minimum ? offset : null;
}

function abiBytes(body, offset) {
  if (offset === null) return null;
  const size = abiSize(body, offset), start = offset + 64;
  if (size === null || Math.ceil(size / 32) > (body.length - start) / 64) return null;
  return body.slice(start, start + size * 2);
}

function describeBatch(body, depth) {
  const offsets = [0, 64, 128].map(position => abiOffset(body, position, 4 * 64));
  if (offsets.includes(null)) return null;
  const [targets, values, payloads] = offsets;
  const count = abiSize(body, targets);
  if (count === null || count < 1 || count > MAX_BATCH_SIZE || abiSize(body, values) !== count || abiSize(body, payloads) !== count) return null;

  const wordsLength = (count + 1) * 64;
  const sorted = [...offsets, body.length].sort((a, b) => a - b);
  if (sorted.slice(0, 3).some((offset, i) => offset + wordsLength > sorted[i + 1])) return null;
  const bytes = body.slice(payloads + 64, sorted[sorted.indexOf(payloads) + 1]);
  const calls = [];
  for (let i = 0; i < count; i++) {
    const address = word(body, targets / 64 + 1 + i);
    const offset = abiOffset(bytes, i * 64, count * 64), data = abiBytes(bytes, offset);
    if (!/^0{24}[\da-f]{40}$/i.test(address) || data === null) return null;
    calls.push({ target: toAddress(address), offset, data });
  }
  // A batch inside a batch is never expanded: 64 × 64 calls would exceed D1's row limit.
  // Shared or overlapping payloads could multiply the decoded tree written to D1.
  let end = count * 64;
  for (const { offset, data } of [...calls].sort((a, b) => a.offset - b.offset)) {
    if (offset < end) return null;
    end = offset + 64 + Math.ceil(data.length / 64) * 64;
  }
  return calls.map(({ target, data }) => ({ target, ...describeNestedCall(target, data, depth + 1, false) }));
}

export function describeCall(target, data) {
  return describeNestedCall(target, data, 0, true);
}

function describeNestedCall(target, data, depth, includeBatch) {
  const calldata = typeof data === 'string' ? data : '';
  const selector = calldata.length >= 8 ? calldata.slice(0, 8) : '', body = calldata.slice(8);
  const label = SELECTORS[selector] ?? (selector ? `未知函数 0x${selector}` : '空调用');
  const where = target === GOVERNANCE.exchange ? 'Exchange（交易、市场、费率）' : target === GOVERNANCE.tokenomics ? 'PaperTokenomics（铸币与分配曲线）' : target === GOVERNANCE.proxyAdmin ? 'ProxyAdmin（合约升级）' : target === GOVERNANCE.timelock ? 'Timelock（最短延迟 1 天）' : target === GOVERNANCE.multisig ? '多签自身' : target;
  // 多签提交给 timelock 的 schedule：再解一层，提前约半小时看到将要排程的目标与函数。
  if (depth < MAX_CALL_DEPTH && selector === 'b0e58bc9') {
    const address = word(body, 0), innerData = abiBytes(body, abiOffset(body, 2 * 64, 4 * 64));
    if (/^0{24}[\da-f]{40}$/i.test(address) && innerData !== null) {
      const innerTarget = toAddress(address);
      return { selector, label, where, inner: { target: innerTarget, ...describeNestedCall(innerTarget, innerData, depth + 1, includeBatch) } };
    }
  }
  const words = [];
  for (let i = 0; i < (selector === '12baae3b' ? 4 : 6) && i * 64 < body.length; i++) {
    const w = word(body, i);
    if (!/^[\da-f]{64}$/i.test(w)) break; // a truncated word is not a value
    words.push(w);
  }
  const call = { selector, label, where, args: selector === '12baae3b' ? words.map(usd) : words.map(w => big(w).toString()) };
  if (includeBatch && depth < MAX_CALL_DEPTH && selector === '8b07f62b') {
    const batch = describeBatch(body, depth);
    if (batch) call.batch = batch;
  }
  return call;
}

// timelock 排程事件：topics[1]=操作 ID，topics[2]=目标；data = value, offset, salt, readyAt(秒), len, calldata
function timelockData(log, words) {
  if (typeof log.data !== 'string' || !/^0x(?:[\da-f]{64})*$/i.test(log.data)
    || (words !== undefined && log.data.length !== 2 + words * 64)) throw new Error('Malformed timelock event');
  return log.data.slice(2);
}

function timelockCalldata(d, headWords) {
  const start = headWords * 64;
  const data = abiBytes(d, start);
  if (abiSize(d, 64) !== headWords * 32 || data === null || d.length !== start + 64 + Math.ceil(data.length / 64) * 64) {
    throw new Error('Malformed timelock event');
  }
  return data;
}

function timelockOperationId(log) {
  const id = log.topics[1];
  if (typeof id !== 'string' || !/^0x[\da-f]{64}$/i.test(id)) throw new Error('Malformed timelock event');
  return id;
}

function scheduleFields(log, seconds) {
  const readyAt = seconds * 1000;
  if (!Number.isSafeInteger(readyAt)) throw new Error('Malformed timelock event');
  return { id: timelockOperationId(log), ...(log.logIndex == null ? {} : { scheduledLogIndex: Number(BigInt(log.logIndex)) }),
    readyAt, scheduledBlock: Number(BigInt(log.blockNumber)), scheduledTx: log.transactionHash };
}

export function decodeScheduled(log) {
  const d = timelockData(log), calldata = timelockCalldata(d, 4);
  const target = toAddress(log.topics[2].slice(2));
  return { ...scheduleFields(log, abiSize(d, 3 * 64) ?? NaN), target, ...describeNestedCall(target, calldata, 0, false) };
}

export function decodeLog(log) {
  const t0 = log.topics[0], address = log.address.toLowerCase();
  let kind;
  if (address === GOVERNANCE.timelock) {
    if (t0 === TOPICS.scheduled) return { kind: 'scheduled', ...decodeScheduled(log) };
    if (t0 === TOPICS.batchScheduled) {
      const d = timelockData(log, 3), batchSize = abiSize(d, 0), target = GOVERNANCE.timelock;
      if (batchSize === null || batchSize < 1) throw new Error('Malformed timelock event');
      const { selector, label, where } = describeCall(target, '8b07f62b');
      return { kind: 'batchScheduled', ...scheduleFields(log, abiSize(d, 2 * 64) ?? NaN), batchSize,
        salt: '0x' + word(d, 1).toLowerCase(), target, selector, label, where };
    }
    if (t0 === TOPICS.operationExecuted || t0 === TOPICS.batchExecuted) {
      timelockOperationId(log);
      if (t0 === TOPICS.batchExecuted) timelockData(log, 1);
      else timelockCalldata(timelockData(log), 2);
      kind = 'operationExecuted';
    }
    if (t0 === TOPICS.operationCancelled) {
      timelockOperationId(log);
      timelockData(log, 0);
      kind = 'operationCancelled';
    }
    if (t0 === TOPICS.minDelayUpdated) timelockData(log, 1);
  }
  kind ??= t0.startsWith(TOPICS.submitted) ? 'multisigSubmitted' : t0.startsWith(TOPICS.executed) ? 'multisigExecuted' : t0.startsWith(TOPICS.signersSet) ? 'signersSet' : 'unknown';
  let call = null;
  if (kind === 'multisigSubmitted' || kind === 'multisigExecuted') {
    const target = log.topics[3] ? toAddress(log.topics[3].slice(2)) : null, d = log.data.slice(2);
    const data = /^(?:[\da-f]{64})+$/i.test(d) ? abiBytes(d, abiOffset(d, 64, 2 * 64)) : null;
    // The contract encodes this outer layer, so damage means a bad RPC response: throw and leave the range pending.
    // Anything wrong inside the submitted calldata is user input and only degrades the description.
    if (data === null) throw new Error('Malformed multisig event');
    if (target && data.length >= 8) call = { target, ...describeCall(target, data) };
  }
  return { kind, address, topic0: t0, topic1: log.topics[1] ?? null, block: Number(BigInt(log.blockNumber)), ...(log.logIndex == null ? {} : { logIndex: Number(BigInt(log.logIndex)) }), tx: log.transactionHash, call };
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

// The official RPC rate-limits getLogs to ~1,000-block ranges, so historical gaps never caught up. Gap healing first
// tries a public archive RPC with 50,000-block ranges (verified 2026-11-19 against the official node), then falls back.
export const GAP_RPC = 'https://rpc.hyperlend.finance/archive';
export const BATCH_BACKFILL_RANGES = Object.freeze([
  [49080037, 49080037], [49169385, 49169385], [49407792, 49407812], [49505121, 49505138],
  [49613797, 49613899], [49758751, 49758789], [49876315, 49876315], [50507327, 50507327],
  [50819178, 50819341], [50936253, 50936265], [51086922, 51086922], [51291026, 51291026],
  [51610328, 51610328], [52099293, Number.MAX_SAFE_INTEGER],
].map(Object.freeze));

const ENDINGS = [TOPICS.operationExecuted, TOPICS.batchExecuted, TOPICS.operationCancelled];
const isSchedule = e => e.kind === 'scheduled' || e.kind === 'batchScheduled';
const eventKey = e => e.tx + ':' + e.topic0 + ':' + e.topic1;
const before = (block, index, otherBlock, otherIndex) => block < otherBlock || (block === otherBlock && index < otherIndex);
const newest = (block, index, otherBlock, otherIndex) => otherBlock - block || (otherIndex ?? -1) - (index ?? -1);

function pairBatchDetails(schedules, events) {
  const byTx = new Map(), paired = new Map();
  for (const e of events) {
    if (e.kind !== 'multisigExecuted' || e.address !== GOVERNANCE.multisig || !e.tx) continue;
    if (!byTx.has(e.tx)) byTx.set(e.tx, { executions: [], batches: [] });
    byTx.get(e.tx).executions.push(e);
  }
  for (const e of schedules) {
    if (e.kind === 'batchScheduled' && e.batchSize <= MAX_BATCH_SIZE) byTx.get(e.scheduledTx)?.batches.push(e);
  }
  const matchesCall = (e, call) => call?.target === GOVERNANCE.timelock && call.selector === e.selector
    && call.batch?.length === e.batchSize && /^0x[\da-f]{64}$/i.test(e.salt) && call.args?.[3] === BigInt(e.salt).toString();
  const canFollow = (e, x) => e.scheduledBlock === x.block
    && (x.logIndex == null || e.scheduledLogIndex == null || x.logIndex > e.scheduledLogIndex);
  for (const { executions, batches } of byTx.values()) {
    const used = new Set();
    // If two schedules precede the same execution, give the closer schedule the first chance to match.
    batches.sort((a, b) => (b.scheduledLogIndex ?? -1) - (a.scheduledLogIndex ?? -1));
    executions.sort((a, b) => (a.logIndex ?? -1) - (b.logIndex ?? -1));
    for (const e of batches) {
      const candidates = executions.filter(x => canFollow(e, x));
      if (candidates.length > 1 && (e.scheduledLogIndex == null || candidates.some(x => x.logIndex == null))) continue;
      const match = candidates[0], call = match?.call;
      if (used.has(match) || !matchesCall(e, call)) continue;
      if (batches.some(other => other !== e && canFollow(other, match)
        && (match.logIndex == null || other.scheduledLogIndex == null || e.scheduledLogIndex == null)
        && matchesCall(other, call))) continue;
      used.add(match);
      paired.set(e, call.batch);
    }
  }
  return paired;
}

function limitGovernanceDetails(operations, recentEvents) {
  const encoder = new TextEncoder();
  let remaining = 300000;
  const entries = [
    ...operations.map(o => ({ record: o, pending: o.resolvedBlock == null, block: o.scheduledBlock, index: o.scheduledLogIndex })),
    ...recentEvents.map(e => ({ record: e, pending: false, block: e.block, index: e.logIndex })),
  ].sort((a, b) => Number(b.pending) - Number(a.pending) || newest(a.block, a.index, b.block, b.index));
  function limit(call) {
    if (!call?.batch && !call?.inner) return call;
    const { batch, inner, ...fields } = call;
    if (Array.isArray(batch)) {
      const bytes = encoder.encode(JSON.stringify(batch)).length + ',"batch":'.length;
      fields.batchSize ??= batch.length;
      if (bytes <= remaining) {
        fields.batch = batch;
        remaining -= bytes;
      }
    }
    if (inner) fields.inner = limit(inner);
    return fields;
  }
  const bounded = new Map(entries.map(({ record }) => [record, record.call
    ? { ...record, call: limit(record.call) } : limit(record)]));
  return { operations: operations.map(o => bounded.get(o)), recentEvents: recentEvents.map(e => bounded.get(e)) };
}

// One recent chunk, then oldest pending chunks. Successful ranges alone are removed.
export async function scanGovernance({ fetcher = fetch, previous = null, maxChunks = 3, archiveUrl = GAP_RPC, gapChunkBlocks = 50000, maxGapChunks = 8 } = {}) {
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 10) throw new RangeError('Invalid governance chunk budget');
  const client = url => (method, params) => readJson(url, { jsonrpc: '2.0', id: 1, method, params }, fetcher, { validate: v => { checkRpcError(v); if (!('result' in v)) throw new ReadError('Missing RPC result', true); return v.result; } });
  const rpc = client('https://rpc.hyperliquid.xyz/evm'), archive = archiveUrl ? client(archiveUrl) : null;
  // The official node rate-limits even eth_blockNumber at times; the archive node answers the head instead.
  const head = Number(BigInt(await rpc('eth_blockNumber', []).catch(error => archive ? archive('eth_blockNumber', []) : Promise.reject(error))));
  const last = Number.isSafeInteger(previous?.lastScannedBlock) ? previous.lastScannedBlock : Math.max(0, head - 300);
  if (head < last) throw new Error('Governance head moved behind cursor');
  const from = Math.max(last + 1, head - 999, 0), events = [], readErrors = [];
  const backfill = Number.isSafeInteger(previous?.lastScannedBlock) && !previous.batchBackfill
    ? BATCH_BACKFILL_RANGES.map(([start, end]) => [start, Math.min(end, last)]) : [];
  let gaps = mergeBlockRanges([...(previous?.gaps ?? []), ...backfill, ...(from > last + 1 ? [[last + 1, from - 1]] : [])]);
  const read = async (start, end, via = rpc, quiet = false) => {
    try {
      const result = await via('eth_getLogs', [{ address: [GOVERNANCE.timelock, GOVERNANCE.multisig], fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }]);
      if (!Array.isArray(result)) throw new Error('Invalid governance log response');
      // Decode before marking a range covered: malformed logs must remain recoverable.
      events.push(...result.map(decodeLog)); gaps = subtractRange(gaps, start, end); return true;
    } catch (error) {
      gaps = mergeBlockRanges([...gaps, [start, end]]);
      if (!quiet) readErrors.push({ from: start, through: end, error: String(error.message ?? error).slice(0, 180) });
      return false;
    }
  };
  let used = 0;
  if (from <= head) { await read(from, head); used++; }
  // Large archive reads for the oldest gaps; a failed archive read leaves the gap for the official fallback below.
  let healed = 0;
  while (archive && healed < maxGapChunks && gaps.length) {
    const [start, lastBlock] = gaps[0], end = Math.min(lastBlock, start + gapChunkBlocks - 1);
    if (!await read(start, end, archive, true)) break;
    healed++;
  }
  while (used < maxChunks && (!archive || !maxGapChunks || healed < maxGapChunks) && gaps.length) {
    const [start, lastBlock] = gaps[0], end = Math.min(lastBlock, start + 999);
    used++;
    if (!await read(start, end)) break;
    healed++;
  }
  const ops = new Map((previous?.operations ?? KNOWN_OPERATIONS).map(o => [o.id, o]));
  const schedules = events.filter(isSchedule);
  const scheduleKey = o => o.scheduledTx + ':' + o.id;
  const scannedSchedules = new Set(schedules.map(scheduleKey));
  const savedBatches = [...ops.values()].filter(o => o.kind === 'batchScheduled' && !scannedSchedules.has(scheduleKey(o)));
  const details = pairBatchDetails([...schedules, ...savedBatches], events);
  for (const o of savedBatches) {
    if (details.has(o)) ops.set(o.id, { ...o, batch: details.get(o) });
  }
  // Schedules first, then endings; within one block the log index decides (older stored records have none).
  for (const e of schedules) {
    const old = ops.get(e.id);
    if (before(e.scheduledBlock, e.scheduledLogIndex, old?.scheduledBlock, old?.scheduledLogIndex)) continue;
    const op = { ...old, ...e };
    const sameSchedule = e.scheduledBlock === old?.scheduledBlock && e.scheduledTx === old.scheduledTx
      && (e.scheduledLogIndex == null || old.scheduledLogIndex == null || e.scheduledLogIndex === old.scheduledLogIndex);
    if (!sameSchedule && e.scheduledLogIndex === undefined) delete op.scheduledLogIndex;
    if (!sameSchedule || e.kind !== 'batchScheduled') {
      delete op.batch;
      if (e.kind !== 'batchScheduled') { delete op.batchSize; delete op.salt; }
    }
    if (details.has(e)) op.batch = details.get(e);
    if (before(op.resolvedBlock, op.resolvedLogIndex, op.scheduledBlock, op.scheduledLogIndex)) {
      for (const field of ['resolvedBlock', 'resolvedLogIndex', 'resolvedTopic', 'outcome']) delete op[field];
    }
    ops.set(e.id, op);
  }
  const orphans = new Map();
  const savedEndings = (previous?.orphanEndings ?? []).map(({ id, topic0, block, logIndex }) => ({
    topic1: id, topic0, block, logIndex, address: GOVERNANCE.timelock,
    kind: topic0 === TOPICS.operationCancelled ? 'operationCancelled' : 'operationExecuted',
  }));
  for (const e of [...savedEndings, ...events]) {
    if (e.address !== GOVERNANCE.timelock || !e.topic1 || e.topic0 === TOPICS.minDelayUpdated
      || !['operationExecuted', 'operationCancelled', 'unknown'].includes(e.kind)) continue;
    const old = ops.get(e.topic1);
    if (!old) {
      if (gaps.length && ENDINGS.includes(e.topic0)) {
        const { topic1: id, block, logIndex, topic0 } = e;
        orphans.set([id, block, logIndex, topic0].join(':'), { id, block, ...(logIndex == null ? {} : { logIndex }), topic0 });
      }
      continue;
    }
    if (before(e.block, e.logIndex, old.scheduledBlock, old.scheduledLogIndex)) continue;
    // In one block a known ending beats an unrecognised event whatever their order; otherwise the later event wins.
    const sameBlock = e.block === old.resolvedBlock, oldKnown = ENDINGS.includes(old.resolvedTopic);
    if (sameBlock && e.kind === 'unknown' && oldKnown) continue;
    const upgrades = sameBlock && e.kind !== 'unknown' && !oldKnown;
    if (!upgrades && before(e.block, e.logIndex, old.resolvedBlock, old.resolvedLogIndex)) continue;
    const op = { ...old, resolvedBlock: e.block, resolvedTopic: e.topic0 };
    if (e.logIndex === undefined) delete op.resolvedLogIndex; else op.resolvedLogIndex = e.logIndex;
    if (e.kind === 'unknown') delete op.outcome;
    else op.outcome = e.kind === 'operationExecuted' ? 'executed' : 'cancelled';
    ops.set(e.topic1, op);
  }
  const completed = [...ops.values()].filter(o => o.resolvedBlock != null)
    .sort((a, b) => newest(a.resolvedBlock, a.resolvedLogIndex, b.resolvedBlock, b.resolvedLogIndex)
      || newest(a.scheduledBlock, a.scheduledLogIndex, b.scheduledBlock, b.scheduledLogIndex) || a.id.localeCompare(b.id));
  for (const o of completed.slice(200)) ops.delete(o.id);
  const operations = [...ops.values()].sort((a, b) => newest(b.scheduledBlock, b.scheduledLogIndex, a.scheduledBlock, a.scheduledLogIndex));
  const recent = [...new Map([...(previous?.recentEvents ?? []), ...events.filter(e => !isSchedule(e))].map(e => [eventKey(e), e])).values()]
    .filter(e => !isSchedule(e) && !((e.address == null || e.address === GOVERNANCE.timelock) && e.topic0 === TOPICS.batchScheduled))
    .sort((a, b) => b.block - a.block || (a.logIndex ?? -1) - (b.logIndex ?? -1)).slice(0, 20);
  const orphanEndings = [...orphans.values()].sort((a, b) => newest(a.block, a.logIndex, b.block, b.logIndex)
    || a.id.localeCompare(b.id) || a.topic0.localeCompare(b.topic0)).slice(0, 100);
  return { at: Date.now(), block: '0x' + head.toString(16), lastScannedBlock: head, scannedFrom: from,
    ...limitGovernanceDetails(operations, recent), orphanEndings, batchBackfill: 1,
    gaps, readErrors, coverageComplete: gaps.length === 0 && readErrors.length === 0 };
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
