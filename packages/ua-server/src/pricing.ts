import { createHash } from "node:crypto";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import {
  EMPTY_PRICING,
  buildPricingTable,
  computeCodexCost,
  computeCostUsd,
  parsePriceEntries,
  pricedModels,
  type CodexUsageEvent,
  type ModelPrice,
  type PricingTable,
} from "@ua/core";
import type { CodexCost } from "./codex-store.js";

/**
 * 定价表**注入**，不内置，而且是**数据**：改价不需要改代码、发版或重启。
 *
 * 分两层，后者整条覆盖前者同名的模型：
 *   - bundled：deploy/pricing.json，随代码发布，是正式的、核实过的价格；
 *   - override：~/.config/ua-server/pricing.json，可选。临时改价、新模型先顶上，写这里即可。
 * 两个文件都被监听，改动后自动重新加载；SIGHUP 或 POST /v1/pricing/reload 也能触发。
 *
 * 新文件有任何错误就**整体不生效**、继续用上一份好的表，并在状态里报出来 ——
 * 写错一个字段不该把所有成本都清空。只有启动时没有上一份可用，才退而接受其中合法的条目。
 *
 * 成本在**读取时**按当前表计算（见 live-pricing.ts），所以改价对历史数据立即生效，不需要回填。
 */

/** 纯函数：把一份 pricing.json 的内容解析成 PricingTable。坏条目跳过并报错。 */
export function parsePricingFile(raw: unknown, origin: string | null = null): { table: PricingTable; errors: string[] } {
  const { entries, errors } = parsePriceEntries(raw, origin);
  return { table: buildPricingTable([entries]), errors };
}

export function loadPricingTable(path: string): { table: PricingTable; errors: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { table: { ...EMPTY_PRICING }, errors: [`pricing file not found: ${path}`] };
  }
  try {
    return parsePricingFile(JSON.parse(text) as unknown);
  } catch {
    return { table: { ...EMPTY_PRICING }, errors: [`pricing file is not valid JSON: ${path}`] };
  }
}

/**
 * 价格版本：对生效价格做的指纹，不靠人手动改版本号 —— 内容变了版本就变。
 * 声明的 version 只用于展示，不进指纹（只改说明、不改价格时不必重算历史）。
 */
export function pricingVersion(table: PricingTable): string {
  const canon = pricedModels(table).map((p) => [p.model, p.rates, p.tiers, p.aliases]);
  return `cat-${createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 12)}`;
}

/** 合成标记，实测 43 条。必须排除在计费与限额统计之外。 */
export const SYNTHETIC_MODEL = "<synthetic>";

/**
 * 是否 Anthropic 家族的模型。
 *
 * 套壳客户端会把请求路由到非 Anthropic 的后端（公司 Mac 上实测到 `qwen3.7-plus`）。
 * 那些 token 不消耗 Claude 的额度，计进来会让「用量 ↔ 百分比」的关系失真，
 * §7.0 的限额标定也会跟着被带偏。
 *
 * ★ 按**家族前缀**判断，不枚举具体型号：Anthropic 的命名一直是 `claude-*`
 * 或裸家族名（opus / sonnet / haiku / fable），新型号能自动命中；
 * 写死型号清单会在下次发新模型那天静默丢掉它的用量 —— 那种错不会报警，
 * 只会让数字慢慢对不上。
 */
const ANTHROPIC_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

export function isAnthropicModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith("claude")) return true;
  return ANTHROPIC_FAMILIES.some((f) => m === f || m.startsWith(`${f}-`) || m.startsWith(`${f}.`));
}

export function countsTowardQuota(model: string): boolean {
  return model !== SYNTHETIC_MODEL && isAnthropicModel(model);
}

/**
 * 事件成本。缺价返回 null，`<synthetic>` 也返回 null —— 合成事件根本不该计费。
 */
export function eventCostUsd(
  e: Parameters<typeof computeCostUsd>[0],
  table: PricingTable,
): number | null {
  if (!countsTowardQuota(e.model)) return null;
  const breakdown = computeCostUsd(e, table);
  return breakdown ? breakdown.totalUsd : null;
}

export interface PricingLayer {
  /** "bundled" | "override"，同时写进条目的 origin */
  kind: string;
  path: string;
  /** 可选的层：文件不存在不算错误 */
  optional: boolean;
}

export interface PricingLayerStatus {
  kind: string;
  path: string;
  present: boolean;
  declaredVersion: string | null;
  models: number;
  errors: string[];
}

export interface PricingStatus {
  version: string;
  loadedAt: Date | null;
  models: ModelPrice[];
  layers: PricingLayerStatus[];
  /** 最近一次加载被拒时的原因；为空 = 当前表就是磁盘上的最新内容 */
  rejected: { at: Date; errors: string[] } | null;
}

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * 当前生效的价格表。服务端只有这一个实例，所有算成本的地方都问它。
 */
export class PriceBook {
  private table: PricingTable = EMPTY_PRICING;
  private ver = pricingVersion(EMPTY_PRICING);
  private loadedAt: Date | null = null;
  private layerStatus: PricingLayerStatus[] = [];
  private rejected: PricingStatus["rejected"] = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly layers: PricingLayer[],
    private readonly log?: Log,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 测试用：直接拿一张表当价格本，不读文件 */
  static fixed(table: PricingTable): PriceBook {
    const book = new PriceBook([]);
    book.table = table;
    book.ver = pricingVersion(table);
    book.loadedAt = new Date(0);
    return book;
  }

  get version(): string {
    return this.ver;
  }

  get current(): PricingTable {
    return this.table;
  }

  /** 价格内容真的变了才通知（只改说明不算） */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 重新读所有层。返回是否生效：
   *   - 有错误且已有一份好表 → 不生效，保留旧表，记下被拒原因；
   *   - 有错误但还没有任何表（启动）→ 接受合法条目，错误照样报出来。
   */
  reload(): boolean {
    const statuses: PricingLayerStatus[] = [];
    const entries: ModelPrice[][] = [];
    const errors: string[] = [];
    for (const layer of this.layers) {
      const st: PricingLayerStatus = { kind: layer.kind, path: layer.path, present: false, declaredVersion: null, models: 0, errors: [] };
      statuses.push(st);
      let text: string;
      try {
        text = readFileSync(layer.path, "utf8");
      } catch {
        if (!layer.optional) st.errors.push(`pricing file not found: ${layer.path}`);
        errors.push(...st.errors.map((e) => `${layer.kind}: ${e}`));
        continue;
      }
      st.present = true;
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch (err) {
        st.errors.push(`not valid JSON: ${(err as Error).message}`);
        errors.push(...st.errors.map((e) => `${layer.kind}: ${e}`));
        continue;
      }
      const parsed = parsePriceEntries(raw, layer.kind);
      st.declaredVersion = parsed.version;
      st.models = parsed.entries.length;
      st.errors.push(...parsed.errors);
      errors.push(...parsed.errors.map((e) => `${layer.kind}: ${e}`));
      entries.push(parsed.entries);
    }

    const at = this.now();
    if (errors.length > 0 && this.loadedAt !== null) {
      this.rejected = { at, errors };
      this.log?.error({ errors }, "定价文件有错误，未生效，继续使用上一份价格");
      return false;
    }

    const table = buildPricingTable(entries);
    const version = pricingVersion(table);
    const changed = version !== this.ver;
    this.table = table;
    this.ver = version;
    this.loadedAt = at;
    this.layerStatus = statuses;
    this.rejected = errors.length > 0 ? { at, errors } : null;
    if (errors.length > 0) this.log?.warn({ errors }, "定价文件有错误，只加载了其中合法的条目；缺价的模型成本为 null");
    this.log?.info({ version, models: pricedModels(table).length, changed }, "定价表已加载");
    if (changed) for (const fn of this.listeners) fn();
    return true;
  }

  /**
   * 监听各层文件所在的目录（编辑器常用「写临时文件再改名」，监听文件本身会丢事件），
   * 稍等片刻再读，免得读到写了一半的文件。返回停止函数。
   */
  watch(debounceMs = 300): () => void {
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        this.reload();
      }, debounceMs);
      timer.unref?.();
    };
    const dirs = new Map<string, Set<string>>();
    for (const l of this.layers) {
      const dir = dirname(l.path);
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir)!.add(basename(l.path));
    }
    for (const [dir, names] of dirs) {
      if (!existsSync(dir)) continue; // 覆盖层的目录可能还不存在：那就只能靠 SIGHUP / 接口触发
      try {
        const w = watch(dir, (_event, file) => {
          if (file === null || names.has(file.toString())) schedule();
        });
        w.unref?.();
        watchers.push(w);
      } catch (err) {
        this.log?.warn({ dir, err: (err as Error).message }, "无法监听定价文件目录，改价后需手动重新加载");
      }
    }
    return () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    };
  }

  claudeCost(e: Parameters<typeof computeCostUsd>[0]): number | null {
    return eventCostUsd(e, this.table);
  }

  codexCost(e: CodexUsageEvent): CodexCost {
    return computeCodexCost(e, this.table, this.ver);
  }

  status(): PricingStatus {
    return {
      version: this.ver,
      loadedAt: this.loadedAt,
      models: pricedModels(this.table),
      layers: this.layerStatus,
      rejected: this.rejected,
    };
  }
}
