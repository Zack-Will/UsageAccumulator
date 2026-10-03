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

/**
 * 同一条消息（同一个 dedupKey）的多份记录里，哪一份的用量更完整。
 *
 * Claude Code 会把一条消息写成多行，且子代理文件里只有最后一行才是最终用量 ——
 * 去重时先到先得会系统性地留下流式中途值。所以各处去重（探针队列、服务端批内、
 * 入库冲突）都必须按这个分数**取大**，而不是取先。
 *
 * 先比 output_tokens（同一条消息里它只增不减，input / cache 各行相同），
 * 相等时最终行优先，旧探针没报的（null）垫底。服务端 SQL 里有一份同样的公式。
 */
export function usageRank(e: Pick<UsageEvent, "outputTokens" | "outputFinal">): number {
  const finality = e.outputFinal === true ? 2 : e.outputFinal === false ? 1 : 0;
  return e.outputTokens * 3 + finality;
}
