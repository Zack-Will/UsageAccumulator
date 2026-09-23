import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shareSessionTitles } from "../src/config.js";
import { MAX_TITLE_CHARS, parseTitleLine, sanitizeTitle, scanFileTitles } from "../src/session-titles.js";
import { ProbeStore } from "../src/store.js";

const custom = (sessionId: string, t: string) => JSON.stringify({ type: "custom-title", customTitle: t, sessionId });
const agent = (sessionId: string, t: string) => JSON.stringify({ type: "agent-name", agentName: t, sessionId });

describe("parseTitleLine", () => {
  it("认得 custom-title 行（实测形态）", () => {
    expect(parseTitleLine(custom("e8c04bc5", "Tibo重置哥"))).toEqual({ sessionId: "e8c04bc5", title: "Tibo重置哥", kind: "custom" });
  });

  it("认得 agent-name 行，作为兜底", () => {
    expect(parseTitleLine(agent("8eb5ce56", "Cleave"))?.kind).toBe("agent");
  });

  it("普通对话行不是标题行 —— 即使正文里提到了 custom-title 这个词", () => {
    const line = JSON.stringify({ type: "user", sessionId: "s", message: { content: 'what is "custom-title"?' } });
    expect(parseTitleLine(line)).toBeNull();
  });

  it("缺 sessionId、空标题、坏 JSON 一律不认", () => {
    expect(parseTitleLine(JSON.stringify({ type: "custom-title", customTitle: "x" }))).toBeNull();
    expect(parseTitleLine(custom("s", "   "))).toBeNull();
    expect(parseTitleLine('{"type":"custom-title", broken')).toBeNull();
  });
});

describe("sanitizeTitle", () => {
  it("压缩空白、去首尾空格", () => {
    expect(sanitizeTitle("  Cleave\n  架构图 \t优化 ")).toBe("Cleave 架构图 优化");
  });

  it("超长截断按字符算，不把中文截成半个", () => {
    const long = "中".repeat(MAX_TITLE_CHARS + 30);
    expect([...sanitizeTitle(long)!].length).toBe(MAX_TITLE_CHARS);
  });
});

describe("scanFileTitles", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("取每个会话**最后一次**出现的标题（桌面端改名时会重写一行）", async () => {
    const d = mkdtempSync(join(tmpdir(), "ua-titles-"));
    dirs.push(d);
    const f = join(d, "s.jsonl");
    writeFileSync(
      f,
      [
        JSON.stringify({ type: "user", sessionId: "s1", message: { content: "hi" } }),
        custom("s1", "Tibo重置哥"),
        JSON.stringify({ type: "assistant", sessionId: "s1" }),
        custom("s1", "Tibo重置哥身份"),
      ].join("\n") + "\n",
    );
    expect(await scanFileTitles(f)).toEqual([{ sessionId: "s1", title: "Tibo重置哥身份", kind: "custom" }]);
  });

  it("★ 后出现的 agent 名不能盖掉用户起的标题", async () => {
    const d = mkdtempSync(join(tmpdir(), "ua-titles-"));
    dirs.push(d);
    const f = join(d, "s.jsonl");
    writeFileSync(f, [custom("s1", "论文写作架构"), agent("s1", "Cleave")].join("\n") + "\n");
    expect((await scanFileTitles(f))[0]?.title).toBe("论文写作架构");
  });
});

describe("ProbeStore / 会话标题", () => {
  it("新标题待上报；上报后不再待上报；改名后重新待上报", () => {
    const s = new ProbeStore(":memory:");
    expect(s.putSessionTitle("s1", "Cleave", "custom")).toBe(true);
    expect(s.pendingSessionTitles(10)).toEqual([{ sessionId: "s1", title: "Cleave" }]);
    s.markSessionTitlesShipped([{ sessionId: "s1", title: "Cleave" }]);
    expect(s.pendingSessionTitles(10)).toEqual([]);
    s.putSessionTitle("s1", "Cleave 架构图优化", "custom");
    expect(s.pendingSessionTitles(10)).toEqual([{ sessionId: "s1", title: "Cleave 架构图优化" }]);
  });

  it("★ 发出去之后、回执之前又改了名：回执不能把新名字标成已上报", () => {
    const s = new ProbeStore(":memory:");
    s.putSessionTitle("s1", "旧名", "custom");
    const inFlight = s.pendingSessionTitles(10);
    s.putSessionTitle("s1", "新名", "custom"); // 在途时改名
    s.markSessionTitlesShipped(inFlight); // 旧名的回执回来了
    expect(s.pendingSessionTitles(10)).toEqual([{ sessionId: "s1", title: "新名" }]);
  });

  it("同一个标题重复写入不算变化", () => {
    const s = new ProbeStore(":memory:");
    s.putSessionTitle("s1", "Cleave", "custom");
    expect(s.putSessionTitle("s1", "Cleave", "custom")).toBe(false);
  });

  it("agent 名不覆盖用户标题，但用户标题可以覆盖 agent 名", () => {
    const s = new ProbeStore(":memory:");
    s.putSessionTitle("s1", "Cleave", "agent");
    expect(s.putSessionTitle("s1", "论文写作架构", "custom")).toBe(true);
    expect(s.putSessionTitle("s1", "Cleave", "agent")).toBe(false);
    expect(s.pendingSessionTitles(10)[0]?.title).toBe("论文写作架构");
  });
});

describe("shareSessionTitles / 隐私", () => {
  it("默认上报", () => {
    expect(shareSessionTitles({ share_session_titles: true, hash_project_paths: false })).toBe(true);
  });

  it("★ 要求隐藏项目路径的机器一律不报标题 —— 不管开关怎么写", () => {
    expect(shareSessionTitles({ share_session_titles: true, hash_project_paths: true })).toBe(false);
  });

  it("开关关掉就不报", () => {
    expect(shareSessionTitles({ share_session_titles: false, hash_project_paths: false })).toBe(false);
  });
});
