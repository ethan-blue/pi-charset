import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNearestConfig, resolveOverrideEncoding, clearConfigCache } from "../src/config";

let root: string;
beforeEach(() => {
  clearConfigCache();
  root = mkdtempSync(join(tmpdir(), "cfg-"));
});

describe("findNearestConfig", () => {
  it("returns null when no config anywhere up the tree", async () => {
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(await findNearestConfig(deep)).toBeNull();
  });

  it("finds .pi-charset.json in the same dir", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK" }));
    const found = await findNearestConfig(root);
    expect(found?.config.sourceEncoding).toBe("GBK");
    expect(found?.configDir).toBe(root);
  });

  it("picks the deepest (nearest) config when nested", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GB18030" }));
    const sub = join(root, "legacy");
    mkdirSync(sub);
    writeFileSync(join(sub, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK" }));
    const found = await findNearestConfig(sub);
    expect(found?.config.sourceEncoding).toBe("GBK");
    expect(found?.configDir).toBe(sub);
  });

  it("applies defaults for missing fields", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({ sourceEncoding: "GBK" }));
    const found = await findNearestConfig(root);
    expect(found?.config.readStrategy).toBe("auto");
    expect(found?.config.unmappable).toBe("error");
    expect(found?.config.verifyWrite).toBe(true);
    expect(found?.config.protectUtf8).toBe(true);
  });
});

describe("resolveOverrideEncoding", () => {
  it("override glob is relative to configDir; most specific wins", async () => {
    writeFileSync(join(root, ".pi-charset.json"), JSON.stringify({
      sourceEncoding: "GB18030",
      overrides: [
        { pattern: "docs/**", encoding: "UTF-8" },
        { pattern: "docs/legacy/*.c", encoding: "GBK" },
      ],
    }));
    const found = (await findNearestConfig(root))!;
    expect(resolveOverrideEncoding(join(root, "docs", "readme.md"), found)).toBe("UTF-8");
    expect(resolveOverrideEncoding(join(root, "docs", "legacy", "x.c"), found)).toBe("GBK");
    expect(resolveOverrideEncoding(join(root, "src", "main.c"), found)).toBe("GB18030");
  });
});
