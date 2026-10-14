export const columns = ['collected_at', 'paper_source_at', 'paper_supply', 'staked_supply', 'pending_rewards', 'reward_accumulator', 'lp_balance', 'queue_debt', 'queue_count', 'btc_mid', 'eth_mid', 'hype_mid'];
const queueFields = { execution_source_at: 'sourceAt', execution_queued: 'queuedIntents', execution_submitted: 'submittedIntents', execution_capacity_blocks: 'capacityBlocks', execution_saturation_pct: 'saturationPct' };
// 风险监控字段同样从快照 JSON 读取，旧样本为 null；不需要迁移表结构。
const riskFields = { net_trader_notional: '$.lpRisk.netNotional', lp_up_to_cliff: '$.lpRisk.up.toCliff', lp_up_to_zero: '$.lpRisk.up.toZero', lp_down_to_cliff: '$.lpRisk.down.toCliff', lp_down_to_zero: '$.lpRisk.down.toZero',
  jump_btc_1s: '$.jumps.BTC.max1s', jump_btc_10s: '$.jumps.BTC.max10s', jump_eth_1s: '$.jumps.ETH.max1s', jump_eth_10s: '$.jumps.ETH.max10s' };
const countFields = { listing_alerts: '$.listing.alerts', gov_operations: '$.governance.operations' };
export const exportColumns = [...columns, ...Object.keys(queueFields), ...Object.keys(riskFields), ...Object.keys(countFields)];
const historySelect = [...columns, ...Object.entries(queueFields).map(([name, field]) => `CASE WHEN json_extract(payload, '$.executionQueue.available') = 1 THEN json_extract(payload, '$.executionQueue.${field}') END AS ${name}`),
  ...Object.entries(riskFields).map(([name, path]) => `json_extract(payload, '${path}') AS ${name}`),
  ...Object.entries(countFields).map(([name, path]) => `CASE WHEN json_type(payload, '${path}') = 'array' THEN json_array_length(payload, '${path}') END AS ${name}`)].join(',');

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

export async function loadAuxiliary(db) {
  const row = await db.prepare("SELECT payload FROM auxiliary_state WHERE name = 'current'").first();
  return row ? JSON.parse(row.payload) : null;
}

export async function saveAuxiliary(db, state) {
  await db.prepare("INSERT INTO auxiliary_state (name, updated_at, payload) VALUES ('current', ?, ?) ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload WHERE excluded.updated_at > auxiliary_state.updated_at")
    .bind(state.collectedAt, JSON.stringify(state)).run();
}

// Full stored payloads, without aggregation or numeric conversion. Bounded pages
// allow the archive to keep exact raw strings and source failure information.
export async function exportSnapshots(db, { after = 0, through = Date.now(), limit = 120 } = {}) {
  if (![after, through, limit].every(Number.isSafeInteger) || after < 0 || through < after || limit < 1 || limit > 120) throw new RangeError('Invalid archive cursor, upper bound or limit (1-120)');
  const data = await db.prepare('SELECT collected_at, payload FROM snapshots WHERE collected_at > ? AND collected_at <= ? ORDER BY collected_at LIMIT ?').bind(after, through, limit + 1).all();
  const selected = (data.results ?? []).slice(0, limit);
  const available = await db.prepare('SELECT MIN(collected_at) AS oldestAt, MAX(collected_at) AS latestAt, COUNT(*) AS count FROM snapshots WHERE collected_at <= ?').bind(through).first();
  return { version: 1, through, available, rows: selected.map(r => ({ collectedAt: r.collected_at, snapshot: JSON.parse(r.payload) })),
    nextAfter: selected.at(-1)?.collected_at ?? after, complete: (data.results ?? []).length <= limit };
}

export async function getHistory(db, hours = 24, now = Date.now()) {
  const bounded = Math.min(2160, Math.max(1, Number.isFinite(hours) ? hours : 24));
  const bucket = Math.max(60000, Math.ceil(bounded * 60 / 1440) * 60000);
  const rows = await db.prepare(`SELECT ${historySelect} FROM snapshots WHERE collected_at IN (SELECT MAX(collected_at) FROM snapshots WHERE collected_at >= ? GROUP BY CAST(collected_at / ? AS INTEGER)) ORDER BY collected_at`).bind(now - bounded * 3600000, bucket).all();
  return { hours: bounded, bucketMs: bucket, rows: rows.results ?? [] };
}

// Small public response: exact index strings near hourly boundaries plus the latest
// sample. No payload JSON extraction or synthetic filling of missing boundaries.
export async function getDividendHistory(db, now = Date.now()) {
  const endAt = Math.floor(now / 3600000) * 3600000, from = endAt - 48 * 3600000 - 120000;
  const data = await db.prepare(`SELECT collected_at, reward_accumulator FROM snapshots
    WHERE collected_at >= ? AND collected_at <= ? AND
    ((collected_at <= ? AND (collected_at % 3600000 <= 120000 OR collected_at % 3600000 >= 3480000))
      OR collected_at = (SELECT MAX(collected_at) FROM snapshots))
    ORDER BY collected_at LIMIT 246`).bind(from, now, endAt + 120000).all();
  return { hours: 48, endAt, boundaryToleranceMs: 120000, rows: data.results ?? [] };
}

export async function purgeExpired(db, now) {
  await db.prepare('DELETE FROM snapshots WHERE collected_at < ?').bind(now - 90 * 86400000).run();
}

export async function exportDay(db, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期必须为 YYYY-MM-DD (UTC)');
  const from = Date.parse(day + 'T00:00:00Z');
  if (!Number.isFinite(from) || new Date(from).toISOString().slice(0, 10) !== day) throw new Error('无效日期');
  const data = await db.prepare(`SELECT ${historySelect} FROM snapshots WHERE collected_at >= ? AND collected_at < ? ORDER BY collected_at LIMIT 1440`).bind(from, from + 86400000).all();
  const escape = x => x === null || x === undefined ? '' : `"${String(x).replaceAll('"', '""')}"`;
  return exportColumns.join(',') + '\n' + (data.results ?? []).map(r => exportColumns.map(k => escape(r[k])).join(',')).join('\n') + '\n';
}
