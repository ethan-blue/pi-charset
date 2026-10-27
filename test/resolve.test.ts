import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import {
  resolveReadEncoding,
  resolveWriteEncoding,
  resolveReadPlan,
  resolveWritePlan,
  ruleFor,
} from "../src/resolve";
import { makeReadOperations, makeWriteOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { putConfig } from "./helpers/tree";
import { JAVA_SRC, JAVA_SRC_UTF8, RARE_SRC } from "./fixtures/build";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  root = mkdtempSync(join(tmpdir(), "resolve-"));
});

describe("resolveReadEncoding", () => {
  it("infers GBK automatically for a GB file even when no config exists up the tree", async () => {
    const f = join(root, "a.txt");
    writeFileSync(f, iconv.encode("你好", "GB18030"));
    expect(await resolveReadEncoding(f)).toBe("GBK");
  });

  it("非 force 模式下字节判定结果优先于 override 声明", async () => {
    writeFileSync(
      join(root, ".pi-charset.json"),
      JSON.stringify({ sourceEncoding: "GB18030", overrides: [{ pattern: "docs/**", encoding: "UTF-8" }] }),
    );
    mkdirSync(join(root, "docs"));
    const f = join(root, "docs", "x.md");
    writeFileSync(f, iconv.encode("你好", "GB18030"));
    expect(await resolveReadEncoding(f)).toBe("GB18030");
    expect((await resolveReadPlan(f))!.transcoded).toBe(true);
  });

  it("force:true 强制按配置编码解码", async () => {
    writeFileSync(
      join(root, ".pi-charset.json"),
      JSON.stringify({ sourceEncoding: "GB18030", overrides: [{ pattern: "docs/**", encoding: "UTF-8", force: true }] }),
    );
    mkdirSync(join(root, "docs"));
    const f = join(root, "docs", "x.md");
    writeFileSync(f, iconv.encode("你好", "GB18030"));
    const plan = (await resolveReadPlan(f))!;
    expect(plan.verdict.kind).toBe("config");
    expect(plan.encoding).toBe("UTF-8");
    expect(plan.note).toContain("force");
  });

  it("config GB: falls back to sourceEncoding for a GB file", async () => {
    putConfig(root, { sourceEncoding: "GB18030" });
    const f = join(root, "a.c");
    writeFileSync(f, iconv.encode("// 中文注释\nint main(){}\n", "GB18030"));
    const enc = await resolveReadEncoding(f);
    expect(enc).toMatch(/GB/i);
  });
});

describe("resolveWriteEncoding", () => {
  it("defaults to UTF-8 in an empty directory without config, and infers GBK when GBK siblings exist", async () => {
    expect(await resolveWriteEncoding(join(root, "new.c"))).toBe("UTF-8");
    writeFileSync(join(root, "sibling.c"), iconv.encode("/* 中文注释 */\r\nint x = 1;\r\n", "GBK"));
    expect(await resolveWriteEncoding(join(root, "new.c"))).toBe("GBK");
  });

  it("new file uses nearest-config sourceEncoding", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    expect(await resolveWriteEncoding(join(root, "new.c"))).toBe("GBK");
  });

  it("new file honors override", async () => {
    writeFileSync(
      join(root, ".pi-charset.json"),
      JSON.stringify({ sourceEncoding: "GB18030", overrides: [{ pattern: "utf/**", encoding: "UTF-8" }] }),
    );
    mkdirSync(join(root, "utf"));
    expect(await resolveWriteEncoding(join(root, "utf", "new.md"))).toBe("UTF-8");
  });
});

describe("resolveWritePlan 决策矩阵", () => {
  it("新建文件采用 writeEncoding ?? sourceEncoding", async () => {
    const p = join(root, "sub", "New.java");
    mkdirSync(join(root, "sub"));
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const plan = await resolveWritePlan(p, "class New{}\n");
    expect(plan.encoding).toBe("GB18030");
    expect(plan.kind).toBe("new");
    expect(plan.reject).toBeNull();
    putConfig(root, { sourceEncoding: "Big5" });
    expect((await resolveWritePlan(p, "x")).encoding).toBe("Big5");
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    expect((await resolveWritePlan(join(bare, "x.txt"), "x")).encoding).toBe("UTF-8");
  });

  it("纯 ASCII 文件按作用域写目标编码写出", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "A.java");
    writeFileSync(p, Buffer.from("class A{}\r\n", "ascii"));
    const plan = await resolveWritePlan(p, "class A{ /* 中文 */ }\r\n");
    expect(plan.kind).toBe("ascii");
    expect(plan.encoding).toBe("GBK");
    expect(plan.transcoding).toBe(false);
  });

  it("CJK 文件跨编码写回：目标无法无损回环时拒写，GBK 升 GB18030 放行", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "UTF-8" });
    const p = join(root, "G.java");
    const gbk = iconv.encode(JAVA_SRC, "GBK");
    writeFileSync(p, gbk);
    const plan = await resolveWritePlan(p, "x");
    expect(plan.reject).toContain("无损");
    expect(plan.encoding).toBeNull();
    expect(readFileSync(p).equals(gbk)).toBe(true);

    clearConfigCache();
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "UTF-8", overrides: [{ pattern: "*.java", encoding: "GBK", force: true }] });
    const forced = await resolveWritePlan(p, "x");
    expect(forced.reject).toBeNull();
    expect(forced.encoding).toBe("UTF-8");

    clearConfigCache();
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const up = await resolveWritePlan(p, JAVA_SRC);
    expect(up.reject).toBeNull();
    expect(up.encoding).toBe("GB18030");
    expect(up.transcoding).toBe(true);
  });

  it("UTF-8 文件默认保持 UTF-8（protectUtf8），显式 force 时允许转换", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "U.java");
    writeFileSync(p, Buffer.from(JAVA_SRC_UTF8, "utf-8"));
    const plan = await resolveWritePlan(p, "x");
    expect(plan.encoding).toBe("UTF-8");
    expect(plan.transcoding).toBe(false);
    expect(plan.warnings.join(" ")).toContain("UTF-8 文件");
    expect(plan.reject).toBeNull();

    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK", overrides: [{ pattern: "*", encoding: "GBK", force: true }] });
    const forced = await resolveWritePlan(p, "x");
    expect(forced.encoding).toBe("GBK");
    expect(forced.transcoding).toBe(true);
    expect(forced.warnings.join(" ")).toContain("破坏性语义变更");
  });

  it("force 错配导致含 U+FFFD 的文本写回 GB 系时拒写", async () => {
    putConfig(root, { overrides: [{ pattern: "*.java", encoding: "GBK", force: true }] });
    const p = join(root, "Mojibake.java");
    const utf8Bytes = Buffer.from(JAVA_SRC_UTF8, "utf-8");
    writeFileSync(p, utf8Bytes);
    const rplan = (await resolveReadPlan(p))!;
    expect(rplan.verdict.hasFffd).toBe(true);
    expect(rplan.note).toContain("U+FFFD");
    const dirty = iconv.decode(utf8Bytes, "GBK");
    expect(dirty).toContain("\ufffd");
    const plan = await resolveWritePlan(p, dirty);
    expect(plan.reject).toContain("U+FFFD");
    const clean = await resolveWritePlan(p, "class X{}\n");
    expect(clean.reject).toBeNull();
    expect(clean.encoding).toBe("GBK");
  });

  it("UTF-16 文件保持原 UTF-16 并补齐 BOM", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "U16.ini");
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode("标题\n", "UTF-16LE")]));
    const plan = await resolveWritePlan(p, "标题2\n");
    expect(plan.encoding).toBe("UTF-16LE");
    expect(plan.addBom).toBe("utf16le");
    expect(plan.reject).toBeNull();
  });

  it("binary 文件拒绝写入", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const p = join(root, "b.bin");
    writeFileSync(p, Buffer.from([0x00, 0x01, 0x80, 0xff]));
    const plan = await resolveWritePlan(p, "hello\n");
    expect(plan.reject).toContain("二进制");
    expect(plan.encoding).toBeNull();
    putConfig(root, { sourceEncoding: "GBK", overrides: [{ pattern: "*", encoding: "GBK", force: true }] });
    expect((await resolveWritePlan(p, "hello\n")).reject).toContain("二进制");
  });

  it("unknown 文件拒绝写入并在读侧附加警告", async () => {
    putConfig(root, { sourceEncoding: "GBK" });
    const p = join(root, "broken.txt");
    writeFileSync(p, Buffer.from("中文中间被截断", "utf-8").subarray(0, 7));
    const plan = await resolveWritePlan(p, "hello\n");
    expect(plan.reject).toContain("UNKNOWN");
    expect(plan.reject).toContain("force");
    expect(plan.encoding).toBeNull();
    const rplan = (await resolveReadPlan(p))!;
    expect(rplan.note).toContain("[encoding: UNKNOWN");
    expect(rplan.transcoded).toBe(false);
  });

  it("无配置文件目录：ruleFor 返回 null，resolveWritePlan 自动按文件字节保持 GBK 编码", async () => {
    const bare = mkdtempSync(join(tmpdir(), "nocfg-"));
    const p = join(bare, "x.txt");
    writeFileSync(p, iconv.encode("你好", "GBK"));
    expect(await ruleFor(p)).toBeNull();
    const plan = await resolveWritePlan(p, "你好世界");
    expect(plan.encoding).toBe("GBK");
    expect(plan.reject).toBeNull();
  });
});

describe("BOM 处理规则", () => {
  it("内容带前导 U+FEFF 而目标为 GB 系时拒写", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Bom.java");
    writeFileSync(p, iconv.encode("标题：测试\n", "GBK"));
    const plan = await resolveWritePlan(p, "\ufeff标题：测试2\n");
    expect(plan.reject).toContain("UTF-8 with BOM");
    expect(plan.reject).toContain("0x3F");
  });

  it("目标为 UTF-8 时保留 BOM", async () => {
    putConfig(root, { sourceEncoding: "UTF-8" });
    const p = join(root, "Bom2.txt");
    writeFileSync(p, Buffer.from("x", "ascii"));
    const plan = await resolveWritePlan(p, "\ufeff标题\n");
    expect(plan.reject).toBeNull();
    expect(plan.addBom).toBe("utf8");
  });

  it("UTF-8-BOM 文件在 GB 配置下保持 UTF-8+BOM", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    const p = join(root, "Bom3.txt");
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("标题：测试\n", "utf-8")]);
    writeFileSync(p, original);
    const plan = await resolveWritePlan(p, "\ufeff标题：测试2\n");
    expect(plan.encoding).toBe("UTF-8");
    expect(plan.addBom).toBe("utf8");
    expect(plan.reject).toBeNull();
    expect(readFileSync(p).equals(original)).toBe(true);
  });
});

describe("磁盘字节无损回环校验", () => {
  it("GB18030 四字节内容写入 writeEncoding=GBK 时拒写", async () => {
    putConfig(root, { sourceEncoding: "GB18030", writeEncoding: "GBK" });
    const p = join(root, "Rare.txt");
    writeFileSync(p, iconv.encode(RARE_SRC, "GB18030"));
    const plan = await resolveWritePlan(p, "whatever");
    expect(plan.reject).toContain("无损");
    expect(plan.reject).toContain("GB18030");
  });

  it("GB18030 四字节内容写入 writeEncoding=GB18030 时放行", async () => {
    putConfig(root, { sourceEncoding: "GB18030", writeEncoding: "GB18030" });
    const p = join(root, "Rare2.txt");
    writeFileSync(p, iconv.encode(RARE_SRC, "GB18030"));
    const plan = await resolveWritePlan(p, "whatever");
    expect(plan.reject).toBeNull();
    expect(plan.encoding).toBe("GB18030");
  });
});

describe("配置解析与校验告警", () => {
  it("非法编码名、单字节 autoCandidates 与损坏 JSON 均生成可见 warning", async () => {
    putConfig(root, { sourceEncoding: "NOT-A-CODEC", autoCandidates: ["ISO-8859-1"] });
    const p = join(root, "w.txt");
    writeFileSync(p, iconv.encode("你好", "GBK"));
    const r = (await ruleFor(p))!;
    expect(r.warnings.join(" ")).toContain("不可用");
    expect(r.warnings.join(" ")).toContain("单字节");
    clearConfigCache();
    putConfig(root, "{ this is not json }");
    const r2 = (await ruleFor(p))!;
    expect(r2.warnings.join(" ")).toContain("不是合法 JSON");
  });

  it("支持带 // 与 /* */ 注释的 JSONC 配置", async () => {
    putConfig(
      root,
      `{
      // Project encoding configuration
      "sourceEncoding": "GBK",   /* Primary read candidate */
      "writeEncoding": "GB18030",
      "overrides": [
        { "pattern": "*.properties", "encoding": "ISO-8859-1", "force": true }
      ]
    }`,
    );
    const r = (await ruleFor(join(root, "a.java")))!;
    expect(r.sourceEncoding).toBe("GBK");
    expect(r.writeEncoding).toBe("GB18030");
    expect(r.warnings).toEqual([]);
    const props = join(root, "x.properties");
    writeFileSync(props, Buffer.from("k=abc", "ascii"));
    expect((await ruleFor(props))!.force).toBe(true);
    expect((await ruleFor(props))!.sourceEncoding).toBe("ISO-8859-1");
  });
});

describe("override.encoding 与根 writeEncoding 优先级", () => {
  it("根无迁移意图时：override 只写 encoding，新文件与纯 ASCII 按 override 写，已有 GBK 文件保持原编码", async () => {
    putConfig(root, {
      sourceEncoding: "GBK",
      writeEncoding: "GBK",
      overrides: [{ pattern: "docs/**", encoding: "UTF-8" }],
    });
    mkdirSync(join(root, "docs"), { recursive: true });
    const fresh = join(root, "docs", "NEW.md");
    expect((await resolveWritePlan(fresh, "# 标题：中文\r\n")).encoding).toBe("UTF-8");
    const ascii = join(root, "docs", "a.md");
    writeFileSync(ascii, "# ascii only\n");
    expect((await resolveWritePlan(ascii, "# ascii only + 中文\n")).encoding).toBe("UTF-8");
    const gbkInDocs = join(root, "docs", "legacy.md");
    writeFileSync(gbkInDocs, iconv.encode("# 旧文档 中文\r\n", "GBK"));
    const p = await resolveWritePlan(gbkInDocs, "x");
    expect(p.reject).toBeNull();
    expect(["GBK", "GB18030"]).toContain(p.encoding);
    expect(p.warnings.join("\n")).toContain("不转码");
    const r = await ruleFor(gbkInDocs);
    expect(r!.matchedPattern).toBe("docs/**");
    expect(r!.writeIntent).toBeNull();
    const before = readFileSync(gbkInDocs);
    const text = (await makeReadOperations().readFile(gbkInDocs)).toString("utf-8");
    await makeWriteOperations().writeFile(gbkInDocs, text);
    expect(readFileSync(gbkInDocs).equals(before)).toBe(true);
  });

  it("显式转码意图（writeEncoding != 读编码）时按 writeEncoding 写出", async () => {
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GB18030" });
    const p = join(root, "Up2.java");
    const gbk = iconv.encode(JAVA_SRC, "GBK");
    writeFileSync(p, gbk);
    const plan = await resolveWritePlan(p, JAVA_SRC);
    expect(plan.encoding).toBe("GB18030");
    expect(plan.rule!.writeIntent).toBe("GB18030");
    await makeWriteOperations().writeFile(p, JAVA_SRC);
    expect(readFileSync(p).equals(gbk)).toBe(true);
    expect((await resolveWritePlan(join(root, "Fresh2.java"), "class Fresh2{}\r\n")).encoding).toBe("GB18030");
  });

  it("根配置含迁移意图（write != source）时根 writeEncoding 优先并输出警告", async () => {
    putConfig(root, {
      sourceEncoding: "GBK",
      writeEncoding: "UTF-8",
      overrides: [{ pattern: "docs/**", encoding: "GBK" }],
    });
    mkdirSync(join(root, "docs"), { recursive: true });
    const p = join(root, "docs", "n.md");
    const plan = await resolveWritePlan(p, "# 新\r\n");
    expect(plan.encoding).toBe("UTF-8");
    expect(plan.warnings.join("\n")).toContain("迁移意图");
    clearConfigCache();
    putConfig(root, {
      sourceEncoding: "GBK",
      writeEncoding: "UTF-8",
      overrides: [{ pattern: "docs/**", encoding: "GBK", writeEncoding: "GBK" }],
    });
    expect((await resolveWritePlan(p, "# 新\r\n")).encoding).toBe("GBK");
  });
});

describe("readStrategy:\"config\" 模式", () => {
  it("读侧强制按配置解码显示，写侧仍按字节判定结果处理", async () => {
    putConfig(root, { sourceEncoding: "GB18030", readStrategy: "config" });
    const p = join(root, "forced.txt");
    writeFileSync(p, "订单服务 =85.5\r\n", "utf-8");
    const plan = (await resolveReadPlan(p))!;
    expect(plan.verdict.kind).toBe("utf8");
    expect(plan.kind).toBe("config");
    expect(plan.encoding).toBe("GB18030");
    expect((await makeReadOperations().readFile(p)).toString("utf-8")).not.toBe("订单服务 =85.5\r\n");
    expect(plan.warnings.join("\n")).toContain("readStrategy");

    const wp = await resolveWritePlan(p, "订单服务 =90.0\r\n");
    expect(wp.reject).toBeNull();
    expect(wp.encoding).toBe("UTF-8");
  });

  it("readStrategy 非法值回退为 auto 并记录 warning", async () => {
    writeFileSync(
      join(root, ".pi-charset.json"),
      JSON.stringify({ sourceEncoding: "GBK", readStrategy: "magic" }),
    );
    const p = join(root, "x.txt");
    writeFileSync(p, iconv.encode("订单服务\r\n", "GBK"));
    const plan = (await resolveReadPlan(p))!;
    expect(plan.rule.readStrategy).toBe("auto");
    expect(plan.warnings.join("\n")).toContain("readStrategy");
  });
});

describe("配置热更新缓存失效", () => {
  it("修改 .pi-charset.json 后下一次解析自动加载新配置", async () => {
    const p = join(root, "legacy.bin");
    writeFileSync(p, Buffer.from("caf\xe9 na\xefve\r\n", "latin1"));
    putConfig(root, {
      sourceEncoding: "UTF-8",
      overrides: [{ pattern: "*.bin", encoding: "ISO-8859-1", force: true }],
    });
    expect((await resolveReadPlan(p))!.encoding).toBe("ISO-8859-1");

    putConfig(root, {
      sourceEncoding: "UTF-8",
      overrides: [{ pattern: "*.bin", encoding: "windows-1252", force: true }],
    });
    const again = (await resolveReadPlan(p))!;
    expect(again.encoding).toBe("windows-1252");
    expect(again.verdict.configReason).toBe("force");
  });

  it("mtime 相同但文件长度变化时缓存自动失效", async () => {
    const p = join(root, "F.java");
    writeFileSync(p, iconv.encode(JAVA_SRC, "GBK"));
    putConfig(root, { sourceEncoding: "GBK", writeEncoding: "GBK" });
    expect((await resolveWritePlan(p, JAVA_SRC.replace("85.5", "90.0"))).encoding).toBe("GBK");
    putConfig(root, {
      sourceEncoding: "GBK",
      writeEncoding: "GBK",
      overrides: [{ pattern: "*.java", encoding: "GBK", writeEncoding: "GB18030" }],
    });
    const wp = await resolveWritePlan(p, JAVA_SRC.replace("85.5", "90.0"));
    expect(wp.encoding).toBe("GB18030");
    expect(wp.warnings.length + (wp.reject ? 1 : 0)).toBeGreaterThan(0);
  });
});
