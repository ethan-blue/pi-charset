# Installation Guide / 安装说明

**[English](#english) | [简体中文](#简体中文)**

---

## English

### 1. Prerequisites

| Component | Requirement |
|---|---|
| Node.js | `>= 22.19.0` |
| Pi | `@earendil-works/pi-coding-agent >= 0.84.0` (verified on `0.84.3` and `1.2.0`) |
| Runtime Dependencies | `iconv-lite`, `micromatch` (no Python required) |
| ripgrep | Automatically resolved from `~/.pi/agent/bin/rg(.exe)`, `rg` on `PATH`, or `@vscode/ripgrep` |

### 2. Installation Methods

#### Option A: Install from Git (Recommended)

```powershell
# Project-level install (writes to <project>/.pi/settings.json)
cd D:\path\to\your-project
pi install git:github.com/ethan-blue/pi-charset -l

# Global user-level install (writes to ~/.pi/agent/settings.json)
pi install git:github.com/ethan-blue/pi-charset

# Pin a specific release tag
pi install git:github.com/ethan-blue/pi-charset@v0.1.0 -l
```

When installing from a `git:` source, Pi clones the repository under `.pi/git/github.com/ethan-blue/pi-charset` (or `~/.pi/agent/git/...`) and runs `npm install` automatically.

#### Option B: Install from a Local Directory (Offline / Intranet)

`pi install <local-path>` records the absolute path in `settings.json` without running `npm install`. When copying a source tree without `node_modules`, install production dependencies first:

```powershell
# 1. Install production dependencies inside the extension directory
cd D:\tools\pi-charset
npm install --omit=dev

# 2. Register the local extension path in your project
cd D:\path\to\your-project
pi install D:\tools\pi-charset -l
```

### 3. Optional: Initialize `.pi-charset.json`

`pi-charset` works out-of-the-box in zero-config self-adaptive mode (automatically preserving existing file encodings and line endings, and inferring new-file encodings from same-directory siblings). If you want an explicit `.pi-charset.json` committed to your repository, locate `scan-encoding.mjs` inside `<PKG_DIR>`:

| Install Method | Package Directory `<PKG_DIR>` |
|---|---|
| Git project-level (`-l`) | `.pi/git/github.com/ethan-blue/pi-charset` |
| Git user-level | `~/.pi/agent/git/github.com/ethan-blue/pi-charset` |
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

### 4. Post-Install Verification

1. Run `/charset-status` in Pi to confirm `pi-charset v0.1.0` and the active `.pi-charset.json` path.
2. Edit a Chinese comment in a GBK file, then run `node <PKG_DIR>/tools/scan-encoding.mjs <file>` and verify the file remains `cjk/GBK`.
3. Optionally scan for pre-existing damaged files (`U+FFFD` or `锟斤拷`):
   ```powershell
   node <PKG_DIR>/tools/scan-encoding.mjs . --damaged
   ```

---

## 简体中文

### 1. 环境要求

| 组件 | 要求 |
|---|---|
| Node.js | `>= 22.19.0` |
| Pi | `@earendil-works/pi-coding-agent >= 0.84.0`（已实测 `0.84.3` 与 `1.2.0`） |
| 运行时依赖 | `iconv-lite`、`micromatch`（无 Python 依赖） |
| ripgrep | 自动查找 `~/.pi/agent/bin/rg(.exe)`、系统 `PATH` 中的 `rg` 或 `@vscode/ripgrep` |

### 2. 安装方式

#### 方式 A：从 Git 仓库安装（推荐）

```powershell
# 项目级安装（写入当前工程 .pi/settings.json）
cd D:\path\to\your-project
pi install git:github.com/ethan-blue/pi-charset -l

# 用户级全局安装（写入 ~/.pi/agent/settings.json）
pi install git:github.com/ethan-blue/pi-charset

# 指定版本 tag 安装
pi install git:github.com/ethan-blue/pi-charset@v0.1.0 -l
```

使用 `git:` 源安装时，Pi 会将仓库克隆至 `.pi/git/github.com/ethan-blue/pi-charset`（或 `~/.pi/agent/git/...`）并自动执行 `npm install`。

#### 方式 B：从本地目录安装（离线或内网环境）

`pi install <本地路径>` 仅将绝对路径写入 `settings.json`，不会自动执行 `npm install`。若拷贝的是不含 `node_modules` 的源码目录，需先安装运行时依赖：

```powershell
# 1. 在扩展目录安装生产依赖
cd D:\tools\pi-charset
npm install --omit=dev

# 2. 在目标工程注册本地扩展路径
cd D:\path\to\your-project
pi install D:\tools\pi-charset -l
```

### 3. 可选：生成项目配置文件 `.pi-charset.json`

扩展安装后默认启用零配置自适应模式（已有文件自动按原编码与行尾读写，新建文件自动根据同目录邻居文件推断编码与行尾）。若需在版本库中固化显式 `.pi-charset.json` 配置，可按不同安装方式找到扩展包目录 `<PKG_DIR>`：

| 安装方式 | 扩展包目录 `<PKG_DIR>` |
|---|---|
| Git 项目级（`-l`） | `.pi/git/github.com/ethan-blue/pi-charset` |
| Git 用户级 | `~/.pi/agent/git/github.com/ethan-blue/pi-charset` |
| 本地目录安装 | 实际本地目录（如 `D:\tools\pi-charset`） |

在目标工程根目录执行：

```powershell
cd D:\path\to\your-project

# 预览生成的配置内容（不写盘）
node <PKG_DIR>/tools/scan-encoding.mjs . --init --dry-run

# 生成 .pi-charset.json
node <PKG_DIR>/tools/scan-encoding.mjs . --init
```

配置完成后重启 Pi。

### 4. 安装后验证

1. **状态检查**：在 Pi 会话中输入 `/charset-status`，确认显示 `pi-charset v0.1.0` 及生效的 `.pi-charset.json` 路径。
2. **读写验证**：修改工程内一个 GBK 文件的中文注释，执行 `node <PKG_DIR>/tools/scan-encoding.mjs <文件路径>`，确认编码仍为 `cjk/GBK`。
3. **历史受损文件排查（可选）**：
   ```powershell
   node <PKG_DIR>/tools/scan-encoding.mjs . --damaged
   ```
