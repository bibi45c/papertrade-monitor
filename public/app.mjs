import { makePlan, emissionRate, executionQueueStatus, stakerIncomeWindow, breakEvenGrowth, pairHedgeCost, burnEstimate } from './model.mjs';
const $ = id => document.getElementById(id);
let snapshot = null, stored = null, plan = null, history = [], recent = [], day = [], refreshing = false, historyRefreshing = false, networkHealthy = false;
const number = (value, digits = 2) => value === null || value === undefined || !Number.isFinite(value) ? '不可用' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = value => number(value) + (Number.isFinite(value) ? ' U' : '');
const compact = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value) : '不可用';
const time = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore', hour12: false }) : '不可用';
const age = value => Number.isFinite(value) ? Math.max(0, Math.round((Date.now() - value) / 1000)) + ' s' : '不可用';
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const set = (id, text) => { $(id).textContent = text; };
const pnlClass = value => Number.isFinite(value) && value >= 0 ? 'pos' : 'neg';
function config() { const c = {}; for (const k of ['margin', 'paperLeverage', 'hedgeLeverage', 'lossBudget', 'takerFeeBps', 'exitSlippageBps', 'holdingHours']) c[k] = Number($(k).value); c.paperLong = $('direction').value === 'long'; return c; }

function render() {
  if (!snapshot) return;
  const s = snapshot, p = s.paper;
  const fresh = networkHealthy && ['summary', 'queue', 'trading', 'context', 'paperBbo'].every(k => s.sources[k]?.ok && Date.now() - s.sources[k].at <= 30000);
  $('connection').className = 'status ' + (fresh ? 'ok' : 'bad'); set('connection', fresh ? '已连接 · ' + age(s.completedAt) : '数据过期 / 来源故障');
  set('updated', time(s.collectedAt)); set('supply', compact(p?.supply)); set('mintRate', number(emissionRate(p), 3)); set('pending', compact(p?.pendingRewards) + ' U'); set('lp', compact(s.balances?.lp) + ' U');
  set('capNote', '超额分配阈值 ' + compact(p?.cap) + ' U'); set('staked', compact(p?.staked));
  set('stakeNote', p && p.supply > 0 ? '占供应 ' + number(p.staked / p.supply * 100, 4) + '%' : '不可用');
  set('queue', s.queue ? compact(s.queue.total) + ' U' : '不可用'); set('queueNote', s.queue ? s.queue.count + ' 笔兑付等待；与下单队列分别采集' : '兑付状态未知');
  const q = s.executionQueue, execution = executionQueueStatus(s);
  set('executionState', !networkHealthy || !execution.fresh ? '过期 / 不可用' : execution.busy ? '拥堵 · 手动方案已阻止' : '快照有效 · ' + age(q.sourceAt));
  set('executionCount', q?.available ? number(q.queuedIntents, 0) + ' / ' + number(q.submittedIntents, 0) : '不可用');
  set('executionBlocks', q?.available ? number(q.capacityBlocks, 0) + ' 块' : '不可用');
  set('executionPressure', q?.available ? number(q.saturationPct, 1) + '%' : '不可用');
  set('executionOldest', execution.fresh ? number(execution.oldestPreviewSeconds, 1) + ' s' : '不可用');
  set('executionNote', execution.reason + '。个人排名未接入；请求从预览消失不证明已成交。');
  const actionNames = { openPosition: '开仓', closePositions: '平仓', paperStake: '质押', paperUnstake: '解除质押', paperClaim: '领取分红', paperDistribute: '分配', registerSessionKey: '会话授权', withdrawToCore: '提现' };
  $('executionPreview').replaceChildren(...(q?.available && q.preview.length ? q.preview.map((p, idx) => { const tr = el('tr'); [idx + 1, actionNames[p.action] ?? p.action, '类别 ' + p.priorityClass, p.estimatedGas, age(p.acceptedAt)].forEach(x => tr.append(el('td', x))); return tr; }) : [(() => { const tr = el('tr'), td = el('td', q?.available ? '该快照队列为空' : '无有效快照，不能当作没有排队'); td.colSpan = 5; tr.append(td); return tr; })()]));
  set('notice', !fresh ? '公开来源故障或超过 30 秒，方案已阻止。旧值仅供查看，不能视为当前行情。' : p?.staked === 0 ? '当前官方质押供应为 0；待分配奖励还不能用于证明个人回本。PAPER 可交易市场价尚未核实。' : 'PAPER 可交易市场价尚未核实。请以实际分配指数与领取流水判断收益；待分配奖励没有计为现金收入。');
  $('markets').replaceChildren(...s.markets.map(m => {
    const tr = el('tr'), diff = m.paperMid && m.bid && m.ask ? (m.paperMid / ((m.bid + m.ask) / 2) - 1) * 10000 : null;
    const fields = [m.coin, Number.isFinite(m.bid) ? number(m.bid, m.coin === 'HYPE' ? 4 : 2) + ' / ' + number(m.ask, m.coin === 'HYPE' ? 4 : 2) : '不可用', m.coin === 'HYPE' ? 'Paper 暂无该市场' : number(m.paperMid), diff === null ? '—' : number(diff, 3) + ' bps', number(m.mark), Number.isFinite(m.funding) ? number(m.funding * 100, 6) + '%' : '不可用', 'HL ' + age(m.bookAt) + (m.paperAt ? ' / P ' + age(m.paperAt) : '')];
    fields.forEach((v, i) => tr.append(el('td', v, i === 5 && Number.isFinite(m.funding) ? pnlClass(m.funding) : undefined))); return tr;
  }));
  $('sources').replaceChildren(...Object.entries(s.sources).map(([name, source]) => { const row = el('div', undefined, 'source'); row.append(el('span', name), el('span', source.ok ? age(source.at) : source.error, source.ok && Date.now() - source.at <= 30000 ? 'pos' : 'neg')); return row; }));
  set('distribution', s.latestDistribution ? time(s.latestDistribution.at) : s.sources.paperActivity?.ok ? '尚无分配记录' : '不可用');
  set('distributionNote', s.latestDistribution ? '该次协议分配 ' + money(s.latestDistribution.amount) : '查询官方最新分配事件');
  renderPlan(); renderHistory(); renderPath(); renderRisk();
}

// 风险与规则变更：治理排程与网页版本来自云端定时记录（/api/latest），其余用实时快照。
function renderRisk() {
  if (!snapshot) return;
  const s = snapshot, g = stored?.governance ?? s.governance, now = Date.now(), pct = v => v === null || v === undefined ? '5% 内不会' : number(v * 100, 2) + '%';
  const ops = (g?.operations ?? []).filter(o => Number.isFinite(o.readyAt)), applied = o => o.resolvedBlock || (o.selector === '12baae3b' && Number(o.args?.[1]) > 0 && s.paper?.cap >= Number(o.args[1])), pending = ops.filter(o => !applied(o));
  set('govCount', g ? String(pending.length) : '不可用');
  const next = pending.map(o => o.readyAt).sort((a, b) => a - b)[0];
  set('govNote', !g ? '治理扫描未接入（等待云端定时记录）' : (g.stale ? '扫描失败，沿用上一条记录 · ' : '') + (next ? '最早 ' + time(next) + ' 可执行（' + number((next - now) / 86400000, 1) + ' 天）' : '没有待执行的排程') + ' · 已扫到区块 ' + (g.lastScannedBlock ?? '—'));
  $('govTable').replaceChildren(...(ops.length ? ops.map(o => { const tr = el('tr'); [o.description ?? `${o.label}${o.args ? '：' + o.args.join(', ') : ''}`, o.where ?? o.target, time(o.readyAt), applied(o) ? (o.resolvedBlock ? '已执行或已取消（区块 ' + o.resolvedBlock + '）' : '已生效（链上参数已等于新值）') : o.readyAt <= now ? '可执行，等待多签执行' : '排程中，' + number((o.readyAt - now) / 86400000, 1) + ' 天后可执行'].forEach(x => tr.append(el('td', x))); return tr; }) : [(() => { const tr = el('tr'), td = el('td', g ? '没有排程操作' : '治理数据不可用，不能当作没有排程'); td.colSpan = 4; tr.append(td); return tr; })()]));
  const alerts = [...(s.listing?.alerts ?? [])], web = stored?.web;
  if (web?.changedAt && now - web.changedAt < 7 * 86400000) alerts.push({ level: 'info', detail: `官方文档或前端版本在 ${time(web.changedAt)} 更新，人工核对是否有上新或规则变化` });
  for (const e of (g?.recentEvents ?? []).filter(e => e.kind === 'multisigSubmitted' || e.kind === 'multisigExecuted').slice(0, 3)) alerts.push({ level: 'high', detail: `多签${e.kind === 'multisigSubmitted' ? '提交' : '执行'}：${e.call?.inner ? e.call.inner.where + ' · ' + e.call.inner.label : e.call?.where + ' · ' + e.call?.label}（区块 ${e.block}）` });
  set('listingCount', s.listing ? String(alerts.length) : '不可用');
  set('listingNote', s.listing ? '当前市场：' + s.listing.symbols.join('、') : '交易参数不可用');
  const names = { critical: '严重', high: '高', info: '提示' };
  $('listingTable').replaceChildren(...(alerts.length ? alerts.map(a => { const tr = el('tr'); tr.append(el('td', a.detail), el('td', names[a.level] ?? a.level, a.level === 'info' ? undefined : 'neg')); return tr; }) : [(() => { const tr = el('tr'), td = el('td', s.listing ? '只有 BTC、ETH，参数与上线基线一致' : '交易参数不可用，不能当作没有变化'); td.colSpan = 2; tr.append(td); return tr; })()]));
  const r = s.lpRisk;
  set('lpCliffMove', !r ? '不可用' : r.flatRateActive ? '已在 200 万以下' : pct(r.up.toCliff));
  set('lpCliffNote', r ? `tracked LP ${compact(r.trackedLp)} U · 净持仓 ${compact(r.netNotional)} U · 下跌到 200 万：${pct(r.down.toCliff)}` : '交易参数或报价不可用');
  $('lpRiskTable').replaceChildren(...(r ? [...r.legs.map(l => { const tr = el('tr'); [l.symbol, compact(l.net) + ' U（多 ' + compact(l.long) + ' / 空 ' + compact(l.short) + '）', '—', '—'].forEach(x => tr.append(el('td', x))); return tr; }), (() => { const tr = el('tr'); ['合计（同涨同跌）', compact(r.netNotional) + ' U', pct(r.up.toCliff) + ' / ' + pct(r.up.toZero), pct(r.down.toCliff) + ' / ' + pct(r.down.toZero)].forEach(x => tr.append(el('td', x))); return tr; })()] : [(() => { const tr = el('tr'), td = el('td', '不可用'); td.colSpan = 4; tr.append(td); return tr; })()]));
  const ev = s.events?.events ?? [], first = ev[0];
  set('nextEvent', first ? (first.inWindow ? '进行中 · ' : '') + first.name : s.events?.calendarExhausted ? '日历需续表' : '不可用');
  set('nextEventNote', first ? time(first.at) + '（' + number((first.at - now) / 3600000, 1) + ' 小时后）' + (ev[1] ? ' · 之后 ' + ev[1].name + ' ' + time(ev[1].at) : '') : 'FOMC、CPI、非农；前后 30 分钟为高波动窗口');
  const j = s.jumps, count = key => day.filter(x => Number.isFinite(x[key]) && x[key] > 0.001).length;
  $('jumpTable').replaceChildren(...['BTC', 'ETH'].map(c => { const tr = el('tr'), v = j?.[c]; [c, v ? number(v.max1s * 100, 3) + '%' : '不可用', v ? number(v.max10s * 100, 3) + '%' : '不可用', day.length ? String(count(c === 'BTC' ? 'jump_btc_1s' : 'jump_eth_1s')) + ' / ' + day.length : '样本不足'].forEach((x, i) => tr.append(el('td', x, i === 1 && v && v.max1s > 0.001 ? 'neg' : undefined))); return tr; }));
  const level = alerts.some(a => a.level === 'critical') ? '严重：出现可能跳空的新市场' : first?.inWindow ? '宏观事件窗口：跳空与 LP 打穿风险上升' : r && !r.flatRateActive && r.up.toCliff !== null && r.up.toCliff < 0.01 ? 'LP 缓冲薄：涨 ' + pct(r.up.toCliff) + ' 即跌破 200 万' : alerts.length ? '有变更需核对' : '平稳';
  set('riskState', level);
}

function renderPath() {
  if (!snapshot) return;
  const s = snapshot, rate = emissionRate(s.paper), btc = s.trading?.instruments?.find(i => i.symbol === 'BTC');
  const w60 = stakerIncomeWindow(recent, 60), w30 = stakerIncomeWindow(recent, 30), k = w60?.incomePerNewPaper ?? null;
  set('incomePerNew', k === null ? '样本不足' : number(k, 5) + ' U');
  set('incomePerNewNote', w30?.incomePerNewPaper ? '30 分钟 ' + number(w30.incomePerNewPaper, 5) + ' U · （分配 + 待分配变化）÷ 新铸 PAPER' : '（分配 + 待分配变化）÷ 新铸 PAPER；需要至少 48 分钟连续样本');
  set('stakerShare', k !== null && rate !== null ? number(k * rate * 100, 1) + '%' : '不可用');
  set('paperYield', w60 ? number(w60.yieldPerPaperHour, 5) + ' U' : '样本不足');
  set('paperYieldNote', w30 ? '30 分钟折算 ' + number(w30.yieldPerPaperHour, 5) + ' U/小时 · 每 1 万枚约 ' + number(w60 ? w60.yieldPerPaperHour * 10000 : NaN, 1) + ' U/小时' : '分红指数增长；随供应增长下降');
  set('supplyGrowth', w60?.supplyGrowth ? '×' + number(w60.supplyGrowth, 2) : '样本不足');
  const paths = [];
  if (btc && rate !== null) {
    for (const move of [0.01, 0.005]) { const h = pairHedgeCost(btc, rate, move); paths.push(['Paper 多空对冲 · 波动 ' + move * 100 + '% 一起平', h.costPerPaper, `每轮成本 ${number(h.cost, 2)} U / 铸 ${compact(h.mintedPaper)}；无 HL 费用与资金费`]); }
    paths.push(['单纯方向亏损', 1 / (0.98 * rate), '亏 1 U 只换铸币，不回收盈利']);
  }
  if (plan?.scenarios) {
    const prob = Number($('lossProbability').value) / 100, [loss, win] = plan.scenarios;
    if (prob > 0 && prob <= 1 && loss.mintedPaper > 0) paths.push([`HL 对冲 · 当前计算器 ${plan.config.paperLeverage}x`, Math.max(0, -(prob * loss.pnl + (1 - prob) * win.pnl)) / (prob * loss.mintedPaper), `按输入 ${number(prob * 100, 0)}% 亏损概率；另有两腿排队敞口`]);
  }
  $('pathTable').replaceChildren(...(paths.length ? paths.map(([name, cost, note]) => { const g = breakEvenGrowth(cost, k), tr = el('tr'); [name, number(cost, 5) + ' U', g === null ? '不可用' : '×' + number(g, 2), note].forEach(x => tr.append(el('td', x))); return tr; }) : [(() => { const tr = el('tr'), td = el('td', '等待铸币率与交易参数'); td.colSpan = 4; tr.append(td); return tr; })()]));
  const best = btc && rate !== null ? breakEvenGrowth(pairHedgeCost(btc, rate, 0.01).costPerPaper, k) : null;
  set('pathState', best === null ? '样本不足 · 不判断' : best < 1.5 ? '最低成本路径需供应再增 ×' + number(best, 2) + ' · 可观察' : best < Math.E ? '需供应再增 ×' + number(best, 2) + ' · 警戒' : '需供应再增 ×' + number(best, 2) + ' · 已接近刷币者互相补贴，暂停新增');
  const burns = btc && rate !== null ? [['1000x · 亏损边爆仓', 1000, null], ['500x · 亏损边爆仓', 500, null], ['100x · 0.5% 平仓', 100, 0.005], ['50x · 1% 平仓', 50, 0.01], ['20x · 2% 平仓', 20, 0.02]].map(([name, lev, move]) => [name, burnEstimate({ instrument: btc, mintRate: rate, notional: s.trading.minimumOpenNotional, leverage: lev, move })]) : [];
  $('burnTable').replaceChildren(...(burns.length ? burns.map(([name, b]) => { const tr = el('tr'); (b ? [name, money(b.margin), number(b.distance * 100, 3) + '%', money(b.expectedLossPerTrade), number(b.costPerPaper, 5) + ' U', compact(b.expectedPaper), number(b.expectedTrades, 0)] : [name, '不可用', '', '', '', '', '']).forEach(x => tr.append(el('td', x))); return tr; }) : [(() => { const tr = el('tr'), td = el('td', '等待铸币率与交易参数'); td.colSpan = 7; tr.append(td); return tr; })()]));
  const hours = s.protocolHours;
  $('protocolHours').replaceChildren(...(hours?.length ? [...hours].reverse().map(h => { const tr = el('tr'); [time(h.startMs).slice(0, -3) + (h.partial ? '（进行中）' : ''), compact(h.revenue) + ' U', compact(h.minted), h.revenuePerNewPaper === null ? '—' : number(h.revenuePerNewPaper, 5) + ' U', h.revenuePerPaperHour === null ? '—' : number(h.revenuePerPaperHour, 5) + ' U', compact(h.traderPnl) + ' U', compact(h.liquidationNotional) + ' U'].forEach((x, i) => tr.append(el('td', x, i === 5 ? pnlClass(h.traderPnl) : undefined))); return tr; }) : [(() => { const tr = el('tr'), td = el('td', s.sources.protocolHistory?.ok ? '尚无交易小时' : '官方小时统计不可用'); td.colSpan = 7; tr.append(td); return tr; })()]));
}

function renderPlan() {
  if (!snapshot) return;
  try { plan = makePlan(snapshot, $('coin').value, config()); }
  catch { plan = { ready: false, reasons: ['交易参数异常或输入无效'], warnings: [] }; }
  if (!networkHealthy) { plan.ready = false; plan.reasons.push('网络连接失败，等待重新采集'); }
  $('planState').className = 'plan-state' + (plan.ready ? '' : ' blocked');
  set('planState', plan.ready ? '参数检查通过 · 仅供手动评估，不代表保证盈利' : '方案阻止：' + plan.reasons.join('；'));
  $('copyPlan').disabled = !plan.ready;
  $('orderParams').replaceChildren();
  if (plan.scenarios) {
    const fields = [['匹配数量', number(plan.quantity, 5) + ' ' + plan.coin], ['Paper 名义仓位', money(plan.notional)], ['实际 Paper 保证金', money(plan.paperMargin)], ['HL 进场 VWAP', money(plan.hedgeEntry)], ['HL 初始保证金估计', money(plan.marginMinimum) + ' + 缓冲'], ['单腿每 1 bps 敞口', money(plan.latencyExposurePerBps)], ['止损 / 止盈价格变动', number(plan.stopMove * 100, 4) + '%'], ['硬清算距离估计', number(plan.bustDistance * 100, 4) + '%'], ['质押最低数量', compact(plan.staking.minimumPaper) + ' PAPER']];
    for (const [name, value] of fields) { const row = el('div'); row.append(el('dt', name), el('dd', value)); $('orderParams').append(row); }
    $('branches').replaceChildren(...plan.scenarios.map(b => { const card = el('article', undefined, 'branch'); card.append(el('h3', b.name), el('div', (b.pnl >= 0 ? '+' : '') + money(b.pnl), 'pnl ' + pnlClass(b.pnl))); for (const [name, value] of [['Paper 结算盈亏', money(b.paper.payout)], ['HL 盈亏（退出偏差已计）', money(b.hedgePnl)], ['HL 开平手续费', money(b.fees)], ['预计资金费收入', money(b.funding)], ['PAPER 数量', compact(b.mintedPaper)], ['亏损分支每枚成本', b.costPerPaper === null ? '未铸币' : number(b.costPerPaper, 8) + ' U']]) { const row = el('div', undefined, 'row'); row.append(el('span', name), el('span', value)); card.append(row); } return card; }));
    const prob = Number($('lossProbability').value) / 100;
    if (!(prob > 0 && prob <= 1)) set('expected', '概率必须在 1%–100% 之间。');
    else {
      const [loss, win] = plan.scenarios, mean = prob * loss.pnl + (1 - prob) * win.pnl, meanPaper = prob * loss.mintedPaper;
      const cost = Math.max(0, -mean) / meanPaper;
      const message = `在你输入的 ${number(prob * 100, 0)}% 亏损概率下，每次组合盈亏约 ${money(mean)}，每枚 PAPER 的重复试验平均成本约 ${number(cost, 8)} U。这个概率尚未验证，不能当作预期收益。`;
      const validRows = history.filter(r => r.reward_accumulator !== null && r.paper_source_at !== null);
      let income = '';
      if (validRows.length >= 2) {
        const first = validRows[0], last = validRows.at(-1), delta = Number(BigInt(last.reward_accumulator) - BigInt(first.reward_accumulator)) / 1e27;
        const hours = (last.paper_source_at - first.paper_source_at) / 3600000;
        if (delta > 0 && hours > 0 && hours < 24) income = ` 分红观测仅覆盖 ${number(hours, 1)} 小时，启动分配与稀释可能变化，暂不外推现金回本时间。`;
        else if (delta > 0 && hours >= 24) income = ` 若未来分配速度等于本区间，持续质押的成本回收时间外推约 ${number(cost / (delta / hours), 1)} 小时；24 小时样本也不保证未来速度。`;
        else income = ' 本区间尚无正的分配指数增长，暂无可支持现金回本时间的观测。';
      } else income = ' 尚缺连续分红样本，现金回本时间不可用。';
      set('expected', message + income);
    }
  } else { $('branches').replaceChildren(el('p', '等待有效行情与参数。', 'subtle')); set('expected', '无法计算；缺失字段没有用零替代。'); }
  $('warnings').replaceChildren(...(plan.warnings ?? []).map(text => el('li', text)));
}

function renderHistory() {
  const queues = history.filter(r => Number.isFinite(r.execution_queued));
  set('executionHistory', queues.length ? `当前历史区间有 ${queues.length} 个下单队列样本，等待笔数 ${number(Math.min(...queues.map(r => r.execution_queued)), 0)}–${number(Math.max(...queues.map(r => r.execution_queued)), 0)}；最后一条 ${time(queues.at(-1).execution_source_at)}。CSV 含队列字段。` : '本区间尚无下单队列历史；旧样本的缺失值没有补成零。');
  const valid = history.filter(r => r.paper_supply !== null && Number.isFinite(r.paper_supply));
  set('historyState', history.length ? history.length + ' 个样本 · ' + time(history[0].collected_at) + ' 起' : '还没有历史样本');
  if (valid.length >= 2) {
    const first = valid[0], last = valid.at(-1); set('dilution', first.paper_supply > 0 ? number((last.paper_supply / first.paper_supply - 1) * 100, 2) + '%' : '不可用');
    const r = history.filter(x => x.reward_accumulator !== null);
    if (r.length >= 2) set('periodDividend', money(Number(BigInt(r.at(-1).reward_accumulator) - BigInt(r[0].reward_accumulator)) / 1e27 * 100000));
    else set('periodDividend', '样本不足');
    const low = Math.min(...valid.map(r => r.paper_supply)), high = Math.max(...valid.map(r => r.paper_supply)), span = high - low || 1;
    const from = valid[0].collected_at, duration = valid.at(-1).collected_at - from || 1;
    const points = valid.map(r => `${20 + (r.collected_at - from) / duration * 960},${155 - (r.paper_supply - low) / span * 130}`).join(' ');
    const svg = $('historyChart'); svg.replaceChildren();
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); line.setAttribute('points', points); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#b9f2b0'); line.setAttribute('stroke-width', '2'); svg.append(line);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', '20'); label.setAttribute('y', '20'); label.setAttribute('fill', '#88958f'); label.textContent = compact(low) + ' → ' + compact(high) + ' PAPER'; svg.append(label);
  } else { set('dilution', '样本不足'); set('periodDividend', '样本不足'); }
}

async function refresh() {
  if (refreshing) return; refreshing = true;
  try { const response = await fetch('/api/live', { cache: 'no-store', signal: AbortSignal.timeout(25000) }); if (!response.ok) throw new Error('API unavailable'); snapshot = await response.json(); networkHealthy = true; render(); }
  catch { networkHealthy = false; $('connection').className = 'status bad'; set('connection', '连接失败'); set('notice', '连接失败。旧值仅供查看，方案已经阻止；恢复后重新计算。'); renderPlan(); }
  finally { refreshing = false; }
}
async function refreshHistory() {
  if (historyRefreshing) return; historyRefreshing = true;
  try {
    const r = await fetch('/api/history?hours=' + Number($('historyHours').value), { signal: AbortSignal.timeout(15000) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); history = data.rows;
    const rr = await fetch('/api/history?hours=2', { signal: AbortSignal.timeout(15000) }); const minute = await rr.json(); recent = rr.ok ? minute.rows : [];
    day = Number($('historyHours').value) === 24 ? history : day;
    if (Number($('historyHours').value) !== 24) { const rd = await fetch('/api/history?hours=24', { signal: AbortSignal.timeout(15000) }); const d = await rd.json(); day = rd.ok ? d.rows : []; }
    const rl = await fetch('/api/latest', { signal: AbortSignal.timeout(15000) }); const latest = await rl.json(); stored = rl.ok ? latest.snapshot : null;
    renderHistory(); renderPlan(); renderPath(); renderRisk();
  }
  catch (error) { set('historyState', error.message); }
  finally { historyRefreshing = false; }
}
$('config').addEventListener('input', () => { renderPlan(); renderPath(); });
$('historyHours').addEventListener('change', refreshHistory);
$('exportDay').value = new Date().toISOString().slice(0, 10);
const updateExport = () => $('exportLink').href = '/api/export.csv?day=' + encodeURIComponent($('exportDay').value);
$('exportDay').addEventListener('change', updateExport); updateExport();
$('copyPlan').addEventListener('click', async () => {
  renderPlan(); if (!plan?.ready) return;
  const p = plan, text = [`${p.coin} 对冲方案（仅测算；确认实际成交后再匹配数量）`, `采集时间：${time(snapshot.collectedAt)}`, `Paper ${p.config.paperLong ? '多' : '空'}：${p.quantity} ${p.coin}，保证金 ${p.paperMargin.toFixed(4)} U，${p.config.paperLeverage}x，参考价 ${p.prices.paperEntry}`, `HL ${p.hedgeLong ? '多' : '空'}：${p.quantity} ${p.coin}，${p.config.hedgeLeverage}x，订单簿 VWAP ${p.hedgeEntry.toFixed(4)}，最低保证金估计 ${p.marginMinimum.toFixed(2)} U + 浮亏缓冲`, `先确认 Paper 提交/成交状态与真实入场价；HL 使用价格限制并匹配已成交数量；任何一腿失败即停止加仓，处理已有敞口。`, `止损/止盈参考价：${p.scenarios.map(b => b.exitMid.toFixed(4)).join(' / ')}；HL 平仓使用 reduce-only，数量以真实仓位为准。`, `Paper 亏损分支组合盈亏 ${p.scenarios[0].pnl.toFixed(4)} U / 铸币 ${p.scenarios[0].mintedPaper.toFixed(4)} PAPER`, `Paper 盈利分支组合盈亏 ${p.scenarios[1].pnl.toFixed(4)} U / 不铸币`, ...p.warnings].join('\n');
  try { await navigator.clipboard.writeText(text); set('copyResult', '方案已复制；不会提交订单。'); } catch { set('copyResult', '浏览器禁止剪贴板，请根据上方参数手动操作。'); }
});
await Promise.all([refresh(), refreshHistory()]);
setInterval(refresh, 10000); setInterval(refreshHistory, 60000);
setInterval(() => { if (snapshot) render(); }, 5000);
