import type { CodexAccountUsageSnapshot, CodexIngestBatch, CodexQuotaSnapshot } from "@ua/core";
import {
  assertAccountBinding, canonicalCodexEvent, newerSnapshot, normalizeCodexEmail,
  type CodexAccountRecord, type CodexCollectorRecord, type CodexCost, type CodexEventRow,
  type CodexIngestResult, type CodexSnapshotRecord, type CodexStore,
} from "./codex-store.js";

export class MemoryCodexStore implements CodexStore {
  private readonly accountRows = new Map<string, CodexAccountRecord>();
  private readonly eventRows = new Map<string, CodexEventRow>();
  private readonly quotaRows = new Map<string, CodexSnapshotRecord<CodexQuotaSnapshot>>();
  /** 全部快照（PG 里本来就全留着；内存版以前只留最新一份） */
  private readonly quotaHistoryRows = new Map<string, { account_id: string; machine_id: string; snapshot: CodexQuotaSnapshot }>();
  private readonly usageRows = new Map<string, CodexSnapshotRecord<CodexAccountUsageSnapshot>>();
  private readonly collectorRows = new Map<string, CodexCollectorRecord>();
  private readonly conflictRows = new Map<string, { account_id: string; event_id: string; machine_id: string; first_seen_at: string }>();
  private readonly warningRows = new Map<string, { account_id: string; machine_id: string; captured_at: string; count: number; scope: string }>();

  async ingest(batch: CodexIngestBatch, machineId: string, costs: CodexCost[], receivedAt: string): Promise<CodexIngestResult> {
    const account = { ...batch.account, email: normalizeCodexEmail(batch.account.email) };
    assertAccountBinding([...this.accountRows.values()], account);
    const prevAccount = this.accountRows.get(account.account_id);
    this.accountRows.set(account.account_id, { ...account,
      first_seen_at: prevAccount?.first_seen_at ?? receivedAt, last_seen_at: receivedAt });
    const result = { accepted: 0, deduped: 0, conflicting_duplicates: 0 };
    for (const [i, event] of batch.events.entries()) {
      const key = JSON.stringify([account.account_id, event.event_id]);
      const previous = this.eventRows.get(key);
      if (previous) {
        result.deduped++;
        if (canonicalCodexEvent(previous.event) !== canonicalCodexEvent(event)) {
          result.conflicting_duplicates++;
          const conflictKey = JSON.stringify([account.account_id, event.event_id, machineId, canonicalCodexEvent(event)]);
          if (!this.conflictRows.has(conflictKey)) this.conflictRows.set(conflictKey, {
            account_id: account.account_id, event_id: event.event_id, machine_id: machineId, first_seen_at: receivedAt,
          });
        }
      } else {
        this.eventRows.set(key, structuredClone({ account_id: account.account_id, machine_id: machineId, event, cost: costs[i]!, conflicting_observations: 0 }));
        result.accepted++;
      }
    }
    const key = JSON.stringify([account.account_id, machineId]);
    if (batch.collector.parse_warnings > 0) {
      const warningKey = JSON.stringify([account.account_id, machineId, batch.collector.captured_at]);
      if (!this.warningRows.has(warningKey)) this.warningRows.set(warningKey, { account_id: account.account_id,
        machine_id: machineId, captured_at: batch.collector.captured_at, count: batch.collector.parse_warnings,
        scope: batch.collector.warning_scope ?? "legacy_all_diagnostics" });
    }
    const previous = this.collectorRows.get(key);
    const collector = !previous || batch.collector.captured_at >= previous.collector.captured_at
      ? batch.collector : previous.collector;
    const maxAt = (a: string | null | undefined, b: string | undefined): string | null =>
      a && b ? (a > b ? a : b) : a ?? b ?? null;
    this.collectorRows.set(key, structuredClone({ account_id: account.account_id, machine_id: machineId,
      collector, received_at: receivedAt,
      last_quota_at: maxAt(previous?.last_quota_at, batch.quota?.captured_at),
      last_account_usage_at: maxAt(previous?.last_account_usage_at, batch.account_usage?.captured_at),
      conflicting_observations: 0, last_conflict_at: null, warning_observations: 0, parse_warnings_total: 0, legacy_parse_warnings_total: 0, last_warning_at: null }));
    if (batch.quota) {
      const record = { machine_id: machineId, snapshot: batch.quota, received_at: receivedAt };
      if (newerSnapshot(record, this.quotaRows.get(account.account_id) ?? null)) this.quotaRows.set(account.account_id, structuredClone(record));
      const historyKey = JSON.stringify([account.account_id, machineId, batch.quota.captured_at]);
      if (!this.quotaHistoryRows.has(historyKey)) this.quotaHistoryRows.set(historyKey,
        structuredClone({ account_id: account.account_id, machine_id: machineId, snapshot: batch.quota }));
    }
    if (batch.account_usage) {
      const record = { machine_id: machineId, snapshot: batch.account_usage, received_at: receivedAt };
      if (newerSnapshot(record, this.usageRows.get(account.account_id) ?? null)) this.usageRows.set(account.account_id, structuredClone(record));
    }
    return result;
  }

  async accounts(): Promise<CodexAccountRecord[]> {
    return structuredClone([...this.accountRows.values()].sort((a, b) => a.account_id.localeCompare(b.account_id)));
  }
  async events(accountId: string, from: string, to: string): Promise<CodexEventRow[]> {
    const conflicts = new Map<string, number>();
    for (const c of this.conflictRows.values()) if (c.account_id === accountId) conflicts.set(c.event_id, (conflicts.get(c.event_id) ?? 0) + 1);
    return structuredClone([...this.eventRows.values()].filter((r) => r.account_id === accountId && r.event.ts >= from && r.event.ts < to)
      .map((r) => ({ ...r, conflicting_observations: conflicts.get(r.event.event_id) ?? 0 }))
      .sort((a, b) => a.event.ts.localeCompare(b.event.ts) || a.event.event_id.localeCompare(b.event.event_id)));
  }
  async quota(accountId: string, machineId?: string): Promise<CodexSnapshotRecord<CodexQuotaSnapshot> | null> {
    if (machineId === undefined) return structuredClone(this.quotaRows.get(accountId) ?? null);
    const mine = [...this.quotaHistoryRows.values()].filter((r) => r.account_id === accountId && r.machine_id === machineId)
      .sort((a, b) => b.snapshot.captured_at.localeCompare(a.snapshot.captured_at))[0];
    return mine ? structuredClone({ machine_id: machineId, snapshot: mine.snapshot, received_at: mine.snapshot.captured_at }) : null;
  }
  async quotaHistory(accountId: string, from: string, to: string): Promise<Array<{ captured_at: string; windows: CodexQuotaSnapshot["windows"] }>> {
    const byTime = new Map<string, { machine_id: string; snapshot: CodexQuotaSnapshot }>();
    for (const r of this.quotaHistoryRows.values()) {
      const at = r.snapshot.captured_at;
      if (r.account_id !== accountId || at < from || at >= to) continue;
      const cur = byTime.get(at);
      if (!cur || r.machine_id < cur.machine_id) byTime.set(at, r);
    }
    return structuredClone([...byTime.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([captured_at, r]) => ({ captured_at, windows: r.snapshot.windows })));
  }
  async accountUsage(accountId: string): Promise<CodexSnapshotRecord<CodexAccountUsageSnapshot> | null> {
    return structuredClone(this.usageRows.get(accountId) ?? null);
  }
  async collectors(accountId: string): Promise<CodexCollectorRecord[]> {
    return structuredClone([...this.collectorRows.values()].filter((r) => r.account_id === accountId)
      .map((r) => {
        const conflicts = [...this.conflictRows.values()].filter((c) => c.account_id === accountId && c.machine_id === r.machine_id);
        const warnings = [...this.warningRows.values()].filter((w) => w.account_id === accountId && w.machine_id === r.machine_id);
        return { ...r, conflicting_observations: conflicts.length,
          last_conflict_at: conflicts.map((c) => c.first_seen_at).sort().at(-1) ?? null,
          warning_observations: warnings.length,
          parse_warnings_total: warnings.reduce((n, w) => n + (w.scope === "withheld_records" ? w.count : 0), 0),
          legacy_parse_warnings_total: warnings.reduce((n, w) => n + (w.scope === "withheld_records" ? 0 : w.count), 0),
          last_warning_at: warnings.map((w) => w.captured_at).sort().at(-1) ?? null };
      })
      .sort((a, b) => a.machine_id.localeCompare(b.machine_id)));
  }
}
