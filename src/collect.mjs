import { readExecutionQueue } from './execution-queue.mjs';
import { readJson, ReadError, checkRpcError } from './read-retry.mjs';
import { scanGovernance, readWebVersions, upcomingEvents, instrumentChanges } from './watch.mjs';
import { lpDrainRisk } from './model.mjs';
export const URLS = Object.freeze({ paper: 'https://exchange.papertrade.xyz', info: 'https://api.hyperliquid.xyz/info', rpc: 'https://rpc.hyperliquid.xyz/evm' });
const BBO = '0x000000000000000000000000000000000000080e';
const raw = value => { if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new Error('Invalid raw amount'); return Number(BigInt(value)) / 1e18; };
const finite = value => { if (value === null || value === undefined || value === '') throw new Error('Missing numeric field'); const n = Number(value); if (!Number.isFinite(n)) throw new Error('Invalid numeric field'); return n; };
const integer = value => { const n = finite(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid integer field'); return n; };
const bool = value => { if (typeof value !== 'boolean') throw new Error('Invalid boolean field'); return value; };

export function parseSummary(s) {
  if (s.ok !== true || !s.source || !s.paper || !s.balances || !s.fees) throw new Error('Unknown summary schema');
  const p = s.paper, b = s.balances;
  return { sourceAt: integer(s.source.at), block: String(s.source.block),
    balances: Object.fromEntries(['tvl', 'margin', 'lp', 'reserve', 'queue'].map(k => [k, raw(b[k])])),
    paper: Object.fromEntries(['supply', 'staked', 'trackedLp', 'accumulator', 'reserve', 'unallocated', 'pendingRewards', 'cliff', 'cap', 'excess', 'rate', 'decay', 'tailProgress'].map(k => [k, p[k] === undefined && k === 'excess' ? null : raw(p[k])])),
    fees: { pending: raw(s.fees.pending), lifetime: raw(s.fees.lifetime) },
    activity: { volume: raw(s.activity.volume), open: integer(s.activity.open) }, raw: s,
  };
}

export function parseTrading(t) {
  if (t.schemaVersion !== 1 || !Array.isArray(t.instruments)) throw new Error('Unknown trading schema');
  const legacy = Object.hasOwn(t, 'intake'), current = Object.hasOwn(t, 'intakeControls');
  if (legacy === current) throw new Error('Unknown trading schema');
  const intake = legacy ? t.intake : t.intakeControls;
  const blockedActions = intake?.[legacy ? 3 : 2];
  if (!Array.isArray(intake) || intake.length !== (legacy ? 4 : 3) || !Array.isArray(blockedActions) || blockedActions.some(action => typeof action !== 'string')) throw new Error('Unknown trading schema');
  // intakeControls omits the global net OI limit; never reuse a historical limit.
  return { block: integer(t.indexedThroughBlock), paused: bool(t.tradingPaused), minimumMargin: raw(t.minimumTradeSizeRaw), minimumOpenNotional: raw(t.minimumOpenNotionalRaw),
    minimumPaperStake: raw(intake[1]), maximumNetOpenInterest: legacy ? raw(intake[2]) : null, blockedActions,
    instruments: t.instruments.map(i => {
      if (!Array.isArray(i) || i.length !== 23 || typeof i[1] !== 'string') throw new Error('Unknown instrument tuple');
      return { id: integer(i[0]), symbol: i[1], assetIndex: integer(i[2]), priceScale: finite(i[3]), active: bool(i[4]), paused: bool(i[5]), terminal: bool(i[6]), openable: i[4] && !i[5],
        rateMultiplier: raw(i[12]), positionMultiplier: raw(i[13]), maxLeverage: integer(i[14]), maxPositionNotional: raw(i[15]), bustBuffer: raw(i[16]), baseRate: raw(i[17]), referenceNotional: raw(i[18]), longOi: raw(i[19]), shortOi: raw(i[20]), longCap: raw(i[21]), shortCap: raw(i[22]),
      };
    }), raw: t,
  };
}

export function parseQueue(q) {
  if (q.ok !== true || !q.source) throw new Error('Unknown queue schema');
  return { sourceAt: integer(q.source.at), block: String(q.source.block), total: raw(q.total), count: integer(q.count), largest: q.largest, front: q.front, raw: q };
}

// 官方小时历史：paperRevenue 为单小时值，traderPnl/liquidation/paperSupply/paperStaked/trades 为累计或时点值。
export function parseProtocolHistory(h, keep = 49) {
  const names = ['paperRevenue', 'traderPnl', 'liquidation', 'paperSupply', 'paperStaked', 'trades'];
  if (!Number.isSafeInteger(h?.startMs) || h.intervalMs !== 3600000 || !h.columns || !h.source) throw new Error('Unknown protocol history schema');
  const length = h.columns.paperSupply?.length;
  if (!Number.isSafeInteger(length) || names.some(k => !Array.isArray(h.columns[k]) || h.columns[k].length !== length)) throw new Error('Incomplete protocol history columns');
  const asOf = integer(h.source.asOfMs), hours = [];
  for (let i = 1; i < length; i++) {
    const v = Object.fromEntries(names.map(k => [k, finite(h.columns[k][i])])), prev = Object.fromEntries(names.map(k => [k, finite(h.columns[k][i - 1])]));
    if (v.paperSupply <= 0) continue;
    const startMs = h.startMs + i * h.intervalMs, minted = v.paperSupply - prev.paperSupply, stakedAvg = (v.paperStaked + prev.paperStaked) / 2;
    hours.push({ startMs, partial: startMs + h.intervalMs > asOf, revenue: v.paperRevenue, minted, paperSupply: v.paperSupply, paperStaked: v.paperStaked, traderPnl: v.traderPnl - prev.traderPnl, liquidationNotional: v.liquidation - prev.liquidation, trades: v.trades - prev.trades,
      revenuePerNewPaper: minted > 0 ? v.paperRevenue / minted : null, revenuePerPaperHour: stakedAvg > 0 ? v.paperRevenue / stakedAvg : null });
  }
  return { sourceAt: asOf, revision: String(h.source.revision ?? ''), hours: hours.slice(-keep) };
}

export function parseBbo(hex, scale) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(hex) || !(scale > 0)) throw new Error('Invalid BBO precompile response');
  const bid = Number(BigInt('0x' + hex.slice(2, 66))) / scale, ask = Number(BigInt('0x' + hex.slice(66, 130))) / scale;
  if (!(bid > 0 && ask >= bid)) throw new Error('Invalid BBO prices');
  return { paperBid: bid, paperAsk: ask, paperMid: (bid + ask) / 2 };
}

const fetchJson = readJson;

// PaperTokenomics 直接读链（合约未验证；函数名来自公开签名库 openchain。0xc16017ca 无公开名，
// 按 2026-10-11 排程 12baae3b 的参数位置与当前数值核对为质押者分配上限，即“超额分配阈值”）。
export const TOKENOMICS = Object.freeze({ address: '0x75174549dbbd44497d31a47e2e2d7406408d63d9',
  reads: { cap: '0xc16017ca', cliff: '0xe9ed73e9', flatRate: '0x1c3972ba', decay: '0xcbb451da' } });
// Trader book from the official leaderboard: every account with open positions, sorted by open notional.
// The per-account currentUnrealizedPnl summed over all open accounts is the LP's mark-to-market liability.
// Coverage is checked against the endpoint's own trackedOpenNotional; an incomplete sum is an error, never a partial value.
export async function readTraderBook({ fetcher = fetch, pageSize = 100, maxPages = 30 } = {}) {
  const n = v => Number(BigInt(v)) / 1e18, accounts = [];
  let tracked = null;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams([['page', String(page)], ['pageSize', String(pageSize)], ['sortDir', 'desc'], ['sortKey', 'currentOpenNotional'], ['window', 'all']]);
    const j = await fetchJson(URLS.paper + '/state/leaderboard/accounts?' + qs, undefined, fetcher);
    if (j?.ok !== true || !Array.isArray(j.accounts) || !j.summary) throw new Error('Unknown leaderboard schema');
    tracked = j.summary.trackedOpenNotional;
    for (const a of j.accounts) if (!accounts.some(b => b.address === a.address)) accounts.push(a); // pages are read moments apart; drop repeats
    if (!j.accounts.length || j.accounts.some(a => BigInt(a.currentOpenNotional) === 0n) || page + 1 >= j.pageInfo?.totalPages) break;
  }
  const open = accounts.filter(a => BigInt(a.currentOpenNotional) > 0n);
  const openNotional = open.reduce((s, a) => s + BigInt(a.currentOpenNotional), 0n);
  // Pages are separate reads of a live book, so allow 0.5% drift against the endpoint's own total; beyond that the sum is rejected.
  const coverage = tracked === null || BigInt(tracked) === 0n ? null : n(openNotional) / n(tracked);
  if (coverage === null || Math.abs(coverage - 1) > 0.005) throw new Error('Leaderboard open notional does not match tracked total');
  const upnl = open.map(a => n(a.currentUnrealizedPnl));
  return { at: Date.now(), accounts: open.length, openNotional: n(openNotional), coverage, unrealizedPnl: upnl.reduce((s, v) => s + v, 0),
    winners: upnl.filter(v => v > 0).reduce((s, v) => s + v, 0), losers: upnl.filter(v => v < 0).reduce((s, v) => s + v, 0),
    largest: open.map(a => ({ address: a.address, unrealizedPnl: n(a.currentUnrealizedPnl), openNotional: n(a.currentOpenNotional) })).sort((a, b) => b.unrealizedPnl - a.unrealizedPnl).slice(0, 5) };
}

export async function readTokenomics({ fetcher = fetch } = {}) {
  const keys = Object.keys(TOKENOMICS.reads);
  const requests = [{ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] },
    ...keys.map((k, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{ to: TOKENOMICS.address, data: TOKENOMICS.reads[k] }, 'latest'] }))];
  const reads = await fetchJson(URLS.rpc, requests, fetcher, { validate: value => {
    if (!Array.isArray(value)) { checkRpcError(value); throw new Error('Unknown RPC batch'); }
    for (const read of value) checkRpcError(read);
    if (!requests.every(r => value.some(v => v.id === r.id && /^0x[0-9a-f]+$/i.test(v.result ?? '')))) throw new ReadError('Incomplete RPC batch', true);
    return value;
  } });
  const word = id => BigInt(reads.find(r => r.id === id).result.slice(0, 66));
  const out = { at: Date.now(), block: String(Number(word(0))), address: TOKENOMICS.address, raw: {} };
  keys.forEach((k, i) => { const v = word(i + 1); out.raw[k] = v.toString(); out[k] = Number(v) / 1e18; });
  return out;
}

export async function collect({ fetcher = fetch, now = Date.now(), pressureReader = () => readExecutionQueue({ fetcher }), previous = null, checkWeb = false, scanGov = false, auxiliary = true, deriveRisk = true } = {}) {
  const result = { version: 1, collectedAt: now, sources: {}, markets: [], paper: null, balances: null, trading: null, queue: null,
    executionQueue: { available: false, reason: '全球执行队列尚未收到有效状态；个人排名未查询。' }, paperMarketPrice: { value: null, reason: '启动期 PAPER 不可转让；未核实可交易市场，分红和铸币成本不能替代市场报价。' } };
  const jobs = [
    ['executionQueue', pressureReader],
    ['summary', async () => parseSummary(await fetchJson(URLS.paper + '/query/protocol/summary', undefined, fetcher))],
    ['trading', async () => parseTrading(await fetchJson(URLS.paper + '/state/trading', undefined, fetcher))],
    ['queue', async () => parseQueue(await fetchJson(URLS.paper + '/query/protocol/queue-summary', undefined, fetcher))],
    ['paperActivity', async () => {
      const a = await fetchJson(URLS.paper + '/query/protocol/paper/activity', undefined, fetcher);
      if (!Array.isArray(a.items) || !('latestDistribution' in a)) throw new Error('Unknown Paper activity schema');
      const d = a.latestDistribution;
      return { at: Date.now(), distribution: d === null ? null : { at: integer(d.timestampMs), amount: raw(d.amountRaw), block: String(d.blockNumber), txHash: String(d.txHash), logIndex: integer(d.logIndex) } };
    }],
    ...(auxiliary ? [['protocolHistory', async () => parseProtocolHistory(await fetchJson(URLS.paper + '/query/protocol/history?interval=1h', undefined, fetcher))]] : []),
    ...(auxiliary && scanGov ? [['governance', () => scanGovernance({ fetcher, previous: previous?.governance ?? null })]] : []),
    ...(auxiliary && checkWeb ? [['web', () => readWebVersions({ fetcher })]] : []),
    ['tokenomics', () => readTokenomics({ fetcher })],
    ['traderBook', () => readTraderBook({ fetcher })],
    ['context', async () => {
      const context = await fetchJson(URLS.info, { type: 'metaAndAssetCtxs' }, fetcher);
      if (!Array.isArray(context) || !Array.isArray(context[0]?.universe) || !Array.isArray(context[1])) throw new Error('Unknown HL context schema');
      return { at: Date.now(), data: context };
    }],
  ];
  const settled = await Promise.allSettled(jobs.map(async ([name, job]) => [name, await job()]));
  const values = {};
  settled.forEach((s, i) => {
    const name = jobs[i][0];
    if (s.status === 'fulfilled') { values[name] = s.value[1]; result.sources[name] = { ok: true, at: s.value[1].sourceAt ?? s.value[1].at ?? now, block: s.value[1].block ?? null }; }
    else result.sources[name] = { ok: false, at: null, error: String(s.reason?.message ?? 'Request failed').slice(0, 180) };
  });
  if (values.summary) Object.assign(result, { paper: values.summary.paper, balances: values.summary.balances, fees: values.summary.fees, activity: values.summary.activity, paperSourceAt: values.summary.sourceAt, rawSummary: values.summary.raw });
  result.rewardAccumulatorRaw = values.summary?.raw.paper.accumulator ?? null;
  result.rewardIndex = result.rewardAccumulatorRaw === null ? null : Number(BigInt(result.rewardAccumulatorRaw)) / 1e27;
  result.latestDistribution = values.paperActivity?.distribution ?? null;
  result.protocolHours = values.protocolHistory?.hours ?? (!auxiliary ? previous?.protocolHours?.slice(-8) ?? null : null);
  result.jumps = null;
  result.sources.jumps = { ok: false, at: null, disabled: true, reason: '已停用 Binance 秒级数据采集' };
  // 治理扫描失败时沿用上一条记录的游标和已知操作，并标记为过期；不当作“没有新排程”。
  result.governance = values.governance ?? (previous?.governance ? { ...previous.governance, stale: auxiliary ? true : previous.governance.stale ?? false } : null);
  // 分钟行只留治理摘要：完整的 recentEvents/gaps 在 auxiliary_state，读取时由 attachAuxiliary 补回。
  // 每分钟重复整份治理扫描会让单行翻倍，D1 免费版 500MB 会在约两周内写满（2026-10-27 已发生）。
  if (!auxiliary && result.governance) { const { recentEvents, gaps, ...summary } = result.governance; result.governance = summary; }
  if (!auxiliary) for (const key of ['protocolHistory', 'governance', 'web']) {
    if (previous?.sources?.[key]) result.sources[key] = { ...previous.sources[key], retained: true };
  }
  const priorWeb = previous?.web ?? null;
  if (values.web) {
    const changed = !!priorWeb && (priorWeb.docs !== values.web.docs || priorWeb.app !== values.web.app);
    result.web = { ...values.web, changedAt: changed ? values.web.at : priorWeb?.changedAt ?? null, previous: changed ? { docs: priorWeb.docs, app: priorWeb.app, at: priorWeb.at } : priorWeb?.previous ?? null };
  } else result.web = priorWeb;
  result.events = upcomingEvents(now);
  result.trading = values.trading ?? null; result.queue = values.queue ?? null; result.tokenomics = values.tokenomics ?? null; result.traderBook = values.traderBook ?? null;
  result.executionQueue = values.executionQueue ?? { available: false, reason: result.sources.executionQueue.error };
  if (result.trading) delete result.trading.raw;
  if (result.queue) delete result.queue.raw;
  const coins = ['BTC', 'ETH'];
  if (values.context) {
    const [meta, ctxs] = values.context.data;
    result.markets = coins.map(coin => {
      const idx = meta.universe.findIndex(m => m.name === coin); if (idx < 0) return { coin, error: 'Market not present' };
      const m = meta.universe[idx], c = ctxs[idx];
      try { return { coin, szDecimals: integer(m.szDecimals), maxLeverage: integer(m.maxLeverage), marginTable: meta.marginTables?.find(t => t[0] === m.marginTableId)?.[1] ?? null, mid: finite(c.midPx), mark: finite(c.markPx), oracle: finite(c.oraclePx), funding: finite(c.funding), openInterest: finite(c.openInterest), volume24h: finite(c.dayNtlVlm), contextAt: values.context.at }; }
      catch (error) { return { coin, error: error.message }; }
    });
  } else result.markets = coins.map(coin => ({ coin }));
  const bookJobs = coins.map(async coin => {
    const book = await fetchJson(URLS.info, { type: 'l2Book', coin }, fetcher);
    if (!Array.isArray(book.levels) || book.levels.length !== 2 || book.levels.some(x => !Array.isArray(x))) throw new Error('Unknown order book schema');
    const [bids, asks] = book.levels;
    if (!bids.length || !asks.length) throw new Error('Empty order book');
    for (const level of [...bids, ...asks]) if (!(finite(level.px) > 0 && finite(level.sz) >= 0)) throw new Error('Invalid depth');
    return { coin, bookAt: integer(book.time), bids, asks, bid: finite(bids[0].px), ask: finite(asks[0].px) };
  });
  const priceJob = (async () => {
    if (!result.trading) throw new Error('No Paper instrument parameters');
    const deadline = Date.now() + 10000;
    const block = await fetchJson(URLS.rpc, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }, fetcher, {
      deadline, validate: value => {
        checkRpcError(value);
        if (!/^0x[0-9a-f]+$/i.test(value.result?.number ?? '') || !/^0x[0-9a-f]+$/i.test(value.result?.timestamp ?? '')) throw new ReadError('Missing EVM block', true);
        return value;
      },
    });
    const items = result.trading.instruments.filter(i => coins.includes(i.symbol));
    const requests = items.map((i, idx) => ({ jsonrpc: '2.0', id: idx + 1, method: 'eth_call', params: [{ to: BBO, data: '0x' + i.assetIndex.toString(16).padStart(64, '0') }, block.result.number] }));
    const reads = await fetchJson(URLS.rpc, requests, fetcher, {
      deadline, validate: value => {
        if (!Array.isArray(value)) { checkRpcError(value); throw new Error('Unknown RPC batch'); }
        for (const read of value) checkRpcError(read);
        if (!items.every((i, idx) => value.some(r => r.id === idx + 1))) throw new ReadError('Incomplete RPC batch', true);
        return value;
      },
    });
    const at = Number(BigInt(block.result.timestamp)) * 1000;
    return { block: block.result.number, at, markets: items.map((i, idx) => ({ coin: i.symbol, ...parseBbo(reads.find(x => x.id === idx + 1)?.result, i.priceScale), paperAt: at, paperBlock: block.result.number })) };
  })();
  const prices = await Promise.allSettled([...bookJobs, priceJob]);
  prices.forEach((s, idx) => {
    const key = idx < coins.length ? `book_${coins[idx]}` : 'paperBbo';
    if (s.status === 'fulfilled') {
      const value = s.value;
      result.sources[key] = { ok: true, at: value.bookAt ?? value.at, block: value.block ?? null };
      for (const m of value.markets ?? [value]) Object.assign(result.markets.find(x => x.coin === m.coin), m);
    } else result.sources[key] = { ok: false, at: null, error: String(s.reason?.message ?? 'Request failed').slice(0, 180) };
  });
  result.listing = instrumentChanges(result.trading);
  result.lpRisk = deriveRisk ? lpDrainRisk(result) : null;
  if (!deriveRisk) result.lpRiskDeferred = true;
  result.completedAt = Date.now();
  return result;
}
