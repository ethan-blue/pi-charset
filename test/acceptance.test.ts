// End-to-end acceptance tests exercising real tool definitions with full-tree SHA-256 verification.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { makeReadOperations, makeWriteOperations, makeEditOperations, clearReadBaselines } from "../src/operations";
import { createEncodingGrepDefinition } from "../src/grep";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { clearEncodingNotes, drainEncodingNotes } from "../src/notify";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let root: string;
let files: Record<string, string>;
let before: Record<string, string>;

const readTool = () => createReadToolDefinition(process.cwd(), { operations: makeReadOperations() });
const editTool = () => createEditToolDefinition(process.cwd(), { operations: makeEditOperations() });
const writeTool = () => createWriteToolDefinition(process.cwd(), { operations: makeWriteOperations() });
const grepTool = () => createEncodingGrepDefinition(process.cwd());

interface ExecResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
  details?: { diff?: string };
}
const exec = (
  tool: { execute: (...args: any[]) => Promise<any> },
  id: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ExecResult> => tool.execute(id, input, signal, undefined, undefined);
const textOf = (r: ExecResult) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(files)) out[k] = sha256(readFileSync(p));
  return out;
}

beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
  clearReadBaselines();
  root = mkdtempSync(join(tmpdir(), "charset-acc-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "中文目录"), { recursive: true });
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  writeFileSync(
    join(root, ".pi-charset.json"),
    JSON.stringify({
      sourceEncoding: "UTF-8",
      writeEncoding: "UTF-8",
      unmappable: "error",
      verifyWrite: true,
      protectUtf8: true,
      overrides: [
        { pattern: "src/**/*.c", encoding: "GBK", writeEncoding: "GBK", newFileLineEnding: "CRLF" },
        { pattern: "src/**/*.h", encoding: "GBK", writeEncoding: "GBK", newFileLineEnding: "CRLF" },
      ],
    }),
  );
  const put = (rel: string, buf: Buffer) => {
    const abs = join(root, ...rel.split("/"));
    writeFileSync(abs, buf);
    files[rel] = abs;
  };
  files = {};
  put("src/gbk注释.c", iconv.encode("/* GBK 中文注释 */\r\nint order = 85.5;\r\n", "gbk"));
  put("src/gbk头.h", iconv.encode("/* 头文件 说明 */\r\n#define FLAG 1\r\n", "gbk"));
  put("src/utf8源.c", Buffer.from("/* UTF-8 中文 */\nint x = 1;\n", "utf-8"));
  put("src/utf8bom.c", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("/* BOM 文件 */\r\nint y;\r\n", "utf-8")]));
  put("src/ascii.c", Buffer.from("/* ascii only */\r\nint z = 2;\r\n", "ascii"));
  put("src/lf.c", iconv.encode("/* LF 文件 */\nint lf = 3;\n", "gbk"));
  put("src/notail.c", iconv.encode("/* 无末尾换行 */\r\nint nt = 4;", "gbk"));
  put("src/mixed.c", iconv.encode("/* 混合 */\r\nint mx = 5;\n", "gbk"));
  put("docs/说明.md", Buffer.from("# 文档 说明\n正文。\n", "utf-8"));
  put("中文目录/测试.c", iconv.encode("/* 路径含中文 */\r\nint cn = 6;\r\n", "gbk"));
  put("src/img.png", TINY_PNG);
  put(".git/objects/gbk注释.c.copy", iconv.encode("/* GBK 中文注释 */\r\nint order = 85.5;\r\n", "gbk"));
  before = snapshot();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("端到端验收矩阵", () => {
  it("A-01/A-02：GBK 读取与 edit 替换中文及数值，保持 GBK 与 CRLF", async () => {
    const p = files["src/gbk注释.c"]!;
    const r = await exec(readTool(), "r", { path: p });
    expect(textOf(r).includes("GBK 中文注释")).toBe(true);

    await expect(
      exec(editTool(), "e", {
        path: p,
        edits: [
          { oldText: "GBK 中文注释", newText: "GBK 中文注释（已改）" },
          { oldText: "int order = 85.5;", newText: "int order = 90.0;" },
        ],
      }),
    ).resolves.toBeTruthy();
    const text = iconv.decode(readFileSync(p), "gbk");
    expect(text).toBe("/* GBK 中文注释（已改） */\r\nint order = 90.0;\r\n");
    expect(readFileSync(p).includes(0x3f)).toBe(false);
    const after = snapshot();
    for (const [k, h] of Object.entries(before)) {
      if (k !== "src/gbk注释.c") expect(after[k]).toBe(h);
    }
  });

  it("A-04：UTF-8 BOM 文件编辑后保留单个 BOM", async () => {
    const p = files["src/utf8bom.c"]!;
    await expect(
      exec(editTool(), "e", { path: p, edits: [{ oldText: "int y;", newText: "int y = 1;" }] }),
    ).resolves.toBeTruthy();
    const bytes = readFileSync(p);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(bytes.indexOf(Buffer.from([0xef, 0xbb, 0xbf]), 3)).toBe(-1);
    expect(bytes.toString("utf-8")).toContain("BOM 文件");
  });

  it("A-05：纯 ASCII 源文件首次加入中文按 override 写为 GBK", async () => {
    const p = files["src/ascii.c"]!;
    await expect(
      exec(editTool(), "e", { path: p, edits: [{ oldText: "ascii only", newText: "ascii 加中文说明" }] }),
    ).resolves.toBeTruthy();
    const text = iconv.decode(readFileSync(p), "gbk");
    expect(text).toBe("/* ascii 加中文说明 */\r\nint z = 2;\r\n");
  });

  it("A-06：新建 .c/.h 写为 GBK+CRLF，新建文档写为 UTF-8", async () => {
    await expect(
      exec(writeTool(), "w", { path: join(root, "src", "new.h"), content: "int fresh = 1;\n" }),
    ).resolves.toBeTruthy();
    expect(iconv.decode(readFileSync(join(root, "src", "new.h")), "gbk")).toBe("int fresh = 1;\r\n");
    await expect(
      exec(writeTool(), "w", { path: join(root, "docs", "新.md"), content: "# 新文档\n" }),
    ).resolves.toBeTruthy();
    expect(readFileSync(join(root, "docs", "新.md")).toString("utf-8")).toBe("# 新文档\n");
  });

  it("A-07：无末尾换行的文件编辑后不追加换行", async () => {
    const p = files["src/notail.c"]!;
    await expect(
      exec(editTool(), "e", { path: p, edits: [{ oldText: "int nt = 4;", newText: "int nt = 40;" }] }),
    ).resolves.toBeTruthy();
    expect(iconv.decode(readFileSync(p), "gbk")).toBe("/* 无末尾换行 */\r\nint nt = 40;");
  });

  it("A-08：混合换行可读、edit/write 拒绝、字节不变；LF 文件保持 LF", async () => {
    const p = files["src/mixed.c"]!;
    const r = await exec(readTool(), "r", { path: p });
    expect(textOf(r).includes("int mx")).toBe(true);
    await expect(
      exec(editTool(), "e", { path: p, edits: [{ oldText: "int mx = 5;", newText: "int mx = 50;" }] }),
    ).rejects.toThrow(/混合换行/);
    expect(sha256(readFileSync(p))).toBe(before["src/mixed.c"]);

    const lf = files["src/lf.c"]!;
    await expect(
      exec(editTool(), "e", { path: lf, edits: [{ oldText: "int lf = 3;", newText: "int lf = 30;" }] }),
    ).resolves.toBeTruthy();
    expect(iconv.decode(readFileSync(lf), "gbk")).toBe("/* LF 文件 */\nint lf = 30;\n");
  });

  it("A-09：GBK 文件写入生僻字被闸门 1 拦截且字节不变", async () => {
    const p = files["src/gbk头.h"]!;
    await expect(
      exec(editTool(), "e", { path: p, edits: [{ oldText: "FLAG 1", newText: "FLAG 䶇" }] }),
    ).rejects.toThrow(/闸门 1/);
    expect(sha256(readFileSync(p))).toBe(before["src/gbk头.h"]);
  });

  it("A-11：图片走 read 图像分支，字节不变", async () => {
    const p = files["src/img.png"]!;
    const r = await exec(readTool(), "r", { path: p });
    expect(r.content!.some((c) => c.type === "image")).toBe(true);
    expect(sha256(readFileSync(p))).toBe(before["src/img.png"]);
  });

  it("A-12/A-13/A-14：中文搜索混合编码各命中一次，literal 与 glob 过滤生效，排除 .git 副本", async () => {
    const g = await exec(grepTool(), "g1", { pattern: "中文", path: root, glob: "*.c" });
    const text = (g.content ?? []).map((c) => c.text ?? "").join("\n");
    expect(text).toContain("gbk注释.c");
    expect(text).toContain("utf8源.c");
    expect(text).not.toContain(".git");

    const lit = await exec(grepTool(), "g2", { pattern: "int order", path: root, literal: true });
    const litText = (lit.content ?? []).map((c) => c.text ?? "").join("\n");
    expect(litText).toContain("gbk注释.c");
    expect(litText.split("gbk注释.c").length - 1).toBe(1);
  });

  it("A-15：配置文件 JSON 语法损坏时输出警告并按默认值保护受管源码", async () => {
    const sub = join(root, "broken");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".pi-charset.json"), '{ sourceEncoding: "GBK",, }');
    const p = join(sub, "managed.c");
    writeFileSync(p, iconv.encode("/* 旧注释 */\r\n", "gbk"));
    clearEncodingNotes();
    await expect(exec(writeTool(), "w", { path: p, content: "/* 新中文注释 */\r\n" })).resolves.toBeTruthy();
    const bytes = readFileSync(p);
    expect(iconv.decode(bytes, "gb18030")).toBe("/* 新中文注释 */\r\n");
    expect(bytes.equals(Buffer.from("/* 新中文注释 */\r\n", "utf-8"))).toBe(false);
    const notes = drainEncodingNotes(p);
    expect(notes.some((n) => n.includes("不是合法 JSON"))).toBe(true);
  });

  it("A-16：读取后被外部改写时拒写并保留外部内容", async () => {
    const p = files["中文目录/测试.c"]!;
    await exec(readTool(), "r", { path: p });
    const external = iconv.encode("/* 外部新内容 */\r\n", "gbk");
    writeFileSync(p, external);
    await expect(exec(writeTool(), "w", { path: p, content: "/* 覆盖尝试 */\r\n" })).rejects.toThrow(/外部修改/);
    expect(readFileSync(p).equals(external)).toBe(true);
  });

  it("A-18：只读文件写入报错且不残留临时文件", async () => {
    const p = files["src/gbk头.h"]!;
    chmodSync(p, 0o444);
    try {
      await expect(exec(writeTool(), "w", { path: p, content: "/* 尝试写入 */\r\n" })).rejects.toThrow(/EPERM|EACCES|失败/);
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(join(root, "src")).filter((f) => f.includes(".pi-charset.tmp"))).toEqual([]);
      expect(sha256(readFileSync(p))).toBe(before["src/gbk头.h"]);
    } finally {
      chmodSync(p, 0o666);
    }
  });
});
