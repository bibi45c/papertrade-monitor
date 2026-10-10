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
  if (t.schemaVersion !== 1 || !Array.isArray(t.instruments) || !Array.isArray(t.intake) || t.intake.length !== 4 || !Array.isArray(t.intake[3])) throw new Error('Unknown trading schema');
  return { block: integer(t.indexedThroughBlock), paused: bool(t.tradingPaused), minimumMargin: raw(t.minimumTradeSizeRaw), minimumOpenNotional: raw(t.minimumOpenNotionalRaw),
    minimumPaperStake: raw(t.intake[1]), maximumNetOpenInterest: raw(t.intake[2]), blockedActions: t.intake[3],
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

export function parseBbo(hex, scale) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(hex) || !(scale > 0)) throw new Error('Invalid BBO precompile response');
  const bid = Number(BigInt('0x' + hex.slice(2, 66))) / scale, ask = Number(BigInt('0x' + hex.slice(66, 130))) / scale;
  if (!(bid > 0 && ask >= bid)) throw new Error('Invalid BBO prices');
  return { paperBid: bid, paperAsk: ask, paperMid: (bid + ask) / 2 };
}

async function fetchJson(url, body, fetcher) {
  const response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Accept': 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function collect({ fetcher = fetch, now = Date.now() } = {}) {
  const result = { version: 1, collectedAt: now, sources: {}, markets: [], paper: null, balances: null, trading: null, queue: null,
    executionQueue: { available: false, reason: '提交交易等待需要个人 intent 与账户队列，当前只读取公共兑付队列。' }, paperMarketPrice: { value: null, reason: '未核实 PAPER 可交易市场，分红和铸币成本不能替代市场报价。' } };
  const jobs = [
    ['summary', async () => parseSummary(await fetchJson(URLS.paper + '/query/protocol/summary', undefined, fetcher))],
    ['trading', async () => parseTrading(await fetchJson(URLS.paper + '/state/trading', undefined, fetcher))],
    ['queue', async () => parseQueue(await fetchJson(URLS.paper + '/query/protocol/queue-summary', undefined, fetcher))],
    ['paperActivity', async () => {
      const a = await fetchJson(URLS.paper + '/query/protocol/paper/activity', undefined, fetcher);
      if (!Array.isArray(a.items) || !('latestDistribution' in a)) throw new Error('Unknown Paper activity schema');
      const d = a.latestDistribution;
      return { at: Date.now(), distribution: d === null ? null : { at: integer(d.timestampMs), amount: raw(d.amountRaw), block: String(d.blockNumber), txHash: String(d.txHash), logIndex: integer(d.logIndex) } };
    }],
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
  result.trading = values.trading ?? null; result.queue = values.queue ?? null;
  if (result.trading) delete result.trading.raw;
  if (result.queue) delete result.queue.raw;
  const coins = ['BTC', 'ETH', 'HYPE'];
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
    const block = await fetchJson(URLS.rpc, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }, fetcher);
    if (!/^0x[0-9a-f]+$/i.test(block.result?.number ?? '') || !/^0x[0-9a-f]+$/i.test(block.result?.timestamp ?? '')) throw new Error('Missing EVM block');
    const items = result.trading.instruments.filter(i => coins.includes(i.symbol));
    const requests = items.map((i, idx) => ({ jsonrpc: '2.0', id: idx + 1, method: 'eth_call', params: [{ to: BBO, data: '0x' + i.assetIndex.toString(16).padStart(64, '0') }, block.result.number] }));
    let reads;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        reads = await fetchJson(URLS.rpc, requests, fetcher);
        if (!Array.isArray(reads)) throw new Error('Unknown RPC batch');
        for (const read of reads) if (read.error) throw new Error('RPC: ' + String(read.error.message ?? read.error.code).slice(0, 140));
        if (!items.every((i, idx) => reads.some(r => r.id === idx + 1))) throw new Error('Incomplete RPC batch');
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
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
  result.completedAt = Date.now();
  return result;
}
