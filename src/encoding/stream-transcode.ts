// Streaming shell output transcoder:
// 1. Buffer output up to sampleBytes (or stream end) and classify the sample via classifyBuffer.
// 2. Pass valid UTF-8, ASCII, BINARY, and unforced UNKNOWN through unchanged.
// 3. Decode non-UTF-8 text with an iconv stateful decoder to handle multi-byte sequences split across chunks.
import iconv from "iconv-lite";
import { classifyBuffer, type Verdict } from "./classify";

export type TranscodeModeName = "passthrough" | "transcoded" | "binary-passthrough" | "empty";

export interface OutputTranscoderOptions {
  candidates: string[];
  /** Fallback encoding when byte classification is inconclusive (e.g., OS console codepage). */
  fallbackEncoding: string | null;
  /** Preferred candidate when multiple CJK encodings round-trip (project sourceEncoding). */
  priorityEncoding?: string | null;
  /** Explicit encoding override (e.g., configured encoding name or single-file dump encoding), applied only when non-UTF-8. */
  preferredEncoding?: string | null;
  sampleBytes?: number;
}

export interface TranscodeStats {
  mode: TranscodeModeName;
  encoding: string | null;
  inBytes: number;
  outBytes: number;
  lossy: boolean;
  verdict: Verdict | null;
  basis: string | null;
}

const DEFAULT_SAMPLE = 64 * 1024;

export interface OutputTranscoder {
  push(chunk: Buffer): Buffer;
  finish(): Buffer;
  stats(): TranscodeStats;
}

export function createOutputTranscoder(opts: OutputTranscoderOptions): OutputTranscoder {
  const sampleBytes = opts.sampleBytes ?? DEFAULT_SAMPLE;
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let decided = false;
  let decoder: ReturnType<typeof iconv.getDecoder> | null = null;
  const stats: TranscodeStats = {
    mode: "passthrough",
    encoding: null,
    inBytes: 0,
    outBytes: 0,
    lossy: false,
    verdict: null,
    basis: null,
  };

  function decide(all: Buffer): void {
    decided = true;
    if (all.length === 0) {
      stats.mode = "empty";
      return;
    }
    const sample = all.subarray(0, sampleBytes);
    const emitRaw = (mode: TranscodeModeName, basis: string) => {
      stats.mode = mode;
      stats.basis = basis;
      stats.outBytes += all.length;
      outBufs.push(all);
    };
    // Treat buffers ending with an incomplete UTF-8 multi-byte prefix as valid UTF-8 if the preceding bytes are valid.
    const truncated = incompleteUtf8Tail(sample);
    if (truncated > 0 && isUtf8Valid(sample.subarray(0, sample.length - truncated))) {
      emitRaw("passthrough", "输出为合法 UTF-8（尾部含截断多字节前缀）");
      return;
    }
    const v = classifyBuffer(sample, {
      sourceEncoding: opts.priorityEncoding ?? opts.fallbackEncoding ?? "GB18030",
      autoCandidates: opts.candidates,
      force: false,
    });
    stats.verdict = v;
    if (v.kind === "utf8" || v.kind === "utf8-bom" || v.kind === "ascii") {
      emitRaw("passthrough", `输出为合法 ${v.encoding}，原样透传`);
      return;
    }
    if (v.kind === "binary") {
      emitRaw("binary-passthrough", "输出判定为 binary，不转码");
      return;
    }
    if (v.kind === "unknown" && !opts.preferredEncoding) {
      emitRaw("binary-passthrough", "输出判定为 unknown，不转码");
      return;
    }
    let enc: string | null = null;
    let basis = "";
    if (opts.preferredEncoding && !isUtf8Valid(sample)) {
      enc = opts.preferredEncoding;
      basis = `按显式指定的 ${enc} 转码`;
    } else if (v.kind === "cjk") {
      enc = v.encoding;
      basis = `字节判定为 ${enc}（候选互校）`;
    } else if (v.kind === "config") {
      enc = v.encoding;
      basis = `按配置编码 ${enc} 转码`;
    } else if (opts.fallbackEncoding) {
      enc = opts.fallbackEncoding;
      basis = `字节未判定，回退至 ${enc}`;
    }
    if (!enc || !iconv.encodingExists(enc)) {
      emitRaw("binary-passthrough", enc ? `编码 "${enc}" 不受支持，原样透传` : "无可用目标编码，原样透传");
      return;
    }
    try {
      decoder = iconv.getDecoder(enc);
    } catch {
      emitRaw("binary-passthrough", `获取编码 "${enc}" 解码器失败，原样透传`);
      return;
    }
    stats.mode = "transcoded";
    stats.encoding = enc;
    stats.basis = basis;
    const text = decoder.write(all);
    pushOut(text);
  }

  function pushOut(text: string): void {
    if (!text) return;
    if (text.includes("\uFFFD")) stats.lossy = true;
    const buf = Buffer.from(text, "utf-8");
    stats.outBytes += buf.length;
    outBufs.push(buf);
  }

  let outBufs: Buffer[] = [];

  return {
    push(chunk: Buffer): Buffer {
      stats.inBytes += chunk.length;
      outBufs = [];
      if (!decided) {
        pending.push(chunk);
        pendingLen += chunk.length;
        if (pendingLen < sampleBytes) return Buffer.alloc(0);
        const all = Buffer.concat(pending, pendingLen);
        pending = [];
        pendingLen = 0;
        decide(all);
        return Buffer.concat(outBufs);
      }
      if (decoder) {
        pushOut(decoder.write(chunk));
        return Buffer.concat(outBufs);
      }
      stats.outBytes += chunk.length;
      return chunk;
    },

    finish(): Buffer {
      outBufs = [];
      if (!decided) {
        const all = pending.length ? Buffer.concat(pending, pendingLen) : Buffer.alloc(0);
        pending = [];
        pendingLen = 0;
        decide(all);
        return Buffer.concat(outBufs);
      }
      if (decoder) {
        pushOut(decoder.end() ?? "");
        decoder = null;
      }
      return Buffer.concat(outBufs);
    },

    stats(): TranscodeStats {
      return { ...stats };
    },
  };
}

function isUtf8Valid(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** Return the byte length of an incomplete valid UTF-8 multi-byte prefix at the end of buf (0 if none). */
export function incompleteUtf8Tail(buf: Buffer): number {
  const max = Math.min(3, buf.length);
  for (let k = max; k >= 1; k--) {
    const start = buf.length - k;
    const lead = buf[start];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
    if (need === 0) continue;
    if (k >= need) continue;
    for (let i = start + 1; i < buf.length; i++) {
      if ((buf[i] & 0xc0) !== 0x80) return 0;
    }
    return k;
  }
  return 0;
}
