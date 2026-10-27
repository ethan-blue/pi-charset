# Acceptance & Test Matrix / 验收矩阵与复现命令

**[English](#english) | [简体中文](#简体中文)**

---

## Verification Commands / 验证命令

```bash
npm run typecheck    # tsc --noEmit (0 errors)
npm test             # vitest run; reports current pass/skip counts
npm run verify       # typecheck + test
```

---

## English

The matrix below maps expected behavior to test suites; it is not a live CI report. Use the commands above to verify the current checkout. Check skipped tests as well as failures: host integration and platform-specific cases depend on the installed host and operating system. A green Windows run does not establish POSIX permission or symlink behavior, and a smoke performance threshold is not a latency guarantee.

### 1. End-to-End Acceptance Matrix (A-01 ~ A-24)

| ID | Scenario | Status | Verification Suite |
|---|---|---|---|
| A-01 | Read GBK Chinese source files | PASS | `test/acceptance.test.ts` (with full-tree SHA-256 verification) |
| A-02 | Edit GBK Chinese and numeric literals preserving encoding and `CRLF` | PASS | `test/acceptance.test.ts`, `test/host-integration.test.ts` |
| A-03 | Byte-exact passthrough in directories without `.pi-charset.json` | PASS | `test/operations.test.ts` |
| A-04 | Preserve single BOM when editing UTF-8 BOM files | PASS | `test/acceptance.test.ts`, `test/roundtrip.test.ts` |
| A-05 | Write pure-ASCII files as GBK when Chinese characters are first added | PASS | `test/acceptance.test.ts`, `test/roundtrip.test.ts` |
| A-06 | Apply `newFileLineEnding` (`GBK + CRLF`) to new `.c`/`.h` files; write new docs as `UTF-8` | PASS | `test/acceptance.test.ts`, `test/operations.test.ts` |
| A-07 | Preserve absence of trailing newline on edit | PASS | `test/acceptance.test.ts`, `test/operations.test.ts` |
| A-08 | Allow reading `MIXED` (`CRLF` + `LF`) files while rejecting `edit` and `write` | PASS | `test/acceptance.test.ts`, `test/operations.test.ts`, `test/host-integration.test.ts` |
| A-09 | Reject unmappable code points (Gate 1) without writing `0x3F` (`?`) | PASS | `test/gates.test.ts`, `test/acceptance.test.ts` |
| A-10 | Classify truncated or invalid byte sequences as `UNKNOWN` and reject writes | PASS | `test/classify.test.ts`, `test/resolve.test.ts`, `test/gates.test.ts` |
| A-11 | Return raw image bytes and `image` content block for PNG/JPEG/GIF/WebP/BMP | PASS | `test/operations.test.ts`, `test/acceptance.test.ts` |
| A-12 | Search Chinese keywords across mixed GBK and UTF-8 files without duplicate hits | PASS | `test/grep.test.ts`, `test/acceptance.test.ts`, `test/perf/grep-scale.test.ts` |
| A-13 | Support `glob`, `literal`, `ignoreCase`, `context`, `limit`, and `AbortSignal` in `grep` | PASS | `test/grep.test.ts`, `test/perf/grep-scale.test.ts` |
| A-14 | Exclude `.git`, `.svn`, `.hg`, and `node_modules` from search results | PASS | `test/grep.test.ts`, `test/acceptance.test.ts` |
| A-15 | Emit warning and apply safe defaults when `.pi-charset.json` contains malformed JSON | PASS | `test/acceptance.test.ts`, `test/resolve.test.ts` |
| A-16 | Detect external file modification via SHA-1 read baseline and reject stale writes | PASS | `test/acceptance.test.ts`, `test/operations.test.ts`, `test/host-integration.test.ts` |
| A-17 | Preserve on-disk file state without rollback when post-write verification detects conflict | PASS | `test/gates.test.ts` |
| A-18 | Report write errors on read-only or locked files and clean up temporary `.tmp` files | PASS | `test/acceptance.test.ts`, `test/gates.test.ts` |
| A-19 | Serialize 20 concurrent writes to the same file without corruption or leftover temp files | PASS | `test/concurrency.test.ts` |
| A-20 | Invalidate caches automatically on config modification or session reload | PASS | `test/resolve.test.ts`, `test/edit-preview.test.ts` |
| A-21 | Sub-session tool inheritance | N/A | Host-dependent; documented in `README.md` scope table |
| A-22 | Load `src/index.ts` via `discoverAndLoadExtensions` and CLI RPC mode | PASS | `test/host-integration.test.ts` |
| A-23 | Compute encoding-aware `edit` preview diffs and invalidate preview cache | PASS | `test/edit-preview.test.ts` |
| A-24 | Verify `npm pack --dry-run` file whitelist and clean directory loading | PASS | `package.json` `files` whitelist verification |

### 2. Test Suite Breakdown

| Test File | Coverage |
|---|---|
| `test/classify.test.ts` | 16 fixture classifications, UTF-8 priority, single-byte exclusion, 1MB classification latency & cache |
| `test/converter.test.ts` | Encoding alias normalization, GB-family detection, unmappable code point detection & `\uXXXX` escaping |
| `test/regressions.test.ts` | GBK question marks and emoji; UTF-8/UTF-16 line endings and BOM; external deletion and pre-rename conflicts; platform path keys; unsupported shell encodings; Rust regex; POSIX mode/symlink checks (platform-conditional) |
| `test/config.test.ts` | `.pi-charset.json` nearest-directory lookup, override specificity scoring & validation |
| `test/resolve.test.ts` | Read/write decision matrix, `writeIntent` resolution, UTF-8 protection, BOM rules, config hot-reload |
| `test/gates.test.ts` | Gate 1 (`error`/`escape`/`drop-to-gb18030`), Gate 2 (read-back verification preserving disk state), Gate 3 |
| `test/roundtrip.test.ts` | Byte-exact `read -> write` round-trip across 12 encodings, ASCII-to-GBK writes, `CRLF` idempotency |
| `test/utf8-protect.test.ts` | UTF-8 preservation inside GBK trees and full-tree mixed-encoding verification |
| `test/line-endings.test.ts` | `CRLF`, `LF`, `MIXED`, and `NONE` detection and restoration |
| `test/operations.test.ts` | `read`/`write`/`edit` operations, `newFileLineEnding`, mixed line-ending guard, SHA-1 baseline check |
| `test/grep.test.ts` | Multi-pass search, per-file classification filtering, context decoding, unconfigured passthrough |
| `test/edit-preview.test.ts` | Synchronous preview routing cache, async diff rendering for GB files, single-byte `force` routing |
| `test/shell.test.ts` | Streaming shell output transcoding, split multi-byte chunks, incomplete UTF-8 tail detection, file dump detection |
| `test/sysnote.test.ts` | Conditional system prompt injection and `tool_result` notice queue |
| `test/zero-config.test.ts` | Zero-config self-adaptive read, write, edit, and same-directory sibling inference |
| `test/scan-init.test.ts` | `tools/scan-encoding.mjs` CLI validation, `--init` declaration extraction, narrowest encoding selection, `--damaged` |
| `test/concurrency.test.ts` | 20-way concurrent single-file writes and multi-file concurrent writes |
| `test/host-integration.test.ts` | Extension registration, `/charset-status` command, and `discoverAndLoadExtensions` loader test |
| `test/perf/io-latency.test.ts` | 300x 8.7KB GBK read/write loop and 1MB file read/write latency |
| `test/perf/grep-scale.test.ts` | 2,000-file mixed GBK/UTF-8 search and `AbortSignal` cancellation latency |

---

## 简体中文

下表用于对照预期行为与测试位置，不是当前版本的实时 CI 报告。请运行上方命令验证本次检出代码，并同时查看失败和跳过项：宿主集成测试、平台相关测试受本机环境影响。Windows 测试通过不能证明 POSIX 权限或符号链接行为已实测，性能 smoke 阈值也不代表延迟承诺。

### 1. 端到端验收矩阵（A-01 ~ A-24）

| 编号 | 验收场景 | 状态 | 验证位置 |
|---|---|---|---|
| A-01 | GBK 中文文件读取 | PASS | `test/acceptance.test.ts`（含整树未修改文件 SHA-256 对照） |
| A-02 | `edit` 工具替换 GBK 中文与数值，保持原编码与 `CRLF` | PASS | `test/acceptance.test.ts`、`test/host-integration.test.ts` |
| A-03 | 无配置文件目录读写与内置行为逐字节一致 | PASS | `test/operations.test.ts` |
| A-04 | UTF-8 BOM 文件编辑后保留单个 BOM | PASS | `test/acceptance.test.ts`、`test/roundtrip.test.ts` |
| A-05 | 纯 ASCII 源文件首次写入中文按 `override` 写为 GBK | PASS | `test/acceptance.test.ts`、`test/roundtrip.test.ts` |
| A-06 | 新建 `.c`/`.h` 按 `newFileLineEnding` 写 `GBK + CRLF`，新建文档写 `UTF-8` | PASS | `test/acceptance.test.ts`、`test/operations.test.ts` |
| A-07 | 无末尾换行文件编辑后不追加换行 | PASS | `test/acceptance.test.ts`、`test/operations.test.ts` |
| A-08 | 混合换行（`CRLF` + `LF`）文件可读，拒绝 `edit` 与 `write` 且磁盘字节不变 | PASS | `test/acceptance.test.ts`、`test/operations.test.ts`、`test/host-integration.test.ts` |
| A-09 | 不可映射字符（如 `䶇` 写入 GBK）被闸门 1 拦截，不产生 `0x3F` | PASS | `test/gates.test.ts`、`test/acceptance.test.ts` |
| A-10 | 截断或未知字节序列判为 `UNKNOWN`，拒绝写入 | PASS | `test/classify.test.ts`、`test/resolve.test.ts`、`test/gates.test.ts` |
| A-11 | PNG/JPEG/GIF/WebP/BMP 图片原样读取并返回 `image` 内容块 | PASS | `test/operations.test.ts`、`test/acceptance.test.ts` |
| A-12 | GBK 与 UTF-8 混合目录搜索中文，双侧命中且不重复计数 | PASS | `test/grep.test.ts`、`test/acceptance.test.ts`、`test/perf/grep-scale.test.ts` |
| A-13 | `grep` 支持 `glob`、`literal`、`ignoreCase`、`context`、`limit` 与 `AbortSignal` 取消 | PASS | `test/grep.test.ts`、`test/perf/grep-scale.test.ts` |
| A-14 | 默认排除 `.git`、`.svn`、`.hg`、`node_modules` 副本 | PASS | `test/grep.test.ts`、`test/acceptance.test.ts` |
| A-15 | 配置文件 JSON 语法损坏时输出警告并按默认值保护受管文件 | PASS | `test/acceptance.test.ts`、`test/resolve.test.ts` |
| A-16 | 读取后文件被外部修改，再次写入时检测 SHA-1 基线冲突并拒写 | PASS | `test/acceptance.test.ts`、`test/operations.test.ts`、`test/host-integration.test.ts` |
| A-17 | 落盘后自校验发现外部并发改写时报错并保留磁盘现场，不回滚覆盖外部新内容 | PASS | `test/gates.test.ts` |
| A-18 | 只读文件或锁冲突写入失败时如实报错并清理 `.tmp` 临时文件 | PASS | `test/acceptance.test.ts`、`test/gates.test.ts` |
| A-19 | 同一文件 20 路并发写入串行化，无交错损坏与临时文件残留 | PASS | `test/concurrency.test.ts` |
| A-20 | 配置文件修改或会话重载后自动失效缓存 | PASS | `test/resolve.test.ts`、`test/edit-preview.test.ts` |
| A-21 | 子会话工具继承 | 未覆盖 | 取决于宿主子会话创建方式，已在 `README.md` 边界表说明 |
| A-22 | 宿主真实加载器加载 `src/index.ts` 与 RPC 模式启动 | PASS | `test/host-integration.test.ts` |
| A-23 | 非 UTF-8 文件 `edit` 预览 diff 计算与缓存失效 | PASS | `test/edit-preview.test.ts` |
| A-24 | `npm pack --dry-run` 打包清单与干净目录加载验证 | PASS | `package.json` `files` 白名单验证 |

### 2. 测试套件分布

各测试文件覆盖范围见上方英文小节第 2 节表格。
