/**
 * key → 色板下标的全局登记表。
 *
 * 「机器 A 在任何一张图里必须是同一个颜色」：颜色不能由每张图自己的数据顺序决定，
 * 必须由一个跨图表的稳定下标决定。这里按 domain 记住首次出现顺序。
 */
import { palette, type Tokens } from "./tokens";

export type ColorDomain = "machine" | "model" | "project" | "attribution";

const order = new Map<ColorDomain, Map<string, number>>();

function slot(domain: ColorDomain, key: string): number {
  let m = order.get(domain);
  if (!m) {
    m = new Map();
    order.set(domain, m);
  }
  const hit = m.get(key);
  if (hit !== undefined) return hit;
  const next = m.size;
  m.set(key, next);
  return next;
}

export function colorFor(domain: ColorDomain, key: string, t: Tokens): string {
  const i = slot(domain, key);
  const p = palette(t, i + 1);
  return p[i] ?? t.cat1;
}

export function colorMapFor(
  domain: ColorDomain,
  keys: readonly string[],
  t: Tokens,
): Map<string, string> {
  return new Map(keys.map((k) => [k, colorFor(domain, k, t)]));
}
