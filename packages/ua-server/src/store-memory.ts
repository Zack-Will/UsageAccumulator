import { dedupKey, usageRank, type Profile, type QuotaSample, type QuotaSnapshot } from "@ua/core";
import type {
  CalibrationRecord,
  EventRow,
  LatestQuotaWindow,
  MachineRecord,
  QuotaBreakdownRow,
  Store,
} from "./store.js";
import { countsTowardQuota } from "./pricing.js";

/**
 * 内存假数据层。测试与本地干跑用。
 *
 * 去重规则与 0001_init.sql 保持一致：
 *   (message_id, request_id) 主键 + request_id 为空时 semantic_id 的部分唯一索引。
 * 这正是 @ua/core 的 dedupKey() 的语义，所以直接用它。
 */
export class MemoryStore implements Store {
  readonly profiles = new Map<string, Profile>();
  readonly events = new Map<string, EventRow>();
  readonly quota: { snapshot: QuotaSnapshot; machineId: string | null }[] = [];
  readonly calibrations: CalibrationRecord[] = [];
  readonly machines = new Map<
    string,
    MachineRecord & { provisionalMachineId: string | null; tokenSha256: string }
  >();
  refreshCount = 0;

  async ping(): Promise<boolean> {
    return true;
  }

  async listProfiles(): Promise<Profile[]> {
    return [...this.profiles.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async ensureProfiles(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!this.profiles.has(id)) {
        this.profiles.set(id, {
          id,
          kind: "oauth",
          label: id,
          accountUuid: null,
          baseUrl: null,
          plan: null,
          orgUuid: null,
        });
      }
    }
  }

  async bindProfileOrg(profileId: string, org: { uuid: string; label: string; plan: string | null }): Promise<string | null> {
    for (const p of this.profiles.values()) {
      if (p.id !== profileId && p.orgUuid === org.uuid) return p.id;
    }
    await this.ensureProfiles([profileId]);
    const p = this.profiles.get(profileId)!;
    this.profiles.set(profileId, { ...p, orgUuid: org.uuid, label: org.label || p.label, plan: org.plan ?? p.plan });
    return null;
  }

  async latestEventAt(): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const { event } of this.events.values()) {
      const cur = out.get(event.profileId);
      if (!cur || event.ts > cur) out.set(event.profileId, event.ts);
    }
    return out;
  }

  async insertEvents(rows: EventRow[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      const key = dedupKey(row.event);
      const cur = this.events.get(key);
      if (!cur) {
        this.events.set(key, row);
        inserted++;
        continue;
      }
      // 语义兜底的键里含 output_tokens，比不出谁更完整（与 store-pg 一致）
      if (!row.event.requestId || usageRank(row.event) <= usageRank(cur.event)) continue;
      const e = row.event;
      this.events.set(key, {
        event: {
          ...cur.event,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          thinkingTokens: e.thinkingTokens,
          cacheReadTokens: e.cacheReadTokens,
          cacheWrite5mTokens: e.cacheWrite5mTokens,
          cacheWrite1hTokens: e.cacheWrite1hTokens,
          outputFinal: e.outputFinal,
        },
        costUsd: row.costUsd,
      });
      updated++;
    }
    return { inserted, updated };
  }

  async insertQuotaSnapshot(s: QuotaSnapshot, machineId: string | null = null): Promise<void> {
    await this.ensureProfiles([s.profileId]);
    this.quota.push({ snapshot: s, machineId });
  }

  async latestQuotaWindows(profileId: string): Promise<LatestQuotaWindow[]> {
    const latest = new Map<string, LatestQuotaWindow>();
    for (const { snapshot } of this.quota) {
      if (snapshot.profileId !== profileId) continue;
      for (const w of snapshot.windows) {
        const prev = latest.get(w.windowKind);
        if (!prev || prev.capturedAt < snapshot.capturedAt) {
          latest.set(w.windowKind, {
            windowKind: w.windowKind,
            utilizationPct: w.utilizationPct,
            resetsAt: w.resetsAt,
            capturedAt: snapshot.capturedAt,
          });
        }
      }
    }
    return [...latest.values()].sort((a, b) => a.windowKind.localeCompare(b.windowKind));
  }

  async quotaSamples(
    profileId: string,
    windowKind: string,
    since: Date,
    until?: Date,
  ): Promise<QuotaSample[]> {
    const out: QuotaSample[] = [];
    for (const { snapshot } of this.quota) {
      if (snapshot.profileId !== profileId) continue;
      if (snapshot.capturedAt < since) continue;
      if (until && snapshot.capturedAt >= until) continue;
      for (const w of snapshot.windows) {
        if (w.windowKind !== windowKind) continue;
        out.push({ ts: snapshot.capturedAt, pct: w.utilizationPct });
      }
    }
    return out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  async quotaWindowResets(profileId: string, windowKind: string, since: Date, until: Date): Promise<Date[]> {
    const seen = new Map<number, Date>();
    for (const { snapshot } of this.quota) {
      if (snapshot.profileId !== profileId || snapshot.capturedAt < since || snapshot.capturedAt >= until) continue;
      for (const w of snapshot.windows) {
        if (w.windowKind !== windowKind || !w.resetsAt) continue;
        const k = Math.round(w.resetsAt.getTime() / 600_000) * 600_000;
        seen.set(k, new Date(k));
      }
    }
    return [...seen.values()].sort((a, b) => a.getTime() - b.getTime());
  }

  async quotaBreakdowns(profileId: string, since: Date): Promise<QuotaBreakdownRow[]> {
    const out: QuotaBreakdownRow[] = [];
    for (const { snapshot } of this.quota) {
      if (snapshot.profileId !== profileId || snapshot.capturedAt < since) continue;
      const weekly = snapshot.windows.find((w) => w.windowKind === "seven_day");
      const raw = snapshot.raw as Record<string, unknown> | null;
      const breakdown = raw && typeof raw === "object" ? raw["seven_day_breakdown"] : undefined;
      if (!weekly || !breakdown || typeof breakdown !== "object" || Array.isArray(breakdown)) continue;
      out.push({ ts: snapshot.capturedAt, weeklyPct: weekly.utilizationPct, breakdown });
    }
    return out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  private readonly titles = new Map<string, { machineId: string; title: string }>();

  async upsertSessionTitles(machineId: string, rows: { sessionId: string; title: string }[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      if (this.titles.get(r.sessionId)?.title === r.title) continue;
      this.titles.set(r.sessionId, { machineId, title: r.title });
      n++;
    }
    return n;
  }

  async sessionTitles(sessionIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of sessionIds) {
      const t = this.titles.get(id);
      if (t) out.set(id, t.title);
    }
    return out;
  }

  async eventsInRange(profileId: string, from: Date, to: Date): Promise<EventRow[]> {
    return [...this.events.values()]
      .filter((r) => r.event.profileId === profileId && r.event.ts >= from && r.event.ts < to)
      .sort((a, b) => a.event.ts.getTime() - b.event.ts.getTime());
  }

  async quotaEventTimestamps(profileId: string, from: Date, to: Date): Promise<Date[]> {
    const rows = await this.eventsInRange(profileId, from, to);
    return rows.filter((r) => countsTowardQuota(r.event.model)).map((r) => r.event.ts);
  }

  async latestCalibration(profileId: string, windowKind?: string): Promise<CalibrationRecord[]> {
    const latest = new Map<string, CalibrationRecord>();
    for (const c of this.calibrations) {
      if (c.profileId !== profileId) continue;
      if (windowKind && c.windowKind !== windowKind) continue;
      const prev = latest.get(c.windowKind);
      if (!prev || prev.computedAt < c.computedAt) latest.set(c.windowKind, c);
    }
    return [...latest.values()];
  }

  async insertCalibration(rec: CalibrationRecord): Promise<void> {
    this.calibrations.push(rec);
  }

  async createMachine(m: {
    id: string;
    provisionalMachineId: string | null;
    hostname: string;
    os: string;
    tokenSha256: string;
  }): Promise<void> {
    this.machines.set(m.id, {
      id: m.id,
      provisionalMachineId: m.provisionalMachineId,
      hostname: m.hostname,
      os: m.os,
      revokedAt: null,
      tokenSha256: m.tokenSha256,
      lastSeenAt: null,
    });
  }

  async findMachineByTokenSha256(hash: string): Promise<MachineRecord | null> {
    for (const m of this.machines.values()) {
      if (m.tokenSha256 === hash) {
        return {
          id: m.id,
          hostname: m.hostname,
          os: m.os,
          lastSeenAt: m.lastSeenAt,
          revokedAt: m.revokedAt,
        };
      }
    }
    return null;
  }

  async listMachines(): Promise<MachineRecord[]> {
    return [...this.machines.values()]
      .map((m) => ({
        id: m.id,
        hostname: m.hostname,
        os: m.os,
        lastSeenAt: m.lastSeenAt,
        revokedAt: m.revokedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async touchMachine(id: string): Promise<void> {
    const m = this.machines.get(id);
    if (m) m.lastSeenAt = new Date();
  }

  async refreshHourly(): Promise<void> {
    this.refreshCount++;
  }

  async close(): Promise<void> {
    /* no-op */
  }
}
