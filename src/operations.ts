// File I/O operations for Pi's read, write, and edit tools:
// - Read: single-read buffer -> image binary guard -> read plan -> decode to UTF-8 -> record SHA-1 baseline fingerprint.
// - Write: single pre-write disk read -> write plan & Gate 3 -> Gate 1 (unmappable code points) -> line-ending & BOM restoration
//          -> pre-write round-trip check -> SHA-1 baseline conflict check -> atomic replace -> Gate 2 (post-write read-back).
import { readFile, mkdir, access, rename, unlink, open, stat, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
} from "@earendil-works/pi-coding-agent";
import { clearConfigCache, CONFIG_FILENAME, type ResolvedConfig } from "./config";
import { resolveReadPlan, resolveWritePlan, type WritePlan } from "./resolve";
import { normalizePathKey } from "./path-key";
import {
  canEncodeAll,
  charListMessage,
  decodeToUtf8,
  encodeFromUtf8,
  escapeUnmappable,
  isGBEncoding,
  isWellFormed,
  normalizeEncoding,
  unmappableChars,
} from "./encoding/converter";
import { classifyBuffer, describeVerdict, invalidateClassifyCache } from "./encoding/classify";
import {
  detectLineEndingKind,
  restoreLineEndings,
  type LineEndingKind,
} from "./encoding/line-endings";
import { pushEncodingNote } from "./notify";
import {
  detectSupportedImageMimeType,
  detectSupportedImageMimeTypeFromFile,
} from "./encoding/mime";

const BOM_BYTES = {
  utf8: Buffer.from([0xef, 0xbb, 0xbf]),
  utf16le: Buffer.from([0xff, 0xfe]),
  utf16be: Buffer.from([0xfe, 0xff]),
} as const;

/**
 * SHA-1 fingerprint recorded when a file is read, checked before writes to detect external edits.
 * Entries hold a normalized path and a 40-character SHA-1; memory grows with files read in the session.
 * Session start and extension reload clear the map. Do not silently evict entries:
 * that would discard external-modification conflict detection for previously read files.
 */
const readBaselines = new Map<string, string>();

function recordBaseline(key: string, hash: string): void {
  readBaselines.set(key, hash);
}

export function clearReadBaselines(): void {
  readBaselines.clear();
}

const baselineKey = (absPath: string) => normalizePathKey(absPath);
const sha1 = (buf: Buffer) => createHash("sha1").update(buf).digest("hex");

function mixedLineEndingError(absPath: string): Error {
  return new Error(
    `拒写 ${absPath}：文件同时包含 CRLF 与 LF（混合换行）。` +
      `直接写入会将全文行尾统一，已拒绝修改；文件仍可正常读取。` +
      `请先使用编辑器或 dos2unix/unix2dos 统一换行后再修改。`,
  );
}

async function readAsUtf8Buffer(absPath: string, opts?: { forEdit?: boolean }): Promise<Buffer> {
  const raw = await readFile(absPath);
  if (detectSupportedImageMimeType(raw)) return raw;

  const plan = await resolveReadPlan(absPath, raw);
  for (const w of plan.warnings) pushEncodingNote(absPath, w);
  if (plan.verdict.kind === "binary") return raw;
  // Reject mixed line endings during edit's read phase before built-in edit normalizes line endings.
  if (opts?.forEdit && detectLineEndingKind(raw, plan.encoding) === "MIXED") throw mixedLineEndingError(absPath);
  recordBaseline(baselineKey(absPath), sha1(raw));
  if (plan.encoding === "UTF-8" || plan.encoding === "BINARY" || plan.encoding === "UNKNOWN") {
    return plan.note ? Buffer.concat([raw, Buffer.from(`\n\n${plan.note}\n`, "utf-8")]) : raw;
  }
  const text = decodeToUtf8(raw, plan.encoding);
  const out = Buffer.from(text, "utf-8");
  return plan.note ? Buffer.concat([out, Buffer.from(`\n\n${plan.note}\n`, "utf-8")]) : out;
}

function isNotFound(e: unknown): boolean {
  return (e as { code?: string })?.code === "ENOENT";
}

/** Read the target file once prior to writing (returns null if the file does not exist yet). Rejects symlinks. */
async function readExistingOrNull(absPath: string): Promise<Buffer | null> {
  try {
    const lst = await lstat(absPath);
    if (lst.isSymbolicLink()) {
      throw new Error(
        `拒写 ${absPath}：该路径为符号链接（symlink）。为防止替换符号链接本身或引发安全竞态，已拒绝写入。请直接对目标文件进行修改。`,
      );
    }
    if (!lst.isFile()) return null;
    return await readFile(absPath);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function gate1Message(absPath: string, bad: string[], enc: string, strategy: string): string {
  const list = charListMessage(bad.slice(0, 12));
  const more = bad.length > 12 ? `…共 ${bad.length} 个不同字符` : "";
  const isGb = isGBEncoding(enc);
  const isGb18030 = normalizeEncoding(enc) === "GB18030";

  let suggestion: string;
  if (isGb && !isGb18030) {
    suggestion = `建议将该目录或 pattern 的 "writeEncoding" 改为 "GB18030"（GBK 超集，原 GBK 字节保持不变）或 "UTF-8"。`;
  } else if (isGb18030) {
    suggestion = `建议将 "writeEncoding" 改为 "UTF-8"。`;
  } else {
    suggestion = `建议将 "writeEncoding" 改为可覆盖上述码点的编码（如 UTF-8 或 GB18030）。`;
  }

  const stratOptions =
    isGb && !isGb18030
      ? `（当前 unmappable="${strategy}"；也可设为 "escape" 转为 \\uXXXX，或设为 "drop-to-gb18030" 自动升为 GB18030）`
      : `（当前 unmappable="${strategy}"；也可设为 "escape" 转为 \\uXXXX）`;

  return (
    `闸门 1 拒写 ${absPath}：目标编码 ${enc} 无法表示以下内容（写出将变为 '?'）：` +
    `${list}${more}。${suggestion}${stratOptions}`
  );
}

function applyGate1(
  plan: WritePlan,
  text: string,
  absPath: string,
): { encoding: string; text: string; note: string | null } {
  const enc = plan.encoding!;
  const strategy = plan.rule?.unmappable ?? "error";
  if (canEncodeAll(text, enc)) return { encoding: enc, text, note: null };
  const bad = unmappableChars(text, enc);
  if (bad.length === 0) return { encoding: enc, text, note: null };
  if (strategy === "escape") {
    const escaped = escapeUnmappable(text, enc);
    return {
      encoding: enc,
      text: escaped,
      note:
        `闸门 1（escape）：${bad.length} 个 ${enc} 无法表示的字符已转为 \\uXXXX 转义：` +
        `${charListMessage(bad.slice(0, 12))}`,
    };
  }
  if (strategy === "drop-to-gb18030" && isGBEncoding(enc) && normalizeEncoding(enc) !== "GB18030") {
    if (unmappableChars(text, "GB18030").length === 0) {
      return {
        encoding: "GB18030",
        text,
        note:
          `闸门 1（drop-to-gb18030）：${enc} 无法表示 ${charListMessage(bad.slice(0, 12))}，` +
          `本次已升为 GB18030 写出`,
      };
    }
    throw new Error(gate1Message(absPath, unmappableChars(text, "GB18030"), "GB18030", strategy));
  }
  throw new Error(gate1Message(absPath, bad, enc, strategy));
}

function encodeForWrite(
  plan: WritePlan,
  encoding: string,
  text: string,
  absPath: string,
  prevRaw: Buffer | null,
): { bytes: Buffer; text: string; bomLen: number } {
  // Strip any leading U+FEFF from the text body and restore BOM at the byte level via plan.addBom.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  // Unified line ending handling across all encodings
  const kind: LineEndingKind | null =
    prevRaw === null ? null : detectLineEndingKind(prevRaw, plan.verdict?.encoding ?? encoding);
  if (kind === "MIXED") throw mixedLineEndingError(absPath);
  let restored = body;
  if (kind === "CRLF" || kind === "LF") {
    restored = restoreLineEndings(body, kind);
  } else if (kind === null && plan.rule?.newFileLineEnding) {
    restored = restoreLineEndings(body, plan.rule.newFileLineEnding);
  }

  const upper = encoding.toUpperCase();
  if (upper === "UTF-8") {
    const bom = plan.addBom === "utf8" ? BOM_BYTES.utf8 : Buffer.alloc(0);
    if (!isWellFormed(restored)) {
      throw new Error(
        `拒写 ${absPath}：内容含孤立 UTF-16 代理项，UTF-8 编码会产生 U+FFFD，已拒绝落盘。`,
      );
    }
    const bodyBytes = Buffer.from(restored, "utf-8");
    if (bodyBytes.toString("utf-8") !== restored) {
      throw new Error(
        `拒写 ${absPath}：内容含孤立 UTF-16 代理项，UTF-8 编码会产生 U+FFFD，已拒绝落盘。`,
      );
    }
    return { bytes: Buffer.concat([bom, bodyBytes]), text: restored, bomLen: bom.length };
  }

  if (!isWellFormed(restored)) {
    throw new Error(
      `拒写 ${absPath}：内容含孤立 UTF-16 代理项，已拒绝落盘。`,
    );
  }
  const bytes = encodeFromUtf8(restored, encoding);
  const bom =
    plan.addBom === "utf16le" ? BOM_BYTES.utf16le : plan.addBom === "utf16be" ? BOM_BYTES.utf16be : Buffer.alloc(0);
  const out = Buffer.concat([bom, bytes]);
  if (decodeToUtf8(out.subarray(bom.length), encoding) !== restored) {
    throw new Error(
      `拒写 ${absPath}：内容经 ${encoding} 编码后解码不一致，已拒绝落盘。可将 writeEncoding 改为 UTF-8 或 GB18030。`,
    );
  }
  return { bytes: out, text: restored, bomLen: bom.length };
}

/** Verify written bytes, encoding classification, and decoded text on disk; keep on-disk state if verification fails. */
async function verifyWritten(
  absPath: string,
  expectedBytes: Buffer,
  expectedText: string,
  encoding: string,
  rule: ResolvedConfig,
  bomLen = 0,
): Promise<string | null> {
  let written: Buffer;
  try {
    written = await readFile(absPath);
  } catch (e) {
    return `写后无法回读（${(e as Error).message}）`;
  }
  if (Buffer.compare(written, expectedBytes) !== 0) {
    return `写后回读的字节与预期不一致（${written.length}B vs ${expectedBytes.length}B，可能被其它进程改写）`;
  }
  const v = classifyBuffer(written, {
    sourceEncoding: encoding,
    autoCandidates: rule.autoCandidates,
    force: false,
  });
  const encU = encoding.toUpperCase();
  const okKind =
    v.kind === "ascii" ||
    (encU === "UTF-8" && (v.kind === "utf8" || v.kind === "utf8-bom")) ||
    (encU !== "UTF-8" && (v.kind === "cjk" || v.kind === "config")) ||
    (encU === "UTF-16LE" && v.kind === "utf16le") ||
    (encU === "UTF-16BE" && v.kind === "utf16be");
  if (!okKind) return `写后判定为 ${describeVerdict(v)}，与期望 ${encoding} 不符`;
  if (encU !== "UTF-8" && v.kind === "cjk" && normalizeEncoding(v.encoding) !== normalizeEncoding(encoding)) {
    return `写后判定为 ${v.encoding}，与期望 ${encoding} 不符`;
  }
  const text =
    encU === "UTF-8"
      ? written.subarray(bomLen).toString("utf-8")
      : decodeToUtf8(written.subarray(bomLen), encoding);
  if (text !== expectedText) {
    const i = firstDiffIndex(text, expectedText);
    return `写后按 ${encoding} 解码与期望文本不一致（首个差异偏移 ${i}）`;
  }
  return null;
}

function firstDiffIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

export interface WriteSeam {
  writeBytes: (absPath: string, bytes: Buffer, expectedPrevRaw?: Buffer | null) => Promise<void>;
}

export const defaultWriteSeam: WriteSeam = { writeBytes: atomicReplace };

async function writeEncoded(absPath: string, utf8content: string, seam: WriteSeam = defaultWriteSeam): Promise<void> {
  await withPathLock(absPath, () => writeEncodedLocked(absPath, utf8content, seam));
}

async function writeEncodedLocked(
  absPath: string,
  utf8content: string,
  seam: WriteSeam,
): Promise<void> {
  // Single pre-write disk read shared across plan resolution, line-ending detection, and SHA-1 baseline check.
  const prevRaw = await readExistingOrNull(absPath);
  const plan = await resolveWritePlan(absPath, utf8content, prevRaw);
  if (plan.reject) throw new Error(plan.reject);
  for (const w of plan.warnings) pushEncodingNote(absPath, w);

  const g1 = applyGate1(plan, utf8content, absPath);
  if (g1.note) pushEncodingNote(absPath, g1.note);
  const { bytes, text, bomLen } = encodeForWrite(plan, g1.encoding, g1.text, absPath, prevRaw);

  const remembered = readBaselines.get(baselineKey(absPath));
  if (remembered !== undefined) {
    if (prevRaw === null) {
      throw new Error(
        `拒写 ${absPath}：文件自上次读取后已被外部删除。请重新确认后再操作。`,
      );
    }
    if (sha1(prevRaw) !== remembered) {
      throw new Error(
        `拒写 ${absPath}：文件自上次读取后已被外部修改（磁盘内容与读取基线不一致）。` +
          `请重新读取该文件后再修改。`,
      );
    }
  }

  const verify = plan.rule?.verifyWrite !== false;
  const existed = prevRaw !== null;
  try {
    await seam.writeBytes(absPath, bytes, prevRaw);
  } catch (e) {
    throw new Error(
      `写入 ${absPath} 失败：${(e as Error).message}。磁盘当前状态未验证，请重新读取确认后再重试。` +
        `${g1.note ? `（${g1.note}）` : ""}`,
    );
  }
  if (verify && plan.rule) {
    const problem = await verifyWritten(absPath, bytes, text, g1.encoding, plan.rule, bomLen);
    if (problem) {
      throw new Error(
        `闸门 2（写后自校验）失败：${problem}。` +
          (existed
            ? `磁盘内容与本次写入不一致（可能被其它进程改写，外部修改冲突），已保留磁盘现状（未回滚）；请重新读取后决定。`
            : `文件写前不存在，已保留写出的内容供检查（未删除）；请读取核对后决定。`) +
          `${g1.note ? `（${g1.note}）` : ""}`,
      );
    }
  }
  afterWrite(absPath, bytes);
}

function afterWrite(absPath: string, written: Buffer | null): void {
  invalidateClassifyCache(absPath);
  const k = baselineKey(absPath);
  if (written === null) readBaselines.delete(k);
  else recordBaseline(k, sha1(written));
  if (path.basename(absPath) === CONFIG_FILENAME) {
    clearConfigCache();
  }
}

export function makeReadOperations(): ReadOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath),
    access: (absPath) => access(absPath, constants.R_OK),
    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
  };
}

export function makeWriteOperations(seam: WriteSeam = defaultWriteSeam): WriteOperations {
  return {
    writeFile: (absPath, content) => writeEncoded(absPath, content, seam),
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  };
}

export function makeEditOperations(seam: WriteSeam = defaultWriteSeam): EditOperations {
  return {
    readFile: (absPath) => readAsUtf8Buffer(absPath, { forEdit: true }),
    writeFile: (absPath, content) => writeEncoded(absPath, content, seam),
    access: (absPath) => access(absPath, constants.R_OK | constants.W_OK),
  };
}

const RENAME_RETRY_MS = [0, 8, 16, 32, 64, 128];

function isTransientLockError(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? "";
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "ENOTEMPTY" || code === "EDELET";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Atomic file replacement via same-directory temp file + fsync + rename with Windows transient-lock retries.
 * Rejects symbolic links explicitly to prevent replacing symlink targets or race vulnerabilities.
 * Preserves existing POSIX file permissions/mode.
 *
 * TOCTOU note:
 * When expectedPrevRaw is provided, destination state is re-checked immediately before rename.
 * Standard OS filesystem rename cannot perform cross-process atomic CAS without specialized platform
 * locks; this re-check minimizes the TOCTOU race window but cannot guarantee absolute elimination.
 */
export async function atomicReplace(
  absPath: string,
  bytes: Buffer,
  expectedPrevRaw?: Buffer | null,
): Promise<void> {
  let existingMode: number | undefined;
  try {
    const lst = await lstat(absPath);
    if (lst.isSymbolicLink()) {
      throw new Error(
        `拒写 ${absPath}：该路径为符号链接（symlink）。为防止替换符号链接本身或引发安全竞态，已拒绝写入。请直接对目标文件进行修改。`,
      );
    }
    if (lst.isFile()) {
      existingMode = lst.mode;
    }
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }

  const tmp = `${absPath}.${randomBytes(6).toString("hex")}.pi-charset.tmp`;
  const openMode = existingMode !== undefined ? existingMode & 0o777 : undefined;
  // Exclusive creation avoids following an unexpected existing temporary path.
  const fh = await open(tmp, "wx", openMode);
  try {
    try {
      await fh.writeFile(bytes);
      if (existingMode !== undefined) await fh.chmod(existingMode & 0o7777);
      await fh.sync();
    } finally {
      await fh.close();
    }

    for (let i = 0; ; i++) {
      // Recheck on every attempt, including after a Windows lock retry. This is
      // conflict detection, not a cross-process compare-and-swap guarantee.
      if (expectedPrevRaw !== undefined) {
        const current = await readExistingOrNull(absPath);
        const mismatch = expectedPrevRaw === null
          ? current !== null
          : current === null || !current.equals(expectedPrevRaw);
        if (mismatch) {
          throw new Error(
            `拒写 ${absPath}：落盘前复核发现文件已被外部进程修改或删除。请重新读取确认后再操作。`,
          );
        }
      }
      try {
        await rename(tmp, absPath);
        return;
      } catch (e) {
        if (i >= RENAME_RETRY_MS.length - 1 || !isTransientLockError(e)) throw e;
        // Keep the already-written temporary file rather than rewriting it.
        await sleep(RENAME_RETRY_MS[i + 1]);
      }
    }
  } finally {
    // Covers write/chmod/fsync/close failures as well as recheck/rename failures.
    await unlink(tmp).catch(() => undefined);
  }
}

const pathLocks = new Map<string, Promise<void>>();

/** Serialize async operations targeting the same file path (case-folded on Windows, case-sensitive on POSIX). */
export async function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const k = normalizePathKey(absPath);
  const tail = pathLocks.get(k) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  const guard = run.then(
    () => undefined,
    () => undefined,
  );
  pathLocks.set(k, guard);
  try {
    return await run;
  } finally {
    if (pathLocks.get(k) === guard) pathLocks.delete(k);
  }
}
