// Dividends and dilution history: PAPER supply and cumulative dividends per 10,000 PAPER since the range start.
// Same visual language as the exposure chart: left axis labels, Singapore-time ticks, gaps left open, hover readout.
const NS = 'http://www.w3.org/2000/svg';
const fin = Number.isFinite;
const compact = v => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 3 }).format(v);
const el = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text !== undefined) n.textContent = text; return n; };

function polyline(points, x, y, color, gapMs, width = 1.7, fill) {
  const out = []; let cur = [];
  points.forEach((p, i) => {
    if (!fin(p.v)) { if (cur.length) out.push(cur); cur = []; return; }
    if (cur.length && p.t - points[i - 1].t > gapMs) { out.push(cur); cur = []; }
    cur.push(p);
  });
  if (cur.length) out.push(cur);
  return out.filter(s => s.length > 1).flatMap(s => {
    const pts = s.map(p => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
    const nodes = [el('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': width, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' })];
    if (fill) nodes.unshift(el('polygon', { points: [...pts, `${x(s.at(-1).t).toFixed(1)},${fill.base}`, `${x(s[0].t).toFixed(1)},${fill.base}`].join(' '), fill: fill.color }));
    return nodes;
  });
}

export function renderSupplyChart({ svg, tip, rows, lang, time }) {
  const zh = lang === 'zh', L = (a, b) => zh ? a : b;
  svg.replaceChildren();
  const supply = rows.filter(r => fin(r.paper_supply)).map(r => ({ t: r.collected_at, v: r.paper_supply }));
  const acc = rows.filter(r => typeof r.reward_accumulator === 'string' && /^\d+$/.test(r.reward_accumulator));
  if (supply.length < 2) { svg.append(el('text', { x: 500, y: 130, 'text-anchor': 'middle', fill: '#88958f' }, L('至少需要两个有效样本', 'At least two valid samples are needed'))); return; }
  const base = acc.length ? BigInt(acc[0].reward_accumulator) : null;
  const div = acc.map(r => ({ t: r.collected_at, v: Number(BigInt(r.reward_accumulator) - base) / 1e27 * 10000 }));
  const t0 = Math.min(supply[0].t, div[0]?.t ?? Infinity), t1 = Math.max(supply.at(-1).t, div.at(-1)?.t ?? -Infinity);
  const X0 = 70, X1 = 990, x = t => X0 + (t - t0) / Math.max(1, t1 - t0) * (X1 - X0);
  // Hourly on-chain rows fill outage periods, so a line may span up to ~65 minutes between points.
  const step = rows.length > 2 ? Math.max(60000, (t1 - t0) / rows.length) : 60000, gapMs = Math.max(step * 3.5, 65 * 60000);
  const panels = [{ top: 22, h: 96 }, { top: 150, h: 84 }];
  const scale = (vals, p) => { let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo || Math.abs(hi) || 1) * 0.08; lo = lo >= 0 ? Math.max(0, lo - pad) : lo - pad; hi += pad; return { lo, hi, y: v => p.top + p.h - (v - lo) / (hi - lo) * p.h }; };

  const s1 = scale(supply.map(p => p.v), panels[0]);
  svg.append(...polyline(supply, x, s1.y, '#b9f2b0', gapMs, 1.8, { base: panels[0].top + panels[0].h, color: '#b9f2b014' }));
  svg.append(el('text', { x: X0 - 6, y: panels[0].top + 10, 'text-anchor': 'end' }, compact(s1.hi)), el('text', { x: X0 - 6, y: panels[0].top + panels[0].h, 'text-anchor': 'end' }, compact(s1.lo)));
  const growth = supply.at(-1).v / supply[0].v - 1;
  svg.append(el('text', { x: X1 - 4, y: panels[0].top - 8, 'text-anchor': 'end', fill: '#b9f2b0' }, L(`PAPER 总供应 · 区间 +${(growth * 100).toPrecision(3)}%`, `PAPER supply · +${(growth * 100).toPrecision(3)}% in range`)));

  if (div.length > 1) {
    const s2 = scale(div.map(p => p.v).concat(0), panels[1]);
    svg.append(...polyline(div, x, s2.y, '#e5c489', gapMs, 1.8, { base: panels[1].top + panels[1].h, color: '#e5c48914' }));
    svg.append(el('text', { x: X0 - 6, y: panels[1].top + 10, 'text-anchor': 'end' }, s2.hi.toPrecision(3) + ' U'), el('text', { x: X0 - 6, y: panels[1].top + panels[1].h, 'text-anchor': 'end' }, '0 U'));
    svg.append(el('text', { x: X1 - 4, y: panels[1].top - 8, 'text-anchor': 'end', fill: '#e5c489' }, L(`每万枚累计分红 · 区间 ${div.at(-1).v.toPrecision(3)} U`, `Cumulative dividends per 10,000 PAPER · ${div.at(-1).v.toPrecision(3)} U in range`)));
  }

  // Singapore-time ticks.
  const span = t1 - t0, offset = 8 * 3600000;
  const tick = [3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000, 86400000, 5 * 86400000].find(s => span / s <= 8) ?? 10 * 86400000;
  for (let t = Math.ceil((t0 + offset) / tick) * tick - offset; t <= t1; t += tick) {
    const d = new Date(t + offset), label = tick >= 86400000 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : `${String(d.getUTCHours()).padStart(2, '0')}:00`;
    svg.prepend(el('line', { x1: x(t), x2: x(t), y1: 12, y2: 236, stroke: '#1d2822' }));
    svg.append(el('text', { x: x(t), y: 254, 'text-anchor': 'middle' }, label));
  }

  const cursor = el('line', { y1: 12, y2: 236, stroke: '#88958f', 'stroke-dasharray': '2 3', visibility: 'hidden' }); svg.append(cursor);
  const nearest = (list, t) => list.reduce((b, p) => !b || Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b, null);
  svg.onmousemove = e => {
    const box = svg.getBoundingClientRect(), t = t0 + ((e.clientX - box.left) / box.width * 1000 - X0) / (X1 - X0) * (t1 - t0);
    const s = nearest(supply, t), d = nearest(div, t);
    cursor.setAttribute('x1', x(s.t)); cursor.setAttribute('x2', x(s.t)); cursor.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.textContent = '';
    for (const row of [time(s.t), L('总供应 ', 'Supply ') + s.v.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' PAPER', ...(d ? [L('累计分红 ', 'Cumulative dividends ') + d.v.toPrecision(4) + L(' U / 万枚', ' U per 10,000')] : [])]) { const n = document.createElement('div'); n.textContent = row; tip.append(n); }
    const left = x(s.t) / 1000 * box.width; tip.style.left = Math.min(box.width - tip.offsetWidth - 8, Math.max(8, left + 12)) + 'px';
  };
  svg.onmouseleave = () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); };
}
