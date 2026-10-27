import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { searchFiles, buildEncodingGroups, buildEncodingPasses, globDirPrefix, findRg } from "../src/grep";
import { clearConfigCache, type FoundConfig } from "../src/config";

let root: string;
beforeEach(() => {
  clearConfigCache();
  root = mkdtempSync(join(tmpdir(), "grep-"));
});

describe("globDirPrefix", () => {
  it("extracts the directory prefix before the first glob char", () => {
    expect(globDirPrefix("openspec/**")).toBe("openspec");
    expect(globDirPrefix("builder/jinja/templates/**")).toBe("builder/jinja/templates");
    expect(globDirPrefix("docs/**")).toBe("docs");
    expect(globDirPrefix(".config/**")).toBe(".config");
    expect(globDirPrefix("legacy/*.c")).toBe("legacy");
  });

  it("returns '.' for bare-filename / root-level patterns", () => {
    expect(globDirPrefix("*.py")).toBe(".");
    expect(globDirPrefix("*.md")).toBe(".");
  });
});

describe("buildEncodingGroups", () => {
  it("single default group when no overrides", () => {
    const found: FoundConfig = {
      config: { sourceEncoding: "GB18030" },
      configDir: "/proj",
    };
    const groups = buildEncodingGroups(found);
    expect(groups).toHaveLength(1);
    expect(groups[0].encoding).toBe("GB18030");
    expect(groups[0].includeDirs).toEqual([]);
    expect(groups[0].excludeDirs).toEqual([]);
  });

  it("splits default group (excluding override dirs) from override groups", () => {
    const found: FoundConfig = {
      config: {
        sourceEncoding: "GB18030",
        overrides: [
          { pattern: "openspec/**", encoding: "UTF-8" },
          { pattern: "docs/**", encoding: "UTF-8" },
        ],
      },
      configDir: "/proj",
    };
    const groups = buildEncodingGroups(found);
    const def = groups.find((g) => g.encoding === "GB18030")!;
    const utf = groups.find((g) => g.encoding === "UTF-8")!;
    expect(def).toBeTruthy();
    expect(def.excludeDirs.sort()).toEqual(["docs", "openspec"]);
    expect(def.includeDirs).toEqual([]);
    expect(utf).toBeTruthy();
    expect(utf.includeDirs.sort()).toEqual(["docs", "openspec"]);
  });

  it("override matching the default encoding does not create a separate group", () => {
    const found: FoundConfig = {
      config: {
        sourceEncoding: "GB18030",
        overrides: [{ pattern: "gbstuff/**", encoding: "GB18030" }],
      },
      configDir: "/proj",
    };
    const groups = buildEncodingGroups(found);
    expect(groups).toHaveLength(1);
    expect(groups[0].encoding).toBe("GB18030");
    expect(groups[0].excludeDirs).toEqual([]);
  });
});

describe("findRg", () => {
  it("returns a usable rg path in this environment", () => {
    const rg = findRg();
    expect(rg).toBeTruthy();
  });
});

const cfg = (o: Record<string, unknown> = { sourceEncoding: "UTF-8" }) =>
  writeFileSync(join(root, ".pi-charset.json"), JSON.stringify(o));

describe("searchFiles 多编码搜索", () => {
  it("finds ASCII pattern in a UTF-8 file", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "hello world\nfoo bar\n", "utf-8");
    const out = await searchFiles(root, { pattern: "foo" });
    expect(out).not.toBeNull();
    expect(out!.text).toContain("a.txt");
    expect(out!.text).toContain("foo bar");
  });

  it("GB18030 目录搜索中文命中", async () => {
    cfg({ sourceEncoding: "GB18030" });
    writeFileSync(join(root, "cn.txt"), iconv.encode("第一行\n这里有标记内容\n末行\n", "GB18030"));
    const out = await searchFiles(root, { pattern: "标记" });
    expect(out).not.toBeNull();
    expect(out!.text).toContain("cn.txt");
    expect(out!.text).toContain("这里有标记内容");
    expect(out!.searchedWith.length).toBeGreaterThan(1);
  });

  it("支持搜索配置树下的隐藏文件", async () => {
    cfg();
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".env"), "SECRET_TOKEN=abc\n", "utf-8");
    writeFileSync(join(root, ".github", "w.yml"), "SECRET_TOKEN: xyz\n", "utf-8");
    const out = await searchFiles(root, { pattern: "SECRET_TOKEN" });
    expect(out!.text).toContain(".env");
    expect(out!.text).toContain(".github/w.yml");
  });

  it("同目录混有 UTF-8 与 GBK 文件时双侧命中且按 file:line 去重", async () => {
    cfg({ sourceEncoding: "GB18030" });
    writeFileSync(join(root, "gb.txt"), iconv.encode("根目录标记\n", "GB18030"));
    writeFileSync(join(root, "u8.txt"), "文档里的标记\n", "utf-8");
    const out = await searchFiles(root, { pattern: "标记" });
    expect(out!.text).toContain("根目录标记");
    expect(out!.text).toContain("文档里的标记");
    const hits = out!.text.split("\n").filter((l) => l.includes("标记"));
    expect(hits).toHaveLength(2);
  });

  it("过滤 UTF-8 文件在 GBK 搜索趟下的乱码伪命中", async () => {
    cfg({ sourceEncoding: "GB18030" });
    const real = "中文报警";
    const utf8Bytes = Buffer.from(real, "utf-8");
    const mojibake = iconv.decode(utf8Bytes, "GBK");
    writeFileSync(join(root, "u8.txt"), utf8Bytes);
    const out = await searchFiles(root, { pattern: mojibake });
    expect(out!.text).toBe("No matches found");
  });

  it("respects glob include filter", async () => {
    cfg();
    writeFileSync(join(root, "keep.py"), "needle\n", "utf-8");
    writeFileSync(join(root, "skip.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", glob: "*.py" });
    expect(out!.text).toContain("keep.py");
    expect(out!.text).not.toContain("skip.txt");
  });

  it("excludes node_modules / .git / .svn by default", async () => {
    cfg();
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".svn"));
    writeFileSync(join(root, "node_modules", "x.txt"), "needle\n", "utf-8");
    writeFileSync(join(root, ".svn", "pristine.txt"), "needle\n", "utf-8");
    writeFileSync(join(root, "top.txt"), "needle\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle" });
    expect(out!.text).toContain("top.txt");
    expect(out!.text).not.toContain("x.txt");
    expect(out!.text).not.toContain("pristine");
  });

  it("literal mode treats pattern as fixed string", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "a.b\naxb\n", "utf-8");
    const out = await searchFiles(root, { pattern: "a.b", literal: true });
    expect(out!.text).toContain("a.b");
    expect(out!.text).not.toContain("axb");
  });

  it("ignoreCase matches case-insensitively", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "Hello NEEDLE\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", ignoreCase: true });
    expect(out!.text).toContain("NEEDLE");
  });

  it("context lines are decoded with the file's own encoding", async () => {
    cfg({ sourceEncoding: "GB18030" });
    writeFileSync(
      join(root, "a.txt"),
      iconv.encode("第一行 中文\n第二行 needle\n第三行 中文\n", "GB18030"),
    );
    const out = await searchFiles(root, { pattern: "needle", context: 1 });
    expect(out!.text).toContain("第一行 中文");
    expect(out!.text).toContain("第二行 needle");
    expect(out!.text).toContain("第三行 中文");
    expect(out!.text).toContain("a.txt-1- 第一行 中文");
  });

  it("returns 'No matches found'", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "hello\n", "utf-8");
    const out = await searchFiles(root, { pattern: "zzz_nope_xyz" });
    expect(out!.text).toBe("No matches found");
  });

  it("searches a single file when path points at a file", async () => {
    cfg();
    writeFileSync(join(root, "a.txt"), "needle here\n", "utf-8");
    writeFileSync(join(root, "b.txt"), "nothing\n", "utf-8");
    const out = await searchFiles(root, { pattern: "needle", path: "a.txt" });
    expect(out!.text).toContain("needle here");
    expect(out!.text).not.toContain("b.txt");
  });

  it("limit 截断提示与内置格式一致", async () => {
    cfg();
    for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.txt`), "needle\n", "utf-8");
    const mine = await searchFiles(root, { pattern: "needle", limit: 1 });
    expect(mine!.details.matchLimitReached).toBe(1);
    expect(mine!.text).toContain("1 matches limit reached. Use limit=2 for more, or refine pattern");
  });
});

describe("与内置 grep 的行为对齐", () => {
  it("无配置目录同样支持混合编码中文搜索", async () => {
    writeFileSync(join(root, "gb.c"), iconv.encode("/* 零配置中文标记 */\r\nint x = 1;\r\n", "GBK"));
    writeFileSync(join(root, "u8.md"), "# 零配置中文标记\n", "utf-8");
    const out = await searchFiles(root, { pattern: "零配置中文标记" });
    expect(out).not.toBeNull();
    expect(out!.text).toContain("gb.c");
    expect(out!.text).toContain("u8.md");
  });

  it("无配置目录命中结果集合与内置 grep 一致", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, ".hidden.txt"), "needle hidden\n", "utf-8");
    writeFileSync(join(root, "sub", "b.txt"), "中文 needle\n", "utf-8");
    const { createGrepToolDefinition } = await import("@earendil-works/pi-coding-agent");
    const { createEncodingGrepDefinition } = await import("../src/grep");
    type Def = { execute: (...a: unknown[]) => Promise<{ content: [{ text?: string }] }> };
    const call = async (def: Def) => {
      const r = await def.execute("tc", { pattern: "needle" }, undefined, () => {}, {} as never);
      return (r.content[0] as { text: string }).text;
    };
    const asDef = (d: unknown) => d as Def;
    const builtin = asDef(createGrepToolDefinition(root));
    const mine = asDef(createEncodingGrepDefinition(root));
    const a = (await call(mine)).split("\n").sort();
    const b = (await call(builtin)).split("\n").sort();
    expect(a).toEqual(b);
    expect(a.join("\n")).toContain(".hidden.txt:1: needle hidden");
    expect(a.join("\n")).toContain("sub/b.txt:1: 中文 needle");
  });

  it("findRg 优先命中 ~/.pi/agent/bin/rg", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const p = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg");
    if (!fs.existsSync(p)) return;
    const { resetRgCache } = await import("../src/grep");
    resetRgCache();
    expect(findRg()).toBe(p);
  });
});

describe("buildEncodingPasses", () => {
  const found = (config: unknown): FoundConfig => ({ config: config as never, configDir: root, warnings: [] });

  it("纯 ASCII pattern 只跑 UTF-8 一趟", () => {
    expect(buildEncodingPasses(found({ sourceEncoding: "GB18030", autoCandidates: ["GB18030"] }), "needle")).toEqual([
      "UTF-8",
    ]);
  });
  it("中文 pattern 将 GB 族合并为 GB18030 一趟", () => {
    const p = buildEncodingPasses(
      found({ sourceEncoding: "GBK", autoCandidates: ["GB18030", "GBK", "GB2312", "Big5"] }),
      "标记",
    );
    expect(p).toEqual(["UTF-8", "BIG5", "GB18030"]);
  });
  it("单字节编码不进入非 ASCII 搜索趟", () => {
    expect(
      buildEncodingPasses(
        found({ sourceEncoding: "UTF-8", overrides: [{ pattern: "*.properties", encoding: "ISO-8859-1" }] }),
        "标记",
      ),
    ).toEqual(["UTF-8"]);
  });
  it("override 声明的 Big5 进入搜索趟集合", () => {
    const p = buildEncodingPasses(
      found({ sourceEncoding: "UTF-8", overrides: [{ pattern: "tw/**", encoding: "Big5" }] }),
      "標記",
    );
    expect(p).toContain("BIG5");
  });
  it("无配置时：纯 ASCII pattern 仅跑 UTF-8，非 ASCII pattern 自动跑 UTF-8 + GB18030", () => {
    expect(buildEncodingPasses(null, "needle")).toEqual(["UTF-8"]);
    expect(buildEncodingPasses(null, "标记")).toEqual(["UTF-8", "GB18030"]);
  });
});
