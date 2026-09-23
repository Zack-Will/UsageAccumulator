export type RingTone = "ok" | "warn" | "danger";

/**
 * 已用逼近上限 → danger；已用偏高或预测撞线 → warn。
 * 7d Fable 这类「用了七成、预计九成」的窗口必须落在 warn，不能显示成安全。
 */
export function ringTone(used: number, projected: number): RingTone {
  if (used >= 90) return "danger";
  if (used >= 70 || projected >= 95) return "warn";
  return "ok";
}
