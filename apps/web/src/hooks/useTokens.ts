import { useEffect, useState } from "react";
import type { ThemeName } from "@ua/tokens";
import { readTokens, type Tokens } from "../charts/tokens";

/**
 * 当前主题下的令牌实值。必须在 useTheme 之后调用 —— 它依赖根元素上的
 * t-dark / t-light 类已经挂好。
 */
export function useTokens(theme: ThemeName): Tokens {
  const [tokens, setTokens] = useState<Tokens>(() => readTokens());
  useEffect(() => {
    setTokens(readTokens());
  }, [theme]);
  return tokens;
}
