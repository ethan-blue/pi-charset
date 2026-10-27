// In-memory queue for non-fatal encoding and gate notices:
// Notices are queued by operations and drained in the tool_result hook so they never enter file content on disk.
import * as path from "node:path";

const MAX_FILES_TRACKED = 256;
const MAX_NOTES_PER_FILE = 6;

const pending = new Map<string, string[]>();

function key(absPath: string): string {
  return path.resolve(absPath).toLowerCase();
}

export function pushEncodingNote(absPath: string, message: string): void {
  if (!message) return;
  const k = key(absPath);
  let list = pending.get(k);
  if (!list) {
    if (pending.size >= MAX_FILES_TRACKED) pending.delete(pending.keys().next().value as string);
    list = [];
    pending.set(k, list);
  }
  if (list.length < MAX_NOTES_PER_FILE && !list.includes(message)) list.push(message);
}

export function drainEncodingNotes(absPath: string): string[] {
  const k = key(absPath);
  const list = pending.get(k);
  if (!list) return [];
  pending.delete(k);
  return list;
}

export function peekEncodingNotes(absPath: string): string[] {
  return pending.get(key(absPath)) ?? [];
}

export function clearEncodingNotes(): void {
  pending.clear();
}

const SHELL_KEY = "\u0000shell-output";

export function pushShellNote(message: string): void {
  if (!message) return;
  const list = pending.get(SHELL_KEY) ?? [];
  if (list.length < MAX_NOTES_PER_FILE && !list.includes(message)) {
    list.push(message);
    pending.set(SHELL_KEY, list);
  }
}

export function drainShellNotes(): string[] {
  const list = pending.get(SHELL_KEY);
  pending.delete(SHELL_KEY);
  return list ?? [];
}

export function notesToSuffix(notes: string[], maxChars = 400): string {
  if (!notes.length) return "";
  let text = notes.join("；");
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";
  return `\n\n[encoding] ${text}`;
}
