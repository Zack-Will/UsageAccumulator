import { pino, type Logger } from "pino";

/**
 * 结构化日志（CONTRACT §4）。
 *
 * redact 是最后一道保险：契约规定 prompt / 响应正文 / 工具参数不得出现在任何
 * 上报或日志里，服务端本来就没有这些字段，但万一探针端将来多带了什么，
 * 这里直接抹掉而不是打出去。
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "*.prompt",
  "*.content",
  "*.message.content",
  "*.text",
  "*.tool_input",
  "machine_token",
  "enroll_token",
  "sessionKey",
];

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { svc: "ua-server" },
  });
}
