/**
 * 探针的单实例锁。
 *
 * ★ 为什么需要：state.db 是 node:sqlite 打开的普通 SQLite 文件。两个探针同时跑
 *   时后来者的写会撞上 `SQLITE_BUSY`，而 node:sqlite 把它抛成未捕获异常 ——
 *   进程**当场崩**，不是退避重试。2026-09-22 实测：菜单栏重启后老探针被 launchd
 *   收养成孤儿仍占着库，新探针起来 23 秒就死，监管方重试一次之后彻底沉默，
 *   额度采集从此停摆。锁要解决的是「谁是唯一的写者」这件事本身。
 *
 * 语义（`run` 子命令）：**后来者接管**。新探针启动意味着用户/监管方要的是它；
 * 老的那个不是孤儿就是重复实例。给老的发 SIGTERM，它会把队列冲刷干净再退
 * （队列本来就落盘，任何时刻硬杀也不丢数据），然后新的接手。
 * 反过来「后来者退让」会让孤儿永久霸占，正是这次故障的形态。
 *
 * `backfill` 不接管：它是一次性任务，抢掉常驻探针得不偿失，直接拒绝更清楚。
 *
 * 锁文件里只有一个 pid。pid 复用理论上存在（老进程死了、号被别人占了），
 * 代价是误发一个 SIGTERM；相比「两个探针互相踩库」这是可接受的折中。
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LockDeps {
  pid: number;
  /** signal=0 只探活。目标不存在抛 ESRCH，存在但无权限抛 EPERM。 */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
}

export const defaultLockDeps: LockDeps = {
  pid: process.pid,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface Acquired {
  ok: true;
  /** 接管来的那个 pid；不是接管则为 null */
  tookOverFrom: number | null;
  release: () => void;
}

export interface Busy {
  ok: false;
  holderPid: number;
}

export class LockBusyError extends Error {
  constructor(readonly holderPid: number) {
    super(`另一个 ua-probe（pid ${holderPid}）正占着状态库，且在宽限期内没有退出`);
    this.name = "LockBusyError";
  }
}

/** 锁文件路径：紧挨着状态库放，一眼能看出它们是一对。 */
export function lockPathFor(stateDb: string): string {
  return `${stateDb}.lock`;
}

export function readHolder(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

export function pidAlive(pid: number, kill: LockDeps["kill"]): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程在，只是不归我们管 —— 仍然算活着
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 试一次。拿到返回 ok，被别的活进程占着返回 holderPid。
 * 锁文件残留（持有者已死、内容损坏）会被清掉后重试一次。
 */
export function tryAcquire(path: string, deps: LockDeps = defaultLockDeps): Acquired | Busy {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" = O_CREAT|O_EXCL：创建与判存在是一个原子动作，没有检查-再创建的窗口
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, `${deps.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return { ok: true, tookOverFrom: null, release: () => releaseIfOurs(path, deps.pid) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = readHolder(path);
    if (holder !== null && holder !== deps.pid && pidAlive(holder, deps.kill)) {
      return { ok: false, holderPid: holder };
    }
    // 陈旧锁：持有者已经不在了（或文件是坏的）。清掉再试。
    try {
      unlinkSync(path);
    } catch {
      /* 并发下可能被别人先清了，无所谓 */
    }
  }
  return { ok: false, holderPid: readHolder(path) ?? 0 };
}

/** 只删属于自己的锁，避免把接管者的锁误删。 */
export function releaseIfOurs(path: string, pid: number): void {
  if (readHolder(path) !== pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* 已经没了就算了 */
  }
}

/**
 * `run` 用：拿不到就接管。
 *
 * 先 SIGTERM 让老实例走正常退出路径（冲刷队列、关库），在宽限期内轮询重试；
 * 超时说明对方卡死了 —— 这时**不**升级成 SIGKILL：一个卡住的写者可能正握着
 * SQLite 的写锁，硬杀留下的热日志要新实例去恢复，不如把情况报上去让人看见。
 */
export async function acquireForRun(
  path: string,
  deps: LockDeps = defaultLockDeps,
  opts: { graceMs?: number; stepMs?: number } = {},
): Promise<Acquired> {
  const graceMs = opts.graceMs ?? 10_000;
  const stepMs = opts.stepMs ?? 200;

  const first = tryAcquire(path, deps);
  if (first.ok) return first;

  const victim = first.holderPid;
  try {
    deps.kill(victim, "SIGTERM");
  } catch {
    /* 刚好在这一瞬间自己死了，下一轮 tryAcquire 会捡到陈旧锁 */
  }

  for (let waited = 0; waited < graceMs; waited += stepMs) {
    await deps.sleep(stepMs);
    const retry = tryAcquire(path, deps);
    if (retry.ok) return { ...retry, tookOverFrom: victim };
  }
  throw new LockBusyError(victim);
}
