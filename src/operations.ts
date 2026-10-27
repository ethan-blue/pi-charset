// File I/O operations for Pi's read, write, and edit tools:
// - Read: single-read buffer -> image binary guard -> read plan -> decode to UTF-8 -> record SHA-1 baseline fingerprint.
// - Write: single pre-write disk read -> write plan & Gate 3 -> Gate 1 (unmappable code points) -> line-ending & BOM restoration
//          -> pre-write round-trip check -> SHA-1 baseline conflict check -> atomic replace -> Gate 2 (post-write read-back).
import { readFile, mkdir, access, rename, unlink, open, stat } from "node:fs/promises";
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
import {
  canEncodeAll,
  charListMessage,
  decodeToUtf8,
  encodeFromUtf8,
  escapeUnmappable,
  isGBEncoding,
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

/** SHA-1 fingerprint recorded when a file is read, checked before writes to detect external edits. */
const readBaselines = new Map<string, string>();

export function clearReadBaselines(): void {
  readBaselines.clear();
}

const baselineKey = (absPath: string) => path.resolve(absPath).toLowerCase();
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
  if (opts?.forEdit && plan.transcoded && detectLineEndingKind(raw) === "MIXED") throw mixedLineEndingError(absPath);
  readBaselines.set(baselineKey(absPath), sha1(raw));
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

/** Read the target file once prior to writing (returns null if the file does not exist yet). */
async function readExistingOrNull(absPath: string): Promise<Buffer | null> {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) return null;
    return await readFile(absPath);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function gate1Message(absPath: string, bad: string[], enc: string, strategy: string): string {
  const list = charListMessage(bad.slice(0, 12));
  const more = bad.length > 12 ? `…共 ${bad.length} 个不同字符` : "";
  return (
    `闸门 1 拒写 ${absPath}：目标编码 ${enc} 无法表示以下内容（写出将变为 '?'）：` +
    `${list}${more}。` +
    (isGBEncoding(enc)
      ? `建议将该目录或 pattern 的 "writeEncoding" 改为 "GB18030"（GBK 超集，原 GBK 字节保持不变）。`
      : `建议将 "writeEncoding" 改为可覆盖上述码点的编码（如 UTF-8 或 GB18030）。`) +
    `（当前 unmappable="${strategy}"；也可设为 "escape" 转为 \\uXXXX，或设为 "drop-to-gb18030" 自动升为 GB18030）`
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
  const upper = encoding.toUpperCase();
  if (upper === "UTF-8") {
    const bom = plan.addBom === "utf8" ? BOM_BYTES.utf8 : Buffer.alloc(0);
    const bodyBytes = Buffer.from(body, "utf-8");
    if (bodyBytes.toString("utf-8") !== body) {
      throw new Error(
        `拒写 ${absPath}：内容含孤立 UTF-16 代理项，UTF-8 编码会产生 U+FFFD，已拒绝落盘。`,
      );
    }
    return { bytes: Buffer.concat([bom, bodyBytes]), text: body, bomLen: bom.length };
  }
  const kind: LineEndingKind | null = prevRaw === null ? null : detectLineEndingKind(prevRaw);
  if (kind === "MIXED") throw mixedLineEndingError(absPath);
  let restored = body;
  if (kind === "CRLF" || kind === "LF") {
    restored = restoreLineEndings(body, kind);
  } else if (kind === null && plan.rule?.newFileLineEnding) {
    restored = restoreLineEndings(body, plan.rule.newFileLineEnding);
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
  writeBytes: (absPath: string, bytes: Buffer) => Promise<void>;
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
  if (remembered !== undefined && prevRaw !== null && sha1(prevRaw) !== remembered) {
    throw new Error(
      `拒写 ${absPath}：文件自上次读取后已被外部修改（磁盘内容与读取基线不一致）。` +
        `请重新读取该文件后再修改。`,
    );
  }

  const verify = plan.rule?.verifyWrite !== false;
  const existed = prevRaw !== null;
  try {
    await seam.writeBytes(absPath, bytes);
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
            ? `磁盘内容与本次写入不一致（可能被其它进程改写，外部修改冲突），已保留磁盘现状（未回滚、未覆盖）；请重新读取后决定。`
            : `文件写前不存在，已保留写出的内容供检查（未删除）；请读取核对后决定。`) +
          `${g1.note ? `（${g1.note}）` : ""}`,
      );
    }
  }
  afterWrite(absPath, bytes);
}

function afterWrite(absPath: string, written: Buffer | null): void {
  invalidateClassifyCache(absPath);
  if (written === null) readBaselines.delete(baselineKey(absPath));
  else readBaselines.set(baselineKey(absPath), sha1(written));
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

/** Atomic file replacement via same-directory temp file + fsync + rename with Windows transient-lock retries. */
export async function atomicReplace(absPath: string, bytes: Buffer): Promise<void> {
  const tmp = `${absPath}.${randomBytes(6).toString("hex")}.pi-charset.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, absPath);
      return;
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      if (i >= RENAME_RETRY_MS.length - 1 || !isTransientLockError(e)) throw e;
      await sleep(RENAME_RETRY_MS[i]);
      const again = await open(tmp, "w");
      try {
        await again.writeFile(bytes);
        await again.sync();
      } finally {
        await again.close();
      }
    }
  }
}

const pathLocks = new Map<string, Promise<void>>();

/** Serialize async operations targeting the same case-insensitive file path. */
export async function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const k = path.resolve(absPath).toLowerCase();
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
