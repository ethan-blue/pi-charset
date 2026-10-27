import iconv from "iconv-lite";

export class UnsupportedEncodingError extends Error {
  constructor(public readonly label: string) {
    super(
      `不支持的编码 "${label}"：iconv-lite 未收录该编码。` +
        `可用编码示例：UTF-8 / GB18030 / GBK / GB2312 / Big5 / Shift_JIS / EUC-KR / EUC-JP / ` +
        `ISO-8859-1 / windows-1252 / UTF-16LE / UTF-16BE / UTF-32LE。`,
    );
    this.name = "UnsupportedEncodingError";
  }
}

/** Multi-byte CJK encodings eligible for lossless byte round-trip classification (single-byte encodings excluded). */
export const AUTO_CJK_CANDIDATES = [
  "GB18030",
  "GBK",
  "GB2312",
  "Big5",
  "Shift_JIS",
  "EUC-KR",
  "EUC-JP",
] as const;

const ALIASES: Record<string, string> = {
  UTF8: "UTF-8",
  "UTF-8": "UTF-8",
  "UNICODE-1-1-UTF-8": "UTF-8",
  "UTF-16": "UTF-16LE",
  UTF16: "UTF-16LE",
  "UTF-16LE": "UTF-16LE",
  UCS2LE: "UTF-16LE",
  "UTF-16BE": "UTF-16BE",
  UCS2BE: "UTF-16BE",
  "UTF-32LE": "UTF-32LE",
  "UTF-32BE": "UTF-32BE",
  GB18030: "GB18030",
  GBK: "GBK",
  CP936: "GBK",
  MS936: "GBK",
  "X-CP936": "GBK",
  GB2312: "GB2312",
  "EUC-CN": "GB2312",
  CP937: "GB2312",
  BIG5: "Big5",
  "BIG-5": "Big5",
  CP950: "Big5",
  "MS-950": "Big5",
  "SHIFT-JIS": "Shift_JIS",
  SJIS: "Shift_JIS",
  CP932: "Shift_JIS",
  "X-SJIS": "Shift_JIS",
  "EUC-KR": "EUC-KR",
  CP949: "EUC-KR",
  UHC: "EUC-KR",
  "EUC-JP": "EUC-JP",
  "EUCJP-MS": "EUC-JP",
  "ISO-8859-1": "ISO-8859-1",
  LATIN1: "ISO-8859-1",
  "ISO8859-1": "ISO-8859-1",
  CP819: "ISO-8859-1",
  "ISO-8859-2": "ISO-8859-2",
  "ISO-8859-5": "ISO-8859-5",
  "ISO-8859-7": "ISO-8859-7",
  "ISO-8859-9": "ISO-8859-9",
  "ISO-8859-15": "ISO-8859-15",
  "WINDOWS-1250": "windows-1250",
  "WINDOWS-1251": "windows-1251",
  "WINDOWS-1252": "windows-1252",
  CP1252: "windows-1252",
  CP1251: "windows-1251",
  CP1250: "windows-1250",
  KOI8R: "KOI8-R",
  KOI8U: "KOI8-U",
  CP437: "CP437",
  CP850: "CP850",
  CP852: "CP852",
  MACINTOSH: "MACINTOSH",
  IBM866: "CP866",
  ASCII: "US-ASCII",
  "US-ASCII": "US-ASCII",
};

export function normalizeEncoding(label: string | undefined | null): string {
  const raw = String(label ?? "").trim();
  if (!raw) return "UTF-8";
  const key = raw.toUpperCase().replace(/_/g, "-").replace(/\s+/g, "");
  const alias = ALIASES[key] ?? ALIASES[key.replace(/-/g, "")];
  const candidate = alias ?? raw;
  if (!iconv.encodingExists(candidate)) {
    const loose = candidate.replace(/-/g, "");
    if (iconv.encodingExists(loose)) return loose;
    throw new UnsupportedEncodingError(raw);
  }
  return candidate;
}

export function isSupportedEncoding(label: string): boolean {
  try {
    normalizeEncoding(label);
    return true;
  } catch {
    return false;
  }
}

const GB_RE = /^(GB18030|GBK|GB2312|EUC-?CN|CP936|CP937|GBK-?EUIPO)$/i;

export function isGBEncoding(encoding: string): boolean {
  const n = safeNormalize(encoding);
  return GB_RE.test(n) || n.toUpperCase().includes("GB");
}

function safeNormalize(label: string): string {
  try {
    return normalizeEncoding(label);
  } catch {
    return label;
  }
}

/** Single-byte encodings round-trip arbitrary byte sequences and require explicit force: true in configuration. */
const SINGLE_BYTE_RE =
  /^(ISO-8859-\d+|ISO-8859-1[0-6]|windows-125\d|windows-1250|CP125\d|CP437|CP850|CP852|CP855|CP866|CP874|KOI8-[RU]|MACINTOSH|IBM\d{3,4}|US-ASCII|LATIN\d)$/i;
export function isSingleByteEncoding(encoding: string): boolean {
  const n = safeNormalize(encoding);
  return SINGLE_BYTE_RE.test(n) || SINGLE_BYTE_RE.test(n.replace(/-/g, ""));
}

/** Stateful escape-sequence encodings cannot be verified via byte-exact round-trip. */
const STATEFUL_RE = /^(ISO-2022-|EBCDIC|CS|\d{4}$)/i;
export function isStatefulEncoding(encoding: string): boolean {
  return STATEFUL_RE.test(safeNormalize(encoding).toUpperCase());
}

export function decodeToUtf8(buffer: Buffer, encoding: string): string {
  return iconv.decode(buffer, encoding);
}

export function encodeFromUtf8(text: string, encoding: string): Buffer {
  return iconv.encode(text, encoding);
}

/** Fast check for whether all code points in text can be losslessly represented in the target encoding. */
export function canEncodeAll(text: string, encoding: string): boolean {
  const buf = iconv.encode(text, encoding);
  if (!buf.includes(0x3f)) return true;
  return iconv.decode(buf, encoding) === text;
}

/** Collect code points in text that cannot be losslessly encoded in the target encoding. */
export function unmappableChars(text: string, encoding: string): string[] {
  const bad: string[] = [];
  for (const ch of text) {
    if (ch === "?") continue;
    const b = iconv.encode(ch, encoding);
    if (b.includes(0x3f) || iconv.decode(b, encoding) !== ch) {
      if (!bad.includes(ch)) bad.push(ch);
    }
  }
  return bad;
}

export function charListMessage(chars: string[]): string {
  return chars.map((c) => `${c} U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(", ");
}

/** Replace unmappable code points with \uXXXX escapes (surrogate pairs for astral code points). */
export function escapeUnmappable(text: string, encoding: string): string {
  if (canEncodeAll(text, encoding)) return text;
  let out = "";
  for (const ch of text) {
    const b = iconv.encode(ch, encoding);
    const lossy = b.includes(0x3f) || iconv.decode(b, encoding) !== ch;
    if (!lossy) {
      out += ch;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const hi = 0xd800 + ((cp - 0x10000) >> 10);
      const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
      out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
    } else {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}
