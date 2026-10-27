import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { putConfig } from "./helpers/tree";
import { FIXTURES, JAVA_SRC, RARE_SRC } from "./fixtures/build";

beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rt-"));
});

describe("read -> write 无损回环", () => {
  const cases: { name: string; cfg: Record<string, unknown> }[] = [
    { name: "gbk.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "gbk-crlf.java", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "gb18030-rare.txt", cfg: { sourceEncoding: "GB18030", writeEncoding: "GB18030" } },
    { name: "utf8.java", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "utf8bom.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "utf16le.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "utf16be.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "ascii.java", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
    { name: "big5.txt", cfg: { sourceEncoding: "Big5", writeEncoding: "Big5" } },
    { name: "euckr.txt", cfg: { sourceEncoding: "EUC-KR", writeEncoding: "EUC-KR" } },
    { name: "latin1.txt", cfg: { sourceEncoding: "ISO-8859-1", overrides: [{ pattern: "*", encoding: "ISO-8859-1", force: true }] } },
    { name: "empty.txt", cfg: { sourceEncoding: "GBK", writeEncoding: "GBK" } },
  ];
  for (const c of cases) {
    it(`${c.name}：内容未修改时写回字节与原文件完全一致`, async () => {
      const f = FIXTURES.find((x) => x.name === c.name)!;
      putConfig(root, c.cfg);
      const p = join(root, c.name);
      const original = f.make();
      writeFileSync(p, original);
      const ops = makeReadOperations();
      const wops = makeWriteOperations();
      const text = (await ops.readFile(p)).toString("utf-8");
      await wops.writeFile(p, text);
      const after = readFileSync(p);
      expect(after.equals(original)).toBe(true);
    });
  }
});

describe("GBK 与 GB18030 混合树写回校验", () => {
  it("sourceEncoding=GBK + writeEncoding=GB18030：原 GBK 文件写回逐字节不变", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "A.java");
    const original = iconv.encode(JAVA_SRC, "GBK");
    writeFileSync(p, original);
    const text = (await makeReadOperations().readFile(p)).toString("utf-8");
    await makeWriteOperations().writeFile(p, text);
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("GB18030 含四字节字符文件降级写 GBK 被拒", async () => {
    putConfig(root, { sourceEncoding: "GB18030", writeEncoding: "GBK" });
    const p = join(root, "Rare.java");
    const original = iconv.encode(RARE_SRC, "GB18030");
    writeFileSync(p, original);
    const text = (await makeReadOperations().readFile(p)).toString("utf-8");
    await expect(makeWriteOperations().writeFile(p, text)).rejects.toThrow(/无损|回环|force/);
    expect(readFileSync(p).equals(original)).toBe(true);
  });
});

describe("纯 ASCII 文件写入中文", () => {
  it("GBK 工程中给纯 ASCII 文件新增中文注释写为 GBK 字节", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Ascii.java");
    writeFileSync(p, Buffer.from("public class Ascii {}\r\n", "ascii"));
    await makeWriteOperations().writeFile(p, "public class Ascii {\r\n    // 中文注释\r\n}\r\n");
    const bytes = readFileSync(p);
    expect(isValidUtf8(bytes)).toBe(false);
    expect(iconv.decode(bytes, "GBK")).toContain("中文注释");
    expect(Buffer.compare(bytes, iconv.encode("public class Ascii {\r\n    // 中文注释\r\n}\r\n", "GBK"))).toBe(0);
  });

  it("UTF-8 工程中给纯 ASCII 文件新增中文写为 UTF-8", async () => {
    putConfig(root, { sourceEncoding: "UTF-8", writeEncoding: "UTF-8" });
    const p = join(root, "Ascii.java");
    writeFileSync(p, Buffer.from("class A{}\n", "ascii"));
    await makeWriteOperations().writeFile(p, "class A{ /* 中文 */ }\n");
    expect(readFileSync(p).equals(Buffer.from("class A{ /* 中文 */ }\n", "utf-8"))).toBe(true);
  });
});

describe("UTF-8-BOM 与 GB18030 扩展字符写回", () => {
  it("剥离 BOM 后的文本写回 UTF-8-BOM 文件时自动还原 BOM", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "BomE2e.txt");
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("标题：TEST-1\r\n", "utf-8")]);
    writeFileSync(p, original);

    const raw = await makeReadOperations().readFile(p);
    const full = raw.toString("utf-8");
    const bom = full.charCodeAt(0) === 0xfeff;
    const content = bom ? full.slice(1) : full;
    expect(bom).toBe(true);

    await makeWriteOperations().writeFile(p, content.replace("TEST-1", "TEST-2") + "追加一行\r\n");

    const after = readFileSync(p);
    expect(after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(after.includes(0x3f)).toBe(false);
    const text = after.subarray(3).toString("utf-8");
    expect(text).toContain("标题：TEST-2");
    expect(text).toContain("追加一行");
    expect(after.length).toBeLessThan(original.length + 60);
  });

  it("writeEncoding=GB18030 时正常保存生僻字 䶇", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Gb.java");
    writeFileSync(p, iconv.encode("class A{}\r\n", "GBK"));
    await makeWriteOperations().writeFile(p, "class A{ /* 注释 䶇 */ }\r\n");
    const after = readFileSync(p);
    expect(after.includes(0x3f)).toBe(false);
    expect(iconv.decode(after, "GB18030")).toContain("䶇");
  });
});

describe("行尾保真与幂等性", () => {
  it("CRLF 的 GBK 文件写回保持 CRLF 且不出现 \\r\\r\\n", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Crlf.java");
    writeFileSync(p, iconv.encode(JAVA_SRC, "GBK"));
    const text = (await makeReadOperations().readFile(p)).toString("utf-8");
    const piRestored = text.replace(/\r?\n/g, "\r\n");
    expect(piRestored).not.toContain("\r\r\n");
    await makeWriteOperations().writeFile(p, piRestored);
    const out = readFileSync(p).toString("binary");
    expect(out).not.toMatch(/\r\r/);
    expect(out.split("\r\n").length).toBeGreaterThan(1);
    expect(iconv.decode(readFileSync(p), "GBK")).toBe(piRestored);
  });

  it("LF 结尾的 GBK 文件写回保持 LF", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Lf.java");
    const lfOnly = iconv.encode(JAVA_SRC.replace(/\r\n/g, "\n"), "GBK");
    writeFileSync(p, lfOnly);
    const text = (await makeReadOperations().readFile(p)).toString("utf-8");
    await makeWriteOperations().writeFile(p, text.replace("=85.5", "=90.0"));
    const after = readFileSync(p);
    expect(after.includes(0x0d)).toBe(false);
    expect(after.equals(iconv.encode(JAVA_SRC.replace(/\r\n/g, "\n").replace("=85.5", "=90.0"), "GBK"))).toBe(true);
    expect(iconv.decode(after, "GBK")).toContain("报警阈值=90.0");
  });

  it("无配置目录 writeFile 原样透传行尾", async () => {
    const p = join(root, "plain.txt");
    const content = "line1\r\nline2\n";
    writeFileSync(p, Buffer.from(content, "utf-8"));
    await makeWriteOperations().writeFile(p, content + "line3\r\n");
    expect(readFileSync(p).equals(Buffer.from(content + "line3\r\n", "utf-8"))).toBe(true);
  });
});

function isValidUtf8(b: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}
