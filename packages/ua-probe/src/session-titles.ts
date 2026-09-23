import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * 会话标题：Claude 桌面端 / Claude Code 在会话 JSONL 里写的
 *   {"type":"custom-title","customTitle":"糖果形状口味组合问题","sessionId":"…"}
 *   {"type":"agent-name","agentName":"Cleave","sessionId":"…"}
 * 前者是侧边栏里那个名字（会随改名重复写入，以最后一条为准），后者是没有标题时的兜底。
 *
 * 为什么需要它：桌面端不选项目文件夹直接开对话时，会自己建一个
 * `scratch-2026-09-22-105cae` 这样的目录，看板只能拿随机后缀「105cae」当项目名。
 * 有了标题，这类会话才看得出是哪一条。
 *
 * 只取标题，不碰任何对话正文。
 */

export type TitleKind = "custom" | "agent";

export interface SessionTitle {
  sessionId: string;
  title: string;
  kind: TitleKind;
}

/** 标题上限：桌面端的标题一般十几个字，截断只防异常输入把表撑大 */
export const MAX_TITLE_CHARS = 120;

export function sanitizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return [...t].length > MAX_TITLE_CHARS ? [...t].slice(0, MAX_TITLE_CHARS).join("") : t;
}

/**
 * 从一行 JSONL 里认出标题行。不是标题行返回 null。
 * 先做子串预判再 JSON.parse：绝大多数行是对话内容，没必要逐行完整解析。
 */
export function parseTitleLine(raw: string): SessionTitle | null {
  const isCustom = raw.includes('"custom-title"');
  const isAgent = !isCustom && raw.includes('"agent-name"');
  if (!isCustom && !isAgent) return null;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId = typeof d["sessionId"] === "string" ? d["sessionId"] : "";
  if (!sessionId) return null;
  if (d["type"] === "custom-title") {
    const title = sanitizeTitle(d["customTitle"]);
    return title ? { sessionId, title, kind: "custom" } : null;
  }
  if (d["type"] === "agent-name") {
    const title = sanitizeTitle(d["agentName"]);
    return title ? { sessionId, title, kind: "agent" } : null;
  }
  return null;
}

/**
 * 整个文件扫一遍，只收标题行，返回每个会话最后一次出现的标题。
 * 给「老会话补标题」用：游标之前的内容增量解析不会再读，老会话的标题只能这样补一次。
 * 按行流式读，不会把几百 MB 的日志一次读进内存。
 */
export async function scanFileTitles(path: string): Promise<SessionTitle[]> {
  const latest = new Map<string, SessionTitle>();
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = parseTitleLine(line);
    if (!t) continue;
    const prev = latest.get(t.sessionId);
    // 自定义标题优先于 agent 名：后出现的 agent 名不能把用户起的标题盖掉
    if (prev?.kind === "custom" && t.kind === "agent") continue;
    latest.set(t.sessionId, t);
  }
  return [...latest.values()];
}
