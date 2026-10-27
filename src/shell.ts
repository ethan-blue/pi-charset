// Shell output transcoding wrapper for bash and powershell tools (registered only when transcodeBash is enabled).
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ShellTranscodeRule } from "./config";
import { createOutputTranscoder, type TranscodeStats } from "./encoding/stream-transcode";
import { resolveReadPlan } from "./resolve";
import { pushShellNote } from "./notify";
import { isSupportedEncoding, normalizeEncoding } from "./encoding/converter";

export interface ShellOperationsLike {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

let lastStats: TranscodeStats | null = null;
export function lastShellTranscodeStats(): TranscodeStats | null {
  return lastStats;
}

const CODEPAGE_TO_ICONV: Record<number, string | null> = {
  65001: null,
  936: "GB18030",
  950: "Big5",
  932: "CP932",
  949: "CP949",
  1252: "windows-1252",
  1250: "windows-1250",
  1251: "windows-1251",
  1254: "windows-1254",
  1256: "windows-1256",
  437: "cp437",
  850: "cp850",
  852: "cp852",
  866: "cp866",
};

let osEncodingCache: string | null | undefined;

/** Detect the OS console codepage (chcp on Windows; LC_ALL/LC_CTYPE/LANG on POSIX). */
export function osConsoleEncoding(): string | null {
  if (osEncodingCache !== undefined) return osEncodingCache;
  if (process.platform === "win32") {
    try {
      const out = execFileSync("chcp.com", [], { encoding: "latin1", timeout: 5000, windowsHide: true });
      const m = /(\d{3,5})/.exec(out);
      const cp = m ? Number(m[1]) : NaN;
      const rawEnc = Number.isFinite(cp) ? (CODEPAGE_TO_ICONV[cp] ?? null) : null;
      osEncodingCache = rawEnc && isSupportedEncoding(rawEnc) ? normalizeEncoding(rawEnc) : null;
    } catch {
      osEncodingCache = null;
    }
  } else {
    const loc = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
    const charset = (loc.split(".")[1] || "").split("@")[0].toUpperCase();
    if (!charset || charset === "UTF-8" || charset === "UTF8") {
      osEncodingCache = null;
    } else {
      let resolved: string | null = null;
      if (charset === "GBK" || charset === "GB2312" || charset === "GB18030") resolved = "GB18030";
      else if (charset === "BIG5") resolved = "Big5";
      else if (charset === "EUC-KR") resolved = "CP949";
      else if (charset === "SHIFTJIS" || charset === "SJIS") resolved = "CP932";
      else {
        try {
          resolved = normalizeEncoding(charset);
        } catch {
          resolved = null;
        }
      }
      osEncodingCache = resolved && isSupportedEncoding(resolved) ? resolved : null;
    }
  }
  return osEncodingCache;
}

export function _resetOsEncodingCache(): void {
  osEncodingCache = undefined;
}

const DUMP_CMDS = new Set(["type", "cat", "more", "less", "head", "tail", "get-content"]);

/** Extract the target file path from a single-file dump command (returns null for wildcards, redirects, or multiple files). */
export function dumpCommandPath(command: string): string | null {
  const segments = command.split(/[|;&\n]+/);
  for (const seg of segments) {
    const toks = seg
      .trim()
      .match(/(?:"[^"]*"|'[^']*'|[^\s]+)+/g)
      ?.map((t) => t.replace(/^["']|["']$/g, ""));
    if (!toks || toks.length < 2) continue;
    const cmd = toks[0].toLowerCase().replace(/\.exe$/, "");
    if (!DUMP_CMDS.has(cmd)) continue;
    const args = toks.slice(1);
    const paths = args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a) && a !== ">" && a !== ">>");
    if (paths.length !== 1) continue;
    const p = paths[0];
    if (/[*?\[\]]/.test(p)) continue;
    return p;
  }
  return null;
}

export async function fileDumpEncodingForCommand(command: string, cwd: string): Promise<string | null> {
  const rel = dumpCommandPath(command);
  if (!rel) return null;
  const abs = path.resolve(cwd, rel);
  try {
    const plan = await resolveReadPlan(abs);
    if (!plan || !plan.transcoded) return null;
    if (plan.verdict.kind === "binary" || plan.verdict.kind === "unknown") return null;
    return plan.encoding;
  } catch {
    return null;
  }
}

export function makeTranscodingShellOperations(base: ShellOperationsLike, rule: ShellTranscodeRule): ShellOperationsLike {
  return {
    exec: async (command, cwd, options) => {
      const explicit = typeof rule.mode === "string" && rule.mode !== "auto" ? rule.mode : null;
      const preferred = (rule.fileDump ? await fileDumpEncodingForCommand(command, cwd) : null) ?? explicit;
      const fallback = rule.sourceEncoding ?? osConsoleEncoding();
      const t = createOutputTranscoder({
        candidates: rule.autoCandidates,
        priorityEncoding: rule.sourceEncoding,
        fallbackEncoding: fallback,
        preferredEncoding: preferred,
      });
      const forward = (buf: Buffer) => {
        if (buf.length > 0) options.onData(buf);
      };
      try {
        return await base.exec(command, cwd, {
          ...options,
          onData: (chunk: Buffer) => forward(t.push(chunk)),
        });
      } finally {
        forward(t.finish());
        lastStats = t.stats();
        const st = lastStats;
        if (st.mode === "transcoded") {
          pushShellNote(
            `bash 输出已由 ${st.encoding} 转成 UTF-8（${st.inBytes}B->${st.outBytes}B；依据：${st.basis ?? "n/a"}${
              st.lossy ? "；转码结果仍含 U+FFFD，输出中混有目标编码无法表示的字节" : ""
            }）。可通过 transcodeBash:false 关闭。`,
          );
        }
      }
    },
  };
}
