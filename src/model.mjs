export const DEFAULTS = Object.freeze({
  margin: 1000, paperLeverage: 20, hedgeLeverage: 10, lossBudget: 100,
  takerFeeBps: 4.5, exitSlippageBps: 1, holdingHours: 1, paperLong: true,
});

const positive = x => Number.isFinite(x) && x > 0;
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
    staking: { allowed: !snapshot.trading.blockedActions.includes('paperStake'), minimumPaper: snapshot.trading.minimumPaperStake },
  };
}

export function dividendBreakEven(plan, cashPerPaper) {
  if (!plan?.scenarios || !positive(cashPerPaper)) return null;
  const branch = plan.scenarios[0];
  return branch.costPerPaper === null ? null : branch.costPerPaper / cashPerPaper;
}
