import { semanticId } from "./dedup.js";
import type { AppType, AttributionLevel, UsageEvent } from "./types.js";

export interface ParseContext {
  machineId: string;
  profileId: string;
  attributionLevel: AttributionLevel;
  appType?: AppType;
  projectSlug?: string | null;
  backfill?: boolean;
}

export interface ParseWarning {
  kind: "missing-cache-breakdown" | "cache-sum-mismatch" | "missing-request-id" | "bad-timestamp";
  detail: string;
}

export interface ParseResult {
  event: UsageEvent | null;
  warnings: ParseWarning[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * 解析一行 Claude Code 会话 JSONL。
 * 只有 type === "assistant" 且带 message.usage 的行才产生事件，其余返回 null。
 * 字段映射见 docs/CONTRACT.md §1.1。
 */
export function parseLine(raw: string, ctx: ParseContext): ParseResult {
  const warnings: ParseWarning[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return { event: null, warnings };

  let d: Record<string, unknown>;
  try {
    d = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { event: null, warnings };
  }
  if (d["type"] !== "assistant") return { event: null, warnings };

  const message = d["message"] as Record<string, unknown> | undefined;
  const usage = message?.["usage"] as Record<string, unknown> | undefined;
  if (!message || !usage) return { event: null, warnings };

  const tsRaw = d["timestamp"];
  const ts = typeof tsRaw === "string" ? new Date(tsRaw) : new Date(NaN);
  if (Number.isNaN(ts.getTime())) {
    warnings.push({ kind: "bad-timestamp", detail: String(tsRaw) });
    return { event: null, warnings };
  }

  // ── 缓存写入必须拆 5m / 1h：两档单价不同
  const creation = usage["cache_creation"] as Record<string, unknown> | undefined;
  const creationTotal = num(usage["cache_creation_input_tokens"]);
  let w5 = 0;
  let w1 = 0;
  if (creation) {
    w5 = num(creation["ephemeral_5m_input_tokens"]);
    w1 = num(creation["ephemeral_1h_input_tokens"]);
    if (creationTotal > 0 && w5 + w1 !== creationTotal) {
      warnings.push({
        kind: "cache-sum-mismatch",
        detail: `5m(${w5})+1h(${w1}) != cache_creation_input_tokens(${creationTotal})`,
      });
    }
  } else if (creationTotal > 0) {
    // 退化：拿不到拆分就全记 5m，并留下告警，绝不静默按 1h 计价
    w5 = creationTotal;
    warnings.push({
      kind: "missing-cache-breakdown",
      detail: `cache_creation 缺失，${creationTotal} tokens 全部按 5m 计`,
    });
  }

  const details = usage["output_tokens_details"] as Record<string, unknown> | undefined;
  const inputTokens = num(usage["input_tokens"]);
  const outputTokens = num(usage["output_tokens"]);
  const cacheReadTokens = num(usage["cache_read_input_tokens"]);
  const sessionId = typeof d["sessionId"] === "string" ? d["sessionId"] : "";
  const model = typeof message["model"] === "string" ? message["model"] : "";
  const messageId = typeof message["id"] === "string" ? message["id"] : "";
  const requestId = typeof d["requestId"] === "string" ? d["requestId"] : "";

  if (!requestId) {
    warnings.push({ kind: "missing-request-id", detail: messageId || sessionId });
  }

  const sem = semanticId({
    sessionId,
    tsMs: ts.getTime(),
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWrite5mTokens: w5,
    cacheWrite1hTokens: w1,
  });

  const event: UsageEvent = {
    messageId,
    requestId,
    semanticId: sem,
    machineId: ctx.machineId,
    appType: ctx.appType ?? "claude",
    profileId: ctx.profileId,
    attributionLevel: ctx.attributionLevel,
    ts,
    model,
    inputTokens,
    outputTokens,
    thinkingTokens: num(details?.["thinking_tokens"]),
    cacheReadTokens,
    cacheWrite5mTokens: w5,
    cacheWrite1hTokens: w1,
    sessionId,
    projectSlug: ctx.projectSlug ?? null,
    gitBranch: typeof d["gitBranch"] === "string" ? d["gitBranch"] : null,
    entrypoint: typeof d["entrypoint"] === "string" ? d["entrypoint"] : null,
    serviceTier: typeof usage["service_tier"] === "string" ? usage["service_tier"] : null,
    isSidechain: d["isSidechain"] === true,
    outputFinal: typeof message["stop_reason"] === "string" || "iterations" in usage,
    backfill: ctx.backfill ?? false,
  };
  return { event, warnings };
}

/** 项目目录名 → project_slug。探针按目录归类时用。 */
export function projectSlugFromPath(filePath: string): string | null {
  const m = /\/projects\/([^/]+)\//.exec(filePath);
  return m?.[1] ?? null;
}
