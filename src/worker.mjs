import { collect } from './collect.mjs';
import { saveSnapshot, latestSnapshot, getHistory, purgeExpired, exportDay } from './storage.mjs';

let pending = null, hot = null;
export async function liveSnapshot() {
  if (hot && Date.now() - hot.completedAt < 8000) return hot;
  pending ??= collect().then(s => { hot = s; return s; }).finally(() => { pending = null; });
  return pending;
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function api(request, db) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return json({ error: 'Only GET requests are accepted' }, 405);
  if (url.pathname === '/api/live') return json(await liveSnapshot());
  if (url.pathname === '/api/health') return json({ ok: true, storage: db ? 'configured' : 'unconfigured', mode: 'public-read-only', historyRetentionDays: 90 });
  if (!db) return json({ error: '历史数据库尚未绑定；实时查询仍可使用。', storage: 'unconfigured' }, 503);
  if (url.pathname === '/api/latest') return json({ snapshot: await latestSnapshot(db) });
  if (url.pathname === '/api/history') return json(await getHistory(db, Number(url.searchParams.get('hours') ?? 24)));
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
      const snapshot = await collect();
      await saveSnapshot(env.DB, snapshot);
      const time = new Date(event.scheduledTime);
      if (time.getUTCHours() === 0 && time.getUTCMinutes() === 17) await purgeExpired(env.DB, event.scheduledTime);
    })());
  },
};
