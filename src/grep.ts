// Multi-encoding ripgrep wrapper:
// - Runs per-encoding ripgrep passes (UTF-8 + GB18030 in zero-config mode for non-ASCII patterns, or all configured encodings when .pi-charset.json is present).
// - Verifies matches against each file's classified encoding and deduplicates by file:line.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import {
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { findNearestConfig, resolveFileRule, type FoundConfig } from "./config";
import { classifyFileCached } from "./encoding/classify";
import { isSingleByteEncoding, normalizeEncoding, decodeToUtf8 } from "./encoding/converter";

export const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regex (or literal when literal=true) pattern to search for" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: cwd)" })),
  glob: Type.Optional(Type.String({ description: "Glob to filter files, e.g. *.py" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
  context: Type.Optional(Type.Number({ description: "Lines of context before and after each match" })),
  limit: Type.Optional(Type.Number({ description: "Max total matches to return" })),
});

export type GrepInput = Static<typeof grepSchema>;

const DEFAULT_EXCLUDE_DIRS = [".git", ".svn", ".hg", "node_modules"];
const DEFAULT_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 500;

let _rgCache: string | null | undefined;

function tryRg(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function piAgentRg(): string | null {
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  const homes = [os.homedir(), process.env.USERPROFILE, process.env.HOME].filter(Boolean) as string[];
  for (const h of homes) {
    const bin = path.join(h, ".pi", "agent", "bin", exe);
    if (!existsSync(bin)) continue;
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      /* continue */
    }
  }
  return null;
}

function findRgFromVscode(): string | null {
  const dirs = ["@vscode/ripgrep"];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm", "node_modules", "@vscode", "ripgrep"));
  dirs.push(path.join(path.dirname(process.execPath), "node_modules", "@vscode", "ripgrep"));
  for (const dir of dirs) {
    try {
      const { rgPath } = require(dir);
      if (rgPath) {
        accessSync(rgPath, constants.X_OK);
        return rgPath;
      }
    } catch {
      /* next */
    }
  }
  return null;
}

export function findRg(): string | null {
  if (_rgCache !== undefined) return _rgCache;
  _rgCache = piAgentRg() ?? (tryRg("rg") ? "rg" : findRgFromVscode());
  return _rgCache;
}

export function resetRgCache(): void {
  _rgCache = undefined;
}

/** Extract the literal directory prefix preceding the first glob metacharacter (or "." if none). */
export function globDirPrefix(pattern: string): string {
  const idxs = [pattern.indexOf("*"), pattern.indexOf("?"), pattern.indexOf("[")].filter((i) => i >= 0);
  const idx = idxs.length ? Math.min(...idxs) : -1;
  const dirPart = idx === -1 ? pattern : pattern.slice(0, idx);
  const lastSlash = dirPart.lastIndexOf("/");
  if (lastSlash === -1) return ".";
  return dirPart.slice(0, lastSlash) || ".";
}

export interface EncodingGroup {
  encoding: string;
  includeDirs: string[];
  excludeDirs: string[];
}

export function buildEncodingGroups(found: FoundConfig): EncodingGroup[] {
  const { config } = found;
  const defaultEncoding = config.sourceEncoding;
  const overrideGroups = new Map<string, Set<string>>();
  const excludeDirs = new Set<string>();

  for (const ov of config.overrides ?? []) {
    const enc = ov.encoding ?? defaultEncoding;
    if (enc === defaultEncoding) continue;
    const dir = globDirPrefix(ov.pattern);
    if (dir === ".") continue;
    excludeDirs.add(dir);
    if (!overrideGroups.has(enc)) overrideGroups.set(enc, new Set());
    overrideGroups.get(enc)!.add(dir);
  }

  const groups: EncodingGroup[] = [
    { encoding: defaultEncoding, includeDirs: [], excludeDirs: [...excludeDirs].sort() },
  ];
  for (const [encoding, dirs] of overrideGroups) {
    groups.push({ encoding, includeDirs: [...dirs].sort(), excludeDirs: [] });
  }
  return groups;
}

const GB_SUPERSET = "GB18030";
const GB_FAMILY = new Set(["GBK", "GB2312", "GB_2312", "HZ-GB-2312", "CP936", "WINDOWS-936"]);

/**
 * Compute the list of encoding passes for a search pattern:
 * - Always run UTF-8 first; ASCII-only patterns require only the UTF-8 pass.
 * - In zero-config mode (`found === null`), non-ASCII patterns run `["UTF-8", "GB18030"]`.
 * - When a configuration file exists, collect declared multi-byte encodings and fold GB-family encodings into GB18030.
 */
export function buildEncodingPasses(found: FoundConfig | null, pattern: string): string[] {
  const passes = ["UTF-8"];
  if (/[^\x00-\x7f]/.test(pattern) === false) return passes;
  if (!found) {
    passes.push(GB_SUPERSET);
    return passes;
  }
  const { config } = found;
  const declared = new Set<string>();
  const add = (name: string | undefined | null) => {
    if (!name) return;
    let n: string | null = null;
    try {
      n = normalizeEncoding(name);
    } catch {
      n = null;
    }
    if (!n) return;
    if (n.toUpperCase() === "UTF-8") return;
    if (isSingleByteEncoding(n)) return;
    declared.add(n.toUpperCase());
  };
  add(config.sourceEncoding);
  add(config.writeEncoding);
  for (const c of config.autoCandidates ?? []) add(c);
  for (const ov of config.overrides ?? []) {
    add(ov.encoding);
    add(ov.writeEncoding);
    for (const c of ov.autoCandidates ?? []) add(c);
  }
  const hasSuperset = declared.has(GB_SUPERSET);
  for (const enc of [...declared].sort()) {
    if (hasSuperset && GB_FAMILY.has(enc)) continue;
    passes.push(enc);
  }
  return passes;
}

function rgEncodingLabel(encoding: string): string | null {
  const up = encoding.toUpperCase();
  if (up === "UTF-8" || up === "UTF8") return null;
  return encoding.toLowerCase();
}

interface RawMatch {
  file: string;
  line: number;
  text: string | undefined;
  encoding: string;
}

function buildRgArgs(input: GrepInput, encoding: string, searchPath: string): string[] {
  const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
  const enc = rgEncodingLabel(encoding);
  if (enc) args.push("--encoding", enc);
  if (input.ignoreCase) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.glob) args.push("--glob", input.glob);
  for (const d of DEFAULT_EXCLUDE_DIRS) args.push("--glob", `!**/${d}/**`);
  args.push("--", input.pattern, searchPath);
  return args;
}

export interface GrepDetails {
  truncation?: ReturnType<typeof truncateHead>;
  matchLimitReached?: number;
  linesTruncated?: boolean;
  searchedWith?: string[];
  skippedPasses?: string[];
}

function runRgPass(
  rg: string,
  args: string[],
  limit: number,
  signal?: AbortSignal,
): Promise<{ matches: RawMatch[]; error: string | null; hitLimit: boolean }> {
  return new Promise((resolve) => {
    const matches: RawMatch[] = [];
    let stderr = "";
    let hitLimit = false;
    let settled = false;
    const done = (error: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ matches, error, hitLimit });
    };
    const child = spawn(rg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev: {
          type?: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type !== "match") continue;
        matches.push({
          file: ev.data?.path?.text ?? "",
          line: ev.data?.line_number as number,
          text: ev.data?.lines?.text,
          encoding: "",
        });
        if (matches.length >= limit) {
          hitLimit = true;
          child.kill();
          done(null);
          return;
        }
      }
    });
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => done(e.message));
    child.on("close", (code) => {
      const ok = code === 0 || code === 1 || hitLimit;
      done(ok ? null : stderr.trim() || `rg exited with code ${code}`);
    });
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}

function ruleContextFor(abs: string, found: FoundConfig | null) {
  if (!found) return null;
  const rule = resolveFileRule(abs, found);
  return {
    sourceEncoding: rule.sourceEncoding,
    autoCandidates: rule.autoCandidates,
    force: rule.force,
  };
}

function sameDecodeFamily(vEncoding: string, passEncoding: string): boolean {
  const a = normalizeEncoding(vEncoding);
  const b = normalizeEncoding(passEncoding);
  if (!a || !b) return false;
  const up = (x: string) => x.toUpperCase();
  if (up(a) === up(b)) return true;
  return (up(a) === GB_SUPERSET && GB_FAMILY.has(up(b))) || (up(b) === GB_SUPERSET && GB_FAMILY.has(up(a)));
}

export interface SearchResult {
  text: string;
  details: GrepDetails;
  searchedWith: string[];
  skippedPasses: string[];
}

export async function searchFiles(rootAbs: string, input: GrepInput, signal?: AbortSignal): Promise<SearchResult | null> {
  const rg = findRg();
  if (!rg) return null;

  const searchPath = path.resolve(rootAbs, input.path || ".");
  let isDir = true;
  try {
    isDir = statSync(searchPath).isDirectory();
  } catch {
    return null;
  }
  const found = await findNearestConfig(isDir ? searchPath : path.dirname(searchPath));

  const passes = buildEncodingPasses(found, input.pattern);
  const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
  const collected: RawMatch[] = [];
  const seen = new Set<string>();
  const used: string[] = [];
  const skipped: string[] = [];

  const lineCache = new Map<string, string[]>();
  const linesOf = (abs: string): string[] => {
    let hit = lineCache.get(abs);
    if (!hit) {
      const v = classifyFileCached(abs, ruleContextFor(abs, found));
      const text = v.kind === "binary" || v.kind === "unknown" ? "" : decodeWith(v.encoding, abs);
      hit = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      lineCache.set(abs, hit);
    }
    return hit;
  };
  const regexCache = new Map<string, RegExp | null>();
  const patternHitsLine = (line: string): boolean => {
    if (input.literal) {
      return input.ignoreCase
        ? line.toLowerCase().includes(input.pattern.toLowerCase())
        : line.includes(input.pattern);
    }
    const key = input.ignoreCase ? "i" : "";
    let re = regexCache.get(key);
    if (re === undefined) {
      try {
        re = new RegExp(input.pattern, key);
      } catch {
        re = null;
      }
      regexCache.set(key, re);
    }
    return re === null ? true : re.test(line);
  };
  /** Verify a match against the file's classified encoding to discard false-positive mojibake hits. */
  const trusted = (abs: string, m: RawMatch): boolean => {
    const v = classifyFileCached(abs, ruleContextFor(abs, found));
    if (v.kind === "binary" || v.kind === "unknown") return false;
    if (v.kind === "ascii" || sameDecodeFamily(v.encoding, m.encoding)) return true;
    const line = linesOf(abs)[m.line - 1];
    return line !== undefined && patternHitsLine(line.replace(/\r/g, ""));
  };

  for (const enc of passes) {
    if (signal?.aborted) break;
    const remaining = effectiveLimit - collected.length;
    if (remaining <= 0) break;
    const { matches, error } = await runRgPass(rg, buildRgArgs(input, enc, searchPath), remaining, signal);
    if (error) {
      skipped.push(`${enc}（${error.slice(0, 60)}）`);
      continue;
    }
    used.push(enc);
    for (const m of matches) {
      if (!m.file || typeof m.line !== "number") continue;
      const abs = path.resolve(searchPath, m.file);
      const key = `${abs}:${m.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      m.encoding = enc;
      if (!trusted(abs, m)) continue;
      collected.push({ ...m, file: abs });
    }
  }

  return formatLikeBuiltin(searchPath, collected, effectiveLimit, input, used, skipped, linesOf);
}

function formatLikeBuiltin(
  searchPath: string,
  matches: RawMatch[],
  effectiveLimit: number,
  input: GrepInput,
  used: string[],
  skipped: string[],
  readLines: (abs: string) => string[],
): SearchResult {
  const details: SearchResult["details"] = {};
  if (matches.length === 0) {
    return {
      text: "No matches found",
      details,
      searchedWith: used,
      skippedPasses: skipped,
    };
  }
  matches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const isDir = (() => {
    try {
      return statSync(searchPath).isDirectory();
    } catch {
      return false;
    }
  })();
  const formatPath = (f: string) => {
    if (isDir) {
      const rel = path.relative(searchPath, f);
      if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
    }
    return path.basename(f);
  };
  const contextValue = input.context && input.context > 0 ? input.context : 0;
  let linesTruncated = false;
  const outputLines: string[] = [];
  for (const m of matches) {
    const rel = formatPath(m.file);
    if (contextValue === 0 && m.text !== undefined) {
      const sanitized = m.text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const { text: t, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(`${rel}:${m.line}: ${t}`);
      continue;
    }
    const lines = readLines(m.file);
    if (!lines.length) {
      outputLines.push(`${rel}:${m.line}: (unable to read file)`);
      continue;
    }
    const start = Math.max(1, m.line - contextValue);
    const end = Math.min(lines.length, m.line + contextValue);
    for (let cur = start; cur <= end; cur++) {
      const sanitized = (lines[cur - 1] ?? "").replace(/\r/g, "");
      const { text: t, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(cur === m.line ? `${rel}:${cur}: ${t}` : `${rel}-${cur}- ${t}`);
    }
  }
  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const notices: string[] = [];
  if (matches.length >= effectiveLimit) {
    notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
    details.matchLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return { text: output, details, searchedWith: used, skippedPasses: skipped };
}

function decodeWith(encoding: string, abs: string): string {
  return decodeToUtf8(readFileSync(abs), encoding);
}

export function createEncodingGrepDefinition(cwd: string): ToolDefinition<typeof grepSchema, GrepDetails> {
  const builtin = createGrepToolDefinition(cwd) as unknown as ToolDefinition<typeof grepSchema, GrepDetails>;

  return {
    name: "grep",
    label: "grep (encoding aware)",
    description: builtin.description,
    promptSnippet: "Search file contents for patterns (respects .gitignore; multi-encoding aware)",
    parameters: grepSchema,
    async execute(
      toolCallId: string,
      params: GrepInput,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof builtin.execute>[3],
      ctx: Parameters<typeof builtin.execute>[4],
    ): Promise<AgentToolResult<GrepDetails>> {
      const res = await searchFiles(cwd, params, signal);
      if (!res) {
        return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      return {
        content: [{ type: "text", text: res.text }],
        details: { ...res.details, searchedWith: res.searchedWith, skippedPasses: res.skippedPasses },
      };
    },
    renderCall: builtin.renderCall,
    renderResult: builtin.renderResult,
  };
}
