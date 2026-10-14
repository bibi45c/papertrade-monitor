import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { api, runScheduled } from '../src/worker.mjs';
import { purgeExpired } from '../src/storage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(root + 'data', { recursive: true });
const database = new DatabaseSync(root + 'data/history.sqlite');
database.exec(await readFile(root + 'migrations/0001_snapshots.sql', 'utf8'));
database.exec(await readFile(root + 'migrations/0002_auxiliary.sql', 'utf8'));
const db = { prepare(sql) { let values = []; return {
  bind(...args) { values = args; return this; },
  async run() { return database.prepare(sql).run(...values); },
  async first() { return database.prepare(sql).get(...values) ?? null; },
  async all() { return { results: database.prepare(sql).all(...values) }; },
}; } };
// 与云端定时任务一致：沿用上一条记录的治理扫描游标，每小时第 11 分钟检查文档与前端版本。
const save = async () => {
  try {
    await runScheduled({ cron: '* * * * *', scheduledTime: Date.now() }, db);
    await purgeExpired(db, Date.now());
  } catch (error) { console.error('采集失败:', error.message); }
};
await save();
setInterval(save, 60000).unref();
const enrich = () => runScheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, db).catch(error => console.error('辅助采集失败:', error.message));
await enrich();
setInterval(enrich, 5 * 60000).unref();
const port = Number(process.env.PORT ?? 8787);
const types = { html: 'text/html;charset=utf-8', css: 'text/css;charset=utf-8', mjs: 'text/javascript;charset=utf-8', svg: 'image/svg+xml' };
const allowed = new Set(['index.html', 'style.css', 'app.mjs', 'model.mjs', 'profit-cache.mjs', 'i18n.mjs', 'translations.mjs', 'favicon.svg']);
http.createServer(async (req, res) => {
  const origin = `http://127.0.0.1:${port}`;
  try {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const response = await api(new Request(url, { method: req.method }), db);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!allowed.has(name)) { res.writeHead(404); res.end('Not found'); return; }
    const content = name === 'model.mjs' ? await readFile(root + 'src/model.mjs') : await readFile(root + 'public/' + name);
    res.writeHead(200, { 'Content-Type': types[name.split('.').at(-1)] ?? 'text/plain', 'Cache-Control': 'no-store' }); res.end(content);
  } catch (error) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
}).listen(port, '127.0.0.1', () => console.log(`Papertrade Monitor http://127.0.0.1:${port} | 本地历史 ${root}data/history.sqlite`));
