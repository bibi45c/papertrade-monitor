import { collect } from './collect.mjs';
import { saveSnapshot, latestSnapshot, getHistory, purgeExpired, exportDay, exportSnapshots } from './storage.mjs';

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
    try { return json(await liveSnapshot()); }
    catch (error) { return json({ error: '实时数据暂不可用：' + String(error.message ?? error).slice(0, 120) }, 503); }
  }
  if (url.pathname === '/api/health') return json({ ok: true, storage: db ? 'configured' : 'unconfigured', mode: 'public-read-only', historyRetentionDays: 90 });
  if (!db) return json({ error: '历史数据库尚未绑定；实时查询仍可使用。', storage: 'unconfigured' }, 503);
  if (url.pathname === '/api/latest') return json({ snapshot: await latestSnapshot(db) });
  if (url.pathname === '/api/archive') {
    const integerParam = (name, fallback) => { const value = url.searchParams.get(name); return value === null ? fallback : /^\d+$/.test(value) ? Number(value) : NaN; };
    try { return json(await exportSnapshots(db, { after: integerParam('after', 0), through: integerParam('through', Date.now()), limit: integerParam('limit', 120) })); }
    catch (error) { if (error instanceof RangeError) return json({ error: error.message }, 400); throw error; }
  }
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
      // 治理日志增量扫描依赖上一条记录的区块游标；每小时第 11 分钟检查一次文档和官方前端版本。
      let previous = null;
      try { previous = await latestSnapshot(env.DB); } catch { previous = null; }
      const minute = new Date(event.scheduledTime).getUTCMinutes();
      const snapshot = await collect({ previous, scanGov: true, checkWeb: minute === 11 || !previous?.web });
      await saveSnapshot(env.DB, snapshot);
      const time = new Date(event.scheduledTime);
      if (time.getUTCHours() === 0 && time.getUTCMinutes() === 17) await purgeExpired(env.DB, event.scheduledTime);
    })());
  },
};
