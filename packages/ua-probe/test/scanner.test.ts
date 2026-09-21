import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readNewLines, walkScanRoots } from "../src/scanner.js";
import { ProbeStore } from "../src/store.js";
import { cleanup, tmpDir } from "./helpers.js";

describe("scanner / 断点续传", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = tmpDir();
    file = join(dir, "s.jsonl");
  });
  afterEach(() => cleanup(dir));

  function cursorFor(path: string, offset: number) {
    const st = statSync(path);
    return { path, inode: String(st.ino), size: st.size, offset, mtime: Math.floor(st.mtimeMs) };
  }

  it("首次读全量，二次读只拿新增的行", async () => {
    writeFileSync(file, "a\nb\n");
    const seen1: string[] = [];
    const r1 = await readNewLines(file, null, (l) => seen1.push(l));
    expect(seen1).toEqual(["a", "b"]);
    expect(r1.reset).toBe("new");
    expect(r1.cursor.offset).toBe(4);

    appendFileSync(file, "c\n");
    const seen2: string[] = [];
    const r2 = await readNewLines(file, r1.cursor, (l) => seen2.push(l));
    expect(seen2).toEqual(["c"]);
    expect(r2.reset).toBeNull();
    expect(r2.cursor.offset).toBe(6);
  });

  it("没有新内容时不重复产出", async () => {
    writeFileSync(file, "a\n");
    const r1 = await readNewLines(file, null, () => undefined);
    const seen: string[] = [];
    const r2 = await readNewLines(file, r1.cursor, (l) => seen.push(l));
    expect(seen).toEqual([]);
    expect(r2.cursor.offset).toBe(r1.cursor.offset);
  });

  it("半行（正在写入的 JSON）不消费，补全后才产出完整的一行", async () => {
    writeFileSync(file, '{"a":1}\n{"b":');
    const seen1: string[] = [];
    const r1 = await readNewLines(file, null, (l) => seen1.push(l));
    expect(seen1).toEqual(['{"a":1}']);
    expect(r1.cursor.offset).toBe(8); // 半行留在下一轮

    appendFileSync(file, "2}\n");
    const seen2: string[] = [];
    await readNewLines(file, r1.cursor, (l) => seen2.push(l));
    expect(seen2).toEqual(['{"b":2}']);
  });

  it("size < offset（被截断）→ 从头重读", async () => {
    writeFileSync(file, "a\nb\nc\n");
    const stale = cursorFor(file, 6);
    writeFileSync(file, "x\n");
    const seen: string[] = [];
    const r = await readNewLines(file, { ...stale, inode: String(statSync(file).ino) }, (l) => seen.push(l));
    expect(r.reset).toBe("truncated");
    expect(seen).toEqual(["x"]);
  });

  it("inode 变了（文件被重建）→ 从头重读", async () => {
    writeFileSync(file, "a\nb\n");
    const c = cursorFor(file, 4);
    const other = join(dir, "other.jsonl");
    writeFileSync(other, "a\nb\nz\n");
    unlinkSync(file);
    renameSync(other, file);

    const seen: string[] = [];
    const r = await readNewLines(file, c, (l) => seen.push(l));
    expect(r.reset).toBe("inode-changed");
    expect(seen).toEqual(["a", "b", "z"]);
  });

  it("UTF-8 多字节跨 chunk 边界不乱码", async () => {
    const big = "宽".repeat(100_000);
    writeFileSync(file, `${big}\n第二行\n`);
    const seen: string[] = [];
    await readNewLines(file, null, (l) => seen.push(l));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(big);
    expect(seen[1]).toBe("第二行");
  });

  it("游标存回 SQLite 后能跨进程续上", async () => {
    const store = new ProbeStore(":memory:");
    writeFileSync(file, "a\n");
    const r1 = await readNewLines(file, null, () => undefined);
    store.putCursor(r1.cursor);

    appendFileSync(file, "b\n");
    const seen: string[] = [];
    await readNewLines(file, store.getCursor(file), (l) => seen.push(l));
    expect(seen).toEqual(["b"]);
    store.close();
  });

  it("walkScanRoots 支持多个根目录，跳过不存在的（套壳客户端路径可能还没建）", async () => {
    const a = join(dir, "roota", "proj");
    const b = join(dir, "rootb");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "x.jsonl"), "");
    writeFileSync(join(b, "y.jsonl"), "");
    writeFileSync(join(b, "ignore.txt"), "");

    const files = await walkScanRoots([join(dir, "roota"), b, join(dir, "missing")]);
    expect(files).toEqual([join(a, "x.jsonl"), join(b, "y.jsonl")].sort());
  });
});
