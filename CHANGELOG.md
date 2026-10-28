# Changelog

English | [简体中文](./CHANGELOG.zh-CN.md)

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.2] - 2026-10-28

### Added

- Add in-session `/charset-init` and `/charset-scan` scaffolding commands (`src/scaffold.ts`, `src/index.ts`) supporting scan-based `.pi-charset.json` generation, preset templates (`embedded-c`, `legacy-java-web`, `mixed-repo`, `all-utf8`), `--dry-run` preview, `--force` overwrite control, and immediate session cache refresh.
- Bundle the `charset-rules` Agent Skill (`skills/charset-rules/SKILL.md`) and `/charset-setup` prompt template (`prompts/charset-setup.md`) in the Pi package manifest (`package.json` `pi.skills` and `pi.prompts`).
- Add automated release verification (`tools/check-release.mjs`), `npm version` synchronization (`tools/sync-version.mjs`), changelog section extraction (`tools/extract-changelog.mjs`), tag-triggered GitHub Release & optional npm provenance workflow (`.github/workflows/release.yml`), and repository engineering rules (`AGENTS.md`, `.editorconfig`, `CONTRIBUTING.md`, `docs/RELEASING.md`).

### Changed

- Split all English and Simplified Chinese documentation into standalone, cross-linked files (`README.md` / `README.zh-CN.md`, `CHANGELOG.md` / `CHANGELOG.zh-CN.md`, `CONTRIBUTING.md` / `CONTRIBUTING.zh-CN.md`, `docs/*.md` / `docs/zh-CN/*.md`).

## [0.1.1] - 2026-10-27

### Fixed

- Preserve literal question marks when escaping characters that the target encoding cannot represent; use encoding round trips rather than replacement-byte heuristics.
- Detect UTF-16 line endings at the character level, including characters whose bytes resemble CR or LF.
- Check destination write access before atomic replacement so read-only files remain protected on POSIX systems.
- Keep path keys case-sensitive outside Windows and reset classification caches when the extension reloads.
- Load the optional ripgrep package through an ESM-compatible module loader; deduplicate search results only after validation.
- Apply line-ending guards to UTF-8 writes as well as legacy encodings; detect deletion after a read and recheck destination content before each rename attempt.
- Leave regex matching to ripgrep, including ASCII patterns such as `\p{Han}` that can match non-ASCII text.
- Validate shell fallback encodings before constructing a streaming decoder.

### Changed

- Reuse per-character encoding checks within each conversion, and reuse the prepared temporary file during Windows rename retries instead of rewriting it.
- Preserve existing file modes during atomic replacement and reject writes to symbolic links instead of replacing the link itself.
- Add GBK setup guidance and document the permanent content changes caused by `escape`, as well as the I/O cost of write verification.
- Add Node 24 to the CI matrix and make strict I/O timing checks opt-in with `STRICT_PERF=1`.
- Update Vitest and the dependency lockfile; pin the checkout's transitive `undici` to a patched range. Overrides do not update a separately installed Pi host.

## [0.1.0] - 2026-10-27

### Added

- **Deterministic Byte Classifier** (`src/encoding/classify.ts`)
  - In-memory classification pipeline powered by Node native C++ SIMD (`node:buffer` `isAscii` / `isUtf8`): `BOM -> NUL binary check -> force rule -> pure ASCII -> strict UTF-8 -> CJK lossless round-trip -> config fallback`.
  - Zero-config self-adaptive mode with same-directory sibling inference for newly created and pure-ASCII files.
  - File-level classification cache keyed by `(path, mtimeMs, size, configKey)`.

- **Write Safety Gates & Conflict Detection** (`src/operations.ts`, `src/resolve.ts`)
  - Gate 1: Unmappable code point detection supporting `error`, `escape` (`\uXXXX`), and `drop-to-gb18030` strategies.
  - Gate 2: Pre-write in-memory round-trip verification and post-write disk read-back verification, preserving on-disk state on conflict without rolling back over external changes.
  - Gate 3: Rejects writes to `BINARY` and `UNKNOWN` files, blocks writing `U+FEFF` BOM into GB-family encodings, and blocks lossy re-encoding of existing files.
  - SHA-1 read baseline tracking to detect external file modifications between `read` and `write`.
  - Per-file serialized write locks and atomic temp-file `fsync + rename` replacement with Windows lock retries.

- **Line-Ending Handling** (`src/encoding/line-endings.ts`)
  - Preserves existing `CRLF` or `LF` line endings; allows reading `MIXED` (`CRLF` + `LF`) files while rejecting `edit` and `write`.
  - Supports `newFileLineEnding: "CRLF" | "LF"` for newly created files.

- **Multi-Encoding Search & Edit Preview** (`src/grep.ts`, `src/edit-preview.ts`)
  - Multi-pass `ripgrep` execution across configured encodings with per-file classification verification and `file:line` deduplication.
  - Encoding-aware `edit` diff preview for non-UTF-8 managed files, delegating UTF-8 files to Pi's built-in renderer.

- **Configuration, Scanner CLI & Diagnostics** (`src/config.ts`, `tools/scan-encoding.mjs`, `src/index.ts`)
  - Configuration file `.pi-charset.json` with JSONC comment support.
  - Standalone scanner `tools/scan-encoding.mjs` supporting directory profiling, `--damaged` inspection, and `--init` config generation.
  - Diagnostic command `/charset-status`.
