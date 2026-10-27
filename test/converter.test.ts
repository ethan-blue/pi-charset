import { describe, it, expect } from "vitest";
import iconv from "iconv-lite";
import {
  canEncodeAll,
  charListMessage,
  decodeToUtf8,
  encodeFromUtf8,
  isGBEncoding,
  isSingleByteEncoding,
  isStatefulEncoding,
  isSupportedEncoding,
  normalizeEncoding,
  unmappableChars,
  UnsupportedEncodingError,
} from "../src/encoding/converter";

describe("normalizeEncoding", () => {
  it("常见别名归一到 iconv 规范名", () => {
    expect(normalizeEncoding("utf8")).toBe("UTF-8");
    expect(normalizeEncoding("UTF-8")).toBe("UTF-8");
    expect(normalizeEncoding("gb18030")).toBe("GB18030");
    expect(normalizeEncoding("cp936")).toBe("GBK");
    expect(normalizeEncoding("euc-cn")).toBe("GB2312");
    expect(normalizeEncoding("big-5")).toBe("Big5");
    expect(normalizeEncoding("sjis")).toBe("Shift_JIS");
    expect(normalizeEncoding("latin1")).toBe("ISO-8859-1");
    expect(normalizeEncoding("cp1252")).toBe("windows-1252");
    expect(normalizeEncoding(undefined)).toBe("UTF-8");
  });
  it("未知编码名抛出 UnsupportedEncodingError", () => {
    expect(() => normalizeEncoding("NOT-A-CODEC")).toThrow(UnsupportedEncodingError);
    expect(isSupportedEncoding("GBK")).toBe(true);
    expect(isSupportedEncoding("EBCDIC-CP-US")).toBe(false);
  });
});

describe("编码族判定", () => {
  it("isGBEncoding 识别 GB 编码族", () => {
    expect(isGBEncoding("GB18030")).toBe(true);
    expect(isGBEncoding("gbk")).toBe(true);
    expect(isGBEncoding("UTF-8")).toBe(false);
    expect(isGBEncoding("Big5")).toBe(false);
  });
  it("isSingleByteEncoding 识别单字节编码", () => {
    expect(isSingleByteEncoding("ISO-8859-1")).toBe(true);
    expect(isSingleByteEncoding("windows-1251")).toBe(true);
    expect(isSingleByteEncoding("GBK")).toBe(false);
    expect(isSingleByteEncoding("UTF-8")).toBe(false);
  });
  it("isStatefulEncoding 识别状态转义序列编码", () => {
    expect(isStatefulEncoding("ISO-2022-JP")).toBe(true);
    expect(isStatefulEncoding("GBK")).toBe(false);
  });
});

describe("编解码往返", () => {
  it("GB18030 中文编解码往返一致", () => {
    const gb = encodeFromUtf8("你好世界", "GB18030");
    expect(decodeToUtf8(gb, "GB18030")).toBe("你好世界");
    expect(gb.equals(Buffer.from("你好世界", "utf-8"))).toBe(false);
  });
  it("多语种 iconv 编码编解码往返一致", () => {
    expect(decodeToUtf8(encodeFromUtf8("Ünïcødé", "ISO-8859-1"), "ISO-8859-1")).toBe("Ünïcødé");
    expect(decodeToUtf8(encodeFromUtf8("한국어", "EUC-KR"), "EUC-KR")).toBe("한국어");
    expect(decodeToUtf8(encodeFromUtf8("日本語", "Shift_JIS"), "Shift_JIS")).toBe("日本語");
    expect(decodeToUtf8(encodeFromUtf8("繁體", "Big5"), "Big5")).toBe("繁體");
  });
});

describe("不可映射字符检测", () => {
  it("unmappableChars 提取 GBK 无法表示的码点", () => {
    expect(unmappableChars("注释：张䶇（生僻字）𠀋 扩展C", "gbk")).toEqual(["䶇", "𠀋"]);
    expect(unmappableChars("注释：张䶇（生僻字）𠀋 扩展C", "gb18030")).toEqual([]);
    expect(unmappableChars("OrderService 123\r\n", "gbk")).toEqual([]);
    expect(charListMessage(["䶇", "𠀋"])).toBe("䶇 U+4D87, 𠀋 U+2000B");
  });
  it("canEncodeAll 与逐码点检测结果一致", () => {
    expect(canEncodeAll("普通中文", "GBK")).toBe(true);
    expect(canEncodeAll("有 䶇 在里面", "GBK")).toBe(false);
    expect(canEncodeAll("问号?本身不算丢字", "GBK")).toBe(true);
  });
  it("iconv 对不可映射字符与 BOM 写出 0x3F", () => {
    expect(iconv.encode("䶇", "gbk")[0]).toBe(0x3f);
    expect(iconv.encode("\ufeff标题：测试\n", "gbk")[0]).toBe(0x3f);
  });
});
