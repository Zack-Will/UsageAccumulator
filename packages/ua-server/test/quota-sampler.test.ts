import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QuotaAuthError, QuotaUnavailableError, type QuotaSnapshot } from "@ua/core";
import { QuotaSampler } from "../src/quota-sampler.js";
import { FileSessionVault, isVaultSafeId, MemorySessionVault } from "../src/quota-vault.js";

const MIN = 60_000;
const KEY = "sk-ant-sid01-FIRST-SECRET-KEY";
const KEY2 = "sk-ant-sid01-SECOND-SECRET-KEY";

type Mode = "ok" | "session" | "challenge" | "down";

/** 假的 claude.ai：按 mode 回应，记下每次调用用的是哪个会话。 */
class FakeClaude {
  mode: Mode = "ok";
  calls: string[] = [];
  private fail(): never {
    if (this.mode === "session") throw new QuotaAuthError("GET x 返回 403，sessionKey 可能已失效", 403, "session");
    if (this.mode === "challenge") throw new QuotaAuthError("GET x 被 Cloudflare 质询（403）", 403, "challenge");
    throw new QuotaUnavailableError("GET x 返回 HTTP 503");
  }
  async orgId(sessionKey: string): Promise<string> {
    this.calls.push(`org:${sessionKey}`);
    if (this.mode !== "ok") this.fail();
    return "org-1";
  }
  async snapshot(sessionKey: string, orgId: string, profileId: string, now = new Date()): Promise<QuotaSnapshot> {
    this.calls.push(`usage:${sessionKey}:${orgId}`);
    if (this.mode !== "ok") this.fail();
    return { profileId, capturedAt: now, windows: [{ windowKind: "five_hour", utilizationPct: 42, resetsAt: null }], raw: {} };
  }
}

let clock: Date;
let vault: MemorySessionVault;
let claude: FakeClaude;
let recorded: QuotaSnapshot[];
let logs: unknown[];
let sampler: QuotaSampler;

const at = (ms: number) => new Date(Date.UTC(2026, 8, 23, 10, 0) + ms);

beforeEach(() => {
  clock = at(0);
  vault = new MemorySessionVault();
  claude = new FakeClaude();
  recorded = [];
  logs = [];
  const log = { info: (o: object, m: string) => logs.push([o, m]), warn: (o: object, m: string) => logs.push([o, m]), error: (o: object, m: string) => logs.push([o, m]) };
  sampler = new QuotaSampler({
    vault,
    client: claude,
    record: async (s) => {
      recorded.push(s);
    },
    log,
    now: () => clock,
    random: () => 0.5,
  });
});

describe("QuotaSampler", () => {
  it("没存会话就什么都不抓", async () => {
    await sampler.tickAll();
    expect(claude.calls).toEqual([]);
    expect((await sampler.status("claude-official")).state).toBe("none");
  });

  it("存了会话、还没抓过时是 pending；抓到后入库并按 间隔 + 抖动 排下一次", async () => {
    await vault.write("claude-official", KEY);
    expect((await sampler.status("claude-official")).state).toBe("pending");

    await sampler.tickAll();
    expect(recorded).toHaveLength(1);
    const s = await sampler.status("claude-official");
    expect(s.state).toBe("ok");
    expect(s.lastOkAt).toEqual(at(0));
    expect(s.nextAttemptAt).toEqual(at(5 * MIN + 30_000)); // random 0.5 × 60s 抖动
  });

  it("没到点不抓，到点再抓；org 只解析一次", async () => {
    await vault.write("claude-official", KEY);
    await sampler.tickAll();
    clock = at(4 * MIN);
    await sampler.tickAll();
    expect(recorded).toHaveLength(1);
    clock = at(6 * MIN);
    await sampler.tickAll();
    expect(recorded).toHaveLength(2);
    expect(claude.calls.filter((c) => c.startsWith("org:"))).toHaveLength(1);
  });

  it("会话失效按 15 分钟 → 1 小时 → 6 小时退避，不重试到被风控", async () => {
    await vault.write("claude-official", KEY);
    claude.mode = "session";
    await sampler.tickAll();
    let s = await sampler.status("claude-official");
    expect(s.state).toBe("auth");
    expect(s.nextAttemptAt).toEqual(at(15 * MIN));

    const before = claude.calls.length;
    clock = at(10 * MIN);
    await sampler.tickAll();
    expect(claude.calls.length).toBe(before);

    clock = at(16 * MIN);
    await sampler.tickAll();
    s = await sampler.status("claude-official");
    expect(s.nextAttemptAt).toEqual(at(16 * MIN + 60 * MIN));
  });

  it("被 Cloudflare 质询单独标 blocked，同样退避", async () => {
    await vault.write("claude-official", KEY);
    claude.mode = "challenge";
    await sampler.tickAll();
    const s = await sampler.status("claude-official");
    expect(s.state).toBe("blocked");
    expect(s.nextAttemptAt).toEqual(at(15 * MIN));
  });

  it("网络或 5xx 是暂时故障：标 error，下一轮照常重试，不进退避阶梯", async () => {
    await vault.write("claude-official", KEY);
    claude.mode = "down";
    await sampler.tickAll();
    const s = await sampler.status("claude-official");
    expect(s.state).toBe("error");
    expect(s.nextAttemptAt).toEqual(at(5 * MIN));
  });

  it("换了会话立刻重试：旧会话的退避不能连累新会话", async () => {
    await vault.write("claude-official", KEY);
    claude.mode = "session";
    await sampler.tickAll();

    await vault.write("claude-official", KEY2);
    claude.mode = "ok";
    clock = at(1 * MIN);
    await sampler.tickAll();
    expect((await sampler.status("claude-official")).state).toBe("ok");
    expect(claude.calls.at(-1)).toBe(`usage:${KEY2}:org-1`);
  });

  it("kick 无视退避马上抓一次（看板刚保存完会话时用）", async () => {
    await vault.write("claude-official", KEY);
    claude.mode = "session";
    await sampler.tickAll();
    claude.mode = "ok";
    expect((await sampler.kick("claude-official")).state).toBe("ok");
  });

  it("会话被删掉后状态回到 none，不留旧的「正常」", async () => {
    await vault.write("claude-official", KEY);
    await sampler.tickAll();
    await vault.remove("claude-official");
    await sampler.tickAll();
    expect((await sampler.status("claude-official")).state).toBe("none");
  });

  it("日志与状态里永远没有 sessionKey", async () => {
    await vault.write("claude-official", KEY);
    claude.mode = "session";
    await sampler.tickAll();
    const s = await sampler.status("claude-official");
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
});

describe("FileSessionVault", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), "ua-vault-")), "claude-sessions");
  });
  afterEach(async () => {
    await rm(join(dir, ".."), { recursive: true, force: true });
  });

  it("目录 0700、文件 0600，读出来去掉首尾空白", async () => {
    const v = new FileSessionVault(dir);
    await v.write("claude-official", KEY);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "claude-official"))).mode & 0o777).toBe(0o600);
    expect(await v.read("claude-official")).toBe(KEY);
    expect(await v.list()).toEqual(["claude-official"]);
    // 不留临时文件
    expect(await readdir(dir)).toEqual(["claude-official"]);
  });

  it("覆盖写是原子的，外部直接改文件也能读到新值", async () => {
    const v = new FileSessionVault(dir);
    await v.write("claude-official", KEY);
    await v.write("claude-official", KEY2);
    expect(await readFile(join(dir, "claude-official"), "utf8")).toBe(`${KEY2}\n`);
    await writeFile(join(dir, "claude-official"), `${KEY}\n`, { mode: 0o600 });
    expect(await v.read("claude-official")).toBe(KEY);
  });

  it("权限过宽要告警", async () => {
    const warns: string[] = [];
    const v = new FileSessionVault(dir, (m) => warns.push(m));
    await v.write("claude-official", KEY);
    await writeFile(join(dir, "claude-official"), KEY, { mode: 0o644 });
    const { chmod } = await import("node:fs/promises");
    await chmod(join(dir, "claude-official"), 0o644);
    await v.read("claude-official");
    expect(warns.join("")).toContain("权限过宽");
  });

  it("profile_id 当文件名：挡住路径穿越与隐藏文件", async () => {
    expect(isVaultSafeId("claude-official")).toBe(true);
    for (const bad of ["../etc", "a/b", ".hidden", "", "x".repeat(65)]) expect(isVaultSafeId(bad)).toBe(false);
    await expect(new FileSessionVault(dir).write("../escape", KEY)).rejects.toThrow();
  });

  it("删除后读不到，列表为空", async () => {
    const v = new FileSessionVault(dir);
    await v.write("claude-official", KEY);
    expect(await v.remove("claude-official")).toBe(true);
    expect(await v.read("claude-official")).toBeNull();
    expect(await v.list()).toEqual([]);
    expect(await v.remove("claude-official")).toBe(false);
  });
});
