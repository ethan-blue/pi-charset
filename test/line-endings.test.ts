import { describe, it, expect } from "vitest";
import { detectLineEnding, detectLineEndingKind, restoreLineEndings } from "../src/encoding/line-endings";

describe("line-endings", () => {
  it("detects CRLF-dominant buffer", () => {
    expect(detectLineEnding(Buffer.from("a\r\nb\r\nc\n"))).toBe("CRLF");
  });
  it("detects LF-dominant buffer", () => {
    expect(detectLineEnding(Buffer.from("a\nb\nc\r\n"))).toBe("LF");
  });
  it("restores to CRLF", () => {
    expect(restoreLineEndings("a\nb\n", "CRLF")).toBe("a\r\nb\r\n");
  });
  it("restores to LF", () => {
    expect(restoreLineEndings("a\r\nb\n", "LF")).toBe("a\nb\n");
  });
});

describe("detectLineEndingKind", () => {
  it("纯 CRLF 返回 CRLF；纯 LF 返回 LF", () => {
    expect(detectLineEndingKind(Buffer.from("a\r\nb\r\n"))).toBe("CRLF");
    expect(detectLineEndingKind(Buffer.from("a\nb\n"))).toBe("LF");
  });
  it("CRLF 与 LF 并存返回 MIXED", () => {
    expect(detectLineEndingKind(Buffer.from("/* 中文 */\r\nint a;\n"))).toBe("MIXED");
    expect(detectLineEndingKind(Buffer.from("a\nb\r\n"))).toBe("MIXED");
  });
  it("全文无换行返回 NONE", () => {
    expect(detectLineEndingKind(Buffer.from("int a;"))).toBe("NONE");
    expect(detectLineEndingKind(Buffer.alloc(0))).toBe("NONE");
  });
  it("孤立 \\r 返回 NONE", () => {
    expect(detectLineEndingKind(Buffer.from("a\rb\r"))).toBe("NONE");
  });
});
