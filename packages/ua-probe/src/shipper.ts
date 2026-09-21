import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { request } from "undici";

export type ShipVerdict = "ok" | "retry" | "drop";

export interface ShipOk {
  ok: true;
  accepted: number;
  deduped: number;
  status: number;
}

export interface ShipFail {
  ok: false;
  verdict: "retry" | "drop";
  status: number;
  message: string;
}

export type ShipResult = ShipOk | ShipFail;

/**
 * 什么该重试、什么该丢。
 * 4xx（除 408/429 与鉴权类）重试多少次都不会变好，而且会**堵住队列头**，
 * 让后面所有正常事件都发不出去 —— 所以直接丢并告警，宁可丢一批也不能卡死整条链路。
 */
export function classifyStatus(status: number): ShipVerdict {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403 || status === 408 || status === 429) return "retry";
  if (status >= 500) return "retry";
  return "drop";
}

/** 指数退避：1s → 最长 5min（ARCHITECTURE §5.2），带 ±20% 抖动避免多机同步重试。 */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 300_000, rand = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = exp * 0.2 * (rand() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

export function buildNdjsonBody(lines: string[]): { body: Buffer; idempotencyKey: string } {
  const ndjson = lines.join("\n") + "\n";
  const body = gzipSync(Buffer.from(ndjson, "utf8"));
  const idempotencyKey = createHash("sha256").update(ndjson).digest("hex").slice(0, 32);
  return { body, idempotencyKey };
}

export interface ShipperOptions {
  serverUrl: string;
  machineToken: string;
  timeoutMs?: number;
}

/** 上报：gzip NDJSON + bearer token（契约 §2）。 */
export class Shipper {
  private readonly base: string;

  constructor(private readonly opts: ShipperOptions) {
    this.base = opts.serverUrl.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.machineToken}`,
      ...extra,
    };
  }

  async sendEvents(lines: string[]): Promise<ShipResult> {
    if (lines.length === 0) return { ok: true, accepted: 0, deduped: 0, status: 200 };
    const { body, idempotencyKey } = buildNdjsonBody(lines);
    try {
      const res = await request(`${this.base}/v1/ingest/events`, {
        method: "POST",
        body,
        headers: this.headers({
          "content-type": "application/x-ndjson",
          "content-encoding": "gzip",
          "idempotency-key": idempotencyKey,
        }),
        headersTimeout: this.opts.timeoutMs ?? 30_000,
        bodyTimeout: this.opts.timeoutMs ?? 30_000,
      });
      const verdict = classifyStatus(res.statusCode);
      const text = await res.body.text();
      if (verdict !== "ok") {
        return { ok: false, verdict, status: res.statusCode, message: text.slice(0, 500) };
      }
      let accepted = lines.length;
      let deduped = 0;
      try {
        const parsed = JSON.parse(text) as { accepted?: number; deduped?: number };
        if (typeof parsed.accepted === "number") accepted = parsed.accepted;
        if (typeof parsed.deduped === "number") deduped = parsed.deduped;
      } catch {
        /* 服务端没回 JSON：按全量接收处理 */
      }
      return { ok: true, accepted, deduped, status: res.statusCode };
    } catch (err) {
      // 网络层错误（断网、DNS、超时）一律可重试 —— 队列就是为这种情况准备的
      return { ok: false, verdict: "retry", status: 0, message: (err as Error).message };
    }
  }

  async sendQuota(payload: string): Promise<ShipResult> {
    try {
      const res = await request(`${this.base}/v1/ingest/quota`, {
        method: "POST",
        body: payload,
        headers: this.headers({ "content-type": "application/json" }),
        headersTimeout: this.opts.timeoutMs ?? 30_000,
        bodyTimeout: this.opts.timeoutMs ?? 30_000,
      });
      const verdict = classifyStatus(res.statusCode);
      const text = await res.body.text();
      if (verdict !== "ok") {
        return { ok: false, verdict, status: res.statusCode, message: text.slice(0, 500) };
      }
      return { ok: true, accepted: 1, deduped: 0, status: res.statusCode };
    } catch (err) {
      return { ok: false, verdict: "retry", status: 0, message: (err as Error).message };
    }
  }

  /** install 用：一次性 enroll token 换长期 machine token（ARCHITECTURE §9）。 */
  static async enroll(
    serverUrl: string,
    enrollToken: string,
    hostname: string,
    os: string,
  ): Promise<{ machineId: string; machineToken: string }> {
    const res = await request(`${serverUrl.replace(/\/+$/, "")}/v1/enroll`, {
      method: "POST",
      body: JSON.stringify({ enroll_token: enrollToken, hostname, os }),
      headers: { "content-type": "application/json" },
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`enroll 失败 HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
    }
    const doc = JSON.parse(text) as { machine_id?: string; machine_token?: string };
    if (!doc.machine_id || !doc.machine_token) throw new Error("enroll 响应缺少 machine_id / machine_token");
    return { machineId: doc.machine_id, machineToken: doc.machine_token };
  }
}
