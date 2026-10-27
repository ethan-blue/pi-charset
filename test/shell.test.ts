// Tests for streaming shell output transcoding.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { createOutputTranscoder, incompleteUtf8Tail } from "../src/encoding/stream-transcode";
import {
  dumpCommandPath,
  fileDumpEncodingForCommand,
  makeTranscodingShellOperations,
  lastShellTranscodeStats,
  osConsoleEncoding,
} from "../src/shell";
import { normalizeBashMode, shellRuleFor, clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { clearEncodingNotes, drainShellNotes, peekEncodingNotes } from "../src/notify";
import { readPiShellSettings } from "../src/pi-settings";
import { putConfig } from "./helpers/tree";

const GB_TEXT = "订单服务初始化完成，报警阈值=85.5\n";

function collect(t: ReturnType<typeof createOutputTranscoder>, chunks: Buffer[]): Buffer {
  const outs: Buffer[] = [];
  for (const c of chunks) outs.push(t.push(c));
  outs.push(t.finish());
  return Buffer.concat(outs.filter((b) => b.length > 0));
}

function isUtf8ValidNow(b: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
});

describe("stream transcoder", () => {
  it("合法 UTF-8 输出原样透传", () => {
    const raw = Buffer.from("hello 世界 ok\n", "utf-8");
    const t = createOutputTranscoder({ candidates: ["GB18030", "GBK"], fallbackEncoding: "GBK" });
    const out = collect(t, [raw]);
    expect(out.equals(raw)).toBe(true);
    expect(t.stats().mode).toBe("passthrough");
  });

  it("GBK 输出转为 UTF-8，支持跨 chunk 拆分多字节字符", () => {
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const chunks: Buffer[] = [];
    for (let i = 0; i < gbk.length; i += 3) chunks.push(gbk.subarray(i, i + 3));
    const t = createOutputTranscoder({ candidates: ["GB18030", "GBK", "GB2312"], fallbackEncoding: "GBK" });
    const out = collect(t, chunks);
    expect(out.toString("utf-8")).toBe(GB_TEXT);
    expect(out.toString("utf-8")).not.toContain("\uFFFD");
    expect(t.stats().mode).toBe("transcoded");
    expect(["GB18030", "GBK", "GB2312"]).toContain(t.stats().encoding);
    expect(t.stats().lossy).toBe(false);
  });

  it("含 NUL 的二进制输出原样透传", () => {
    const bin = Buffer.concat([Buffer.from([0x4c, 0x00, 0x65, 0x00]), Buffer.from("junk\xff\xfe", "latin1")]);
    const t = createOutputTranscoder({ candidates: ["GB18030"], fallbackEncoding: "GBK" });
    const out = collect(t, [bin]);
    expect(out.equals(bin)).toBe(true);
    expect(t.stats().mode).toBe("binary-passthrough");
  });

  it("preferredEncoding 优先于自动候选，但对合法 UTF-8 保持透传", () => {
    const opts = { candidates: ["GB18030"], fallbackEncoding: "GB18030", preferredEncoding: "Big5" };
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const t1 = createOutputTranscoder(opts);
    expect(collect(t1, [gbk]).toString("utf-8")).toBe(iconv.decode(gbk, "Big5"));
    const utf8 = Buffer.from("已是 UTF-8\n", "utf-8");
    const t2 = createOutputTranscoder(opts);
    expect(collect(t2, [utf8]).equals(utf8)).toBe(true);
    expect(t2.stats().mode).toBe("passthrough");
  });

  it("累积至 sampleBytes 前暂存输出，finish 时统一输出", () => {
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const t = createOutputTranscoder({ candidates: ["GBK"], fallbackEncoding: "GBK", sampleBytes: 10 });
    const first = t.push(gbk.subarray(0, 5));
    expect(first.length).toBe(0);
    const rest = collect(t, [gbk.subarray(5)]);
    expect(rest.toString("utf-8")).toBe(GB_TEXT);
  });

  it("字节判定为 unknown 时：无显式编码则透传，有显式编码则转码并标记 lossy", () => {
    const bad = Buffer.concat([iconv.encode("订单", "GBK"), Buffer.from([0xff, 0xff])]);
    const t0 = createOutputTranscoder({ candidates: ["GB18030", "GBK"], fallbackEncoding: "GBK" });
    expect(collect(t0, [bad]).equals(bad)).toBe(true);
    expect(t0.stats().mode).toBe("binary-passthrough");
    const t1 = createOutputTranscoder({
      candidates: ["GB18030", "GBK"],
      fallbackEncoding: "GBK",
      preferredEncoding: "GBK",
    });
    const out = collect(t1, [bad]);
    expect(t1.stats().mode).toBe("transcoded");
    expect(t1.stats().lossy).toBe(true);
    expect(out.toString("utf-8")).toContain("订单");
  });

  it("空输出标记为 empty", () => {
    const t = createOutputTranscoder({ candidates: ["GBK"], fallbackEncoding: "GBK" });
    expect(collect(t, []).length).toBe(0);
    expect(t.stats().mode).toBe("empty");
  });

  it("末尾含合法 UTF-8 截断前缀时按 UTF-8 原样透传", () => {
    const full = Buffer.from("# " + "\u2500".repeat(40) + "\n", "utf-8");
    const cut = full.subarray(0, 120);
    expect(isUtf8ValidNow(cut)).toBe(false);
    expect(incompleteUtf8Tail(cut)).toBeGreaterThan(0);
    const t = createOutputTranscoder({ candidates: ["GB18030", "GBK", "GB2312", "Big5"], fallbackEncoding: "GBK" });
    const out = collect(t, [cut]);
    expect(out.equals(cut)).toBe(true);
    expect(t.stats().mode).toBe("passthrough");
  });

  it("ASCII 加末尾单个 GBK 汉字仍正常转码", () => {
    const mixed = Buffer.concat([Buffer.from("status ok ", "utf-8"), iconv.encode("好", "GBK")]);
    const t = createOutputTranscoder({ candidates: ["GB18030", "GBK"], fallbackEncoding: "GBK" });
    const out = collect(t, [mixed]);
    expect(t.stats().mode).toBe("transcoded");
    expect(out.toString("utf-8")).toBe("status ok 好");
  });

  it("incompleteUtf8Tail 边界测试", () => {
    expect(incompleteUtf8Tail(Buffer.from([0x41, 0xe2, 0x94]))).toBe(2);
    expect(incompleteUtf8Tail(Buffer.from([0x41, 0xf0, 0x9f, 0x98]))).toBe(3);
    expect(incompleteUtf8Tail(Buffer.from([0x41, 0xb4]))).toBe(0);
    expect(incompleteUtf8Tail(Buffer.from([0xe2, 0x94, 0x80]))).toBe(0);
    expect(incompleteUtf8Tail(Buffer.from("abc"))).toBe(0);
  });
});

describe("单文件查看命令识别", () => {
  it("识别单文件查看命令，跳过通配符与多文件参数", () => {
    expect(dumpCommandPath("type src/a.java")).toBe("src/a.java");
    expect(dumpCommandPath('cat "src/a b.java"')).toBe("src/a b.java");
    expect(dumpCommandPath("ls -la | cat src/a.java")).toBe("src/a.java");
    expect(dumpCommandPath("Get-Content src\\a.java")).toBe("src\\a.java");
    expect(dumpCommandPath("cat *.java")).toBeNull();
    expect(dumpCommandPath("cat a.java b.txt")).toBeNull();
    expect(dumpCommandPath("head -n 5 src/a.java")).toBe("src/a.java");
    expect(dumpCommandPath("javac Foo.java")).toBeNull();
  });

  it("GBK 文件返回其读编码，UTF-8 文件返回 null", async () => {
    const root = mkdtempSync(join(tmpdir(), "shell-dump-"));
    putConfig(root, { sourceEncoding: "GBK", transcodeBash: "auto" });
    const gbkFile = join(root, "G.java");
    writeFileSync(gbkFile, iconv.encode(GB_TEXT, "GBK"));
    expect(await fileDumpEncodingForCommand(`cat ${gbkFile}`, root)).toBeTruthy();
    const utf8File = join(root, "U.java");
    writeFileSync(utf8File, GB_TEXT, "utf-8");
    expect(await fileDumpEncodingForCommand(`cat ${utf8File}`, root)).toBeNull();
  });
});

describe("transcodeBash 配置归一化与开关", () => {
  it("normalizeBashMode 处理各类型输入并记录告警", () => {
    const w: string[] = [];
    expect(normalizeBashMode(undefined, "x", w)).toBe(false);
    expect(normalizeBashMode(false, "x", w)).toBe(false);
    expect(normalizeBashMode("off", "x", w)).toBe(false);
    expect(normalizeBashMode(true, "x", w)).toBe("auto");
    expect(normalizeBashMode("auto", "x", w)).toBe("auto");
    expect(normalizeBashMode("true", "x", w)).toBe("auto");
    expect(normalizeBashMode("gbk", "x", w)).toBe("GBK");
    expect(normalizeBashMode("UTF-8", "x", w)).toBe(false);
    expect(normalizeBashMode("ISO-2022-JP", "x", w)).toBe("auto");
    expect(normalizeBashMode("NOPE-99", "x", w)).toBe("auto");
    expect(normalizeBashMode(123, "x", w)).toBe(false);
    expect(w.length).toBeGreaterThanOrEqual(5);
  });

  it("shellRuleFor：无配置或 transcodeBash=false 时返回 null", () => {
    const root = mkdtempSync(join(tmpdir(), "shell-cfg-"));
    expect(shellRuleFor(root)).toBeNull();
    putConfig(root, { sourceEncoding: "GBK" });
    expect(shellRuleFor(root)).toBeNull();
    putConfig(root, { sourceEncoding: "GBK", transcodeBash: true });
    const rule = shellRuleFor(root)!;
    expect(rule.mode).toBe("auto");
    expect(rule.fileDump).toBe(true);
    putConfig(root, { sourceEncoding: "GBK", transcodeBash: "Big5", bashFileDump: false });
    clearConfigCache();
    const r2 = shellRuleFor(root)!;
    expect(r2.mode).toBe("Big5");
    expect(r2.fileDump).toBe(false);
  });
});

describe("makeTranscodingShellOperations", () => {
  const byteEmitter = (buf: Buffer) => ({
    exec: async (_cmd: string, _cwd: string, opts: { onData: (b: Buffer) => void }) => {
      for (let i = 0; i < buf.length; i += 3) opts.onData(buf.subarray(i, i + 3));
      return { exitCode: 0 };
    },
  });

  it("priorityEncoding 优先于 fallbackEncoding（避免英文控制台码页 437 抢占 GBK 判定）", () => {
    const bytes = iconv.encode(GB_TEXT, "GBK");
    const t = createOutputTranscoder({
      candidates: ["GB18030", "GBK", "GB2312", "Big5"],
      priorityEncoding: "GBK",
      fallbackEncoding: "cp437",
    });
    const out = collect(t, [bytes]);
    expect(out.toString("utf-8")).toBe(GB_TEXT);
    expect(t.stats().encoding).not.toBe("cp437");
    expect(t.stats().basis).toContain("候选互校");
  });

  it("transcodeBash 开启时将 GBK 输出转为 UTF-8 并记录提示", async () => {
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const rule = {
      mode: "auto" as const,
      fileDump: false,
      sourceEncoding: "GBK",
      autoCandidates: ["GB18030", "GBK", "GB2312", "Big5"],
      configDir: "/tmp",
      warnings: [],
    };
    const ops = makeTranscodingShellOperations(byteEmitter(gbk), rule);
    const out: Buffer[] = [];
    const r = await ops.exec("whatever", "/tmp", { onData: (b) => out.push(b) });
    expect(r.exitCode).toBe(0);
    const text = Buffer.concat(out).toString("utf-8");
    expect(text).toBe(GB_TEXT);
    expect(lastShellTranscodeStats()?.mode).toBe("transcoded");
    const notes = drainShellNotes();
    expect(notes.join(" ")).toContain("bash 输出已由");
    expect(notes.join(" ")).toContain("transcodeBash:false");
  });

  it("UTF-8 输出原样透传且不记录提示", async () => {
    const raw = Buffer.from("plain output 世界\n", "utf-8");
    const rule = {
      mode: "auto" as const,
      fileDump: false,
      sourceEncoding: "GBK",
      autoCandidates: ["GB18030", "GBK"],
      configDir: "/tmp",
      warnings: [],
    };
    const ops = makeTranscodingShellOperations(byteEmitter(raw), rule);
    const out: Buffer[] = [];
    await ops.exec("x", "/tmp", { onData: (b) => out.push(b) });
    expect(Buffer.concat(out).equals(raw)).toBe(true);
    expect(peekEncodingNotes("\u0000shell-output")).toEqual([]);
    expect(drainShellNotes()).toEqual([]);
  });

  it("子进程超时或报错时仍 flush 已输出的部分数据", async () => {
    const gbk = iconv.encode(GB_TEXT, "GBK");
    const base = {
      exec: async (_c: string, _cwd: string, opts: { onData: (b: Buffer) => void }) => {
        opts.onData(gbk.subarray(0, 8));
        throw new Error("timeout:5");
      },
    };
    const rule = {
      mode: "GBK" as const,
      fileDump: false,
      sourceEncoding: "GBK",
      autoCandidates: ["GBK"],
      configDir: "/tmp",
      warnings: [],
    };
    const out: Buffer[] = [];
    await expect(makeTranscodingShellOperations(base, rule).exec("x", "/tmp", { onData: (b) => out.push(b) })).rejects.toThrow(
      /timeout/,
    );
    expect(Buffer.concat(out).toString("utf-8")).toBe(iconv.decode(gbk.subarray(0, 8), "GBK"));
  });

  it("osConsoleEncoding 返回合法 iconv 编码名或 null", () => {
    const enc = osConsoleEncoding();
    if (enc) {
      expect(iconv.encodingExists(enc)).toBe(true);
      if (process.platform === "win32") {
        expect(["GB18030", "Big5", "CP932", "CP949", "windows-1252", "cp437", "cp850", "cp852", "cp866", "windows-1250", "windows-1251", "windows-1254", "windows-1256"]).toContain(enc);
      }
    }
  });
});

describe("readPiShellSettings", () => {
  it("读取项目级 .pi/settings.json 的 shellPath 与 shellCommandPrefix", () => {
    const root = mkdtempSync(join(tmpdir(), "piset-"));
    const dir = join(root, ".pi");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ shellPath: "/bin/bash", shellCommandPrefix: "shopt -s x" }));
    const s = readPiShellSettings(root);
    expect(s.shellPath).toBe("/bin/bash");
    expect(s.shellCommandPrefix).toBe("shopt -s x");
  });

  it("损坏或缺失 settings.json 时不抛错", () => {
    const root = mkdtempSync(join(tmpdir(), "piset2-"));
    writeFileSync(join(root, ".pi"), "not a dir");
    expect(() => readPiShellSettings(root)).not.toThrow();
    const s = readPiShellSettings(root);
    for (const v of Object.values(s)) expect(typeof v).toBe("string");
  });
});
