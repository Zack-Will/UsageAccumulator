-- Independent Codex ledger. No transcript text or credentials are accepted.
BEGIN;

CREATE TABLE IF NOT EXISTS codex_accounts (
  account_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  plan_type TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_events (
  account_id TEXT NOT NULL REFERENCES codex_accounts(account_id),
  event_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  event JSONB NOT NULL,
  event_hash TEXT NOT NULL,
  cost_usd NUMERIC(24,12),
  cost_basis TEXT NOT NULL CHECK (cost_basis = 'api_equivalent_current_rates'),
  price_version TEXT NOT NULL,
  missing_reason TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, event_id)
);
CREATE INDEX IF NOT EXISTS codex_events_account_ts_idx ON codex_events (account_id, ts);

-- Each row is a COMPLETE snapshot, including windows: []; never merge windows across rows.
CREATE TABLE IF NOT EXISTS codex_quota_snapshots (
  account_id TEXT NOT NULL REFERENCES codex_accounts(account_id),
  machine_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (account_id, machine_id, captured_at)
);
CREATE INDEX IF NOT EXISTS codex_quota_latest_idx ON codex_quota_snapshots (account_id, captured_at DESC, machine_id);

-- Official account-wide cumulative aggregates; NEVER sum with local codex_events.
CREATE TABLE IF NOT EXISTS codex_account_usage_snapshots (
  account_id TEXT NOT NULL REFERENCES codex_accounts(account_id),
  machine_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (account_id, machine_id, captured_at)
);
CREATE INDEX IF NOT EXISTS codex_account_usage_latest_idx ON codex_account_usage_snapshots (account_id, captured_at DESC, machine_id);

CREATE TABLE IF NOT EXISTS codex_collectors (
  account_id TEXT NOT NULL REFERENCES codex_accounts(account_id),
  machine_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  collector JSONB NOT NULL,
  last_quota_at TIMESTAMPTZ,
  last_account_usage_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, machine_id)
);

COMMIT;
