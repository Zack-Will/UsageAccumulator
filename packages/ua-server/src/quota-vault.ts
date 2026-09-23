/**
 * claude.ai 会话（sessionKey）在服务端的保管处。
 *
 * ★ 存文件，不进 Postgres：数据库会被备份、会被 pg_dump 带走，凭证不该跟着走。
 *   一个 profile 一个文件，目录 0700、文件 0600，写入走「临时文件 + rename」保证原子。
 * ★ 采样器每一轮都重新读文件：在机器上直接覆盖它（比如 ssh 管道写入）同样立刻生效。
 * ★ 只有读写删，API 层永远不回显内容（见 app.ts 的 /v1/quota/session）。
 */
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionVault {
  /** 存了会话的 profile_id */
  list(): Promise<string[]>;
  /** 读不到返回 null，不抛 */
  read(profileId: string): Promise<string | null>;
  write(profileId: string, sessionKey: string): Promise<void>;
  /** 返回是否真的删掉了一份 */
  remove(profileId: string): Promise<boolean>;
}

/** profile_id 直接当文件名，所以只收安全字符：挡住 `../` 这类路径穿越，也挡住以 `.` 开头的临时文件。 */
export function isVaultSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

export class FileSessionVault implements SessionVault {
  constructor(
    private readonly dir: string,
    private readonly onWarn?: (msg: string) => void,
  ) {}

  private pathOf(profileId: string): string {
    if (!isVaultSafeId(profileId)) throw new Error(`profile_id 不能当文件名：${profileId}`);
    return join(this.dir, profileId);
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter(isVaultSafeId).sort();
    } catch {
      return [];
    }
  }

  async read(profileId: string): Promise<string | null> {
    const p = this.pathOf(profileId);
    try {
      const st = await stat(p);
      // 0600 是硬要求：group/other 有任何权限就告警（和探针的 FileCredentialStore 同一口径）
      if ((st.mode & 0o077) !== 0) {
        this.onWarn?.(`${p} 权限过宽（${(st.mode & 0o777).toString(8)}），应为 600`);
      }
      const v = (await readFile(p, "utf8")).trim();
      return v || null;
    } catch {
      return null;
    }
  }

  async write(profileId: string, sessionKey: string): Promise<void> {
    const target = this.pathOf(profileId);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    // 以 . 开头：list() 不会把写到一半的临时文件当成一个 profile
    const tmp = join(this.dir, `.${profileId}.${process.pid}.${Date.now()}.tmp`);
    try {
      await writeFile(tmp, `${sessionKey}\n`, { mode: 0o600, flag: "wx" });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async remove(profileId: string): Promise<boolean> {
    try {
      await rm(this.pathOf(profileId));
      return true;
    } catch {
      return false;
    }
  }
}

/** 测试与「不落盘」场景用。 */
export class MemorySessionVault implements SessionVault {
  private readonly keys = new Map<string, string>();

  async list(): Promise<string[]> {
    return [...this.keys.keys()].sort();
  }
  async read(profileId: string): Promise<string | null> {
    return this.keys.get(profileId) ?? null;
  }
  async write(profileId: string, sessionKey: string): Promise<void> {
    this.keys.set(profileId, sessionKey);
  }
  async remove(profileId: string): Promise<boolean> {
    return this.keys.delete(profileId);
  }
}
