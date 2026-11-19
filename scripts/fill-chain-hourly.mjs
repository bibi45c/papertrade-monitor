// Local/maintenance: fill every missing hour in chain_hourly at once (the Worker does 48 hours per auxiliary run).
//   node scripts/fill-chain-hourly.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fillChainHourly } from '../src/chain-index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const native = new DatabaseSync(root + 'data/history.sqlite');
native.exec(readFileSync(root + 'migrations/0003_chain_hourly.sql', 'utf8'));
const db = { prepare(sql) { let v = []; return { bind(...a) { v = a; return this; }, async run() { return native.prepare(sql).run(...v); }, async all() { return { results: native.prepare(sql).all(...v) }; } }; } };
for (let i = 0; i < 40; i++) {
  const r = await fillChainHourly(db, { maxHours: 96 });
  console.log(JSON.stringify(r));
  if (!r.missing || !r.stored) break;
}
console.log(native.prepare('SELECT COUNT(*) n, MIN(hour_at) a, MAX(hour_at) b FROM chain_hourly').get());
