// Read and write encoding plan resolution (supports both explicit .pi-charset.json and zero-config adaptive inference).
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { findNearestConfig, inferAdaptiveRule, resolveFileRule, CONFIG_FILENAME, type ResolvedConfig } from "./config";
import { classifyBuffer, describeVerdict, exactRoundTrip, type Kind, type Verdict } from "./encoding/classify";
import { isGBEncoding, normalizeEncoding } from "./encoding/converter";

async function readRawOrNull(p: string): Promise<Buffer | null> {
  try {
    return await readFile(p);
  } catch {
    return null;
  }
}

/** Return the explicit configuration rule if a config file exists up the tree, or null otherwise. */
export async function ruleFor(absFilePath: string): Promise<ResolvedConfig | null> {
  const found = await findNearestConfig(path.dirname(absFilePath));
  if (!found) return null;
  return resolveFileRule(absFilePath, found);
}

/** Return the explicit configuration rule if present, or synthesize an adaptive rule from the file and its directory siblings. */
export async function effectiveRuleFor(absFilePath: string, rawBytes?: Buffer | null): Promise<ResolvedConfig> {
  const explicit = await ruleFor(absFilePath);
  if (explicit) return explicit;
  return inferAdaptiveRule(absFilePath, rawBytes);
}

export interface ReadPlan {
  transcoded: boolean;
  encoding: string;
  kind: Kind;
  verdict: Verdict;
  rule: ResolvedConfig;
  note: string | null;
  warnings: string[];
}

export async function resolveReadPlan(absFilePath: string, preloadedRaw?: Buffer | null): Promise<ReadPlan> {
  const raw = preloadedRaw !== undefined ? preloadedRaw : await readRawOrNull(absFilePath);
  const rule = await effectiveRuleFor(absFilePath, raw);
  if (raw === null) {
    return {
      transcoded: false,
      encoding: rule.sourceEncoding,
      kind: "utf8",
      verdict: classifyBuffer(Buffer.alloc(0), rule),
      rule,
      note: null,
      warnings: [...rule.warnings],
    };
  }
  const verdict = classifyBuffer(raw, {
    sourceEncoding: rule.sourceEncoding,
    autoCandidates: rule.autoCandidates,
    force: rule.force,
  });
  const warnings = [...rule.warnings];

  let readEncoding = verdict.encoding;
  let transcodedKind: Kind = verdict.kind;
  if (rule.readStrategy === "config" && verdict.kind !== "binary") {
    if (normalizeEncoding(rule.sourceEncoding) !== verdict.encoding) {
      readEncoding = normalizeEncoding(rule.sourceEncoding);
      transcodedKind = "config";
      warnings.push(
        `readStrategy="config"：字节判定为 ${describeVerdict(verdict)}，按配置以 ${readEncoding} 解码（仅作用于读取显示；写入仍按字节判定处理）`,
      );
    }
  }

  let note: string | null = null;
  // Append inline note only for files whose writes will be rejected by Gate 3; non-fatal warnings go through tool_result.
  if (verdict.kind === "unknown") {
    note = `[encoding: UNKNOWN — 未转码，写入将被拒绝] 判定失败的路径=${absFilePath}`;
  } else if (verdict.kind === "config" && verdict.configReason === "force" && verdict.hasFffd) {
    note =
      `[encoding: ${verdict.encoding} 按 force 解码出现 U+FFFD —— 配置与文件真实编码不符，写入将被拒绝] 路径=${absFilePath}`;
  }

  return {
    transcoded: readEncoding !== "UTF-8" && verdict.kind !== "binary" && verdict.kind !== "unknown",
    encoding: readEncoding,
    kind: transcodedKind,
    verdict,
    rule,
    note,
    warnings,
  };
}

export interface WritePlan {
  encoding: string | null;
  rule: ResolvedConfig | null;
  kind: Kind | "new";
  verdict: Verdict | null;
  addBom: "" | "utf8" | "utf16le" | "utf16be";
  reject: string | null;
  warnings: string[];
  transcoding: boolean;
}

function bomFlagFor(encoding: string, verdict: Verdict | null, content: string): WritePlan["addBom"] {
  const enc = encoding.toUpperCase();
  const hadBom = verdict?.bom === true;
  if (enc === "UTF-16LE") return "utf16le";
  if (enc === "UTF-16BE") return "utf16be";
  if (enc === "UTF-8") return hadBom || content.charCodeAt(0) === 0xfeff ? "utf8" : "";
  return "";
}

function bomBytes(flag: WritePlan["addBom"]): Buffer {
  if (flag === "utf8") return Buffer.from([0xef, 0xbb, 0xbf]);
  if (flag === "utf16le") return Buffer.from([0xff, 0xfe]);
  if (flag === "utf16be") return Buffer.from([0xfe, 0xff]);
  return Buffer.alloc(0);
}

export function planBomBytes(flag: WritePlan["addBom"]): Buffer {
  return bomBytes(flag);
}

export async function resolveWritePlan(
  absFilePath: string,
  content: string,
  preloadedRaw?: Buffer | null,
): Promise<WritePlan> {
  const raw = preloadedRaw !== undefined ? preloadedRaw : await readRawOrNull(absFilePath);
  const rule = await effectiveRuleFor(absFilePath, raw);
  const warnings = [...rule.warnings];
  const verdict = raw === null ? null : classifyBuffer(raw, {
    sourceEncoding: rule.sourceEncoding,
    autoCandidates: rule.autoCandidates,
    force: rule.force,
  });
  const targetFromConfig = normalizeEncoding(rule.writeEncoding || rule.sourceEncoding);

  // New files and pure-ASCII files use the configured or sibling-inferred write target for their scope.
  if (!verdict || verdict.kind === "ascii") {
    const addBom = bomFlagFor(targetFromConfig, verdict, content);
    return {
      encoding: targetFromConfig,
      rule,
      kind: verdict ? "ascii" : "new",
      verdict,
      addBom: applyBomRuleForContent(addBom, content, targetFromConfig, warnings),
      reject: rejectIfBomIntoGB(content, targetFromConfig, rule, absFilePath, warnings),
      warnings,
      transcoding: false,
    };
  }

  if (verdict.kind === "binary") {
    return {
      encoding: null,
      rule,
      kind: "binary",
      verdict,
      addBom: "",
      reject:
        `拒绝写入 ${absFilePath}：文件前 8192 字节内含 NUL，判定为二进制（binary）。` +
        `若确为文本文件（如含 NUL 的多字节编码如 UTF-16/32），请核对编码并为文本添加对应 BOM（如 UTF-16LE/BE BOM），或通过编辑器将其另存为受支持的带 BOM 文本后再操作。`,
      warnings,
      transcoding: false,
    };
  }

  // Reject writes when force-decoding produced U+FFFD and the replacement character would be written back to a GB encoding.
  if (verdict.kind === "config" && rule.force && verdict.hasFffd && content.includes("\ufffd")) {
    return {
      encoding: null,
      rule,
      kind: "config",
      verdict,
      addBom: "",
      reject:
        `拒写 ${absFilePath}：待写入内容含 U+FFFD（替换字符），目标编码 ${targetFromConfig} 无法无损表示。` +
        `请核对配置中的 encoding 是否与文件实际编码一致，或移除 force 由字节判定处理。`,
      warnings,
      transcoding: false,
    };
  }
  if (verdict.kind === "unknown") {
    if (rule.force) {
      warnings.push(`force=true 跳过 unknown 判定，按 ${targetFromConfig} 写出`);
      return {
        encoding: targetFromConfig,
        rule,
        kind: "unknown",
        verdict,
        addBom: bomFlagFor(targetFromConfig, verdict, content),
        reject: null,
        warnings,
        transcoding: true,
      };
    }
    return {
      encoding: null,
      rule,
      kind: "unknown",
      verdict,
      addBom: "",
      reject:
        `拒绝写入 ${absFilePath}：字节判定为 UNKNOWN（非合法 UTF-8，且无法通过候选编码 ` +
        `${(rule.autoCandidates || []).join("/")} 无损回环）。请确认文件编码后在 ` +
        `"${CONFIG_FILENAME}" 中添加 {"pattern":"<glob>","encoding":"<编码>","force":true}。`,
      warnings,
      transcoding: false,
    };
  }

  // Keep existing UTF-8 files as UTF-8 unless force: true or protectUtf8: false is set.
  if (verdict.kind === "utf8" || verdict.kind === "utf8-bom") {
    const wantsGb = isGBEncoding(targetFromConfig);
    if (verdict.kind === "utf8" && !wantsGb) {
      return { encoding: "UTF-8", rule, kind: "utf8", verdict, addBom: bomFlagFor("UTF-8", verdict, content), reject: null, warnings, transcoding: false };
    }
    if (verdict.kind === "utf8-bom" && !wantsGb) {
      return { encoding: "UTF-8", rule, kind: "utf8-bom", verdict, addBom: "utf8", reject: null, warnings, transcoding: false };
    }
    const mayConvert = rule.force || rule.protectUtf8 === false;
    if (!mayConvert) {
      warnings.push(
        `UTF-8${verdict.kind === "utf8-bom" ? "(BOM)" : ""} 文件保持 UTF-8 写回（未转为 ${targetFromConfig}）。如需强制转换，请为该 pattern 设置 "force": true。`,
      );
      return {
        encoding: "UTF-8",
        rule,
        kind: verdict.kind,
        verdict,
        addBom: verdict.kind === "utf8-bom" ? "utf8" : "",
        reject: null,
        warnings,
        transcoding: false,
      };
    }
    warnings.push(
      `按 force/protectUtf8=false 将 UTF-8 文件转换为 ${targetFromConfig}（破坏性语义变更）`,
    );
    return {
      encoding: targetFromConfig,
      rule,
      kind: verdict.kind,
      verdict,
      addBom: "",
      reject: rejectIfBomIntoGB(content, targetFromConfig, rule, absFilePath, warnings),
      warnings,
      transcoding: true,
    };
  }

  if (verdict.kind === "utf16le" || verdict.kind === "utf16be") {
    const keep = verdict.encoding;
    const forceConvert = rule.force && targetFromConfig !== keep;
    const encoding = forceConvert ? targetFromConfig : keep;
    if (forceConvert) warnings.push(`force=true：UTF-16 文件按 ${encoding} 重写`);
    return {
      encoding,
      rule,
      kind: verdict.kind,
      verdict,
      addBom: forceConvert ? "" : (encoding === "UTF-16LE" ? "utf16le" : "utf16be"),
      reject: null,
      warnings,
      transcoding: forceConvert,
    };
  }

  // Multi-byte CJK files keep their detected encoding unless writeIntent is explicitly configured.
  const detected = verdict.kind === "cjk" && !rule.writeIntent ? verdict.encoding : null;
  if (detected && normalizeEncoding(detected) !== normalizeEncoding(targetFromConfig)) {
    warnings.push(
      `当前作用域声明 ${targetFromConfig}${rule.matchedPattern ? `（override "${rule.matchedPattern}"）` : ""}，` +
        `文件按字节判定为 ${detected}，保持 ${detected} 写回（不转码）。`,
    );
  }
  const encoding = detected ?? targetFromConfig;
  const byteVerdict: Verdict | null = verdict.kind === "config" && raw ? classifyBuffer(raw, null) : null;
  if (byteVerdict && rule.force) {
    if ((byteVerdict.kind === "utf8" || byteVerdict.kind === "utf8-bom") && encoding.toUpperCase() !== "UTF-8") {
      warnings.push(
        `force=true：磁盘原文件为 ${byteVerdict.kind === "utf8-bom" ? "UTF-8 with BOM" : "UTF-8"}，按 ${encoding} 重写（破坏性语义变更）`,
      );
    }
  }
  if (verdict.kind === "cjk" && !rule.force && !exactRoundTrip(raw!, encoding)) {
    return {
      encoding: null,
      rule,
      kind: verdict.kind,
      verdict,
      addBom: "",
      reject:
        `拒写 ${absFilePath}：磁盘字节判定为 ${verdict.encoding}，目标写编码 ${encoding}` +
        `${rule.matchedPattern ? `（来自 override "${rule.matchedPattern}"）` : `（来自 ${rule.configDir} 配置）`}无法无损表示原文件字节（逐字节回环不相等）。` +
        `建议：${isGBEncoding(encoding) && encoding.toUpperCase() !== "GB18030" ? "将 writeEncoding 改为 GB18030（GBK 超集，原 GBK 字节不变）" : `将该 override 的 encoding 改为 ${verdict.encoding}`}；` +
        `若需强制转换，请在该 pattern 上设置 "force": true。`,
      warnings,
      transcoding: false,
    };
  }
  let baselineEncoding: string;
  if (verdict.kind !== "config") baselineEncoding = verdict.encoding;
  else if (byteVerdict && (byteVerdict.kind === "utf8" || byteVerdict.kind === "utf8-bom")) baselineEncoding = "UTF-8";
  else if (byteVerdict && byteVerdict.kind === "cjk") baselineEncoding = byteVerdict.encoding;
  else baselineEncoding = encoding;
  const transcoding = normalizeEncoding(baselineEncoding) !== normalizeEncoding(encoding);
  if (transcoding) {
    warnings.push(
      `磁盘原编码 ${baselineEncoding} -> 按配置写出 ${encoding}（${rule.matchedPattern ? `override "${rule.matchedPattern}"` : rule.configDir}）`,
    );
  }
  return {
    encoding,
    rule,
    kind: verdict.kind,
    verdict,
    addBom: bomFlagFor(encoding, verdict, content),
    reject: rejectIfBomIntoGB(content, encoding, rule, absFilePath, warnings),
    warnings,
    transcoding,
  };
}

/** Reject writing leading U+FEFF BOM into GB-family encodings (which iconv encodes as 0x3F '?'). */
function rejectIfBomIntoGB(
  content: string,
  encoding: string,
  rule: ResolvedConfig,
  absPath: string,
  warnings: string[],
): string | null {
  const hasBomChar = content.charCodeAt(0) === 0xfeff;
  if (!hasBomChar) return null;
  if (rule.force) {
    warnings.push("force=true 且内容含前导 U+FEFF：已剥离 BOM 后按目标编码写出");
    return null;
  }
  if (!isGBEncoding(encoding)) return null;
  return (
    `拒绝写入 ${absPath}：内容含 UTF-8 with BOM (U+FEFF)，目标编码 ${encoding} 无法表示 BOM（写出将产生 0x3F '?'）。` +
    `请将该 pattern 的 writeEncoding 设为 UTF-8，或移除文件 BOM，或在对应 override 中设置 "force": true。`
  );
}

function applyBomRuleForContent(
  flag: WritePlan["addBom"],
  content: string,
  encoding: string,
  warnings: string[],
): WritePlan["addBom"] {
  if (content.charCodeAt(0) !== 0xfeff) return flag;
  if (isGBEncoding(encoding)) return flag;
  if (encoding.toUpperCase() === "UTF-8" && flag === "") {
    warnings.push("内容带前导 U+FEFF，按 UTF-8 写出 BOM");
    return "utf8";
  }
  return flag;
}

export async function resolveReadEncoding(absFilePath: string): Promise<string | null> {
  const plan = await resolveReadPlan(absFilePath);
  if (plan.verdict.kind === "binary" || plan.verdict.kind === "unknown") return plan.verdict.encoding === "BINARY" ? "BINARY" : "UNKNOWN";
  return plan.encoding;
}

export async function resolveWriteEncoding(absFilePath: string): Promise<string | null> {
  const plan = await resolveWritePlan(absFilePath, "");
  return plan.encoding;
}

export type { ResolvedConfig };
