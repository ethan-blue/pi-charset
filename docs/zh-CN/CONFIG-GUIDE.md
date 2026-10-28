# 配置指南（`.pi-charset.json`）

[English](../CONFIG-GUIDE.md) | 简体中文

---

## 1. 快速生成配置与脚手架

在 Pi 会话内可直接通过脚手架命令扫描或初始化 `.pi-charset.json`（无需查找扩展包路径，写盘后自动刷新当前会话缓存）：

```text
/charset-scan                        # 只读扫描目录编码与行尾分布
/charset-scan --damaged              # 排查含 U+FFFD 或「锟斤拷」的历史受损文件
/charset-init --dry-run              # 预览自动推断规则（不写盘）
/charset-init                        # 根据工程声明与字节分布生成 .pi-charset.json
/charset-init embedded-c             # 或套用预设模板：embedded-c | legacy-java-web | mixed-repo | all-utf8
/charset-setup                       # 引导式提示模板：只读审计 + 预览确认
```

也可在终端中直接运行独立扫描脚本：

```bash
# 1. 扫描目录编码分布（只读，不修改任何文件）
node tools/scan-encoding.mjs D:/path/to/project
node tools/scan-encoding.mjs D:/path/to/project --out report.csv

# 2. 根据工程声明与字节分布生成 .pi-charset.json
node tools/scan-encoding.mjs D:/path/to/project --init --dry-run
node tools/scan-encoding.mjs D:/path/to/project --init
```

`--init` 按以下优先级确定根编码与 `overrides`：
1. **工程声明优先**：读取 Eclipse `.settings/org.eclipse.core.resources.prefs`、IDEA `.idea/encodings.xml`、Maven `pom.xml`、Gradle `build.gradle`、`.editorconfig` 与 `.gitattributes`。若某路径声明与该路径下超过 50% 的非 ASCII 文件实际字节冲突，跳过该声明并在配置文件头部注释中列出。
2. **字节唯一候选**：无工程声明时，统计仅能通过单一候选编码无损回环的文件数。
3. **最窄覆盖编码**：当非 UTF-8 文件均在多候选间歧义时，按 `GBK -> Big5 -> Shift_JIS -> EUC-KR -> EUC-JP -> GB18030` 顺序选取能覆盖全部已观测文件的最窄编码。
4. **防覆盖保护**：若目标目录已存在 `.pi-charset.json`，默认以退出码 `1` 退出；传入 `--force` 才执行覆盖。

## 2. 零配置自适应模式（默认行为）

当工作目录向上查找不到 `.pi-charset.json` 时，扩展默认运行在**零配置自适应模式**：
- **已存在文件**：`read`、`write`、`edit` 直接根据文件自身字节判定编码。`GBK`、`GB18030`、`Big5`、`UTF-16` 与 `UTF-8` 文件在读取时自动解码为 UTF-8，在写入时自动保持原文件编码、原行尾（`CRLF` 或 `LF`）与 BOM，并默认启用全部三道写入门禁。
- **新建文件与纯 ASCII 文件**：自动扫描同目录下最多 16 个相邻文件（优先匹配同语言后缀族，如 `.c`/`.h`），继承同目录的主流编码与行尾格式（同目录无传统编码文件时默认 `UTF-8`）。
- **多编码搜索（`grep`）**：正则搜索或非 ASCII 字面量搜索执行 `UTF-8 + GB18030` 双趟搜索并按 `file:line` 去重。纯 ASCII 正则也需要分趟，例如 `\p{Han}` 虽然模式只含 ASCII，匹配的却是中文。
- 仅在需要对新建/纯 ASCII 文件严格固定编码、指定单字节编码（`ISO-8859-1` + `force: true`）、跨编码迁移或开启 `transcodeBash` 时，才需要创建 `.pi-charset.json`。

## 3. 配置字段参考

| 字段 | 默认值 | 说明 |
|---|---|---|
| `sourceEncoding` | `"GB18030"` | 读侧多候选歧义时的优先编码，同时作为纯 ASCII 文件与新建文件的默认编码 |
| `writeEncoding` | 同 `sourceEncoding` | 写目标编码。仅当 `writeEncoding` 与当前作用域读编码不同时，才对已存在文件执行转码 |
| `unmappable` | `"error"` | 闸门 1 策略：`error`（拒写并列出字符与码点）、`escape`（转为 `\uXXXX`）、`drop-to-gb18030`（GB 族自动升为 GB18030） |
| `verifyWrite` | `true` | 闸门 2 开关：写前内存编解码往返校验 + 写后磁盘回读核对 |
| `protectUtf8` | `true` | 含非 ASCII 字节的合法 UTF-8 文件保持 UTF-8 写回，不转为 GB 系编码 |
| `readStrategy` | `"auto"` | `auto` 按字节判定解码；`config` 跳过字节判定，直接按 `sourceEncoding` 解码显示 |
| `autoCandidates` | `["GB18030","GBK","GB2312","Big5","Shift_JIS","EUC-KR","EUC-JP"]` | 多字节自动判定候选链，按数组顺序定优先级。不接受单字节编码与状态转义编码 |
| `newFileLineEnding` | 未设置 | 新建文件的行尾格式，可选 `"CRLF"` 或 `"LF"`；不作用于已存在文件 |
| `transcodeBash` | `false` | Shell 输出流转码：`false` 关闭；`true` 或 `"auto"` 自动判定并转 UTF-8；或指定具体编码名（如 `"GBK"`）。修改后需重启 Pi |
| `bashFileDump` | `true` | 在 `transcodeBash` 开启时生效：`type`、`cat`、`head`、`tail`、`Get-Content` 读取单文件时直接采用该文件的读编码 |
| `overrides` | `[]` | 按路径 glob 覆盖局部规则 |

### 不可映射字符策略选型

源码文件建议保留 `error`。`escape` 会永久改变文件内容：不能表示的字符会变成字面的 `\uXXXX` 文本，补充平面字符使用代理对；后续读取不会自动反转义。语言是否识别这些转义，取决于它位于字符串、注释还是标识符中，不能当作 C、Java、JSON 或配置文件的通用修复方案。

`drop-to-gb18030` 会改变 GB 系文件的输出编码。只有编译器、编辑器及后续工具均接受 GB18030 时才适用；工程必须使用 GBK 时不要启用。

日常使用建议保留 `verifyWrite: true`。校验会增加内存编解码和写后整文件回读，大文件或高频写入会有额外 I/O 成本。关闭它意味着放弃写后校验，而不只是关闭日志。

### 3.1 `overrides` 匹配与特异度规则

- 不含 `/` 的模式（如 `*.properties`）按文件名匹配任意目录层级（`matchBase: true`）；含 `/` 的模式（如 `src/**/*.c`）相对配置文件所在目录匹配。
- 多条规则同时命中同一文件时，按路径段特异度计分取最高者：字面路径段 `+10`，含通配符段 `+5`，单星号 `*` `+2`，双星号 `**` `+1`；同分按数组先后顺序取第一条。
- `override` 规则只写 `encoding` 且根配置无迁移意图（根 `writeEncoding == sourceEncoding`）时，该作用域下的新建文件与纯 ASCII 文件默认按 `override.encoding` 写入。
- 单字节编码（如 `ISO-8859-1`、`windows-1252`）对任意字节流都能回环，必须在 `override` 中显式设置 `"force": true` 才会生效。

### 3.2 写入目标编码决策表

| 磁盘文件状态 | 无转码意图（`writeEncoding == 读编码`） | 有转码意图（`writeEncoding != 读编码`） |
|---|---|---|
| 新建文件 | 作用域读编码（`override.encoding` 优先于根配置） | `writeEncoding` |
| 纯 ASCII 文件 | 作用域读编码 | `writeEncoding` |
| UTF-8 / UTF-8 BOM | 保持 UTF-8（保留原 BOM） | `protectUtf8: true` 时仍保持 UTF-8；显式 `force: true` 或 `protectUtf8: false` 时转为 `writeEncoding` |
| GBK / GB18030 / Big5 等多字节 | 保持文件自身判定出的编码写回 | 按 `writeEncoding` 写；若原文件字节无法在目标编码下无损回环则由闸门 3 拒写 |
| UTF-16LE / UTF-16BE | 保持原 UTF-16 编码并保留 BOM | 仅在 `force: true` 时转为 `writeEncoding` |
| `force: true` 或单字节编码 | 按声明的 `encoding` 写 | 按 `writeEncoding` 写 |

## 4. 常见工程配置示例

完整模板可直接从 [`examples/`](../../examples) 复制：

### 4.1 嵌入式 C 工程（源码 GBK + CRLF，文档 UTF-8）

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

### 4.2 传统 Java Web 工程（GBK 主体 + UTF-8 子目录 + ISO-8859-1 配置）

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

## 5. 门禁报错处理

- **闸门 1（目标编码无法表示字符）**：此时磁盘文件未被修改。可将 `writeEncoding` 改为 `"GB18030"` 或 `"UTF-8"`，或将该规则 `unmappable` 设为 `"escape"` / `"drop-to-gb18030"`，或替换生僻字符后重试。
- **闸门 2（写后回读校验不一致）**：磁盘保留最新现场，不执行旧备份回滚（避免覆盖外部编辑器或格式化工具写入的新内容）。先执行 `read` 查看当前文件内容，确认后再重试。
- **闸门 3（未知编码或有损转码拦截）**：先核对文件真实编码，并保留版本管理中的原文件，再考虑调整为兼容的目标编码。`force: true` 用于覆盖编码判定，不会修复损坏字节，也不会跳过往返校验；不要为了消除报错直接开启它。
