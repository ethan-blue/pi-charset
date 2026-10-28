# pi-charset

[![CI](https://github.com/ethan-blue/pi-charset/actions/workflows/ci.yml/badge.svg)](https://github.com/ethan-blue/pi-charset/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-charset.svg)](https://www.npmjs.com/package/pi-charset)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)

适用于 [Pi](https://github.com/earendil-works)（`@earendil-works/pi-coding-agent`）的文件编码与行尾处理扩展，在工具 I/O 层接管 `read`、`write`、`edit` 与 `grep`。

[English](./README.md) | 简体中文

---

## 简介

`pi-charset` 在 Pi 的工具 I/O 层接管 `read`、`write`、`edit` 与 `grep`，用于支持同一工程内混合存在 `GBK`、`GB18030`、`Big5`、`Shift_JIS`、`EUC-KR`、`ISO-8859-1`、`UTF-16` 与 `UTF-8` 文件的按文件读写与多编码搜索。全链路在进程内基于字节特征判定，不调用 Python 或外部探测子进程。

## GBK 工程使用建议

已有 GBK 工程，建议先在 Pi 中运行 `/charset-init --dry-run`（或嵌入式 C 工程运行 `/charset-init embedded-c --dry-run`），确认建议的目录规则后再生成 `.pi-charset.json`。保留 `unmappable: "error"` 和 `verifyWrite: true`：GBK 放不下的字符应该报错，而不是静默变成问号。

修改源码时使用 Pi 的 `read`、`edit`、`write` 工具。Shell 重定向和外部格式化工具不经过本扩展。安装后先用 `/charset-status` 查看状态，试改一个已纳入版本管理的小文件，再用常用编辑器核对差异。

字节判定不能证明文件的原始编码。GBK 与 GB18030 存在重叠，同一串字节也可能符合其他编码；工程明确要求 GBK 时，应显式配置 GBK，尤其是新建文件和纯 ASCII 文件。本扩展用于防止新增乱码，不能恢复已经保存为问号或错误文本的原始内容。

## 工作机制

### 1. 字节判定顺序

按以下固定顺序在内存中判定文件编码：
1. **BOM 识别**：`UTF-8 BOM`、`UTF-16LE`、`UTF-16BE`（`UTF-32 BOM` 归为 `BINARY`）。
2. **二进制识别**：前 8192 字节内含 `0x00` 判为 `BINARY`。
3. **显式 `force`**：命中带 `force: true` 的规则时直接采用规则指定编码。
4. **纯 ASCII**：通过 Node 原生 `node:buffer` `isAscii` 判定全部字节 `<= 0x7F`。
5. **严格 UTF-8**：通过 Node 原生 `node:buffer` `isUtf8` 整文件零分配校验判为 `UTF-8`。
6. **多字节候选回环**：按 `autoCandidates` 顺序检查 `encode(decode(bytes)) == bytes` 且无 `U+FFFD`；多候选同时通过时优先采用 `sourceEncoding`。
7. **兜底**：未通过上述步骤的字节流判为 `UNKNOWN`。

### 2. 三道写入门禁

- **闸门 1（字符可映射检查）**：写入前逐码点检查目标编码表示能力。默认策略 `error` 直接拒写并列出字符及 `U+XXXX` 码点；可选 `escape`（转为 `\uXXXX`）与 `drop-to-gb18030`（GB 族自动升为 `GB18030`）。
- **闸门 2（写前往返与写后回读校验）**：落盘前在内存验证 `decode(encode(text)) === text`；落盘后回读磁盘文件核对字节与解码文本。若写后核对不一致，报错并保留磁盘现状，不执行旧备份回滚。
- **闸门 3（未知编码与有损写入拦截）**：拦截 `BINARY` 与 `UNKNOWN` 文件写入；含非 ASCII 的 UTF-8 文件默认保持 UTF-8 写回（`protectUtf8: true`）；磁盘原字节无法在目标编码下逐字节无损回环时拒绝写入。

### 3. 行尾与读取基线校验

- **行尾保持**：已存在文件按磁盘原有行尾（`CRLF` 或 `LF`，UTF-16 按解码后字符级识别）写回；无换行文件不追加尾部换行。
- **混合换行拦截**：同时含 `CRLF` 与 `LF` 的文件允许 `read` 读取，拒绝 `edit` 与 `write` 修改。
- **新建文件行尾**：支持通过 `newFileLineEnding: "CRLF" | "LF"` 指定新建文件的行尾格式。
- **读取基线冲突检测**：读取文件时记录 SHA-1 指纹；写入前若磁盘内容被外部修改或删除，报冲突并拒绝覆盖。

### 4. 零配置自适应与同目录邻居推断

`pi-charset` 安装后无需编写 `.pi-charset.json` 即可直接工作：
- **已存在文件**：读取时按文件自身字节判定出的编码（`GBK`、`GB18030`、`Big5`、`UTF-16`、`UTF-8`）解码；写入时自动保持原文件编码、原有行尾（`CRLF` 或 `LF`）与 BOM。
- **新建文件与纯 ASCII 文件加中文**：未放置 `.pi-charset.json` 时，自动扫描同目录下的相邻源码文件（优先匹配同语言后缀族，如 `.c`/`.h`），继承该目录的主流编码与行尾格式（同目录为 UTF-8 或空目录时默认 `UTF-8`）。
- **多编码搜索（`grep`）**：正则搜索或非 ASCII 字面量搜索时，零配置下执行 `UTF-8 + GB18030` 双趟 `ripgrep` 搜索（有 `.pi-charset.json` 时按配置候选编码集合分趟），经逐文件字节判定复核后按 `file:line` 去重。

## 快速开始

### 1. 安装与升级

```bash
# 从 npm 全局安装（推荐；加 -l 则仅写入当前工程 .pi/settings.json）
pi install npm:pi-charset

# 日常一键升级至最新发布版
pi update --extensions

# 或从 Git 仓库安装
pi install git:github.com/ethan-blue/pi-charset -l
```

### 2. 脚手架生成或手动编写 `.pi-charset.json`

在 Pi 会话中可直接通过内置脚手架命令扫描或生成 `.pi-charset.json`（无需查找扩展安装路径，落盘后立即刷新当前会话缓存）：

```text
/charset-scan                        # 只读扫描当前工程的编码与行尾分布
/charset-scan --damaged              # 排查历史遗留的 U+FFFD / 锟斤拷 受损文件
/charset-init --dry-run              # 预览自动推断的配置（不写盘）
/charset-init                        # 根据工程声明与字节特征生成 .pi-charset.json
/charset-init embedded-c             # 或直接套用预设模板：embedded-c | legacy-java-web | mixed-repo | all-utf8
/charset-setup                       # 引导式提示模板：扫描审计 + 预览配置
```

也可在命令行中直接调用独立扫描脚本：

```bash
node tools/scan-encoding.mjs /path/to/project --init --dry-run
node tools/scan-encoding.mjs /path/to/project --init
```

或在项目根目录手动创建 `.pi-charset.json`（支持 `//` 与 `/* */` 注释）：

```jsonc
{
  "sourceEncoding": "UTF-8",
  "writeEncoding": "UTF-8",
  "unmappable": "error",
  "verifyWrite": true,
  "protectUtf8": true,
  "readStrategy": "auto",
  "autoCandidates": ["GB18030", "GBK", "GB2312", "Big5"],
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

### 3. 状态诊断

在 Pi 会话中执行：

```text
/charset-status
```

## 作用边界

| 入口 | 是否处理 | 说明 |
|---|---|---|
| `read`、`write`、`edit`、`grep` 工具 | 是 | 默认启用零配置自适应模式；可通过可选的 `.pi-charset.json` 自定义规则 |
| `bash`、`powershell` 标准输出与错误流 | 可选 | 默认关闭；设置 `transcodeBash: "auto"` 后将非 UTF-8 输出转为 UTF-8 |
| Shell 重定向写文件（如 `echo >`、`Set-Content`） | 否 | 不经过文件工具层，请使用 `write` 或 `edit` 工具写文件 |
| 启动命令行 `@file` 参数 | 否 | 在扩展加载前由宿主直接读取 |

原子替换用于避免文件只写了一半，不等于跨进程事务或文件锁。请避免与外部工具同时修改同一文件。符号链接拒绝写入，请直接修改目标文件。替换时保留已有权限模式，但不保证保留所有者、ACL、扩展属性、硬链接关系，也不保证掉电后的持久性。

## 文档索引

- [安装说明](./docs/zh-CN/INSTALL.md)
- [配置指南](./docs/zh-CN/CONFIG-GUIDE.md)
- [宿主兼容矩阵](./docs/zh-CN/COMPATIBILITY.md)
- [验收与测试矩阵](./docs/zh-CN/ACCEPTANCE.md)
- [发布规范](./docs/zh-CN/RELEASING.md)
- [参与贡献](./CONTRIBUTING.zh-CN.md)
- [版本变更日志](./CHANGELOG.zh-CN.md)
- [配置示例](./examples)

## 本地开发

```bash
npm run typecheck       # TypeScript 类型检查 (tsc --noEmit)
npm test                # 运行 Vitest 测试套件
npm run check:release   # 校验版本一致性、变更日志、文档链接与打包清单
npm run verify          # 依次运行 typecheck + test + check:release
```

## 许可证

[MIT](./LICENSE) © 2026 ethan-blue
