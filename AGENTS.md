# Repository Engineering Rules

## Architecture & Module Boundaries

- `src/encoding/`: Pure byte-level classification (`classify.ts`), codec normalization and unmappable detection (`converter.ts`), character-aware line-ending detection (`line-endings.ts`), image header sniffing (`mime.ts`), and streaming shell output transcoding (`stream-transcode.ts`). No Pi SDK imports belong in `src/encoding/`.
- `src/config.ts` & `src/resolve.ts`: Configuration discovery, validation, zero-config sibling inference, and side-effect-free read/write plan resolution.
- `src/operations.ts`: Read/write/edit I/O execution, Gate 1/2/3 enforcement, SHA-1 read baseline checks, path-serialized write locks, and atomic temp-file replacement.
- `src/grep.ts`, `src/edit-preview.ts`, `src/shell.ts`, `src/scaffold.ts`, `src/index.ts`: Pi host integration (`read`, `write`, `edit`, `grep`, optional `bash`/`powershell`, and `/charset-status`, `/charset-init`, `/charset-scan` commands).
- `skills/charset-rules/` & `prompts/charset-setup.md`: Bundled Pi package skill and prompt template declared under `package.json` `"pi"`.

## Core Invariants

1. **Deterministic In-Process Classification**: Never shell out to Python, `file`, or `chardet`. Classification must remain deterministic and in-memory.
2. **Non-Destructive Failure**: Gate 1, Gate 3, mixed line endings, symlink targets, read-only targets, and stale SHA-1 baselines must fail before mutating the destination file. Gate 2 post-write mismatches must report the conflict and preserve on-disk state without rolling back over concurrent external edits.
3. **No Binary Test Fixtures in Git**: Construct multi-encoding byte buffers in `test/fixtures/build.ts` or inline within `test/*.test.ts`. `test/fixtures/out/` remains gitignored.

## Code & Documentation Conventions

- **Comments**: All comments in `src/`, `tools/`, `test/`, and `examples/` must be concise, factual English explaining invariants, edge cases, or platform behavior.
- **Bilingual Documentation Split**: Keep English and Simplified Chinese in separate files—never mixed in a single Markdown document:
  - Root: `README.md` <-> `README.zh-CN.md`, `CHANGELOG.md` <-> `CHANGELOG.zh-CN.md`, `CONTRIBUTING.md` <-> `CONTRIBUTING.zh-CN.md`.
  - Docs: `docs/*.md` <-> `docs/zh-CN/*.md`.
  - Update both languages together whenever user-visible behavior, commands, or configuration fields change.

## Verification & Release Gate

Run `npm run verify` before committing or tagging a release:
- `npm run typecheck` (`tsc --noEmit`)
- `npm test` (`vitest run`)
- `npm run check:release` (`tools/check-release.mjs`: verifies version parity across `package.json`, `package-lock.json`, `src/version.ts`, `CHANGELOG.md`, and `CHANGELOG.zh-CN.md`; validates `package.json` `pi` manifest resources; checks all relative Markdown links; and audits `npm pack --dry-run` tarball contents).
