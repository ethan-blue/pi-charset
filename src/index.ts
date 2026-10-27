import * as path from "node:path";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  createLocalBashOperations,
  createLocalPowerShellOperations,
} from "@earendil-works/pi-coding-agent";
import {
  makeReadOperations,
  makeWriteOperations,
  makeEditOperations,
  clearReadBaselines,
} from "./operations";
import { createEncodingGrepDefinition } from "./grep";
import { wrapEditToolWithEncodingPreview, clearUtf8Cache } from "./edit-preview";
import { clearConfigCache, findNearestConfigSync, shellRuleFor, CONFIG_FILENAME } from "./config";
import { readPiShellSettings } from "./pi-settings";
import { makeTranscodingShellOperations } from "./shell";
import { systemNoteFor } from "./sysnote";
import { clearEncodingNotes, drainEncodingNotes, drainShellNotes, pushEncodingNote, notesToSuffix } from "./notify";
import { PLUGIN_VERSION } from "./version";

type AnyText = { type: "text"; text: string };

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  pi.registerTool(createReadToolDefinition(cwd, { operations: makeReadOperations() }));
  pi.registerTool(createWriteToolDefinition(cwd, { operations: makeWriteOperations() }));

  // Wrap edit's renderCall so non-UTF-8 files get an encoding-aware preview diff.
  const editDef = createEditToolDefinition(cwd, { operations: makeEditOperations() });
  pi.registerTool(wrapEditToolWithEncodingPreview(editDef, makeEditOperations(), cwd));

  pi.registerTool(createEncodingGrepDefinition(cwd));

  const statusHandler = async (_args: string, ctx: any) => {
    const found = findNearestConfigSync(cwd);
    const cfgFile = found ? (found.configPath ?? path.join(found.configDir, CONFIG_FILENAME)) : null;
    const lines = [
      `pi-charset v${PLUGIN_VERSION}（Pi ${VERSION}）`,
      `cwd: ${cwd}`,
      cfgFile
        ? `配置: ${cfgFile}`
        : `配置: 零配置自适应模式（未放置 ${CONFIG_FILENAME}，按文件字节与同目录上下文自动读写）`,
      "接管: read / write / edit（含非 UTF-8 编辑预览）/ grep（多编码搜索）",
    ];
    if (found?.warnings?.length) lines.push(`配置警告: ${found.warnings.join("；")}`);
    lines.push("说明: 若其它扩展注册了同名文件工具，以 Pi 的扩展加载顺序为准（后注册者生效）。");
    const text = lines.join("\n");
    ctx.ui?.notify?.(text, "info");
  };

  pi.registerCommand("charset-status", {
    description: "编码扩展状态：插件与 Pi 版本、cwd、生效模式与接管范围",
    handler: statusHandler,
  });

  // Register custom bash/powershell tools only when transcodeBash is explicitly enabled in the nearest config.
  const shellRule = shellRuleFor(cwd);
  if (shellRule) {
    const shell = readPiShellSettings(cwd);
    pi.registerTool(
      createBashToolDefinition(cwd, {
        operations: makeTranscodingShellOperations(createLocalBashOperations(), shellRule) as never,
        ...(shell.shellPath ? { shellPath: shell.shellPath } : {}),
        ...(shell.shellCommandPrefix ? { commandPrefix: shell.shellCommandPrefix } : {}),
      }),
    );
    pi.registerTool(
      createPowerShellToolDefinition(cwd, {
        operations: makeTranscodingShellOperations(createLocalPowerShellOperations(), shellRule) as never,
      }),
    );
    for (const w of shellRule.warnings) pushEncodingNote(cwd, w);
  }

  pi.on("session_start", async () => {
    clearConfigCache();
    clearUtf8Cache();
    clearEncodingNotes();
    clearReadBaselines();
  });
  pi.on("resources_discover", async (event) => {
    if (event.reason === "reload") {
      clearConfigCache();
      clearUtf8Cache();
      clearEncodingNotes();
      clearReadBaselines();
    }
  });

  let notePromise: Promise<string | null> | null = null;
  const noteOnce = () => {
    if (!notePromise) notePromise = systemNoteFor(cwd);
    return notePromise;
  };
  pi.on("before_agent_start", async (event) => {
    const note = await noteOnce();
    if (!note) return undefined;
    return { systemPrompt: event.systemPrompt + "\n\n" + note };
  });

  pi.on("tool_result", async (event, ctx) => {
    const name = event.toolName;
    if (name === "bash" || name === "powershell") {
      const sn = drainShellNotes();
      if (sn.length === 0) return undefined;
      for (const n of sn) ctx.ui?.notify?.(n, "info");
      if (event.isError) return undefined;
      const suffix = notesToSuffix(sn);
      const content = (event.content ?? []) as (AnyText | { type: "image"; data: string; mimeType: string })[];
      return { content: [...content, { type: "text", text: suffix }] };
    }
    if (name !== "read" && name !== "edit" && name !== "write") return undefined;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const rel = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
    if (!rel) return undefined;
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
    const notes = drainEncodingNotes(abs);
    if (notes.length === 0) return undefined;
    for (const n of notes) ctx.ui?.notify?.(n, "info");
    if (event.isError) return undefined;
    const suffix = notesToSuffix(notes);
    if (!suffix) return undefined;
    const content = (event.content ?? []) as (AnyText | { type: "image"; data: string; mimeType: string })[];
    return { content: [...content, { type: "text", text: suffix }] };
  });
}
