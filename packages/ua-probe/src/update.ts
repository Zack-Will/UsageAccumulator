import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** README 推荐的安装来源；npm 全局安装的探针按它升级。 */
export const RELEASE_TGZ_URL = "https://github.com/Zack-Will/UsageAccumulator/releases/latest/download/ua-probe.tgz";

/**
 * 探针的三种装法，升级方式各不相同：
 * - npm：`npm i -g` 装的，入口在某个 node_modules 里，重跑 npm 即可；
 * - bundle：curl 下来的单文件，从服务端 /dl 拿新版、校验后原地替换；
 * - source：直接跑仓库源码，版本由 git/rsync 决定，探针不该替你动工作区。
 */
export type InstallKind = "npm" | "bundle" | "source";

export function detectInstall(realCliPath: string): InstallKind {
  if (/\.ts$/.test(realCliPath)) return "source";
  if (/[\\/]node_modules[\\/]/.test(realCliPath)) return "npm";
  return "bundle";
}

export interface ServiceRef {
  manager: "launchd" | "systemd";
  name: string;
  unitPath: string;
}

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 找出启动参数里引用了这个入口的服务。同一个单文件可能同时跑着 Claude 探针和
 * Codex 采集器（com.ua.probe / com.ua.codex-probe），升级后两个都要重启。
 * 只看 *.plist / *.service：改了后缀停用的旧单元不能被拉起来抢状态库。
 */
export function findServices(paths: string[], dirs = serviceDirs()): ServiceRef[] {
  const out: ServiceRef[] = [];
  const needles = [...new Set(paths)];
  for (const { manager, dir } of dirs) {
    if (!existsSync(dir)) continue;
    const suffix = manager === "launchd" ? ".plist" : ".service";
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(suffix)) continue;
      const unitPath = join(dir, file);
      let text: string;
      try { text = readFileSync(unitPath, "utf8"); } catch { continue; }
      if (manager === "launchd") {
        if (!needles.some((p) => text.includes(`<string>${xmlEscape(p)}</string>`))) continue;
        const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] ?? basename(file, suffix);
        out.push({ manager, name: label, unitPath });
      } else {
        const execStart = text.split("\n").filter((l) => l.startsWith("ExecStart=")).join("\n");
        if (!needles.some((p) => execStart.includes(p))) continue;
        out.push({ manager, name: file, unitPath });
      }
    }
  }
  return out;
}

function serviceDirs(): { manager: ServiceRef["manager"]; dir: string }[] {
  return process.platform === "darwin"
    ? [{ manager: "launchd", dir: join(homedir(), "Library", "LaunchAgents") }]
    : [{ manager: "systemd", dir: join(homedir(), ".config", "systemd", "user") }];
}

export function restartCommand(s: ServiceRef, uid = process.getuid?.() ?? 0): string[] {
  return s.manager === "launchd"
    ? ["launchctl", "kickstart", "-k", `gui/${uid}/${s.name}`]
    : ["systemctl", "--user", "restart", s.name];
}

export const sha256 = (buf: Uint8Array): string => createHash("sha256").update(buf).digest("hex");

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; bytes(): Promise<Uint8Array> }>;
const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { redirect: "follow" });
  return { ok: res.ok, status: res.status, bytes: async () => new Uint8Array(await res.arrayBuffer()) };
};

export interface BundleUpdate {
  status: "up_to_date" | "available" | "updated";
  localSha: string;
  remoteSha: string;
}

/**
 * 单文件升级：先拿 .sha256 判断有没有新版，再下载并校验，最后同目录写临时文件 + rename，
 * 正在跑的服务读到的要么是整份旧文件要么是整份新文件，不会是半截。
 */
export async function updateBundle(target: string, url: string, opts: { check?: boolean; fetcher?: Fetcher } = {}): Promise<BundleUpdate> {
  const get = opts.fetcher ?? defaultFetch;
  const sumRes = await get(`${url}.sha256`);
  if (!sumRes.ok) throw new Error(`下载校验和失败：HTTP ${sumRes.status}（${url}.sha256）`);
  const remoteSha = /^[0-9a-f]{64}\b/i.exec(new TextDecoder().decode(await sumRes.bytes()).trim())?.[0]?.toLowerCase();
  if (!remoteSha) throw new Error(`校验和格式不对：${url}.sha256`);
  const localSha = sha256(readFileSync(target));
  if (localSha === remoteSha) return { status: "up_to_date", localSha, remoteSha };
  if (opts.check) return { status: "available", localSha, remoteSha };

  const res = await get(url);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}（${url}）`);
  const body = await res.bytes();
  const got = sha256(body);
  if (got !== remoteSha) throw new Error(`下载内容与校验和不符（期望 ${remoteSha.slice(0, 12)}…，实际 ${got.slice(0, 12)}…），未替换`);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, body, { mode: statSync(target).mode & 0o777 });
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 已不存在 */ }
    throw err;
  }
  return { status: "updated", localSha, remoteSha };
}

export async function restartServices(services: ServiceRef[]): Promise<{ service: ServiceRef; error: string | null }[]> {
  const results: { service: ServiceRef; error: string | null }[] = [];
  for (const service of services) {
    const [cmd, ...args] = restartCommand(service);
    try { await exec(cmd!, args); results.push({ service, error: null }); }
    catch (err) { results.push({ service, error: (err as Error).message.trim() }); }
  }
  return results;
}

export async function npmInstallGlobal(spec: string): Promise<void> {
  await exec("npm", ["i", "-g", spec], { maxBuffer: 16 << 20 });
}

export function realPath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}
