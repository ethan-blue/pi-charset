# Host Compatibility & Verification

English | [简体中文](./zh-CN/COMPATIBILITY.md)

---

## 1. Tested Host Matrix

`package.json` declares `peerDependencies` for `@earendil-works/pi-coding-agent >= 0.84.0`. The table below lists verified host environments:

| Environment | Host Version | Typecheck | Full Test Suite | Extension Loader (`discoverAndLoadExtensions`) | CLI Smoke (`pi --mode rpc`) |
|---|---|---|---|---|---|
| v0.1.2 lockfile, Windows / Node 24 | `1.4.0` | PASS | 271 passed, 2 POSIX-only tests skipped | PASS | — |
| v0.1.1 lockfile, Windows / Node 24 | `1.4.0` | PASS | 270 passed, 2 POSIX-only tests skipped | PASS | — |
| Historical v0.1.0 lockfile | `0.84.3` | PASS | PASS | PASS | — |
| Local Host Junction | `1.2.0` / `1.2.0` / `1.2.0` / `1.2.0` | PASS | PASS | PASS | PASS |
| Clean Tarball Unpack | `1.4.0` | — | — | PASS | — |

See GitHub Actions for current Windows/Linux and Node 22/24 results.

The root `overrides` entry keeps the checkout's host dependency on a patched `undici`. npm ignores dependency-package overrides when this extension is installed into another application: update and audit your actual Pi installation separately.

## 2. Cross-Version API Adaptations (`0.84.3` – `1.4.0`)

| Location | Host Change | Adaptation |
|---|---|---|
| `src/grep.ts` tool `execute` 5th parameter | `ExtensionContext` in `0.84.3` -> `ExtensionToolContext` in `1.2.0+` (adds `tools` and `executeTool`) | Derived via `Parameters<typeof builtin.execute>[4]` so all versions typecheck cleanly |
| `test/host-integration.test.ts` | Extension loader verification | Calls `discoverAndLoadExtensions` exported by `@earendil-works/pi-coding-agent` |
| `src/index.ts` command registration | `pi.registerCommand` | Registers `/charset-status`, `/charset-init`, and `/charset-scan`, verified across host versions |

## 3. Host Junction Verification Workflow (Windows)

To run the full test suite against a globally installed Pi version without modifying the repository's lockfile:

```powershell
# 1. Locate global npm root and installed Pi version
npm root -g
pi --version

# 2. Copy repository excluding node_modules and .git
robocopy D:\path\to\pi-charset D:\tmp\pi-host-check /E /XD node_modules .git

# 3. Junction non-@earendil-works dependencies from the repository lockfile
node -e "const fs=require('fs'),p=require('path');const src='D:/path/to/pi-charset/node_modules',dst='D:/tmp/pi-host-check/node_modules';fs.mkdirSync(dst,{recursive:true});for(const e of fs.readdirSync(src)){if(e==='@earendil-works')continue;fs.symlinkSync(p.join(src,e),p.join(dst,e),'junction')}"

# 4. Junction @earendil-works packages from the global Pi installation
node -e "const fs=require('fs');const g='<npm-root-g>/@earendil-works/pi-coding-agent',dst='D:/tmp/pi-host-check/node_modules/@earendil-works';fs.mkdirSync(dst,{recursive:true});for(const n of ['pi-coding-agent','pi-ai','pi-tui','pi-agent-core'])fs.symlinkSync(n==='pi-coding-agent'?g:g+'/node_modules/@earendil-works/'+n,dst+'/'+n,'junction')"

# 5. Run typecheck and full test suite (PI_HOST_VERSION asserts the active host version)
cd D:\tmp\pi-host-check
npm run typecheck
$env:PI_HOST_VERSION='1.2.0'; npx vitest run

# 6. CLI RPC smoke check
cd $env:TEMP
pi --mode rpc -e D:/tmp/pi-host-check/src/index.ts --no-mcp --no-session < NUL
```

## 4. Version Consistency Assertions

`test/host-integration.test.ts` enforces two version invariants:
1. The runtime `VERSION` exported by `@earendil-works/pi-coding-agent` must match `node_modules/@earendil-works/pi-coding-agent/package.json`.
2. When `PI_HOST_VERSION` is set in the environment, `VERSION` must equal `process.env.PI_HOST_VERSION`.
