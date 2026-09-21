/**
 * 进程内事件总线，给 SSE 用（CONTRACT §2：/v1/stream 推 window_update / event_batch）。
 * 单实例部署，不需要 Redis；多实例时把它换成 Postgres LISTEN/NOTIFY 即可。
 */
/**
 * CONTRACT §2 定死的三个 SSE 事件：
 *   window_update — data 与 GET /v1/windows/current 同体
 *   event_batch   — {profile_id, count, last_ts}
 *   ping          — {} 心跳
 */
export type StreamEventName = "window_update" | "event_batch" | "ping";

export interface StreamEvent {
  name: StreamEventName;
  profileId: string;
  data: unknown;
}

type Listener = (e: StreamEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  publish(e: StreamEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        // 一个订阅者炸掉不能影响其他人
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

/** SSE 帧。纯函数，单独测。 */
export function formatSse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
