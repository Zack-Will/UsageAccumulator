import { createHash } from "node:crypto";
import type { CodexUsageEvent } from "./codex-types.js";

/** Input includes cached/cache-write tokens; output includes reasoning tokens. */
interface Counters {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

/**
 * A per-request usage record waiting for its token_count. Context compaction is billed
 * by a request that only ever appears here: no token_count reports it, and the next
 * cumulative snapshot repeats the previous total.
 */
interface PendingUsageRecord {
  response_id: string;
  turn_id: string | null;
  ts: string;
  model: string;
  model_provider: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  project: string | null;
  usage: Counters;
  flags: string[];
}

/** Only allowlisted metadata is retained. Persist this together with the file cursor. */
export interface CodexParserState {
  version: 1;
  line_ordinal: number;
  session_id: string | null;
  parent_session_id: string | null;
  created_at: string | null;
  turn_id: string | null;
  model: string;
  model_provider: string | null;
  reasoning_effort: string | null;
  service_tier: string | null;
  project: string | null;
  history_through_ordinal: number;
  fork_boundary_unknown: boolean;
  awaiting_own_context: boolean;
  cumulative: Counters | null;
  cumulative_unreported: string[];
  pending_flags: string[];
  last_only_ids: string[];
  /** Absent in checkpoints written before usage records were tracked. */
  pending_record?: PendingUsageRecord | null;
}

/**
 * Bump when collectors should rescan and re-derive events: the scan identity includes it.
 * Rescans are safe only because an already-derived event keeps its id across revisions.
 * 2: requests reported only by token_usage_record (context compaction) are emitted.
 */
export const CODEX_PARSER_REVISION = 2;

export function createCodexParserState(): CodexParserState {
  return {
    version: 1, line_ordinal: 0, session_id: null, parent_session_id: null,
    created_at: null, turn_id: null, model: "", model_provider: null,
    reasoning_effort: null, service_tier: null, project: null,
    history_through_ordinal: 0, fork_boundary_unknown: false,
    awaiting_own_context: false, cumulative: null, cumulative_unreported: [], pending_flags: [], last_only_ids: [],
    pending_record: null,
  };
}

export interface CodexParseResult {
  state: CodexParserState;
  event: CodexUsageEvent | null;
  /** Stable codes only: never interpolate transcript text or raw field values. */
  warnings: string[];
  /**
   * The subset of warnings meaning a record that may carry usage was dropped or withheld.
   * Only these qualify coverage; the rest are diagnostics about events that were emitted.
   */
  withheld: string[];
}

const KEYS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;
const object = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : null;
const str = (x: unknown): string | null => typeof x === "string" && x.length > 0 ? x : null;
const iso = (x: unknown): string | null => {
  if (typeof x !== "string") return null;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const unique = (xs: string[]): string[] => [...new Set(xs)];
/** Flags describing one emitted event's own fields, not the coverage around it. */
const EVENT_DESCRIPTORS = new Set(["model_unknown", "turn_id_unavailable", "total_tokens_derived", "total_tokens_mismatch",
  "input_subsets_exceed_total", "reasoning_exceeds_output", "last_usage_only", "counter_detail_baseline_changed",
  "missing_required_counter", "invalid_counter", "counter_overflow"]);
const hash = (parts: unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const equal = (a: Counters, b: Counters): boolean => KEYS.every((k) => a[k] === b[k]);

function counters(raw: unknown, flags: string[]): Counters | null {
  const x = object(raw);
  if (!x) return null;
  const out = {} as Counters;
  for (const k of KEYS) {
    const v = x[k];
    if (v === undefined || v === null) {
      if (k === "input_tokens" || k === "output_tokens") {
        flags.push("missing_required_counter");
        return null;
      }
      out[k] = 0;
      if (k !== "total_tokens") flags.push(`${k}_unreported`);
    } else if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      flags.push("invalid_counter");
      return null;
    } else out[k] = v;
  }
  const sum = out.input_tokens + out.output_tokens;
  if (!Number.isSafeInteger(sum)) { flags.push("counter_overflow"); return null; }
  if (x["total_tokens"] == null) { out.total_tokens = sum; flags.push("total_tokens_derived"); }
  else if (out.total_tokens !== sum) flags.push("total_tokens_mismatch");
  if (out.cached_input_tokens + out.cache_write_input_tokens > out.input_tokens) flags.push("input_subsets_exceed_total");
  if (out.reasoning_output_tokens > out.output_tokens) flags.push("reasoning_exceeds_output");
  return out;
}

/**
 * Stateful Codex rollout parser. Feed every physical line, including ignored lines,
 * and parse the prefix before applying a reporting date filter.
 *
 * The first session_meta owns the file: spawned rollouts may embed their parent's
 * session_meta and restamp copied history. subagent_history_start_ordinal marks
 * the observed inherited prefix (1-based physical lines, including the header).
 * A fork without that boundary is withheld until thread_settings_applied followed
 * by a fresh turn_context. This deliberately prefers an explicit incomplete result
 * to billing copied history. Parent-only subagents without a fork are independent.
 *
 * Additive events always use last_token_usage, checked against cumulative growth.
 * A delta can span missing requests: it must NEVER become one additive event,
 * otherwise another machine's more complete transcript would double-bill the gap.
 * Missing last usage only advances the baseline and records incomplete coverage.
 * Counter decreases are withheld and the previous high-water baseline is retained:
 * reset/reordered logs cannot be distinguished reliably from this metadata alone.
 * Subsequent recoverable growth carries counter_decreased. A first cumulative
 * snapshot without matching last usage emits only last usage (or establishes a
 * baseline without an event), avoiding attribution of unknown past usage to now.
 */
export function parseCodexLine(raw: string, previous: CodexParserState): CodexParseResult {
  const state: CodexParserState = { ...previous, line_ordinal: previous.line_ordinal + 1 };
  const warnings: string[] = [];
  const withheld: string[] = [];
  const hold = (...codes: string[]): void => { warnings.push(...codes); withheld.push(...codes); };
  const result = (event: CodexUsageEvent | null = null): CodexParseResult =>
    ({ state, event, warnings: unique(warnings), withheld: unique(withheld) });
  /** Emit the pending record as its own request: nothing else will ever report it. */
  const releaseRecord = (flag: string): CodexParseResult => {
    const rec = state.pending_record!;
    state.pending_record = null;
    const flags = unique([...rec.flags, flag]);
    return result({
      event_id: `codex:v1:${hash(["record", state.session_id, rec.response_id])}`,
      session_id: state.session_id!, turn_id: rec.turn_id, parent_session_id: state.parent_session_id,
      ts: rec.ts, model: rec.model, model_provider: rec.model_provider,
      reasoning_effort: rec.reasoning_effort, service_tier: rec.service_tier,
      project: rec.project, ...rec.usage, quality_flags: flags,
    });
  };
  if (!raw.trim()) return result();
  let doc: Record<string, unknown> | null;
  try { doc = object(JSON.parse(raw)); } catch { hold("invalid_json"); return result(); }
  if (!doc) { hold("invalid_record"); return result(); }
  if (doc["type"] === "compacted" && state.pending_record && state.line_ordinal > state.history_through_ordinal) {
    return releaseRecord("compaction_usage_from_record");
  }
  const payload = object(doc["payload"]);
  if (!payload) return result();

  if (doc["type"] === "session_meta" && !state.session_id) {
    const id = str(payload["id"]) ?? str(payload["session_id"]);
    if (!id) { hold("missing_session_id"); return result(); }
    state.session_id = id;
    state.parent_session_id = str(payload["parent_thread_id"]) ?? str(payload["forked_from_id"]);
    state.created_at = iso(payload["timestamp"]) ?? iso(doc["timestamp"]);
    state.model_provider = str(payload["model_provider"]);
    state.project = str(payload["cwd"]);
    const ordinal = payload["subagent_history_start_ordinal"];
    const boundary = typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal >= state.line_ordinal;
    state.history_through_ordinal = boundary ? ordinal : 0;
    state.fork_boundary_unknown = Boolean(str(payload["forked_from_id"])) && !boundary;
    state.awaiting_own_context = state.fork_boundary_unknown || boundary;
    if (state.fork_boundary_unknown) warnings.push("fork_history_boundary_unknown");
    return result();
  }
  if (state.line_ordinal <= state.history_through_ordinal) return result();
  if (doc["type"] === "session_meta") {
    const id = str(payload["id"]) ?? str(payload["session_id"]);
    if (id && id !== state.session_id) warnings.push("inherited_session_meta_ignored");
    return result();
  }
  if (state.fork_boundary_unknown) {
    if (doc["type"] === "event_msg" && payload["type"] === "thread_settings_applied") {
      state.fork_boundary_unknown = false;
      state.pending_flags = unique([...state.pending_flags, "fork_boundary_inferred"]);
    } else if ((doc["type"] === "event_msg" && payload["type"] === "token_count") || doc["type"] === "token_usage_record") {
      hold("fork_history_usage_withheld");
    }
    return result();
  }
  if (doc["type"] === "turn_context") {
    state.turn_id = str(payload["turn_id"]);
    state.model = str(payload["model"]) ?? "";
    state.reasoning_effort = str(payload["effort"]) ?? str(payload["reasoning_effort"]);
    state.service_tier = str(payload["service_tier"]);
    state.project = str(payload["cwd"]) ?? state.project;
    state.model_provider = str(payload["model_provider"]) ?? state.model_provider;
    state.awaiting_own_context = false;
    return result();
  }
  if (doc["type"] === "token_usage_record") {
    // One record per model request, written before the token_count that reports it.
    // Matched requests keep their token_count identity (stable across parser versions and
    // observers); only a record no token_count claims becomes an event of its own.
    if (!state.session_id) { hold("usage_without_session"); return result(); }
    if (state.awaiting_own_context) { hold("fork_usage_before_own_context"); return result(); }
    const threadId = str(payload["thread_id"]);
    if (threadId && threadId !== state.session_id) { warnings.push("usage_record_foreign_thread"); return result(); }
    const responseId = str(payload["response_id"]);
    const ts = iso(doc["timestamp"]);
    const recFlags: string[] = [];
    const recUsage = counters(payload["usage"], recFlags);
    if (!responseId || !ts || !recUsage) { warnings.push("usage_record_unusable"); return result(); }
    const turnId = str(payload["turn_id"]) ?? state.turn_id;
    const released = state.pending_record ? releaseRecord("usage_record_without_token_count") : null;
    const recordFlags = [...recFlags];
    if (!state.model) recordFlags.push("model_unknown");
    if (!turnId) recordFlags.push("turn_id_unavailable");
    state.pending_record = {
      response_id: responseId, turn_id: turnId, ts, model: state.model, model_provider: state.model_provider,
      reasoning_effort: state.reasoning_effort, service_tier: state.service_tier, project: state.project,
      usage: recUsage, flags: recordFlags,
    };
    return released ?? result();
  }
  if (doc["type"] !== "event_msg" || payload["type"] !== "token_count") return result();
  const info = object(payload["info"]);
  if (!info) return result(); // Rate-limit-only updates do not contain a usage observation.
  if (!state.session_id) { hold("usage_without_session"); return result(); }
  if (state.awaiting_own_context) { hold("fork_usage_before_own_context"); return result(); }
  const ts = iso(doc["timestamp"]);
  if (!ts) { hold("invalid_timestamp"); return result(); }
  const flags = [...state.pending_flags];
  const totalFlags: string[] = [];
  const lastFlags: string[] = [];
  const total = counters(info["total_token_usage"], totalFlags);
  const last = counters(info["last_token_usage"], lastFlags);
  warnings.push(...totalFlags, ...lastFlags);
  let usage: Counters;
  let identity: unknown[];

  const record = state.pending_record ?? null;
  if (record && !(last && equal(last, record.usage))) {
    // A snapshot repeating the previous total reports nothing new: the pending record
    // (a compaction request, in observed logs) is the only report of that usage.
    if (total && state.cumulative && equal(total, state.cumulative)) return releaseRecord("usage_record_without_token_count");
    state.pending_record = null;
    hold("usage_record_unmatched");
    flags.push("usage_record_unmatched", "cumulative_gap");
  } else state.pending_record = null;

  if (total) {
    if (state.cumulative && equal(total, state.cumulative)) return result();
    if (state.cumulative && ["input_tokens", "output_tokens", "total_tokens"].every((k) => total[k as keyof Counters] === state.cumulative![k as keyof Counters])) {
      // A cache/reasoning breakdown revision is not additional usage. Keep the
      // newest detail baseline, but do not invent a second billable observation.
      state.cumulative = total;
      state.cumulative_unreported = totalFlags.filter((f) => f.endsWith("_unreported"));
      state.pending_flags = unique([...flags, "counter_detail_revision_ignored"]);
      warnings.push("counter_detail_revision_ignored");
      return result();
    }
    const comparable = (k: string): boolean =>
      !totalFlags.includes(`${k}_unreported`) && !state.cumulative_unreported.includes(`${k}_unreported`);
    if (state.cumulative && KEYS.some((k) => comparable(k) && total[k] < state.cumulative![k])) {
      hold("counter_decreased");
      state.pending_flags = unique([...flags, "counter_decreased"]);
      return result();
    }
    // Cache/reasoning detail can be revised or absent in older clients. These
    // subsets cannot participate in the identity of a cumulative endpoint.
    identity = ["cumulative", state.session_id, state.turn_id, total.input_tokens, total.output_tokens];
    flags.push(...totalFlags);
    if (state.cumulative) {
      const baseline = state.cumulative;
      usage = Object.fromEntries(KEYS.map((k) => {
        if (comparable(k)) return [k, total[k] - baseline[k]];
        flags.push("counter_detail_baseline_changed");
        return [k, last && !lastFlags.includes(`${k}_unreported`) ? last[k] : 0];
      })) as unknown as Counters;
      if (!last) {
        state.cumulative = total;
        state.cumulative_unreported = totalFlags.filter((f) => f.endsWith("_unreported"));
        state.pending_flags = unique([...flags, "cumulative_gap", "last_usage_unavailable"]);
        hold("cumulative_gap", "last_usage_unavailable");
        return result();
      }
      if (KEYS.some((k) => !lastFlags.includes(`${k}_unreported`) && !totalFlags.includes(`${k}_unreported`) && last[k] > total[k])) {
        state.cumulative = total;
        state.cumulative_unreported = totalFlags.filter((f) => f.endsWith("_unreported"));
        state.pending_flags = unique([...flags, "cumulative_gap", "last_exceeds_cumulative"]);
        hold("cumulative_gap", "last_exceeds_cumulative");
        return result();
      }
      if (!equal(usage, last)) flags.push("last_usage_mismatch", "cumulative_gap");
      // Even a well-formed delta may contain several requests. The current last
      // request is the only additive quantity whose identity all observers share.
      usage = last;
      flags.push(...lastFlags);
    } else if (state.last_only_ids.length > 0) {
      // Legacy records cannot prove whether the first total repeats the last-only
      // request or includes new usage. Establish a baseline instead of billing twice.
      state.cumulative = total;
      state.cumulative_unreported = totalFlags.filter((f) => f.endsWith("_unreported"));
      state.pending_flags = unique([...flags, "cumulative_gap", "cumulative_rebaseline_after_last_only"]);
      hold("cumulative_rebaseline_after_last_only");
      return result();
    } else if (last) {
      if (KEYS.some((k) => !lastFlags.includes(`${k}_unreported`) && !totalFlags.includes(`${k}_unreported`) && last[k] > total[k])) {
        state.cumulative = total;
        state.cumulative_unreported = totalFlags.filter((f) => f.endsWith("_unreported"));
        state.pending_flags = unique([...flags, "cumulative_gap", "last_exceeds_cumulative"]);
        hold("last_exceeds_cumulative");
        return result();
      }
      usage = last;
      flags.push(...lastFlags);
      if (!equal(total, last)) flags.push("initial_cumulative_history_unattributed", "cumulative_gap");
    } else {
      state.cumulative = total;
      state.cumulative_unreported = totalFlags.filter((f) => f.endsWith("_unreported"));
      state.pending_flags = unique([...flags, "cumulative_gap", "initial_cumulative_baseline_only"]);
      hold("initial_cumulative_baseline_only");
      return result();
    }
    state.cumulative = total;
    state.cumulative_unreported = totalFlags.filter((f) => f.endsWith("_unreported"));
  } else {
    if (!last) { hold("usage_counters_unavailable"); return result(); }
    flags.push(...lastFlags, "last_usage_only", ...totalFlags);
    usage = last;
    identity = ["last", state.session_id, state.turn_id, ts, last.input_tokens, last.output_tokens];
    const id = hash(identity);
    if (state.last_only_ids.includes(id)) return result();
    state.last_only_ids = [...state.last_only_ids, id];
    // A later cumulative snapshot includes these events; rebaseline before using it.
    state.cumulative = null;
  }
  // Coverage qualifiers outlive an all-zero observation; per-event descriptors do not.
  const carry = unique(flags.filter((f) => !EVENT_DESCRIPTORS.has(f) && !f.endsWith("_unreported")));
  if (!state.model) flags.push("model_unknown");
  if (!state.turn_id) flags.push("turn_id_unavailable");
  if (usage.cached_input_tokens + usage.cache_write_input_tokens > usage.input_tokens) flags.push("input_subsets_exceed_total");
  if (usage.reasoning_output_tokens > usage.output_tokens) flags.push("reasoning_exceeds_output");
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) flags.push("total_tokens_mismatch");
  warnings.push(...flags);
  if (KEYS.every((k) => usage[k] === 0)) {
    state.pending_flags = carry;
    return result();
  }
  state.pending_flags = [];
  return result({
    event_id: `codex:v1:${hash(identity)}`,
    session_id: state.session_id, turn_id: state.turn_id, parent_session_id: state.parent_session_id,
    ts, model: state.model, model_provider: state.model_provider,
    reasoning_effort: state.reasoning_effort, service_tier: state.service_tier,
    project: state.project, ...usage, quality_flags: unique(flags),
  });
}
