export type LineEndingStyle = "CRLF" | "LF";

/** Line-ending classification: MIXED indicates both CRLF and LF are present; NONE indicates no newline characters. */
export type LineEndingKind = "CRLF" | "LF" | "MIXED" | "NONE";

export function detectLineEndingKind(buffer: Buffer): LineEndingKind {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0d && i + 1 < buffer.length && buffer[i + 1] === 0x0a) {
      crlf++;
      i++;
    } else if (buffer[i] === 0x0a) {
      lf++;
    }
  }
  if (crlf === 0 && lf === 0) return "NONE";
  if (crlf > 0 && lf > 0) return "MIXED";
  return crlf > 0 ? "CRLF" : "LF";
}

export function detectLineEnding(buffer: Buffer): LineEndingStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0d && i + 1 < buffer.length && buffer[i + 1] === 0x0a) {
      crlf++;
      i++;
    } else if (buffer[i] === 0x0a) {
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
