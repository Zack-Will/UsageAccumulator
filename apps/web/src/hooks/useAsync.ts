import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/** 极简数据获取：deps 变化即重取，卸载/重取时 abort 上一次。 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    setState((s) => ({ data: s.data, error: null, loading: true }));
    fn(ac.signal)
      .then((data) => {
        if (alive) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!alive || ac.signal.aborted) return;
        setState({ data: null, error: e instanceof Error ? e : new Error(String(e)), loading: false });
      });
    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
