import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LockBusyError,
  acquireForRun,
  lockPathFor,
  pidAlive,
  readHolder,
  tryAcquire,
  type LockDeps,
} from "../src/lock.js";

const dirs: string[] = [];
function tmpLock(): string {
  const d = mkdtempSync(join(tmpdir(), "ua-lock-"));
  dirs.push(d);
  return join(d, "state.db.lock");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一个可编排的假进程表：哪些 pid 活着、收到过哪些信号。 */
function fakeWorld(alive: Set<number>, pid = 100) {
  const signals: Array<[number, string]> = [];
  const deps: LockDeps = {
    pid,
    kill: (target, signal) => {
      if (!alive.has(target)) {
        const e = new Error("ESRCH") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      }
      if (signal !== 0) signals.push([target, String(signal)]);
    },
    sleep: async () => undefined,
  };
  return { deps, signals };
}

describe("lock / 路径与探活", () => {
  it("锁文件紧挨着状态库", () => {
    expect(lockPathFor("/x/state.db")).toBe("/x/state.db.lock");
  });

  it("EPERM 算活着 —— 进程在，只是不归我们管", () => {
    const kill = (): never => {
      const e = new Error("EPERM") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    };
    expect(pidAlive(4242, kill)).toBe(true);
  });

  it("ESRCH 算死了；pid 0/1 一律不当作持有者", () => {
    const kill = (): never => {
      const e = new Error("ESRCH") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    };
    expect(pidAlive(4242, kill)).toBe(false);
    expect(pidAlive(1, kill)).toBe(false);
  });
});

describe("lock / tryAcquire", () => {
  it("空地上直接拿到，锁文件写的是自己的 pid", () => {
    const path = tmpLock();
    const { deps } = fakeWorld(new Set([100]), 100);
    const r = tryAcquire(path, deps);
    expect(r.ok).toBe(true);
    expect(readHolder(path)).toBe(100);
  });

  it("持有者还活着 → 拒绝，并报出是谁占着", () => {
    const path = tmpLock();
    writeFileSync(path, "555\n");
    const { deps } = fakeWorld(new Set([555]), 100);
    const r = tryAcquire(path, deps);
    expect(r).toEqual({ ok: false, holderPid: 555 });
  });

  it("持有者已经死了 → 清掉陈旧锁并接手", () => {
    const path = tmpLock();
    writeFileSync(path, "555\n");
    const { deps } = fakeWorld(new Set(), 100); // 谁都不在
    expect(tryAcquire(path, deps).ok).toBe(true);
    expect(readHolder(path)).toBe(100);
  });

  it("锁文件内容损坏也当陈旧锁处理，而不是把自己锁在门外", () => {
    const path = tmpLock();
    writeFileSync(path, "不是数字");
    const { deps } = fakeWorld(new Set(), 100);
    expect(tryAcquire(path, deps).ok).toBe(true);
  });

  it("release 只删自己的锁 —— 接管者的锁不能被前任误删", () => {
    const path = tmpLock();
    const { deps } = fakeWorld(new Set([100]), 100);
    const r = tryAcquire(path, deps);
    expect(r.ok).toBe(true);
    // 模拟已经被别人接管
    writeFileSync(path, "777\n");
    if (r.ok) r.release();
    expect(readHolder(path)).toBe(777);
  });
});

describe("lock / acquireForRun 接管语义", () => {
  it("老实例收到 SIGTERM 并退出后，新实例接手并报出前任 pid", async () => {
    const path = tmpLock();
    writeFileSync(path, "555\n");
    const alive = new Set([555, 100]);
    const { deps, signals } = fakeWorld(alive, 100);
    // 老实例响应 SIGTERM：下一次 sleep 之后它就没了
    let ticks = 0;
    deps.sleep = async () => {
      if (++ticks >= 1) alive.delete(555);
    };

    const got = await acquireForRun(path, deps, { graceMs: 1000, stepMs: 100 });
    expect(signals).toEqual([[555, "SIGTERM"]]);
    expect(got.tookOverFrom).toBe(555);
    expect(readHolder(path)).toBe(100);
  });

  it("老实例赖着不走 → 宽限期后报错，**不**升级成 SIGKILL", async () => {
    const path = tmpLock();
    writeFileSync(path, "555\n");
    const { deps, signals } = fakeWorld(new Set([555, 100]), 100);

    await expect(acquireForRun(path, deps, { graceMs: 500, stepMs: 100 })).rejects.toBeInstanceOf(
      LockBusyError,
    );
    // 只发过 SIGTERM，一次
    expect(signals).toEqual([[555, "SIGTERM"]]);
    expect(readHolder(path)).toBe(555);
  });

  it("持有者其实早就死了 → 不发任何信号，直接接手", async () => {
    const path = tmpLock();
    writeFileSync(path, "555\n");
    const { deps, signals } = fakeWorld(new Set([100]), 100);
    const got = await acquireForRun(path, deps, { graceMs: 500, stepMs: 100 });
    expect(signals).toEqual([]);
    expect(got.tookOverFrom).toBe(null);
  });
});

describe("lock / 与状态库同目录", () => {
  it("目录不存在也能建锁", () => {
    const d = mkdtempSync(join(tmpdir(), "ua-lock-"));
    dirs.push(d);
    const path = join(d, "nested", "deeper", "state.db.lock");
    const { deps } = fakeWorld(new Set([100]), 100);
    expect(tryAcquire(path, deps).ok).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe("100");
  });
});
