import { pino, type Logger } from "pino";

/**
 * 结构化日志。凭证绝不进日志 —— 这里的 redact 是最后一道防线，
 * 真正的防线是调用方根本不要把 sessionKey / token 传进日志对象。
 */
const REDACT = [
  "machine_token",
  "machineToken",
  "token",
  "sessionKey",
  "session_key",
  "cookie",
  "Cookie",
  "authorization",
  "Authorization",
  "credential",
  "*.machine_token",
  "*.machineToken",
  "*.sessionKey",
  "*.token",
  "*.cookie",
  "*.authorization",
];

export function createLogger(level = process.env["UA_PROBE_LOG_LEVEL"] ?? "info"): Logger {
  return pino({
    level,
    base: { component: "ua-probe" },
    redact: { paths: REDACT, censor: "[redacted]" },
  });
}

export type { Logger };

/** 只保留末 4 位，用于"我确实读到凭证了"这类日志，永远不打印全文。 */
export function fingerprint(secret: string): string {
  if (!secret) return "<empty>";
  return `…${secret.slice(-4)} (len=${secret.length})`;
}
