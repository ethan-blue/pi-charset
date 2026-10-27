#!/usr/bin/env node
// Directory encoding scanner and .pi-charset.json generator.
//
// Classification order (matching src/encoding/classify.ts):
//   empty -> UTF-8 BOM -> UTF-16LE/BE BOM -> NUL in first 8192B (binary) -> pure ASCII
//   -> strict full-file UTF-8 -> lossless multi-byte CJK round-trip without U+FFFD -> unknown
//
// Usage:
//   node tools/scan-encoding.mjs <root> [--ext java,jsp,xml] [--out report.csv]
//        [--max-mb 50] [--list-unknown] [--damaged]
//   node tools/scan-encoding.mjs <root> --init [--force] [--dry-run]
import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";

const argv = process.argv.slice(2);
const root = argv[0] && !argv[0].startsWith("--") ? path.resolve(argv[0]) : process.cwd();
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
};
const extFilter = String(flag("ext", "") || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const outCsv = flag("out", null);
const maxBytes = Number(flag("max-mb", 50)) * 1024 * 1024;
const listUnknown = !!flag("list-unknown", false);
const doInit = !!flag("init", false);
const forceInit = !!flag("force", false);
const dryRun = !!flag("dry-run", false);
const damagedOnly = !!flag("damaged", false);

const BOOL_FLAGS = new Set(["list-unknown", "init", "force", "dry-run", "damaged"]);
const VALUE_FLAGS = new Set(["ext", "out", "max-mb"]);
(() => {
  const known = new Set([...BOOL_FLAGS, ...VALUE_FLAGS]);
  const args = argv.slice(argv[0] && !argv[0].startsWith("--") ? 1 : 0);
  const problems = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!known.has(name)) {
        const near = [...known].find((k) => k.startsWith(name.slice(0, 3)));
        problems.push(`未知参数 ${a}${near ? `（是否指 --${near}？）` : ""}`);
        continue;
      }
      if (VALUE_FLAGS.has(name)) i++;
    } else if (known.has(a)) {
      problems.push(`参数 ${a} 缺少前缀：请写 --${a}`);
    } else {
      problems.push(`多余的位置参数 ${a}（仅接受一个目录参数与 -- 选项）`);
    }
  }
  if (problems.length) {
    console.error("[ERROR] " + problems.join("\n[ERROR] "));
    console.error(
      "用法：node tools/scan-encoding.mjs <目录> [--init [--force]] [--dry-run] [--damaged] [--out report.csv] [--ext java,jsp] [--max-mb 50] [--list-unknown]",
    );
    process.exit(2);
  }
})();

const SKIP_DIRS = new Set([".git", ".svn", ".hg", ".idea", "node_modules", ".pi"]);
const BINARY_EXT = new Set([
  "class", "jar", "war", "ear", "zip", "gz", "tgz", "bz2", "7z", "rar",
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "tif", "tiff", "webp",
  "ttf", "otf", "eot", "woff", "woff2", "pdf", "doc", "docx", "xls", "xlsx",
  "ppt", "pptx", "so", "dll", "exe", "bin", "dat", "jks", "keystore", "ser",
  "mp3", "mp4", "avi", "swf", "flv", "wav", "mar", "xdb", "scc",
]);
const CANDIDATES = ["GB18030", "GBK", "GB2312", "Big5", "Shift_JIS", "EUC-KR", "EUC-JP"];
// When no project declaration exists, pick the narrowest encoding covering all observed files (skipping GB2312).
const FAMILY_ORDER = ["GBK", "Big5", "Shift_JIS", "EUC-KR", "EUC-JP", "GB18030"];

const startsWith = (b, sig) => sig.every((x, i) => b[i] === x);
const hasNul = (b, limit = 8192) => b.subarray(0, Math.min(b.length, limit)).includes(0);
const isAllAscii = (b) => { for (let i = 0; i < b.length; i++) if (b[i] > 0x7f) return false; return true; };
function isValidUtf8(b) { try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } }
const roundTrips = (b, e) => { try { return Buffer.compare(iconv.encode(iconv.decode(b, e), e), b) === 0; } catch { return false; } };

function classify(b) {
  if (b.length === 0) return { kind: "empty", enc: "UTF-8", pass: [] };
  if (startsWith(b, [0xef, 0xbb, 0xbf])) return { kind: "utf8-bom", enc: "UTF-8", pass: [] };
  if (startsWith(b, [0xff, 0xfe])) return { kind: "utf16le", enc: "UTF-16LE", pass: [] };
  if (startsWith(b, [0xfe, 0xff])) return { kind: "utf16be", enc: "UTF-16BE", pass: [] };
  if (hasNul(b)) return { kind: "binary", enc: "BINARY", pass: [] };
  if (isAllAscii(b)) return { kind: "ascii", enc: "UTF-8", pass: [] };
  if (isValidUtf8(b)) return { kind: "utf8", enc: "UTF-8", pass: [] };
  const pass = CANDIDATES.filter((e) => roundTrips(b, e) && !iconv.decode(b, e).includes("\ufffd"));
  if (pass.length === 0) return { kind: "unknown", enc: "UNKNOWN", pass: [] };
  return { kind: "cjk", enc: pass[0], pass };
}

const lineEndingOf = (b) => {
  let crlf = 0, lf = 0;
  const n = Math.min(b.length, 262144);
  for (let i = 0; i < n; i++) {
    if (b[i] === 0x0d && b[i + 1] === 0x0a) { crlf++; i++; }
    else if (b[i] === 0x0a) lf++;
  }
  return crlf === 0 && lf === 0 ? "none" : crlf === 0 ? "LF" : lf === 0 ? "CRLF" : crlf >= lf ? "CRLF*" : "LF*";
};

const rows = [];
const stats = new Map();
const anomalies = { unknown: [], ambiguous: [], utf8InGbTree: [], gb18030Only: [], oversize: [], bom: [] };
const damaged = [];
let scanned = 0, skippedBinary = 0;

function bump(ext, key) {
  if (!stats.has(ext)) stats.set(ext, {});
  const s = stats.get(ext);
  s[key] = (s[key] || 0) + 1;
}

(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
    if (e.isSymbolicLink && e.isSymbolicLink()) continue;
    const ext = path.extname(e.name).replace(/^\./, "").toLowerCase() || "(noext)";
    if (extFilter.length && !extFilter.includes(ext)) continue;
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (BINARY_EXT.has(ext)) { bump(ext, "binary"); skippedBinary++; continue; }
    if (st.size > maxBytes) { bump(ext, "oversize"); anomalies.oversize.push([p, st.size]); continue; }
    const b = fs.readFileSync(p);
    const c = classify(b);
    bump(ext, c.kind);
    bump(ext, `eol:${lineEndingOf(b)}`);
    if (c.kind !== "ascii") bump(ext, `eol-nonascii:${lineEndingOf(b)}`);
    scanned++;
    let fffd = 0;
    if (c.kind !== "binary" && c.kind !== "unknown" && c.kind !== "ascii") {
      try {
        const text = c.kind === "utf8" || c.kind === "utf8-bom" ? b.toString("utf-8") : iconv.decode(b, c.enc);
        fffd = (text.match(/\ufffd/g) || []).length;
        if (/锟斤拷/.test(text)) fffd = Math.max(fffd, 1);
      } catch {
        /* ignore */
      }
    }
    const rel = path.relative(root, p).replace(/\\/g, "/");
    // Exclude the configuration file itself (its header comments mention U+FFFD and mojibake examples).
    if (fffd && !/(^|\/)\.pi-charset\.json(\.|$)/.test(rel)) damaged.push([rel, c.kind, fffd]);
    rows.push({ rel, ext, kind: c.kind, enc: c.enc, pass: c.pass.join("|"), size: st.size, eol: lineEndingOf(b), fffd });
    if (c.kind === "unknown") anomalies.unknown.push([rel, st.size]);
    if (c.kind === "cjk" && c.pass.length > 1) {
      const only18030 = c.pass.length === 1 && c.pass[0] === "GB18030" ? false : !c.pass.includes("GBK") && c.pass.includes("GB18030");
      anomalies.ambiguous.push([rel, c.pass.join(">"), only18030]);
    }
    if (c.kind === "cjk" && c.pass.length === 1 && c.pass[0] === "GB18030") anomalies.gb18030Only.push(rel);
    if (c.kind === "utf8" || c.kind === "utf8-bom") anomalies.utf8InGbTree.push(rel);
    if (c.kind === "utf8-bom") anomalies.bom.push(rel);
  }
})(root);

if (damagedOnly) {
  damaged.sort((a, b) => b[2] - a[2]);
  const totalFffd = damaged.reduce((s, d) => s + d[2], 0);
  console.log(`扫描根目录: ${root}`);
  console.log(`实际判定文件数: ${scanned}（跳过已知二进制扩展名 ${skippedBinary} 个）`);
  console.log(`\n已经被毁的文件（内容含 U+FFFD 或「锟斤拷」）：${damaged.length} 个，共 ${totalFffd} 处替换字符`);
  if (!damaged.length) console.log("    （无）");
  else damaged.forEach(([f, kind, n]) => console.log(`    ${String(n).padStart(4)} 处  [${kind}]  ${f}`));
  process.exit(0);
}

const KINDS = ["ascii", "utf8", "utf8-bom", "utf16le", "utf16be", "cjk", "unknown", "binary", "empty", "oversize"];
console.log(`\n扫描根目录: ${root}`);
console.log(`实际判定文件数: ${scanned}（跳过已知二进制扩展名 ${skippedBinary} 个）\n`);
const header = ["ext".padEnd(9), ...KINDS.map((k) => k.slice(0, 7).padStart(8)), "文件数".padStart(8)];
console.log(header.join(" "));
console.log("-".repeat(header.join(" ").length));
const sorted = [...stats.entries()].sort((a, b) => {
  const sa = Object.values(a[1]).reduce((x, y) => x + y, 0);
  const sb = Object.values(b[1]).reduce((x, y) => x + y, 0);
  return sb - sa;
});
for (const [ext, s] of sorted) {
  const total = KINDS.reduce((acc, k) => acc + (s[k] || 0), 0);
  console.log(
    ext.padEnd(9),
    ...KINDS.map((k) => String(s[k] || 0).padStart(8)),
    String(total).padStart(8),
  );
}
console.log("\n行尾风格（仅统计文本文件；CRLF*=混合行尾且以 CRLF 为主）");
for (const [ext, s] of sorted) {
  const t = ["CRLF", "LF", "CRLF*", "LF*", "none"].map((k) => `${k}:${s[`eol:${k}`] || 0}`).join(" ");
  if (s.ascii || s.utf8 || s.cjk || s["utf8-bom"]) {
    console.log(
      `  ${ext.padEnd(9)} 全部[${t}]  含非ASCII[${["CRLF", "LF", "CRLF*", "LF*", "none"].map((k) => `${k}:${s[`eol-nonascii:${k}`] || 0}`).join(" ")}]`,
    );
  }
}

const gb = rows.filter((r) => r.kind === "cjk");
console.log(`\n多字节 CJK 判定明细（共 ${gb.length} 个文件）`);
const passStat = new Map();
for (const r of gb) passStat.set(r.pass, (passStat.get(r.pass) || 0) + 1);
[...passStat.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  候选链: ${k}`));
console.log(`  -> GBK 可无损回环: ${gb.filter((r) => r.pass.split("|").includes("GBK")).length}`);
console.log(`  -> 仅 GB18030 可回环（含 4 字节扩展区字符）: ${anomalies.gb18030Only.length}`);
console.log(`  -> 歧义（多候选同时通过）: ${anomalies.ambiguous.length}`);

console.log(`\n含非 ASCII 的合法 UTF-8 文件: ${anomalies.utf8InGbTree.length}`);
anomalies.utf8InGbTree.slice(0, listUnknown ? 99999 : 15).forEach((f) => console.log(`    ${f}`));
if (anomalies.utf8InGbTree.length > 15 && !listUnknown) console.log(`    ... 共 ${anomalies.utf8InGbTree.length} 个，用 --list-unknown 查看全部`);
console.log(`\nUTF-8 BOM 文件: ${anomalies.bom.length}`);
anomalies.bom.slice(0, 10).forEach((f) => console.log(`    ${f}`));
console.log(`\nunknown（非合法 UTF-8，且无法被候选编码无损回环）: ${anomalies.unknown.length}`);
anomalies.unknown.slice(0, 15).forEach(([f, sz]) => console.log(`    ${f} (${sz}B)`));
if (anomalies.oversize.length) console.log(`\noversize(>${maxBytes / 1048576}MB，未判定): ${anomalies.oversize.length}`);

damaged.sort((a, b) => b[2] - a[2]);
const totalFffd = damaged.reduce((a, d) => a + d[2], 0);
console.log(`\n已经被毁的文件（内容含 U+FFFD 或「锟斤拷」）：${damaged.length} 个，共 ${totalFffd} 处替换字符`);
damaged.slice(0, listUnknown ? 99999 : 20).forEach(([f, kind, n]) => console.log(`    ${String(n).padStart(4)} 处  [${kind}]  ${f}`));
if (damaged.length > 20 && !listUnknown) console.log(`    ... 共 ${damaged.length} 个，用 --list-unknown 查看全部`);

if (outCsv) {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  fs.writeFileSync(
    outCsv,
    ["file,ext,kind,chosen,candidates,size,eol,fffd", ...rows.map((r) => [esc(r.rel), r.ext, r.kind, r.enc, esc(r.pass), r.size, r.eol, r.fffd].join(","))].join("\n"),
    "utf-8",
  );
  console.log(`\nCSV 明细已写出: ${outCsv}（${rows.length} 行）`);
}

if (doInit) initFromProfile();

function normEnc(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const k = raw.toLowerCase().replace(/[\s_]/g, "");
  const map = {
    utf8: "UTF-8", "utf-8": "UTF-8", u8: "UTF-8",
    gbk: "GBK", cp936: "GBK", "windows-936": "GBK", ms936: "GBK", chinese: "GBK", "gb-cp936": "GBK",
    gb2312: "GB2312", "euc-cn": "GB2312", "gb_2312-80": "GB2312", gbkgb2312: "GB2312",
    gb18030: "GB18030", cp54936: "GB18030",
    big5: "Big5", cp950: "Big5", big5hkscs: "Big5_HKSCS",
    "shift-jis": "Shift_JIS", shiftjis: "Shift_JIS", sjis: "Shift_JIS", cp932: "Shift_JIS", ms932: "Shift_JIS",
    "euc-kr": "EUC-KR", ksc5601: "EUC-KR", cp949: "EUC-KR", uhc: "EUC-KR",
    "euc-jp": "EUC-JP", ujis: "EUC-JP", cp51932: "EUC-JP",
    "iso-8859-1": "ISO-8859-1", latin1: "ISO-8859-1", "8859-1": "ISO-8859-1", l1: "ISO-8859-1", cp819: "ISO-8859-1",
    cp1252: "windows-1252", "windows-1252": "windows-1252", "x-cp1252": "windows-1252",
    utf16le: "UTF-16LE", unicode: "UTF-16LE", "utf-16le": "UTF-16LE",
    utf16be: "UTF-16BE", "utf-16be": "UTF-16BE",
    ascii: "ASCII", "us-ascii": "ASCII", ansi_x3_4_1968: "ASCII",
  };
  const hit = map[k];
  if (hit) {
    try {
      return iconv.encodingExists(hit) ? hit : null;
    } catch {
      return null;
    }
  }
  try {
    return iconv.encodingExists(raw) ? raw : null;
  } catch {
    return null;
  }
}

function findDeclFiles(dir, depth, acc) {
  if (depth > 4 || acc.length > 200) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === ".svn" || e.name === "node_modules" || e.name === "target" || e.name === "build" || e.name === "dist") continue;
      findDeclFiles(p, depth + 1, acc);
    } else if (
      /^(org\.eclipse\.core\.resources\.prefs|encodings\.xml|pom\.xml|build\.gradle|build\.gradle\.kts|\.editorconfig|\.gitattributes)$/.test(e.name)
    ) {
      acc.push(p);
    }
  }
  return acc;
}

function collectDeclarations() {
  const out = [];
  for (const abs of findDeclFiles(root, 0, [])) {
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.size > 400_000) continue;
    let txt;
    try {
      txt = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const projDir = path.posix.dirname(path.posix.dirname(rel));
    const base = projDir === "." || projDir === ".." ? "" : projDir;
    const toRoot = (p) => (base ? `${base}/${p}` : p);
    const fixPath = (p) => {
      const absPath = p.replace(/^\/+/, "");
      const candA = toRoot(absPath);
      const candB = absPath;
      if (fs.existsSync(path.join(root, candA))) return candA;
      if (fs.existsSync(path.join(root, candB))) return candB;
      return candA;
    };
    if (rel.endsWith("org.eclipse.core.resources.prefs")) {
      for (const line of txt.split(/\r?\n/)) {
        const m = /^encoding(\/\/.+|\/[^/=]+|\/<project>)=\s*([^\s]+)\s*$/.exec(line.trim());
        if (!m) continue;
        const enc = normEnc(m[2]);
        if (!enc) continue;
        const key = m[1];
        if (key.endsWith("<project>")) {
          out.push({ scope: base || ".", encoding: enc, source: `${rel}: ${line.trim()}`, kind: "root" });
        } else {
          const p = fixPath(key.replace(/^\/\//, "/").replace(/^\//, ""));
          out.push({ scope: p, encoding: enc, source: `${rel}: ${line.trim()}`, kind: "path" });
        }
      }
    } else if (rel.endsWith("encodings.xml")) {
      for (const m of txt.matchAll(/<encoding\s+package="([^"]*)"[^>]*charset="([^"]+)"/g)) {
        const enc = normEnc(m[2]);
        if (enc) out.push({ scope: m[1] || ".", encoding: enc, source: `${rel}: package=${m[1] || "(default)"}`, kind: m[1] ? "path" : "root" });
      }
      for (const m of txt.matchAll(/<component name="ProjectEncodings"[^>]*encoding="([^"]+)"/g)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: base || ".", encoding: enc, source: `${rel}: 工程默认`, kind: "root" });
      }
    } else if (rel.endsWith("pom.xml")) {
      for (const m of txt.matchAll(/<(?:project\.)?build\.sourceEncoding>([^<]+)</g)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: base || ".", encoding: enc, source: `${rel}: <${m[0].slice(1, -1).split(">")[0]}>`, kind: "root" });
      }
    } else if (/build\.gradle(\.kts)?$/.test(rel)) {
      for (const m of txt.matchAll(/(?:encoding|charset)\s*[=(]?\s*["']([A-Za-z0-9_.-]+)["']/g)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: base || ".", encoding: enc, source: `${rel}: ${m[0].trim()}`, kind: "root" });
      }
    } else if (rel.endsWith(".editorconfig")) {
      for (const m of txt.matchAll(/^charset\s*=\s*([a-z0-9-]+)\s*$/gim)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: base || ".", encoding: enc, source: `${rel}: charset=${m[1]}`, kind: "root" });
      }
    } else if (rel.endsWith(".gitattributes")) {
      for (const m of txt.matchAll(/working-tree-encoding\s*=\s*([A-Za-z0-9_.-]+)/g)) {
        const enc = normEnc(m[1]);
        if (enc) out.push({ scope: "(gitattributes)", encoding: enc, source: `${rel}: working-tree-encoding=${m[1]}`, kind: "git" });
      }
    }
  }
  return out;
}

function initFromProfile() {
  const target = path.join(root, ".pi-charset.json");
  if (!dryRun && fs.existsSync(target) && !forceInit) {
    console.log(`\n[WARN] 已存在 ${target}，未改动（覆盖请加 --force；预览请加 --dry-run）。`);
    process.exitCode = 1;
    return;
  }
  const cjkRows = rows.filter((r) => r.kind === "cjk");
  const utf8Rows = rows.filter((r) => r.kind === "utf8" || r.kind === "utf8-bom");
  const asciiRows = rows.filter((r) => r.kind === "ascii");
  const unknownRows = rows.filter((r) => r.kind === "unknown");
  const ambiguous = cjkRows.filter((r) => r.pass.split("|").length > 1);
  const sole = new Map();
  for (const r of cjkRows) {
    if (r.pass.split("|").length !== 1) continue;
    sole.set(r.enc, (sole.get(r.enc) || 0) + 1);
  }
  const ranked = [...sole.entries()].sort((a, b) => b[1] - a[1] || CANDIDATES.indexOf(a[0]) - CANDIDATES.indexOf(b[0]));
  const decls = collectDeclarations();
  const rootDecl = decls.filter((d) => d.kind === "root");
  const declVotes = new Map();
  for (const d of rootDecl) declVotes.set(d.encoding, (declVotes.get(d.encoding) || 0) + 1);
  const declTop = [...declVotes.entries()].sort((a, b) => b[1] - a[1])[0];

  let legacy, basis;
  const narrowest = FAMILY_ORDER.find((e) => cjkRows.length > 0 && cjkRows.every((r) => r.pass.split("|").includes(e)));
  const tooNarrow = new Map();
  if (narrowest) {
    for (const e of FAMILY_ORDER) {
      if (e === narrowest) break;
      tooNarrow.set(e, cjkRows.filter((r) => !r.pass.split("|").includes(e)).length);
    }
  }
  if (declTop) {
    legacy = declTop[0];
    basis = `工程声明：${rootDecl.filter((d) => d.encoding === legacy).map((d) => d.source).join("；")}`;
  } else if (ranked.length) {
    legacy = ranked[0][0];
    basis = `字节事实：${ranked[0][0]} 候选唯一的文件共 ${ranked[0][1]} 个`;
  } else if (narrowest) {
    legacy = narrowest;
    const why = [...tooNarrow.entries()].map(([e, n]) => `${e} 差 ${n} 个`).join("、");
    basis = `无工程声明且字节候选存在歧义 -> 取覆盖全部 ${cjkRows.length} 个传统编码文件的最窄候选 ${narrowest}${why ? `（更窄候选：${why}）` : ""}`;
  } else if (cjkRows.length) {
    legacy = "GB18030";
    basis = "无工程声明且单一窄编码无法覆盖全部文件 -> 取超集 GB18030";
  } else {
    legacy = "UTF-8";
    basis = "未检出传统编码文本，整树按 UTF-8 配置";
  }

  const overrides = [];
  const notes = [];
  const push = (pattern, encoding, source) => {
    if (overrides.length >= 40) return;
    if (overrides.some((o) => o.pattern === pattern && o.encoding === encoding)) return;
    overrides.push({ pattern, encoding });
    if (source) notes.push(`override ${pattern} → ${encoding}（依据：${source}）`);
  };
  const conflictRatio = (d) => {
    const dir = d.kind === "root" ? "" : d.scope;
    const inScope = rows.filter(
      (r) => (r.kind === "cjk" || r.kind === "utf8") && (!dir || r.rel === dir || r.rel.startsWith(dir + "/")),
    );
    if (!inScope.length) return null;
    const declaredUtf8 = /^UTF-8$/i.test(d.encoding);
    const wrong = declaredUtf8 ? inScope.filter((r) => r.kind === "cjk") : inScope.filter((r) => r.kind === "utf8");
    return { total: inScope.length, wrong: wrong.length, sample: wrong[0] ? wrong[0].rel : "", inScope };
  };
  for (const d of decls.filter((x) => x.kind === "path")) {
    const isDir = !/\.[A-Za-z0-9]{1,8}$/.test(d.scope);
    const c = conflictRatio(d);
    if (c && c.wrong >= c.total * 0.5) {
      notes.push(`没采纳声明 ${d.scope} → ${d.encoding}：范围内 ${c.wrong}/${c.total} 个非 ASCII 文件字节不是该编码（如 ${c.sample}）。`);
      continue;
    }
    push(isDir ? `${d.scope}/**` : d.scope, d.encoding, d.source);
  }
  if (legacy !== "UTF-8") {
    const dirCounts = new Map();
    for (const r of rows) {
      if (r.kind === "binary" || r.kind === "empty" || r.kind === "oversize" || r.kind === "unknown") continue;
      const segs = r.rel.split("/");
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join("/");
        if (!dirCounts.has(dir)) dirCounts.set(dir, { utf8: 0, cjk: 0 });
        const c = dirCounts.get(dir);
        if (r.kind === "utf8" || r.kind === "utf8-bom") c.utf8++;
        else if (r.kind === "cjk") c.cjk++;
      }
    }
    const covered = new Set();
    const sortedDirs = [...dirCounts.entries()].sort((a, b) => a[0].split("/").length - b[0].split("/").length);
    for (const [dir, c] of sortedDirs) {
      if (covered.has(dir)) continue;
      const total = c.utf8 + c.cjk;
      if (total < 8) continue;
      if (c.utf8 < c.cjk || c.utf8 / total < 0.7) continue;
      const pattern = `${dir}/**`;
      if (overrides.length >= 60) break;
      push(
        pattern,
        "UTF-8",
        `目录内含 ${c.utf8} 个 UTF-8、${c.cjk} 个传统编码，非 ASCII 中 UTF-8 占 ${Math.round((c.utf8 * 100) / total)}%`,
      );
      for (const sub of dirCounts.keys()) {
        if (sub.startsWith(dir + "/")) covered.add(sub);
      }
    }
  }

  const conflicts = [];
  for (const d of decls) {
    if (d.kind === "git") continue;
    const c = conflictRatio(d);
    if (!c || !c.wrong || c.wrong < c.inScope.length * 0.5) continue;
    conflicts.push(`${d.source} 声明 ${d.encoding}，范围内 ${c.wrong}/${c.total} 个非 ASCII 文件字节不符（如 ${c.sample}）`);
  }
  const gitDecl = decls.filter((d) => d.kind === "git");

  const headerLines = [
    `// Generated by tools/scan-encoding.mjs ${dryRun ? "--init --dry-run" : "--init"} at ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    `// Profile: legacy CJK ${cjkRows.length} (ambiguous ${ambiguous.length}) | UTF-8 ${utf8Rows.length} | ASCII ${asciiRows.length} | unknown ${unknownRows.length} | damaged ${damaged.length}`,
    `// sourceEncoding = ${legacy}. Basis: ${basis}`,
  ];
  if (declTop && ranked.length && ranked[0][0] !== declTop[0]) {
    headerLines.push(`// Note: top unique byte candidate is ${ranked[0][0]} (${ranked[0][1]} files); project declaration ${declTop[0]} took precedence.`);
  }
  for (const c of conflicts.slice(0, 10)) headerLines.push(`// Declaration conflict: ${c}`);
  if (gitDecl.length) {
    headerLines.push(`// Detected .gitattributes working-tree-encoding (${gitDecl.map((g) => g.encoding).join(",")}).`);
  }
  if (damaged.length) headerLines.push(`// Detected ${damaged.length} files containing U+FFFD or mojibake sequences.`);
  if (unknownRows.length) headerLines.push(`// ${unknownRows.length} files classified as unknown; writes will be blocked by Gate 3.`);
  headerLines.push(`// Reference: docs/CONFIG-GUIDE.md`);

  const cfg = {
    sourceEncoding: legacy,
    writeEncoding: legacy,
    unmappable: "error",
    verifyWrite: true,
    protectUtf8: true,
    readStrategy: "auto",
    transcodeBash: false,
    overrides,
  };
  notes.unshift(`根编码 ${legacy}（${basis}）；writeEncoding=${legacy}；unmappable="error"；protectUtf8=true。`);
  notes.push(`共生成 ${overrides.length} 条 override（工程声明路径规则 ${decls.filter((d) => d.kind === "path").length} 条）。`);
  const text = `${headerLines.join("\n")}\n${JSON.stringify(cfg, null, 2)}\n`;

  if (dryRun) {
    console.log(`\n（--dry-run）建议写入 ${target} 的内容如下，磁盘未动：\n`);
    console.log(text);
    notes.forEach((n) => console.log(`   - ${n}`));
    return;
  }
  fs.writeFileSync(target, text, "utf-8");
  console.log(`\n已写出 ${target}`);
  notes.slice(0, 14).forEach((n) => console.log(`   - ${n}`));
  if (notes.length > 14) console.log(`   - …另有 ${notes.length - 14} 条说明见配置文件头部注释。`);
  if (conflicts.length) console.log(`   - ${conflicts.length} 条声明与字节不符记录已写入配置文件头部注释。`);
}
