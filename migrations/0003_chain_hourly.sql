-- Hour-boundary protocol state read directly from the Paper contracts at the block nearest each UTC hour.
-- Fills hours that have no stored minute snapshot (e.g. the 2026-10-27 to 11-19 D1 outage); never replaces a snapshot.
-- Raw on-chain integers (1e18 or 1e27 scaled) are kept as decimal strings.
CREATE TABLE IF NOT EXISTS chain_hourly (
  hour_at INTEGER PRIMARY KEY,   -- UTC hour boundary (ms)
  block INTEGER NOT NULL,        -- HyperEVM block whose timestamp is closest to hour_at
  block_at INTEGER NOT NULL,     -- that block's own timestamp (ms)
  paper_supply TEXT,             -- PAPER totalSupply()
  staked_supply TEXT,            -- staking 0x817b1cd2()
  accumulator TEXT,              -- staking 0x939d6237() reward accumulator (1e27)
  pending_rewards TEXT,          -- Exchange 0xafdf6702()
  reserve TEXT,                  -- staking 0xcab64bcd()
  lp_balance TEXT,               -- Exchange lpBankrollAvailable()
  treasury TEXT,                 -- Exchange treasury()
  read_at INTEGER NOT NULL
);
