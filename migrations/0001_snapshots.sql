CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  collected_at INTEGER NOT NULL UNIQUE,
  paper_source_at INTEGER,
  paper_supply REAL,
  staked_supply REAL,
  pending_rewards REAL,
  reward_accumulator TEXT,
  lp_balance REAL,
  queue_debt REAL,
  queue_count INTEGER,
  btc_mid REAL,
  eth_mid REAL,
  hype_mid REAL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(collected_at);
