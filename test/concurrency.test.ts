import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { clearEncodingNotes } from "../src/notify";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { putConfig } from "./helpers/tree";
import { JAVA_SRC } from "./fixtures/build";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
  root = mkdtempSync(join(tmpdir(), "conc-"));
});

describe("并发写入串行化与原子替换", () => {
  it("20 路并发写同一 GBK 文件，落盘结果为完整单次写入且保持合法 GBK", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Conc.java");
    writeFileSync(p, iconv.encode(JAVA_SRC, "GBK"));
    const wr = makeWriteOperations();
    const rd = makeReadOperations();
    const wanted: string[] = [];
    for (let i = 0; i < 20; i++) {
      wanted.push(JAVA_SRC.replace("报警阈值=85.5", `报警阈值=${85 + i / 10}`));
    }
    await Promise.all(wanted.map((text) => wr.writeFile(p, text)));
    const finalBytes = readFileSync(p);
    const finalText = iconv.decode(finalBytes, "GBK");
    expect(wanted).toContain(finalText);
    expect(finalText.endsWith("}\r\n")).toBe(true);
    expect(finalBytes.includes(0x3f)).toBe(false);
    expect((await rd.readFile(p)).toString("utf-8")).toBe(finalText);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(root).filter((f) => f.includes(".pi-charset.tmp"))).toEqual([]);
  });

  it("多文件并发写入互不干扰", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const files = Array.from({ length: 12 }, (_, i) => join(root, `F${i}.java`));
    files.forEach((f, i) => writeFileSync(f, iconv.encode(JAVA_SRC.replace("85.5", String(90 + i)), "GBK")));
    const wr = makeWriteOperations();
    await Promise.all(files.map((f, i) => wr.writeFile(f, JAVA_SRC.replace("85.5", String(100 + i)))));
    for (let i = 0; i < files.length; i++) {
      expect(iconv.decode(readFileSync(files[i]), "GB18030")).toBe(JAVA_SRC.replace("85.5", String(100 + i)));
    }
  });

  it("闸门 1 拒写期间并发读取原文件始终完整", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "RollConc.java");
    const original = iconv.encode(JAVA_SRC, "GBK");
    writeFileSync(p, original);
    const wr = makeWriteOperations();
    const reader = (async () => {
      const seen: number[] = [];
      for (let i = 0; i < 40; i++) {
        seen.push(readFileSync(p).length);
        await new Promise((r) => setImmediate(r));
      }
      return seen;
    })();
    await expect(wr.writeFile(p, "含生僻字 䶇 的内容")).rejects.toThrow(/闸门 1/);
    const lengths = await reader;
    expect([...new Set(lengths)]).toEqual([original.length]);
    expect(readFileSync(p).equals(original)).toBe(true);
  });
});
