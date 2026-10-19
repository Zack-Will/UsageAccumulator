import { describe, expect, it } from "vitest";
import { createCodexParserState, parseCodexLine, type CodexParserState } from "../src/codex.js";

const T = "2026-10-01T00:00:00.000Z";
const line = (type: string, payload: unknown, timestamp = T) => JSON.stringify({ type, payload, timestamp });
const meta = (extra: Record<string, unknown> = {}) => line("session_meta", {
  id: "session-1", timestamp: T, cwd: "/project", model_provider: "openai", ...extra,
});
const turn = (id = "turn-1", model = "gpt-test", extra: Record<string, unknown> = {}) =>
  line("turn_context", { turn_id: id, model, effort: "high", ...extra });
const usage = (input: number, output: number, cached = 0, write = 0, reasoning = 0) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
  output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
});
const count = (total: unknown, last: unknown = total, timestamp = T) =>
  line("event_msg", { type: "token_count", info: { total_token_usage: total, last_token_usage: last } }, timestamp);
function ready(): CodexParserState {
  return parseCodexLine(turn(), parseCodexLine(meta(), createCodexParserState()).state).state;
}

describe("Codex rollout metadata parser", () => {
  it("keeps input/cache and output/reasoning inclusive; retains writes separately", () => {
    const result = parseCodexLine(count(usage(100, 30, 40, 10, 20)), ready());
    expect(result.event).toMatchObject({
      session_id: "session-1", turn_id: "turn-1", model: "gpt-test", model_provider: "openai",
      reasoning_effort: "high", project: "/project", input_tokens: 100, cached_input_tokens: 40,
      cache_write_input_tokens: 10, output_tokens: 30, reasoning_output_tokens: 20, total_tokens: 130,
      quality_flags: [],
    });
    expect(result.warnings).toEqual([]);
  });

  it("suppresses repeated cumulative observations even when timestamp or turn changes", () => {
    const first = parseCodexLine(count(usage(100, 20)), ready());
    const afterTurn = parseCodexLine(turn("turn-2"), first.state).state;
    const duplicate = parseCodexLine(count(usage(100, 20), usage(100, 20), "2026-10-01T00:01:00Z"), afterTurn);
    expect(duplicate.event).toBeNull();
    const next = parseCodexLine(count(usage(250, 50), usage(150, 30)), duplicate.state);
    expect(next.event).toMatchObject({ turn_id: "turn-2", input_tokens: 150, output_tokens: 30, total_tokens: 180 });
  });

  it("uses the current last request, not a multi-request delta, when observations are missing", () => {
    const a = parseCodexLine(count(usage(100, 20)), ready());
    const b = parseCodexLine(count(usage(300, 60), usage(50, 10)), a.state);
    expect(b.event).toMatchObject({ input_tokens: 50, output_tokens: 10 });
    expect(b.event?.quality_flags).toContain("last_usage_mismatch");
    expect(b.event?.quality_flags).toContain("cumulative_gap");
  });

  it("does not assign an unseen cumulative history to the first observed request", () => {
    const first = parseCodexLine(count(usage(10_000, 500), usage(100, 20)), ready());
    expect(first.event).toMatchObject({ input_tokens: 100, output_tokens: 20 });
    expect(first.event?.quality_flags).toContain("initial_cumulative_history_unattributed");
    const next = parseCodexLine(count(usage(10_200, 530), usage(200, 30)), first.state);
    expect(next.event?.quality_flags).toEqual([]);
    expect(next.event?.input_tokens).toBe(200);
  });

  it("establishes a baseline when the first snapshot lacks last usage", () => {
    const first = parseCodexLine(count(usage(100, 20), null), ready());
    expect(first.event).toBeNull();
    expect(first.warnings).toContain("initial_cumulative_baseline_only");
    const next = parseCodexLine(count(usage(250, 50), null), first.state);
    expect(next.event).toBeNull();
    expect(next.warnings).toContain("last_usage_unavailable");
    const recovered = parseCodexLine(count(usage(350, 70), usage(100, 20)), next.state);
    expect(recovered.event).toMatchObject({ input_tokens: 100, output_tokens: 20 });
    expect(recovered.event?.quality_flags).toContain("cumulative_gap");
    expect(recovered.event?.quality_flags).toContain("initial_cumulative_baseline_only");
  });

  it("does not bill a counter decrease or a replay; recovery reports incomplete history", () => {
    const a = parseCodexLine(count(usage(100, 20)), ready());
    const b = parseCodexLine(count(usage(30, 4)), a.state);
    expect(b.event).toBeNull();
    expect(b.warnings).toContain("counter_decreased");
    expect(b.state.cumulative).toEqual(a.state.cumulative);
    const repeated = parseCodexLine(count(usage(100, 20)), b.state);
    expect(repeated.event).toBeNull();
    const c = parseCodexLine(count(usage(120, 30), usage(90, 26)), repeated.state);
    expect(c.event).toMatchObject({ input_tokens: 90, output_tokens: 26 });
    expect(c.event?.quality_flags).toContain("counter_decreased");
  });

  it("survives JSON serialization/restart with identical deltas and stable event ids", () => {
    const first = parseCodexLine(count(usage(100, 20, 30)), ready());
    const before = JSON.stringify(first.state);
    const serialized = JSON.parse(before) as CodexParserState;
    const nextLine = count(usage(300, 60, 100), usage(200, 40, 70));
    expect(parseCodexLine(nextLine, serialized)).toEqual(parseCodexLine(nextLine, first.state));
    expect(JSON.stringify(first.state)).toBe(before);
  });

  it("gives copied logs the same ids without using the machine or project path", () => {
    const a = parseCodexLine(count(usage(100, 20)), ready()).event!;
    const relocated = { ...ready(), project: "/other-machine/project" };
    const b = parseCodexLine(count(usage(100, 20)), relocated).event!;
    expect(a.event_id).toBe(b.event_id);
    expect(a.event_id).not.toContain("project");
  });

  it("merges a gapped observer with a complete observer without double-counting the missing request", () => {
    const parse = (steps: number[]) => {
      let state = ready();
      return steps.map((n) => {
        const r = parseCodexLine(count(usage(n, n / 10), usage(100, 10)), state);
        state = r.state;
        return r.event!;
      });
    };
    const complete = parse([100, 200, 300]);
    const gapped = parse([100, 300]);
    expect(gapped[1]?.event_id).toBe(complete[2]?.event_id);
    expect(gapped[1]?.input_tokens).toBe(complete[2]?.input_tokens);
    expect(gapped[1]?.quality_flags).toContain("cumulative_gap");
    for (const sequence of [[...gapped, ...complete], [...complete, ...gapped]]) {
      const ledger = new Map<string, NonNullable<ReturnType<typeof parseCodexLine>["event"]>>();
      for (const event of sequence) if (!ledger.has(event.event_id)) ledger.set(event.event_id, event);
      expect([...ledger.values()].reduce((sum, event) => sum + event.input_tokens, 0)).toBe(300);
      expect([...ledger.values()].reduce((sum, event) => sum + event.output_tokens, 0)).toBe(30);
    }
  });

  it("does not put revisable cached/cache-write/reasoning detail or reported total into event identity", () => {
    const first = parseCodexLine(count(usage(100, 20, 0, 0, 0)), ready()).event!;
    const revised = parseCodexLine(count(usage(100, 20, 30, 10, 10)), ready()).event!;
    const old = parseCodexLine(count({ input_tokens: 100, output_tokens: 20 }), ready()).event!;
    expect(revised.event_id).toBe(first.event_id);
    expect(old.event_id).toBe(first.event_id);
  });

  it("inherits the current turn model and resets optional turn settings on model switch", () => {
    const first = parseCodexLine(count(usage(100, 20)), ready());
    const switched = parseCodexLine(turn("turn-2", "gpt-next", { effort: null, service_tier: "priority" }), first.state);
    const next = parseCodexLine(count(usage(250, 50), usage(150, 30)), switched.state);
    expect(next.event).toMatchObject({ model: "gpt-next", reasoning_effort: null, service_tier: "priority", input_tokens: 150 });
  });

  it("locks a fork to the first session header and skips restamped inherited metadata/usage", () => {
    let state = parseCodexLine(meta({ id: "child", forked_from_id: "parent", parent_thread_id: "parent", subagent_history_start_ordinal: 4 }), createCodexParserState()).state;
    state = parseCodexLine(meta({ id: "parent", cwd: "/parent" }), state).state;
    state = parseCodexLine(turn("parent-turn", "parent-model"), state).state;
    const inherited = parseCodexLine(count(usage(10_000, 500)), state);
    expect(inherited.event).toBeNull();
    expect(inherited.state.cumulative).toBeNull();
    state = parseCodexLine(turn("child-turn", "child-model"), inherited.state).state;
    const own = parseCodexLine(count(usage(100, 20)), state);
    expect(own.event).toMatchObject({ session_id: "child", parent_session_id: "parent", turn_id: "child-turn", model: "child-model", input_tokens: 100, project: "/project" });
  });

  it("withholds forks with unknown copied-history boundary until an explicit fresh section", () => {
    let state = parseCodexLine(meta({ id: "child", forked_from_id: "parent" }), createCodexParserState()).state;
    state = parseCodexLine(meta({ id: "parent" }), state).state;
    state = parseCodexLine(turn("parent-turn"), state).state;
    const inherited = parseCodexLine(count(usage(1000, 200)), state);
    expect(inherited.event).toBeNull();
    expect(inherited.warnings).toContain("fork_history_usage_withheld");
    state = parseCodexLine(line("event_msg", { type: "thread_settings_applied" }), inherited.state).state;
    expect(parseCodexLine(count(usage(100, 20)), state).event).toBeNull();
    state = parseCodexLine(turn("child-turn"), state).state;
    const own = parseCodexLine(count(usage(100, 20)), state);
    expect(own.event?.session_id).toBe("child");
    expect(own.event?.quality_flags).toContain("fork_boundary_inferred");
  });

  it("counts ordinary parent-linked subagents independently", () => {
    let state = parseCodexLine(meta({ id: "reviewer", parent_thread_id: "parent", source: { subagent: { other: "review" } } }), createCodexParserState()).state;
    state = parseCodexLine(turn("review-turn", "codex-auto-review"), state).state;
    const child = parseCodexLine(count(usage(100, 20)), state).event!;
    expect(child).toMatchObject({ session_id: "reviewer", parent_session_id: "parent", model: "codex-auto-review" });
    expect(child.event_id).not.toBe(parseCodexLine(count(usage(100, 20)), ready()).event?.event_id);
  });

  it("ignores later foreign session headers rather than overwriting file identity", () => {
    const changed = parseCodexLine(meta({ id: "foreign", model_provider: "foreign", cwd: "/foreign" }), ready());
    expect(changed.state.session_id).toBe("session-1");
    expect(changed.state.project).toBe("/project");
    expect(changed.warnings).toContain("inherited_session_meta_ignored");
  });

  it("accepts older counters without cache-write/reasoning and marks missing detail", () => {
    const old = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30 };
    const result = parseCodexLine(count(old), ready());
    expect(result.event).toMatchObject({ cache_write_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 120 });
    expect(result.event?.quality_flags).toEqual(expect.arrayContaining(["cache_write_input_tokens_unreported", "reasoning_output_tokens_unreported", "total_tokens_derived"]));
  });

  it("supports legacy last-only usage with exact replay dedup and explicit uncertainty", () => {
    const first = parseCodexLine(count(null, usage(100, 20)), ready());
    expect(first.event?.quality_flags).toContain("last_usage_only");
    expect(parseCodexLine(count(null, usage(100, 20)), first.state).event).toBeNull();
    expect(parseCodexLine(count(null, usage(100, 20), "2026-10-01T00:01:00Z"), first.state).event).not.toBeNull();
  });

  it("does not rebill the ambiguous first cumulative observation after legacy last-only records", () => {
    const first = parseCodexLine(count(null, usage(100, 20)), ready());
    const repeated = parseCodexLine(count(usage(100, 20)), first.state);
    expect(repeated.event).toBeNull();
    expect(repeated.warnings).toContain("cumulative_rebaseline_after_last_only");
    const next = parseCodexLine(count(usage(250, 50), usage(150, 30)), repeated.state);
    expect(next.event).toMatchObject({ input_tokens: 150, output_tokens: 30 });
    expect(next.event?.quality_flags).toContain("cumulative_rebaseline_after_last_only");
  });

  it("uses last detail when a formerly unreported counter appears, rather than billing its history", () => {
    const old = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30, total_tokens: 120 };
    const first = parseCodexLine(count(old), ready());
    const next = parseCodexLine(count(usage(250, 50, 80, 70, 35), usage(150, 30, 50, 10, 20)), first.state);
    expect(next.event).toMatchObject({ input_tokens: 150, output_tokens: 30, cache_write_input_tokens: 10, reasoning_output_tokens: 20 });
    expect(next.event?.quality_flags).toContain("counter_detail_baseline_changed");
  });

  it("does not confuse disappearance of optional detail with a cumulative reset", () => {
    const first = parseCodexLine(count(usage(100, 20, 30, 10, 10)), ready());
    const old = { input_tokens: 250, output_tokens: 50, cached_input_tokens: 80, total_tokens: 300 };
    const next = parseCodexLine(count(old, { input_tokens: 150, output_tokens: 30, cached_input_tokens: 50 }), first.state);
    expect(next.event).toMatchObject({ input_tokens: 150, output_tokens: 30, cache_write_input_tokens: 0 });
    expect(next.warnings).not.toContain("counter_decreased");
  });

  it("does not turn revised cached/reasoning detail into additive token usage", () => {
    const first = parseCodexLine(count(usage(100, 20, 0, 0, 0)), ready());
    const revised = parseCodexLine(count(usage(100, 20, 30, 0, 10)), first.state);
    expect(revised.event).toBeNull();
    expect(revised.warnings).toContain("counter_detail_revision_ignored");
    const next = parseCodexLine(count(usage(250, 50, 80, 0, 20), usage(150, 30, 50, 0, 10)), revised.state);
    expect(next.event).toMatchObject({ input_tokens: 150, cached_input_tokens: 50, reasoning_output_tokens: 10 });
  });

  it("does not bill last usage greater than its initial cumulative observation", () => {
    const result = parseCodexLine(count(usage(100, 20), usage(200, 50)), ready());
    expect(result.event).toBeNull();
    expect(result.warnings).toContain("last_exceeds_cumulative");
  });

  it("marks inconsistent subset and total fields without silently inventing replacements", () => {
    const malformed = { ...usage(10, 5, 9, 3, 7), total_tokens: 99 };
    const result = parseCodexLine(count(malformed), ready());
    expect(result.event).toMatchObject({ input_tokens: 10, cached_input_tokens: 9, cache_write_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 7, total_tokens: 99 });
    expect(result.event?.quality_flags).toEqual(expect.arrayContaining(["input_subsets_exceed_total", "reasoning_exceeds_output", "total_tokens_mismatch"]));
  });

  it.each([null, [], true, 42, "secret-transcript", "{invalid"])("bad records do not throw or poison subsequent lines: %j", (bad) => {
    const initial = ready();
    const result = parseCodexLine(typeof bad === "string" && bad.startsWith("{") ? bad : JSON.stringify(bad), initial);
    expect(result.event).toBeNull();
    expect(result.warnings.join(" ")).not.toContain("secret-transcript");
    expect(parseCodexLine(count(usage(100, 20)), result.state).event?.total_tokens).toBe(120);
  });

  it.each([-1, 0.5, "100", Number.MAX_SAFE_INTEGER + 1])("rejects invalid counters: %j", (value) => {
    const bad = { ...usage(100, 20), input_tokens: value };
    const result = parseCodexLine(count(bad), ready());
    expect(result.event).toBeNull();
    expect(result.warnings).toContain("invalid_counter");
  });

  it("does not mutate baseline for invalid timestamps or rate-limit-only observations", () => {
    const state = ready();
    const invalid = parseCodexLine(count(usage(100, 20), usage(100, 20), "not a date"), state);
    expect(invalid.state.cumulative).toBeNull();
    expect(invalid.warnings).toContain("invalid_timestamp");
    const quotaOnly = parseCodexLine(line("event_msg", { type: "token_count", info: null, rate_limits: { anything: 50 } }), invalid.state);
    expect(quotaOnly.event).toBeNull();
    expect(quotaOnly.warnings).toEqual([]);
  });

  it("retains no bodies, instructions, credentials, source metadata, or arbitrary payloads", () => {
    const secret = "DO_NOT_RETAIN_THIS_TRANSCRIPT";
    let state = parseCodexLine(meta({ base_instructions: secret, auth: secret, source: { subagent: { other: secret } } }), createCodexParserState()).state;
    state = parseCodexLine(turn("turn-1", "gpt-test", { summary: secret, arbitrary: secret }), state).state;
    state = parseCodexLine(line("response_item", { type: "message", content: secret }), state).state;
    const result = parseCodexLine(count({ ...usage(100, 20), unknown: secret }), state);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not emit usage without session metadata, and marks absent model context", () => {
    expect(parseCodexLine(count(usage(100, 20)), createCodexParserState()).warnings).toContain("usage_without_session");
    const state = parseCodexLine(meta(), createCodexParserState()).state;
    expect(parseCodexLine(count(usage(100, 20)), state).event?.quality_flags).toContain("model_unknown");
  });

  describe("per-request usage records", () => {
    const record = (response: string, u: ReturnType<typeof usage>, extra: Record<string, unknown> = {}) =>
      line("token_usage_record", { thread_id: "session-1", session_id: "root", turn_id: "turn-1", response_id: response, usage: u, ...extra });
    const feed = (lines: string[], state = ready()) => {
      const out: ReturnType<typeof parseCodexLine>[] = [];
      for (const l of lines) { const r = parseCodexLine(l, state); state = r.state; out.push(r); }
      return { out, events: out.flatMap((r) => r.event ? [r.event] : []), state };
    };

    it("keeps the token_count identity for a matched request", () => {
      const plain = feed([count(usage(100, 10))]).events;
      const withRecord = feed([record("r1", usage(100, 10)), count(usage(100, 10))]).events;
      expect(withRecord).toEqual(plain);
    });

    it("emits a compaction request that no token_count reports, without breaking the next request", () => {
      const { events } = feed([
        record("r1", usage(100, 10)), count(usage(100, 10)),
        record("compact", usage(5000, 300)), line("compacted", { message: "" }), count(usage(100, 10)),
        record("r2", usage(200, 20)), count(usage(300, 30), usage(200, 20)),
      ]);
      expect(events.map((e) => e.input_tokens)).toEqual([100, 5000, 200]);
      expect(events[1]!.quality_flags).toEqual(["compaction_usage_from_record"]);
      expect(events[2]!.quality_flags).toEqual([]);
      expect(new Set(events.map((e) => e.event_id)).size).toBe(3);
    });

    it("releases an unclaimed record when a repeated snapshot or the next record arrives", () => {
      const dup = feed([record("r1", usage(100, 10)), count(usage(100, 10)), record("lost", usage(50, 5)), count(usage(100, 10))]);
      expect(dup.events.map((e) => e.input_tokens)).toEqual([100, 50]);
      const next = feed([record("lost", usage(50, 5)), record("r1", usage(100, 10)), count(usage(100, 10))]);
      expect(next.events.map((e) => e.input_tokens)).toEqual([50, 100]);
      expect(next.events[0]!.quality_flags).toContain("usage_record_without_token_count");
    });

    it("never bills both a record and a disagreeing token_count; marks the gap as withheld", () => {
      const { events, out } = feed([record("r1", usage(999, 9)), count(usage(100, 10))]);
      expect(events.map((e) => e.input_tokens)).toEqual([100]);
      expect(events[0]!.quality_flags).toEqual(expect.arrayContaining(["usage_record_unmatched", "cumulative_gap"]));
      expect(out[1]!.withheld).toEqual(["usage_record_unmatched"]);
    });

    it("ignores a record for another thread", () => {
      const { events, out } = feed([record("x", usage(100, 10), { thread_id: "other" })]);
      expect(events).toEqual([]);
      expect(out[0]!.withheld).toEqual([]);
    });
  });

  it("counts only dropped or withheld records as withheld, not notes about emitted events", () => {
    const noTurn = parseCodexLine(line("turn_context", { model: "gpt-test" }), parseCodexLine(meta(), createCodexParserState()).state).state;
    const emitted = parseCodexLine(count({ input_tokens: 100, output_tokens: 10 }), noTurn);
    expect(emitted.event).not.toBeNull();
    expect(emitted.warnings).toEqual(expect.arrayContaining(["turn_id_unavailable", "total_tokens_derived"]));
    expect(emitted.withheld).toEqual([]);
    const first = parseCodexLine(count(usage(100, 10)), ready());
    expect(parseCodexLine(count(usage(100, 10)), first.state).withheld).toEqual([]); // a suppressed repeat loses nothing
    expect(parseCodexLine("{not json", ready()).withheld).toEqual(["invalid_json"]);
  });

  it("keeps a gap flag pending across an all-zero observation instead of dropping it", () => {
    const a = parseCodexLine(count(usage(100, 10)), ready());
    const zero = parseCodexLine(count(usage(5000, 300), usage(0, 0)), a.state);
    expect(zero.event).toBeNull();
    const next = parseCodexLine(count(usage(5100, 310), usage(100, 10)), zero.state);
    expect(next.event?.quality_flags).toContain("cumulative_gap");
  });
});

