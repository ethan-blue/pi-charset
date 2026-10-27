// Conditional system prompt injection: injects ENCODING_NOTE only when a configuration file applies to the current working tree.
import { findNearestConfig, CONFIG_FILENAME } from "./config";
import { existsSync } from "node:fs";
import * as path from "node:path";

export const ENCODING_NOTE = `Encoding (a \`${CONFIG_FILENAME}\` applies here): \`read\`/\`write\`/\`edit\`/\`grep\` convert per file by deterministic byte classification — no guessing, no subprocess.
Existing files keep their own on-disk encoding; UTF-8 files are protected from being down-converted; a character the target encoding cannot represent fails loudly instead of turning into \`?\`. Never \`iconv\` a file or re-save it as UTF-8.
If a read reports \`[encoding: UNKNOWN]\` or a write is refused: stop and ask the user which encoding is correct — do not guess and do not convert by hand.`;

const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "target", "build", "dist", ".next"]);
const SCAN_MAX_DIRS = 400;

export async function configAppliesTo(cwd: string): Promise<boolean> {
  if (await findNearestConfig(cwd)) return true;
  if (existsSync(path.join(cwd, CONFIG_FILENAME))) return true;
  let visited = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  while (stack.length && visited < SCAN_MAX_DIRS) {
    const { dir, depth } = stack.pop()!;
    visited++;
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await import("node:fs")).readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => !e.isDirectory() && e.name === CONFIG_FILENAME) && depth > 0) return true;
    if (depth >= 3) continue;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SCAN_SKIP_DIRS.has(e.name)) {
        stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return false;
}

export async function systemNoteFor(cwd: string): Promise<string | null> {
  return (await configAppliesTo(cwd)) ? ENCODING_NOTE : null;
}
