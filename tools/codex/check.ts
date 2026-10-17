/** Read-only preflight. Prints capabilities and an account fingerprint, never login material. */
import { createHash } from "node:crypto";
import { CodexClient } from "../../packages/ua-probe/src/codex-client.js";
const [binaryPath, expectedEmail] = process.argv.slice(2);
if (!binaryPath || !expectedEmail) throw new Error("usage: check <codex-binary> <expected-email>");
const client = new CodexClient({ binaryPath, timeoutMs: 30_000 });
try {
  await client.start();
  const { account, quota } = await client.readAccount(expectedEmail);
  let usage: Record<string, unknown>;
  try {
    const snapshot = await client.readUsage();
    usage = { available: true, days: snapshot.daily?.length ?? null, first: snapshot.daily?.[0]?.date ?? null,
      last: snapshot.daily?.at(-1)?.date ?? null, lifetime_tokens: snapshot.lifetime_tokens };
  } catch { usage = { available: false }; }
  process.stdout.write(JSON.stringify({ email_matches: true, account_fingerprint: createHash("sha256").update(account.account_id).digest("hex").slice(0, 16),
    plan: account.plan_type, windows: quota.windows.map((w) => ({ id: w.window_id, duration_minutes: w.duration_minutes, used_percent: w.used_percent })), usage }) + "\n");
} finally { await client.close(); }
