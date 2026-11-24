// Trader net exposure vs LP bankroll: 15-minute history (minute archive + on-chain backfill) plus the live point.
// Values missing in the source stay missing; lines break across gaps instead of interpolating.
const COLS = { t: 0, lp: 1, tvl: 2, btcL: 3, btcS: 4, ethL: 5, ethS: 6, btcPx: 7, ethPx: 8, src: 9, samples: 10, upnl: 11 };
const GAP_MS = 45 * 60000;
const NS = 'http://www.w3.org/2000/svg';
const fin = Number.isFinite;
// Marked events (UTC), verified from Exchange logs and the public /query/accounts/{addr}/trades endpoint.
// 11-13: one account closed three month-old high-leverage shorts (blocks 51144536–51144540); LP paid the
// realized profit, then the account withdrew its whole balance (block 51144579). LP available only moves
// when profit is realized, so the unrealized liability built up for weeks without showing on the LP line.
export const EVENTS = Object.freeze([
  { t: Date.parse('2026-11-13T09:43:19Z'), block: 51144536,
    zh: '11-13 09:43 一个账户平掉 3 张 10 月开的高杠杆空单（ETH 250x 与 40x、BTC 145x，保证金合计 6.5 万 U），已实现盈利 2.02M 由 LP 支付；09:44 提走全部 2.14M，treasury 同步减少',
    en: '11-13 09:43 one account closed three high-leverage shorts opened in October (ETH 250x and 40x, BTC 145x; 65K U margin in total); LP paid the 2.02M realized profit, and the account withdrew its full 2.14M at 09:44, reducing treasury',
    short: { zh: '空单兑现 2.02M + 提现 2.14M', en: 'Shorts realized 2.02M + withdrew 2.14M' } },
]);

const usd = v => !fin(v) ? '—' : (v < 0 ? '−' : '') + '$' + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(Math.abs(v));
const signedUsd = v => !fin(v) ? '—' : (v > 0 ? '+' : '') + usd(v);
const pct = (v, d = 2) => !fin(v) ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%';

// Long history (daily file from the archive server) + recent 15-minute points from the Worker's D1.
// History wins where both exist; recent points extend it, and their mids extend the candle price lines.
export function mergeSeries(history, recent) {
  if (!history && !recent) return null;
  const points = [...(history?.points ?? [])], end = points.at(-1)?.[0] ?? -Infinity;
  for (const p of recent?.points ?? []) if (p[0] > end) points.push(p);
  const prices = { ...(history?.prices ?? {}) };
  for (const [coin, col] of [['BTC', 7], ['ETH', 8]]) {
    const list = [...(prices[coin] ?? [])], last = list.at(-1)?.[0] ?? -Infinity;
    for (const p of recent?.points ?? []) if (p[0] > last && Number.isFinite(p[col])) list.push([p[0], p[col]]);
    prices[coin] = list;
  }
  return { ...(history ?? {}), points, prices, recentFrom: recent?.points?.[0]?.[0] ?? null };
}

export function livePoint(s) {
  if (!s) return null;
  const inst = Object.fromEntries((s.trading?.instruments ?? []).map(i => [i.symbol, i]));
  const mid = Object.fromEntries((s.markets ?? []).map(m => [m.coin, m.mid]));
  const upnl = s.sources?.traderBook?.ok && Number.isFinite(s.traderBook?.unrealizedPnl) ? s.traderBook.unrealizedPnl : null;
  return [s.collectedAt, s.balances?.lp ?? null, s.balances?.tvl ?? null, inst.BTC?.longOi ?? null, inst.BTC?.shortOi ?? null, inst.ETH?.longOi ?? null, inst.ETH?.shortOi ?? null, mid.BTC ?? null, mid.ETH ?? null, 2, 1, upnl];
}

function derive(p) {
  const btcNet = fin(p[COLS.btcL]) && fin(p[COLS.btcS]) && fin(p[COLS.btcPx]) ? (p[COLS.btcL] - p[COLS.btcS]) * p[COLS.btcPx] : null;
  const ethNet = fin(p[COLS.ethL]) && fin(p[COLS.ethS]) && fin(p[COLS.ethPx]) ? (p[COLS.ethL] - p[COLS.ethS]) * p[COLS.ethPx] : null;
  const side = (b, e) => fin(p[b]) && fin(p[COLS.btcPx]) && fin(p[e]) && fin(p[COLS.ethPx]) ? p[b] * p[COLS.btcPx] + p[e] * p[COLS.ethPx] : null;
  return { t: p[COLS.t], lp: p[COLS.lp], tvl: p[COLS.tvl], btcPx: p[COLS.btcPx], ethPx: p[COLS.ethPx], btcNet, ethNet, total: fin(btcNet) && fin(ethNet) ? btcNet + ethNet : null,
    long: side(COLS.btcL, COLS.ethL), short: side(COLS.btcS, COLS.ethS), src: p[COLS.src], upnl: p[COLS.upnl] ?? null };
}

// Rolling median over `w` buckets on each side, never across a gap; keeps steps, drops single-bucket spikes.
function smooth(rows, key, w) {
  if (w < 1) return rows.map(r => r[key]);
  return rows.map((r, i) => {
    if (!fin(r[key])) return null;
    const vals = [];
    for (let j = i - w; j <= i + w; j++) if (rows[j] && fin(rows[j][key]) && Math.abs(rows[j].t - r.t) <= (w + 1) * 15 * 60000) vals.push(rows[j][key]);
    vals.sort((a, b) => a - b); return vals[vals.length >> 1];
  });
}
const quantile = (vals, q) => { const v = [...vals].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))]; };

// Largest BTC move within `windowMs` inside the range, with the LP change over the same window.
export function largestMove(rows, windowMs = 12 * 3600000) {
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    if (!fin(rows[i].btcPx)) continue;
    for (let j = i + 1; j < rows.length && rows[j].t - rows[i].t <= windowMs; j++) {
      if (!fin(rows[j].btcPx)) continue;
      const move = rows[j].btcPx / rows[i].btcPx - 1;
      if (!best || Math.abs(move) > Math.abs(best.move)) best = { from: rows[i], to: rows[j], move };
    }
  }
  if (!best) return null;
  const inside = rows.filter(r => r.t >= best.from.t && r.t <= best.to.t && fin(r.lp));
  const lpMin = inside.length ? Math.min(...inside.map(r => r.lp)) : null;
  return { ...best, lpDelta: fin(best.to.lp) && fin(best.from.lp) ? best.to.lp - best.from.lp : null, lpMin };
}

function line(points, x, y, color, width = 1.6, dash) {
  const segs = []; let cur = [];
  points.forEach((p, i) => {
    if (!fin(p.v)) { if (cur.length) segs.push(cur); cur = []; return; }
    if (cur.length && p.t - points[i - 1].t > GAP_MS) { segs.push(cur); cur = []; }
    cur.push(`${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur);
  return segs.filter(s => s.length > 1).map(s => {
    const el = document.createElementNS(NS, 'polyline');
    el.setAttribute('points', s.join(' ')); el.setAttribute('fill', 'none'); el.setAttribute('stroke', color); el.setAttribute('stroke-width', width);
    el.setAttribute('vector-effect', 'non-scaling-stroke'); el.setAttribute('stroke-linejoin', 'round'); if (dash) el.setAttribute('stroke-dasharray', dash);
    return el;
  });
}
function text(x, y, value, anchor = 'start', color) {
  const el = document.createElementNS(NS, 'text'); el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('text-anchor', anchor);
  if (color) el.style.fill = color; el.textContent = value; return el;
}
function hline(x1, x2, y, color, dash) { const el = document.createElementNS(NS, 'line'); Object.entries({ x1, x2, y1: y, y2: y, stroke: color }).forEach(([k, v]) => el.setAttribute(k, v)); if (dash) el.setAttribute('stroke-dasharray', dash); return el; }
function vline(x, y1, y2, color, dash) { const el = document.createElementNS(NS, 'line'); Object.entries({ x1: x, x2: x, y1, y2, stroke: color }).forEach(([k, v]) => el.setAttribute(k, v)); if (dash) el.setAttribute('stroke-dasharray', dash); return el; }

export function renderExposure({ series, snapshot, rangeDays, lang, time, $ }) {
  const zh = lang === 'zh', L = (a, b) => zh ? a : b;
  const live = livePoint(snapshot), now = live?.[0] ?? Date.now();
  const raw = [...(series?.points ?? [])];
  if (live && (!raw.length || live[0] > raw.at(-1)[0])) raw.push(live);
  const from = rangeDays > 0 ? now - rangeDays * 86400000 : -Infinity;
  const rows = raw.filter(p => p[COLS.t] >= from).map(derive);

  // Current values (live snapshot first).
  const cur = live ? derive(live) : rows.at(-1);
  const inst = Object.fromEntries((snapshot?.trading?.instruments ?? []).map(i => [i.symbol, i]));
  const mid = Object.fromEntries((snapshot?.markets ?? []).map(m => [m.coin, m.mid]));
  const legNote = s => inst[s] && fin(mid[s]) ? L(`多 ${usd(inst[s].longOi * mid[s])} / 空 ${usd(inst[s].shortOi * mid[s])} · 多空比 ${(inst[s].longOi / inst[s].shortOi).toFixed(2)}`, `Long ${usd(inst[s].longOi * mid[s])} / short ${usd(inst[s].shortOi * mid[s])} · ratio ${(inst[s].longOi / inst[s].shortOi).toFixed(2)}`) : L('不可用', 'Unavailable');
  $('expBtc').textContent = signedUsd(cur?.btcNet); $('expBtcNote').textContent = legNote('BTC');
  $('expEth').textContent = signedUsd(cur?.ethNet); $('expEthNote').textContent = legNote('ETH');
  $('expTotal').textContent = signedUsd(cur?.total);
  $('expTotalNote').textContent = fin(cur?.long) && fin(cur?.short) ? L(`总持仓 ${usd(cur.long + cur.short)}（多 ${usd(cur.long)} / 空 ${usd(cur.short)}）· 交易者整体赚钱由 LP 赔`, `Open interest ${usd(cur.long + cur.short)} (long ${usd(cur.long)} / short ${usd(cur.short)}) · paid by the LP when traders win`) : L('交易者整体赚钱由 LP 赔', 'Paid out of the LP when traders win as a whole');
  const first = rows.find(r => fin(r.lp));
  $('expLp').textContent = usd(cur?.lp);
  $('expLpNote').textContent = first && fin(cur?.lp) ? L(`区间内 ${signedUsd(cur.lp - first.lp)}（${pct(cur.lp / first.lp - 1)}）`, `${signedUsd(cur.lp - first.lp)} over range (${pct(cur.lp / first.lp - 1)})`) : '—';
  const firstTvl = rows.find(r => fin(r.tvl));
  $('expTvl').textContent = usd(cur?.tvl);
  const book = snapshot?.sources?.traderBook?.ok ? snapshot.traderBook : null;
  $('expEffLp').textContent = book && fin(cur?.lp) ? usd(cur.lp - book.unrealizedPnl) : L('不可用', 'Unavailable');
  $('expEffLpNote').textContent = book ? L(`交易者浮盈亏 ${signedUsd(book.unrealizedPnl)}（赚 ${signedUsd(book.winners)} / 亏 ${signedUsd(book.losers)}，${book.accounts} 户）· 来自官方排行榜`, `Trader unrealized PnL ${signedUsd(book.unrealizedPnl)} (winners ${signedUsd(book.winners)} / losers ${signedUsd(book.losers)}, ${book.accounts} open accounts) · official leaderboard`) : L('排行榜数据拿不到', 'Leaderboard total unavailable');
  $('expTvlNote').textContent = firstTvl && fin(cur?.tvl) ? L(`区间内 ${signedUsd(cur.tvl - firstTvl.tvl)}`, `${signedUsd(cur.tvl - firstTvl.tvl)} over range`) : '—';

  const svg = $('exposureChart'); svg.replaceChildren();
  $('exposureState').textContent = !series ? L('历史数据拿不到，只显示当前值', 'History series unavailable (current values only)')
    : rows.length ? L(`${rows.length} 个点 · ${time(rows[0].t)} 起`, `${rows.length} points · from ${time(rows[0].t)}`) : L('区间内没有数据', 'No data in range');
  if (rows.length < 2) { $('exposureMove').textContent = ''; return; }

  const X0 = 64, X1 = 990, t0 = rows[0].t, t1 = rows.at(-1).t, x = t => X0 + (t - t0) / Math.max(1, t1 - t0) * (X1 - X0);
  const panels = [{ top: 22, h: 104 }, { top: 158, h: 142 }, { top: 332, h: 104 }];
  const scale = (vals, p, includeZero) => {
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08; lo -= pad; hi += pad;
    return { y: v => p.top + p.h - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * p.h, lo, hi };
  };
  const label = (p, value, color) => svg.append(text(X1 - 4, p.top - 6, value, 'end', color));

  // 1. BTC and ETH, % change from the start of the range: continuous 15m candle opens plus the live mid.
  const pctSeries = (coin, live) => {
    const pts = (series?.prices?.[coin] ?? []).filter(([t]) => t >= t0 && t <= t1).map(([t, v]) => ({ t, v }));
    if (fin(live) && cur.t > (pts.at(-1)?.t ?? 0)) pts.push({ t: cur.t, v: live });
    const base = pts.find(q => fin(q.v))?.v;
    return { pts: base ? pts.map(q => ({ t: q.t, v: q.v / base - 1, px: q.v })) : [], base };
  };
  const btcP = pctSeries('BTC', cur?.btcPx), ethP = pctSeries('ETH', cur?.ethPx);
  const s1 = scale([...btcP.pts, ...ethP.pts].map(q => q.v).filter(fin).concat(0), panels[0], true);
  svg.append(hline(X0, X1, s1.y(0), '#2c3a31', '3 3'));
  svg.append(...line(ethP.pts, x, s1.y, '#7fb2f0', 1.4), ...line(btcP.pts, x, s1.y, '#f0a35e', 1.6));
  svg.append(text(X0 - 6, s1.y(0) + 4, '0%', 'end'));
  // Axis extremes only when they sit clear of the zero label.
  if (s1.y(0) - panels[0].top > 18) svg.append(text(X0 - 6, panels[0].top + 10, pct(s1.hi, 0), 'end'));
  if (panels[0].top + panels[0].h - s1.y(0) > 18) svg.append(text(X0 - 6, panels[0].top + panels[0].h, pct(s1.lo, 0), 'end'));
  const lastPct = q => q.pts.length ? pct(q.pts.at(-1).v, 1) : '—';
  svg.append(text(X1 - 4, panels[0].top - 6, `ETH ${lastPct(ethP)}`, 'end', '#7fb2f0'), text(X1 - 84, panels[0].top - 6, `BTC ${lastPct(btcP)}`, 'end', '#f0a35e'),
    text(X0, panels[0].top - 6, L('涨跌幅（相对起点）', 'Price change from range start')));

  // 2. Scissors: total long vs total short notional (BTC + ETH); the shaded gap is the net exposure the LP carries.
  //    Rolling median sized to the range; axis from the 1st–99th percentile, spikes beyond it clipped.
  const w = Math.max(0, Math.round(rows.length / 400));
  const sm = { long: smooth(rows, 'long', w), short: smooth(rows, 'short', w) };
  const vals = [...sm.long, ...sm.short].filter(fin);
  const lo = vals.length ? quantile(vals, 0.01) : 0, hi = vals.length ? quantile(vals, 0.99) : 0;
  // Open interest is never negative: the axis starts at zero, with headroom only above.
  const top2 = hi * 1.08 || 1, s2 = { lo: 0, hi: top2, y: v => panels[1].top + panels[1].h - Math.min(top2, Math.max(0, v)) / top2 * panels[1].h };
  const clipped = vals.some(v => v < s2.lo || v > s2.hi);
  // Fill between the two lines, split into runs where the same side leads; runs break across data gaps.
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const longer = run.filter(q => q.l >= q.s).length >= run.length / 2;
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', [...run.map(q => `${x(q.t).toFixed(1)},${s2.y(q.l).toFixed(1)}`), ...[...run].reverse().map(q => `${x(q.t).toFixed(1)},${s2.y(q.s).toFixed(1)}`)].join(' '));
      poly.setAttribute('fill', longer ? '#f0a35e33' : '#7fb2f033'); svg.append(poly);
    }
    run = [];
  };
  rows.forEach((r, i) => {
    const q = { t: r.t, l: sm.long[i], s: sm.short[i] };
    if (!fin(q.l) || !fin(q.s)) return flush();
    const prev = run.at(-1);
    if (prev && (q.t - prev.t > GAP_MS || (q.l >= q.s) !== (prev.l >= prev.s))) { const keep = prev; flush(); if (q.t - keep.t <= GAP_MS) run.push(keep); }
    run.push(q);
  });
  flush();
  svg.append(...line(rows.map((r, i) => ({ t: r.t, v: sm.long[i] })), x, s2.y, '#f0a35e', 1.5), ...line(rows.map((r, i) => ({ t: r.t, v: sm.short[i] })), x, s2.y, '#7fb2f0', 1.5));
  svg.append(text(X0 - 6, panels[1].top + 10, usd(s2.hi), 'end'), text(X0 - 6, panels[1].top + panels[1].h, '$0', 'end'));
  svg.append(text(X1 - 4, panels[1].top - 6, L('空头持仓', 'Short OI'), 'end', '#7fb2f0'), text(X1 - 70, panels[1].top - 6, L('多头持仓', 'Long OI'), 'end', '#f0a35e'),
    text(X1 - 136, panels[1].top - 6, L('阴影是净敞口：橙色净多，蓝色净空', 'Shaded gap = net exposure (orange net long, blue net short)'), 'end'));
  if (clipped) svg.append(text(X0, panels[1].top - 6, L('纵轴取 1%–99% 分位，尖峰截掉', '1st–99th percentile axis; spikes clipped')));

  // 3. LP bankroll with the on-chain flat-zone threshold.
  const lps = rows.map(r => r.lp).filter(fin);
  const s3 = scale(lps, panels[2]);
  const cliff = snapshot?.sources?.tokenomics?.ok && fin(snapshot?.tokenomics?.cliff) ? snapshot.tokenomics.cliff : snapshot?.paper?.cliff;
  if (fin(cliff) && cliff > s3.lo && cliff < s3.hi) svg.append(hline(X0, X1, s3.y(cliff), '#f39c99', '4 4'), text(X0 + 4, s3.y(cliff) - 4, L(`${usd(cliff)} 平坦区阈值`, `${usd(cliff)} flat-zone threshold`), 'start', '#f39c99'));
  svg.append(...line(rows.map(r => ({ t: r.t, v: r.lp })), x, s3.y, '#b9f2b0', 1.8));
  svg.append(text(X0 - 6, panels[2].top + 10, usd(s3.hi), 'end'), text(X0 - 6, panels[2].top + panels[2].h, usd(s3.lo), 'end'));
  label(panels[2], L('LP 可用余额', 'LP bankroll'), '#b9f2b0');

  // Day ticks (Singapore time) along the bottom.
  const span = t1 - t0, step = span > 20 * 86400000 ? 5 * 86400000 : span > 6 * 86400000 ? 86400000 : span > 2 * 86400000 ? 12 * 3600000 : 6 * 3600000;
  const offset = 8 * 3600000;
  for (let t = Math.ceil((t0 + offset) / step) * step - offset; t <= t1; t += step) {
    const d = new Date(t + offset), tick = `${d.getUTCMonth() + 1}/${d.getUTCDate()}` + (step < 86400000 ? ` ${String(d.getUTCHours()).padStart(2, '0')}:00` : '');
    svg.append(text(x(t), 462, tick, 'middle'));
    svg.prepend(vline(x(t), 12, 444, '#1d2822'));
  }

  // Event markers.
  for (const e of EVENTS.filter(e => e.t >= t0 && e.t <= t1)) {
    svg.append(vline(x(e.t), 12, 444, '#f39c99', '2 3'), text(x(e.t) + 4, panels[2].top + panels[2].h - 4, e.short[zh ? 'zh' : 'en'], 'start', '#f39c99'));
  }

  const m = largestMove(rows);
  const events = EVENTS.filter(e => e.t >= t0 && e.t <= t1).map(e => L('标记：', 'Marked: ') + e[zh ? 'zh' : 'en'] + L(`，区块 ${e.block}。`, `, block ${e.block}.`)).join(' ');
  $('exposureMove').textContent = (m ? L(
    `区间内 12 小时最大单边：${time(m.from.t)} → ${time(m.to.t)}，BTC ${pct(m.move)}（${Math.round(m.from.btcPx).toLocaleString('en-US')} → ${Math.round(m.to.btcPx).toLocaleString('en-US')}）。起点 BTC 净持仓 ${signedUsd(m.from.btcNet)}、合计 ${signedUsd(m.from.total)}，同期 LP ${signedUsd(m.lpDelta)}，最低 ${usd(m.lpMin)}。`,
    `Largest one-way move in range (within 12h): ${time(m.from.t)} → ${time(m.to.t)}, BTC ${pct(m.move)} (${Math.round(m.from.btcPx).toLocaleString('en-US')} → ${Math.round(m.to.btcPx).toLocaleString('en-US')}). Trader BTC net at start ${signedUsd(m.from.btcNet)}, total ${signedUsd(m.from.total)}; LP ${signedUsd(m.lpDelta)} over the window, low ${usd(m.lpMin)}.`) : '') + (events ? ' ' + events : '');

  // Hover readout (raw bucket values, not the smoothed line).
  const tip = $('exposureTip'), cursor = vline(0, 12, 444, '#88958f', '2 3');
  cursor.setAttribute('visibility', 'hidden'); svg.append(cursor);
  svg.onmousemove = e => {
    const box = svg.getBoundingClientRect(), vx = (e.clientX - box.left) / box.width * 1000;
    const t = t0 + (vx - X0) / (X1 - X0) * (t1 - t0); let best = rows[0];
    for (const r of rows) if (Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
    cursor.setAttribute('x1', x(best.t)); cursor.setAttribute('x2', x(best.t)); cursor.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.textContent = '';
    for (const row of [time(best.t), `BTC $${fin(best.btcPx) ? Math.round(best.btcPx).toLocaleString('en-US') : '—'}`,
      `ETH $${fin(best.ethPx) ? Math.round(best.ethPx).toLocaleString('en-US') : '—'}`, L('多 ', 'Long ') + usd(best.long) + L(' / 空 ', ' / short ') + usd(best.short), L('合计净敞口 ', 'Total net ') + signedUsd(best.total), `BTC ${signedUsd(best.btcNet)} · ETH ${signedUsd(best.ethNet)}`, 'LP ' + usd(best.lp) + ' · treasury ' + usd(best.tvl), ...(fin(best.upnl) ? [L('交易者浮盈 ', 'Trader UPnL ') + signedUsd(best.upnl) + L(' · 扣除后 LP ', ' · LP net ') + usd(best.lp - best.upnl)] : [])]) { const d = document.createElement('div'); d.textContent = row; tip.append(d); }
    const left = (x(best.t) / 1000) * box.width; tip.style.left = Math.min(box.width - tip.offsetWidth - 8, Math.max(8, left + 12)) + 'px';
  };
  svg.onmouseleave = () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); };
}
