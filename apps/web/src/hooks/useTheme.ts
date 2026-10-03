import { useCallback, useEffect, useState } from "react";
import { THEME_CLASS, type ThemeName } from "@ua/tokens";
import { syncAppTheme } from "../app-bridge";

const LS_KEY = "ua.theme";

function initial(): ThemeName {
  try {
    const v = globalThis.localStorage?.getItem(LS_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* 忽略 */
  }
  return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useTheme(): [ThemeName, (t: ThemeName) => void] {
  const [theme, setTheme] = useState<ThemeName>(initial);

  useEffect(() => {
    const el = document.documentElement;
    el.classList.remove(THEME_CLASS.dark, THEME_CLASS.light);
    el.classList.add(THEME_CLASS[theme]);
    el.style.colorScheme = theme;
    syncAppTheme(theme);
    try {
      globalThis.localStorage?.setItem(LS_KEY, theme);
    } catch {
      /* 忽略 */
    }
  }, [theme]);

  const set = useCallback((t: ThemeName) => setTheme(t), []);
  return [theme, set];
}
