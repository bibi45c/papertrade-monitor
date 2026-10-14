import { collect } from './collect.mjs';
import { saveSnapshot, latestSnapshot, getHistory, getDividendHistory, purgeExpired, exportDay, exportSnapshots, loadAuxiliary, saveAuxiliary } from './storage.mjs';
import { collectAuxiliary, attachAuxiliary } from './auxiliary.mjs';

// Workers 不能跨请求共享进行中的 I/O：发起采集的请求被客户端取消后，共享的 Promise 永远不结束，
// 同一实例后续未命中缓存的 /api/live 会全部挂起。所以每个请求自己采集，只复用 8 秒内已完成的结果，
// 并加整体时限，超时返回 503 而不是挂住。
let hot = null;
export async function liveSnapshot({ collector = collect, deadlineMs = 20000 } = {}) {
  if (hot && Date.now() - hot.completedAt < 8000) return hot;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('实时采集超时')), deadlineMs); });
  try { const snapshot = await Promise.race([collector(), timeout]); hot = snapshot; return snapshot; }
  finally { clearTimeout(timer); }
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function api(request, db) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return json({ error: 'Only GET requests are accepted' }, 405);
  if (url.pathname === '/api/live') {
    try {
      const auxiliary = db ? await loadAuxiliary(db).catch(() => null) : null;
      return json(attachAuxiliary(await liveSnapshot({ collector: () => collect({ auxiliary: false, deriveRisk: false }) }), auxiliary));
    }
    catch (error) { return json({ error: '实时数据暂不可用：' + String(error.message ?? error).slice(0, 120) }, 503); }
  }
  if (url.pathname === '/api/health') return json({ ok: true, storage: db ? 'configured' : 'unconfigured', mode: 'public-read-only', historyRetentionDays: 90 });
  if (!db) return json({ error: '历史数据库尚未绑定；实时查询仍可使用。', storage: 'unconfigured' }, 503);
  if (url.pathname === '/api/latest') return json({ snapshot: attachAuxiliary(await latestSnapshot(db), await loadAuxiliary(db).catch(() => null)) });
  if (url.pathname === '/api/archive') {
    const integerParam = (name, fallback) => { const value = url.searchParams.get(name); return value === null ? fallback : /^\d+$/.test(value) ? Number(value) : NaN; };
    try { return json(await exportSnapshots(db, { after: integerParam('after', 0), through: integerParam('through', Date.now()), limit: integerParam('limit', 120) })); }
    catch (error) { if (error instanceof RangeError) return json({ error: error.message }, 400); throw error; }
  }
  if (url.pathname === '/api/history') return json(await getHistory(db, Number(url.searchParams.get('hours') ?? 24)));
  if (url.pathname === '/api/dividend-history') return json(await getDividendHistory(db));
  if (url.pathname === '/api/export.csv') {
    const day = url.searchParams.get('day') ?? new Date().toISOString().slice(0, 10);
    try { return new Response(await exportDay(db, day), { headers: { 'Content-Type': 'text/csv;charset=utf-8', 'Content-Disposition': `attachment; filename="papertrade-${day}.csv"`, 'Cache-Control': 'no-store' } }); }
    catch (error) { return json({ error: error.message }, 400); }
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/live' && request.method === 'GET') {
      const cache = caches.default, key = new Request(url.origin + '/api/live');
      const cached = await cache.match(key); if (cached) return cached;
      const response = await api(request, env.DB);
      if (!response.ok) return response;
      response.headers.set('Cache-Control', 'public, max-age=8');
      ctx.waitUntil(cache.put(key, response.clone()));
      return response;
    }
    try { return await api(request, env.DB); }
    catch { return json({ error: '历史存储请求失败，请检查数据库迁移和服务状态。' }, 503); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.DB) throw new Error('D1 DB binding is required for scheduled collection');
      await runScheduled(event, env.DB);
      const time = new Date(event.scheduledTime);
      if (time.getUTCHours() === 0 && time.getUTCMinutes() === 17) await purgeExpired(env.DB, event.scheduledTime);
    })());
  },
};

export async function runScheduled(event, db, { coreCollector = collect, auxiliaryCollector = collectAuxiliary, logger = console } = {}) {
  const start = Date.now();
  const auxiliaryRun = event.cron === '*/5 * * * *';
  const kind = auxiliaryRun ? 'auxiliary' : 'core';
  logger.log(JSON.stringify({ type: 'collection-start', kind, scheduledAt: event.scheduledTime }));
  try {
    const previous = await loadAuxiliary(db).catch(() => null);
    if (auxiliaryRun) {
      const seed = previous ?? await latestSnapshot(db);
      const state = await auxiliaryCollector({ previous: seed, checkWeb: !seed?.web || start - seed.web.at >= 3600000 });
      await saveAuxiliary(db, state);
      logger.log(JSON.stringify({ type: 'collection-saved', kind, collectedAt: state.collectedAt, durationMs: Date.now() - start, failedSources: Object.keys(state.sources).filter(k => !state.sources[k].ok) }));
    } else {
      const snapshot = await coreCollector({ previous, auxiliary: false, deriveRisk: false });
      await saveSnapshot(db, snapshot);
      logger.log(JSON.stringify({ type: 'collection-saved', kind, collectedAt: snapshot.collectedAt, durationMs: Date.now() - start, failedSources: Object.keys(snapshot.sources).filter(k => !snapshot.sources[k].ok && !snapshot.sources[k].disabled) }));
    }
  } catch (error) {
    logger.error(JSON.stringify({ type: 'collection-failed', kind, scheduledAt: event.scheduledTime, error: String(error.message ?? error).slice(0, 180) }));
    throw error;
  }
}
