# 版本变更日志

[English](./CHANGELOG.md) | 简体中文

本文件记录项目的重要版本变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.1.4] - 2026-10-28

### 修复

- 带 UTF-8 BOM 的文件改为对 BOM 后的完整字节做严格 UTF-8 校验：BOM 后含非法或截断序列时判为 UNKNOWN 并拒写，不再当作合法 UTF-8。
- 校验 UTF-16 BOM 正文：奇数字节长度与孤立代理项判为 UNKNOWN，不再在读取时按有损解码、写回时丢码元或写入替换字符。
- `force: true` 不再能绕过“文件自身 BOM 与字节矛盾”的拒写；向 UNKNOWN 文件写入含 U+FFFD 的内容时直接拒写，避免把替换字符固化进损坏文件。
- UTF-16 强制转换写出目标端序的 BOM（LE<->BE），不再丢失 BOM。

## [0.1.3] - 2026-10-28

### 调整

- 将 `.github/workflows/release.yml` 切换为无密钥 npm OIDC Trusted Publishing（附带 Sigstore Provenance 溯源签名）并自动标记最新 GitHub Release。
- 更新安装说明与实时版本徽章，将 `pi install npm:pi-charset` 与 `pi update --extensions` 作为首选安装与一键升级路径。

## [0.1.2] - 2026-10-28

### 新增

- 新增会话内 `/charset-init` 与 `/charset-scan` 脚手架命令（`src/scaffold.ts`、`src/index.ts`），支持工程自动扫描生成 `.pi-charset.json`、预设模板套用（`embedded-c`、`legacy-java-web`、`mixed-repo`、`all-utf8`）、`--dry-run` 预览、`--force` 覆盖控制与当前会话缓存即时刷新。
- 在 `package.json` 的 `pi` 清单中随包分发 `charset-rules` 编码安全规则 Skill（`skills/charset-rules/SKILL.md`）与 `/charset-setup` 引导式提示模板（`prompts/charset-setup.md`）。
- 新增发布门禁脚本（`tools/check-release.mjs`）、`npm version` 版本同步钩子（`tools/sync-version.mjs`）、发布说明提取脚本（`tools/extract-changelog.mjs`）、标签触发的 GitHub Release 与可选 npm Provenance 自动发布工作流（`.github/workflows/release.yml`），以及仓内工程规范（`AGENTS.md`、`.editorconfig`、`CONTRIBUTING.zh-CN.md`、`docs/zh-CN/RELEASING.md`）。

### 调整

- 将全部中英文文档拆分为独立互链文件（`README.md` / `README.zh-CN.md`、`CHANGELOG.md` / `CHANGELOG.zh-CN.md`、`CONTRIBUTING.md` / `CONTRIBUTING.zh-CN.md`、`docs/*.md` / `docs/zh-CN/*.md`）。

## [0.1.1] - 2026-10-27

### 修复

- 修复不可映射字符转义时误改合法问号的问题，改用编解码回环判断字符是否可表示。
- 按字符识别 UTF-16 换行，避免将普通字符中的字节误认成行尾。
- 原子替换前检查目标文件写权限，避免在 POSIX 系统上绕过只读保护。
- 非 Windows 平台保留路径大小写，扩展重载时一并清理编码判定缓存。
- 修复 ESM 环境下的可选 ripgrep 加载，在验证命中可信后再去重。
- UTF-8 写入同样执行行尾保护；检测读取后的外部删除，并在每次重命名前复核目标内容。
- 正则匹配交由 ripgrep 处理，修复 `\p{Han}` 等纯 ASCII 模式漏搜传统编码文本的问题。
- 校验 Shell 回退编码，避免不支持的编码名导致流式解码异常。

### 调整

- 单次转换内复用重复字符的编码判定；Windows 重命名重试复用已写好的临时文件，避免重复写盘。
- 原子替换时保留已有文件权限；符号链接拒绝写入，不再直接替换链接本身。
- 补充 GBK 工程使用步骤，说明 `escape` 的永久内容改写及写后校验的 I/O 成本。
- CI 增加 Node 24；严格 I/O 耗时断言改为通过 `STRICT_PERF=1` 启用。
- 更新 Vitest 和依赖锁文件，将本仓库的间接依赖 `undici` 限定到已修复范围；此覆盖规则不会升级另行安装的 Pi 宿主。

## [0.1.0] - 2026-10-27

### 新增

- **确定性字节编码判定**（`src/encoding/classify.ts`）
  - 基于 Node 原生 C++ SIMD（`node:buffer` `isAscii` / `isUtf8`）的纯内存编码判定链：`BOM -> NUL 二进制检查 -> force 规则 -> 纯 ASCII -> 严格 UTF-8 -> CJK 多字节无损回环 -> 配置兜底`。
  - 零配置自适应模式：已有文件自动保持原编码与行尾，新建文件与纯 ASCII 文件自动根据同目录邻居文件推断编码与行尾。
  - 基于 `(path, mtimeMs, size, configKey)` 的文件级判定缓存。

- **写入门禁与冲突检测**（`src/operations.ts`、`src/resolve.ts`）
  - 闸门 1：目标编码不可映射字符检查，支持 `error`、`escape`（`\uXXXX`）与 `drop-to-gb18030` 三种策略。
  - 闸门 2：写前内存编解码往返校验与写后磁盘回读核对；校验不一致时报错并保留磁盘现状，不执行旧备份回滚。
  - 闸门 3：拦截 `BINARY`、`UNKNOWN`、BOM 写入 GB 族编码以及原文件字节无法无损回环的写入。
  - 记录受管文件读取时的 SHA-1 基线指纹，在写入前检测外部进程修改冲突。
  - 路径级串行写锁，配合同目录临时文件 `fsync + rename` 原子替换与 Windows 瞬时文件锁退避重试。

- **行尾处理**（`src/encoding/line-endings.ts`）
  - 保留已存在文件的 `CRLF` 或 `LF` 行尾；混合换行（`CRLF` 与 `LF` 并存）文件允许读取、拒绝写入。
  - 支持通过 `newFileLineEnding: "CRLF" | "LF"` 配置新建文件的行尾格式。

- **多编码搜索与编辑预览**（`src/grep.ts`、`src/edit-preview.ts`）
  - `grep` 按配置编码集合分趟调用 `ripgrep`，经逐文件字节判定过滤乱码伪命中并按 `file:line` 去重。
  - 针对非 UTF-8 受管文件提供编码感知的 `edit` diff 预览，UTF-8 文件直接委托内置渲染器。

- **配置、扫描工具与诊断命令**（`src/config.ts`、`tools/scan-encoding.mjs`、`src/index.ts`）
  - 标准配置文件 `.pi-charset.json`（支持 JSONC 注释）。
  - 独立扫描脚本 `tools/scan-encoding.mjs`，支持目录编码画像、`--damaged` 受损文件检查与 `--init` 配置生成。
  - 注册 `/charset-status` 诊断命令。
