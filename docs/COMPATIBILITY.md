# Host Compatibility & Verification / 宿主兼容矩阵与验证步骤

**[English](#english) | [简体中文](#简体中文)**

---

## English

### 1. Tested Host Matrix

`package.json` declares `peerDependencies` for `@earendil-works/pi-coding-agent >= 0.84.0`. The table below lists verified host environments:

| Environment | `pi-coding-agent` / `pi-ai` / `pi-tui` / `pi-agent-core` | Typecheck | Full Test Suite (264 tests) | Extension Loader (`discoverAndLoadExtensions`) | CLI Smoke (`pi --mode rpc`) |
|---|---|---|---|---|---|
| Repository Lockfile (`npm ci`) | `0.84.3` | PASS | PASS | PASS | — |
| Local Host Junction | `1.2.0` / `1.2.0` / `1.2.0` / `1.2.0` | PASS | PASS | PASS | PASS |
| Clean Tarball Unpack | `1.4.0` | — | — | PASS | — |

Verified OS environment: Windows 11 (`10.0.26200`), Node.js `v24.11.1`, ripgrep `14.1.1`.

### 2. Cross-Version API Adaptations (`0.84.3` vs `1.2.0`)

| Location | Host Change | Adaptation |
|---|---|---|
| `src/grep.ts` tool `execute` 5th parameter | `ExtensionContext` in `0.84.3` -> `ExtensionToolContext` in `1.2.0` (adds `tools` and `executeTool`) | Derived via `Parameters<typeof builtin.execute>[4]` so both versions typecheck cleanly |
| `test/host-integration.test.ts` | Extension loader verification | Calls `discoverAndLoadExtensions` exported by `@earendil-works/pi-coding-agent` |
| `src/index.ts` command registration | `pi.registerCommand` | Registers `/charset-status`, verified in both host versions |

### 3. Host Junction Verification Workflow (Windows)

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

### 4. Version Consistency Assertions

`test/host-integration.test.ts` enforces two version invariants:
1. The runtime `VERSION` exported by `@earendil-works/pi-coding-agent` must match `node_modules/@earendil-works/pi-coding-agent/package.json`.
2. When `PI_HOST_VERSION` is set in the environment, `VERSION` must equal `process.env.PI_HOST_VERSION`.

---

## 简体中文

### 1. 实测矩阵

`package.json` 中 `peerDependencies` 声明 `@earendil-works/pi-coding-agent >= 0.84.0`。已完成实测的宿主版本如下：

| 测试环境 | `pi-coding-agent` / `pi-ai` / `pi-tui` / `pi-agent-core` | 类型检查 | 全量测试 (264 项) | 扩展加载器 (`discoverAndLoadExtensions`) | CLI 冒烟 (`pi --mode rpc`) |
|---|---|---|---|---|---|
| 仓库锁文件环境 (`npm ci`) | `0.84.3` | PASS | PASS | PASS | — |
| 本机宿主环境 (Junction) | `1.2.0` / `1.2.0` / `1.2.0` / `1.2.0` | PASS | PASS | PASS | PASS |
| 干净目录打包加载 | `1.4.0` | — | — | PASS | — |

实测系统环境：Windows 11 (`10.0.26200`)，Node.js `v24.11.1`，ripgrep `14.1.1`。

### 2. 跨版本接口适配点（`0.84.3` 与 `1.2.0`）

| 位置 | 版本差异 | 处理方式 |
|---|---|---|
| `src/grep.ts` 工具 `execute` 第 5 参数 | `0.84.3` 为 `ExtensionContext`，`1.2.0` 为 `ExtensionToolContext`（新增 `tools` 与 `executeTool`） | 使用 `Parameters<typeof builtin.execute>[4]` 从内置工具定义推导类型 |
| `test/host-integration.test.ts` | 验证真实扩展加载器行为 | 直接调用 `@earendil-works/pi-coding-agent` 导出的 `discoverAndLoadExtensions` 加载 `src/index.ts` |
| `src/index.ts` 命令注册 | `pi.registerCommand` | 注册 `/charset-status`，两版本均通过注册与执行断言 |

### 3. 宿主副本验证流程（Windows）

将仓库复制到临时目录，并将 `node_modules/@earendil-works` 下的四个包通过目录联接（Junction）指向本机全局安装的 Pi，其余依赖沿用仓库锁文件，命令见上方英文小节第 3 节。

### 4. 版本一致性断言

`test/host-integration.test.ts` 包含两项版本核对断言：
1. 运行时导入的 `VERSION` 必须与 `node_modules/@earendil-works/pi-coding-agent/package.json` 中的 `version` 字段一致。
2. 当环境变量 `PI_HOST_VERSION` 存在时，断言 `VERSION === process.env.PI_HOST_VERSION`。
