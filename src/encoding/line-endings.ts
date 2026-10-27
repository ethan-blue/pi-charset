import iconv from "iconv-lite";

export type LineEndingStyle = "CRLF" | "LF";

/** Line-ending classification: MIXED indicates both CRLF and LF are present; NONE indicates no newline characters. */
export type LineEndingKind = "CRLF" | "LF" | "MIXED" | "NONE";

/** Detect line-ending kind from decoded text string directly. */
export function detectLineEndingKindFromText(text: string): LineEndingKind {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
      crlf++;
      i++;
    } else if (text[i] === "\n") {
      lf++;
    }
  }
  if (crlf === 0 && lf === 0) return "NONE";
  if (crlf > 0 && lf > 0) return "MIXED";
  return crlf > 0 ? "CRLF" : "LF";
}

export function detectLineEndingFromText(text: string): LineEndingStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
      crlf++;
      i++;
    } else if (text[i] === "\n") {
      lf++;
    }
  }
  if (crlf === 0 && lf === 0) {
    return process.platform === "win32" ? "CRLF" : "LF";
  }
  return crlf >= lf ? "CRLF" : "LF";
}

/**
 * Detect line ending kind from buffer or text.
 * When encoding is UTF-16LE/BE or the buffer contains UTF-16 BOM, text-level decoding is used
 * to avoid false newlines from codepoints with 0x0A or 0x0D bytes (e.g. U+010A, U+010D).
 */
export function detectLineEndingKind(input: Buffer | string, encoding?: string): LineEndingKind {
  if (typeof input === "string") return detectLineEndingKindFromText(input);
  if (encoding) {
    const upper = encoding.toUpperCase();
    if (upper === "UTF-16LE" || upper === "UTF-16BE" || upper.startsWith("UTF-16") || upper.startsWith("UTF-32")) {
      return detectLineEndingKindFromText(iconv.decode(input, encoding));
    }
  }
  if (input.length >= 2) {
    if (input[0] === 0xff && input[1] === 0xfe && !(input.length >= 4 && input[2] === 0 && input[3] === 0)) {
      return detectLineEndingKindFromText(iconv.decode(input, "UTF-16LE"));
    }
    if (input[0] === 0xfe && input[1] === 0xff) {
      return detectLineEndingKindFromText(iconv.decode(input, "UTF-16BE"));
    }
  }
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0x0d && i + 1 < input.length && input[i + 1] === 0x0a) {
      crlf++;
      i++;
    } else if (input[i] === 0x0a) {
      lf++;
    }
  }
  if (crlf === 0 && lf === 0) return "NONE";
  if (crlf > 0 && lf > 0) return "MIXED";
  return crlf > 0 ? "CRLF" : "LF";
}

export function detectLineEnding(input: Buffer | string, encoding?: string): LineEndingStyle {
  if (typeof input === "string") return detectLineEndingFromText(input);
  if (encoding) {
    const upper = encoding.toUpperCase();
    if (upper === "UTF-16LE" || upper === "UTF-16BE" || upper.startsWith("UTF-16") || upper.startsWith("UTF-32")) {
      return detectLineEndingFromText(iconv.decode(input, encoding));
    }
  }
  if (input.length >= 2) {
    if (input[0] === 0xff && input[1] === 0xfe && !(input.length >= 4 && input[2] === 0 && input[3] === 0)) {
      return detectLineEndingFromText(iconv.decode(input, "UTF-16LE"));
    }
    if (input[0] === 0xfe && input[1] === 0xff) {
      return detectLineEndingFromText(iconv.decode(input, "UTF-16BE"));
    }
  }
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0x0d && i + 1 < input.length && input[i + 1] === 0x0a) {
      crlf++;
      i++;
    } else if (input[i] === 0x0a) {
      lf++;
    }
  }
  if (crlf === 0 && lf === 0) {
    return process.platform === "win32" ? "CRLF" : "LF";
  }
  return crlf >= lf ? "CRLF" : "LF";
}

export function restoreLineEndings(text: string, style: LineEndingStyle): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (style === "CRLF") {
    return normalized.replace(/\n/g, "\r\n");
  }
  return normalized;
}
