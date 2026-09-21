import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { expandHome } from "./paths.js";

const exec = promisify(execFile);

/**
 * 官方额度用的 sessionKey。
 *
 * ★ 只存本机，**绝不上报服务端**，也绝不进日志（ARCHITECTURE §9）。
 * 这里只有读，没有写 —— 写入由用户自己执行，凭证不经过探针的命令行
 * （argv 会出现在 `ps` 里）。
 */
export interface CredentialStore {
  readonly kind: string;
  /** 读不到返回 null，不抛。 */
  read(): Promise<string | null>;
  /** 给用户看的"怎么把凭证放进去"提示，绝不包含凭证本身。 */
  hint(): string;
}

export class KeychainCredentialStore implements CredentialStore {
  readonly kind = "keychain";
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  async read(): Promise<string | null> {
    try {
      const { stdout } = await exec("security", [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
      ]);
      const v = stdout.trim();
      return v || null;
    } catch {
      return null;
    }
  }

  hint(): string {
    return `security add-generic-password -U -s ${this.service} -a ${this.account} -w   # 交互式输入，不要写在命令行里`;
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly kind = "file";
  constructor(
    private readonly path: string,
    private readonly onPermissionWarning?: (msg: string) => void,
  ) {}

  async read(): Promise<string | null> {
    const p = expandHome(this.path);
    try {
      const st = await stat(p);
      // 0600 是硬要求：group/other 有任何权限就告警
      if ((st.mode & 0o077) !== 0) {
        this.onPermissionWarning?.(`${p} 权限过宽（${(st.mode & 0o777).toString(8)}），应为 600`);
      }
      const v = (await readFile(p, "utf8")).trim();
      return v || null;
    } catch {
      return null;
    }
  }

  hint(): string {
    return `install -m 600 /dev/null ${expandHome(this.path)} && cat > ${expandHome(this.path)}   # 粘贴 sessionKey 后 Ctrl-D`;
  }
}

export class EnvCredentialStore implements CredentialStore {
  readonly kind = "env";
  constructor(private readonly name: string) {}

  async read(): Promise<string | null> {
    const v = process.env[this.name];
    return v && v.trim() ? v.trim() : null;
  }

  hint(): string {
    return `export ${this.name}=<sessionKey>`;
  }
}

export function createCredentialStore(
  cfg: {
    credential: "keychain" | "file" | "env";
    keychain_service: string;
    keychain_account: string;
    credential_file: string;
    credential_env: string;
  },
  onPermissionWarning?: (msg: string) => void,
): CredentialStore {
  switch (cfg.credential) {
    case "keychain":
      return new KeychainCredentialStore(cfg.keychain_service, cfg.keychain_account);
    case "env":
      return new EnvCredentialStore(cfg.credential_env);
    case "file":
    default:
      return new FileCredentialStore(cfg.credential_file, onPermissionWarning);
  }
}
