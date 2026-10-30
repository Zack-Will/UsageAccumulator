import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchdPlist, systemdUnit } from "../src/install.js";
import { detectInstall, findServices, restartCommand, sha256, updateBundle, type Fetcher } from "../src/update.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ua-update-"));
const served = (files: Record<string, string | Uint8Array>): Fetcher => async (url) => {
  const body = files[url];
  return body === undefined
    ? { ok: false, status: 404, bytes: async () => new Uint8Array() }
    : { ok: true, status: 200, bytes: async () => typeof body === "string" ? new TextEncoder().encode(body) : body };
};

describe("ua-probe update", () => {
  it("tells the three install kinds apart", () => {
    expect(detectInstall("/Users/me/Repos/UsageAccumulator/packages/ua-probe/src/cli.ts")).toBe("source");
    expect(detectInstall("/opt/homebrew/lib/node_modules/@zack-will/ua-probe/ua-probe.mjs")).toBe("npm");
    expect(detectInstall("/Users/me/.local/lib/ua-codex/ua-probe.mjs")).toBe("bundle");
  });

  it("finds every enabled service that runs this entry, and skips disabled units", () => {
    const dir = tmp();
    const entry = "/Users/me/.local/lib/ua-codex/ua-probe.mjs";
    const plist = (label: string, args: string[]) => launchdPlist({
      label, launcher: { program: "/opt/homebrew/bin/node", args: [entry, ...args] }, configPath: "/c.toml", logDir: "/logs", nodeDir: "/opt/homebrew/bin",
    });
    writeFileSync(join(dir, "com.ua.probe.plist"), plist("com.ua.probe", ["run"]));
    writeFileSync(join(dir, "com.ua.codex-probe.plist"), plist("com.ua.codex-probe", ["codex-run"]));
    writeFileSync(join(dir, "com.old.plist.disabled-arch-switch"), plist("com.old", ["run"]));
    writeFileSync(join(dir, "other.plist"), plist("other", []).replace(entry, "/elsewhere/ua-probe.mjs"));
    const found = findServices([entry], [{ manager: "launchd", dir }]);
    expect(found.map((s) => s.name)).toEqual(["com.ua.codex-probe", "com.ua.probe"]);
    expect(restartCommand(found[1]!, 501)).toEqual(["launchctl", "kickstart", "-k", "gui/501/com.ua.probe"]);
  });

  it("matches systemd units by ExecStart only", () => {
    const dir = tmp();
    const entry = "/home/me/.local/lib/ua-probe.mjs";
    writeFileSync(join(dir, "ua-probe.service"), systemdUnit({ launcher: { program: "/usr/bin/node", args: [entry, "run"] }, configPath: "/c.toml" }));
    writeFileSync(join(dir, "unrelated.service"), `[Unit]\nDescription=${entry}\n[Service]\nExecStart=/bin/true\n`);
    const found = findServices([entry], [{ manager: "systemd", dir }]);
    expect(found.map((s) => s.name)).toEqual(["ua-probe.service"]);
    expect(restartCommand(found[0]!)).toEqual(["systemctl", "--user", "restart", "ua-probe.service"]);
  });

  it("replaces the bundle only after the checksum matches, keeping its mode", async () => {
    const dir = tmp();
    const target = join(dir, "ua-probe.mjs");
    writeFileSync(target, "old", { mode: 0o755 });
    const url = "https://ua.example/dl/ua-probe.mjs";
    const next = new TextEncoder().encode("new");
    const fetcher = served({ [url]: next, [`${url}.sha256`]: `${sha256(next)}  ua-probe.mjs\n` });

    expect((await updateBundle(target, url, { check: true, fetcher })).status).toBe("available");
    expect(readFileSync(target, "utf8")).toBe("old");
    expect((await updateBundle(target, url, { fetcher })).status).toBe("updated");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect((await updateBundle(target, url, { fetcher })).status).toBe("up_to_date");
    expect(readdirSync(dir)).toEqual(["ua-probe.mjs"]);
  });

  it("refuses a download that does not match the published checksum", async () => {
    const dir = tmp();
    const target = join(dir, "ua-probe.mjs");
    writeFileSync(target, "old");
    const url = "https://ua.example/dl/ua-probe.mjs";
    const fetcher = served({ [url]: "tampered", [`${url}.sha256`]: `${sha256(new TextEncoder().encode("new"))}  ua-probe.mjs\n` });
    await expect(updateBundle(target, url, { fetcher })).rejects.toThrow(/校验和不符/);
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["ua-probe.mjs"]);
  });
});
