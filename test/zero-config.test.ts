// Tests for zero-config self-adaptive read, write, edit, and same-directory sibling inference.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations, makeEditOperations } from "../src/operations";
import { clearEncodingNotes } from "../src/notify";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";

const dirs: string[] = [];
function tmp(prefix = "adaptive-"): string {
  const d = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
function put(dir: string, rel: string, data: string | Buffer): string {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}
const gbk = (t: string) => iconv.encode(t, "GBK");

beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("零配置自适应模式：已有文件读写", () => {
  it("无 .pi-charset.json 时读取 GBK 文件自动解码为 UTF-8，写入时自动保持 GBK 与原行尾", async () => {
    const d = tmp();
    const p = put(d, "A.c", gbk("/* 订单服务 */\r\nint a = 1;\r\n"));
    const r = makeReadOperations();
    const w = makeWriteOperations();

    const got = await r.readFile(p);
    expect(got.toString("utf-8")).toBe("/* 订单服务 */\r\nint a = 1;\r\n");

    await w.writeFile(p, "/* 订单服务（已改） */\nint a = 2;\n");
    const after = readFileSync(p);
    expect(after.equals(gbk("/* 订单服务（已改） */\r\nint a = 2;\r\n"))).toBe(true);
  });

  it("无 .pi-charset.json 时同一目录下 GBK 与 UTF-8 文件各自保持原编码与行尾", async () => {
    const d = tmp();
    const gbkFile = put(d, "motor.c", gbk("/* 电机控制 */\r\nint m = 1;\r\n"));
    const utf8File = put(d, "readme.md", "# 说明文档\n正文\n");
    const editOps = makeEditOperations();

    const gbkText = (await editOps.readFile(gbkFile)).toString("utf-8");
    await editOps.writeFile(gbkFile, gbkText.replace("电机控制", "电机位置控制"));
    expect(readFileSync(gbkFile).equals(gbk("/* 电机位置控制 */\r\nint m = 1;\r\n"))).toBe(true);

    const utf8Text = (await editOps.readFile(utf8File)).toString("utf-8");
    await editOps.writeFile(utf8File, utf8Text.replace("正文", "更新正文"));
    expect(readFileSync(utf8File).toString("utf-8")).toBe("# 说明文档\n更新正文\n");
  });

  it("无 .pi-charset.json 时同样启用三道写入门禁与混合换行保护", async () => {
    const d = tmp();
    const gbkFile = put(d, "rare.c", gbk("/* 普通注释 */\r\nint r = 1;\r\n"));
    const mixedFile = put(d, "mixed.c", gbk("/* 混合换行 */\r\nint m = 1;\n"));
    const w = makeWriteOperations();
    const e = makeEditOperations();

    await expect(w.writeFile(gbkFile, "/* 生僻字 䶇 */\r\nint r = 1;\r\n")).rejects.toThrow(/闸门 1/);
    await expect(e.readFile(mixedFile)).rejects.toThrow(/混合换行/);
  });
});

describe("零配置自适应模式：同目录邻居推断（新建文件与纯 ASCII 文件加中文）", () => {
  it("同目录存在 GBK+CRLF 的 .c/.h 文件时，新建 .c/.h 或给纯 ASCII .c 加中文自动采用 GBK+CRLF", async () => {
    const d = tmp();
    put(d, "existing1.c", gbk("/* 已有模块一 */\r\nint x = 1;\r\n"));
    put(d, "existing2.h", gbk("/* 已有头文件 */\r\n#define K 1\r\n"));
    const asciiFile = put(d, "ascii.c", "/* english only */\r\nint y = 2;\r\n");
    const newFile = path.join(d, "fresh.c");

    const w = makeWriteOperations();
    await w.writeFile(asciiFile, "/* 新增中文注释 */\nint y = 2;\n");
    expect(readFileSync(asciiFile).equals(gbk("/* 新增中文注释 */\r\nint y = 2;\r\n"))).toBe(true);

    await w.writeFile(newFile, "/* 新建源码文件 */\nint z = 3;\n");
    expect(readFileSync(newFile).equals(gbk("/* 新建源码文件 */\r\nint z = 3;\r\n"))).toBe(true);
  });

  it("空目录或纯 UTF-8 目录下新建文件与纯 ASCII 文件加中文默认采用 UTF-8", async () => {
    const d = tmp();
    const asciiFile = put(d, "ascii.c", "/* ascii */\nint a = 1;\n");
    const newFile = path.join(d, "new.c");

    const w = makeWriteOperations();
    await w.writeFile(asciiFile, "/* 中文 UTF-8 */\nint a = 1;\n");
    expect(readFileSync(asciiFile).equals(Buffer.from("/* 中文 UTF-8 */\nint a = 1;\n", "utf-8"))).toBe(true);

    await w.writeFile(newFile, "/* 新文件 UTF-8 */\n");
    expect(readFileSync(newFile).equals(Buffer.from("/* 新文件 UTF-8 */\n", "utf-8"))).toBe(true);
  });
});
