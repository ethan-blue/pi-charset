// Host integration tests: ExtensionAPI tool and command registration and discoverAndLoadExtensions loader verification.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import register from "../src/index";
import { PLUGIN_VERSION } from "../src/version";
import { clearConfigCache } from "../src/config";
import { clearClassifyCache } from "../src/encoding/classify";
import { clearReadBaselines } from "../src/operations";
import { clearEncodingNotes } from "../src/notify";

const pi = await import("@earendil-works/pi-coding-agent");
const { VERSION, discoverAndLoadExtensions } = pi as typeof pi & {
  discoverAndLoadExtensions: (
    configuredPaths: string[],
    cwd: string,
    agentDir?: string,
  ) => Promise<{ extensions: unknown[]; errors: { path: string; error: string }[] }>;
};

function hostPkgVersion(): string {
  let dir = fileURLToPath(new URL(".", import.meta.url));
  for (;;) {
    const pkgPath = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; version?: string };
      if (pkg.name === "@earendil-works/pi-coding-agent") return pkg.version!;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("cannot locate pi-coding-agent package.json");
    dir = parent;
  }
}

interface CapturedTool {
  name: string;
  execute: (id: string, input: Record<string, unknown>, ...rest: unknown[]) => Promise<{
    content?: { type: string; text?: string }[];
    isError?: boolean;
    details?: { diff?: string; patch?: string };
  }>;
}

function makeFakePi() {
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const piStub = {
    registerTool: (t: CapturedTool) => tools.set(t.name, t),
    registerCommand: (name: string, opts: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, opts),
    on: () => () => undefined,
  };
  return { piStub, tools, commands };
}

let root: string;
const prevCwd = process.cwd();
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  clearEncodingNotes();
  clearReadBaselines();
  root = mkdtempSync(join(tmpdir(), "charset-host-"));
  process.chdir(root);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("宿主与插件版本核对", () => {
  it("核对宿主 pi 版本", () => {
    expect(VERSION).toBe(hostPkgVersion());
    if (process.env.PI_HOST_VERSION) expect(VERSION).toBe(process.env.PI_HOST_VERSION);
  });
  it("PLUGIN_VERSION 与 package.json 版本一致", async () => {
    const pkg = JSON.parse(readFileSync(resolve(prevCwd, "package.json"), "utf-8")) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });
});

describe("扩展注册与工具调用", () => {
  it("注册 read/write/edit/grep 四工具与 /charset-status 命令", () => {
    const { piStub, tools, commands } = makeFakePi();
    register(piStub as never);
    expect([...tools.keys()].sort()).toEqual(["edit", "grep", "read", "write"]);
    expect(commands.has("charset-status")).toBe(true);
  });

  it("read -> edit -> read：GBK 文件中文替换并保持 GBK/CRLF", async () => {
    const { piStub, tools } = makeFakePi();
    register(piStub as never);
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK" }));
    const p = join(root, "sample.c");
    const original = iconv.encode("/* 中文旧值 */\r\nint value = 1;\r\n", "gbk");
    writeFileSync(p, original);

    const r1 = await tools.get("read")!.execute("r1", { path: p });
    expect(r1.isError !== true).toBe(true);
    expect(r1.content!.some((c) => c.text?.includes("中文旧值"))).toBe(true);

    const e = await tools.get("edit")!.execute("e1", { path: p, edits: [{ oldText: "中文旧值", newText: "中文新值" }] });
    expect(e.isError !== true).toBe(true);
    expect(typeof e.details?.diff).toBe("string");
    expect(readFileSync(p).equals(iconv.encode("/* 中文新值 */\r\nint value = 1;\r\n", "gbk"))).toBe(true);

    const r2 = await tools.get("read")!.execute("r2", { path: p });
    expect(r2.content!.some((c) => c.text?.includes("中文新值"))).toBe(true);
  });

  it("write -> read -> grep：新建 GBK 文件后混合编码目录搜索双侧命中", async () => {
    const { piStub, tools } = makeFakePi();
    register(piStub as never);
    writeFileSync(
      join(root, ".pi-charset.json"),
      JSON.stringify({
        sourceEncoding: "UTF-8",
        overrides: [{ pattern: "*.c", encoding: "GBK", writeEncoding: "GBK" }],
      }),
    );
    mkdirSync(join(root, "src"), { recursive: true });

    const w = await tools.get("write")!.execute("w1", {
      path: join(root, "src", "gbk源.c"),
      content: "int gbk文件 = 1;\n",
    });
    expect(w.isError !== true).toBe(true);
    expect(iconv.decode(readFileSync(join(root, "src", "gbk源.c")), "gbk")).toBe("int gbk文件 = 1;\n");

    writeFileSync(join(root, "src", "utf8注.md"), "同一关键词：gbk文件\n", "utf-8");

    const g = await tools.get("grep")!.execute("g1", { pattern: "gbk文件", path: join(root, "src") });
    const text = (g.content ?? []).map((c) => c.text ?? "").join("\n");
    expect(text.includes("gbk源.c")).toBe(true);
    expect(text.includes("utf8注.md")).toBe(true);
    expect(g.isError !== true).toBe(true);
  });

  it("混合换行文件：read 正常返回，edit 拒绝修改且字节不变", async () => {
    const { piStub, tools } = makeFakePi();
    register(piStub as never);
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK" }));
    const p = join(root, "mixed.c");
    const original = iconv.encode("/* 中文 */\r\nint a;\n", "gbk");
    writeFileSync(p, original);

    const r = await tools.get("read")!.execute("r1", { path: p });
    expect(r.content!.some((c) => c.text?.includes("int a;"))).toBe(true);

    await expect(tools.get("edit")!.execute("e1", { path: p, edits: [{ oldText: "int a;", newText: "int b;" }] }))
      .rejects.toThrow(/混合换行/);
    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it("读取后文件被外部修改：write 拒绝并保留外部内容", async () => {
    const { piStub, tools } = makeFakePi();
    register(piStub as never);
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK", writeEncoding: "GBK" }));
    const p = join(root, "stale.c");
    writeFileSync(p, iconv.encode("/* v1 */\r\n", "gbk"));

    await tools.get("read")!.execute("r1", { path: p });
    const external = iconv.encode("/* 外部 v2 */\r\n", "gbk");
    writeFileSync(p, external);

    await expect(tools.get("write")!.execute("w1", { path: p, content: "/* v1 改 */\r\n" })).rejects.toThrow(
      /外部修改|不一致/,
    );
    expect(readFileSync(p).equals(external)).toBe(true);
  });

  it("/charset-status 输出插件版本、Pi 版本、cwd 与配置位置", async () => {
    const { piStub, commands } = makeFakePi();
    register(piStub as never);
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK" }));
    const notes: string[] = [];
    await commands.get("charset-status")!.handler("", {
      ui: { notify: (m: string) => notes.push(m) },
    });
    const text = notes.join("\n");
    expect(text).toContain(PLUGIN_VERSION);
    expect(text).toContain(VERSION);
    expect(text).toContain(".pi-charset.json");
  });
});

describe("discoverAndLoadExtensions 加载器集成", () => {
  it("从源码路径加载扩展无错误", async () => {
    const extPath = resolve(prevCwd, "src", "index.ts");
    const result = await discoverAndLoadExtensions([extPath], root, root);
    expect(result.errors).toEqual([]);
    expect(result.extensions.length).toBeGreaterThan(0);
  });
});
