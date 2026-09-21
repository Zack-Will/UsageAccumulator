import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const LAUNCHD_LABEL = "com.ua.probe";
export const SYSTEMD_UNIT = "ua-probe.service";

export interface Launcher {
  program: string;
  args: string[];
}

/**
 * 找一个能跑 TypeScript 入口的启动器。
 * 优先用仓库里装好的 tsx（它能把 `./x.js` 解析到 `./x.ts`），
 * 没有则退回 node（要求已经有编译产物或 Node 自带类型剥离）。
 */
export function resolveLauncher(cliPath = defaultCliPath()): Launcher {
  let dir = dirname(cliPath);
  for (let i = 0; i < 8; i++) {
    const bin = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(bin)) return { program: bin, args: [cliPath, "run"] };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { program: process.execPath, args: [cliPath, "run"] };
}

export function defaultCliPath(): string {
  return resolve(fileURLToPath(new URL("./cli.ts", import.meta.url)));
}

export function launchdPlist(v: { label: string; launcher: Launcher; configPath: string; logDir: string }): string {
  const argv = [v.launcher.program, ...v.launcher.args, "--config", v.configPath];
  const items = argv.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(v.label)}</string>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(v.logDir, "ua-probe.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(v.logDir, "ua-probe.err.log"))}</string>
</dict>
</plist>
`;
}

export function systemdUnit(v: { launcher: Launcher; configPath: string }): string {
  const cmd = [v.launcher.program, ...v.launcher.args, "--config", v.configPath].map(shellQuote).join(" ");
  return `[Unit]
Description=UsageAccumulator probe
After=network-online.target

[Service]
Type=simple
ExecStart=${cmd}
Restart=always
RestartSec=10
# 只读 $HOME/.claude 与 ~/.cc-switch，不需要 root
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

export interface ServiceInstallResult {
  platform: string;
  unitPath: string;
  loaded: boolean;
  notes: string[];
}

/** macOS → launchd user agent；Linux → systemd user service（不需要 root）。 */
export async function installService(configPath: string, launcher = resolveLauncher()): Promise<ServiceInstallResult> {
  const notes: string[] = [];
  if (process.platform === "darwin") {
    const dir = join(homedir(), "Library", "LaunchAgents");
    const logDir = join(homedir(), "Library", "Logs", "ua-probe");
    mkdirSync(dir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    const unitPath = join(dir, `${LAUNCHD_LABEL}.plist`);
    writeFileSync(unitPath, launchdPlist({ label: LAUNCHD_LABEL, launcher, configPath, logDir }), { mode: 0o644 });
    let loaded = false;
    try {
      const uid = process.getuid?.() ?? 0;
      await exec("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]).catch(() => undefined);
      await exec("launchctl", ["bootstrap", `gui/${uid}`, unitPath]);
      loaded = true;
    } catch (err) {
      notes.push(`launchctl bootstrap 失败：${(err as Error).message}；手动执行 launchctl bootstrap gui/$(id -u) ${unitPath}`);
    }
    notes.push(`日志：${join(logDir, "ua-probe.log")}`);
    return { platform: "darwin", unitPath, loaded, notes };
  }

  const dir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const unitPath = join(dir, SYSTEMD_UNIT);
  writeFileSync(unitPath, systemdUnit({ launcher, configPath }), { mode: 0o644 });
  let loaded = false;
  try {
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    loaded = true;
  } catch (err) {
    notes.push(`systemctl 失败：${(err as Error).message}；手动执行 systemctl --user enable --now ${SYSTEMD_UNIT}`);
  }
  // ★ 不加这个，SSH 断开后 user service 会被杀
  notes.push(`记得执行：loginctl enable-linger ${process.env["USER"] ?? "$USER"}    # 否则 SSH 断开后探针会被杀掉`);
  notes.push(`日志：journalctl --user -u ${SYSTEMD_UNIT} -f`);
  return { platform: "linux", unitPath, loaded, notes };
}
