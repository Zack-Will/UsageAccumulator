import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { dedupKey, semanticId } from "@ua/core";
import { decodeEventBatch, maybeGunzip, quotaSnapshotWireSchema, quotaWireToSnapshot, wireToEvent, usageEventWireSchema } from "../src/wire.js";
import { makeEvent, ndjson, toWire } from "./helpers.js";

describe("wire decoding", () => {
  it("decodes plain NDJSON", () => {
    const body = Buffer.from(ndjson([toWire(makeEvent()), toWire(makeEvent())]));
    const out = decodeEventBatch(body);
    expect(out.events).toHaveLength(2);
    expect(out.invalid).toBe(0);
  });

  it("decodes gzip NDJSON by magic bytes, not by header", () => {
    const body = gzipSync(Buffer.from(ndjson([toWire(makeEvent())])));
    expect(maybeGunzip(body).toString("utf8")).toContain("message_id");
    expect(decodeEventBatch(body).events).toHaveLength(1);
  });

  it("maps snake_case wire fields onto the core UsageEvent", () => {
    const e = makeEvent({ cacheWrite5mTokens: 11, cacheWrite1hTokens: 22 });
    const parsed = usageEventWireSchema.parse(toWire(e));
    const back = wireToEvent(parsed)!;
    expect(back.messageId).toBe(e.messageId);
    expect(back.cacheWrite5mTokens).toBe(11);
    // ★ 5m 与 1h 绝不能合并：单价不同
    expect(back.cacheWrite1hTokens).toBe(22);
    expect(back.ts.toISOString()).toBe(e.ts.toISOString());
    expect(back.projectSlug).toBe(e.projectSlug);
  });

  it("computes semantic_id when the probe did not send one (CONTRACT §1.2)", () => {
    const e = makeEvent({ requestId: "" });
    const wire = toWire(e);
    delete wire["semantic_id"];
    const back = wireToEvent(usageEventWireSchema.parse(wire))!;
    expect(back.requestId).toBe("");
    expect(back.semanticId).toBe(
      semanticId({
        sessionId: e.sessionId,
        tsMs: e.ts.getTime(),
        model: e.model,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens,
        cacheWrite5mTokens: e.cacheWrite5mTokens,
        cacheWrite1hTokens: e.cacheWrite1hTokens,
      }),
    );
    // request_id 为空时去重键退回 semantic_id
    expect(dedupKey(back)).toBe(`sem|${back.semanticId}`);
  });

  it("collapses in-batch duplicates (ssh 双写 / 探针重发)", () => {
    const e = makeEvent();
    const body = Buffer.from(ndjson([toWire(e), toWire(e), toWire(e)]));
    const out = decodeEventBatch(body);
    expect(out.events).toHaveLength(1);
    expect(out.dedupedInBatch).toBe(2);
  });

  it("dedups empty-request_id rows by semantic_id, not by request_id alone", () => {
    const a = makeEvent({ requestId: "", messageId: "msg_x", outputTokens: 1 });
    const b = makeEvent({ requestId: "", messageId: "msg_x", outputTokens: 2 });
    const out = decodeEventBatch(Buffer.from(ndjson([toWire(a), toWire(b)])));
    // 内容不同 → semantic_id 不同 → 两条都保留
    expect(out.events).toHaveLength(2);
  });

  it("skips bad lines instead of rejecting the whole batch", () => {
    const body = Buffer.from(
      "{not json}\n" +
        ndjson([toWire(makeEvent())]) +
        JSON.stringify({ message_id: "", machine_id: "m", profile_id: "p", ts: "x" }) +
        "\n" +
        JSON.stringify({ ...toWire(makeEvent()), ts: "not-a-date" }) +
        "\n",
    );
    const out = decodeEventBatch(body);
    expect(out.events).toHaveLength(1);
    expect(out.invalid).toBe(3);
  });

  it("keeps window_kind a free-form string (no enum)", () => {
    const parsed = quotaSnapshotWireSchema.parse({
      profile_id: "claude-official",
      captured_at: "2026-09-21T02:30:00Z",
      windows: [
        { window_kind: "five_hour", utilization_pct: 62, resets_at: "2026-09-21T10:30:00Z" },
        // 官方字段名尚未实测确认，任何字符串都必须能收
        { window_kind: "seven_day_fable_whatever", utilization_pct: 73, resets_at: null },
      ],
      raw: { anything: true },
    });
    const snap = quotaWireToSnapshot(parsed)!;
    expect(snap.windows.map((w) => w.windowKind)).toEqual([
      "five_hour",
      "seven_day_fable_whatever",
    ]);
    expect(snap.windows[1]!.resetsAt).toBeNull();
    expect(snap.raw).toEqual({ anything: true });
  });
});
