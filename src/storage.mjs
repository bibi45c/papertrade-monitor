export const columns = ['collected_at', 'paper_source_at', 'paper_supply', 'staked_supply', 'pending_rewards', 'reward_accumulator', 'lp_balance', 'queue_debt', 'queue_count', 'btc_mid', 'eth_mid', 'hype_mid'];

export async function saveSnapshot(db, snapshot) {
  if (!db) return false;
  const values = [Math.floor(snapshot.collectedAt / 60000) * 60000, snapshot.paperSourceAt ?? null,
    snapshot.paper?.supply ?? null, snapshot.paper?.staked ?? null, snapshot.paper?.pendingRewards ?? null, snapshot.rewardAccumulatorRaw ?? null,
    snapshot.balances?.lp ?? null, snapshot.queue?.total ?? null, snapshot.queue?.count ?? null,
    ...['BTC', 'ETH', 'HYPE'].map(coin => snapshot.markets.find(m => m.coin === coin)?.mid ?? null)];
  await db.prepare(`INSERT OR IGNORE INTO snapshots (${columns.join(',')}, payload) VALUES (${values.map(() => '?').join(',')}, ?)`).bind(...values, JSON.stringify(snapshot)).run();
  return true;
}

export async function latestSnapshot(db) {
  const row = await db.prepare('SELECT payload FROM snapshots ORDER BY collected_at DESC LIMIT 1').first();
  return row ? JSON.parse(row.payload) : null;
}

export async function getHistory(db, hours = 24, now = Date.now()) {
  const bounded = Math.min(2160, Math.max(1, Number.isFinite(hours) ? hours : 24));
  const bucket = Math.max(60000, Math.ceil(bounded * 60 / 1440) * 60000);
  const rows = await db.prepare(`SELECT ${columns.join(',')} FROM snapshots WHERE collected_at IN (SELECT MAX(collected_at) FROM snapshots WHERE collected_at >= ? GROUP BY CAST(collected_at / ? AS INTEGER)) ORDER BY collected_at`).bind(now - bounded * 3600000, bucket).all();
  return { hours: bounded, bucketMs: bucket, rows: rows.results ?? [] };
}

export async function purgeExpired(db, now) {
  await db.prepare('DELETE FROM snapshots WHERE collected_at < ?').bind(now - 90 * 86400000).run();
}

export async function exportDay(db, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期必须为 YYYY-MM-DD (UTC)');
  const from = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(from) || new Date(from).toISOString().slice(0, 10) !== day) throw new Error('无效日期');
  const data = await db.prepare(`SELECT ${columns.join(',')} FROM snapshots WHERE collected_at >= ? AND collected_at < ? ORDER BY collected_at LIMIT 1440`).bind(from, from + 86400000).all();
  const escape = x => x === null || x === undefined ? '' : `"${String(x).replaceAll('"', '""')}"`;
  return columns.join(',') + '\n' + (data.results ?? []).map(r => columns.map(k => escape(r[k])).join(',')).join('\n') + '\n';
}
