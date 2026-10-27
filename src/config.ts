// Configuration loader, validator, and zero-config sibling inference (.pi-charset.json).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import micromatch from "micromatch";
import {
  UnsupportedEncodingError,
  isGBEncoding,
  isSingleByteEncoding,
  isStatefulEncoding,
  normalizeEncoding,
} from "./encoding/converter";
import { classifyBuffer, DEFAULT_AUTO_CANDIDATES } from "./encoding/classify";
import { detectLineEndingKind } from "./encoding/line-endings";

export const CONFIG_FILENAME = ".pi-charset.json";

function resolveConfigPathSync(dir: string): { path: string; stat: { mtimeMs: number; size: number } } | null {
  const p = path.join(dir, CONFIG_FILENAME);
  try {
    const st = statSync(p);
    return { path: p, stat: st };
  } catch {
    return null;
  }
}

async function resolveConfigPath(dir: string): Promise<{ path: string; stat: { mtimeMs: number; size: number } } | null> {
  const p = path.join(dir, CONFIG_FILENAME);
  try {
    const st = await stat(p);
    return { path: p, stat: st };
  } catch {
    return null;
  }
}

export type ReadStrategy = "auto" | "config";
export type UnmappableStrategy = "error" | "escape" | "drop-to-gb18030";
export type NewFileLineEnding = "CRLF" | "LF";

function normalizeNewFileLineEnding(raw: unknown, where: string, warnings: string[]): NewFileLineEnding | undefined {
  if (raw === undefined) return undefined;
  if (raw === "CRLF" || raw === "LF") return raw;
  warnings.push(`${where}: newFileLineEnding 只接受 "CRLF"/"LF"，收到 ${JSON.stringify(raw)}，已忽略`);
  return undefined;
}

export interface OverrideRule {
  pattern: string;
  encoding?: string;
  writeEncoding?: string;
  /** Bypass byte classification and use the rule's encoding directly (required for single-byte encodings). */
  force?: boolean;
  readStrategy?: ReadStrategy;
  unmappable?: UnmappableStrategy;
  autoCandidates?: string[];
  protectUtf8?: boolean;
  verifyWrite?: boolean;
  newFileLineEnding?: NewFileLineEnding;
}

export interface EncodingConfig {
  sourceEncoding: string;
  writeEncoding?: string;
  readStrategy?: ReadStrategy;
  unmappable?: UnmappableStrategy;
  verifyWrite?: boolean;
  protectUtf8?: boolean;
  autoCandidates?: string[];
  /** Shell output transcoding mode: false (default) | true/"auto" | explicit encoding name. */
  transcodeBash?: BashTranscodeMode;
  /** When transcodeBash is enabled, use the target file's own read encoding for single-file dump commands. */
  bashFileDump?: boolean;
  newFileLineEnding?: NewFileLineEnding;
  overrides?: OverrideRule[];
}

export type BashTranscodeMode = false | "auto" | string;

interface CacheEntry {
  config: EncodingConfig;
  configPath: string;
  warnings: string[];
  mtimeMs: number;
  size: number;
}

export interface FoundConfig {
  config: EncodingConfig;
  configDir: string;
  configPath?: string;
  warnings?: string[];
}

export interface ResolvedConfig {
  configDir: string;
  sourceEncoding: string;
  writeEncoding: string;
  /** Explicit transcoding target when writeEncoding differs from sourceEncoding; null keeps existing file encoding. */
  writeIntent: string | null;
  readStrategy: ReadStrategy;
  unmappable: UnmappableStrategy;
  verifyWrite: boolean;
  protectUtf8: boolean;
  autoCandidates: string[];
  force: boolean;
  newFileLineEnding: NewFileLineEnding | null;
  matchedPattern: string | null;
  warnings: string[];
  /** True when synthesized by zero-config adaptive inference without a .pi-charset.json file. */
  adaptive?: boolean;
}

interface ConfigDefaults {
  sourceEncoding: string;
  readStrategy: ReadStrategy;
  unmappable: UnmappableStrategy;
  verifyWrite: boolean;
  protectUtf8: boolean;
  autoCandidates: string[];
  transcodeBash: BashTranscodeMode;
  bashFileDump: boolean;
}

const DEFAULTS: ConfigDefaults = {
  sourceEncoding: "GB18030",
  readStrategy: "auto",
  unmappable: "error",
  verifyWrite: true,
  protectUtf8: true,
  autoCandidates: [...DEFAULT_AUTO_CANDIDATES],
  transcodeBash: false,
  bashFileDump: true,
};

const NARROW_CJK_ORDER = ["GBK", "Big5", "Shift_JIS", "EUC-KR", "EUC-JP", "GB18030"] as const;
const BINARY_SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".pdf",
  ".zip", ".gz", ".7z", ".rar", ".jar", ".war", ".class", ".exe", ".dll", ".so", ".bin", ".o", ".obj", ".axf", ".elf",
]);

const dirCache = new Map<string, CacheEntry | null>();
let _configGen = 0;

export function configGeneration(): number {
  return _configGen;
}

export function clearConfigCache(): void {
  dirCache.clear();
  _configGen++;
}

/** Pick the narrowest encoding from NARROW_CJK_ORDER that appears in candidates (e.g. GBK over GB18030 when 2-byte clean). */
export function pickNarrowestCandidate(candidates: string[], fallback = "GB18030"): string {
  for (const pref of NARROW_CJK_ORDER) {
    if (candidates.includes(pref)) return pref;
  }
  return candidates[0] ?? fallback;
}

function sameExtGroup(extA: string, extB: string): boolean {
  if (extA === extB) return true;
  const cFamily = new Set([".c", ".h", ".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx", ".s", ".asm", ".inc"]);
  return cFamily.has(extA) && cFamily.has(extB);
}

/**
 * Scan up to 16 sibling text files in the same directory to infer the dominant encoding and line-ending style
 * when creating a new file or adding non-ASCII characters to a pure-ASCII file without a configuration file.
 */
function inferFromSiblings(dir: string, targetExt: string, excludeBase: string): { encoding: string; eol: NewFileLineEnding | null } {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { encoding: "UTF-8", eol: null };
  }
  const files = entries
    .filter((e) => e.isFile() && e.name !== excludeBase && !e.name.startsWith(".") && !BINARY_SKIP_EXT.has(path.extname(e.name).toLowerCase()))
    .sort((a, b) => {
      const aMatch = sameExtGroup(path.extname(a.name).toLowerCase(), targetExt) ? 0 : 1;
      const bMatch = sameExtGroup(path.extname(b.name).toLowerCase(), targetExt) ? 0 : 1;
      return aMatch - bMatch || a.name.localeCompare(b.name);
    })
    .slice(0, 16);

  let cjkCount = 0;
  let utf8Count = 0;
  let crlfCount = 0;
  let lfCount = 0;
  const cjkCandidateSets: string[][] = [];

  for (const f of files) {
    const p = path.join(dir, f.name);
    let st: { size: number };
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.size === 0 || st.size > 256 * 1024) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(p);
    } catch {
      continue;
    }
    const v = classifyBuffer(buf, null);
    if (v.kind === "binary" || v.kind === "unknown") continue;
    const eol = detectLineEndingKind(buf);
    if (eol === "CRLF") crlfCount++;
    else if (eol === "LF") lfCount++;
    if (v.kind === "cjk") {
      cjkCount++;
      cjkCandidateSets.push(v.candidates.length ? v.candidates : [v.encoding]);
    } else if (v.kind === "utf8" || v.kind === "utf8-bom") {
      utf8Count++;
    }
  }

  const dominantEol: NewFileLineEnding | null = crlfCount > lfCount ? "CRLF" : lfCount > crlfCount ? "LF" : null;
  if (cjkCount > 0 && cjkCount >= utf8Count) {
    const common = NARROW_CJK_ORDER.find((enc) => cjkCandidateSets.every((set) => set.includes(enc))) ?? "GB18030";
    return { encoding: common, eol: dominantEol };
  }
  return { encoding: "UTF-8", eol: null };
}

/**
 * Synthesize a self-adaptive ResolvedConfig when no .pi-charset.json file is present:
 * - Existing non-ASCII files use their own byte-classified encoding.
 * - New files and pure-ASCII files inherit the dominant encoding and line ending of sibling files in the same directory (defaulting to UTF-8).
 */
export function inferAdaptiveRule(absFilePath: string, rawBytes?: Buffer | null): ResolvedConfig {
  const dir = path.dirname(absFilePath);
  let raw = rawBytes;
  if (raw === undefined) {
    try {
      raw = readFileSync(absFilePath);
    } catch {
      raw = null;
    }
  }
  if (raw && raw.length > 0) {
    const v = classifyBuffer(raw, null);
    if (v.kind === "cjk") {
      const enc = pickNarrowestCandidate(v.candidates, v.encoding);
      return {
        configDir: dir,
        sourceEncoding: enc,
        writeEncoding: enc,
        writeIntent: null,
        readStrategy: "auto",
        unmappable: "error",
        verifyWrite: true,
        protectUtf8: true,
        autoCandidates: [...DEFAULT_AUTO_CANDIDATES],
        force: false,
        newFileLineEnding: null,
        matchedPattern: null,
        warnings: [],
        adaptive: true,
      };
    }
    if (v.kind === "utf16le" || v.kind === "utf16be") {
      return {
        configDir: dir,
        sourceEncoding: v.encoding,
        writeEncoding: v.encoding,
        writeIntent: null,
        readStrategy: "auto",
        unmappable: "error",
        verifyWrite: true,
        protectUtf8: true,
        autoCandidates: [...DEFAULT_AUTO_CANDIDATES],
        force: false,
        newFileLineEnding: null,
        matchedPattern: null,
        warnings: [],
        adaptive: true,
      };
    }
    if (v.kind === "utf8" || v.kind === "utf8-bom" || v.kind === "binary" || v.kind === "unknown") {
      return {
        configDir: dir,
        sourceEncoding: "UTF-8",
        writeEncoding: "UTF-8",
        writeIntent: null,
        readStrategy: "auto",
        unmappable: "error",
        verifyWrite: true,
        protectUtf8: true,
        autoCandidates: [...DEFAULT_AUTO_CANDIDATES],
        force: false,
        newFileLineEnding: null,
        matchedPattern: null,
        warnings: [],
        adaptive: true,
      };
    }
  }

  // Target file is either new or pure ASCII: infer from sibling files in the same directory.
  const sib = inferFromSiblings(dir, path.extname(absFilePath).toLowerCase(), path.basename(absFilePath));
  return {
    configDir: dir,
    sourceEncoding: sib.encoding,
    writeEncoding: sib.encoding,
    writeIntent: null,
    readStrategy: "auto",
    unmappable: "error",
    verifyWrite: true,
    protectUtf8: true,
    autoCandidates: [...DEFAULT_AUTO_CANDIDATES],
    force: false,
    newFileLineEnding: sib.eol,
    matchedPattern: null,
    warnings: [],
    adaptive: true,
  };
}

function loadConfigInDirSync(dir: string): CacheEntry | null {
  const cached = dirCache.get(dir);
  const found = resolveConfigPathSync(dir);
  if (!found) {
    dirCache.set(dir, null);
    return null;
  }
  const { path: p, stat: st } = found;
  if (cached && cached.configPath === p && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    dirCache.set(dir, null);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (e) {
    const entry: CacheEntry = {
      config: { ...DEFAULTS },
      configPath: p,
      warnings: [`${p} 不是合法 JSON（${(e as Error).message}）；本次按默认值处理，请修正该文件`],
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    dirCache.set(dir, entry);
    return entry;
  }
  const { config, warnings } = validateConfig((parsed ?? {}) as Record<string, unknown>, p);
  const entry: CacheEntry = { config, configPath: p, warnings, mtimeMs: st.mtimeMs, size: st.size };
  dirCache.set(dir, entry);
  return entry;
}

export function findNearestConfigSync(startDir: string): FoundConfig | null {
  let cur = path.resolve(startDir);
  const warnings: string[] = [];
  while (true) {
    const entry = loadConfigInDirSync(cur);
    if (entry) {
      if (entry.warnings.length) warnings.push(...entry.warnings);
      return { config: entry.config, configDir: cur, configPath: entry.configPath, warnings };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Strip // line comments and /* *\/ block comments from JSONC while preserving string literals. */
export function stripJsonComments(src: string): string {
  let out = "";
  let inStr = false;
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
        continue;
      }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function normalizeBashMode(raw: unknown, where: string, warnings: string[]): BashTranscodeMode {
  if (raw === undefined || raw === false || raw === "false" || raw === "off") return false;
  if (raw === true || raw === "auto" || raw === "on") return "auto";
  if (typeof raw === "string") {
    try {
      const n = normalizeEncoding(raw);
      if (n === "UTF-8") {
        warnings.push(`${where}: transcodeBash="${raw}" 目标已是 UTF-8，按 false 处理`);
        return false;
      }
      if (isStatefulEncoding(n)) {
        warnings.push(`${where}: transcodeBash="${raw}" 为状态转义编码，无法做流式判定，改用 "auto"`);
        return "auto";
      }
      return n;
    } catch {
      warnings.push(`${where}: transcodeBash="${raw}" 不是可用编码名，改用 "auto"`);
      return "auto";
    }
  }
  warnings.push(`${where}: transcodeBash 只接受 false/"auto"/编码名，收到 ${JSON.stringify(raw)}，按 false 处理`);
  return false;
}

function validateConfig(parsed: Record<string, unknown>, where: string): { config: EncodingConfig; warnings: string[] } {
  const warnings: string[] = [];
  const merged = { ...DEFAULTS, ...(parsed ?? {}) } as EncodingConfig;
  try {
    merged.sourceEncoding = normalizeEncoding(String(merged.sourceEncoding ?? "GB18030"));
  } catch (e) {
    warnings.push(`${where}: sourceEncoding "${merged.sourceEncoding}" 不可用（${(e as Error).message}），按 GB18030 处理`);
    merged.sourceEncoding = "GB18030";
  }
  if (merged.writeEncoding) {
    try {
      merged.writeEncoding = normalizeEncoding(String(merged.writeEncoding));
    } catch {
      warnings.push(`${where}: writeEncoding "${merged.writeEncoding}" 不可用，回退至 sourceEncoding`);
      merged.writeEncoding = merged.sourceEncoding;
    }
  }
  if (merged.readStrategy !== "auto" && merged.readStrategy !== "config") {
    warnings.push(`${where}: readStrategy "${merged.readStrategy}" 非法，已回退为 "auto"`);
    merged.readStrategy = "auto";
  }
  if (merged.unmappable !== "error" && merged.unmappable !== "escape" && merged.unmappable !== "drop-to-gb18030") {
    warnings.push(`${where}: unmappable "${merged.unmappable}" 非法，已回退为 "error"`);
    merged.unmappable = "error";
  }
  if (typeof merged.verifyWrite !== "boolean") merged.verifyWrite = true;
  if (typeof merged.protectUtf8 !== "boolean") merged.protectUtf8 = true;
  if (!Array.isArray(merged.autoCandidates) || merged.autoCandidates.length === 0) {
    merged.autoCandidates = [...DEFAULT_AUTO_CANDIDATES];
  } else {
    const kept: string[] = [];
    for (const c of merged.autoCandidates) {
      let n: string;
      try {
        n = normalizeEncoding(String(c));
      } catch {
        warnings.push(`${where}: autoCandidates 中的 "${c}" 不是可用编码，已忽略（支持列表：${DEFAULT_AUTO_CANDIDATES.join("/")}）`);
        continue;
      }
      if (isSingleByteEncoding(n) || isStatefulEncoding(n)) {
        warnings.push(
          `${where}: autoCandidates 不支持单字节或转义序列编码 "${n}"，需在 overrides 中通过 "force": true 指定`,
        );
        continue;
      }
      kept.push(n);
    }
    if (kept.length === 0) {
      warnings.push(`${where}: autoCandidates 全部无效，已回退默认候选链`);
      merged.autoCandidates = [...DEFAULT_AUTO_CANDIDATES];
    } else merged.autoCandidates = kept;
  }
  merged.transcodeBash = normalizeBashMode(parsed.transcodeBash, where, warnings);
  merged.newFileLineEnding = normalizeNewFileLineEnding(parsed.newFileLineEnding, where, warnings);
  if (parsed.bashFileDump === undefined) merged.bashFileDump = DEFAULTS.bashFileDump;
  else if (typeof parsed.bashFileDump !== "boolean") {
    warnings.push(`${where}: bashFileDump 必须是布尔值，已回退为 true`);
    merged.bashFileDump = true;
  } else merged.bashFileDump = parsed.bashFileDump;
  if (merged.overrides) {
    merged.overrides = merged.overrides.map((r) => {
      const rule: OverrideRule = { ...r };
      const label = r.encoding;
      if (!label) {
        warnings.push(`${where}: override "${r.pattern}" 缺少 encoding，已忽略`);
        return rule;
      }
      try {
        const n = normalizeEncoding(String(label));
        rule.encoding = n;
        if ((isSingleByteEncoding(n) || isStatefulEncoding(n)) && rule.force !== true) {
          warnings.push(
            `${where}: override "${r.pattern}" 的编码 ${n} 为单字节或转义序列编码，需设置 "force": true 才会生效`,
          );
        }
      } catch (e) {
        warnings.push(`${where}: override "${r.pattern}" 的编码 "${label}" 不可用（${(e as UnsupportedEncodingError).message}）`);
      }
      if (rule.writeEncoding) {
        try {
          rule.writeEncoding = normalizeEncoding(rule.writeEncoding);
        } catch {
          warnings.push(`${where}: override "${r.pattern}" 的 writeEncoding 不可用，已回退`);
          rule.writeEncoding = undefined;
        }
      }
      rule.newFileLineEnding = normalizeNewFileLineEnding(r.newFileLineEnding, `${where}: override "${r.pattern}"`, warnings);
      return rule;
    });
  }
  return { config: merged, warnings };
}

async function loadConfigInDir(dir: string): Promise<CacheEntry | null> {
  const cached = dirCache.get(dir);
  const found = await resolveConfigPath(dir);
  if (!found) {
    dirCache.set(dir, null);
    return null;
  }
  const { path: p, stat: st } = found;
  if (cached && cached.configPath === p && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  let text: string;
  try {
    text = await readFile(p, "utf-8");
  } catch {
    dirCache.set(dir, null);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (e) {
    // Fall back to default configuration with a warning if the JSON file is malformed, avoiding raw UTF-8 passthrough.
    const entry: CacheEntry = {
      config: { ...DEFAULTS },
      configPath: p,
      warnings: [`${p} 不是合法 JSON（${(e as Error).message}）；本次按默认值处理，请修正该文件`],
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    dirCache.set(dir, entry);
    return entry;
  }
  const { config, warnings } = validateConfig((parsed ?? {}) as Record<string, unknown>, p);
  const entry: CacheEntry = { config, configPath: p, warnings, mtimeMs: st.mtimeMs, size: st.size };
  dirCache.set(dir, entry);
  return entry;
}

export async function findNearestConfig(startDir: string): Promise<FoundConfig | null> {
  let cur = path.resolve(startDir);
  const warnings: string[] = [];
  while (true) {
    const entry = await loadConfigInDir(cur);
    if (entry) {
      if (entry.warnings.length) warnings.push(...entry.warnings);
      return { config: entry.config, configDir: cur, configPath: entry.configPath, warnings };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function scoreSpecificity(pattern: string): number {
  if (!pattern) return 0;
  let score = 0;
  for (const seg of pattern.split("/")) {
    if (seg === "**") score += 1;
    else if (seg === "*") score += 2;
    else if (seg.includes("*") || seg.includes("?")) score += 5;
    else score += 10;
  }
  return score;
}

function ruleMatches(rel: string, pattern: string): boolean {
  if (!pattern) return false;
  const isBare = !pattern.includes("/");
  return micromatch.isMatch(rel, pattern, isBare ? { matchBase: true } : undefined);
}

function pickOverride(absFilePath: string, found: FoundConfig): { rule: OverrideRule | null; score: number } {
  const { config, configDir } = found;
  if (!config.overrides?.length) return { rule: null, score: 0 };
  const rel = path.relative(configDir, absFilePath).replace(/\\/g, "/");
  const matched = config.overrides
    .map((rule, index) => ({ rule, score: scoreSpecificity(rule.pattern), index }))
    .filter((it) => ruleMatches(rel, it.rule.pattern))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = matched[0];
  return best ? { rule: best.rule, score: best.score } : { rule: null, score: 0 };
}

export function resolveFileRule(absFilePath: string, found: FoundConfig): ResolvedConfig {
  const { config, configDir } = found;
  const { rule } = pickOverride(absFilePath, found);
  const warnings = [...(found.warnings ?? [])];
  const overrideRead = normalizeRuleLabel(rule?.encoding);
  const sourceEncoding = overrideRead ?? config.sourceEncoding;
  const rootWrite = normalizeRuleLabel(config.writeEncoding);
  const rootSource = normalizeRuleLabel(config.sourceEncoding);
  const migrationIntent = !!rootWrite && !!rootSource && rootWrite !== rootSource;
  // When an override specifies only encoding and the root config has no migration intent, writeEncoding follows the override.
  const writeEncoding =
    normalizeRuleLabel(rule?.writeEncoding) ??
    (overrideRead && !migrationIntent ? overrideRead : rootWrite ?? sourceEncoding);
  if (migrationIntent && overrideRead && rootWrite && overrideRead !== rootWrite && !rule?.writeEncoding) {
    warnings.push(
      `${configDir}: 根配置带迁移意图（sourceEncoding=${rootSource} -> writeEncoding=${rootWrite}），` +
        `override "${rule?.pattern}" 仅声明了读编码 ${overrideRead}，该目录下新建与纯 ASCII 文件仍按 ${rootWrite} 写入；` +
        `若需按 ${overrideRead} 写入，请在该 override 中显式设置 "writeEncoding": "${overrideRead}"。`,
    );
  }
  if (rule?.writeEncoding && rule.encoding === undefined) {
    warnings.push(`${configDir}: override "${rule.pattern}" 仅设置了 writeEncoding，读编码沿用 ${sourceEncoding}`);
  }
  const force = rule?.force ?? false;
  const writeIntent = normalizeEncoding(writeEncoding) !== normalizeEncoding(sourceEncoding) ? writeEncoding : null;
  if (isGBEncoding(writeEncoding) && isGBEncoding(sourceEncoding) && writeEncoding !== sourceEncoding) {
    if (writeEncoding.toUpperCase() === "GBK" && sourceEncoding.toUpperCase() === "GB18030") {
      warnings.push(
        `${configDir}: writeEncoding=GBK 而 sourceEncoding=GB18030，文件中的 4 字节扩展区字符在写出时将被闸门 1 拦截`,
      );
    }
  }
  return {
    configDir,
    sourceEncoding,
    writeEncoding,
    writeIntent,
    readStrategy: rule?.readStrategy ?? config.readStrategy ?? DEFAULTS.readStrategy,
    unmappable: rule?.unmappable ?? config.unmappable ?? DEFAULTS.unmappable,
    verifyWrite: rule?.verifyWrite ?? config.verifyWrite ?? DEFAULTS.verifyWrite,
    protectUtf8: rule?.protectUtf8 ?? config.protectUtf8 ?? DEFAULTS.protectUtf8,
    autoCandidates: rule?.autoCandidates?.length
      ? (rule.autoCandidates.map((c) => safeNormalize(String(c))).filter(Boolean) as string[])
      : config.autoCandidates ?? DEFAULTS.autoCandidates,
    force,
    matchedPattern: rule?.pattern ?? null,
    newFileLineEnding: rule?.newFileLineEnding ?? config.newFileLineEnding ?? null,
    warnings,
  };
}

function safeNormalize(label: string): string | null {
  try {
    return normalizeEncoding(label);
  } catch {
    return null;
  }
}

function normalizeRuleLabel(label: string | undefined): string | null {
  if (!label) return null;
  return safeNormalize(label);
}

export function resolveOverrideEncoding(absFilePath: string, found: FoundConfig): string {
  return resolveFileRule(absFilePath, found).sourceEncoding;
}

export interface ShellTranscodeRule {
  mode: BashTranscodeMode;
  fileDump: boolean;
  sourceEncoding: string;
  autoCandidates: string[];
  configDir: string;
  warnings: string[];
}

export function shellRuleFor(startDir: string): ShellTranscodeRule | null {
  const found = findNearestConfigSync(startDir);
  if (!found) return null;
  const warnings: string[] = [...(found.warnings ?? [])];
  const mode = normalizeBashMode(found.config.transcodeBash, found.configDir, warnings);
  if (mode === false) return null;
  return {
    mode,
    fileDump: found.config.bashFileDump !== false,
    sourceEncoding: found.config.sourceEncoding,
    autoCandidates: found.config.autoCandidates ?? [...DEFAULT_AUTO_CANDIDATES],
    configDir: found.configDir,
    warnings,
  };
}
