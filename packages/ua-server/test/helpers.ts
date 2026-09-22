import { semanticId, type UsageEvent } from "@ua/core";
import { loadConfig, type Config } from "../src/config.js";

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      UA_DASHBOARD_TOKEN: "dash-token",
      UA_DASHBOARD_PASSWORD: "open-sesame",
      UA_ENROLL_TOKEN: "enroll-token",
      UA_DASHBOARD_URL: "https://ua.example.com",
      UA_LOG_LEVEL: "silent",
      UA_PRICING_FILE: "deploy/pricing.json",
    } as NodeJS.ProcessEnv),
    ...over,
  };
}

export const AUTH = { authorization: "Bearer dash-token" };

let seq = 0;

export function makeEvent(over: Partial<UsageEvent> = {}): UsageEvent {
  seq++;
  const base: UsageEvent = {
    messageId: `msg_${seq}`,
    requestId: `req_${seq}`,
    semanticId: "",
    machineId: "machine-a",
    appType: "claude",
    profileId: "claude-official",
    attributionLevel: "timeline",
    ts: new Date("2026-09-21T06:00:00.000Z"),
    model: "claude-opus-5",
    inputTokens: 2,
    outputTokens: 726,
    thinkingTokens: 295,
    cacheReadTokens: 38256,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 31626,
    sessionId: "session-1",
    projectSlug: "-Users-me-Repos-Cleave",
    gitBranch: "HEAD",
    entrypoint: "claude-desktop",
    serviceTier: "standard",
    isSidechain: false,
    backfill: false,
    ...over,
  };
  if (!base.semanticId) {
    base.semanticId = semanticId({
      sessionId: base.sessionId,
      tsMs: base.ts.getTime(),
      model: base.model,
      inputTokens: base.inputTokens,
      outputTokens: base.outputTokens,
      cacheReadTokens: base.cacheReadTokens,
      cacheWrite5mTokens: base.cacheWrite5mTokens,
      cacheWrite1hTokens: base.cacheWrite1hTokens,
    });
  }
  return base;
}

/** UsageEvent → CONTRACT §1.1 的线上 JSON（snake_case）。 */
export function toWire(e: UsageEvent): Record<string, unknown> {
  return {
    message_id: e.messageId,
    request_id: e.requestId,
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
    project_slug: e.projectSlug,
    git_branch: e.gitBranch,
    entrypoint: e.entrypoint,
    service_tier: e.serviceTier,
    is_sidechain: e.isSidechain,
    backfill: e.backfill,
  };
}

export function ndjson(objs: Record<string, unknown>[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
}
