import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { createEditToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeReadOperations, makeWriteOperations, makeEditOperations, clearReadBaselines } from "../src/operations";
import { wrapEditToolWithEncodingPreview, clearUtf8Cache } from "../src/edit-preview";
import { clearConfigCache } from "../src/config";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG = Buffer.from(TINY_PNG_BASE64, "base64");

let root: string;
function putConfig(dir: string) {
  writeFileSync(join(dir, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
}
beforeEach(() => {
  clearConfigCache();
  clearUtf8Cache();
  clearReadBaselines();
  root = mkdtempSync(join(tmpdir(), "ops-"));
});

describe("read operations", () => {
  it("passthrough: no config returns raw bytes unchanged", async () => {
    const f = join(root, "a.txt");
    const raw = Buffer.from("hello\n", "utf-8");
    writeFileSync(f, raw);
    const ops = makeReadOperations();
    const out = await ops.readFile(f);
    expect(out.equals(raw)).toBe(true);
  });

  it("with GB config: returns UTF-8 buffer that decodes to correct Chinese", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "cn.txt");
    writeFileSync(f, iconv.encode("你好世界", "GB18030"));
    const ops = makeReadOperations();
    const out = await ops.readFile(f);
    expect(out.toString("utf-8")).toBe("你好世界");
  });

  it("exposes detectImageMimeType so Pi can take the image branch", async () => {
    const f = join(root, "dot.png");
    writeFileSync(f, TINY_PNG);
    const ops = makeReadOperations();
    expect(typeof ops.detectImageMimeType).toBe("function");
    await expect(ops.detectImageMimeType!(f)).resolves.toBe("image/png");
  });

  it("detectImageMimeType returns null for plain text", async () => {
    const f = join(root, "a.txt");
    writeFileSync(f, "hello\n", "utf-8");
    const ops = makeReadOperations();
    await expect(ops.detectImageMimeType!(f)).resolves.toBeNull();
  });

  it("with GB config: PNG bytes are returned unchanged", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "dot.png");
    writeFileSync(f, TINY_PNG);
    const ops = makeReadOperations();
    const out = await ops.readFile(f);
    expect(out.equals(TINY_PNG)).toBe(true);
  });

  it("read tool returns an image content block for PNG", async () => {
    const f = join(root, "dot.png");
    writeFileSync(f, TINY_PNG);
    const def = createReadToolDefinition(root, { operations: makeReadOperations() });
    const result = await def.execute(
      "call-img",
      { path: f },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    const text = result.content.find((c) => c.type === "text");
    expect(text?.type === "text" ? text.text : "").toContain("Read image file");
  });
});

describe("write operations", () => {
  it("passthrough: no config writes UTF-8", async () => {
    const f = join(root, "a.txt");
    const ops = makeWriteOperations();
    await ops.writeFile(f, "hello世界");
    expect(readFileSync(f).toString("utf-8")).toBe("hello世界");
  });

  it("with GB config: new file written as GB18030 bytes", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "cn.txt");
    const ops = makeWriteOperations();
    await ops.writeFile(f, "你好世界");
    const bytes = readFileSync(f);
    expect(bytes.equals(iconv.encode("你好世界", "GB18030"))).toBe(true);
    expect(bytes.equals(Buffer.from("你好世界", "utf-8"))).toBe(false);
  });

  it("preserves CRLF line endings of existing GB file on rewrite", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "cn.txt");
    writeFileSync(f, iconv.encode("a中\r\nb文\r\n", "GB18030"));
    const ops = makeWriteOperations();
    await ops.writeFile(f, "a中\nb文\n");
    const decoded = iconv.decode(readFileSync(f), "GB18030");
    expect(decoded).toBe("a中\r\nb文\r\n");
  });
});

describe("edit operations", () => {
  it("exposes readFile, writeFile and access", () => {
    const ops = makeEditOperations();
    expect(typeof ops.readFile).toBe("function");
    expect(typeof ops.writeFile).toBe("function");
    expect(typeof ops.access).toBe("function");
  });

  it("edits a GB18030 file and writes it back as GB18030", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "code.py");
    writeFileSync(f, iconv.encode("# 旧的注释\nx = 1\n", "GB18030"));
    const ops = makeEditOperations();

    const utf8 = (await ops.readFile(f)).toString("utf-8");
    expect(utf8).toBe("# 旧的注释\nx = 1\n");
    const edited = utf8.replace("旧的注释", "新的中文注释");
    await ops.writeFile(f, edited);

    const bytes = readFileSync(f);
    expect(iconv.decode(bytes, "GB18030")).toBe("# 新的中文注释\nx = 1\n");
    expect(bytes.equals(Buffer.from("# 新的中文注释\nx = 1\n", "utf-8"))).toBe(false);
  });

  it("preserves CRLF line endings through an edit round-trip", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "crlf.py");
    writeFileSync(f, iconv.encode("第一行\r\n第二行\r\n", "GB18030"));
    const ops = makeEditOperations();

    const utf8 = (await ops.readFile(f)).toString("utf-8");
    const edited = utf8.replace("第二行", "改后的第二行");
    await ops.writeFile(f, edited);

    const decoded = iconv.decode(readFileSync(f), "GB18030");
    expect(decoded).toBe("第一行\r\n改后的第二行\r\n");
  });

  it("passthrough: edits a UTF-8 file (no config) staying UTF-8", async () => {
    const f = join(root, "plain.txt");
    writeFileSync(f, "hello 世界\n", "utf-8");
    const ops = makeEditOperations();

    const utf8 = (await ops.readFile(f)).toString("utf-8");
    expect(utf8).toBe("hello 世界\n");
    await ops.writeFile(f, utf8.replace("世界", "world"));

    expect(readFileSync(f).toString("utf-8")).toBe("hello world\n");
  });
});

describe("integration: wrapped edit tool", () => {
  it("execute() via the wrapped def edits a GB18030 file and returns diff", async () => {
    putConfig(root);
    const f = join(root, "wrapped.py");
    writeFileSync(f, iconv.encode("# 旧的注释\nx = 1\n", "GB18030"));

    const baseDef = createEditToolDefinition(root, { operations: makeEditOperations() });
    const def = wrapEditToolWithEncodingPreview(baseDef, makeEditOperations(), root);
    const res = await def.execute(
      "call-x",
      { path: f, edits: [{ oldText: "旧的注释", newText: "新的中文注释" }] },
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(iconv.decode(readFileSync(f), "GB18030")).toBe("# 新的中文注释\nx = 1\n");
    const diffText = res.details?.diff as string | undefined;
    expect(diffText).toBeDefined();
    expect(diffText).toContain("新的中文注释");
    expect(diffText).toContain("旧的注释");
  });
});

describe("混合换行拦截", () => {
  const gbkCfg = (dir: string) =>
    writeFileSync(join(dir, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK" }));

  it("write 拒绝混合换行的 GBK 文件且磁盘字节不变", async () => {
    gbkCfg(root);
    const f = join(root, "mix.c");
    const original = iconv.encode("/* 中文 */\r\nint a;\n", "GBK");
    writeFileSync(f, original);
    await expect(makeWriteOperations().writeFile(f, "/* 中文 */\r\nint a;\r\nint b;\n")).rejects.toThrow(/混合换行/);
    expect(readFileSync(f).equals(original)).toBe(true);
  });

  it("edit 在 readFile 阶段拒绝混合换行文件，read 工具仍可正常读取", async () => {
    gbkCfg(root);
    const f = join(root, "mix2.c");
    writeFileSync(f, iconv.encode("/* 中文 */\r\nint a;\n", "GBK"));
    const editOps = makeEditOperations();
    await expect(editOps.readFile(f)).rejects.toThrow(/混合换行/);
    const out = await makeReadOperations().readFile(f);
    expect(out.toString("utf-8")).toBe("/* 中文 */\r\nint a;\n");
  });
});

describe("newFileLineEnding 新建文件行尾配置", () => {
  const cfg = (dir: string, extra: Record<string, unknown>) =>
    writeFileSync(join(dir, ".pi-charset.json"), JSON.stringify(extra));

  it("新建文件按 override 的 CRLF 写出 GBK", async () => {
    cfg(root, {
      sourceEncoding: "UTF-8",
      overrides: [{ pattern: "src/**/*.c", encoding: "GBK", writeEncoding: "GBK", newFileLineEnding: "CRLF" }],
    });
    const f = join(root, "src", "new.c");
    mkdirSync(join(root, "src"), { recursive: true });
    await makeWriteOperations().writeFile(f, "int a;\nint b;\n");
    const bytes = readFileSync(f);
    expect(iconv.decode(bytes, "GBK")).toBe("int a;\r\nint b;\r\n");
    expect(bytes.includes(0x0d)).toBe(true);
  });

  it("未配置 newFileLineEnding 时新建文件保持输入行尾", async () => {
    cfg(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const f = join(root, "plain.c");
    await makeWriteOperations().writeFile(f, "int a;\n");
    expect(iconv.decode(readFileSync(f), "GBK")).toBe("int a;\n");
  });

  it("已存在 LF 文件按磁盘原行尾保留 LF", async () => {
    cfg(root, { sourceEncoding: "GBK", writeEncoding: "GBK", newFileLineEnding: "CRLF" });
    const f = join(root, "keep.c");
    writeFileSync(f, iconv.encode("int a;\n", "GBK"));
    await makeWriteOperations().writeFile(f, "int a;\nint b;\n");
    expect(iconv.decode(readFileSync(f), "GBK")).toBe("int a;\nint b;\n");
  });

  it("无末尾换行的内容不追加换行", async () => {
    cfg(root, { sourceEncoding: "GBK", writeEncoding: "GBK", newFileLineEnding: "CRLF" });
    const f = join(root, "tail.c");
    await makeWriteOperations().writeFile(f, "int a;");
    expect(iconv.decode(readFileSync(f), "GBK")).toBe("int a;");
  });

  it("override 优先于根配置；非法值忽略并记录告警", async () => {
    cfg(root, {
      sourceEncoding: "GBK",
      writeEncoding: "GBK",
      newFileLineEnding: "CRLF",
      overrides: [{ pattern: "*.h", encoding: "GBK", writeEncoding: "GBK", newFileLineEnding: "LF" }],
    });
    await makeWriteOperations().writeFile(join(root, "a.h"), "int b;\n");
    await makeWriteOperations().writeFile(join(root, "a.c"), "int a;\n");
    expect(iconv.decode(readFileSync(join(root, "a.h")), "GBK")).toBe("int b;\n");
    expect(iconv.decode(readFileSync(join(root, "a.c")), "GBK")).toBe("int a;\r\n");

    const bad = join(root, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK", newFileLineEnding: "CR" }));
    await makeWriteOperations().writeFile(join(bad, "n.c"), "int c;\n");
    expect(iconv.decode(readFileSync(join(bad, "n.c")), "GBK")).toBe("int c;\n");
  });
});

describe("读取基线 SHA-1 冲突检测", () => {
  it("read 之后文件被外部改写则 write 报冲突，重新 read 后允许写入", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK" }));
    const f = join(root, "base.c");
    writeFileSync(f, iconv.encode("/* v1 */\r\n", "GBK"));
    const rd = makeReadOperations();
    const wr = makeWriteOperations();
    expect((await rd.readFile(f)).toString("utf-8")).toBe("/* v1 */\r\n");

    writeFileSync(f, iconv.encode("/* 外部 v2 */\r\n", "GBK"));
    await expect(wr.writeFile(f, "/* v1 改 */\r\n")).rejects.toThrow(/外部修改|不一致/);
    expect(iconv.decode(readFileSync(f), "GBK")).toBe("/* 外部 v2 */\r\n");

    expect((await rd.readFile(f)).toString("utf-8")).toBe("/* 外部 v2 */\r\n");
    await wr.writeFile(f, "/* 外部 v2 改 */\r\n");
    expect(iconv.decode(readFileSync(f), "GBK")).toBe("/* 外部 v2 改 */\r\n");
  });

  it("未先调用 read 的直接 write 正常写入", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK" }));
    const f = join(root, "direct.c");
    writeFileSync(f, iconv.encode("/* v1 */\r\n", "GBK"));
    await makeWriteOperations().writeFile(f, "/* v2 */\r\n");
    expect(iconv.decode(readFileSync(f), "GBK")).toBe("/* v2 */\r\n");
  });
});
