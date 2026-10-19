-- Collectors now declare what parse_warnings counts. Rows written before this declaration
-- also counted diagnostics about emitted events (e.g. a missing turn_id), so they cannot
-- qualify coverage; they stay visible as legacy diagnostics.
BEGIN;

ALTER TABLE codex_collection_warnings
  ADD COLUMN IF NOT EXISTS warning_scope TEXT NOT NULL DEFAULT 'legacy_all_diagnostics';

COMMIT;
