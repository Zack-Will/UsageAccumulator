import { dedupKey, type Profile, type QuotaSample, type QuotaSnapshot } from "@ua/core";
import type {
  CalibrationRecord,
  EventRow,
  LatestQuotaWindow,
  MachineRecord,
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
        });
      }
    }
  }

  async insertEvents(rows: EventRow[]): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      const key = dedupKey(row.event);
      if (this.events.has(key)) continue;
      this.events.set(key, row);
      inserted++;
    }
    return inserted;
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
