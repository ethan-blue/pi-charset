import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { makeWriteOperations, type WriteSeam } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { putConfig } from "./helpers/tree";
import { JAVA_SRC, RARE_SRC } from "./fixtures/build";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  root = mkdtempSync(join(tmpdir(), "gates-"));
});

const gbkBytes = (text: string) => iconv.encode(text, "GBK");

describe("闸门 1：不可映射字符检查", () => {
  it("error 策略：GBK 文件写入生僻字 䶇 报错，包含字符、U+4D87、路径与 GB18030 建议，磁盘字节不变", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Rare.java");
    const original = gbkBytes("class A{}\r\n");
    writeFileSync(p, original);

    await expect(makeWriteOperations().writeFile(p, "class A{ /* 张䶇 𠀋 */ }\r\n")).rejects.toThrow();
    let msg = "";
    try {
      await makeWriteOperations().writeFile(p, "class A{ /* 张䶇 𠀋 */ }\r\n");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("闸门 1");
    expect(msg).toContain("拒写");
    expect(msg).toContain(p);
    expect(msg).toContain("䶇");
    expect(msg).toContain("U+4D87");
    expect(msg).toContain("𠀋");
    expect(msg).toContain("U+2000B");
    expect(msg).toContain("GB18030");
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("drop-to-gb18030 策略：自动升为 GB18030 写出，原有 GBK 字节保持不变", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", unmappable: "drop-to-gb18030" });
    const p = join(root, "Up.java");
    writeFileSync(p, gbkBytes(JAVA_SRC));
    const text = iconv.decode(readFileSync(p), "GBK") + "// 新增：张䶇\r\n";
    await makeWriteOperations().writeFile(p, text);
    const after = readFileSync(p);
    expect(after.includes(0x3f)).toBe(false);
    const dec = iconv.decode(after, "GB18030");
    expect(dec).toContain("䶇");
    expect(dec).toContain("报警阈值=85.5");
    const prefix = gbkBytes(JAVA_SRC);
    expect(after.subarray(0, prefix.length).equals(prefix)).toBe(true);
  });

  it("escape 策略：转为 \\uXXXX 文本，文件保持 GBK", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", unmappable: "escape" });
    const p = join(root, "Esc.java");
    writeFileSync(p, gbkBytes("class A{}\r\n"));
    await makeWriteOperations().writeFile(p, "class A{ /* 䶇 */ }\r\n");
    const after = readFileSync(p);
    const dec = iconv.decode(after, "GBK");
    expect(dec).toContain("\\u4d87");
    expect(dec).not.toContain("䶇");
    expect(after.includes(0x3f)).toBe(false);
  });

  it("纯 ASCII 与常规中文正常写入", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Ok.java");
    writeFileSync(p, gbkBytes("class A{}\r\n"));
    await makeWriteOperations().writeFile(p, "class A{ /* 订单服务 OrderService 123 */ }\r\n\t\r\n");
    expect(iconv.decode(readFileSync(p), "GBK")).toContain("订单服务");
  });
});

describe("闸门 2：写后回读自校验（保留现场，不回滚）", () => {
  const corruptOnceSeam = (): WriteSeam => {
    let n = 0;
    return {
      writeBytes: async (abs: string, bytes: Buffer) => {
        n++;
        writeFileSync(abs, n === 1 ? Buffer.concat([bytes, Buffer.from([0x00, 0x41])]) : bytes);
      },
    };
  };

  it("写出字节与预期不一致时抛闸门 2 错误并保留磁盘现状", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Roll.java");
    const original = gbkBytes(JAVA_SRC);
    writeFileSync(p, original);
    const seam = corruptOnceSeam();
    let msg = "";
    try {
      await makeWriteOperations(seam).writeFile(p, iconv.decode(original, "GBK").replace("=85.5", "=90.0"));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("闸门 2");
    expect(msg).toContain("不一致");
    expect(msg).toContain("未回滚");
    expect(readFileSync(p).equals(original)).toBe(false);
    expect(readFileSync(p).subarray(readFileSync(p).length - 2).equals(Buffer.from([0x00, 0x41]))).toBe(true);
  });

  it("落盘直接抛错时报告磁盘状态未验证", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Boom.java");
    const original = gbkBytes(JAVA_SRC);
    writeFileSync(p, original);
    const seam: WriteSeam = {
      writeBytes: async () => {
        throw new Error("EBUSY: resource busy or locked");
      },
    };
    let msg = "";
    try {
      await makeWriteOperations(seam).writeFile(p, "新内容");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("EBUSY");
    expect(msg).toContain("未验证");
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("新建文件写后校验不一致时保留已写出文件供核对", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Fresh.java");
    const seam = corruptOnceSeam();
    let msg = "";
    try {
      await makeWriteOperations(seam).writeFile(p, "class Fresh{}\r\n");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("写前不存在");
    expect(msg).toContain("未删除");
    expect(existsSync(p)).toBe(true);
  });

  it("写后校验窗口内被外部进程改写时报错并保留外部新内容", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Ext.java");
    const original = gbkBytes("/* 原内容 */\r\n");
    const external = gbkBytes("/* 外部最新内容 */\r\n");
    writeFileSync(p, original);
    let calls = 0;
    const seam: WriteSeam = {
      writeBytes: async (file, bytes) => {
        writeFileSync(file, bytes);
        if (++calls === 1) writeFileSync(file, external);
      },
    };
    await expect(makeWriteOperations(seam).writeFile(p, "/* 插件修改 */\r\n")).rejects.toThrow(/外部|冲突|不一致/);
    expect(readFileSync(p).equals(external)).toBe(true);
    expect(readFileSync(p).equals(original)).toBe(false);
  });

  it("verifyWrite:false 时跳过写后回读校验", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030", verifyWrite: false });
    const p = join(root, "NoVerify.java");
    writeFileSync(p, gbkBytes("class A{}\r\n"));
    const seam = corruptOnceSeam();
    await makeWriteOperations(seam).writeFile(p, "class A{ /* 中文 */ }\r\n");
    const after = readFileSync(p);
    expect(after.subarray(after.length - 2).equals(Buffer.from([0x00, 0x41]))).toBe(true);
  });

  it("原子替换完成后不留临时文件", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Good.java");
    writeFileSync(p, gbkBytes("class A{}\r\n"));
    await makeWriteOperations().writeFile(p, "class A{ /* 中文 */ }\r\n");
    expect(readFileSync(p).equals(gbkBytes("class A{ /* 中文 */ }\r\n"))).toBe(true);
    const leftovers = readdirSync(root).filter((f) => f.includes(".pi-charset.tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("闸门 3：UNKNOWN、BINARY 与 BOM 写入拦截", () => {
  it("内容带前导 U+FEFF 而目标为 GB 系时拒写且不产生 0x3F", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Bom.java");
    const original = gbkBytes("标题：测试\n");
    writeFileSync(p, original);
    let msg = "";
    try {
      await makeWriteOperations().writeFile(p, "\ufeff标题：测试2\n");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("UTF-8 with BOM");
    expect(msg).toContain("0x3F");
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("unknown 与 binary 文件拒绝写入", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const u = join(root, "unknown.bin");
    writeFileSync(u, Buffer.from("中文中间被截断", "utf-8").subarray(0, 7));
    await expect(makeWriteOperations().writeFile(u, "x\n")).rejects.toThrow(/UNKNOWN/);
    const b = join(root, "b.class");
    writeFileSync(b, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x01]));
    await expect(makeWriteOperations().writeFile(b, "x\n")).rejects.toThrow(/二进制/);
  });

  it("force 错配产生 U+FFFD 的文本写回 GB 系时被拒", async () => {
    putConfig(root, { overrides: [{ pattern: "*.java", encoding: "GBK", force: true }] });
    const p = join(root, "Mojibake.java");
    const utf8 = Buffer.from(RARE_SRC.replace("䶇", "").trim(), "utf-8");
    writeFileSync(p, utf8);
    const dirty = iconv.decode(utf8, "GBK");
    expect(dirty).toContain("\ufffd");
    await expect(makeWriteOperations().writeFile(p, dirty)).rejects.toThrow(/U\+FFFD/);
    expect(readFileSync(p).equals(utf8)).toBe(true);
  });
});
