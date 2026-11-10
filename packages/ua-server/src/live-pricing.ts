import type { CodexStore } from "./codex-store.js";
import type { PriceBook } from "./pricing.js";
import type { Store } from "./store.js";

/**
 * 读取时按**当前**价格表算成本。
 *
 * 所有汇总（看板、窗口、标定、Codex 用量）都从 eventsInRange / codex.events 取行再在 JS 里累加，
 * 所以只要在这两个出口把成本换成现算的，改价对历史数据立即生效、新模型补价后旧记录马上有价，
 * 不再依赖库里存的 cost_usd —— 那一列由 repriceStoredCosts 在后台慢慢跟上。
 *
 * 口径与 Codex 一直以来的 `api_equivalent_current_rates` 一致：按当前 API 单价折算，不还原历史计费。
 */
export function withLivePricing(store: Store, book: PriceBook): Store {
  const codex = new Proxy(store.codex, {
    get(target, prop) {
      if (prop === "events") {
        return async (...args: Parameters<CodexStore["events"]>) =>
          (await target.events(...args)).map((r) => ({ ...r, cost: book.codexCost(r.event) }));
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "codex") return codex;
      if (prop === "eventsInRange") {
        return async (...args: Parameters<Store["eventsInRange"]>) =>
          (await target.eventsInRange(...args)).map((r) => ({ ...r, costUsd: book.claudeCost(r.event) }));
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

interface Log {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const BATCH = 2000;
/** 防御：万一写回没把版本改过来（比如并发改价），别无限循环下去；下次改价或重启会接着补 */
const MAX_BATCHES = 500;

/**
 * 把库里 price_version 不是当前版本的行重算并写回。启动时与每次价格变化后各跑一次；
 * 跑的过程中价格又变了，跑完会再来一轮。返回停止函数。
 */
export function startRepricing(store: Store, book: PriceBook, log: Log): { trigger: () => Promise<void>; stop: () => void } {
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const once = async (): Promise<void> => {
    const version = book.version;
    // 跑到一半价格又变了：立刻收手，交给下一轮按新版本重来。否则写回的是新版本号、
    // 这一轮却还在找「不是旧版本」的行，会把同一批行反复抓回来重算（2026-11-10 线上连改两次价时撞到）
    const current = () => !stopped && book.version === version;
    let claude = 0;
    let codex = 0;
    for (let i = 0; i < MAX_BATCHES && current(); i++) {
      const events = await store.staleCostEvents(version, BATCH);
      if (events.length === 0) break;
      await store.updateEventCosts(version, events.map((event) => ({ event, costUsd: book.claudeCost(event) })));
      claude += events.length;
    }
    for (let i = 0; i < MAX_BATCHES && current(); i++) {
      const rows = await store.codex.staleCostEvents(version, BATCH);
      if (rows.length === 0) break;
      await store.codex.updateEventCosts(rows.map((r) => ({
        account_id: r.account_id, event_id: r.event.event_id, cost: book.codexCost(r.event),
      })));
      codex += rows.length;
    }
    if (claude + codex > 0) log.info({ version, claude, codex }, "已按当前价格重算库里的成本列");
  };

  const trigger = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await once();
        } catch (err) {
          log.error({ err: (err as Error).message }, "重算成本列失败，下次价格变化或重启时再试");
        }
      } while (again && !stopped);
      running = null;
    })();
    return running;
  };

  const off = book.onChange(() => void trigger());
  return {
    trigger,
    stop: () => {
      stopped = true;
      off();
    },
  };
}
