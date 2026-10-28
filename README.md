# pi-charset

[![CI](https://github.com/ethan-blue/pi-charset/actions/workflows/ci.yml/badge.svg)](https://github.com/ethan-blue/pi-charset/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.1.1-blue.svg)](https://github.com/ethan-blue/pi-charset/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

Encoding-aware `read`, `write`, `edit`, and `grep` extension for [Pi](https://github.com/earendil-works) (`@earendil-works/pi-coding-agent`).

English | [简体中文](./README.zh-CN.md)

---

## Overview

`pi-charset` intercepts file I/O and search operations in Pi to handle repositories that mix `GBK`, `GB18030`, `Big5`, `Shift_JIS`, `EUC-KR`, `ISO-8859-1`, `UTF-16`, and `UTF-8` files within the same workspace. All byte classification and transcoding run in-process without external Python or `chardet` subprocesses.

## Working with a GBK Project

For an existing GBK project, run `/charset-init --dry-run` (or `/charset-init embedded-c --dry-run`) inside Pi to review the suggested rules before generating `.pi-charset.json`. Keep `unmappable: "error"` and `verifyWrite: true`: characters that GBK cannot represent should stop a write rather than turn into `?`.

Use Pi's `read`, `edit`, and `write` tools for source changes. Shell redirection and external formatters bypass this extension. After installation, run `/charset-status`, edit a small tracked file, and inspect the diff in your usual editor before wider use.

Byte detection is not proof of an encoding: GBK and GB18030 overlap, and some bytes also decode under other encodings. For a project that requires GBK, declare GBK explicitly instead of relying on inference, especially for new or ASCII-only files. This extension prevents new encoding damage; it cannot reconstruct text that was already saved as question marks or mojibake.

## Architecture

### 1. Deterministic Byte Classification

Files are classified in memory in a fixed order:
1. **BOM Detection**: `UTF-8 BOM`, `UTF-16LE`, `UTF-16BE` (`UTF-32 BOM` is classified as `BINARY`).
2. **Binary Guard**: Any `0x00` byte within the first 8192 bytes classifies the file as `BINARY`.
3. **Explicit `force`**: Rules with `force: true` apply the configured encoding directly.
4. **Pure ASCII**: Validated via Node's native `node:buffer` `isAscii` (`<= 0x7F`).
5. **Strict UTF-8**: Full-buffer validation via Node's native `node:buffer` `isUtf8` without heap string allocation.
6. **Multi-Byte CJK Round-Trip**: Candidates in `autoCandidates` are tested for `encode(decode(bytes)) == bytes` with zero `U+FFFD` replacement characters; `sourceEncoding` takes priority when multiple candidates pass.
7. **Fallback**: Unclassified byte sequences are marked `UNKNOWN`.

### 2. Write Safety Gates

- **Gate 1 (Unmappable Code Points)**: Checks every code point against the target encoding before writing. Default policy `error` aborts the write and lists unmappable characters with `U+XXXX` code points. Optional policies: `escape` (`\uXXXX`) and `drop-to-gb18030` (promotes GB-family writes to `GB18030`).
- **Gate 2 (Pre-Write Round-Trip & Post-Write Read-Back)**: Verifies `decode(encode(text)) === text` in memory before touching disk, then reads back the written file to verify byte and text equality. If post-write verification fails, `pi-charset` reports the mismatch and preserves the on-disk file without rolling back to a stale backup.
- **Gate 3 (Unknown & Lossy Conversion Guard)**: Rejects writes to `BINARY` or `UNKNOWN` files, preserves existing `UTF-8` files by default (`protectUtf8: true`), and rejects writes when existing on-disk bytes cannot losslessly round-trip in the target encoding.

### 3. Line Endings & Baseline Conflict Detection

- **Line-Ending Preservation**: Existing files keep their on-disk line endings (`CRLF` or `LF`, detected at the character level for UTF-16); files without newlines do not get trailing newlines appended.
- **Mixed Line-Ending Guard**: Files containing both `CRLF` and `LF` can be read via `read`, but `edit` and `write` are rejected.
- **New-File Line Endings**: Configurable via `newFileLineEnding: "CRLF" | "LF"` for newly created files.
- **Read Baseline Verification**: Records a SHA-1 fingerprint when a managed file is read; rejects writes if the on-disk file was modified or deleted externally after the read.

### 4. Zero-Config Self-Adaptive Mode & Sibling Inference

`pi-charset` works out-of-the-box without requiring a `.pi-charset.json` file:
- **Existing Files**: Automatically read in their byte-classified encoding (`GBK`, `GB18030`, `Big5`, `UTF-16`, `UTF-8`) and written back preserving their original encoding, line endings (`CRLF` or `LF`), and BOM.
- **New & Pure-ASCII Files**: When no `.pi-charset.json` is present, `pi-charset` inspects sibling files in the same directory (matching extension group first, e.g. `.c`/`.h`) and inherits the dominant encoding and line-ending style (defaulting to `UTF-8` when siblings are UTF-8 or ASCII).
- **Multi-Encoding Search (`grep`)**: Regex patterns and non-ASCII literals run `UTF-8 + GB18030` `ripgrep` passes in zero-config mode, or the configured candidate encodings when `.pi-charset.json` is present. Matches are verified against each file's classified encoding and deduplicated by `file:line`.

## Quick Start

### 1. Installation

```bash
# Install from Git (-l writes to project .pi/settings.json; omit -l for global install)
pi install git:github.com/ethan-blue/pi-charset -l

# Pin a specific release tag
pi install git:github.com/ethan-blue/pi-charset@v0.1.2 -l

# Or install from a local checkout (run npm install --omit=dev in the package directory first)
pi install /path/to/pi-charset -l
```

### 2. Scaffold or Create `.pi-charset.json`

Inside a Pi session, generate `.pi-charset.json` directly with `/charset-init` (auto-scan or preset template):

```text
/charset-scan                        # Read-only encoding & line-ending profile
/charset-scan --damaged              # Check for pre-existing U+FFFD / mojibake files
/charset-init --dry-run              # Preview auto-inferred config without writing disk
/charset-init                        # Generate .pi-charset.json from project declarations & bytes
/charset-init embedded-c             # Or scaffold from preset: embedded-c | legacy-java-web | mixed-repo | all-utf8
/charset-setup                       # Prompt template: guided workspace audit + config preview
```

Or run the standalone CLI scanner outside Pi:

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

### 3. Diagnostics

Run inside a Pi session:

```text
/charset-status
```

## Scope & Boundaries

| Entry Point | Handled | Notes |
|---|---|---|
| `read`, `write`, `edit`, `grep` tools | Yes | Works out-of-the-box in zero-config adaptive mode; customizable via optional `.pi-charset.json` |
| `bash`, `powershell` stdout/stderr | Optional | Disabled by default; enable via `transcodeBash: "auto"` |
| Shell output redirection (`echo >`, `Set-Content`) | No | Bypasses file tools; use `write` or `edit` instead |
| CLI startup `@file` arguments | No | Read by the host before extensions load |

Atomic replacement avoids partially written files, but it is not a cross-process transaction or lock. Avoid editing the same file concurrently with external tools. Writes to symbolic links are rejected; edit the target file directly. Existing permission modes are retained, but ownership, ACLs, extended attributes, hard-link relationships, and crash durability are not guaranteed by this replacement scheme.

## Documentation

- [Installation Guide](./docs/INSTALL.md)
- [Configuration Guide](./docs/CONFIG-GUIDE.md)
- [Host Compatibility Matrix](./docs/COMPATIBILITY.md)
- [Acceptance & Test Matrix](./docs/ACCEPTANCE.md)
- [Release Guide](./docs/RELEASING.md)
- [Contributing](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)
- [Configuration Examples](./examples)

## Development

```bash
npm run typecheck       # TypeScript type checking (tsc --noEmit)
npm test                # Run Vitest suite
npm run check:release   # Verify version sync, changelog, links, and package manifest
npm run verify          # Run typecheck + test + check:release
```

## License

[MIT](./LICENSE) © 2026 ethan-blue
