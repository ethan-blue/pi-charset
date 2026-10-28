# 安装说明

[English](../INSTALL.md) | 简体中文

---

## 1. 环境要求

| 组件 | 要求 |
|---|---|
| Node.js | `>= 22.19.0` |
| Pi | `@earendil-works/pi-coding-agent >= 0.84.0`（已实测 `0.84.3`、`1.2.0` 与 `1.4.0`） |
| 运行时依赖 | `iconv-lite`、`micromatch`（无 Python 依赖） |
| ripgrep | 自动查找 `~/.pi/agent/bin/rg(.exe)`、系统 `PATH` 中的 `rg` 或 `@vscode/ripgrep` |

## 2. 安装与升级

### 方式 A：从 npm 官方源安装（推荐）

```powershell
# 用户级全局安装（写入 ~/.pi/agent/settings.json，所有工程自动生效）
pi install npm:pi-charset

# 项目级安装（写入当前工程 .pi/settings.json）
pi install npm:pi-charset -l

# 日常一键升级已安装扩展至最新版本
pi update --extensions
```

### 方式 B：从 Git 仓库安装

```powershell
# 不锁版本安装（后续可通过 pi update --extensions 跟踪最新提交）
pi install git:github.com/ethan-blue/pi-charset

# 指定版本标签安装
pi install git:github.com/ethan-blue/pi-charset@v0.1.3 -l
```

使用 `git:` 源安装时，Pi 会将仓库克隆至 `.pi/git/github.com/ethan-blue/pi-charset`（或 `~/.pi/agent/git/...`）并自动执行 `npm install`。

### 方式 C：从本地目录安装（离线或内网环境）

`pi install <本地路径>` 仅将绝对路径写入 `settings.json`，不会自动执行 `npm install`。若拷贝的是不含 `node_modules` 的源码目录，需先安装运行时依赖：

```powershell
# 1. 在扩展目录安装生产依赖
cd D:\tools\pi-charset
npm install --omit=dev

# 2. 在目标工程注册本地扩展路径
cd D:\path\to\your-project
pi install D:\tools\pi-charset -l
```

## 3. 可选：脚手架生成 `.pi-charset.json`

扩展安装后默认启用零配置自适应模式（已有文件自动按原编码与行尾读写，新建文件自动根据同目录邻居文件推断编码与行尾），并自动随包加载 `charset-rules` 编码安全规则 Skill 与 `/charset-setup` 引导模板。

若需在版本库中固化显式 `.pi-charset.json` 配置，可直接在 Pi 会话中执行内置脚手架命令：

```text
/charset-init --dry-run
/charset-init
# 或直接套用预设工程模板：
/charset-init embedded-c
```

也可在终端中按不同安装方式找到扩展包目录 `<PKG_DIR>` 手动调用脚本：

| 安装方式 | 扩展包目录 `<PKG_DIR>` |
|---|---|
| Git 项目级（`-l`） | `.pi/git/github.com/ethan-blue/pi-charset` |
| Git 用户级 | `~/.pi/agent/git/github.com/ethan-blue/pi-charset` |
| npm 项目级（`-l`） | `.pi/npm/node_modules/pi-charset` |
| npm 用户级 | `~/.pi/agent/npm/node_modules/pi-charset` |
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

## 4. 安装后验证

1. **状态检查**：在 Pi 会话中输入 `/charset-status`，确认显示 `pi-charset v0.1.3` 及生效的模式或 `.pi-charset.json` 路径。
2. **读写验证**：修改工程内一个 GBK 文件的中文注释，执行 `/charset-scan`（或 `node <PKG_DIR>/tools/scan-encoding.mjs <文件路径>`），确认编码仍为 `cjk/GBK`。
3. **历史受损文件排查（可选）**：
   ```text
   /charset-scan --damaged
   ```
