import { createHmac } from "node:crypto";
import type { QuotaSnapshot, UsageEvent } from "@ua/core";

/**
 * 上报线格式（docs/CONTRACT.md §1.1）。
 *
 * ★ 这里只列 usage 元数据。prompt / 响应正文 / 工具参数**永远不在这张表里**，
 * 而且因为是显式字段映射（不是 spread），新增的 JSONL 字段也不会意外泄漏出去。
 */
export interface WireUsageEvent {
  message_id: string;
  request_id: string;
  semantic_id: string;
  machine_id: string;
  app_type: string;
  profile_id: string;
  attribution_level: string;
  ts: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  session_id: string;
  project_slug: string | null;
  git_branch: string | null;
  entrypoint: string | null;
  service_tier: string | null;
  is_sidechain: boolean;
  /** output_tokens 是不是最终值；false = 最终行没写进 JSONL，只是下界（CONTRACT §1.1） */
  output_final: boolean | null;
  backfill: boolean;
}

/** `hash_project_paths = true` 时上报 HMAC 后的 slug，看板显示别名（ARCHITECTURE §9）。 */
export function hashProjectSlug(slug: string, secret: string): string {
  return "h_" + createHmac("sha256", secret).update(slug).digest("hex").slice(0, 24);
}

export function toWireEvent(
  e: UsageEvent,
  opts: { hashProjectPaths: boolean; projectHashSecret: string },
): WireUsageEvent {
  let slug = e.projectSlug;
  if (slug && opts.hashProjectPaths && opts.projectHashSecret) {
    slug = hashProjectSlug(slug, opts.projectHashSecret);
  }
  return {
    // 契约 §1.2：message_id / request_id 任一缺失时用 semantic_id 兜底，
    // 保证主键始终非空；semantic_id 一并带上，服务端可自行校验。
    message_id: e.messageId || e.semanticId,
    request_id: e.requestId || e.semanticId,
    semantic_id: e.semanticId,
    machine_id: e.machineId,
    app_type: e.appType,
    profile_id: e.profileId,
    attribution_level: e.attributionLevel,
    ts: e.ts.toISOString(),
    model: e.model,
    input_tokens: e.inputTokens,
    output_tokens: e.outputTokens,
    thinking_tokens: e.thinkingTokens,
    cache_read_tokens: e.cacheReadTokens,
    cache_write_5m_tokens: e.cacheWrite5mTokens,
    cache_write_1h_tokens: e.cacheWrite1hTokens,
    session_id: e.sessionId,
    project_slug: slug,
    git_branch: e.gitBranch,
    entrypoint: e.entrypoint,
    service_tier: e.serviceTier,
    is_sidechain: e.isSidechain,
    output_final: e.outputFinal,
    backfill: e.backfill,
  };
}

export interface WireQuotaSnapshot {
  profile_id: string;
  captured_at: string;
  windows: { window_kind: string; utilization_pct: number; resets_at: string | null }[];
  raw: unknown;
}

export function toWireQuota(s: QuotaSnapshot): WireQuotaSnapshot {
  return {
    profile_id: s.profileId,
    captured_at: s.capturedAt.toISOString(),
    windows: s.windows.map((w) => ({
      window_kind: w.windowKind,
      utilization_pct: w.utilizationPct,
      resets_at: w.resetsAt ? w.resetsAt.toISOString() : null,
    })),
    raw: s.raw,
  };
}
