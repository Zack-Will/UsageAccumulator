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
 * 服务端的错误信封（契约 §2）：`{"error":{"code":…,"message":…}}`。
 * 只有回了这个形状，才说明**是我们的服务端**在表态；
 * frp / nginx / 门户劫持的错误页不是这个形状，也就不该被当成裁决。
 */
export function isServerErrorEnvelope(text: string): boolean {
  try {
    const p = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof p?.error?.code === "string";
  } catch {
    return false;
  }
}

/**
 * 什么该重试、什么该丢。
 * 4xx（除 408/429 与鉴权类）重试多少次都不会变好，而且会**堵住队列头**，
 * 让后面所有正常事件都发不出去 —— 所以直接丢并告警，宁可丢一批也不能卡死整条链路。
 *
 * ★ 但「丢」的前提是**服务端确实表了态**。中间链路也会给 4xx ——
 * frp 隧道没注册时回的是 404 HTML 页 —— 那是基建抖动，重试就能好。
 * 把它们一并丢掉等于静默丢数据，2026-09-21 实测发生过一次：
 * 探针收到 frp 的 404 页面，一整批事件被判永久失败丢弃。
 * 所以 fromServer 为 false 时一律重试，宁可堆在本地队列里也不丢。
 */
export function classifyStatus(status: number, fromServer = true): ShipVerdict {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403 || status === 408 || status === 429) return "retry";
  if (status >= 500) return "retry";
  return fromServer ? "drop" : "retry";
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
      // 先读 body —— 是否出自我们的服务端，决定 4xx 该丢还是该重试
      const text = await res.body.text();
      const verdict = classifyStatus(res.statusCode, isServerErrorEnvelope(text));
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
      const text = await res.body.text();
      const verdict = classifyStatus(res.statusCode, isServerErrorEnvelope(text));
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
