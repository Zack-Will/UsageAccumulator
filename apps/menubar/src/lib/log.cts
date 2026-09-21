/**
 * 极简日志。**任何情况下都不写 token。**
 * 所有对外可见的字符串在进这里之前必须先过 redact()。
 */

/** 把可能混进 URL / 错误信息里的凭证抹掉。 */
export function redact(input: string): string {
  return input
    .replace(/Bearer\s+[\w.\-~+/]+=*/gi, "Bearer ***")
    .replace(/([?&](?:token|access_token|machine_token|key)=)[^&\s]*/gi, "$1***")
    .replace(/\/\/[^/@\s]+@/g, "//***@");
}

function emit(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
  const line = `[ua-menubar] ${level} ${redact(msg)}`;
  if (extra === undefined) {
    console[level](line);
  } else {
    console[level](line, typeof extra === "string" ? redact(extra) : extra);
  }
}

export const log = {
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};

/** 把任意 throw 出来的东西压成一句脱敏短语。 */
export function errText(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
