# Changelog / 版本变更日志

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本文件记录项目的重要版本变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.1.0] - 2026-10-27

### Added / 新增

- **Deterministic Byte Classifier / 确定性字节编码判定** (`src/encoding/classify.ts`)
  - In-memory classification pipeline powered by Node native C++ SIMD (`node:buffer` `isAscii` / `isUtf8`): `BOM -> NUL binary check -> force rule -> pure ASCII -> strict UTF-8 -> CJK lossless round-trip -> config fallback`.
  - 基于 Node 原生 C++ SIMD（`node:buffer` `isAscii` / `isUtf8`）的纯内存编码判定链：`BOM -> NUL 二进制检查 -> force 规则 -> 纯 ASCII -> 严格 UTF-8 -> CJK 多字节无损回环 -> 配置兜底`。
  - Zero-config self-adaptive mode with same-directory sibling inference for newly created and pure-ASCII files.
  - 零配置自适应模式：已有文件自动保持原编码与行尾，新建文件与纯 ASCII 文件自动根据同目录邻居文件推断编码与行尾。
  - File-level classification cache keyed by `(path, mtimeMs, size, configKey)`.
  - 基于 `(path, mtimeMs, size, configKey)` 的文件级判定缓存。

- **Write Safety Gates & Conflict Detection / 写入门禁与冲突检测** (`src/operations.ts`, `src/resolve.ts`)
  - Gate 1: Unmappable code point detection supporting `error`, `escape` (`\uXXXX`), and `drop-to-gb18030` strategies.
  - 闸门 1：目标编码不可映射字符检查，支持 `error`、`escape`（`\uXXXX`）与 `drop-to-gb18030` 三种策略。
  - Gate 2: Pre-write in-memory round-trip verification and post-write disk read-back verification, preserving on-disk state on conflict without rolling back over external changes.
  - 闸门 2：写前内存编解码往返校验与写后磁盘回读核对；校验不一致时报错并保留磁盘现状，不执行旧备份回滚。
  - Gate 3: Rejects writes to `BINARY` and `UNKNOWN` files, blocks writing `U+FEFF` BOM into GB-family encodings, and blocks lossy re-encoding of existing files.
  - 闸门 3：拦截 `BINARY`、`UNKNOWN`、BOM 写入 GB 族编码以及原文件字节无法无损回环的写入。
  - SHA-1 read baseline tracking to detect external file modifications between `read` and `write`.
  - 记录受管文件读取时的 SHA-1 基线指纹，在写入前检测外部进程修改冲突。
  - Per-file serialized write locks and atomic temp-file `fsync + rename` replacement with Windows lock retries.
  - 路径级串行写锁，配合同目录临时文件 `fsync + rename` 原子替换与 Windows 瞬时文件锁退避重试。

- **Line-Ending Handling / 行尾处理** (`src/encoding/line-endings.ts`)
  - Preserves existing `CRLF` or `LF` line endings; allows reading `MIXED` (`CRLF` + `LF`) files while rejecting `edit` and `write`.
  - 保留已存在文件的 `CRLF` 或 `LF` 行尾；混合换行（`CRLF` 与 `LF` 并存）文件允许读取、拒绝写入。
  - Supports `newFileLineEnding: "CRLF" | "LF"` for newly created files.
  - 支持通过 `newFileLineEnding: "CRLF" | "LF"` 配置新建文件的行尾格式。

- **Multi-Encoding Search & Edit Preview / 多编码搜索与编辑预览** (`src/grep.ts`, `src/edit-preview.ts`)
  - Multi-pass `ripgrep` execution across configured encodings with per-file classification verification and `file:line` deduplication.
  - `grep` 按配置编码集合分趟调用 `ripgrep`，经逐文件字节判定过滤乱码伪命中并按 `file:line` 去重。
  - Encoding-aware `edit` diff preview for non-UTF-8 managed files, delegating UTF-8 files to Pi's built-in renderer.
  - 针对非 UTF-8 受管文件提供编码感知的 `edit` diff 预览，UTF-8 文件直接委托内置渲染器。

- **Configuration, Scanner CLI & Diagnostics / 配置、扫描工具与诊断命令** (`src/config.ts`, `tools/scan-encoding.mjs`, `src/index.ts`)
  - Configuration file `.pi-charset.json` with JSONC comment support.
  - 标准配置文件 `.pi-charset.json`（支持 JSONC 注释）。
  - Standalone scanner `tools/scan-encoding.mjs` supporting directory profiling, `--damaged` inspection, and `--init` config generation.
  - 独立扫描脚本 `tools/scan-encoding.mjs`，支持目录编码画像、`--damaged` 受损文件检查与 `--init` 配置生成。
  - Diagnostic command `/charset-status`.
  - 注册 `/charset-status` 诊断命令。
