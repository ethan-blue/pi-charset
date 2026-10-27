# pi-charset

[![Version](https://img.shields.io/badge/version-0.1.1-blue.svg)](./package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

Encoding-aware `read`, `write`, `edit`, and `grep` extension for [Pi](https://github.com/earendil-works) (`@earendil-works/pi-coding-agent`).
适用于 [Pi](https://github.com/earendil-works)（`@earendil-works/pi-coding-agent`）的文件编码与行尾处理扩展，在工具 I/O 层接管 `read`、`write`、`edit` 与 `grep`。

**[English](#english) | [简体中文](#简体中文)**

---

## English

### Overview

`pi-charset` intercepts file I/O and search operations in Pi to handle repositories that mix `GBK`, `GB18030`, `Big5`, `Shift_JIS`, `EUC-KR`, `ISO-8859-1`, `UTF-16`, and `UTF-8` files within the same workspace. All classification and transcoding run in-process without external Python or `chardet` subprocesses.

### Working with a GBK project

For an existing GBK project, start with the scanner's `--init --dry-run` command below and review the suggested rules before generating a configuration. Keep `unmappable: "error"` and `verifyWrite: true`: characters that GBK cannot represent should stop a write rather than turn into `?`.

Use Pi's `read`, `edit`, and `write` tools for source changes. Shell redirection and external formatters bypass this extension. After installation, run `/charset-status`, edit a small tracked file, and inspect the diff in your usual editor before wider use.

Byte detection is not proof of an encoding: GBK and GB18030 overlap, and some bytes also decode under other encodings. For a project that requires GBK, declare GBK explicitly instead of relying on inference, especially for new or ASCII-only files. This extension prevents new encoding damage; it cannot reconstruct text that was already saved as question marks or mojibake.

### Architecture

#### 1. Deterministic Byte Classification
Files are classified in memory in a fixed order:
1. **BOM Detection**: `UTF-8 BOM`, `UTF-16LE`, `UTF-16BE` (`UTF-32 BOM` is classified as `BINARY`).
2. **Binary Guard**: Any `0x00` byte within the first 8192 bytes classifies the file as `BINARY`.
3. **Explicit `force`**: Rules with `force: true` apply the configured encoding directly.
4. **Pure ASCII**: Files containing only bytes `<= 0x7F` are classified as `ASCII`.
5. **Strict UTF-8**: Full-buffer validation via `TextDecoder("utf-8", { fatal: true })`.
6. **Multi-Byte CJK Round-Trip**: Candidates in `autoCandidates` are tested for `encode(decode(bytes)) == bytes` with zero `U+FFFD` replacement characters; `sourceEncoding` takes priority when multiple candidates pass.
7. **Fallback**: Unclassified byte sequences are marked `UNKNOWN`.

#### 2. Write Safety Gates
- **Gate 1 (Unmappable Code Points)**: Checks every code point against the target encoding before writing. Default policy `error` aborts the write and lists unmappable characters with `U+XXXX` code points. Optional policies: `escape` (`\uXXXX`) and `drop-to-gb18030` (promotes GB-family writes to `GB18030`).
- **Gate 2 (Pre-Write Round-Trip & Post-Write Read-Back)**: Verifies `decode(encode(text)) === text` in memory before touching disk, then reads back the written file to verify byte and text equality. If post-write verification fails, `pi-charset` reports the mismatch and preserves the on-disk file without rolling back to a stale backup.
- **Gate 3 (Unknown & Lossy Conversion Guard)**: Rejects writes to `BINARY` or `UNKNOWN` files, preserves existing `UTF-8` files by default (`protectUtf8: true`), and rejects writes when existing on-disk bytes cannot losslessly round-trip in the target encoding.

#### 3. Line Endings & Baseline Conflict Detection
- **Line-Ending Preservation**: Existing files keep their on-disk line endings (`CRLF` or `LF`); files without newlines do not get trailing newlines appended.
- **Mixed Line-Ending Guard**: Files containing both `CRLF` and `LF` can be read via `read`, but `edit` and `write` are rejected.
- **New-File Line Endings**: Configurable via `newFileLineEnding: "CRLF" | "LF"` for newly created files.
- **Read Baseline Verification**: Records a SHA-1 fingerprint when a managed file is read; rejects writes if the on-disk file was modified externally after the read.

#### 4. Zero-Config Self-Adaptive Mode & Sibling Inference
`pi-charset` works out-of-the-box without requiring a `.pi-charset.json` file:
- **Existing Files**: Automatically read in their byte-classified encoding (`GBK`, `GB18030`, `Big5`, `UTF-16`, `UTF-8`) and written back preserving their original encoding, line endings (`CRLF` or `LF`), and BOM.
- **New & Pure-ASCII Files**: When no `.pi-charset.json` is present, `pi-charset` inspects sibling files in the same directory (matching extension group first, e.g. `.c`/`.h`) and inherits the dominant encoding and line-ending style (defaulting to `UTF-8` when siblings are UTF-8 or ASCII).
- **Multi-Encoding Search (`grep`)**: Regex patterns and non-ASCII literals run `UTF-8 + GB18030` `ripgrep` passes in zero-config mode, or the configured candidate encodings when `.pi-charset.json` is present. Matches are verified against each file's classified encoding and deduplicated by `file:line`.

### Quick Start

#### 1. Installation

```bash
# Install from Git (-l writes to project .pi/settings.json; omit -l for global install)
pi install git:github.com/ethan-blue/pi-charset -l

# Or install from a local checkout (run npm install --omit=dev in the package directory first)
pi install /path/to/pi-charset -l
```

#### 2. Generate or Create `.pi-charset.json`

Scan an existing project and generate `.pi-charset.json`:

```bash
node tools/scan-encoding.mjs /path/to/project --init --dry-run
node tools/scan-encoding.mjs /path/to/project --init
```

Or create `.pi-charset.json` manually in the project root (JSONC comments supported):

```jsonc
{
  "sourceEncoding": "UTF-8",
  "writeEncoding": "UTF-8",
  "unmappable": "error",
  "verifyWrite": true,
  "protectUtf8": true,
  "readStrategy": "auto",
  "autoCandidates": ["GB18030", "GBK", "GB2312", "Big5"],
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

#### 3. Diagnostics

Run inside a Pi session:

```text
/charset-status
```

### Scope & Boundaries

| Entry Point | Handled | Notes |
|---|---|---|
| `read`, `write`, `edit`, `grep` tools | Yes | Works out-of-the-box in zero-config adaptive mode; customizable via optional `.pi-charset.json` |
| `bash`, `powershell` stdout/stderr | Optional | Disabled by default; enable via `transcodeBash: "auto"` |
| Shell output redirection (`echo >`, `Set-Content`) | No | Bypasses file tools; use `write` or `edit` instead |
| CLI startup `@file` arguments | No | Read by the host before extensions load |

Atomic replacement avoids partially written files, but it is not a cross-process transaction or lock. Avoid editing the same file concurrently with external tools. Writes to symbolic links are rejected; edit the target file directly. Existing permission modes are retained, but ownership, ACLs, extended attributes, hard-link relationships, and crash durability are not guaranteed by this replacement scheme.

### Documentation

- [Installation Guide](./docs/INSTALL.md)
- [Configuration Guide](./docs/CONFIG-GUIDE.md)
- [Host Compatibility Matrix](./docs/COMPATIBILITY.md)
- [Acceptance & Test Matrix](./docs/ACCEPTANCE.md)
- [Configuration Examples](./examples)

---

## 简体中文

### 简介

`pi-charset` 在 Pi 的工具 I/O 层接管 `read`、`write`、`edit` 与 `grep`，用于支持同一工程内混合存在 `GBK`、`GB18030`、`Big5`、`Shift_JIS`、`EUC-KR`、`ISO-8859-1`、`UTF-16` 与 `UTF-8` 文件的按文件读写与多编码搜索。全链路在进程内基于字节特征判定，不调用 Python 或外部探测子进程。

### GBK 工程怎么用

已有 GBK 工程，建议先运行下方扫描命令的 `--init --dry-run`，确认建议的目录规则后再生成配置。保留 `unmappable: "error"` 和 `verifyWrite: true`：GBK 放不下的字符应该报错，而不是悄悄变成问号。

修改源码时使用 Pi 的 `read`、`edit`、`write` 工具。Shell 重定向和外部格式化工具不经过本扩展。安装后先用 `/charset-status` 查看状态，试改一个已纳入版本管理的小文件，再用常用编辑器核对差异。

字节判定不能证明文件的原始编码。GBK 与 GB18030 存在重叠，同一串字节也可能符合其他编码；工程明确要求 GBK 时，应显式配置 GBK，尤其是新建文件和纯 ASCII 文件。本扩展用于防止新增乱码，不能恢复已经保存为问号或错误文本的原始内容。

### 工作机制

#### 1. 字节判定顺序
按以下固定顺序在内存中判定文件编码：
1. **BOM 识别**：`UTF-8 BOM`、`UTF-16LE`、`UTF-16BE`（`UTF-32 BOM` 归为 `BINARY`）。
2. **二进制识别**：前 8192 字节内含 `0x00` 判为 `BINARY`。
3. **显式 `force`**：命中带 `force: true` 的规则时直接采用规则指定编码。
4. **纯 ASCII**：全部字节 `<= 0x7F` 判为 `ASCII`。
5. **严格 UTF-8**：通过 `TextDecoder("utf-8", { fatal: true })` 整文件校验判为 `UTF-8`。
6. **多字节候选回环**：按 `autoCandidates` 顺序检查 `encode(decode(bytes)) == bytes` 且无 `U+FFFD`；多候选同时通过时优先采用 `sourceEncoding`。
7. **兜底**：未通过上述步骤的字节流判为 `UNKNOWN`。

#### 2. 三道写入门禁
- **闸门 1（字符可映射检查）**：写入前逐码点检查目标编码表示能力。默认策略 `error` 直接拒写并列出字符及 `U+XXXX` 码点；可选 `escape`（转为 `\uXXXX`）与 `drop-to-gb18030`（GB 族自动升为 `GB18030`）。
- **闸门 2（写前往返与写后回读校验）**：落盘前在内存验证 `decode(encode(text)) === text`；落盘后回读磁盘文件核对字节与解码文本。若写后核对不一致，报错并保留磁盘现状，不执行旧备份回滚。
- **闸门 3（未知编码与有损写入拦截）**：拦截 `BINARY` 与 `UNKNOWN` 文件写入；含非 ASCII 的 UTF-8 文件默认保持 UTF-8 写回（`protectUtf8: true`）；磁盘原字节无法在目标编码下逐字节无损回环时拒绝写入。

#### 3. 行尾与读取基线校验
- **行尾保持**：已存在文件按磁盘原有行尾（`CRLF` 或 `LF`）写回；无换行文件不追加尾部换行。
- **混合换行拦截**：同时含 `CRLF` 与 `LF` 的文件允许 `read` 读取，拒绝 `edit` 与 `write` 修改。
- **新建文件行尾**：支持通过 `newFileLineEnding: "CRLF" | "LF"` 指定新建文件的行尾格式。
- **读取基线冲突检测**：读取受管文件时记录 SHA-1 指纹；写入前若磁盘 SHA-1 已改变，报外部修改冲突并拒绝覆盖。

#### 4. 零配置自适应与同目录邻居推断
`pi-charset` 安装后无需编写 `.pi-charset.json` 即可直接工作：
- **已存在文件**：读取时按文件自身字节判定出的编码（`GBK`、`GB18030`、`Big5`、`UTF-16`、`UTF-8`）解码；写入时自动保持原文件编码、原有行尾（`CRLF` 或 `LF`）与 BOM。
- **新建文件与纯 ASCII 文件加中文**：未放置 `.pi-charset.json` 时，自动扫描同目录下的相邻源码文件（优先匹配同语言后缀族，如 `.c`/`.h`），继承该目录的主流编码与行尾格式（同目录为 UTF-8 或空目录时默认 `UTF-8`）。
- **多编码搜索（`grep`）**：正则搜索或非 ASCII 字面量搜索时，零配置下执行 `UTF-8 + GB18030` 双趟 `ripgrep` 搜索（有 `.pi-charset.json` 时按配置候选编码集合分趟），经逐文件字节判定复核后按 `file:line` 去重。

### 快速开始

#### 1. 安装

```bash
# 从 Git 安装（-l 写入当前项目 .pi/settings.json，不加 -l 写入用户全局配置）
pi install git:github.com/ethan-blue/pi-charset -l

# 或从本地目录安装（需先在扩展目录执行 npm install --omit=dev）
pi install /path/to/pi-charset -l
```

#### 2. 生成或编写 `.pi-charset.json`

使用内置扫描工具分析工程并生成 `.pi-charset.json`：

```bash
node tools/scan-encoding.mjs /path/to/project --init --dry-run
node tools/scan-encoding.mjs /path/to/project --init
```

或在项目根目录手动创建 `.pi-charset.json`（支持 `//` 与 `/* */` 注释）：

```jsonc
{
  "sourceEncoding": "UTF-8",
  "writeEncoding": "UTF-8",
  "unmappable": "error",
  "verifyWrite": true,
  "protectUtf8": true,
  "readStrategy": "auto",
  "autoCandidates": ["GB18030", "GBK", "GB2312", "Big5"],
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

#### 3. 状态诊断

在 Pi 会话中执行：

```text
/charset-status
```

### 作用边界

| 入口 | 是否处理 | 说明 |
|---|---|---|
| `read`、`write`、`edit`、`grep` 工具 | 是 | 默认启用零配置自适应模式；可通过可选的 `.pi-charset.json` 自定义规则 |
| `bash`、`powershell` 标准输出与错误流 | 可选 | 默认关闭；设置 `transcodeBash: "auto"` 后将非 UTF-8 输出转为 UTF-8 |
| Shell 重定向写文件（如 `echo >`、`Set-Content`） | 否 | 不经过文件工具层，请使用 `write` 或 `edit` 工具写文件 |
| 启动命令行 `@file` 参数 | 否 | 在扩展加载前由宿主直接读取 |

原子替换用于避免文件只写了一半，不等于跨进程事务或文件锁。请避免与外部工具同时修改同一文件。符号链接拒绝写入，请直接修改目标文件。替换时保留已有权限模式，但不保证保留所有者、ACL、扩展属性、硬链接关系，也不保证掉电后的持久性。

### 文档索引

- [安装说明 (INSTALL.md)](./docs/INSTALL.md)
- [配置指南 (CONFIG-GUIDE.md)](./docs/CONFIG-GUIDE.md)
- [宿主兼容矩阵 (COMPATIBILITY.md)](./docs/COMPATIBILITY.md)
- [验收与测试矩阵 (ACCEPTANCE.md)](./docs/ACCEPTANCE.md)
- [配置示例 (examples/)](./examples)

---

## Development / 本地开发

```bash
npm run typecheck    # TypeScript type checking (tsc --noEmit)
npm test             # Run Vitest; use its summary for current pass/skip counts
npm run verify       # Run typecheck + test
```

## License / 许可证

[MIT](./LICENSE) © 2026 ethan-blue
