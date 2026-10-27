import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { putConfig, writeTree } from "./helpers/tree";
import { mixedEncodingProjectTree, JAVA_SRC, JAVA_SRC_UTF8 } from "./fixtures/build";

const isUtf8 = (b: Buffer): boolean => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

describe("UTF-8 文件保护", () => {
  let root: string;
  beforeEach(() => {
    clearConfigCache();
    clearClassifyCache();
    root = mkdtempSync(join(tmpdir(), "protect-"));
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
  });

  it("GBK 配置目录下编辑 UTF-8 文件后仍保持合法 UTF-8", async () => {
    const p = join(root, "Mixed.java");
    const original = Buffer.from(JAVA_SRC_UTF8, "utf-8");
    writeFileSync(p, original);

    const r = makeReadOperations();
    const w = makeWriteOperations();
    const text = (await r.readFile(p)).toString("utf-8");
    expect(text).toContain("报警阈值=85.5");
    await w.writeFile(p, text.replace("=85.5", "=90.0"));

    const after = readFileSync(p);
    expect(isUtf8(after)).toBe(true);
    expect(after.toString("utf-8")).not.toContain("\ufffd\ufffd");
    expect(after.length).toBeLessThan(original.length + 60);
    expect(after.toString("utf-8")).toContain("温控器A");
    expect(after.toString("utf-8")).toContain("=90.0");
    expect(Buffer.compare(after, iconv.encode(after.toString("utf-8"), "GBK"))).not.toBe(0);
  });

  it("同一目录内 GBK 文件与 UTF-8 文件同时正确解码读取", async () => {
    const g = join(root, "Gbk.java");
    const u = join(root, "Utf8.java");
    writeFileSync(g, iconv.encode(JAVA_SRC, "GBK"));
    writeFileSync(u, Buffer.from(JAVA_SRC_UTF8, "utf-8"));
    const r = makeReadOperations();
    const fromGbk = (await r.readFile(g)).toString("utf-8");
    const fromUtf8 = (await r.readFile(u)).toString("utf-8");
    expect(fromGbk).toContain("温控器A");
    expect(fromUtf8).toContain("温控器A");
    expect(fromGbk.replace(/\r\n/g, "\n")).toBe(fromUtf8.replace(/\r\n/g, "\n"));
    expect(fromGbk).not.toContain("锟斤拷");
  });

  it("protectUtf8:false 时按目标编码转为 GBK", async () => {
    clearConfigCache();
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", protectUtf8: false });
    const p = join(root, "NoProtect.java");
    writeFileSync(p, Buffer.from(JAVA_SRC_UTF8, "utf-8"));
    const r = makeReadOperations();
    const w = makeWriteOperations();
    const text = (await r.readFile(p)).toString("utf-8");
    await w.writeFile(p, text.replace("=85.5", "=90.0"));
    const after = readFileSync(p);
    expect(isUtf8(after)).toBe(false);
    expect(iconv.decode(after, "GBK")).toContain("温控器A");
  });
});

describe("混合编码工程树读写校验", () => {
  let root = "";
  let paths: Map<string, string> = new Map();
  beforeEach(() => {
    clearConfigCache();
    clearClassifyCache();
    root = mkdtempSync(join(tmpdir(), "tree-"));
    paths = writeTree(join(root, "tree"), mixedEncodingProjectTree(join(root, "tree")).files);
  });

  const textFiles = () =>
    [...paths.keys()].filter((f) => !f.endsWith(".pi-charset.json") && !f.endsWith(".dsv"));

  it("所有文本文件 read -> write（内容未改）逐字节无损", async () => {
    const r = makeReadOperations();
    const w = makeWriteOperations();
    const broken: string[] = [];
    for (const rel of textFiles()) {
      const abs = paths.get(rel)!;
      const before = readFileSync(abs);
      const out = await r.readFile(abs);
      await w.writeFile(abs, out.toString("utf-8"));
      const after = readFileSync(abs);
      if (!after.equals(before)) broken.push(`${rel} (${before.length}B -> ${after.length}B)`);
    }
    expect(broken).toEqual([]);
  });

  it("编辑 ASCII 片段后各文件保持原有编码类别", async () => {
    const r = makeReadOperations();
    const w = makeWriteOperations();
    const bad: string[] = [];
    const edited: string[] = [];
    for (const rel of textFiles()) {
      const abs = paths.get(rel)!;
      const before = readFileSync(abs);
      const text = (await r.readFile(abs)).toString("utf-8");
      if (!text.includes("=85.5")) continue;
      edited.push(rel);
      await w.writeFile(abs, text.replace("=85.5", "=90.0"));
      const after = readFileSync(abs);
      if (Math.abs(after.length - before.length) > 2) bad.push(`${rel}: 尺寸异常 ${before.length}B->${after.length}B`);
      if (isUtf8(before) && !isUtf8(after)) bad.push(`${rel}: UTF-8 文件被转码`);
      if (!isUtf8(before) && isUtf8(after) && after.some((x) => x > 0x7f)) bad.push(`${rel}: GBK 文件变成了 UTF-8`);
    }
    expect(bad).toEqual([]);
    expect(edited.length).toBeGreaterThanOrEqual(4);
  });

  it("含 NUL 的二进制文件（.dsv）读透传、写拒绝", async () => {
    const abs = paths.get("db/oracle.dsv")!;
    const before = readFileSync(abs);
    const r = makeReadOperations();
    const out = await r.readFile(abs);
    expect(out.equals(before)).toBe(true);
    await expect(makeWriteOperations().writeFile(abs, "text\n")).rejects.toThrow(/二进制|binary/);
    expect(readFileSync(abs).equals(before)).toBe(true);
  });

  it("UTF-8 与 GBK 的 JSP 文件共存时各自保持声明编码", async () => {
    const r = makeReadOperations();
    const w = makeWriteOperations();
    const cases = [
      ["WebContent/pages/login.jsp", "GBK", "登录名"],
      ["WebContent/pages/msg/wxmessagefeedback.jsp", "UTF-8", "回复微信消息"],
    ] as const;
    const bad: string[] = [];
    for (const [rel, , needle] of cases) {
      const abs = paths.get(rel)!;
      const text = (await r.readFile(abs)).toString("utf-8");
      if (!text.includes(needle)) bad.push(`${rel} 未读出 ${needle}`);
      await w.writeFile(abs, text + "<%-- touched --%>\r\n");
      const after = readFileSync(abs);
      const declared = /pageEncoding="([^"]+)"/i.exec(after.toString("latin1"))?.[1] ?? "(无声明)";
      const declaredUtf8 = /utf-?8/i.test(declared);
      if (isUtf8(after) !== declaredUtf8) bad.push(`${rel}: 声明 pageEncoding=${declared} 但磁盘 ${isUtf8(after) ? "是" : "不是"} UTF-8`);
    }
    expect(bad).toEqual([]);
  });
});
