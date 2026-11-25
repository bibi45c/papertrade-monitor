// Hourly protocol state straight from the Paper contracts, for hours with no stored snapshot.
// Read-only public RPC calls; values are the contracts' own numbers at the block nearest each hour, never interpolated.
import { readJson, checkRpcError, ReadError } from './read-retry.mjs';

// Getters verified 2026-11-19 against /query/protocol/summary at the same block (exact equality).
export const CHAIN_READS = Object.freeze({
  paper_supply: ['0xe40f17915daa230324030003a197cdaef2261c0e', '0x18160ddd'],   // PAPER totalSupply()
  staked_supply: ['0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016', '0x817b1cd2'],  // staking: total staked
  accumulator: ['0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016', '0x939d6237'],    // staking: reward accumulator (1e27)
  pending_rewards: ['0x6cd5661646289fb6e65ea5c032310fded797d0a2', '0xafdf6702'], // Exchange: pending protocol rewards
  reserve: ['0xaad6c7b0cc3014fc80ffedae0ed7ce5967b0f016', '0xcab64bcd'],        // staking: reserve
  lp_balance: ['0x6cd5661646289fb6e65ea5c032310fded797d0a2', '0x0cdd5fc4'],      // Exchange lpBankrollAvailable()
  treasury: ['0x6cd5661646289fb6e65ea5c032310fded797d0a2', '0x61d027b3'],        // Exchange treasury()
});
export const INDEX_RPC = 'https://rpc.hyperlend.finance/archive'; // archive node: historical eth_call by block number
export const CHAIN_FROM = Date.parse('2026-10-10T16:00:00Z');   // first full hour after the monitor's first record
const HOUR = 3600000, TOLERANCE = 120000, GROUP = 24;

async function batch(fetcher, requests) {
  const value = await readJson(INDEX_RPC, requests, fetcher, { validate: v => {
    if (!Array.isArray(v)) { checkRpcError(v); throw new Error('Unknown RPC batch'); }
    for (const r of v) checkRpcError(r);
    if (!requests.every(q => v.some(r => r.id === q.id && 'result' in r))) throw new ReadError('Incomplete RPC batch', true);
    return v;
  } });
  return requests.map(q => value.find(r => r.id === q.id).result);
}

// Complete hours since `from` with neither a stored snapshot within ±2 minutes of the hour nor a chain row.
export async function missingHours(db, now, from = CHAIN_FROM) {
  const end = Math.floor(now / HOUR) * HOUR, have = new Set();
  // Index range lookups around each hour boundary (reads a few rows per hour, not every stored minute); CROSS JOIN pins that loop order.
  const snaps = await db.prepare(`WITH RECURSIVE hours(h) AS (SELECT ?1 UNION ALL SELECT h + ${HOUR} FROM hours WHERE h + ${HOUR} <= ?2)
    SELECT s.collected_at FROM hours CROSS JOIN snapshots s ON s.collected_at BETWEEN hours.h - ${TOLERANCE} AND hours.h + ${TOLERANCE} WHERE s.reward_accumulator IS NOT NULL`).bind(from, end).all();
  for (const r of snaps.results ?? []) have.add(Math.round(r.collected_at / HOUR) * HOUR);
  const chain = await db.prepare('SELECT hour_at FROM chain_hourly WHERE hour_at >= ? AND hour_at <= ?').bind(from, end).all();
  for (const r of chain.results ?? []) have.add(r.hour_at);
  const out = [];
  for (let t = from; t <= end; t += HOUR) if (!have.has(t)) out.push(t);
  return out;
}

export async function readChainHours(targets, { fetcher = fetch } = {}) {
  if (!targets.length) return [];
  const [head] = await batch(fetcher, [{ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }]);
  const hn = Number(BigInt(head.number)), ht = Number(BigInt(head.timestamp));
  const [ref] = await batch(fetcher, [{ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + (hn - 500000).toString(16), false] }]);
  const rate = 500000 / (ht - Number(BigInt(ref.timestamp)));
  const out = [];
  for (let g = 0; g < targets.length; g += GROUP) {
    const group = targets.slice(g, g + GROUP);
    let blocks = group.map(t => Math.round(hn - (ht - t / 1000) * rate)), stamps = [];
    for (let pass = 0; pass < 3; pass++) {
      const res = await batch(fetcher, blocks.map((b, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), false] })));
      stamps = res.map(r => Number(BigInt(r.timestamp)) * 1000);
      if (pass < 2) blocks = blocks.map((b, i) => b + Math.round((group[i] - stamps[i]) / 1000 * rate));
    }
    const keys = Object.keys(CHAIN_READS), calls = [];
    blocks.forEach((b, i) => keys.forEach((k, j) => calls.push({ jsonrpc: '2.0', id: i * keys.length + j + 1, method: 'eth_call', params: [{ to: CHAIN_READS[k][0], data: CHAIN_READS[k][1] }, '0x' + b.toString(16)] })));
    const res = await batch(fetcher, calls);
    group.forEach((t, i) => {
      if (Math.abs(stamps[i] - t) > TOLERANCE) return; // a block too far from the hour is skipped, not stored
      const row = { hourAt: t, block: blocks[i], blockAt: stamps[i] };
      keys.forEach((k, j) => { const r = res[i * keys.length + j]; row[k] = /^0x[0-9a-f]{64}/i.test(r) ? BigInt(r.slice(0, 66)).toString() : null; });
      out.push(row);
    });
  }
  return out;
}

export async function fillChainHourly(db, { now = Date.now(), fetcher = fetch, maxHours = 48, from = CHAIN_FROM } = {}) {
  const missing = await missingHours(db, now, from);
  // Newest first, so the 48-hour dividend window is complete before older history.
  const targets = missing.slice(-maxHours).reverse();
  const rows = await readChainHours(targets, { fetcher });
  const readAt = Date.now(), keys = Object.keys(CHAIN_READS);
  for (const r of rows) await db.prepare(`INSERT OR IGNORE INTO chain_hourly (hour_at, block, block_at, ${keys.join(', ')}, read_at) VALUES (?, ?, ?, ${keys.map(() => '?').join(', ')}, ?)`)
    .bind(r.hourAt, r.block, r.blockAt, ...keys.map(k => r[k]), readAt).run();
  return { missing: missing.length, stored: rows.length };
}
