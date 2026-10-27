// Read Pi's shellPath and shellCommandPrefix settings when registering custom bash tools.
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { stripJsonComments } from "./config";

export interface PiShellSettings {
  shellPath?: string;
  shellCommandPrefix?: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(stripJsonComments(readFileSync(file, "utf-8"))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeShellPath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function pick(src: Record<string, unknown> | null): PiShellSettings {
  const out: PiShellSettings = {};
  const sp = normalizeShellPath(src?.shellPath);
  if (sp) out.shellPath = sp;
  if (typeof src?.shellCommandPrefix === "string" && src.shellCommandPrefix) {
    out.shellCommandPrefix = src.shellCommandPrefix;
  }
  return out;
}

export function readPiShellSettings(cwd: string): PiShellSettings {
  let globalFile: string;
  try {
    globalFile = path.join(getAgentDir(), "settings.json");
  } catch {
    globalFile = path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "settings.json");
  }
  return { ...pick(readJson(globalFile)), ...pick(readJson(path.join(cwd, CONFIG_DIR_NAME, "settings.json"))) };
}
