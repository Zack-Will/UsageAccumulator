/** Codex v1: serialized metadata only. Never include transcript bodies or credentials. */
export interface CodexUsageEvent {
  event_id: string;
  session_id: string;
  turn_id: string | null;
  parent_session_id: string | null;
  ts: string;
  model: string;
  model_provider: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  project: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  quality_flags: string[];
}

export interface CodexAccount {
  account_id: string;
  email: string;
  plan_type: string | null;
}

export interface CodexQuotaWindow {
  window_id: string;
  limit_id: string;
  slot: "primary" | "secondary";
  label: string | null;
  used_percent: number;
  duration_minutes: number | null;
  resets_at: string | null;
}

export interface CodexQuotaSnapshot {
  captured_at: string;
  windows: CodexQuotaWindow[];
  /** Normalized allowlisted limit metadata, never the original account response. */
  limits: Array<{
    limit_id: string;
    plan_type: string | null;
    credits: { has_credits: boolean; unlimited: boolean; balance: string | null } | null;
    limit_reached: string | null;
  }>;
}

export interface CodexAccountUsageSnapshot {
  captured_at: string;
  daily: Array<{ date: string; tokens: number }> | null;
  lifetime_tokens: number | null;
  /** Optional official thread estimates; cumulative snapshots, never additive events. */
  threads: Array<{
    session_id: string;
    estimated_credits_micros: number;
    estimated_usd_micros: number | null;
  }>;
}

export interface CodexIngestBatch {
  schema_version: 1;
  account: CodexAccount;
  events: CodexUsageEvent[];
  quota?: CodexQuotaSnapshot;
  account_usage?: CodexAccountUsageSnapshot;
  collector: {
    captured_at: string;
    state: "ok" | "auth" | "error";
    error_code: string | null;
    backfill_from: string;
    scanned_files: number;
    parse_warnings: number;
    account_binding: "verified_login_configured_history";
  };
}
