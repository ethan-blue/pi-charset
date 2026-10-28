# Configuration Guide (`.pi-charset.json`)

English | [简体中文](./zh-CN/CONFIG-GUIDE.md)

---

## 1. Quick Initialization & Scaffolding

Inside a Pi session, scaffold `.pi-charset.json` directly without looking up package paths (updates take effect immediately without restarting Pi):

```text
/charset-scan                        # Read-only encoding & line-ending profile
/charset-scan --damaged              # Inspect files containing U+FFFD or mojibake
/charset-init --dry-run              # Preview auto-inferred rules without writing disk
/charset-init                        # Generate .pi-charset.json from project declarations & bytes
/charset-init embedded-c             # Or scaffold from preset: embedded-c | legacy-java-web | mixed-repo | all-utf8
/charset-setup                       # Guided prompt template: audit + preview before writing
```

Or run the standalone scanner from a terminal:

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

## 2. Zero-Config Self-Adaptive Behavior (Default)

When no `.pi-charset.json` is present up the directory tree, `pi-charset` operates in **zero-config self-adaptive mode**:
- **Existing Files**: `read`, `write`, and `edit` classify each file by its bytes. Existing `GBK`, `GB18030`, `Big5`, `UTF-16`, and `UTF-8` files are decoded to UTF-8 on read and written back in their original encoding, line-ending style (`CRLF` or `LF`), and BOM, with all three write safety gates active.
- **New & Pure-ASCII Files**: `pi-charset` scans up to 16 sibling files in the same directory (prioritizing the same file extension group such as `.c`/`.h`) and inherits the dominant encoding and line ending (defaulting to `UTF-8` if no CJK siblings exist).
- **Multi-Encoding `grep`**: Regex patterns and non-ASCII literals run across `UTF-8` and `GB18030` passes and deduplicate matches by `file:line`. ASCII-only regexes also need these passes: for example, `\p{Han}` matches Chinese characters despite containing only ASCII syntax.
- `.pi-charset.json` is only needed when you want to override defaults (e.g., strict GBK enforcement for new/ASCII files, single-byte `ISO-8859-1` with `force: true`, explicit encoding migration, or enabling `transcodeBash`).

## 3. Configuration Reference

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

### Choosing an Unmappable-Character Policy

Keep `error` for source files unless the project explicitly requires another policy. `escape` changes file contents permanently: an unsupported character becomes literal `\uXXXX` text (a surrogate pair for supplementary characters). Reads do not reverse these escapes. Whether the result has the intended meaning depends on the language and the exact string, comment, or identifier context; it is not a general-purpose repair for C, Java, JSON, or configuration files.

`drop-to-gb18030` changes the output encoding for GB-family writes. Use it only if the compiler, editor, and downstream tools accept GB18030; it is not a way to keep a strict GBK requirement.

Keep `verifyWrite: true` for normal use. Verification adds an in-memory conversion and a full disk read after writing, so large or frequently rewritten files incur additional I/O. Disabling it trades away verification, not just logging.

### 3.1 `overrides` Matching & Specificity

- Bare patterns without `/` (e.g., `*.properties`) match basenames at any depth (`matchBase: true`); patterns containing `/` (e.g., `src/**/*.c`) match relative to the directory containing `.pi-charset.json`.
- When multiple rules match a file, the rule with the highest segment specificity wins: literal segment `+10`, wildcard segment `+5`, `*` `+2`, `**` `+1`. Ties break by array order.
- If an override specifies `encoding` without `writeEncoding` and the root config has no migration intent (`writeEncoding == sourceEncoding`), new and pure-ASCII files in that override scope default to `override.encoding`.
- Single-byte encodings (`ISO-8859-1`, `windows-1252`) round-trip arbitrary bytes and require `"force": true` in the override rule.

### 3.2 Write Target Resolution Matrix

| On-Disk File State | No Transcode Intent (`writeEncoding == readEncoding`) | Explicit Transcode Intent (`writeEncoding != readEncoding`) |
|---|---|---|
| New file | Scope read encoding (`override.encoding` > root) | `writeEncoding` |
| Pure ASCII file | Scope read encoding | `writeEncoding` |
| UTF-8 / UTF-8 BOM | Keep UTF-8 (and existing BOM) | Keep UTF-8 when `protectUtf8: true`; convert to `writeEncoding` only when `force: true` or `protectUtf8: false` |
| Multi-byte CJK (`GBK`, `GB18030`, `Big5`, etc.) | Keep the file's classified encoding | Write as `writeEncoding` (rejected by Gate 3 if existing bytes cannot round-trip in `writeEncoding`) |
| UTF-16LE / UTF-16BE | Keep original UTF-16 with BOM | Convert to `writeEncoding` only when `force: true` |
| `force: true` or single-byte rule | Write as rule `encoding` | Write as `writeEncoding` |

## 4. Configuration Recipes

See ready-to-copy templates in [`examples/`](../examples):

### 4.1 Embedded C Project (GBK + CRLF Sources, UTF-8 Docs)

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

### 4.2 Legacy Java Web Project (GBK Primary + UTF-8 Subtrees + ISO-8859-1 Properties)

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

## 5. Gate Error Reference

- **Gate 1 (Unmappable Characters)**: The file on disk is untouched. Either change `writeEncoding` to `"GB18030"` / `"UTF-8"`, set `unmappable` to `"escape"` or `"drop-to-gb18030"`, or replace the unmappable character.
- **Gate 2 (Post-Write Verification Mismatch)**: The on-disk file is preserved as-is without rolling back to avoid clobbering concurrent external edits. Read the file again to inspect the current disk state before retrying.
- **Gate 3 (Unknown or Lossy Conversion Blocked)**: Check the file's actual encoding and keep a version-controlled copy before changing rules. Choose a compatible target encoding if appropriate. `force: true` overrides detection; it does not repair damaged bytes or waive round-trip checks. Do not use it merely to silence an error.
