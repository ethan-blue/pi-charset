// Tests for tools/scan-encoding.mjs argument validation, --init, and --damaged modes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import iconv from "iconv-lite";
import { stripJsonComments, findNearestConfigSync, resolveFileRule } from "../src/config";
import { resolveReadPlan } from "../src/resolve";

const TOOL = path.join(process.cwd(), "tools", "scan-encoding.mjs");
let root = "";

beforeAll(() => {
  root = mkdtemp("scan-init-");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkdtemp(prefix: string): string {
  const p = path.join(os.tmpdir(), prefix + Date.now() + "-" + Math.random().toString(36).slice(2, 7));
  mkdirSync(p, { recursive: true });
  return p;
}
function w(rel: string, content: string | Buffer, base = root) {
  const abs = path.join(base, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}
function gbk(text: string): Buffer {
  return iconv.encode(text, "GBK");
}
function init(dir: string, extra: string[] = []) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, dir, "--init", ...extra], { encoding: "utf-8", maxBuffer: 64 << 20 });
    return { stdout, code: 0 };
  } catch (e: any) {
    return { stdout: String(e.stdout || "") + String(e.stderr || ""), code: typeof e.status === "number" ? e.status : -1 };
  }
}
function run(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], { encoding: "utf-8", maxBuffer: 64 << 20 });
    return { stdout, code: 0 };
  } catch (e: any) {
    return { stdout: String(e.stdout || "") + String(e.stderr || ""), code: typeof e.status === "number" ? e.status : -1 };
  }
}
function readCfg(dir: string) {
  const f = path.join(dir, ".pi-charset.json");
  expect(existsSync(f)).toBe(true);
  return JSON.parse(stripJsonComments(readFileSync(f, "utf-8")));
}

describe("scan-encoding --init", () => {
  it("1. 多候选歧义的 GBK 工程选取最窄覆盖编码 GBK", () => {
    const d = mkdtemp("narrow-");
    for (let n = 0; n < 6; n++) w(`src/F${n}.java`, gbk(`/** 订单服务第${n}个，报警阈值=85.5 。*/ class F${n}{}`), d);
    const r = init(d);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已写出");
    const cfg = readCfg(d);
    expect(cfg.sourceEncoding).toBe("GBK");
    expect(cfg.writeEncoding).toBe("GBK");
    const head = readFileSync(path.join(d, ".pi-charset.json"), "utf-8");
    expect(head).toContain("最窄");
    expect(head).toContain("sourceEncoding = GBK");
  });

  it("2. 存在 GB18030 四字节扩展区字符时选为 GB18030", () => {
    const d = mkdtemp("wide-");
    for (let n = 0; n < 5; n++) w(`src/G${n}.java`, gbk(`/** 普通中文${n} */ class G${n}{}`), d);
    w("src/Ext.java", iconv.encode("/** 扩展区汉字 \uD840\uDC0B 尾 */ class Ext{}", "GB18030"), d);
    expect(init(d).code).toBe(0);
    expect(readCfg(d).sourceEncoding).toBe("GB18030");
  });

  it("3. 工程声明优先于字节推断，且 GBK 文件仍按字节判定读取", async () => {
    const d = mkdtemp("decl-");
    w("pom.xml", "<project><properties><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties></project>\n", d);
    const java = w("src/A.java", gbk("/** 中文注释 。*/ class A{}"), d);
    const r = init(d);
    expect(r.stdout).toContain("工程声明");
    expect(readCfg(d).sourceEncoding).toBe("UTF-8");
    const found = findNearestConfigSync(d);
    expect(found).toBeTruthy();
    const plan = await resolveReadPlan(java);
    expect(plan).not.toBeNull();
    expect(plan!.transcoded).toBe(true);
    expect(/^GB(18030|K)$/.test(plan!.encoding)).toBe(true);
    expect(plan!.kind).toBe("cjk");
    void resolveFileRule;
  });

  it("4. 提取 Eclipse 路径级声明为 override，跳过与字节矛盾的声明", () => {
    const d = mkdtemp("eclipse-");
    w(
      ".settings/org.eclipse.core.resources.prefs",
      [
        "eclipse.preferences.version=1",
        "encoding//modern/js/a=UTF-8",
        "encoding//wrong/x.js=GBK",
      ].join("\n") + "\n",
      d,
    );
    for (let n = 0; n < 6; n++) w(`modern/js/a/F${n}.js`, `var v=${n}; // 中文注释\r\n`, d);
    for (let n = 0; n < 4; n++) w(`src/S${n}.java`, gbk(`/** 服务${n} 。*/ class S${n}{}`), d);
    w("wrong/x.js", Buffer.from("var ok = 1; // 中文注释\n", "utf-8"), d);
    const r = init(d);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("没采纳声明 wrong/x.js");
    const cfg = readCfg(d);
    expect(cfg.sourceEncoding).toBe("GBK");
    const pats = cfg.overrides.map((o: any) => o.pattern);
    expect(pats).toContain("modern/js/a/**");
    expect(pats.find((p: string) => p.includes("wrong"))).toBeUndefined();
  });

  it("5. 已存在配置时拒绝覆盖，--force 覆盖，--dry-run 不写盘", () => {
    const d = mkdtemp("force-");
    for (let n = 0; n < 4; n++) w(`src/T${n}.java`, gbk(`/** 中文${n} 。*/ class T${n}{}`), d);
    expect(init(d).code).toBe(0);
    const mine = '{ "sourceEncoding": "Big5", "writeEncoding": "Big5" }\n';
    const cfgPath = path.join(d, ".pi-charset.json");
    writeFileSync(cfgPath, mine, "utf-8");

    const again = init(d);
    expect(again.code).not.toBe(0);
    expect(again.stdout).toContain("未改动");
    expect(readFileSync(cfgPath, "utf-8")).toBe(mine);

    const dry = init(d, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("磁盘未动");
    expect(readFileSync(cfgPath, "utf-8")).toBe(mine);

    expect(init(d, ["--force"]).code).toBe(0);
    expect(readFileSync(cfgPath, "utf-8")).not.toBe(mine);
    expect(readCfg(d).sourceEncoding).toBe("GBK");
  });

  it("6. 纯 UTF-8 工程生成 UTF-8 配置", () => {
    const d = mkdtemp("utf8only-");
    for (let n = 0; n < 5; n++) w(`src/U${n}.java`, `/** 中文注释${n} 。*/ class U${n}{}`, d);
    expect(init(d).code).toBe(0);
    expect(readCfg(d).sourceEncoding).toBe("UTF-8");
  });

  it("7. 生成的配置文件通过扩展自身校验且无警告", () => {
    const d = mkdtemp("parse-");
    for (let n = 0; n < 4; n++) w(`src/V${n}.java`, gbk(`/** 中文${n} 。*/ class V${n}{}`), d);
    w("src/Prop.properties", gbk("k=中文值\r\n"), d);
    expect(init(d).code).toBe(0);
    const abs = findNearestConfigSync(d)!;
    const rule = resolveFileRule(path.join(d, "src/V0.java"), abs);
    expect(rule.warnings.length).toBe(0);
    expect(rule.unmappable).toBe("error");
    expect(rule.verifyWrite).toBe(true);
    expect(rule.protectUtf8).toBe(true);
  });

  it("8. 目录多数推断：为非 ASCII 中 UTF-8 占比 >=70% 且数量 >=8 的最浅目录生成 override", () => {
    const d = mkdtemp("dirmajor-");
    for (let n = 0; n < 6; n++) w(`src/S${n}.java`, gbk(`/** 服务${n} 。*/ class S${n}{}`), d);
    for (let n = 0; n < 10; n++) w(`WebContent/page/p${n}.jsp`, `<%-- 订单页面${n}：报警阈值=85.5 --%>`, d);
    for (let n = 0; n < 2; n++) w(`WebContent/page/legacy${n}.jsp`, gbk(`<%-- 旧页面${n}：遗留编码 --%>`), d);
    const r = init(d);
    expect(r.code).toBe(0);
    const cfg = readCfg(d);
    expect(cfg.sourceEncoding).toBe("GBK");
    const pats = cfg.overrides.map((o: any) => o.pattern);
    expect(pats).toContain("WebContent/**");
    expect(pats).not.toContain("WebContent/page/**");
    expect(r.stdout).toContain("WebContent/** → UTF-8");
    expect(r.stdout).toContain("占");
  });

  it("9. 非法参数与漏写 -- 前缀时返回退出码 2", () => {
    const d = mkdtemp("args-");
    for (let n = 0; n < 3; n++) w(`src/W${n}.java`, gbk(`/** 中文${n} 。*/ class W${n}{}`), d);
    const typo = run([d, "init"]);
    expect(typo.code).toBe(2);
    expect(typo.stdout).toContain("缺少前缀");
    expect(typo.stdout).toContain("--init");
    expect(existsSync(path.join(d, ".pi-charset.json"))).toBe(false);
    const bogus = run([d, "--int"]);
    expect(bogus.code).toBe(2);
    expect(bogus.stdout).toContain("未知参数");
    expect(run([d, "--init", "--out", path.join(d, "r.csv")]).code).toBe(0);
  });

  it("10. --damaged 输出已损坏文件列表且排除 .pi-charset.json 自身", () => {
    const d = mkdtemp("damaged-");
    for (let n = 0; n < 3; n++) w(`src/X${n}.java`, gbk(`/** 中文${n} 。*/ class X${n}{}`), d);
    w("src/Broken.java", Buffer.from("/** 损坏注释 \uFFFD\uFFFD */ class Broken{}", "utf-8"), d);
    expect(init(d).code).toBe(0);
    const r = run([d, "--damaged"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已经被毁的文件");
    expect(r.stdout).toContain("src/Broken.java");
    expect(r.stdout).not.toContain(".pi-charset.json");
    expect(r.stdout).not.toContain("行尾风格");
    expect(r.stdout).not.toContain("--------");
  });
});
