import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import {
  isUtf8FileCached,
  clearUtf8Cache,
  wrapEditToolWithEncodingPreview,
} from "../src/edit-preview";
import { makeEditOperations } from "../src/operations";
import { clearConfigCache } from "../src/config";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearUtf8Cache();
  root = mkdtempSync(join(tmpdir(), "preview-"));
});

describe("isUtf8FileCached 同步预览路由", () => {
  it("无配置目录：GB18030 文件同样返回 false（自适应路由至扩展预览），UTF-8 文件返回 true", () => {
    const f = join(root, "gb.py");
    writeFileSync(f, iconv.encode("# 旧的注释\n朱镕基\n", "GB18030"));
    expect(isUtf8FileCached(f)).toBe(false);

    const u8 = join(root, "u8.py");
    writeFileSync(u8, "# UTF-8 注释\n", "utf-8");
    expect(isUtf8FileCached(u8)).toBe(true);
  });

  it("有配置时 GB18030 文件返回 false（走扩展预览渲染）", () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "gb.py");
    writeFileSync(f, iconv.encode("# 旧的注释\n朱镕基\n", "GB18030"));
    expect(isUtf8FileCached(f)).toBe(false);
  });

  it("单字节编码按 force 配置路由至扩展预览", () => {
    writeFileSync(
      join(root, ".pi-charset.json"),
      JSON.stringify({
        sourceEncoding: "UTF-8",
        overrides: [{ pattern: "*.txt", encoding: "ISO-8859-1", force: true }],
      }),
    );
    const latin = join(root, "legacy.txt");
    writeFileSync(latin, Buffer.from("caf\u00e9 na\u00efve \u00fcber\n", "latin1"));
    expect(isUtf8FileCached(latin)).toBe(false);
    const outside = join(root, "other.md");
    writeFileSync(outside, "caf\u00e9 na\u00efve\n", "utf-8");
    expect(isUtf8FileCached(outside)).toBe(true);
  });

  it("UTF-8 中文、纯 ASCII、UTF-8 BOM 返回 true", () => {
    const a = join(root, "u8.txt");
    writeFileSync(a, "hello 世界\n");
    expect(isUtf8FileCached(a)).toBe(true);

    const b = join(root, "ascii.txt");
    writeFileSync(b, "plain ascii only\n");
    expect(isUtf8FileCached(b)).toBe(true);

    const c = join(root, "bom.txt");
    writeFileSync(c, "\uFEFFhello 世界\n", "utf-8");
    expect(isUtf8FileCached(c)).toBe(true);
  });

  it("按 mtime + size + 配置代数失效缓存", () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const f = join(root, "cache.txt");
    writeFileSync(f, "hello\n", "utf-8");
    expect(isUtf8FileCached(f)).toBe(true);

    writeFileSync(f, iconv.encode("你好\n", "GB18030"));
    const mt = statSync(f).mtimeMs + 1000;
    utimesSync(f, new Date(mt), new Date(mt));
    expect(isUtf8FileCached(f)).toBe(false);

    rmSync(join(root, ".pi-charset.json"));
    clearConfigCache();
    expect(isUtf8FileCached(f)).toBe(false);
    writeFileSync(f, "hello\n", "utf-8");
    const mt2 = statSync(f).mtimeMs + 2000;
    utimesSync(f, new Date(mt2), new Date(mt2));
    expect(isUtf8FileCached(f)).toBe(true);
  });

  it("文件尚不存在时返回 true", () => {
    expect(isUtf8FileCached(join(root, "nope.txt"))).toBe(true);
  });
});

describe("wrapEditToolWithEncodingPreview", () => {
  beforeEach(() => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
  });

  function makeTheme() {
    return {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
  }

  function fakeContext() {
    const state: Record<string, unknown> = {};
    return {
      state,
      lastComponent: undefined,
      invalidate: () => {},
      argsComplete: true,
    } as any;
  }

  it("GB 文件走扩展预览渲染，不调用内置 renderCall", () => {
    const f = join(root, "gb.py");
    writeFileSync(f, iconv.encode("# 旧的注释\nx = 1\n", "GB18030"));

    const base = createEditToolDefinition(root, { operations: makeEditOperations() }) as any;
    let builtinTouched = false;
    base.renderCall = () => {
      builtinTouched = true;
      return {} as any;
    };
    const wrapped = wrapEditToolWithEncodingPreview(base, makeEditOperations(), root) as any;

    const out = wrapped.renderCall({ path: f, edits: [{ oldText: "旧的注释", newText: "新的中文注释" }] }, makeTheme(), fakeContext());
    expect(out).toBeDefined();
    expect(builtinTouched).toBe(false);
  });

  it("UTF-8 文件委托内置 renderCall", () => {
    const f = join(root, "u8.txt");
    writeFileSync(f, "hello world\n", "utf-8");

    const base = createEditToolDefinition(root, { operations: makeEditOperations() }) as any;
    let builtinTouched = false;
    const builtinRender = base.renderCall;
    base.renderCall = (...a: any[]) => {
      builtinTouched = true;
      return builtinRender(...a);
    };
    const wrapped = wrapEditToolWithEncodingPreview(base, makeEditOperations(), root) as any;

    wrapped.renderCall({ path: f, edits: [{ oldText: "world", newText: "pi" }] }, makeTheme(), fakeContext());
    expect(builtinTouched).toBe(true);
  });

  it("GB 文件异步解析出中文 diff", async () => {
    const f = join(root, "gb2.py");
    writeFileSync(f, iconv.encode("# 旧的注释\nx = 1\n", "GB18030"));

    const base = createEditToolDefinition(root, { operations: makeEditOperations() }) as any;
    const wrapped = wrapEditToolWithEncodingPreview(base, makeEditOperations(), root) as any;

    const ctx = fakeContext();
    const out = wrapped.renderCall(
      { path: f, edits: [{ oldText: "旧的注释", newText: "新的中文注释" }] },
      makeTheme(),
      ctx,
    ) as any;
    const st0 = (ctx.state.callComponent ?? out) as { preview?: { diff?: string; error?: string } };
    for (let i = 0; i < 40 && !st0.preview; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const st = st0;
    expect(st.preview).toBeDefined();
    expect(st.preview!.error).toBeUndefined();
    expect(st.preview!.diff).toContain("新的中文注释");
    expect(st.preview!.diff).toContain("旧的注释");
  });

  it("GB 文件 oldText 不存在时记录 preview.error", async () => {
    const f = join(root, "gb3.py");
    writeFileSync(f, iconv.encode("# 旧注释\nx = 1\n", "GB18030"));

    const base = createEditToolDefinition(root, { operations: makeEditOperations() }) as any;
    const wrapped = wrapEditToolWithEncodingPreview(base, makeEditOperations(), root) as any;
    const ctx = fakeContext();
    wrapped.renderCall(
      { path: f, edits: [{ oldText: "不存在的文本", newText: "x" }] },
      makeTheme(),
      ctx,
    );
    const st0 = (ctx.state.callComponent ?? {}) as { preview?: { diff?: string; error?: string } };
    for (let i = 0; i < 40 && !st0.preview; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const st = st0;
    expect(st.preview).toBeDefined();
    expect(st.preview!.error).toBeTruthy();
    expect(st.preview!.diff).toBeUndefined();
  });
});
