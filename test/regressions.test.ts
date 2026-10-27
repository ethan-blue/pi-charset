import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync, existsSync, chmodSync, statSync, symlinkSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeWriteOperations, makeReadOperations, makeEditOperations, clearReadBaselines, atomicReplace } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { canEncodeAll, escapeUnmappable, unmappableChars } from "../src/encoding/converter";
import { normalizePathKey } from "../src/path-key";
import { createOutputTranscoder } from "../src/encoding/stream-transcode";
import { findRg, searchFiles } from "../src/grep";
import { putConfig } from "./helpers/tree";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(process.cwd(), ".charset-regression-"));
  clearConfigCache(); clearClassifyCache(); clearReadBaselines();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const content = "int a = b ? c : d; // 中文 😀\n";

describe("encoding safety regressions", () => {
  it("escapes only unsupported characters in an actual GBK write", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", unmappable: "escape" });
    const p = join(root, "a.c");
    writeFileSync(p, iconv.encode("// 原文\r\n", "GBK"));
    await makeWriteOperations().writeFile(p, content);
    expect(iconv.decode(readFileSync(p), "GBK")).toBe("int a = b ? c : d; // 中文 \\ud83d\\ude00\r\n");
  });
  it("rejects unsupported GBK characters without changing disk bytes", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "a.c"), original = iconv.encode("// 原文\r\n", "GBK");
    writeFileSync(p, original);
    await expect(makeWriteOperations().writeFile(p, content)).rejects.toThrow();
    expect(readFileSync(p)).toEqual(original);
  });
  it("does not confuse question-mark bytes with encoding loss", () => {
    expect(escapeUnmappable("? 中文 😀", "GBK")).toBe("? 中文 \\ud83d\\ude00");
    expect(canEncodeAll("丿?\ufeff", "UTF-16LE")).toBe(true);
    expect(unmappableChars("丿?", "UTF-16LE")).toEqual([]);
    expect(canEncodeAll("\ufeff中文", "UTF-8")).toBe(true);
    expect(canEncodeAll("\ud800", "UTF-8")).toBe(false);
  });
  it.each([false, true])("preserves existing UTF-8 CRLF (BOM=%s)", async (bom) => {
    putConfig(root, { sourceEncoding: "UTF-8" });
    const p = join(root, "a.txt");
    writeFileSync(p, `${bom ? "\ufeff" : ""}中文\r\n第二行\r\n`);
    await makeWriteOperations().writeFile(p, "修改\n第二行\n");
    expect(readFileSync(p).toString("utf8")).toBe(`${bom ? "\ufeff" : ""}修改\r\n第二行\r\n`);
  });
  it("honors CRLF for a newly created UTF-8 file", async () => {
    putConfig(root, { sourceEncoding: "UTF-8", newFileLineEnding: "CRLF" });
    const p = join(root, "new.txt");
    await makeWriteOperations().writeFile(p, "中文\n下一行\n");
    expect(readFileSync(p).toString("utf8")).toBe("中文\r\n下一行\r\n");
  });
  it("rejects mixed UTF-8 line endings in edit and write", async () => {
    putConfig(root, { sourceEncoding: "UTF-8" });
    const p = join(root, "mixed.txt"), original = Buffer.from("中文\r\n第二行\n");
    writeFileSync(p, original);
    await expect(makeEditOperations().readFile(p)).rejects.toThrow(/混合换行/);
    await expect(makeWriteOperations().writeFile(p, "修改\n")).rejects.toThrow(/混合换行/);
    expect(readFileSync(p)).toEqual(original);
  });
  it.each(["UTF-16LE", "UTF-16BE"])("preserves %s BOM and CRLF without false newline detection", async (enc) => {
    putConfig(root, { sourceEncoding: "GBK" });
    const p = join(root, "wide.txt"), bom = Buffer.from(enc === "UTF-16LE" ? [255, 254] : [254, 255]);
    const text = "中文 Ċč਍\r\n第二行\r\n";
    writeFileSync(p, Buffer.concat([bom, iconv.encode(text, enc)]));
    await makeReadOperations().readFile(p);
    await makeWriteOperations().writeFile(p, text.replace("中文", "修改").replace(/\r\n/g, "\n"));
    expect(readFileSync(p)).toEqual(Buffer.concat([bom, iconv.encode(text.replace("中文", "修改"), enc)]));
  });
  it("does not resurrect a file externally deleted after read", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const p = join(root, "gone.c");
    writeFileSync(p, iconv.encode("// 原文\r\n", "GBK"));
    await makeReadOperations().readFile(p); unlinkSync(p);
    await expect(makeWriteOperations().writeFile(p, "// 修改\n")).rejects.toThrow(/删除/);
    expect(existsSync(p)).toBe(false);
  });
  it("cleans temporary files and preserves external edits on pre-rename conflict", async () => {
    const p = join(root, "conflict.txt");
    writeFileSync(p, "external change");
    await expect(atomicReplace(p, Buffer.from("replacement"), Buffer.from("old content"))).rejects.toThrow(/外部进程/);
    expect(readFileSync(p, "utf8")).toBe("external change");
    expect(readdirSync(root).filter(name => name.endsWith(".pi-charset.tmp"))).toEqual([]);
  });
  it("uses platform-specific path identity", () => {
    expect(normalizePathKey(join(root, "Foo.c"), "win32")).toBe(normalizePathKey(join(root, "foo.c"), "win32"));
    expect(normalizePathKey(join(root, "Foo.c"), "linux")).not.toBe(normalizePathKey(join(root, "foo.c"), "linux"));
  });
  it("passes bytes through when the requested shell encoding is unsupported", () => {
    const t = createOutputTranscoder({ candidates: [], fallbackEncoding: "not-a-real-charset", preferredEncoding: "not-a-real-charset" });
    const bytes = Buffer.from([0x80, 0xff, 0x81]);
    const out = Buffer.concat([t.push(bytes), t.finish()]);
    expect(out).toEqual(bytes);
    expect(t.stats().basis).toContain("不受支持");
  });
  it.skipIf(process.platform === "win32")("retains executable mode", async () => {
    putConfig(root, { sourceEncoding: "UTF-8" });
    const p = join(root, "run.sh"); writeFileSync(p, "#!/bin/sh\necho old\n"); chmodSync(p, 0o751);
    await makeWriteOperations().writeFile(p, "#!/bin/sh\necho new\n");
    expect(statSync(p).mode & 0o777).toBe(0o751);
  });
  it.skipIf(process.platform === "win32")("rejects symlinks without replacing them or their targets", async () => {
    putConfig(root, { sourceEncoding: "UTF-8" });
    const p = join(root, "target.txt"), link = join(root, "link.txt"); writeFileSync(p, "中文\n"); symlinkSync(p, link);
    await expect(makeWriteOperations().writeFile(link, "修改\n")).rejects.toThrow(/symlink/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true); expect(readFileSync(p, "utf8")).toBe("中文\n");
  });
  it.skipIf(!findRg())("supports Rust inline flags and Unicode regex across GBK and UTF-8", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    writeFileSync(join(root, "gb.c"), iconv.encode("// NEEDLE 中文\n", "GBK"));
    writeFileSync(join(root, "utf.c"), "// NEEDLE 中文\n");
    for (const pattern of ["(?i)needle", "\\p{Han}+"]) {
      const result = await searchFiles(root, { pattern, path: "." });
      expect(result?.text).toContain("gb.c"); expect(result?.text).toContain("utf.c");
      expect(result?.text).not.toContain("�");
    }
  });
});
