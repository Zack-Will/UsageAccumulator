import { calibrate } from "@ua/core";
import type { Logger } from "pino";
import { buildObservations, calibrationPoints } from "./aggregate.js";
import type { CalibrationRecord, Store } from "./store.js";

/**
 * 标定任务（ARCHITECTURE §7.0）。
 *
 * 官方只给百分比，本地有精确 token；把两者配对成观测，非负最小二乘反解出
 * 限额绝对值与模型权重，结果写 calibrations 表（只增不改，方便看限额是否被官方调过）。
 *
 * 观测点不足时 calibrate() 返回 null —— 此时**不写表**，看板显示「标定中」，
 * 所有指标退回百分比口径，功能不受影响。
 */
export interface CalibrationJobOptions {
  /** 回看多久的采样点，默认 14 天 */
  lookbackMs?: number;
  /** 少于这么多干净观测不出结果 */
  minObservations?: number;
  now?: Date;
}

export async function runCalibrationOnce(
  store: Store,
  opts: CalibrationJobOptions = {},
): Promise<CalibrationRecord[]> {
  const now = opts.now ?? new Date();
  const lookbackMs = opts.lookbackMs ?? 14 * 24 * 60 * 60 * 1000;
  const since = new Date(now.getTime() - lookbackMs);

  const written: CalibrationRecord[] = [];
  const profiles = await store.listProfiles();

  for (const profile of profiles) {
    const kinds = await store.latestQuotaWindows(profile.id);
    if (kinds.length === 0) continue;
    const rows = await store.eventsInRange(profile.id, since, now);
    const events = rows.map((r) => r.event);

    for (const k of kinds) {
      const samples = await store.quotaSamples(profile.id, k.windowKind, since);
      const observations = buildObservations(samples, events);
      const result = calibrate(observations, {
        ...(opts.minObservations !== undefined ? { minObservations: opts.minObservations } : {}),
      });
      if (!result) continue;

      const rec: CalibrationRecord = {
        profileId: profile.id,
        windowKind: k.windowKind,
        computedAt: now,
        limitWeightedTokens: result.limitWeightedTokens,
        baseModel: result.baseModel,
        weights: result.weights,
        residual: result.residual,
        observations: result.observations,
        converged: result.converged,
        // 散点与残差必须来自同一批观测，所以在这里算好一起落库
        points: calibrationPoints(observations, result),
      };
      await store.insertCalibration(rec);
      written.push(rec);
    }
  }
  return written;
}

/** 定期跑；返回停止函数。 */
export function startCalibrationJob(
  store: Store,
  intervalMs: number,
  log: Logger,
  opts: CalibrationJobOptions = {},
): () => void {
  if (intervalMs <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const written = await runCalibrationOnce(store, opts);
      if (written.length > 0) {
        log.info(
          {
            calibrations: written.map((w) => ({
              profile_id: w.profileId,
              window_kind: w.windowKind,
              observations: w.observations,
              residual: Number(w.residual.toFixed(4)),
              limit_weighted_tokens: Math.round(w.limitWeightedTokens),
            })),
          },
          "calibration updated",
        );
      }
    } catch (err) {
      log.error({ err }, "calibration job failed");
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
