export const DEFAULTS = Object.freeze({
  margin: 1000, paperLeverage: 20, hedgeLeverage: 10, lossBudget: 100,
  takerFeeBps: 4.5, exitSlippageBps: 1, holdingHours: 1, paperLong: true,
});

const positive = x => Number.isFinite(x) && x > 0;
export function executionQueueStatus(snapshot, now = Date.now()) {
  const q = snapshot?.executionQueue, source = snapshot?.sources?.executionQueue;
  const fresh = !!q?.available && source?.ok === true && Number.isFinite(q.sourceAt) && now - q.sourceAt <= 15000 && q.sourceAt <= now + 5000;
  if (!fresh) return { fresh: false, busy: false, reason: '下单队列过期或不可用，不能据此安排两腿成交' };
  if (q.previewAvailable === false) return { fresh: false, busy: false, oldestPreviewSeconds: null, reason: '全球队列统计有效，但官方未提供顺序预览；等待年龄未知，手动两腿方案保持阻止' };
  const oldest = q.preview.length ? Math.max(...q.preview.map(p => Math.max(0, now - p.acceptedAt) / 1000)) : 0;
  const busy = q.capacityBlocks > 3 || q.saturationPct >= 95 || oldest > 30;
  return { fresh: true, busy, oldestPreviewSeconds: oldest,
    reason: busy ? '下单队列拥堵：容量折算超过 3 块、提交压力 ≥95% 或前 10 条等待超过 30 秒；这是监控的保守阈值' : '全球队列快照有效；个人成交位置与时间仍未确认' };
}
export function emissionRate(paper) {
  if (!paper || !positive(paper.rate) || !positive(paper.decay) || !Number.isFinite(paper.trackedLp) || !Number.isFinite(paper.tailProgress)) return null;
  if (paper.trackedLp < paper.cliff) return paper.rate;
  return paper.rate * (paper.decay / (paper.decay + paper.tailProgress)) ** 2;
}

export function paperPnl({ notional, priceMove, instrument, liquidation = false, margin, queueEmpty = true, mintRate }) {
  if (!positive(notional) || !Number.isFinite(priceMove) || !instrument) throw new Error('Invalid position');
  const raw = notional * priceMove;
  if (liquidation) return { rawPnl: -margin, payout: -margin, mintedPaper: margin * mintRate, lossBasis: margin, haircut: 0 };
  if (raw < 0) {
    const basis = -raw * (queueEmpty ? 0.98 : 1);
    return { rawPnl: raw, payout: raw, mintedPaper: basis * mintRate, lossBasis: basis, haircut: 0 };
  }
  const move = Math.max(priceMove - 1 / 50000, 0);
  if (move === 0) return { rawPnl: raw, payout: 0, mintedPaper: 0, lossBasis: 0, haircut: raw };
  const { baseRate, rateMultiplier, positionMultiplier, referenceNotional } = instrument;
  if (!positive(rateMultiplier) || !positive(positionMultiplier) || !positive(referenceNotional) || !(baseRate >= 0 && baseRate < 1)) throw new Error('Unknown payout parameters');
  const scale = (1 - baseRate) / (1 + 1 / (move * rateMultiplier) + referenceNotional / (1e6 * move * positionMultiplier));
  const payout = notional * move * scale * 0.98;
  return { rawPnl: raw, payout, mintedPaper: 0, lossBasis: 0, haircut: raw - payout };
}

export function roundSize(size, decimals) {
  if (!positive(size) || !Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('Invalid size precision');
  const scale = 10 ** decimals;
  return Math.floor(size * scale) / scale;
}

export function vwap(levels, quantity) {
  if (!positive(quantity) || !Array.isArray(levels)) return null;
  let remaining = quantity, cost = 0;
  for (const level of levels) {
    const px = Number(level.px), sz = Number(level.sz);
    if (!positive(px) || !Number.isFinite(sz) || sz < 0) return null;
    const used = Math.min(remaining, sz);
    cost += used * px; remaining -= used;
    if (remaining <= quantity * 1e-12) return cost / quantity;
  }
  return null;
}

export function makePlan(snapshot, coin, input = {}) {
  const config = { ...DEFAULTS, ...input }, reasons = [], warnings = [];
  for (const key of ['margin', 'paperLeverage', 'hedgeLeverage', 'lossBudget']) if (!positive(config[key])) reasons.push(`${key} 必须大于 0`);
  for (const key of ['paperLeverage', 'hedgeLeverage']) if (!Number.isSafeInteger(config[key])) reasons.push(`${key} 必须是整数`);
  for (const key of ['takerFeeBps', 'exitSlippageBps', 'holdingHours']) if (!Number.isFinite(config[key]) || config[key] < 0) reasons.push(`${key} 必须是非负数`);
  if (config.lossBudget >= config.margin) reasons.push('止损预算必须小于保证金');
  const market = snapshot?.markets?.find(m => m.coin === coin), instrument = snapshot?.trading?.instruments?.find(i => i.symbol === coin);
  if (!market || !instrument) reasons.push('Paper 或 Hyperliquid 交易参数不可用');
  if (reasons.length) return { ready: false, reasons, warnings, coin, config };
  const { paperMid, paperAt, bookAt, bids, asks } = market;
  if (!positive(paperMid)) reasons.push('Paper 链上 BBO 价格不可用');
  const now = Date.now();
  if (!Number.isFinite(paperAt) || !Number.isFinite(bookAt) || now - paperAt > 30000 || now - bookAt > 30000 || paperAt > now + 5000 || bookAt > now + 5000) reasons.push('报价超过 30 秒或时间异常');
  if (!snapshot.sources?.summary?.ok || now - snapshot.sources.summary.at > 30000) reasons.push('Paper 协议统计过期或不可用');
  if (!snapshot.sources?.trading?.ok || now - snapshot.sources.trading.at > 30000) reasons.push('Paper 交易参数过期或不可用');
  if (!snapshot.sources?.queue?.ok || now - snapshot.sources.queue.at > 30000) reasons.push('兑付队列过期或不可用');
  if (!snapshot.sources?.context?.ok || now - snapshot.sources.context.at > 30000) reasons.push('HL 保证金或资金费参数过期');
  if (market.paperBlock && Math.abs(Number(BigInt(market.paperBlock)) - snapshot.trading.block) > 30) reasons.push('Paper 交易参数落后链上报价超过 30 个区块');
  if (snapshot.trading.paused || !instrument.openable || snapshot.trading.blockedActions.includes('openPosition')) reasons.push('Paper 当前禁止开仓');
  if (snapshot.trading.blockedActions.includes('closePositions')) reasons.push('Paper 当前禁止平仓');
  if (config.paperLeverage > instrument.maxLeverage) reasons.push('超过 Paper 最大杠杆');
  if (config.hedgeLeverage > market.maxLeverage) reasons.push('超过 HL 最大杠杆');
  const rate = emissionRate(snapshot.paper);
  if (rate === null) reasons.push('铸币曲线参数不可用');
  const queueEmpty = snapshot.queue?.count === 0 && snapshot.queue?.total === 0;
  if (!queueEmpty) reasons.push('兑付队列非空或状态未知，收益到账时间无法确定');
  if (reasons.length) return { ready: false, reasons, warnings, coin, config };
  const quantity = roundSize(config.margin * config.paperLeverage / paperMid, market.szDecimals), notional = quantity * paperMid;
  const execution = executionQueueStatus(snapshot, now);
  if (!execution.fresh || execution.busy) reasons.push(execution.reason);
  const paperMargin = notional / config.paperLeverage, requestedNotional = config.margin * config.paperLeverage;
  const hedgeLong = !config.paperLong, hedgeEntry = vwap(hedgeLong ? asks : bids, quantity);
  if (quantity <= 0 || hedgeEntry === null) reasons.push('订单簿不足以覆盖该数量');
  if (notional < snapshot.trading.minimumOpenNotional || paperMargin < snapshot.trading.minimumMargin) reasons.push('低于 Paper 最小开仓要求');
  if (notional > instrument.maxPositionNotional) reasons.push('超过 Paper 单仓限额');
  if (![instrument.longCap, instrument.shortCap, instrument.longOi, instrument.shortOi, snapshot.trading.maximumNetOpenInterest].every(Number.isFinite)) reasons.push('Paper OI 容量参数不完整');
  const sideCap = config.paperLong ? instrument.longCap : instrument.shortCap;
  const sideOi = config.paperLong ? instrument.longOi : instrument.shortOi;
  if (sideOi + quantity > sideCap) reasons.push('当前 Paper 方向 OI 容量不足');
  const netAfter = (instrument.longOi - instrument.shortOi) * paperMid + (config.paperLong ? notional : -notional);
  if (Math.abs(netAfter) > snapshot.trading.maximumNetOpenInterest) reasons.push('当前 Paper 净 OI 容量不足');
  if (hedgeEntry === null || quantity <= 0) return { ready: false, reasons, warnings, coin, config };
  const stopMove = config.lossBudget / notional;
  const bustDistance = 1 / config.paperLeverage - instrument.bustBuffer;
  if (!positive(bustDistance) || stopMove >= bustDistance * 0.7) reasons.push('止损接近硬清算触发价，无法可靠对冲全额损失');
  if (config.lossBudget >= paperMargin) reasons.push('止损预算超过实际舍入后的保证金');
  const funding = Number.isFinite(market.funding) ? (hedgeLong ? -1 : 1) * market.funding * notional * config.holdingHours : null;
  if (funding === null) reasons.push('资金费率不可用');
  const scenarios = [-1, 1].map(branch => {
    const signedPaperMove = branch * stopMove;
    const underlyingMove = (config.paperLong ? 1 : -1) * signedPaperMove;
    const exitMid = paperMid * (1 + underlyingMove);
    const hedgeExit = exitMid * (hedgeLong ? 1 - config.exitSlippageBps / 10000 : 1 + config.exitSlippageBps / 10000);
    const hedgePnl = (hedgeLong ? 1 : -1) * quantity * (hedgeExit - hedgeEntry);
    const fees = quantity * (hedgeEntry + hedgeExit) * config.takerFeeBps / 10000;
    const paper = paperPnl({ notional, priceMove: signedPaperMove, instrument, mintRate: rate, queueEmpty });
    const pnlBeforeFunding = paper.payout + hedgePnl - fees;
    const pnl = funding === null ? null : pnlBeforeFunding + funding;
    const cost = pnl === null ? null : Math.max(0, -pnl);
    return { name: branch < 0 ? 'Paper 亏损并铸币' : 'Paper 盈利且不铸币', exitMid, paper, hedgePnl, fees, funding, pnlBeforeFunding, pnl, mintedPaper: paper.mintedPaper, costPerPaper: paper.mintedPaper && cost !== null ? cost / paper.mintedPaper : null };
  });
  const marginMinimum = quantity * Math.max(hedgeEntry, market.mark ?? hedgeEntry) / config.hedgeLeverage;
  warnings.push('HL 费率为输入假设，尚未读取你的账户费率；显示的保证金只是初始估计，另留浮亏和维持保证金缓冲。');
  warnings.push('Paper 实际开平仓经过提交队列，两腿不能原子成交。止损是计划价格，不能保证该价格成交。');
  warnings.push('两分支使用同一未来持仓时长；当前资金费率不代表未来每小时费率。未计 GAS、人工操作延迟、资金转移费。');
  warnings.push('硬清算距离按当前市场 buffer 估算；以开仓后平台显示的该仓位 bust price 为准。');
  return { ready: reasons.length === 0, reasons, warnings, coin, config, quantity, notional, requestedNotional, paperMargin, hedgeEntry, hedgeLong, stopMove, bustDistance, rate, marginMinimum, scenarios,
    prices: { paperEntry: paperMid, hedgeEntry, paperAt, bookAt },
    execution, latencyExposurePerBps: notional / 10000,
    staking: { allowed: !snapshot.trading.blockedActions.includes('paperStake'), minimumPaper: snapshot.trading.minimumPaperStake },
  };
}

export function dividendBreakEven(plan, cashPerPaper) {
  if (!plan?.scenarios || !positive(cashPerPaper)) return null;
  const branch = plan.scenarios[0];
  return branch.costPerPaper === null ? null : branch.costPerPaper / cashPerPaper;
}

// 盈利路径指标。全部由公开快照推导；样本不足或字段缺失返回 null，不补零。
const finiteRow = r => r && r.reward_accumulator !== null && r.reward_accumulator !== undefined && [r.collected_at, r.paper_supply, r.staked_supply, r.pending_rewards].every(Number.isFinite);
export function stakerIncomeWindow(rows, minutes) {
  const valid = (rows ?? []).filter(finiteRow);
  if (valid.length < 2 || !positive(minutes)) return null;
  const end = valid.at(-1).collected_at, win = valid.filter(r => r.collected_at >= end - minutes * 60000);
  if (win.length < 2) return null;
  const span = (win.at(-1).collected_at - win[0].collected_at) / 60000;
  if (span < minutes * 0.8) return null;
  let indexDelta = 0, distributed = 0;
  for (let i = 1; i < win.length; i++) {
    const d = Number(BigInt(win[i].reward_accumulator) - BigInt(win[i - 1].reward_accumulator)) / 1e27;
    indexDelta += d; distributed += d * win[i - 1].staked_supply;
  }
  const first = win[0], last = win.at(-1);
  const income = distributed + last.pending_rewards - first.pending_rewards, minted = last.paper_supply - first.paper_supply;
  return { minutes: span, indexDelta, yieldPerPaperHour: indexDelta / span * 60, distributed, income, minted,
    incomePerNewPaper: minted > 0 ? income / minted : null, supplyGrowth: first.paper_supply > 0 ? last.paper_supply / first.paper_supply : null };
}

// Complete UTC hours only. Prefer exact per-token index changes; a missing
// boundary may use official revenue / average stake, explicitly an estimate.
export function dividendWindow48(rows = [], protocolHours = [], now = Date.now()) {
  const hour = 3600000, endAt = Math.floor(now / hour) * hour, startAt = endAt - 48 * hour;
  const points = rows.filter(r => Number.isSafeInteger(r?.collected_at) && r.collected_at <= now && typeof r.reward_accumulator === 'string' && /^\d+$/.test(r.reward_accumulator)).sort((a, b) => a.collected_at - b.collected_at);
  const official = new Map();
  for (const h of protocolHours) if (Number.isSafeInteger(h?.startMs) && !h.partial) official.set(h.startMs, official.has(h.startMs) ? null : h);
  const nearest = at => {
    let best = null, distance = 120001;
    for (const p of points) { const d = Math.abs(p.collected_at - at); if (d < distance) { best = p; distance = d; } }
    return best;
  };
  const bins = []; let totalWeight = 0, validWeight = 0, weighted = 0, sum = 0, measuredHours = 0, estimatedHours = 0;
  let ratioWeight = 0, ratioHours = 0, revenue = 0, minted = 0;
  for (let i = 0; i < 48; i++) {
    const at = startAt + i * hour, weight = 2 ** (-(47 - i) / 12), a = nearest(at), b = nearest(at + hour), h = official.get(at);
    totalWeight += weight; let rate = null, kind = 'missing';
    if (a && b && b.collected_at > a.collected_at) {
      const delta = BigInt(b.reward_accumulator) - BigInt(a.reward_accumulator);
      if (delta >= 0n) { rate = Number(delta) / 1e27 * hour / (b.collected_at - a.collected_at); kind = 'measured'; }
    }
    if (!Number.isFinite(rate) || rate < 0) {
      rate = Number.isFinite(h?.revenuePerPaperHour) && h.revenuePerPaperHour >= 0 ? h.revenuePerPaperHour : null;
      kind = rate === null ? 'missing' : 'estimated';
    }
    if (rate !== null) { validWeight += weight; weighted += weight * rate; sum += rate; if (kind === 'measured') measuredHours++; else estimatedHours++; }
    if (Number.isFinite(h?.revenue) && h.revenue >= 0 && Number.isFinite(h.minted) && h.minted >= 0) {
      ratioWeight += weight; ratioHours++; revenue += weight * h.revenue; minted += weight * h.minted;
    }
    bins.push({ startMs: at, weight, rate, kind });
  }
  const validHours = measuredHours + estimatedHours, coverage = validWeight / totalWeight;
  const available = validHours >= 36 && coverage >= .8;
  const first = official.get(startAt), last = official.get(endAt - hour);
  const initialSupply = first?.paperSupply - first?.minted;
  return { startAt, endAt, hours: 48, halfLifeHours: 12, available, validHours, measuredHours, estimatedHours, coverage,
    weightedPerPaperHour: available ? weighted / validWeight : null,
    meanPerPaperHour: available ? sum / validHours : null,
    incomePerNewPaper: ratioHours >= 36 && ratioWeight / totalWeight >= .8 && minted > 0 ? revenue / minted : null,
    supplyGrowth: official.size >= 48 && initialSupply > 0 && Number.isFinite(last?.paperSupply) ? last.paperSupply / initialSupply : null,
    bins };
}

// 回本所需供应增长：收入/新 PAPER 稳定为 k 时，之后供应增长 g 倍，每枚约得 k × ln(g)。
export function breakEvenGrowth(costPerPaper, incomePerNewPaper) {
  if (!Number.isFinite(costPerPaper) || costPerPaper < 0 || !positive(incomePerNewPaper)) return null;
  return Math.exp(costPerPaper / incomePerNewPaper);
}

export function breakEvenGrowthLabel(growth) {
  if (growth === null || growth === undefined || Number.isNaN(growth)) return '样本不足 / 不可用';
  if (growth > 100) return '回本门槛过高（>100 倍）';
  return '×' + growth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 同账户（或两个账户）Paper 多空等量对冲，同一笔 Close 意图在同一区块平仓。
export function pairHedgeCost(instrument, mintRate, move, notional = 10000) {
  if (!positive(mintRate) || !positive(move) || !positive(notional)) return null;
  const lose = paperPnl({ notional, priceMove: -move, instrument, mintRate }), win = paperPnl({ notional, priceMove: move, instrument, mintRate });
  const cost = -(lose.payout + win.payout);
  return { move, notional, cost, mintedPaper: lose.mintedPaper, costPerPaper: cost / lose.mintedPaper, keep: win.payout / (notional * move) };
}

// 单向下单、固定胜率，直到预算全部磨损的期望铸币量。move 为 null 表示亏损边等硬清算。
export function burnEstimate({ instrument, mintRate, notional, leverage, move, budget = 1000, winProbability = 0.5 }) {
  if (!positive(mintRate) || !positive(notional) || !positive(leverage) || !(winProbability >= 0 && winProbability < 1)) return null;
  const margin = notional / leverage;
  let lose, mint, distance;
  if (move === null) {
    distance = 1 / leverage - instrument.bustBuffer;
    if (!positive(distance)) return null;
    lose = -margin; mint = margin * mintRate;
  } else {
    if (!positive(move) || move >= 1 / leverage - instrument.bustBuffer) return null;
    const l = paperPnl({ notional, priceMove: -move, instrument, mintRate }); lose = l.payout; mint = l.mintedPaper; distance = move;
  }
  const win = paperPnl({ notional, priceMove: distance, instrument, mintRate }).payout, p = 1 - winProbability;
  const expectedLoss = -(p * lose + winProbability * win);
  if (!positive(expectedLoss)) return null;
  const costPerPaper = expectedLoss / (p * mint);
  return { margin, distance, lose, win, mintPerLoss: mint, expectedLossPerTrade: expectedLoss, costPerPaper, expectedPaper: budget / costPerPaper, expectedTrades: budget / expectedLoss };
}

// LP 打穿风险：交易者净持仓按同一涨跌幅全部兑现时 LP 的变化（未计清算保证金收入与分批平仓，偏保守）。
export function lpDrainRisk(snapshot, { maxMove = 0.05, step = 0.0001 } = {}) {
  const p = snapshot?.paper, instruments = snapshot?.trading?.instruments;
  if (!p || !Number.isFinite(p.trackedLp) || !Number.isFinite(p.cliff) || !Array.isArray(instruments)) return null;
  const legs = [];
  for (const i of instruments) {
    const mid = snapshot.markets?.find(m => m.coin === i.symbol)?.paperMid;
    if (!positive(mid) || !Number.isFinite(i.longOi) || !Number.isFinite(i.shortOi)) return null;
    legs.push({ symbol: i.symbol, instrument: i, net: (i.longOi - i.shortOi) * mid, long: i.longOi * mid, short: i.shortOi * mid });
  }
  const lpChange = (move, dir) => legs.reduce((sum, l) => {
    if (l.net === 0) return sum;
    return l.net * dir > 0 ? sum - paperPnl({ notional: Math.abs(l.net), priceMove: move, instrument: l.instrument }).payout : sum + Math.abs(l.net) * move * 0.98;
  }, 0);
  const solve = (dir, buffer) => {
    if (buffer <= 0) return 0;
    for (let m = step; m <= maxMove + 1e-12; m += step) if (-lpChange(m, dir) >= buffer) return m;
    return null;
  };
  const toCliff = p.trackedLp - p.cliff, toZero = p.trackedLp;
  return { legs: legs.map(({ instrument, ...l }) => l), netNotional: legs.reduce((s, l) => s + l.net, 0), trackedLp: p.trackedLp, cliff: p.cliff, bufferToCliff: toCliff,
    up: { toCliff: solve(1, toCliff), toZero: solve(1, toZero) }, down: { toCliff: solve(-1, toCliff), toZero: solve(-1, toZero) }, flatRateActive: p.trackedLp < p.cliff };
}
