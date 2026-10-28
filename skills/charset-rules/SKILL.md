---
name: charset-rules
description: Enforce file-encoding, line-ending, and write-gate safety rules in repositories containing GBK, GB18030, Big5, Shift_JIS, EUC-KR, ISO-8859-1, UTF-16, or CRLF/LF mixed files. Use when editing embedded C/C++, legacy Java, or mixed-encoding repositories, scaffolding .pi-charset.json, or resolving Gate 1/2/3 encoding errors.
license: MIT
---

# Charset & Line-Ending Safety Rules

Follow these rules whenever working in a repository with non-UTF-8 files (`GBK`, `GB18030`, `Big5`, `Shift_JIS`, `EUC-KR`, `ISO-8859-1`, `UTF-16`) or strict `CRLF` / `LF` conventions.

## 1. File Tool Boundaries

- **Always read, edit, and write source files via Pi's `read`, `edit`, and `write` tools**, and search via `grep`.
- **Never write or rewrite source files through shell commands** (`echo >`, `cat <<EOF >`, `sed -i`, `perl -pi`, `Set-Content`, `Out-File`, or one-off Python/Node scripts). Shell writes bypass `pi-charset`'s byte classifier, line-ending preservation, and write safety gates, silently converting `GBK` files to `UTF-8` or corrupting non-ASCII bytes.
- **Never run `iconv` or manually convert file encodings** unless the user explicitly asks to migrate a file's encoding.

## 2. Scaffolding `.pi-charset.json`

`pi-charset` works in zero-config self-adaptive mode by default, but projects with strict compiler encoding requirements (such as Keil MDK `GBK` C/C++ sources or legacy Java `GBK` / `ISO-8859-1` trees) should commit an explicit `.pi-charset.json`:

1. Preview first without writing to disk:
   - Scan-based inference: run `node ../../tools/scan-encoding.mjs . --init --dry-run` (relative to this skill directory) or ask the user to run `/charset-init --dry-run`.
   - Preset templates (`../../examples/`): `embedded-c`, `legacy-java-web`, `mixed-repo`, `all-utf8` (e.g. `/charset-init embedded-c --dry-run`).
2. Keep `"unmappable": "error"`, `"verifyWrite": true`, and `"protectUtf8": true` unless the project toolchain explicitly requires otherwise.
3. Single-byte encodings (`ISO-8859-1`, `windows-1252`) round-trip any byte sequence and **must** declare `"force": true` in `overrides`.

## 3. Resolving Write Gate Rejections

- **Gate 1 (Unmappable Code Points)**:
  - Disk bytes were not modified.
  - Do **not** blindly switch `unmappable` to `"escape"` on C/C++ or configuration files (`\uXXXX` permanently alters literal text and is not reversed on read).
  - Prefer replacing the unsupported character (e.g. an emoji or CJK Extension B character in a strict `GBK` file) or ask the user whether the toolchain accepts `GB18030` / `UTF-8`.
- **Gate 2 (Post-Write Verification Conflict)**:
  - The on-disk file was preserved without rollback so concurrent external changes are not clobbered.
  - Run `read` to inspect the current disk content before retrying.
- **Gate 3 (`UNKNOWN`, `BINARY`, or Lossy Re-Encoding)**:
  - Never set `"force": true` merely to silence a Gate 3 error.
  - Inspect the file via `node ../../tools/scan-encoding.mjs <path> --damaged` and confirm the intended encoding with the user.
- **Mixed Line Endings (`CRLF` + `LF`)**:
  - `read` succeeds, while `edit` and `write` refuse to normalize the whole file silently. Ask the user before normalizing line endings across the file.
