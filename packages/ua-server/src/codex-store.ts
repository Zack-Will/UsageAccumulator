import type { CodexAccount, CodexAccountUsageSnapshot, CodexIngestBatch, CodexQuotaSnapshot, CodexUsageEvent } from "@ua/core";

export interface CodexCost {
  usd: number | null;
  basis: "api_equivalent_current_rates";
  price_version: string;
  missing_reason: string | null;
}

export interface CodexEventRow {
  account_id: string;
  /** First collecting machine, not a claim about the original execution host. */
  machine_id: string;
  event: CodexUsageEvent;
  cost: CodexCost;
  conflicting_observations: number;
}

export interface CodexAccountRecord extends CodexAccount {
  first_seen_at: string;
  last_seen_at: string;
}

export interface CodexSnapshotRecord<T> {
  machine_id: string;
  snapshot: T;
  received_at: string;
}

export interface CodexCollectorRecord {
  account_id: string;
  machine_id: string;
  collector: CodexIngestBatch["collector"];
  received_at: string;
  last_quota_at: string | null;
  last_account_usage_at: string | null;
  conflicting_observations: number;
  last_conflict_at: string | null;
  /** Unique warning-bearing scan observations; repeated upload batches do not inflate this. */
  warning_observations: number;
  /** Withheld-record warnings: the only ones that qualify usage coverage. */
  parse_warnings_total: number;
  /** Diagnostics from collectors that did not declare warning_scope; disclosed, never coverage. */
  legacy_parse_warnings_total: number;
  last_warning_at: string | null;
}

export interface CodexIngestResult {
  accepted: number;
  deduped: number;
  /** Same event identity with different content: keep the first immutable record. */
  conflicting_duplicates: number;
}

export class CodexHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface CodexStore {
  /** Atomic account binding, immutable events, complete snapshots, collector heartbeat. */
  ingest(batch: CodexIngestBatch, machineId: string, costs: CodexCost[], receivedAt: string): Promise<CodexIngestResult>;
  accounts(): Promise<CodexAccountRecord[]>;
  events(accountId: string, from: string, to: string): Promise<CodexEventRow[]>;
  quota(accountId: string): Promise<CodexSnapshotRecord<CodexQuotaSnapshot> | null>;
  accountUsage(accountId: string): Promise<CodexSnapshotRecord<CodexAccountUsageSnapshot> | null>;
  collectors(accountId: string): Promise<CodexCollectorRecord[]>;
}

export function normalizeCodexEmail(email: string): string { return email.trim().toLowerCase(); }

export function assertAccountBinding(accounts: CodexAccountRecord[], incoming: CodexAccount): void {
  const email = normalizeCodexEmail(incoming.email);
  if (accounts.some((a) => (a.account_id === incoming.account_id && a.email !== email)
    || (a.email === email && a.account_id !== incoming.account_id))) {
    throw new CodexHttpError(409, "account_binding_conflict", "The account ID and email conflict with an existing stable binding; explicit migration is required");
  }
}

/** Stable across source JSON key order and PostgreSQL JSONB reserialization. */
export function canonicalCodexEvent(event: CodexUsageEvent): string {
  return JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))));
}

export function newerSnapshot<T extends { captured_at: string }>(
  candidate: CodexSnapshotRecord<T>, current: CodexSnapshotRecord<T> | null,
): boolean {
  return current === null || candidate.snapshot.captured_at > current.snapshot.captured_at
    || (candidate.snapshot.captured_at === current.snapshot.captured_at && candidate.machine_id < current.machine_id);
}
