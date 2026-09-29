/**
 * key → 色板下标的全局登记表。
 *
 * 「机器 A 在任何一张图里必须是同一个颜色」：颜色不能由每张图自己的数据顺序决定，
 * 必须由一个跨图表的稳定下标决定。这里按 domain 记住首次出现顺序。
 */
import { palette, type Tokens } from "./tokens";

export type ColorDomain = "machine" | "model" | "project" | "attribution" | "product";

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

/**
 * ★ 同一批里没见过的 key **按字典序**登记，而不是按调用方给的顺序。
 *
 * 调用方给的顺序通常是「按 token 降序」—— 排名一变，刷新页面后谁先登记就变了，
 * 两个模型的颜色会互换（实测：Opus 5.5 的用量刚超过 Opus 5，两者颜色当场对调）。
 * 字典序与数据无关，同一组 key 每次刷新都落在同一个色位上。
 */
export function colorMapFor(
  domain: ColorDomain,
  keys: readonly string[],
  t: Tokens,
): Map<string, string> {
  for (const k of [...new Set(keys)].sort()) slot(domain, k);
  return new Map(keys.map((k) => [k, colorFor(domain, k, t)]));
}
