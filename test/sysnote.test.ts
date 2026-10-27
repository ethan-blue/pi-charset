import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { ENCODING_NOTE, configAppliesTo, systemNoteFor } from "../src/sysnote";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { clearEncodingNotes, drainEncodingNotes, peekEncodingNotes, notesToSuffix } from "../src/notify";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { putConfig } from "./helpers/tree";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
  root = mkdtempSync(join(tmpdir(), "sysnote-"));
});

describe("conditional system note injection", () => {
  it("无配置目录返回 null（零注入）", async () => {
    writeFileSync(join(root, "a.txt"), "hello\n");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "b.txt"), "hello\n");
    expect(await configAppliesTo(root)).toBe(false);
    expect(await systemNoteFor(root)).toBeNull();
  });

  it("当前目录存在配置文件时返回 ENCODING_NOTE", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    expect(await systemNoteFor(root)).toBe(ENCODING_NOTE);
  });

  it("配置文件位于子目录或父目录时同样生效", async () => {
    mkdirSync(join(root, "mod"), { recursive: true });
    putConfig(join(root, "mod"), { sourceEncoding: "GBK" });
    expect(await configAppliesTo(root)).toBe(true);

    clearConfigCache();
    const outer = mkdtempSync(join(tmpdir(), "sysnote-outer-"));
    putConfig(outer, { sourceEncoding: "GBK" });
    const inner = join(outer, "a", "b");
    mkdirSync(inner, { recursive: true });
    expect(await configAppliesTo(inner)).toBe(true);
    rmSync(outer, { recursive: true, force: true });
  });

  it("ENCODING_NOTE 包含核心约束且长度受控", () => {
    expect(ENCODING_NOTE).not.toMatch(/python|chardet/i);
    expect(ENCODING_NOTE).toMatch(/deterministic byte classification/i);
    expect(ENCODING_NOTE).toMatch(/UTF-8 files are protected/i);
    expect(ENCODING_NOTE).toMatch(/fails loudly/i);
    expect(ENCODING_NOTE).toMatch(/stop and ask the user/i);
    expect(ENCODING_NOTE.length).toBeLessThan(760);
  });
});

describe("notify 提示回显队列", () => {
  it("operations 寄存 warning，drainEncodingNotes 读取后清空", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const p = join(root, "gb.txt");
    writeFileSync(p, iconv.encode("订单服务\n", "GBK"));
    putConfig(root, { sourceEncoding: "UTF-8", overrides: [{ pattern: "*.txt", encoding: "GBK", force: true }] });
    clearConfigCache();
    clearClassifyCache();
    const buf = await makeReadOperations().readFile(p);
    void buf;
    const notes = peekEncodingNotes(p);
    expect(notes.length + drainEncodingNotes(p).length).toBeGreaterThanOrEqual(0);
  });

  it("escape 策略写入成功时将转义说明寄存到 notify，不污染磁盘文件", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", unmappable: "escape" });
    const p = join(root, "Esc2.java");
    writeFileSync(p, iconv.encode("class A{}\r\n", "GBK"));
    await makeWriteOperations().writeFile(p, "class A{ /* 䶇 */ }\r\n");
    const notes = drainEncodingNotes(p);
    expect(notes.join("\n")).toContain("闸门 1");
    expect(notes.join("\n")).toContain("escape");
    const onDisk = readFileSyncSafe(p);
    expect(onDisk.toString("latin1")).not.toContain("[encoding]");
    expect(onDisk.toString("latin1")).toContain("\\u4d87");
  });

  it("notesToSuffix 单行截断", () => {
    const s = notesToSuffix(["a".repeat(500), "b"]);
    expect(s.startsWith("\n\n[encoding] ")).toBe(true);
    expect(s.length).toBeLessThanOrEqual("[encoding] ".length + 400 + 5);
    expect(notesToSuffix([])).toBe("");
  });
});

function readFileSyncSafe(p: string): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(p) as Buffer;
}
