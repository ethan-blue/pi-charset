# 宿主兼容矩阵与验证步骤

[English](../COMPATIBILITY.md) | 简体中文

---

## 1. 实测矩阵

`package.json` 中 `peerDependencies` 声明 `@earendil-works/pi-coding-agent >= 0.84.0`。已完成实测的宿主版本如下：

| 测试环境 | 宿主版本 | 类型检查 | 全量测试 | 扩展加载器 (`discoverAndLoadExtensions`) | CLI 冒烟 (`pi --mode rpc`) |
|---|---|---|---|---|---|
| v0.1.2 锁文件，Windows / Node 24 | `1.4.0` | PASS | 271 项通过，2 项 POSIX 测试跳过 | PASS | — |
| v0.1.1 锁文件，Windows / Node 24 | `1.4.0` | PASS | 270 项通过，2 项 POSIX 测试跳过 | PASS | — |
| v0.1.0 历史锁文件 | `0.84.3` | PASS | PASS | PASS | — |
| 本机宿主环境 (Junction) | `1.2.0` / `1.2.0` / `1.2.0` / `1.2.0` | PASS | PASS | PASS | PASS |
| 干净目录打包加载 | `1.4.0` | — | — | PASS | — |

Windows/Linux、Node 22/24 的持续集成验证结果请查看 GitHub Actions。

根项目中的 `overrides` 用于将本仓库测试环境的 `undici` 更新到已修复版本。扩展安装进其他应用时，npm 不会采用依赖包内的 `overrides`；实际运行 Pi 的环境仍需单独升级和审计。

## 2. 跨版本接口适配点（`0.84.3` – `1.4.0`）

| 位置 | 版本差异 | 处理方式 |
|---|---|---|
| `src/grep.ts` 工具 `execute` 第 5 参数 | `0.84.3` 为 `ExtensionContext`，`1.2.0+` 为 `ExtensionToolContext`（新增 `tools` 与 `executeTool`） | 使用 `Parameters<typeof builtin.execute>[4]` 从内置工具定义推导类型 |
| `test/host-integration.test.ts` | 验证真实扩展加载器行为 | 直接调用 `@earendil-works/pi-coding-agent` 导出的 `discoverAndLoadExtensions` 加载 `src/index.ts` |
| `src/index.ts` 命令注册 | `pi.registerCommand` | 注册 `/charset-status`、`/charset-init` 与 `/charset-scan`，跨宿主版本均通过注册与执行断言 |

## 3. 宿主副本验证流程（Windows）

在不改动仓库锁文件的前提下，对照本机全局安装的 Pi 宿主版本执行完整验证：

```powershell
# 1. 查看全局 npm 根目录与本机安装的 Pi 版本
npm root -g
pi --version

# 2. 复制仓库（排除 node_modules 与 .git）
robocopy D:\path\to\pi-charset D:\tmp\pi-host-check /E /XD node_modules .git

# 3. 将非 @earendil-works 依赖通过目录联接指向仓库 node_modules
node -e "const fs=require('fs'),p=require('path');const src='D:/path/to/pi-charset/node_modules',dst='D:/tmp/pi-host-check/node_modules';fs.mkdirSync(dst,{recursive:true});for(const e of fs.readdirSync(src)){if(e==='@earendil-works')continue;fs.symlinkSync(p.join(src,e),p.join(dst,e),'junction')}"

# 4. 将 @earendil-works 四个宿主包通过目录联接指向全局 Pi 安装目录
node -e "const fs=require('fs');const g='<npm-root-g>/@earendil-works/pi-coding-agent',dst='D:/tmp/pi-host-check/node_modules/@earendil-works';fs.mkdirSync(dst,{recursive:true});for(const n of ['pi-coding-agent','pi-ai','pi-tui','pi-agent-core'])fs.symlinkSync(n==='pi-coding-agent'?g:g+'/node_modules/@earendil-works/'+n,dst+'/'+n,'junction')"

# 5. 运行类型检查与全量测试（PI_HOST_VERSION 强制核对当前生效宿主版本）
cd D:\tmp\pi-host-check
npm run typecheck
$env:PI_HOST_VERSION='1.2.0'; npx vitest run

# 6. CLI RPC 模式启动冒烟测试
cd $env:TEMP
pi --mode rpc -e D:/tmp/pi-host-check/src/index.ts --no-mcp --no-session < NUL
```

## 4. 版本一致性断言

`test/host-integration.test.ts` 包含两项版本核对断言：
1. 运行时导入的 `VERSION` 必须与 `node_modules/@earendil-works/pi-coding-agent/package.json` 中的 `version` 字段一致。
2. 当环境变量 `PI_HOST_VERSION` 存在时，断言 `VERSION === process.env.PI_HOST_VERSION`。
