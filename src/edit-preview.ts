// Encoding-aware edit preview wrapper:
// Pi's built-in edit tool reads files directly as UTF-8 inside renderCall(), bypassing operations.readFile.
// This wrapper computes the preview diff from operations.readFile-decoded UTF-8 for non-UTF-8 files (including in zero-config mode),
// and delegates to the built-in renderCall for UTF-8 files.
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { configGeneration, findNearestConfigSync, resolveFileRule } from "./config";
import { classifyBuffer } from "./encoding/classify";
import { normalizePathKey } from "./path-key";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Text, Spacer } from "@earendil-works/pi-tui";
import {
  generateDiffString,
  renderDiff,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

interface EditEdit {
  oldText: string;
  newText: string;
}

/** Apply exact-match edits in reverse order against LF-normalized text to produce a preview diff. */
function applyEditsExact(normalizedContent: string, edits: EditEdit[], filePath: string): { baseContent: string; newContent: string } {
  const lfEdits = edits.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) }));
  for (let i = 0; i < lfEdits.length; i++) {
    if (lfEdits[i].oldText.length === 0) {
      throw new Error(`edits[${i}].oldText must not be empty in ${filePath}.`);
    }
  }
  type Matched = { matchIndex: number; matchLength: number; newText: string };
  const matched: Matched[] = [];
  for (let i = 0; i < lfEdits.length; i++) {
    const idx = normalizedContent.indexOf(lfEdits[i].oldText);
    if (idx === -1) {
      throw new Error(
        `Preview: could not exactly locate edits[${i}] in ${filePath}. The edit will still be attempted on execution.`,
      );
    }
    const occurrences = normalizedContent.split(lfEdits[i].oldText).length - 1;
    if (occurrences > 1) {
      throw new Error(`Preview: edits[${i}] is not unique in ${filePath} (${occurrences} occurrences); execution will also reject this.`);
    }
    matched.push({ matchIndex: idx, matchLength: lfEdits[i].oldText.length, newText: lfEdits[i].newText });
  }
  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    if (matched[i - 1].matchIndex + matched[i - 1].matchLength > matched[i].matchIndex) {
      throw new Error(`edits[${i - 1}] and edits[${i}] overlap in ${filePath}.`);
    }
  }
  let newContent = normalizedContent;
  for (let i = matched.length - 1; i >= 0; i--) {
    const m = matched[i];
    newContent = newContent.substring(0, m.matchIndex) + m.newText + newContent.substring(m.matchIndex + m.matchLength);
  }
  return { baseContent: normalizedContent, newContent };
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  gen: number;
  builtinPreviewIsSafe: boolean;
}
const utf8Cache = new Map<string, CacheEntry>();

/** Return true if the built-in UTF-8 preview renderer can safely handle absPath (cached by mtimeMs + size + configGeneration). */
export function isUtf8FileCached(absPath: string): boolean {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(absPath);
  } catch {
    return true;
  }
  const gen = configGeneration();
  const key = normalizePathKey(absPath);
  const cached = utf8Cache.get(key);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.gen === gen)
    return cached.builtinPreviewIsSafe;
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return true;
  }
  const found = findNearestConfigSync(path.dirname(absPath));
  const rule = found ? resolveFileRule(absPath, found) : null;
  const v = classifyBuffer(
    buf,
    rule
      ? {
          sourceEncoding: rule.sourceEncoding,
          autoCandidates: rule.autoCandidates,
          force: rule.force,
        }
      : null,
  );
  const safe =
    v.kind === "utf8" || v.kind === "utf8-bom" || v.kind === "ascii" || v.kind === "binary" || v.kind === "unknown";
  utf8Cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, gen, builtinPreviewIsSafe: safe });
  if (utf8Cache.size > 512) {
    const firstKey = utf8Cache.keys().next().value;
    if (firstKey) utf8Cache.delete(firstKey);
  }
  return safe;
}

export function needsEncodingPreview(absPath: string): boolean {
  return !isUtf8FileCached(absPath);
}

export function clearUtf8Cache(): void {
  utf8Cache.clear();
}

interface EditPreviewArgs {
  path?: string;
  file_path?: string;
  edits?: EditEdit[];
  oldText?: string;
  newText?: string;
}

function getEditPath(args: EditPreviewArgs): string | null {
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  return null;
}

function getEditList(args: EditPreviewArgs): EditEdit[] | null {
  if (
    Array.isArray(args.edits) &&
    args.edits.length > 0 &&
    args.edits.every((e) => typeof e?.oldText === "string" && typeof e?.newText === "string")
  ) {
    return args.edits;
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    return [{ oldText: args.oldText, newText: args.newText }];
  }
  return null;
}

function formatEditHeader(args: EditPreviewArgs, theme: Theme, cwd: string): string {
  const rawPath = getEditPath(args);
  const display = rawPath ? path.relative(cwd, path.resolve(cwd, rawPath)) || rawPath : "(no path)";
  return `${theme.fg("toolTitle", theme.bold("edit"))} ${display}`;
}

interface EditRenderContext {
  lastComponent: Component | undefined;
  state: { callComponent?: Box } & Record<string, unknown>;
  invalidate: () => void;
  argsComplete: boolean;
}

export function wrapEditToolWithEncodingPreview(
  def: ToolDefinition<any, any, any>,
  operations: {
    readFile: (absPath: string) => Promise<Buffer>;
  },
  cwd: string,
): ToolDefinition<any, any, any> {
  const builtinRenderCall = def.renderCall;
  if (typeof builtinRenderCall !== "function") return def;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def.renderCall = (args: any, theme: Theme, context: any): Component => {
    const rawPath = getEditPath(args as EditPreviewArgs);
    if (!rawPath || isUtf8FileCached(path.resolve(cwd, rawPath))) {
      return builtinRenderCall(args, theme, context);
    }

    const ctx = context as EditRenderContext;
    const component =
      ctx.lastComponent instanceof Box ? (ctx.lastComponent as Box) : ctx.state.callComponent ?? new Box(1, 1, (t) => theme.bg("toolPendingBg", t));
    ctx.state.callComponent = component;

    const argsKey = JSON.stringify({ path: rawPath, edits: getEditList(args as EditPreviewArgs) });
    const st = component as Box & {
      preview?: { diff?: string; error?: string } | undefined;
      previewArgsKey?: string | undefined;
      previewPending?: boolean;
      settledError?: boolean;
    };
    if (st.previewArgsKey !== argsKey) {
      st.preview = undefined;
      st.previewArgsKey = argsKey;
      st.previewPending = false;
      st.settledError = false;
    }

    const build = (bgFn: (t: string) => string) => {
      component.setBgFn(bgFn);
      component.clear();
      component.addChild(new Text(formatEditHeader(args as EditPreviewArgs, theme, cwd), 0, 0));
      let body: string | undefined;
      if (st.preview) {
        if ("error" in st.preview && st.preview.error) {
          body = theme.fg("error", st.preview.error);
        } else if (st.preview.diff) {
          try {
            body = renderDiff(st.preview.diff, { filePath: rawPath });
          } catch {
            body = st.preview.diff;
          }
        }
      }
      if (body) {
        component.addChild(new Spacer(1));
        component.addChild(new Text(body, 0, 0));
      }
      return component;
    };

    build((t) => theme.bg("toolPendingBg", t));

    if (ctx.argsComplete && getEditList(args as EditPreviewArgs) && !st.preview && !st.previewPending) {
      st.previewPending = true;
      const requestKey = argsKey;
      const absolutePath = path.resolve(cwd, rawPath);
      void (async () => {
        let preview: { diff?: string; error?: string };
        try {
          const buffer = await operations.readFile(absolutePath);
          const rawContent = buffer.toString("utf-8");
          const { text: withoutBom } = stripBom(rawContent);
          const ending = detectLineEnding(withoutBom);
          const normalized = normalizeToLF(withoutBom);
          const { baseContent, newContent } = applyEditsExact(normalized, getEditList(args as EditPreviewArgs)!, rawPath);
          const finalNew = restoreLineEndings(newContent, ending);
          const { diff } = generateDiffString(baseContent, finalNew, 4);
          preview = { diff };
        } catch (err) {
          preview = { error: err instanceof Error ? err.message : String(err) };
        }
        if (st.previewArgsKey === requestKey) {
          st.preview = preview;
          st.previewPending = false;
          st.settledError = Boolean(preview.error);
          try {
            build(
              preview.error
                ? (t) => theme.bg("toolErrorBg", t)
                : (t) => theme.bg("toolSuccessBg", t),
            );
          } catch {
            /* Ignore theme singleton errors in non-TUI test environments. */
          }
          ctx.invalidate();
        }
      })();
    }

    return component;
  };

  return def;
}
