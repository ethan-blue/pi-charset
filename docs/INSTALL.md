# Installation Guide

English | [简体中文](./zh-CN/INSTALL.md)

---

## 1. Prerequisites

| Component | Requirement |
|---|---|
| Node.js | `>= 22.19.0` |
| Pi | `@earendil-works/pi-coding-agent >= 0.84.0` (verified on `0.84.3`, `1.2.0`, and `1.4.0`) |
| Runtime Dependencies | `iconv-lite`, `micromatch` (no Python required) |
| ripgrep | Automatically resolved from `~/.pi/agent/bin/rg(.exe)`, `rg` on `PATH`, or `@vscode/ripgrep` |

## 2. Installation & Updates

### Option A: Install from npm (Recommended)

```powershell
# Global user-level install (writes to ~/.pi/agent/settings.json)
pi install npm:pi-charset

# Project-level install (writes to <project>/.pi/settings.json)
pi install npm:pi-charset -l

# Upgrade installed packages to the latest release at any time
pi update --extensions
```

### Option B: Install from Git

```powershell
# Unpinned Git install (tracks main via pi update --extensions)
pi install git:github.com/ethan-blue/pi-charset

# Pin a specific release tag
pi install git:github.com/ethan-blue/pi-charset@v0.1.3 -l
```

When installing from a `git:` source, Pi clones the repository under `.pi/git/github.com/ethan-blue/pi-charset` (or `~/.pi/agent/git/...`) and runs `npm install` automatically.

### Option C: Install from a Local Directory (Offline / Intranet)

`pi install <local-path>` records the absolute path in `settings.json` without running `npm install`. When copying a source tree without `node_modules`, install production dependencies first:

```powershell
# 1. Install production dependencies inside the extension directory
cd D:\tools\pi-charset
npm install --omit=dev

# 2. Register the local extension path in your project
cd D:\path\to\your-project
pi install D:\tools\pi-charset -l
```

## 3. Optional: Scaffold `.pi-charset.json`

`pi-charset` works out-of-the-box in zero-config self-adaptive mode (automatically preserving existing file encodings and line endings, and inferring new-file encodings from same-directory siblings), and bundles the `charset-rules` skill and `/charset-setup` prompt template automatically.

To commit an explicit `.pi-charset.json` in your repository, run the built-in scaffolding commands directly inside Pi:

```text
/charset-init --dry-run
/charset-init
# or apply a preset template directly:
/charset-init embedded-c
```

You can also run `scan-encoding.mjs` from the command line inside `<PKG_DIR>`:

| Install Method | Package Directory `<PKG_DIR>` |
|---|---|
| Git project-level (`-l`) | `.pi/git/github.com/ethan-blue/pi-charset` |
| Git user-level | `~/.pi/agent/git/github.com/ethan-blue/pi-charset` |
| npm project-level (`-l`) | `.pi/npm/node_modules/pi-charset` |
| npm user-level | `~/.pi/agent/npm/node_modules/pi-charset` |
| Local directory | Your local directory path (e.g., `D:\tools\pi-charset`) |

Run `--init` in your target project root:

```powershell
cd D:\path\to\your-project

# Preview the recommended configuration without writing to disk
node <PKG_DIR>/tools/scan-encoding.mjs . --init --dry-run

# Write .pi-charset.json
node <PKG_DIR>/tools/scan-encoding.mjs . --init
```

Restart Pi after creating `.pi-charset.json`.

## 4. Post-Install Verification

1. Run `/charset-status` in Pi to confirm `pi-charset v0.1.3` and the active mode or `.pi-charset.json` path.
2. Edit a Chinese comment in a GBK file, then run `/charset-scan` (or `node <PKG_DIR>/tools/scan-encoding.mjs <file>`) and verify the file remains `cjk/GBK`.
3. Optionally scan for pre-existing damaged files (`U+FFFD` or `锟斤拷`):
   ```text
   /charset-scan --damaged
   ```
