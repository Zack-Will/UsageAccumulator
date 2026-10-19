import { useCallback, useEffect, useState } from "react";

/**
 * 看哪一家：Claude 与 Codex 是两本独立的账本，切换器在顶栏，选项卡两边共用。
 * 和主题一样记在本机；旧链接 #/codex 进来时直接切到 Codex。
 */
export type Provider = "claude" | "codex";

const LS_KEY = "ua.provider";

function initial(): Provider {
  if (globalThis.location?.hash.replace(/^#\/?/, "") === "codex") return "codex";
  try {
    const v = globalThis.localStorage?.getItem(LS_KEY);
    if (v === "claude" || v === "codex") return v;
  } catch {
    /* 隐私模式下 localStorage 可能抛错 */
  }
  return "claude";
}

export function useProvider(): [Provider, (p: Provider) => void] {
  const [provider, setProvider] = useState<Provider>(initial);
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(LS_KEY, provider);
    } catch {
      /* 忽略 */
    }
  }, [provider]);
  return [provider, useCallback((p: Provider) => setProvider(p), [])];
}
