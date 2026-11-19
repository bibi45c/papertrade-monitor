// Local/maintenance: repeatedly run the governance scan until historical gaps are healed, then save auxiliary_state.
// Uses the same scanGovernance (official head chunk + archive RPC for gaps). Writes only the local development database.
//   node scripts/heal-governance.mjs [maxRuns=20]
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { scanGovernance } from '../src/watch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const db = new DatabaseSync(root + 'data/history.sqlite');
const row = db.prepare("SELECT payload FROM auxiliary_state WHERE name = 'current'").get();
if (!row) throw new Error('No auxiliary_state to heal');
const aux = JSON.parse(row.payload);
let g = aux.governance;
for (let run = 0; run < Number(process.argv[2] ?? 20) && g?.gaps?.length; run++) {
  try { g = await scanGovernance({ previous: g, maxGapChunks: 10 }); }
  catch (error) { console.log('run', run, 'failed:', error.message); await new Promise(r => setTimeout(r, 5000)); continue; }
  console.log(JSON.stringify({ run, gaps: g.gaps.length, blocks: g.gaps.reduce((s, [a, b]) => s + b - a + 1, 0), readErrors: g.readErrors.length, ops: g.operations.length, events: g.recentEvents.length }));
}
const now = Date.now();
const next = { ...aux, governance: { ...g, stale: g.readErrors.length > 0 }, completedAt: now, collectedAt: now, sources: { ...aux.sources, governance: { ok: g.readErrors.length === 0, at: now, block: g.block } } };
db.prepare("UPDATE auxiliary_state SET updated_at = ?, payload = ? WHERE name = 'current'").run(now, JSON.stringify(next));
console.log('saved', g.gaps.length === 0 ? 'coverage complete' : g.gaps.length + ' gaps left');
