# Acceptance & Test Matrix

English | [简体中文](./zh-CN/ACCEPTANCE.md)

---

## Verification Commands

```bash
npm run typecheck       # tsc --noEmit (0 errors)
npm test                # vitest run; reports current pass/skip counts
npm run check:release   # version sync, changelog, markdown links, and tarball manifest
npm run verify          # typecheck + test + check:release
```

The matrix below maps expected behavior to test suites; it is not a live CI report. Use the commands above to verify the current checkout. Check skipped tests as well as failures: host integration and platform-specific cases depend on the installed host and operating system. A green Windows run does not establish POSIX permission or symlink behavior, and a smoke performance threshold is not a latency guarantee.

## 1. End-to-End Acceptance Matrix (A-01 ~ A-24)

| ID | Scenario | Status | Verification Suite |
|---|---|---|---|
| A-01 | Read GBK Chinese source files | PASS | `test/acceptance.test.ts` (with full-tree SHA-256 verification) |
| A-02 | Edit GBK Chinese and numeric literals preserving encoding and `CRLF` | PASS | `test/acceptance.test.ts`, `test/host-integration.test.ts` |
| A-03 | Zero-config self-adaptive read/write/sibling inference without `.pi-charset.json` | PASS | `test/zero-config.test.ts`, `test/operations.test.ts` |
| A-04 | Preserve single BOM when editing UTF-8 BOM files | PASS | `test/acceptance.test.ts`, `test/roundtrip.test.ts` |
| A-05 | Write pure-ASCII files as GBK when Chinese characters are first added | PASS | `test/acceptance.test.ts`, `test/roundtrip.test.ts` |
| A-06 | Apply `newFileLineEnding` (`GBK + CRLF`) to new `.c`/`.h` files; write new docs as `UTF-8` | PASS | `test/acceptance.test.ts`, `test/operations.test.ts` |
| A-07 | Preserve absence of trailing newline on edit | PASS | `test/acceptance.test.ts`, `test/operations.test.ts` |
| A-08 | Allow reading `MIXED` (`CRLF` + `LF`) files while rejecting `edit` and `write` | PASS | `test/acceptance.test.ts`, `test/operations.test.ts`, `test/regressions.test.ts` |
| A-09 | Reject unmappable code points (Gate 1) without writing `0x3F` (`?`) | PASS | `test/gates.test.ts`, `test/acceptance.test.ts` |
| A-10 | Classify truncated or invalid byte sequences as `UNKNOWN` and reject writes | PASS | `test/classify.test.ts`, `test/resolve.test.ts`, `test/gates.test.ts` |
| A-11 | Return raw image bytes and `image` content block for PNG/JPEG/GIF/WebP/BMP | PASS | `test/operations.test.ts`, `test/acceptance.test.ts` |
| A-12 | Search Chinese keywords across mixed GBK and UTF-8 files without duplicate hits | PASS | `test/grep.test.ts`, `test/acceptance.test.ts`, `test/perf/grep-scale.test.ts` |
| A-13 | Support `glob`, `literal`, `ignoreCase`, `context`, `limit`, and `AbortSignal` in `grep` | PASS | `test/grep.test.ts`, `test/perf/grep-scale.test.ts` |
| A-14 | Exclude `.git`, `.svn`, `.hg`, and `node_modules` from search results | PASS | `test/grep.test.ts`, `test/acceptance.test.ts` |
| A-15 | Emit warning and apply safe defaults when `.pi-charset.json` contains malformed JSON | PASS | `test/acceptance.test.ts`, `test/resolve.test.ts` |
| A-16 | Detect external file modification or deletion via SHA-1 read baseline and reject stale writes | PASS | `test/acceptance.test.ts`, `test/operations.test.ts`, `test/regressions.test.ts` |
| A-17 | Preserve on-disk file state without rollback when post-write verification detects conflict | PASS | `test/gates.test.ts`, `test/regressions.test.ts` |
| A-18 | Report write errors on read-only or locked files and clean up temporary `.tmp` files | PASS | `test/acceptance.test.ts`, `test/gates.test.ts` |
| A-19 | Serialize 20 concurrent writes to the same file without corruption or leftover temp files | PASS | `test/concurrency.test.ts` |
| A-20 | Invalidate caches automatically on config modification or session reload | PASS | `test/resolve.test.ts`, `test/edit-preview.test.ts` |
| A-21 | Sub-session tool inheritance | N/A | Host-dependent; documented in [`README.md`](../README.md) scope table |
| A-22 | Load `src/index.ts` via `discoverAndLoadExtensions` and CLI RPC mode | PASS | `test/host-integration.test.ts` |
| A-23 | Compute encoding-aware `edit` preview diffs and invalidate preview cache | PASS | `test/edit-preview.test.ts` |
| A-24 | Verify `npm pack --dry-run` file whitelist and clean directory loading | PASS | `tools/check-release.mjs` |

## 2. Test Suite Breakdown

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
| `test/grep.test.ts` | Multi-pass search, per-file classification filtering, context decoding, zero-config multi-encoding search |
| `test/edit-preview.test.ts` | Synchronous preview routing cache, async diff rendering for GB files, single-byte `force` routing |
| `test/shell.test.ts` | Streaming shell output transcoding, split multi-byte chunks, incomplete UTF-8 tail detection, file dump detection |
| `test/sysnote.test.ts` | Conditional system prompt injection and `tool_result` notice queue |
| `test/zero-config.test.ts` | Zero-config self-adaptive read, write, edit, and same-directory sibling inference |
| `test/scan-init.test.ts` | `tools/scan-encoding.mjs` CLI validation, `--init` declaration extraction, narrowest encoding selection, `--damaged` |
| `test/concurrency.test.ts` | 20-way concurrent single-file writes and multi-file concurrent writes |
| `test/host-integration.test.ts` | Extension registration, `/charset-status` + `/charset-init` + `/charset-scan` scaffolding commands, and `discoverAndLoadExtensions` loader test |
| `test/perf/io-latency.test.ts` | 300x 8.7KB GBK read/write loop and 1MB file read/write latency |
| `test/perf/grep-scale.test.ts` | 2,000-file mixed GBK/UTF-8 search and `AbortSignal` cancellation latency |
