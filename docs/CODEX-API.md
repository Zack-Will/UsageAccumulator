# Codex ledger API v1

This backend is independent of Claude profiles, events, quotas, calibration and UI. All paths below are under `/v1/codex`. Local token events, subscription quota snapshots, and official account usage are three separate datasets. They are not added together.

## Authentication and account binding

The existing `/v1` authentication applies: enrolled machine bearer tokens, the configured dashboard bearer token, or dashboard session cookies. Only an enrolled, non-revoked **machine token** may call `POST /ingest`; dashboard identities remain read-only for this ledger. The server obtains `machine_id` from authentication; it is never accepted in the upload body.

Set `UA_CODEX_ACCOUNT_EMAIL` to the intended account email before enabling ingestion. An empty setting disables ingestion with HTTP 503 `codex_not_configured`. Email is trimmed and case-folded, with no provider-specific alias rewriting. The first successful observation binds email and account ID in both directions. An upload with a different email than configured, a different account ID for an existing email, or a different email for an existing ID returns HTTP 409 `account_binding_conflict`. No part of a conflicting batch is stored. Changing a binding requires an explicit migration; editing the environment variable does not rebind stored history.

This checks the local collector's reported identity against the configured account; it is not an independent server-side OAuth verification. The collector must obtain identity from its local signed-in Codex session. The backend accepts neither login credentials nor transcript content. Nested request objects use strict allowlists; extra fields are rejected.

## `POST /ingest`

The JSON body is the shared `CodexIngestBatch` contract in `packages/ua-core/src/codex-types.ts` (schema version 1):

- `account`: `account_id`, `email`, nullable `plan_type`.
- `events`: at most 5,000 normalized `CodexUsageEvent` records. Every event has a stable `event_id`, `session_id`, nullable `turn_id` and `parent_session_id`, RFC3339 `ts`, `model`, nullable `model_provider`, `reasoning_effort`, `service_tier`, and `project`; integer token counts `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`; and a `quality_flags` array.
- Optional `quota`: `captured_at`, a **complete** `windows` array, and allowlisted `limits` metadata. Each window has `window_id`, `limit_id`, `slot` (`primary` or `secondary`), nullable `label`, `used_percent` in 0–100, nullable positive `duration_minutes`, and nullable `resets_at`. `primary` does not imply five hours. Limits contain `limit_id`, nullable `plan_type`, nullable `limit_reached`, and nullable `credits` (`has_credits`, `unlimited`, nullable string `balance`).
- Optional `account_usage`: `captured_at`, nullable `daily` (`date`, `tokens`), nullable `lifetime_tokens`, and `threads` (`session_id`, `estimated_credits_micros`, nullable `estimated_usd_micros`). These are official cumulative account observations, never local event increments.
- `collector`: `captured_at`, `state` (`ok`, `auth`, `error`), nullable machine-readable `error_code`, RFC3339 `backfill_from`, `scanned_files`, `parse_warnings`, optional `warning_scope: "withheld_records"`, and `account_binding: "verified_login_configured_history"`. With `warning_scope`, `parse_warnings` counts only records that may carry usage and were dropped or withheld (invalid JSON, usage without a session, withheld fork history, counter decreases, baselines without a request, unmatched usage records). Collectors that omit it counted every diagnostic, including notes about emitted events; those counts are disclosed as legacy diagnostics and never qualify coverage.

All timestamps are normalized to UTC. Tokens are nonnegative safe integers. Observation/event timestamps may be at most five minutes ahead of server time. Events before the declared `backfill_from` boundary are rejected. Snapshot reset times may be in the future. Duplicate window IDs within a quota snapshot are rejected. The normal server body limit also applies (32 MiB by default). An error collector heartbeat may include a successfully fetched quota even when account usage was unavailable.

Success response:

```json
{
  "ok": true,
  "account_id": "example-account-id",
  "machine_id": "enrolled-machine-id",
  "accepted": 12,
  "deduped": 3,
  "conflicting_duplicates": 0
}
```

`accepted + deduped` always equals the input event count. The global immutable key is `(account_id, event_id)`, including across machines and across retries. A duplicate cannot overwrite original tokens, model, attribution or stored price. A duplicate with different event metadata increments `conflicting_duplicates` and keeps the first record. An exact retry is safe; batches are atomic. `machine_id` on events denotes the first observing collector, which is not necessarily the original execution host if files were copied between machines.

Conflicts also persist as separate hash-only evidence keyed by account, event, collecting machine and alternative payload hash. Repeating the same conflicting upload does not inflate the persisted observation count. Usage totals and collectors expose those conflicts even after the original acknowledgement is gone. The immutable stored event is not rewritten to hide a discrepancy.

Quota and account usage use separate snapshot tables keyed by account, machine and capture timestamp. The latest full snapshot wins by capture time, with lexical machine ID as a deterministic tie-breaker. A newer `windows: []` clears the current windows. Older delayed snapshots cannot resurrect removed windows. The same machine/capture timestamp is immutable. Snapshots from two machines are never summed.

Errors use `{ "error": { "code": "...", "message": "..." } }`: 400 `bad_request`, 401 `unauthorized`, 403 `forbidden`/`machine_revoked`, 409 `account_binding_conflict`, 503 `codex_not_configured`. The collector preserves unacknowledged events when a request fails. On a permanent 400/413/422 it bisects the batch and quarantines only the rejected events (kept locally for repair, never deleted), provided the same envelope without those events is accepted; the rest of the queue keeps shipping, and the collector heartbeat reports `state: "error"`, `error_code: "codex_events_rejected"`. Queued events that a later, narrower `backfill_from` excludes are withheld locally and not sent.

## `GET /accounts`

Returns `{ accounts: [...] }`. Each account has `account_id`, `email`, nullable `plan_type`, `first_seen_at`, and `last_seen_at`. The timestamps are server receipt times. This private authenticated API includes the configured account email; logs do not log upload bodies or email.

All remaining GET endpoints accept `account_id`. It may be omitted only when exactly one account exists; otherwise the server returns 400. A supplied unknown ID returns 404.

## `GET /quota`

Returns `account_id`, nullable `snapshot`, nullable `source_machine_id`, nullable `received_at`, `age_seconds`, `stale`, `collectors`, and `aggregation: "latest_complete_snapshot"`. `snapshot` is the complete normalized quota object from ingest, including `captured_at`, `windows` and `limits`. A null snapshot means no observations; an empty windows array means the latest observation returned no active windows. These are different states.

Freshness is based on the source capture timestamp, not response time or upload time. `UA_QUOTA_STALE_MS` controls the threshold (15 minutes by default). Percentage values are returned as observed; no cross-window sum, token-to-quota calibration, nonlocal-use attribution or Claude prediction is applied.

## `GET /collectors`

Returns `{ account_id, collectors: [...] }`. Each collector contains `account_id`, `machine_id`, nullable `hostname`, its latest `collector` status, server `received_at`, nullable `last_quota_at` and `last_account_usage_at`, plus `age_seconds`, `stale`, `quota_freshness` and `account_usage_freshness`. Each freshness object contains nullable `age_seconds` and boolean `stale`. The quota response embeds the same collector state without hostnames.

Collectors are tracked independently. A fresh home collector does not conceal a stale Mac collector. An old replay updates receipt time but cannot replace a newer collector state or move the source capture timestamps backwards. Machines with no accepted Codex observations are not listed.

Each collector also exposes cumulative `conflicting_observations`, nullable `last_conflict_at`, `warning_observations`, `parse_warnings_total` (withheld-record warnings only), `legacy_parse_warnings_total` (undeclared diagnostics from older collectors), and nullable `last_warning_at`. Warning-bearing scans are stored once per account, machine and collector capture timestamp, so split event batches/retries do not multiply diagnostics. A later clean scan does not erase previous warnings. Scan warnings can refer to withheld records that have no event timestamp, and therefore are not range-limited.

## `GET /usage`

Parameters: `account_id`, required RFC3339 `from`, optional `to` (defaults to server now), `by=day|model|machine|project|session` (default `day`), and IANA `timezone` (default: the server's `UA_TIME_ZONE`). The range is **[from, to)**, with `from < to`. For example, Shanghai midnight on October 1, 2026 is `2026-09-30T16:00:00Z`. Day buckets use the requested timezone; storage and range filtering use UTC. Empty calendar days are not synthesized.

Response fields: `account_id`, `from`, `to`, `by`, `timezone`, `source: "local_codex_events"`, `machine_attribution: "first_observer"`, `additive_with_account_usage: false`, `totals`, and `buckets`. Each bucket has a `key` and the same aggregate fields as totals:

| Field | Meaning |
| --- | --- |
| `events` | Unique stored events in the range |
| `tokens` | `input`, `cached_input`, `cache_write_input`, `output`, `reasoning_output`, `total` |
| `cost_usd` | Known priced subtotal, or null if no event is priced |
| `cost_basis` | Always `api_equivalent_current_rates` |
| `pricing_complete` | True only for nonempty data with every event priced |
| `usage_complete` | No known gaps/conflicts in observed local records; not a claim of complete account activity |
| `usage_coverage_status` | `no_data`, `incomplete`, or `no_known_gaps` |
| `incomplete_events` | Distinct events with a coverage-affecting quality flag or conflicting observation |
| `conflicting_events`, `conflicting_observations` | Distinct affected events and distinct alternative payload observations |
| `cost_complete` | Requires both complete price coverage and no known local usage gaps |
| `priced_events`, `unpriced_events` | Explicit monetary coverage counts |
| `cost_coverage_pct` | Priced event share, or null for no events |
| `priced_token_coverage_pct` | Token share of priced events, or null for zero tokens |
| `price_versions` | Price versions used for these stored estimates |
| `missing_reasons` | Count by pricing failure reason |
| `quality_flags` | Count of affected events by quality flag |

Cached input and cache writes are subsets of input; reasoning output is a subset of output. Do not add these categories to `total` again. Prices are computed at first ingest by `computeCodexCost`; unknown models/partitions remain unpriced, not zero-priced. A partial subtotal must be shown with its coverage. These values are **current Standard API-equivalent USD estimates**, not subscription charges and not historical invoices. This API does not estimate exchange rates or CNY. Stored estimates are immutable; a deliberate reprice would need a separate migration/versioned action.

Neutral flags (`configured_account_history`, `total_tokens_derived`, `model_unknown`, `turn_id_unavailable`, `reasoning_output_tokens_unreported`, and `compaction_usage_from_record`/`usage_record_without_token_count` for a request reported only by its per-request usage record, e.g. context compaction) do not by themselves invalidate token coverage. Model availability still independently determines monetary coverage. Gap/reset/fork flags and unrecognized quality flags conservatively mark affected events incomplete. They do not delete valid observed tokens or their known price subtotal.

The response states `coverage_scope: "observed_local_records_not_all_account_activity"`. `collector_parse_warnings_total` and `collector_warnings_scope: "all_observed_scans_not_range_limited"` disclose cumulative withheld-record warnings; `collector_legacy_diagnostics_total` discloses undeclared legacy diagnostics, which do not affect completeness. Any withheld-record warning conservatively make **totals** `usage_complete`/`cost_complete` false, because skipped records may have no timestamp to place in a requested range. Bucket integrity fields concern their own observed events only. These flags must not be interpreted as an assertion that every warning means lost billable usage; they mean completeness has not been established.

`by=machine` attributes each unique event to the first collecting machine so the buckets sum to the total. It does not establish the original execution host. Project and session grouping use metadata only, with no titles or transcript text. Missing model/project is grouped as `(unknown)`.

## `GET /account-usage`

Returns `account_id`, nullable `snapshot`, nullable `source_machine_id`, nullable `received_at`, `age_seconds`, `stale`, `aggregation: "latest_official_account_snapshot"`, and `additive_with_local_events: false`. This is the latest full official account observation, including null/unavailable fields. It never changes local usage totals or the API-equivalent price estimate. Official thread credit/USD estimates retain their source units and are not treated as subscriptions' actual charges.

## Validation

Run `pnpm --filter @ua/server test` and `pnpm --filter @ua/server typecheck`. The optional real database test is `UA_TEST_CODEX_DATABASE_URL=... pnpm --filter @ua/server exec vitest run test/codex-pg-live.test.ts`; it creates and removes a unique schema and does not drop `public`. Do not point the older `migrate-live.test.ts` at a production database: that pre-existing test resets its public schema.
