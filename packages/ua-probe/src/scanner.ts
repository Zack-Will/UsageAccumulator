import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileCursor } from "./store.js";

export interface ReadOutcome {
  cursor: FileCursor;
  /** 本次读到的完整行数 */
  lines: number;
  /** 游标被重置的原因，null 表示正常增量 */
  reset: "new" | "inode-changed" | "truncated" | null;
}

/** 遍历 scan_roots，收集所有 .jsonl。不存在的根目录跳过而不是报错。 */
export async function walkScanRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    try {
      const st = await stat(root);
      if (st.isFile()) {
        if (root.endsWith(".jsonl")) out.push(root);
        continue;
      }
      if (!st.isDirectory()) continue;
    } catch {
      continue; // 根目录不存在：套壳客户端可能还没创建，跳过
    }
    await walkDir(root, out);
  }
  return out.sort();
}

async function walkDir(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkDir(p, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

/**
 * 断点续传的增量读取（ARCHITECTURE §5.1）。
 *
 *   inode 变了     → 文件被重建，从 0 重读
 *   size < offset  → 被截断，从 0 重读
 *   size > offset  → 从 offset 读到 EOF
 *
 * 只在读到完整的一行（以 \n 结尾）之后才推进 offset ——
 * Claude Code 正在写入的半行必须留到下一轮，否则会把 JSON 截断成垃圾。
 */
export async function readNewLines(
  path: string,
  prev: FileCursor | null,
  onLine: (raw: string) => void,
): Promise<ReadOutcome> {
  const st = await stat(path);
  const inode = String(st.ino);
  const size = st.size;
  const mtime = Math.floor(st.mtimeMs);

  let start = 0;
  let reset: ReadOutcome["reset"] = "new";
  if (prev) {
    if (prev.inode !== inode) {
      reset = "inode-changed";
    } else if (size < prev.offset) {
      reset = "truncated";
    } else {
      start = prev.offset;
      reset = null;
    }
  }

  if (start >= size) {
    return { cursor: { path, inode, size, offset: start, mtime }, lines: 0, reset };
  }

  let consumed = 0;
  let lines = 0;
  let leftover: Buffer = Buffer.alloc(0);

  const stream = createReadStream(path, { start });
  for await (const chunk of stream) {
    let buf = leftover.length ? Buffer.concat([leftover, chunk as Buffer]) : (chunk as Buffer);
    let idx: number;
    let from = 0;
    while ((idx = buf.indexOf(0x0a, from)) !== -1) {
      const lineBuf = buf.subarray(from, idx);
      consumed += idx - from + 1;
      from = idx + 1;
      lines++;
      const raw = lineBuf.toString("utf8").replace(/\r$/, "");
      if (raw) onLine(raw);
    }
    leftover = from === 0 ? buf : Buffer.from(buf.subarray(from));
    buf = Buffer.alloc(0);
  }

  return {
    cursor: { path, inode, size, offset: start + consumed, mtime },
    lines,
    reset,
  };
}
