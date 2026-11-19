// Local preview only: copy the production auxiliary state and recent minute snapshots into data/history.sqlite.
// Reads the public read-only API; never writes anywhere but the local development database.
//   node scripts/seed-local.mjs [hours=30]
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const BASE = 'https://papertrade-monitor.papertrade-monitor.workers.dev';
const hours = Number(process.argv[2] ?? 30);
const file = root + 'data/history.sqlite';
if (existsSync(file)) copyFileSync(file, file + '.bak-' + new Date().toISOString().slice(0, 10));
const db = new DatabaseSync(file);
for (const m of ['0001_snapshots.sql', '0002_auxiliary.sql']) db.exec(readFileSync(root + 'migrations/' + m, 'utf8'));
const { saveSnapshot } = await import('../src/storage.mjs');
const shim = { prepare(sql) { let v = []; return { bind(...a) { v = a; return this; }, async run() { return db.prepare(sql).run(...v); } }; } };

const latest = (await (await fetch(BASE + '/api/latest')).json()).snapshot;
const aux = { collectedAt: latest.auxiliaryAt, completedAt: latest.auxiliaryAt, governance: latest.governance, protocolHours: latest.protocolHours, web: latest.web,
  sources: Object.fromEntries(['governance', 'protocolHistory', 'web'].map(k => [k, latest.sources[k] ? { ...latest.sources[k], retained: undefined } : null])) };
db.prepare("INSERT INTO auxiliary_state (name, updated_at, payload) VALUES ('current', ?, ?) ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload").run(aux.completedAt, JSON.stringify(aux));

let after = Date.now() - hours * 3600000, through = Date.now(), added = 0;
for (;;) {
  const page = await (await fetch(`${BASE}/api/archive?after=${after}&through=${through}&limit=120`)).json();
  for (const r of page.rows) { await saveSnapshot(shim, r.snapshot); added++; }
  after = page.nextAfter; if (page.complete) break;
}
console.log(JSON.stringify({ added, auxiliaryAt: new Date(aux.completedAt).toISOString() }));
