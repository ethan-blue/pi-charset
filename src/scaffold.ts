// Workspace encoding scanner and .pi-charset.json scaffolding helpers for /charset-init and /charset-scan commands.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME } from "./config";

export const PRESET_TEMPLATES = ["embedded-c", "legacy-java-web", "mixed-repo", "all-utf8"] as const;
export type PresetTemplate = (typeof PRESET_TEMPLATES)[number];

export interface ScaffoldResult {
  ok: boolean;
  text: string;
  wroteFile: boolean;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER_SCRIPT = path.join(PACKAGE_ROOT, "tools", "scan-encoding.mjs");
const EXAMPLES_DIR = path.join(PACKAGE_ROOT, "examples");

function tokenizeArgs(raw: string): string[] {
  return (raw.trim().match(/(?:"[^"]*"|'[^']*'|[^\s]+)+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

function runNodeScript(scriptPath: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { cwd, encoding: "utf-8", windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function isPresetTemplate(name: string): name is PresetTemplate {
  return (PRESET_TEMPLATES as readonly string[]).includes(name);
}

export function initUsageText(): string {
  return [
    "用法: /charset-init [--dry-run] [--force] [模板名]",
    "模式 1（默认扫描生成）: /charset-init [--dry-run] [--force]",
    `模式 2（预设模板脚手架）: /charset-init <${PRESET_TEMPLATES.join("|")}> [--dry-run] [--force]`,
  ].join("\n");
}

export async function runCharsetInit(cwd: string, rawArgs = ""): Promise<ScaffoldResult> {
  const tokens = tokenizeArgs(rawArgs);
  let dryRun = false;
  let force = false;
  let template: PresetTemplate | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--help" || t === "-h") {
      return { ok: true, text: initUsageText(), wroteFile: false };
    }
    if (t === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (t === "--force") {
      force = true;
      continue;
    }
    if (t === "--template") {
      const next = tokens[++i] ?? "";
      if (!isPresetTemplate(next)) {
        return {
          ok: false,
          text: `未知预设模板 "${next}"。可选模板：${PRESET_TEMPLATES.join(" / ")}\n${initUsageText()}`,
          wroteFile: false,
        };
      }
      template = next;
      continue;
    }
    if (!t.startsWith("-") && template === null && isPresetTemplate(t)) {
      template = t;
      continue;
    }
    return {
      ok: false,
      text: `不支持的参数 "${t}"。\n${initUsageText()}`,
      wroteFile: false,
    };
  }

  const target = path.join(cwd, CONFIG_FILENAME);

  if (template) {
    const srcPath = path.join(EXAMPLES_DIR, `${template}.jsonc`);
    if (!existsSync(srcPath)) {
      return { ok: false, text: `未找到预设模板文件：${srcPath}`, wroteFile: false };
    }
    const content = readFileSync(srcPath, "utf-8");
    if (dryRun) {
      return {
        ok: true,
        text: `（--dry-run）预设模板 "${template}" 预览（目标 ${target}，未写盘）：\n\n${content.trim()}`,
        wroteFile: false,
      };
    }
    if (existsSync(target) && !force) {
      return {
        ok: false,
        text: `已存在 ${target}，未覆盖（如需覆盖请执行 /charset-init ${template} --force；仅预览请加 --dry-run）。`,
        wroteFile: false,
      };
    }
    writeFileSync(target, content, "utf-8");
    return {
      ok: true,
      text: `已按预设模板 "${template}" 生成 ${target}，配置已在当前会话生效。`,
      wroteFile: true,
    };
  }

  if (!existsSync(SCANNER_SCRIPT)) {
    return { ok: false, text: `未找到扫描脚本：${SCANNER_SCRIPT}`, wroteFile: false };
  }
  const scriptArgs = [cwd, "--init"];
  if (dryRun) scriptArgs.push("--dry-run");
  if (force) scriptArgs.push("--force");

  const { code, stdout, stderr } = await runNodeScript(SCANNER_SCRIPT, scriptArgs, cwd);
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  const wroteFile = code === 0 && !dryRun && existsSync(target);
  return {
    ok: code === 0,
    text: wroteFile ? `${combined}\n配置缓存已刷新，当前会话已立即生效。` : combined || "扫描未返回输出。",
    wroteFile,
  };
}

export async function runCharsetScan(cwd: string, rawArgs = ""): Promise<{ ok: boolean; text: string }> {
  if (!existsSync(SCANNER_SCRIPT)) {
    return { ok: false, text: `未找到扫描脚本：${SCANNER_SCRIPT}` };
  }
  const tokens = tokenizeArgs(rawArgs);
  const scriptArgs: string[] = [cwd];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--help" || t === "-h") {
      return {
        ok: true,
        text: "用法: /charset-scan [--damaged] [--list-unknown] [--ext c,h,java] [--max-mb 50]",
      };
    }
    if (t === "--damaged" || t === "--list-unknown") {
      scriptArgs.push(t);
      continue;
    }
    if (t === "--ext" || t === "--max-mb") {
      const val = tokens[++i];
      if (!val || val.startsWith("-")) {
        return { ok: false, text: `参数 ${t} 需要提供值。` };
      }
      scriptArgs.push(t, val);
      continue;
    }
    return {
      ok: false,
      text: `不支持的参数 "${t}"。用法: /charset-scan [--damaged] [--list-unknown] [--ext c,h,java] [--max-mb 50]`,
    };
  }

  const { code, stdout, stderr } = await runNodeScript(SCANNER_SCRIPT, scriptArgs, cwd);
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return { ok: code === 0, text: combined || "扫描完成。" };
}
