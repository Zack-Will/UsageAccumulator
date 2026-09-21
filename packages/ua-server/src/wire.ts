import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { dedupKey, semanticId, type QuotaSnapshot, type UsageEvent } from "@ua/core";

/**
 * 线上格式 → 内部类型。字段名以 CONTRACT §1 为准，一个字母都不能自己发明。
 * 这一层全是纯函数，可以脱离数据库测。
 */

const int = z.coerce.number().int().nonnegative().default(0);

/** CONTRACT §1.1 */
export const usageEventWireSchema = z.object({
  // 恒非空（CONTRACT §1.2：实测 29,198 条里为空 0 条）。空值一律 400，不静默接收。
  message_id: z.string().min(1),
  // 实测 519 条缺 requestId，所以允许空字符串，由 semantic_id 兜底（CONTRACT §1.2）
  request_id: z.string().default(""),
  // 契约规定探针永远填写；没带就由服务端用同一套公式补算，结果完全一致（兼容旧探针）
  semantic_id: z.string().optional(),
  machine_id: z.string().min(1),
  app_type: z.string().default("claude"),
  profile_id: z.string().min(1),
  attribution_level: z.string().default("unknown"),
  ts: z.string().min(1),
  model: z.string().default(""),
  input_tokens: int,
  output_tokens: int,
  thinking_tokens: int,
  cache_read_tokens: int,
  cache_write_5m_tokens: int,
  cache_write_1h_tokens: int,
  session_id: z.string().default(""),
  project_slug: z.string().nullish(),
  git_branch: z.string().nullish(),
  entrypoint: z.string().nullish(),
  service_tier: z.string().nullish(),
  is_sidechain: z.coerce.boolean().default(false),
  backfill: z.coerce.boolean().default(false),
});

export type UsageEventWire = z.infer<typeof usageEventWireSchema>;

/** CONTRACT §1.3 —— window_kind 是自由字符串，刻意不加枚举约束 */
export const quotaSnapshotWireSchema = z.object({
  profile_id: z.string().min(1),
  /** 采集机器，仅供追溯来源；v1 只有一台开启 QuotaFetcher */
  machine_id: z.string().nullish(),
  captured_at: z.string().min(1),
  windows: z
    .array(
      z.object({
        window_kind: z.string().min(1),
        utilization_pct: z.number().min(0).max(100).nullish(),
        resets_at: z.string().nullish(),
      }),
    )
    .default([]),
  raw: z.unknown().default({}),
});

export const enrollWireSchema = z.object({
  enroll_token: z.string().min(1),
  hostname: z.string().default(""),
  os: z.string().default(""),
  /**
   * 探针 install 时本地生成的临时 id，enroll 时一并提交。
   * **服务端是权威**（CONTRACT §2.3）：下发的 machine_id 覆盖它，这里只留着排障时对日志。
   * 刻意不直接采用客户端给的值 —— 机器身份不能由客户端自己挑。
   */
  provisional_machine_id: z.string().nullish(),
});

function toDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** wire → UsageEvent。semantic_id 缺失时按 CONTRACT §1.2 的公式补算。 */
export function wireToEvent(w: UsageEventWire): UsageEvent | null {
  const ts = toDate(w.ts);
  if (!ts) return null;
  const sem =
    w.semantic_id && w.semantic_id.length > 0
      ? w.semantic_id
      : semanticId({
          sessionId: w.session_id,
          tsMs: ts.getTime(),
          model: w.model,
          inputTokens: w.input_tokens,
          outputTokens: w.output_tokens,
          cacheReadTokens: w.cache_read_tokens,
          cacheWrite5mTokens: w.cache_write_5m_tokens,
          cacheWrite1hTokens: w.cache_write_1h_tokens,
        });
  return {
    messageId: w.message_id,
    requestId: w.request_id,
    semanticId: sem,
    machineId: w.machine_id,
    appType: (w.app_type === "codex" || w.app_type === "gemini" ? w.app_type : "claude") as
      | "claude"
      | "codex"
      | "gemini",
    profileId: w.profile_id,
    attributionLevel: (["proxy", "timeline", "fallback"].includes(w.attribution_level)
      ? w.attribution_level
      : "unknown") as UsageEvent["attributionLevel"],
    ts,
    model: w.model,
    inputTokens: w.input_tokens,
    outputTokens: w.output_tokens,
    thinkingTokens: w.thinking_tokens,
    cacheReadTokens: w.cache_read_tokens,
    cacheWrite5mTokens: w.cache_write_5m_tokens,
    cacheWrite1hTokens: w.cache_write_1h_tokens,
    sessionId: w.session_id,
    projectSlug: w.project_slug ?? null,
    gitBranch: w.git_branch ?? null,
    entrypoint: w.entrypoint ?? null,
    serviceTier: w.service_tier ?? null,
    isSidechain: w.is_sidechain,
    backfill: w.backfill,
  };
}

export function quotaWireToSnapshot(w: z.infer<typeof quotaSnapshotWireSchema>): QuotaSnapshot | null {
  const capturedAt = toDate(w.captured_at);
  if (!capturedAt) return null;
  return {
    profileId: w.profile_id,
    capturedAt,
    windows: w.windows.map((x) => ({
      windowKind: x.window_kind,
      utilizationPct: x.utilization_pct ?? 0,
      resetsAt: x.resets_at ? toDate(x.resets_at) : null,
    })),
    raw: w.raw ?? {},
  };
}

/** gzip 魔数。探针按 CONTRACT §2 发 gzip NDJSON，但不依赖 header 是否带对。 */
export function maybeGunzip(buf: Buffer): Buffer {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  return buf;
}

export interface DecodedBatch {
  events: UsageEvent[];
  /** 解析失败的行数（跳过而不是整批拒绝：一行坏掉不该让整批 1000 条重传） */
  invalid: number;
  /** 批内自身重复（探针重发、ssh 双写），这些也算 deduped */
  dedupedInBatch: number;
}

/**
 * gzip NDJSON → UsageEvent[]。纯函数，无 IO、无数据库。
 * 批内先按 @ua/core 的 dedupKey 收敛一次，能少打一大半数据库。
 */
export function decodeEventBatch(body: Buffer): DecodedBatch {
  const text = maybeGunzip(body).toString("utf8");
  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let dedupedInBatch = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      invalid++;
      continue;
    }
    const parsed = usageEventWireSchema.safeParse(json);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const ev = wireToEvent(parsed.data);
    if (!ev) {
      invalid++;
      continue;
    }
    const key = dedupKey(ev);
    if (seen.has(key)) {
      dedupedInBatch++;
      continue;
    }
    seen.add(key);
    events.push(ev);
  }
  return { events, invalid, dedupedInBatch };
}
