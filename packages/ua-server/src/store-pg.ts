import postgres from "postgres";
import type { Profile, QuotaSample, QuotaSnapshot, UsageEvent } from "@ua/core";
import type {
  CalibrationRecord,
  EventRow,
  LatestQuotaWindow,
  MachineRecord,
  QuotaBreakdownRow,
  Store,
} from "./store.js";

type Sql = postgres.Sql<Record<string, never>>;

const EVENT_COLUMNS = [
  "message_id",
  "request_id",
  "semantic_id",
  "machine_id",
  "app_type",
  "profile_id",
  "attribution_level",
  "ts",
  "model",
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "session_id",
  "project_slug",
  "git_branch",
  "entrypoint",
  "service_tier",
  "is_sidechain",
  "output_final",
  "backfill",
  "cost_usd",
] as const;

function n(v: unknown): number {
  // BIGINT 在驱动里可能是字符串，统一收成 number
  return typeof v === "number" ? v : Number(v ?? 0);
}

function rowToEventRow(r: Record<string, unknown>): EventRow {
  const event: UsageEvent = {
    messageId: String(r["message_id"] ?? ""),
    requestId: String(r["request_id"] ?? ""),
    semanticId: String(r["semantic_id"] ?? ""),
    machineId: String(r["machine_id"] ?? ""),
    appType: String(r["app_type"] ?? "claude") as UsageEvent["appType"],
    profileId: String(r["profile_id"] ?? ""),
    attributionLevel: String(r["attribution_level"] ?? "unknown") as UsageEvent["attributionLevel"],
    ts: r["ts"] instanceof Date ? (r["ts"] as Date) : new Date(String(r["ts"])),
    model: String(r["model"] ?? ""),
    inputTokens: n(r["input_tokens"]),
    outputTokens: n(r["output_tokens"]),
    thinkingTokens: n(r["thinking_tokens"]),
    cacheReadTokens: n(r["cache_read_tokens"]),
    cacheWrite5mTokens: n(r["cache_write_5m_tokens"]),
    cacheWrite1hTokens: n(r["cache_write_1h_tokens"]),
    sessionId: String(r["session_id"] ?? ""),
    projectSlug: r["project_slug"] == null ? null : String(r["project_slug"]),
    gitBranch: r["git_branch"] == null ? null : String(r["git_branch"]),
    entrypoint: r["entrypoint"] == null ? null : String(r["entrypoint"]),
    serviceTier: r["service_tier"] == null ? null : String(r["service_tier"]),
    isSidechain: r["is_sidechain"] === true,
    outputFinal: typeof r["output_final"] === "boolean" ? r["output_final"] : null,
    backfill: r["backfill"] === true,
  };
  // NUMERIC 回来是字符串；缺价是 NULL，绝不当 0
  const cost = r["cost_usd"];
  return { event, costUsd: cost == null ? null : Number(cost) };
}

function rowToMachine(r: Record<string, unknown>): MachineRecord {
  return {
    id: String(r["id"]),
    hostname: r["hostname"] == null ? null : String(r["hostname"]),
    os: r["os"] == null ? null : String(r["os"]),
    lastSeenAt: r["last_seen_at"] instanceof Date ? (r["last_seen_at"] as Date) : null,
    revokedAt: r["revoked_at"] instanceof Date ? (r["revoked_at"] as Date) : null,
  };
}

export class PgStore implements Store {
  constructor(private readonly sql: Sql) {}

  static open(databaseUrl: string): PgStore {
    const sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 30,
      // prompt / 响应正文根本不会到这里，但显式关掉 notice 输出，避免任何意外回显
      onnotice: () => {},
    }) as Sql;
    return new PgStore(sql);
  }

  async ping(): Promise<boolean> {
    await this.sql`SELECT 1`;
    return true;
  }

  async listProfiles(): Promise<Profile[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT id, kind, label, account_uuid, base_url, plan, org_uuid FROM profiles ORDER BY id`;
    return rows.map((r) => ({
      id: String(r["id"]),
      kind: (r["kind"] === "api_key" ? "api_key" : "oauth") as Profile["kind"],
      label: String(r["label"] ?? ""),
      accountUuid: r["account_uuid"] == null ? null : String(r["account_uuid"]),
      baseUrl: r["base_url"] == null ? null : String(r["base_url"]),
      plan: r["plan"] == null ? null : String(r["plan"]),
      orgUuid: r["org_uuid"] == null ? null : String(r["org_uuid"]),
    }));
  }

  async bindProfileOrg(profileId: string, org: { uuid: string; label: string; plan: string | null }): Promise<string | null> {
    const taken = await this.sql<{ id: string }[]>`
      SELECT id FROM profiles WHERE org_uuid = ${org.uuid} AND id <> ${profileId} LIMIT 1`;
    if (taken.length > 0) return taken[0]!.id;
    await this.sql`
      INSERT INTO profiles (id, label, org_uuid, plan)
      VALUES (${profileId}, ${org.label || profileId}, ${org.uuid}, ${org.plan})
      ON CONFLICT (id) DO UPDATE SET
        org_uuid = EXCLUDED.org_uuid,
        label    = CASE WHEN ${org.label} = '' THEN profiles.label ELSE EXCLUDED.label END,
        plan     = COALESCE(EXCLUDED.plan, profiles.plan)`;
    return null;
  }

  async latestEventAt(): Promise<Map<string, Date>> {
    // 逐 profile 走 (profile_id, ts DESC) 索引取一行，不对整张事件表做 GROUP BY
    const rows = await this.sql<{ id: string; ts: Date | null }[]>`
      SELECT p.id, e.ts
      FROM profiles p
      LEFT JOIN LATERAL (
        SELECT ts FROM usage_events WHERE profile_id = p.id ORDER BY ts DESC LIMIT 1
      ) e ON true`;
    const out = new Map<string, Date>();
    for (const r of rows) if (r.ts) out.set(r.id, new Date(r.ts));
    return out;
  }

  async ensureProfiles(ids: string[]): Promise<void> {
    const unique = [...new Set(ids.filter((x) => x.length > 0))];
    if (unique.length === 0) return;
    await this.sql`
      INSERT INTO profiles ${this.sql(
        unique.map((id) => ({ id, label: id })),
        "id",
        "label",
      )}
      ON CONFLICT (id) DO NOTHING`;
  }

  /**
   * 批量 upsert。
   *
   * 有 request_id 的行按主键冲突，**更完整就覆盖**用量与成本（usageRank 的 SQL 版）：
   * Claude Code 把一条消息写成多行、子代理只有最后一行是最终用量，先到先得会存下
   * 流式中途值。覆盖只动用量相关列 —— machine_id / profile_id 等仍归先到的那份。
   *
   * request_id 为空的行（语义兜底）仍然 DO NOTHING：它们的 semantic_id 里含 output_tokens，
   * 同一条消息的不同行本来就是不同的键，比不出谁更完整。
   */
  async insertEvents(rows: EventRow[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };
    const payload = rows.map(({ event: e, costUsd }) => ({
      message_id: e.messageId,
      request_id: e.requestId,
      semantic_id: e.semanticId,
      machine_id: e.machineId,
      app_type: e.appType,
      profile_id: e.profileId,
      attribution_level: e.attributionLevel,
      ts: e.ts,
      model: e.model,
      input_tokens: e.inputTokens,
      output_tokens: e.outputTokens,
      thinking_tokens: e.thinkingTokens,
      cache_read_tokens: e.cacheReadTokens,
      cache_write_5m_tokens: e.cacheWrite5mTokens,
      cache_write_1h_tokens: e.cacheWrite1hTokens,
      session_id: e.sessionId,
      project_slug: e.projectSlug,
      git_branch: e.gitBranch,
      entrypoint: e.entrypoint,
      service_tier: e.serviceTier,
      is_sidechain: e.isSidechain,
      output_final: e.outputFinal,
      backfill: e.backfill,
      cost_usd: costUsd,
    }));
    const keyed = payload.filter((p) => p.request_id !== "");
    const semantic = payload.filter((p) => p.request_id === "");
    let inserted = 0;
    let updated = 0;
    if (keyed.length > 0) {
      // xmax = 0 ⇔ 这一行是新插入的；否则是 DO UPDATE 改的。被 WHERE 挡下的冲突不返回。
      const res = await this.sql<{ inserted: boolean }[]>`
        INSERT INTO usage_events ${this.sql(keyed, ...EVENT_COLUMNS)}
        ON CONFLICT (message_id, request_id) DO UPDATE SET
          input_tokens          = EXCLUDED.input_tokens,
          output_tokens         = EXCLUDED.output_tokens,
          thinking_tokens       = EXCLUDED.thinking_tokens,
          cache_read_tokens     = EXCLUDED.cache_read_tokens,
          cache_write_5m_tokens = EXCLUDED.cache_write_5m_tokens,
          cache_write_1h_tokens = EXCLUDED.cache_write_1h_tokens,
          output_final          = EXCLUDED.output_final,
          cost_usd              = EXCLUDED.cost_usd
        WHERE EXCLUDED.output_tokens * 3 + (CASE EXCLUDED.output_final WHEN TRUE THEN 2 WHEN FALSE THEN 1 ELSE 0 END)
            > usage_events.output_tokens * 3 + (CASE usage_events.output_final WHEN TRUE THEN 2 WHEN FALSE THEN 1 ELSE 0 END)
        RETURNING (xmax = 0) AS inserted`;
      for (const r of res) {
        if (r.inserted) inserted++;
        else updated++;
      }
    }
    if (semantic.length > 0) {
      const res = await this.sql<{ ok: number }[]>`
        INSERT INTO usage_events ${this.sql(semantic, ...EVENT_COLUMNS)}
        ON CONFLICT DO NOTHING
        RETURNING 1 AS ok`;
      inserted += res.length;
    }
    return { inserted, updated };
  }

  async insertQuotaSnapshot(s: QuotaSnapshot, machineId: string | null = null): Promise<void> {
    await this.ensureProfiles([s.profileId]);
    if (s.windows.length === 0) return;
    const payload = s.windows.map((w) => ({
      profile_id: s.profileId,
      machine_id: machineId,
      captured_at: s.capturedAt,
      window_kind: w.windowKind,
      utilization_pct: w.utilizationPct,
      resets_at: w.resetsAt,
      raw: this.sql.json(s.raw as never),
    }));
    await this.sql`
      INSERT INTO quota_snapshots ${this.sql(
        payload,
        "profile_id",
        "machine_id",
        "captured_at",
        "window_kind",
        "utilization_pct",
        "resets_at",
        "raw",
      )}
      ON CONFLICT (profile_id, window_kind, captured_at) DO NOTHING`;
  }

  async latestQuotaWindows(profileId: string): Promise<LatestQuotaWindow[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT DISTINCT ON (window_kind)
             window_kind, utilization_pct, resets_at, captured_at
      FROM quota_snapshots
      WHERE profile_id = ${profileId}
      ORDER BY window_kind, captured_at DESC`;
    return rows.map((r) => ({
      windowKind: String(r["window_kind"]),
      utilizationPct: n(r["utilization_pct"]),
      resetsAt: r["resets_at"] instanceof Date ? (r["resets_at"] as Date) : null,
      capturedAt: r["captured_at"] as Date,
    }));
  }

  async quotaSamples(
    profileId: string,
    windowKind: string,
    since: Date,
    until?: Date,
  ): Promise<QuotaSample[]> {
    /*
     * 上界可选：标定只需要「最近若干天」，按周回看需要闭区间。
     *
     * ★ 不能用「JS 最大日期」当哨兵：new Date(8640000000000000) 是公元 275760 年，
     * Postgres 直接报 `time zone displacement out of range` 并让整个请求 500。
     * 2026-09-22 就是这么把 /v1/summary 和 /v1/ingest/quota 一起打挂的。
     * 没有上界时就不要那个条件。
     */
    const upperClause = until ? this.sql`AND captured_at < ${until}` : this.sql``;
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT captured_at, utilization_pct
      FROM quota_snapshots
      WHERE profile_id = ${profileId} AND window_kind = ${windowKind}
        AND captured_at >= ${since} ${upperClause}
      ORDER BY captured_at`;
    return rows.map((r) => ({ ts: r["captured_at"] as Date, pct: n(r["utilization_pct"]) }));
  }

  /**
   * ★ 模型过滤必须与 pricing.ts 的 countsTowardQuota 同口径：
   * 生成列 counts_toward_quota 只挡掉 `<synthetic>`，挡不住套壳客户端路由过去的
   * 非 Anthropic 模型（公司 Mac 上实测到 qwen3.7-plus）。那些 token 不吃 Claude 额度，
   * 算进来会让「这段时间本地有动静」在实际没动静时也成立，把别处的消耗吞掉。
   */
  async quotaWindowResets(profileId: string, windowKind: string, since: Date, until: Date): Promise<Date[]> {
    const rows = await this.sql<{ reset: Date }[]>`
      SELECT DISTINCT to_timestamp(round(extract(epoch FROM resets_at) / 600) * 600) AS reset
      FROM quota_snapshots
      WHERE profile_id = ${profileId} AND window_kind = ${windowKind} AND resets_at IS NOT NULL
        AND captured_at >= ${since} AND captured_at < ${until}
      ORDER BY 1`;
    return rows.map((r) => (r.reset instanceof Date ? r.reset : new Date(String(r.reset))));
  }

  async quotaBreakdowns(profileId: string, since: Date): Promise<QuotaBreakdownRow[]> {
    // raw 是整份响应、每个窗口一行各存一份；只取 seven_day 那行就够了
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT captured_at, utilization_pct, raw->'seven_day_breakdown' AS breakdown
      FROM quota_snapshots
      WHERE profile_id = ${profileId} AND window_kind = 'seven_day'
        AND captured_at >= ${since}
        AND jsonb_typeof(raw->'seven_day_breakdown') = 'object'
      ORDER BY captured_at`;
    return rows.map((r) => ({
      ts: r["captured_at"] as Date,
      weeklyPct: n(r["utilization_pct"]),
      breakdown: r["breakdown"],
    }));
  }

  async quotaEventTimestamps(profileId: string, from: Date, to: Date): Promise<Date[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT ts FROM usage_events
      WHERE profile_id = ${profileId} AND ts >= ${from} AND ts < ${to}
        AND counts_toward_quota
        AND (model LIKE 'claude%' OR model ~ '^(opus|sonnet|haiku|fable)([-.]|$)')
      ORDER BY ts`;
    return rows.map((r) => r["ts"] as Date);
  }

  async upsertSessionTitles(machineId: string, rows: { sessionId: string; title: string }[]): Promise<number> {
    if (rows.length === 0) return 0;
    let n = 0;
    // 批量很小（一台机器也就几十上百个会话），逐条 upsert 足够，换来 WHERE 里能判「没变就不写」
    for (const r of rows) {
      const res = await this.sql`
        INSERT INTO session_titles (session_id, machine_id, title, updated_at)
        VALUES (${r.sessionId}, ${machineId}, ${r.title}, now())
        ON CONFLICT (session_id) DO UPDATE
          SET title = excluded.title, machine_id = excluded.machine_id, updated_at = now()
          WHERE session_titles.title IS DISTINCT FROM excluded.title`;
      n += res.count;
    }
    return n;
  }

  async sessionTitles(sessionIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(sessionIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT session_id, title FROM session_titles WHERE session_id = ANY(${ids})`;
    return new Map(rows.map((r) => [String(r["session_id"]), String(r["title"])]));
  }

  async eventsInRange(profileId: string, from: Date, to: Date): Promise<EventRow[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM usage_events
      WHERE profile_id = ${profileId} AND ts >= ${from} AND ts < ${to}
      ORDER BY ts`;
    return rows.map(rowToEventRow);
  }

  async latestCalibration(profileId: string, windowKind?: string): Promise<CalibrationRecord[]> {
    const rows = windowKind
      ? await this.sql<Record<string, unknown>[]>`
          SELECT DISTINCT ON (window_kind) * FROM calibrations
          WHERE profile_id = ${profileId} AND window_kind = ${windowKind}
          ORDER BY window_kind, computed_at DESC`
      : await this.sql<Record<string, unknown>[]>`
          SELECT DISTINCT ON (window_kind) * FROM calibrations
          WHERE profile_id = ${profileId}
          ORDER BY window_kind, computed_at DESC`;
    return rows.map((r) => ({
      profileId: String(r["profile_id"]),
      windowKind: String(r["window_kind"]),
      computedAt: r["computed_at"] as Date,
      limitWeightedTokens: n(r["limit_weighted_tokens"]),
      baseModel: String(r["base_model"]),
      weights: (r["weights"] ?? {}) as Record<string, number>,
      residual: n(r["residual"]),
      observations: n(r["observations"]),
      converged: r["converged"] === true,
      points: (r["points"] ?? []) as CalibrationRecord["points"],
    }));
  }

  async insertCalibration(rec: CalibrationRecord): Promise<void> {
    await this.sql`
      INSERT INTO calibrations
        (profile_id, window_kind, computed_at, limit_weighted_tokens, base_model, weights,
         residual, observations, converged, points)
      VALUES (${rec.profileId}, ${rec.windowKind}, ${rec.computedAt}, ${rec.limitWeightedTokens},
              ${rec.baseModel}, ${this.sql.json(rec.weights as never)}, ${rec.residual},
              ${rec.observations}, ${rec.converged}, ${this.sql.json(rec.points as never)})`;
  }

  async createMachine(m: {
    id: string;
    provisionalMachineId: string | null;
    hostname: string;
    os: string;
    tokenSha256: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO machines (id, provisional_machine_id, hostname, os, token_sha256)
      VALUES (${m.id}, ${m.provisionalMachineId}, ${m.hostname}, ${m.os}, ${m.tokenSha256})`;
  }

  /** 吊销的也查出来：鉴权层要能把 machine_revoked 与 unauthorized 分开（CONTRACT §2）。 */
  async findMachineByTokenSha256(hash: string): Promise<MachineRecord | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT id, hostname, os, last_seen_at, revoked_at FROM machines
      WHERE token_sha256 = ${hash}
      LIMIT 1`;
    const r = rows[0];
    return r ? rowToMachine(r) : null;
  }

  async listMachines(): Promise<MachineRecord[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT id, hostname, os, last_seen_at, revoked_at FROM machines ORDER BY id`;
    return rows.map(rowToMachine);
  }

  async touchMachine(id: string): Promise<void> {
    await this.sql`UPDATE machines SET last_seen_at = now() WHERE id = ${id}`;
  }

  /** CONCURRENTLY 需要视图已被填充过一次；首次退回普通刷新。 */
  async refreshHourly(): Promise<void> {
    try {
      await this.sql`REFRESH MATERIALIZED VIEW CONCURRENTLY usage_hourly`;
    } catch {
      await this.sql`REFRESH MATERIALIZED VIEW usage_hourly`;
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
