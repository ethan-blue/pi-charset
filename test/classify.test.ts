import { describe, it, expect, beforeEach } from "vitest";
import iconv from "iconv-lite";
import {
  classifyBuffer,
  classifyFileCached,
  clearClassifyCache,
  containsNul,
  exactRoundTrip,
  isAllAscii,
  isValidUtf8Strict,
  DEFAULT_AUTO_CANDIDATES,
} from "../src/encoding/classify";
import { clearConfigCache } from "../src/config";
import { FIXTURES, JAVA_SRC, JAVA_SRC_UTF8, RARE_SRC, BIG5_SRC } from "./fixtures/build";

beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
});

const buf = (name: string) => FIXTURES.find((f) => f.name === name)!.make();

describe("classifyBuffer 样本分类", () => {
  const expected: Record<string, string> = {
    "empty.txt": "utf8",
    "utf8bom.txt": "utf8-bom",
    "utf16le.txt": "utf16le",
    "utf16be.txt": "utf16be",
    "fake-binary.bin": "binary",
    "utf32le.txt": "binary",
    "tiny.png": "binary",
    "ascii.java": "ascii",
    "gbk.txt": "cjk",
    "gbk-crlf.java": "cjk",
    "gb18030-rare.txt": "cjk",
    "utf8.java": "utf8",
    "big5.txt": "cjk",
    "euckr.txt": "cjk",
    "truncated-utf8.txt": "unknown",
    "latin1.txt": "unknown",
  };
  for (const f of FIXTURES) {
    it(`${f.name} -> ${expected[f.name]}`, () => {
      const v = classifyBuffer(buf(f.name), null);
      expect(v.kind).toBe(expected[f.name]);
    });
  }

  it("无配置时 CJK 候选取首个通过项 GB18030 并标记歧义状态", () => {
    const v = classifyBuffer(buf("gbk.txt"), null);
    expect(v.encoding).toBe("GB18030");
    expect(v.candidates[0]).toBe("GB18030");
    expect(v.ambiguous).toBe(v.candidates.length > 1);
    expect(v.exhaustive).toBe(true);
  });

  it("配置 sourceEncoding 决定多候选歧义时的首选编码", () => {
    const noCfg = classifyBuffer(buf("big5.txt"), null);
    const big5 = classifyBuffer(buf("big5.txt"), { sourceEncoding: "Big5" });
    expect(noCfg.encoding).not.toBe("Big5");
    expect(big5.encoding).toBe("Big5");
    expect(big5.kind).toBe("cjk");
    expect(big5.hasFffd).toBe(false);
  });

  it("截断的多字节序列判为 unknown", () => {
    const v = classifyBuffer(buf("truncated-utf8.txt"), null);
    expect(v.kind).toBe("unknown");
    expect(v.encoding).toBe("UNKNOWN");
    expect(v.candidates).toEqual([]);
  });

  it("单字节编码样本通过 force 或配置声明路径解析", () => {
    const forced = classifyBuffer(buf("latin1.txt"), { sourceEncoding: "ISO-8859-1", force: true });
    expect(forced.kind).toBe("config");
    expect(forced.encoding).toBe("ISO-8859-1");
    expect(forced.configReason).toBe("force");
    expect(forced.hasFffd).toBe(false);
    expect(iconv.decode(buf("latin1.txt"), "ISO-8859-1")).toContain("Gr");
    expect(classifyBuffer(buf("latin1.txt"), null).kind).toBe("unknown");
    const implicit = classifyBuffer(buf("latin1.txt"), { sourceEncoding: "ISO-8859-1" });
    expect(implicit.kind).toBe("config");
    expect(implicit.configReason).toBe("undecidable");
  });

  it("rejects invalid UTF-8 after a BOM without rejecting valid replacement characters", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    for (const tail of [[0x61, 0xff, 0x62], [0xe4, 0xb8], [0x80]]) {
      expect(classifyBuffer(Buffer.concat([bom, Buffer.from(tail)])).kind).toBe("unknown");
    }
    expect(classifyBuffer(bom).kind).toBe("utf8-bom");
    expect(classifyBuffer(Buffer.concat([bom, Buffer.from("a\ufffdb")])).kind).toBe("utf8-bom");
  });

  it("rejects malformed UTF-16 BOM bodies: odd length and unpaired surrogates", () => {
    const leBom = Buffer.from([0xff, 0xfe]);
    const beBom = Buffer.from([0xfe, 0xff]);
    // Truncated final code unit (odd body length).
    expect(classifyBuffer(Buffer.concat([leBom, Buffer.from([0x61, 0x00, 0x00])])).kind).toBe("unknown");
    // Orphan lead surrogate at end of body (LE).
    expect(classifyBuffer(Buffer.concat([leBom, Buffer.from([0x00, 0xd8])])).kind).toBe("unknown");
    // Trail surrogate without a lead (LE).
    expect(classifyBuffer(Buffer.concat([leBom, Buffer.from([0x00, 0xdc])])).kind).toBe("unknown");
    // Orphan lead surrogate (BE).
    expect(classifyBuffer(Buffer.concat([beBom, Buffer.from([0xd8, 0x00])])).kind).toBe("unknown");
    // Valid surrogate pair (U+1F600 in LE) and valid BMP text still pass.
    expect(classifyBuffer(Buffer.concat([leBom, Buffer.from([0x3d, 0xd8, 0x00, 0xde])])).kind).toBe("utf16le");
    expect(classifyBuffer(Buffer.concat([beBom, iconv.encode("中文", "UTF-16BE")])).kind).toBe("utf16be");
  });

  it("记录 BOM 标记", () => {
    expect(classifyBuffer(buf("utf8bom.txt"), null).bom).toBe(true);
    expect(classifyBuffer(buf("utf16le.txt"), null).bom).toBe(true);
    expect(classifyBuffer(buf("gbk.txt"), null).bom).toBe(false);
  });
});

describe("字节回环与编码判定原语", () => {
  const gbkBytes = iconv.encode(JAVA_SRC, "GBK");
  const utf8Bytes = iconv.encode(JAVA_SRC_UTF8, "UTF-8");

  it("中文 GBK 源码不通过严格 UTF-8 校验", () => {
    expect(isValidUtf8Strict(gbkBytes)).toBe(false);
  });
  it("合法 UTF-8 中文文件按 GBK 逐字节回环不相等", () => {
    expect(exactRoundTrip(utf8Bytes, "GBK")).toBe(false);
  });
  it("GBK 字节在 GBK 与 GB18030 下回环相等且无 U+FFFD", () => {
    expect(exactRoundTrip(gbkBytes, "GBK")).toBe(true);
    expect(exactRoundTrip(gbkBytes, "GB18030")).toBe(true);
    expect(iconv.decode(gbkBytes, "GBK").includes("\ufffd")).toBe(false);
  });
  it("GBK 内容用 GB18030 编码输出字节一致", () => {
    expect(Buffer.compare(iconv.encode(iconv.decode(gbkBytes, "GBK"), "GB18030"), gbkBytes)).toBe(0);
  });
  it("iconv 解码非法字节产生 U+FFFD", () => {
    expect(iconv.decode(Buffer.from([0x80, 0x90, 0xa0, 0xff, 0xfe, 0x81]), "GBK")).toContain("\ufffd");
  });
  it("单字节编码不进入自动判定候选集", () => {
    expect(exactRoundTrip(gbkBytes, "ISO-8859-1")).toBe(true);
    expect(exactRoundTrip(iconv.encode("Яндекс ÿ", "windows-1251"), "windows-1251")).toBe(true);
    for (const c of DEFAULT_AUTO_CANDIDATES) expect(c).not.toMatch(/ISO-8859|windows-12|CP\d/i);
    const v = classifyBuffer(gbkBytes, { sourceEncoding: "GBK", autoCandidates: ["ISO-8859-1", "GBK"] });
    expect(v.candidates).not.toContain("ISO-8859-1");
  });
  it("截断的多字节序列被整文件严格校验拦截", () => {
    const t = Buffer.from("中文中间", "utf-8").subarray(0, 7);
    expect(isValidUtf8Strict(t)).toBe(false);
    expect(classifyBuffer(t, null).kind).toBe("unknown");
  });
  it("GB18030 四字节扩展区字符仅通过 GB18030 回环", () => {
    const b = iconv.encode(RARE_SRC, "GB18030");
    expect(exactRoundTrip(b, "GB18030")).toBe(true);
    expect(exactRoundTrip(b, "GBK")).toBe(false);
    expect(classifyBuffer(b, { sourceEncoding: "GBK" }).encoding).toBe("GB18030");
  });
  it("isAllAscii 与 containsNul 边界校验", () => {
    expect(isAllAscii(Buffer.from("OrderService 123\r\n", "ascii"))).toBe(true);
    expect(isAllAscii(Buffer.from([0x00]))).toBe(true);
    expect(isAllAscii(Buffer.from([0x80]))).toBe(false);
    expect(classifyBuffer(Buffer.from([0x00]), null).kind).toBe("binary");
    expect(containsNul(Buffer.from([0x41, 0x00]))).toBe(true);
    expect(containsNul(Buffer.concat([Buffer.from("A".repeat(9000), "ascii"), Buffer.from([0])]))).toBe(false);
  });
  it("Big5 样本解码还原繁体原文", () => {
    const b = iconv.encode(BIG5_SRC, "Big5");
    expect(iconv.decode(b, "Big5")).toBe(BIG5_SRC);
  });
});

describe("判定缓存与耗时", () => {
  it("1MB 文件首次判定与缓存命中耗时", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const unit = iconv.encode(JAVA_SRC, "GBK");
    const parts: Buffer[] = [];
    let n = 0;
    while (n < 1024 * 1024) { parts.push(unit); n += unit.length; }
    const big = Buffer.concat(parts).subarray(0, 1024 * 1024);
    const dir = mkdtempSync(join(tmpdir(), "cls-"));
    const f = join(dir, "big.java");
    writeFileSync(f, big);

    const t0 = Date.now();
    const v = classifyFileCached(f, { sourceEncoding: "GBK", autoCandidates: ["GB18030", "GBK"] });
    const first = Date.now() - t0;
    expect(v.encoding).toBe("GBK");
    const t1 = Date.now();
    classifyFileCached(f, { sourceEncoding: "GBK", autoCandidates: ["GB18030", "GBK"] });
    const second = Date.now() - t1;
    const budget = process.env.CI ? 400 : 150;
    expect(first, `首次判定 ${first}ms 应 <${budget}ms`).toBeLessThan(budget);
    expect(second, `缓存命中 ${second}ms 应 <10ms`).toBeLessThan(10);
  });

  it("文件修改后缓存自动失效重算", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "cls2-"));
    const f = join(dir, "a.txt");
    writeFileSync(f, iconv.encode(JAVA_SRC, "GBK"));
    expect(classifyFileCached(f, null).kind).toBe("cjk");
    writeFileSync(f, iconv.encode(JAVA_SRC, "UTF-8"));
    expect(classifyFileCached(f, null).kind).toBe("utf8");
  });
});
