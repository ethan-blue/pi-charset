---
description: Audit workspace file encodings and preview a .pi-charset.json configuration
argument-hint: "[target-dir]"
---
Inspect the file-encoding and line-ending profile of `${1:-.}` before making any configuration changes:

1. Run the bundled read-only scanner (`tools/scan-encoding.mjs`) against `${1:-.}` and check for `UNKNOWN` files or pre-existing `U+FFFD` / mojibake damage (`--damaged`).
2. Run `--init --dry-run` against `${1:-.}` to preview the recommended `.pi-charset.json` rules without writing to disk.
3. Summarize the detected encodings, line-ending styles (`CRLF` vs `LF`), any damaged or `UNKNOWN` files, and the proposed `.pi-charset.json` configuration, then wait for confirmation before writing `.pi-charset.json`.
