// Scale and cancellation tests for multi-encoding search across 2,000 mixed GBK and UTF-8 files.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { createEncodingGrepDefinition } from "../../src/grep";
import { clearConfigCache } from "../../src/config";
import { clearClassifyCache } from "../../src/encoding/classify";

let root: string;
beforeEach(() => {
  clearConfigCache();
  clearClassifyCache();
  root = mkdtempSync(join(tmpdir(), "charset-scale-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("2000 文件混合编码搜索与取消", () => {
  it("中文关键词全量搜索与 AbortSignal 取消", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "UTF-8" }));
    const N_DIRS = 40, PER_DIR = 50;
    const marker = "报警阈值";
    for (let d = 0; d < N_DIRS; d++) {
      const dir = join(root, `mod${d}`);
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < PER_DIR; i++) {
        const gbk = i % 2 === 0;
        const body = `// 模块 ${d} 文件 ${i}\nint ${marker}${gbk ? "A" : "B"} = ${i};\nint filler = ${d * 100 + i};\n`;
        writeFileSync(join(dir, `f${i}.${gbk ? "c" : "md"}`), gbk ? iconv.encode(body, "gbk") : Buffer.from(body, "utf-8"));
      }
    }

    const tool = createEncodingGrepDefinition(root);
    const exec = (
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{ content?: { type: string; text?: string }[] }> =>
      (tool.execute as unknown as (...args: unknown[]) => Promise<{ content?: { type: string; text?: string }[] }>)(
        "scale",
        input,
        signal,
        undefined,
        undefined,
      );
    const textOf = (r: { content?: { type: string; text?: string }[] }) =>
      (r.content ?? []).map((c) => c.text ?? "").join("\n");

    const t0 = Date.now();
    const res = await exec({ pattern: marker, path: root });
    const searchMs = Date.now() - t0;
    console.log(`2000 文件混合编码搜索：${searchMs}ms`);
    const gbkOnly = await exec({ pattern: marker, path: root, glob: "*.c" });
    const utf8Only = await exec({ pattern: marker, path: root, glob: "*.md" });
    const gbkText = textOf(gbkOnly);
    const utf8Text = textOf(utf8Only);
    const gbkHits = (gbkText.match(/mod\d+[/\\]f\d+\.c\b/g) ?? []).length;
    const utf8Hits = (utf8Text.match(/mod\d+[/\\]f\d+\.md\b/g) ?? []).length;
    console.log(`按编码分趟：GBK 命中 ${gbkHits} 个，UTF-8 命中 ${utf8Hits} 个`);
    void res;

    const ctrl = new AbortController();
    const t1 = Date.now();
    const pending = exec({ pattern: marker, path: root }, ctrl.signal);
    ctrl.abort();
    await pending;
    const cancelMs = Date.now() - t1;
    console.log(`搜索启动后取消耗时：${cancelMs}ms`);

    expect(gbkHits).toBeGreaterThan(0);
    expect(utf8Hits).toBeGreaterThan(0);
    expect(searchMs).toBeLessThan(120_000);
    expect(cancelMs).toBeLessThan(30_000);
  }, 180_000);
});
