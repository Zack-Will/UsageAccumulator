import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Attributor, extractOwnerAccountUuid, readLiveBaseUrl } from "../src/attributor.js";
import { CcSwitchReader } from "../src/ccswitch.js";
import { ProbeStore } from "../src/store.js";
import { cleanup, makeCcSwitchDb, makeConfig, silentLog, tmpDir } from "./helpers.js";

describe("Attributor / 归属三级降级链", () => {
  let dir: string;
  let ccdb: string;
  let settings: string;

  beforeEach(() => {
    dir = tmpDir();
    ccdb = join(dir, "cc-switch.db");
    settings = join(dir, "settings.json");
  });
  afterEach(() => cleanup(dir));

  function build(overrides: Parameters<typeof makeConfig>[0] = {}) {
    const cfg = makeConfig({ ccSwitchDb: ccdb, claudeSettings: settings, ...overrides });
    const store = new ProbeStore(":memory:");
    const attr = new Attributor(cfg, store, silentLog);
    return { cfg, store, attr };
  }

  it("L1：代理日志命中 → proxy，provider_id 映射到 profile", () => {
    makeCcSwitchDb(ccdb, [{ requestId: "req_hit", providerId: "anyrouter", dataSource: "proxy" }]);
    const { attr } = build({ providerProfiles: { anyrouter: "gw-anyrouter" } });
    const res = attr.attribute({ requestId: "req_hit", tsMs: Date.now() + 1000, ownerAccountUuid: null });
    expect(res).toEqual({ profileId: "gw-anyrouter", level: "proxy" });
    attr.close();
  });

  it("L1：占位符 provider_id（本机实测的情形）→ 优雅降级，不返回 proxy", () => {
    // 实测：data_source 只有 session_log，provider_id 全是 `_session`，代理未启用
    makeCcSwitchDb(ccdb, [{ requestId: "req_ph", providerId: "_session", dataSource: "session_log" }]);
    const { attr, store } = build();
    store.appendTimeline(1, "claude-official", "settings");
    const res = attr.attribute({ requestId: "req_ph", tsMs: Date.now() + 1000, ownerAccountUuid: null });
    expect(res.level).toBe("timeline");
    attr.close();
  });

  it("L1：cc-switch DB 不存在 → 不抛错，直接降级", () => {
    const { attr, store } = build({ ccSwitchDb: join(dir, "nope.db") });
    store.appendTimeline(1, "claude-official", "settings");
    expect(attr.attribute({ requestId: "req_x", tsMs: Date.now() + 1000, ownerAccountUuid: null }).level).toBe("timeline");
    attr.close();
  });

  it("L2：live settings.json 的 env.ANTHROPIC_BASE_URL 决定 profile", () => {
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gw.example.com" } }));
    const { attr, store } = build({ baseUrlProfiles: { "https://gw.example.com": "gw-x" } });
    const t0 = attr.installedAt;
    const probe = attr.refreshTimeline(t0 + 1000);
    expect(probe.profileId).toBe("gw-x");
    expect(store.allTimeline()).toHaveLength(1);

    const res = attr.attribute({ requestId: "", tsMs: t0 + 5000, ownerAccountUuid: null });
    expect(res).toEqual({ profileId: "gw-x", level: "timeline" });
    attr.close();
  });

  it("L2：settings.json 没有 env 段 → 官方 OAuth，且 cc-switch is_current 不一致时以 live 为准", () => {
    // ★ 本机实测：is_current 指向 Anyrouter，但 settings.json 没有 env 段，实际跑的是官方 OAuth
    writeFileSync(settings, JSON.stringify({ theme: "auto" }));
    makeCcSwitchDb(ccdb, [], [{ id: "anyrouter", appType: "claude", name: "Anyrouter", isCurrent: true, baseUrl: "https://anyrouter" }]);
    const { attr } = build({ providerProfiles: { anyrouter: "gw-anyrouter" } });
    const probe = attr.refreshTimeline(1000);
    expect(probe.profileId).toBe("claude-official");
    expect(probe.source).toContain("official-oauth");
    expect(probe.mismatch).toContain("以 live settings 为准");
    attr.close();
  });

  it("L2：切换会追加时间线点，历史事件按其时间戳归到当时的 profile", () => {
    writeFileSync(settings, JSON.stringify({ theme: "auto" }));
    const { attr, store } = build();
    const t0 = attr.installedAt;
    attr.refreshTimeline(t0 + 1000);
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gw.example.com" } }));
    attr.refreshTimeline(t0 + 5000);

    expect(store.allTimeline().map((t) => t.profileId)).toEqual(["claude-official", "https://gw.example.com"]);
    expect(attr.attribute({ requestId: "", tsMs: t0 + 2000, ownerAccountUuid: null }).profileId).toBe("claude-official");
    expect(attr.attribute({ requestId: "", tsMs: t0 + 6000, ownerAccountUuid: null }).profileId).toBe(
      "https://gw.example.com",
    );
    attr.close();
  });

  it("L3：没有时间线时用 ownerAccountUuid，再没有就用 default_profile_id", () => {
    const { attr } = build({ accountProfiles: { "11111111-2222-3333-4444-555555555555": "acct-p" } });
    const withUuid = attr.attribute({
      requestId: "",
      tsMs: Date.now() + 1000,
      ownerAccountUuid: "11111111-2222-3333-4444-555555555555",
    });
    expect(withUuid).toEqual({ profileId: "acct-p", level: "fallback" });

    const without = attr.attribute({ requestId: "", tsMs: Date.now() + 1000, ownerAccountUuid: null });
    expect(without).toEqual({ profileId: "claude-official", level: "fallback" });
    attr.close();
  });

  it("探针安装前的历史数据一律 unknown", () => {
    const { attr, store } = build();
    store.appendTimeline(1, "gw-x", "settings"); // 就算有时间线也不算
    const res = attr.attribute({ requestId: "", tsMs: attr.installedAt - 1, ownerAccountUuid: null });
    expect(res.level).toBe("unknown");
    attr.close();
  });

  it("统计各级别的计数，供看板显示归属可信度", () => {
    makeCcSwitchDb(ccdb, [{ requestId: "req_hit", providerId: "p1", dataSource: "proxy" }]);
    const { attr } = build();
    const future = Date.now() + 1000;
    attr.attribute({ requestId: "req_hit", tsMs: future, ownerAccountUuid: null });
    attr.attribute({ requestId: "", tsMs: future, ownerAccountUuid: null });
    attr.attribute({ requestId: "", tsMs: attr.installedAt - 1, ownerAccountUuid: null });
    expect(attr.stats).toEqual({ proxy: 1, timeline: 0, fallback: 1, unknown: 1 });
    attr.close();
  });
});

describe("cc-switch 只读访问", () => {
  let dir: string;
  beforeEach(() => (dir = tmpDir()));
  afterEach(() => cleanup(dir));

  it("以只读模式打开，写入被 SQLite 拒绝", () => {
    const p = join(dir, "cc.db");
    makeCcSwitchDb(p, [{ requestId: "r", providerId: "x", dataSource: "proxy" }]);
    const r = new CcSwitchReader(p);
    expect(r.available).toBe(true);
    expect(() => r.connection!.exec("DELETE FROM proxy_request_logs")).toThrow();
    r.close();
  });

  it("统计真代理记录数，全占位符时为 0", () => {
    const p = join(dir, "cc.db");
    makeCcSwitchDb(p, [
      { requestId: "a", providerId: "_session", dataSource: "session_log" },
      { requestId: "b", providerId: "_codex_session", dataSource: "codex_session" },
      { requestId: "c", providerId: "real", dataSource: "proxy" },
    ]);
    const r = new CcSwitchReader(p);
    expect(r.proxyLogStats()).toEqual({ total: 3, realProxy: 1 });
    r.close();
  });

  it("文件不存在时 available=false 且不抛", () => {
    const r = new CcSwitchReader(join(dir, "missing.db"));
    expect(r.available).toBe(false);
    expect(r.lookupProxy("x")).toBeNull();
    expect(r.currentProvider()).toBeNull();
  });
});

describe("辅助解析", () => {
  it("extractOwnerAccountUuid 只在有该字段时命中", () => {
    expect(extractOwnerAccountUuid('{"ownerAccountUuid":"11111111-2222-3333-4444-555555555555"}')).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(extractOwnerAccountUuid('{"ownerAccountUuid":null}')).toBeNull();
    expect(extractOwnerAccountUuid('{"type":"assistant"}')).toBeNull();
  });

  it("readLiveBaseUrl：文件不存在或无 env 段都返回 null（= 官方 OAuth）", () => {
    expect(readLiveBaseUrl("/definitely/not/here.json")).toBeNull();
  });
});
