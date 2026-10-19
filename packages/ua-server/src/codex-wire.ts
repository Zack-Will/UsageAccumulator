import { z } from "zod";
import type { CodexIngestBatch } from "@ua/core";

const text = z.string().min(1).max(256);
const nullableText = z.string().max(256).nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const codexTimestamp = z.string().datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const flag = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:-]+$/);

/** Strict allowlists: neither prompt bodies nor OAuth material can enter this ledger. */
export const codexIngestSchema = z.object({
  schema_version: z.literal(1),
  account: z.object({ account_id: text, email: z.string().trim().email().max(320).transform((s) => s.toLowerCase()), plan_type: nullableText }).strict(),
  events: z.array(z.object({
    event_id: text, session_id: text, turn_id: nullableText, parent_session_id: nullableText,
    ts: codexTimestamp, model: z.string().max(256), model_provider: nullableText,
    reasoning_effort: nullableText, service_tier: nullableText, project: z.string().max(2048).nullable(),
    input_tokens: count, cached_input_tokens: count, cache_write_input_tokens: count,
    output_tokens: count, reasoning_output_tokens: count, total_tokens: count,
    quality_flags: z.array(flag).max(100),
  }).strict()).max(5000),
  quota: z.object({
    captured_at: codexTimestamp,
    windows: z.array(z.object({
      window_id: text, limit_id: text, slot: z.enum(["primary", "secondary"]), label: nullableText,
      used_percent: z.number().min(0).max(100), duration_minutes: z.number().int().positive().max(5256000).nullable(),
      resets_at: codexTimestamp.nullable(),
    }).strict()).max(200),
    limits: z.array(z.object({
      limit_id: text, plan_type: nullableText,
      credits: z.object({ has_credits: z.boolean(), unlimited: z.boolean(), balance: z.string().max(100).nullable() }).strict().nullable(),
      limit_reached: nullableText,
    }).strict()).max(100),
  }).strict().optional(),
  account_usage: z.object({
    captured_at: codexTimestamp,
    daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tokens: count }).strict()).max(10000).nullable(),
    lifetime_tokens: count.nullable(),
    threads: z.array(z.object({ session_id: text, estimated_credits_micros: count, estimated_usd_micros: count.nullable() }).strict()).max(50000),
  }).strict().optional(),
  collector: z.object({
    captured_at: codexTimestamp, state: z.enum(["ok", "auth", "error"]), error_code: flag.nullable(),
    backfill_from: codexTimestamp, scanned_files: count, parse_warnings: count,
    warning_scope: z.literal("withheld_records").optional(),
    account_binding: z.literal("verified_login_configured_history"),
  }).strict(),
}).strict();

// Compile-time check of the shared probe/server boundary.
const checkContract: z.infer<typeof codexIngestSchema> extends CodexIngestBatch ? true : never = true;
void checkContract;
