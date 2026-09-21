import { createHash } from "node:crypto";
import type { UsageEvent } from "./types.js";

/**
 * requestId 缺失时的兜底身份。
 * 借鉴 cc-switch 的 session_usage_dedup.semantic_id 思路。
 */
export function semanticId(parts: {
  sessionId: string;
  tsMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}): string {
  const key = [
    parts.sessionId,
    parts.tsMs,
    parts.model,
    parts.inputTokens,
    parts.outputTokens,
    parts.cacheReadTokens,
    parts.cacheWrite5mTokens,
    parts.cacheWrite1hTokens,
  ].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * 全局去重键。ssh 场景下同一次请求会被本地和远端两台机器各上报一次，
 * 这是预期行为，靠这个键在服务端吃掉。
 */
export function dedupKey(e: Pick<UsageEvent, "messageId" | "requestId" | "semanticId">): string {
  if (e.messageId && e.requestId) return `${e.messageId}|${e.requestId}`;
  return `sem|${e.semanticId}`;
}
