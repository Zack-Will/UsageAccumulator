-- Keep immutable usage while making conflicting observations and skipped scan data visible.
BEGIN;

CREATE TABLE IF NOT EXISTS codex_event_conflicts (
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  observed_hash TEXT NOT NULL,
  recorded_hash TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, event_id, machine_id, observed_hash),
  FOREIGN KEY (account_id, event_id) REFERENCES codex_events(account_id, event_id)
);
CREATE INDEX IF NOT EXISTS codex_conflicts_collector_idx ON codex_event_conflicts (account_id, machine_id);

-- One collector scan may be shipped in several event batches: count its diagnostics once.
CREATE TABLE IF NOT EXISTS codex_collection_warnings (
  account_id TEXT NOT NULL REFERENCES codex_accounts(account_id),
  machine_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  parse_warnings BIGINT NOT NULL CHECK (parse_warnings > 0),
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, machine_id, captured_at)
);

COMMIT;
