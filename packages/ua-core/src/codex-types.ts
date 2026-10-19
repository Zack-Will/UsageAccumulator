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
  /**
   * 官方发的「重置额度」券（用掉一张就会把窗口提前清零）。只有服务端直接读 /wham/usage 时才有；
   * 探针经 app-server 读不到它，缺省 = 不知道，不是「没有」。
   */
  reset_credits?: CodexResetCredits | null;
}

export interface CodexResetCredits {
  available_count: number;
  /** null = 详情接口没读到，只有数量 */
  credits: Array<{
    reset_type: string;
    status: string;
    granted_at: string;
    expires_at: string | null;
    title: string | null;
  }> | null;
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
    /**
     * What parse_warnings counts. "withheld_records": only records that may carry usage and
     * were dropped or withheld. Absent (older collectors): every diagnostic, including ones
     * about events that were emitted, so the count cannot qualify coverage.
     */
    warning_scope?: "withheld_records";
    account_binding: "verified_login_configured_history";
  };
}
