import type { CodexEventRow } from "./codex-store.js";

export type CodexUsageBy = "day" | "model" | "machine" | "project" | "session";

/** These affect provenance/labels, not the observed input/output total. Unknown flags fail closed. */
const COVERAGE_NEUTRAL_FLAGS = new Set([
  "configured_account_history", "total_tokens_derived", "model_unknown", "turn_id_unavailable",
  "reasoning_output_tokens_unreported",
  // A request reported only by its per-request usage record (context compaction): complete usage.
  "compaction_usage_from_record", "usage_record_without_token_count",
]);

function totals(rows: CodexEventRow[]) {
  let cost = 0;
  let priced = 0;
  let pricedTokens = 0;
  let incomplete = 0;
  let conflictingEvents = 0;
  let conflictingObservations = 0;
  const tokens = { input: 0, cached_input: 0, cache_write_input: 0, output: 0, reasoning_output: 0, total: 0 };
  const missing: Record<string, number> = {};
  const quality: Record<string, number> = {};
  const versions = new Set<string>();
  for (const { event: e, cost: c, conflicting_observations: conflicts } of rows) {
    if (conflicts > 0) { conflictingEvents++; conflictingObservations += conflicts; }
    if (conflicts > 0 || e.quality_flags.some((f) => !COVERAGE_NEUTRAL_FLAGS.has(f))) incomplete++;
    tokens.input += e.input_tokens;
    tokens.cached_input += e.cached_input_tokens;
    tokens.cache_write_input += e.cache_write_input_tokens;
    tokens.output += e.output_tokens;
    tokens.reasoning_output += e.reasoning_output_tokens;
    tokens.total += e.total_tokens;
    versions.add(c.price_version);
    if (c.usd !== null) { cost += c.usd; priced++; pricedTokens += e.total_tokens; }
    else { const reason = c.missing_reason ?? "unknown"; missing[reason] = (missing[reason] ?? 0) + 1; }
    for (const flag of new Set(e.quality_flags)) quality[flag] = (quality[flag] ?? 0) + 1;
  }
  return {
    events: rows.length, tokens,
    cost_usd: priced > 0 ? Number(cost.toFixed(12)) : null,
    cost_basis: "api_equivalent_current_rates" as const,
    pricing_complete: rows.length > 0 && priced === rows.length,
    usage_complete: rows.length > 0 && incomplete === 0,
    usage_coverage_status: rows.length === 0 ? "no_data" : incomplete > 0 ? "incomplete" : "no_known_gaps",
    incomplete_events: incomplete, conflicting_events: conflictingEvents, conflicting_observations: conflictingObservations,
    cost_complete: rows.length > 0 && priced === rows.length && incomplete === 0,
    priced_events: priced, unpriced_events: rows.length - priced,
    cost_coverage_pct: rows.length > 0 ? priced / rows.length * 100 : null,
    priced_token_coverage_pct: tokens.total > 0 ? pricedTokens / tokens.total * 100 : null,
    price_versions: [...versions].sort(), missing_reasons: missing, quality_flags: quality,
  };
}

export function aggregateCodexUsage(rows: CodexEventRow[], by: CodexUsageBy, timezone: string) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const groups = new Map<string, CodexEventRow[]>();
  for (const row of rows) {
    const e = row.event;
    let key: string;
    switch (by) {
      case "day": {
        const parts = Object.fromEntries(day.formatToParts(new Date(e.ts)).map((p) => [p.type, p.value]));
        key = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
        break;
      }
      case "model": key = e.model || "(unknown)"; break;
      case "machine": key = row.machine_id; break;
      case "project": key = e.project || "(unknown)"; break;
      case "session": key = e.session_id; break;
    }
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return { totals: totals(rows), buckets: [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, events]) => ({ key, ...totals(events) })) };
}
