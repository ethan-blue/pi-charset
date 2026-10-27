# Configuration Guide / 配置指南 (`.pi-charset.json`)

**[English](#english) | [简体中文](#简体中文)**

---

## English

### 1. Quick Initialization

```bash
# 1. Inspect encoding distribution across a directory (read-only)
node tools/scan-encoding.mjs D:/path/to/project
node tools/scan-encoding.mjs D:/path/to/project --out report.csv

# 2. Generate .pi-charset.json from project declarations and byte analysis
node tools/scan-encoding.mjs D:/path/to/project --init --dry-run
node tools/scan-encoding.mjs D:/path/to/project --init
```

`--init` resolves the root encoding and `overrides` in the following order:
1. **Project Declarations**: Reads Eclipse `.settings/org.eclipse.core.resources.prefs`, IDEA `.idea/encodings.xml`, Maven `pom.xml`, Gradle `build.gradle`, `.editorconfig`, and `.gitattributes`. Path-level declarations that conflict with more than 50% of non-ASCII files in their scope are skipped and documented in header comments.
2. **Unique Byte Candidates**: If no project declaration exists, counts files that round-trip under a single candidate encoding.
3. **Narrowest Covering Encoding**: When all CJK files are ambiguous across multiple candidates, selects the first encoding in `GBK -> Big5 -> Shift_JIS -> EUC-KR -> EUC-JP -> GB18030` that losslessly covers every observed file.
4. **Overwrite Protection**: Exits with code `1` if `.pi-charset.json` already exists; pass `--force` to overwrite.

### 2. Zero-Config Self-Adaptive Behavior (Default)

When no `.pi-charset.json` is present up the directory tree, `pi-charset` operates in **zero-config self-adaptive mode**:
- **Existing Files**: `read`, `write`, and `edit` classify each file by its bytes. Existing `GBK`, `GB18030`, `Big5`, `UTF-16`, and `UTF-8` files are decoded to UTF-8 on read and written back in their original encoding, line-ending style (`CRLF` or `LF`), and BOM, with all three write safety gates active.
- **New & Pure-ASCII Files**: `pi-charset` scans up to 16 sibling files in the same directory (prioritizing the same file extension group such as `.c`/`.h`) and inherits the dominant encoding and line ending (defaulting to `UTF-8` if no CJK siblings exist).
- **Multi-Encoding `grep`**: Regex patterns and non-ASCII literals run across `UTF-8` and `GB18030` passes and deduplicate matches by `file:line`. ASCII-only regexes also need these passes: for example, `\p{Han}` matches Chinese characters despite containing only ASCII syntax.
- `.pi-charset.json` is only needed when you want to override defaults (e.g., single-byte `ISO-8859-1` with `force: true`, explicit encoding migration, or enabling `transcodeBash`).

### 3. Configuration Reference

| Key | Default | Description |
|---|---|---|
| `sourceEncoding` | `"GB18030"` | Preferred candidate when multiple CJK encodings round-trip; also used as default encoding for pure-ASCII and newly created files. |
| `writeEncoding` | `= sourceEncoding` | Target write encoding. Existing non-ASCII files are transcoded only when `writeEncoding` differs from the scope's read encoding. |
| `unmappable` | `"error"` | Gate 1 policy: `"error"` (abort and list code points), `"escape"` (`\uXXXX`), or `"drop-to-gb18030"` (auto-promote GB-family writes to `GB18030`). |
| `verifyWrite` | `true` | Gate 2 toggle: pre-write in-memory round-trip check + post-write disk read-back verification. |
| `protectUtf8` | `true` | Keeps valid non-ASCII UTF-8 files in UTF-8 when written inside a GB-configured tree. |
| `readStrategy` | `"auto"` | `"auto"` uses byte classification; `"config"` forces decoding with `sourceEncoding` for display. |
| `autoCandidates` | `["GB18030","GBK","GB2312","Big5","Shift_JIS","EUC-KR","EUC-JP"]` | Ordered list of multi-byte CJK candidates for byte classification. Single-byte and stateful encodings are rejected. |
| `newFileLineEnding` | `undefined` | Line-ending style for newly created files (`"CRLF"` or `"LF"`). Does not alter existing files. |
| `transcodeBash` | `false` | Shell output transcoding: `false` (disabled), `true` / `"auto"`, or an explicit encoding name (e.g., `"GBK"`). Requires restarting Pi when changed. |
| `bashFileDump` | `true` | When `transcodeBash` is enabled, single-file dump commands (`type`, `cat`, `head`, `tail`, `Get-Content`) use the file's own read encoding. |
| `overrides` | `[]` | Path-based glob override rules. |

#### Choosing an unmappable-character policy

Keep `error` for source files unless the project explicitly requires another policy. `escape` changes file contents permanently: an unsupported character becomes literal `\uXXXX` text (a surrogate pair for supplementary characters). Reads do not reverse these escapes. Whether the result has the intended meaning depends on the language and the exact string, comment, or identifier context; it is not a general-purpose repair for C, Java, JSON, or configuration files.

`drop-to-gb18030` changes the output encoding for GB-family writes. Use it only if the compiler, editor, and downstream tools accept GB18030; it is not a way to keep a strict GBK requirement.

Keep `verifyWrite: true` for normal use. Verification adds an in-memory conversion and a full disk read after writing, so large or frequently rewritten files incur additional I/O. Disabling it trades away verification, not just logging.

#### 3.1 `overrides` Matching & Specificity

- Bare patterns without `/` (e.g., `*.properties`) match basenames at any depth (`matchBase: true`); patterns containing `/` (e.g., `src/**/*.c`) match relative to the directory containing `.pi-charset.json`.
- When multiple rules match a file, the rule with the highest segment specificity wins: literal segment `+10`, wildcard segment `+5`, `*` `+2`, `**` `+1`. Ties break by array order.
- If an override specifies `encoding` without `writeEncoding` and the root config has no migration intent (`writeEncoding == sourceEncoding`), new and pure-ASCII files in that override scope default to `override.encoding`.
- Single-byte encodings (`ISO-8859-1`, `windows-1252`) round-trip arbitrary bytes and require `"force": true` in the override rule.

#### 3.2 Write Target Resolution Matrix

| On-Disk File State | No Transcode Intent (`writeEncoding == readEncoding`) | Explicit Transcode Intent (`writeEncoding != readEncoding`) |
|---|---|---|
| New file | Scope read encoding (`override.encoding` > root) | `writeEncoding` |
| Pure ASCII file | Scope read encoding | `writeEncoding` |
| UTF-8 / UTF-8 BOM | Keep UTF-8 (and existing BOM) | Keep UTF-8 when `protectUtf8: true`; convert to `writeEncoding` only when `force: true` or `protectUtf8: false` |
| Multi-byte CJK (`GBK`, `GB18030`, `Big5`, etc.) | Keep the file's classified encoding | Write as `writeEncoding` (rejected by Gate 3 if existing bytes cannot round-trip in `writeEncoding`) |
| UTF-16LE / UTF-16BE | Keep original UTF-16 with BOM | Convert to `writeEncoding` only when `force: true` |
| `force: true` or single-byte rule | Write as rule `encoding` | Write as `writeEncoding` |

### 4. Configuration Recipes

#### 4.1 Embedded C Project (GBK + CRLF Sources, UTF-8 Docs)

```jsonc
{
  "sourceEncoding": "UTF-8",
  "writeEncoding": "UTF-8",
  "unmappable": "error",
  "verifyWrite": true,
  "protectUtf8": true,
  "overrides": [
    {
      "pattern": "src/**/*.c",
      "encoding": "GBK",
      "writeEncoding": "GBK",
      "newFileLineEnding": "CRLF"
    },
    {
      "pattern": "src/**/*.h",
      "encoding": "GBK",
      "writeEncoding": "GBK",
      "newFileLineEnding": "CRLF"
    }
  ]
}
```

#### 4.2 Legacy Java Web Project (GBK Primary + UTF-8 Subtrees + ISO-8859-1 Properties)

```jsonc
{
  "sourceEncoding": "GBK",
  "writeEncoding": "GBK",
  "unmappable": "error",
  "verifyWrite": true,
  "protectUtf8": true,
  "autoCandidates": ["GB18030", "GBK", "GB2312", "Big5"],
  "overrides": [
    { "pattern": "WebContent/Mobile/**", "encoding": "UTF-8" },
    { "pattern": "conf/tplt/**", "encoding": "UTF-8" },
    {
      "pattern": "*.properties",
      "encoding": "ISO-8859-1",
      "force": true,
      "writeEncoding": "ISO-8859-1",
      "unmappable": "escape"
    }
  ]
}
```

### 5. Gate Error Reference

- **Gate 1 (Unmappable Characters)**: The file on disk is untouched. Either change `writeEncoding` to `"GB18030"` / `"UTF-8"`, set `unmappable` to `"escape"` or `"drop-to-gb18030"`, or replace the unmappable character.
- **Gate 2 (Post-Write Verification Mismatch)**: The on-disk file is preserved as-is without rolling back to avoid clobbering concurrent external edits. Read the file again to inspect the current disk state before retrying.
- **Gate 3 (Unknown or Lossy Conversion Blocked)**: Check the file's actual encoding and keep a version-controlled copy before changing rules. Choose a compatible target encoding if appropriate. `force: true` overrides detection; it does not repair damaged bytes or waive round-trip checks. Do not use it merely to silence an error.

---

## 简体中文

### 1. 快速生成配置

```bash
# 1. 扫描目录编码分布（只读，不修改任何文件）
node tools/scan-encoding.mjs D:/path/to/project
node tools/scan-encoding.mjs D:/path/to/project --out report.csv

# 2. 根据工程声明与字节分布生成 .pi-charset.json
node tools/scan-encoding.mjs D:/path/to/project --init --dry-run
node tools/scan-encoding.mjs D:/path/to/project --init
```

`--init` 按以下优先级确定根编码与 `overrides`：
1. **工程声明优先**：读取 Eclipse `.settings/org.eclipse.core.resources.prefs`、IDEA `.idea/encodings.xml`、Maven `pom.xml`、Gradle `build.gradle`、`.editorconfig` 与 `.gitattributes`。若某路径声明与该路径下超过 50% 的非 ASCII 文件实际字节冲突，跳过该声明并在配置文件头部注释中列出。
2. **字节唯一候选**：无工程声明时，统计仅能通过单一候选编码无损回环的文件数。
3. **最窄覆盖编码**：当非 UTF-8 文件均在多候选间歧义时，按 `GBK -> Big5 -> Shift_JIS -> EUC-KR -> EUC-JP -> GB18030` 顺序选取能覆盖全部已观测文件的最窄编码。
4. **防覆盖保护**：若目标目录已存在 `.pi-charset.json`，默认以退出码 `1` 退出；传入 `--force` 才执行覆盖。

### 2. 零配置自适应模式（默认行为）

当工作目录向上查找不到 `.pi-charset.json` 时，扩展默认运行在**零配置自适应模式**：
- **已存在文件**：`read`、`write`、`edit` 直接根据文件自身字节判定编码。`GBK`、`GB18030`、`Big5`、`UTF-16` 与 `UTF-8` 文件在读取时自动解码为 UTF-8，在写入时自动保持原文件编码、原行尾（`CRLF` 或 `LF`）与 BOM，并默认启用全部三道写入门禁。
- **新建文件与纯 ASCII 文件**：自动扫描同目录下最多 16 个相邻文件（优先匹配同语言后缀族，如 `.c`/`.h`），继承同目录的主流编码与行尾格式（同目录无传统编码文件时默认 `UTF-8`）。
- **多编码搜索（`grep`）**：正则搜索或非 ASCII 字面量搜索执行 `UTF-8 + GB18030` 双趟搜索并按 `file:line` 去重。纯 ASCII 正则也需要分趟，例如 `\p{Han}` 虽然模式只含 ASCII，匹配的却是中文。
- 仅在需要指定单字节编码（`ISO-8859-1` + `force: true`）、跨编码迁移或开启 `transcodeBash` 时，才需要创建 `.pi-charset.json`。

### 3. 配置字段参考

| 字段 | 默认值 | 说明 |
|---|---|---|
| `sourceEncoding` | `"GB18030"` | 读侧多候选歧义时的优先编码，同时作为纯 ASCII 文件与新建文件的默认编码 |
| `writeEncoding` | 同 `sourceEncoding` | 写目标编码。仅当 `writeEncoding` 与当前作用域读编码不同时，才对已存在文件执行转码 |
| `unmappable` | `"error"` | 闸门 1 策略：`error`（拒写并列出字符与码点）、`escape`（转为 `\uXXXX`）、`drop-to-gb18030`（GB 族自动升为 GB18030） |
| `verifyWrite` | `true` | 闸门 2 开关：写前内存编解码往返校验 + 写后磁盘回读核对 |
| `protectUtf8` | `true` | 含非 ASCII 字节的合法 UTF-8 文件保持 UTF-8 写回，不转为 GB 系编码 |
| `readStrategy` | `"auto"` | `auto` 按字节判定解码；`config` 跳过字节判定，直接按 `sourceEncoding` 解码显示 |
| `autoCandidates` | `["GB18030","GBK","GB2312","Big5","Shift_JIS","EUC-KR","EUC-JP"]` | 多字节自动判定候选链，按数组顺序定优先级。不接受单字节编码与状态转义编码 |
| `newFileLineEnding` | 未设置 | 新建文件的行尾格式，可选 `"CRLF"` 或 `"LF"`；不作用于已存在文件 |
| `transcodeBash` | `false` | Shell 输出流转码：`false` 关闭；`true` 或 `"auto"` 自动判定并转 UTF-8；或指定具体编码名（如 `"GBK"`）。修改后需重启 Pi |
| `bashFileDump` | `true` | 在 `transcodeBash` 开启时生效：`type`、`cat`、`head`、`tail`、`Get-Content` 读取单文件时直接采用该文件的读编码 |
| `overrides` | `[]` | 按路径 glob 覆盖局部规则 |

#### 不可映射字符策略怎么选

源码文件建议保留 `error`。`escape` 会永久改变文件内容：不能表示的字符会变成字面的 `\uXXXX` 文本，补充平面字符使用代理对；后续读取不会自动反转义。语言是否识别这些转义，还取决于它位于字符串、注释还是标识符中，不能把它当作 C、Java、JSON 或配置文件的通用修复方案。

`drop-to-gb18030` 会改变 GB 系文件的输出编码。只有编译器、编辑器及后续工具均接受 GB18030 时才适用；工程必须使用 GBK 时不要选它。

日常使用建议保留 `verifyWrite: true`。校验会增加内存编解码和写后整文件回读，大文件或高频写入会有额外 I/O 成本。关闭它意味着放弃校验，而不只是关闭日志。

#### 3.1 `overrides` 匹配与特异度规则

- 不含 `/` 的模式（如 `*.properties`）按文件名匹配任意目录层级（`matchBase: true`）；含 `/` 的模式（如 `src/**/*.c`）相对配置文件所在目录匹配。
- 多条规则同时命中同一文件时，按路径段特异度计分取最高者：字面路径段 `+10`，含通配符段 `+5`，单星号 `*` `+2`，双星号 `**` `+1`；同分按数组先后顺序取第一条。
- `override` 规则只写 `encoding` 且根配置无迁移意图（根 `writeEncoding == sourceEncoding`）时，该作用域下的新建文件与纯 ASCII 文件默认按 `override.encoding` 写入。
- 单字节编码（如 `ISO-8859-1`、`windows-1252`）对任意字节流都能回环，必须在 `override` 中显式设置 `"force": true` 才会生效。

#### 3.2 写入目标编码决策表

| 磁盘文件状态 | 无转码意图（`writeEncoding == 读编码`） | 有转码意图（`writeEncoding != 读编码`） |
|---|---|---|
| 新建文件 | 作用域读编码（`override.encoding` 优先于根配置） | `writeEncoding` |
| 纯 ASCII 文件 | 作用域读编码 | `writeEncoding` |
| UTF-8 / UTF-8 BOM | 保持 UTF-8（保留原 BOM） | `protectUtf8: true` 时仍保持 UTF-8；显式 `force: true` 或 `protectUtf8: false` 时转为 `writeEncoding` |
| GBK / GB18030 / Big5 等多字节 | 保持文件自身判定出的编码写回 | 按 `writeEncoding` 写；若原文件字节无法在目标编码下无损回环则由闸门 3 拒写 |
| UTF-16LE / UTF-16BE | 保持原 UTF-16 编码并保留 BOM | 仅在 `force: true` 时转为 `writeEncoding` |
| `force: true` 或单字节编码 | 按声明的 `encoding` 写 | 按 `writeEncoding` 写 |

### 4. 常见工程配置示例

参见上方英文小节中的 **4.1 嵌入式 C 工程** 与 **4.2 传统 Java Web 工程**，或直接复制 [`examples/`](../examples) 目录下的模板文件。

### 5. 门禁报错处理

- **闸门 1（目标编码无法表示字符）**：此时磁盘文件未被修改。可将 `writeEncoding` 改为 `"GB18030"` 或 `"UTF-8"`，或将该规则 `unmappable` 设为 `"escape"` / `"drop-to-gb18030"`，或替换生僻字符后重试。
- **闸门 2（写后回读校验不一致）**：磁盘保留最新现场，不执行旧备份回滚（避免覆盖外部编辑器或格式化工具写入的新内容）。先执行 `read` 查看当前文件内容，确认后再重试。
- **闸门 3（未知编码或有损转码拦截）**：先核对文件真实编码，并保留版本管理中的原文件，再考虑调整为兼容的目标编码。`force: true` 用于覆盖编码判定，不会修复损坏字节，也不会跳过往返校验；不要为了消除报错直接开启它。
