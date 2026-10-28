// Deterministic byte-level encoding classifier:
// Order: empty -> BOM (utf8 / utf32->binary / utf16le / utf16be) -> NUL=binary -> force
//        -> pure ASCII (SIMD) -> strict full-buffer UTF-8 (SIMD) -> CJK round-trip candidates -> config fallback -> unknown
import { isAscii, isUtf8 } from "node:buffer";
import { readFileSync, statSync, promises as fsp } from "node:fs";
import iconv from "iconv-lite";
import { normalizePathKey } from "../path-key";
import {
  AUTO_CJK_CANDIDATES,
  isSingleByteEncoding,
  isStatefulEncoding,
  normalizeEncoding,
} from "./converter";

export type Kind =
  | "utf8"
  | "utf8-bom"
  | "utf16le"
  | "utf16be"
  | "cjk"
  | "binary"
  | "ascii"
  | "unknown"
  | "config";

export interface Verdict {
  kind: Kind;
  encoding: string;
  ambiguous: boolean;
  hasFffd: boolean;
  candidates: string[];
  exhaustive: boolean;
  bom: boolean;
  configReason?: "force" | "undecidable";
}

export interface ClassifyConfig {
  sourceEncoding?: string | null;
  autoCandidates?: string[];
  force?: boolean;
}

export const DEFAULT_AUTO_CANDIDATES: string[] = [...AUTO_CJK_CANDIDATES];
/** Buffers larger than 512KB short-circuit after the first matching candidate. */
export const FULL_SCAN_LIMIT = 512 * 1024;
export const NUL_PROBE_LIMIT = 8192;

const startsWith = (b: Buffer, sig: number[]): boolean => {
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return false;
  return true;
};

/** Check for NUL (0x00) bytes within the first `limit` bytes using native Buffer.includes. */
export function containsNul(b: Buffer, limit = NUL_PROBE_LIMIT): boolean {
  const n = Math.min(b.length, limit);
  return b.subarray(0, n).includes(0);
}

/** Check whether all bytes are ASCII (<= 0x7F) using Node's native C++ SIMD implementation. */
export function isAllAscii(b: Buffer): boolean {
  return isAscii(b);
}

/** Validate the entire buffer as strict UTF-8 using Node's native C++ SIMD implementation without heap string allocation. */
export function isValidUtf8Strict(b: Buffer): boolean {
  return isUtf8(b);
}

/** Check whether decoding and re-encoding under enc reproduces the exact input bytes without U+FFFD. */
export function exactRoundTrip(b: Buffer, enc: string): boolean {
  try {
    const text = iconv.decode(b, enc);
    if (text.includes("\ufffd")) return false;
    return Buffer.compare(iconv.encode(text, enc), b) === 0;
  } catch {
    return false;
  }
}

function decodeHasFffd(b: Buffer, enc: string): boolean {
  try {
    return iconv.decode(b, enc).includes("\ufffd");
  } catch {
    return true;
  }
}

function normalizeCandidates(list: string[] | undefined): string[] {
  const src = list && list.length ? list : DEFAULT_AUTO_CANDIDATES;
  const out: string[] = [];
  for (const e of src) {
    let n: string;
    try {
      n = normalizeEncoding(e);
    } catch {
      continue;
    }
    if (isSingleByteEncoding(n) || isStatefulEncoding(n)) continue;
    if (!AUTO_CJK_CANDIDATES.includes(n as (typeof AUTO_CJK_CANDIDATES)[number])) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out : [...DEFAULT_AUTO_CANDIDATES];
}

/** Check that a UTF-16 byte body is well-formed: even length and no unpaired surrogate code units. */
function isValidUtf16Body(body: Buffer, littleEndian: boolean): boolean {
  if (body.length % 2 !== 0) return false;
  const unitAt = (i: number) =>
    littleEndian ? body[i]! | (body[i + 1]! << 8) : (body[i]! << 8) | body[i + 1]!;
  for (let i = 0; i < body.length; i += 2) {
    const unit = unitAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 4 > body.length) return false;
      const next = unitAt(i + 2);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 2;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function configVerdict(b: Buffer, enc: string, reason: "force" | "undecidable"): Verdict {
  return {
    kind: "config",
    encoding: enc,
    ambiguous: false,
    hasFffd: decodeHasFffd(b, enc),
    candidates: [enc],
    exhaustive: true,
    bom: false,
    configReason: reason,
  };
}

export function classifyBuffer(B: Buffer, cfg: ClassifyConfig | null = null): Verdict {
  if (B.length === 0) {
    return { kind: "utf8", encoding: "UTF-8", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };
  }
  // Check UTF-32 BOM before UTF-16LE (FF FE) and classify UTF-32 as binary.
  if (startsWith(B, [0xef, 0xbb, 0xbf])) {
    if (!isValidUtf8Strict(B.subarray(3)))
      return { kind: "unknown", encoding: "UNKNOWN", ambiguous: false, hasFffd: true, candidates: [], exhaustive: true, bom: true };
    return { kind: "utf8-bom", encoding: "UTF-8", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: true };
  }
  if (startsWith(B, [0xff, 0xfe, 0x00, 0x00]) || startsWith(B, [0x00, 0x00, 0xfe, 0xff]))
    return { kind: "binary", encoding: "BINARY", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };
  if (startsWith(B, [0xff, 0xfe])) {
    if (!isValidUtf16Body(B.subarray(2), true))
      return { kind: "unknown", encoding: "UNKNOWN", ambiguous: false, hasFffd: true, candidates: [], exhaustive: true, bom: true };
    return { kind: "utf16le", encoding: "UTF-16LE", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: true };
  }
  if (startsWith(B, [0xfe, 0xff])) {
    if (!isValidUtf16Body(B.subarray(2), false))
      return { kind: "unknown", encoding: "UNKNOWN", ambiguous: false, hasFffd: true, candidates: [], exhaustive: true, bom: true };
    return { kind: "utf16be", encoding: "UTF-16BE", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: true };
  }

  if (containsNul(B))
    return { kind: "binary", encoding: "BINARY", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };

  let pref: string | null = null;
  if (cfg?.sourceEncoding) {
    try {
      pref = normalizeEncoding(cfg.sourceEncoding);
    } catch {
      pref = null;
    }
  }

  if (cfg?.force && pref) return configVerdict(B, pref, "force");

  if (isAllAscii(B))
    return { kind: "ascii", encoding: "UTF-8", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };

  if (isValidUtf8Strict(B))
    return { kind: "utf8", encoding: "UTF-8", ambiguous: false, hasFffd: false, candidates: [], exhaustive: true, bom: false };

  const cands = normalizeCandidates(cfg?.autoCandidates);
  if (pref && !cands.includes(pref)) {
    if (isSingleByteEncoding(pref) || isStatefulEncoding(pref)) return configVerdict(B, pref, "undecidable");
  }
  const order = pref && cands.includes(pref) ? [pref, ...cands.filter((c) => c !== pref)] : cands;
  const pass: string[] = [];
  let exhaustive = true;
  for (let i = 0; i < order.length; i++) {
    const e = order[i];
    if (!exactRoundTrip(B, e)) continue;
    pass.push(e);
    if (pref && e === pref) {
      exhaustive = false;
      break;
    }
    if (B.length > FULL_SCAN_LIMIT) {
      exhaustive = false;
      break;
    }
  }
  if (pass.length === 0) {
    if (pref && !cands.includes(pref))
      return { ...configVerdict(B, pref, "undecidable"), kind: "config" };
    return { kind: "unknown", encoding: "UNKNOWN", ambiguous: false, hasFffd: true, candidates: [], exhaustive: true, bom: false };
  }
  const chosen = pref && pass.includes(pref) ? pref : pass[0];
  return {
    kind: "cjk",
    encoding: chosen,
    ambiguous: exhaustive ? pass.length > 1 : pass.length > 1 || order.length > pass.length,
    hasFffd: false,
    candidates: pass,
    exhaustive,
    bom: false,
  };
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  verdict: Verdict;
}
const fileCache = new Map<string, CacheEntry>();
const fsStat = fsp.stat;
const CFG_SEP = "\u0000";

function cfgKeyPart(cfg: ClassifyConfig | null): string {
  if (!cfg) return "-";
  return `${cfg.sourceEncoding ?? "-"}|${(cfg.autoCandidates ?? []).join(",")}|${cfg.force ? 1 : 0}`;
}

export function classifyFileCached(absPath: string, cfg: ClassifyConfig | null): Verdict {
  const key = cacheKey(absPath, cfg);
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return classifyBuffer(Buffer.alloc(0), cfg);
  }
  const hit = fileCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.verdict;
  const verdict = classifyBuffer(readFileSync(absPath), cfg);
  store(key, st, verdict);
  return verdict;
}

export async function verdictForBuffer(absPath: string, buf: Buffer, cfg: ClassifyConfig | null): Promise<Verdict> {
  const key = cacheKey(absPath, cfg);
  let st;
  try {
    st = await fsStat(absPath);
  } catch {
    return classifyBuffer(buf, cfg);
  }
  const hit = fileCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.verdict;
  const verdict = classifyBuffer(buf, cfg);
  store(key, st, verdict);
  return verdict;
}

function cacheKey(absPath: string, cfg: ClassifyConfig | null): string {
  return normalizePathKey(absPath) + CFG_SEP + cfgKeyPart(cfg);
}

function store(key: string, st: { mtimeMs: number; size: number }, verdict: Verdict): void {
  fileCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, verdict });
  if (fileCache.size > 20000) {
    for (const k of [...fileCache.keys()].slice(0, 10000)) fileCache.delete(k);
  }
}

export function clearClassifyCache(): void {
  fileCache.clear();
}

export function invalidateClassifyCache(absPath: string): void {
  const target = normalizePathKey(absPath);
  for (const k of [...fileCache.keys()]) if (k.split(CFG_SEP)[0] === target) fileCache.delete(k);
}

export function describeVerdict(v: Verdict): string {
  const bits = [`${v.kind}:${v.encoding}`];
  if (v.ambiguous) bits.push(`候选=${v.candidates.join(">") || "多"}`);
  if (v.hasFffd) bits.push("含U+FFFD");
  return bits.join(" ");
}
