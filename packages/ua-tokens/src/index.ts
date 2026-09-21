/** 分类色板的令牌名，图表按序取用；确保「机器 A 在任何图里都是同一个颜色」。 */
export const CATEGORICAL = ["var(--cat1)", "var(--cat2)", "var(--cat3)", "var(--cat4)"] as const;
export const STATUS = { ok: "var(--ok)", warn: "var(--warn)", danger: "var(--danger)", info: "var(--info)" } as const;
export type ThemeName = "dark" | "light";
export const THEME_CLASS: Record<ThemeName, string> = { dark: "t-dark", light: "t-light" };
