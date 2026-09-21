import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** `~/x` / `$HOME/x` → 绝对路径。配置里的路径一律过这一层。 */
export function expandHome(p: string): string {
  let out = p;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  else if (out.startsWith("$HOME/")) out = join(homedir(), out.slice(6));
  return isAbsolute(out) ? out : resolve(out);
}

export const CONFIG_DIR = join(homedir(), ".config", "ua-probe");
export const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, "config.toml");
export const DEFAULT_STATE_PATH = join(CONFIG_DIR, "state.db");
export const DEFAULT_CREDENTIAL_FILE = join(CONFIG_DIR, "claude-session-key");
