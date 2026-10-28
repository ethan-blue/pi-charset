# 验收与测试矩阵

[English](../ACCEPTANCE.md) | 简体中文

---

## 验证命令

```bash
npm run typecheck       # tsc --noEmit (0 错误)
npm test                # vitest run；输出当前通过与跳过计数
npm run check:release   # 核对版本同步、变更日志、Markdown 链接与打包清单
npm run verify          # 依次执行 typecheck + test + check:release
```

下表用于对照预期行为与测试位置，不是当前版本的实时 CI 报告。请运行上方命令验证本次检出代码，并同时查看失败和跳过项：宿主集成测试、平台相关测试受本机环境影响。Windows 测试通过不能证明 POSIX 权限或符号链接行为已实测，性能 smoke 阈值也不代表延迟承诺。

## 1. 端到端验收矩阵（A-01 ~ A-24）

| 编号 | 验收场景 | 状态 | 验证位置 |
|---|---|---|---|
| A-01 | GBK 中文文件读取 | PASS | `test/acceptance.test.ts`（含整树未修改文件 SHA-256 对照） |
| A-02 | `edit` 工具替换 GBK 中文与数值，保持原编码与 `CRLF` | PASS | `test/acceptance.test.ts`、`test/host-integration.test.ts` |
| A-03 | 无 `.pi-charset.json` 目录下的零配置自适应读写与同目录邻居推断 | PASS | `test/zero-config.test.ts`、`test/operations.test.ts` |
| A-04 | UTF-8 BOM 文件编辑后保留单个 BOM | PASS | `test/acceptance.test.ts`、`test/roundtrip.test.ts` |
| A-05 | 纯 ASCII 源文件首次写入中文按 `override` 写为 GBK | PASS | `test/acceptance.test.ts`、`test/roundtrip.test.ts` |
| A-06 | 新建 `.c`/`.h` 按 `newFileLineEnding` 写 `GBK + CRLF`，新建文档写 `UTF-8` | PASS | `test/acceptance.test.ts`、`test/operations.test.ts` |
| A-07 | 无末尾换行文件编辑后不追加换行 | PASS | `test/acceptance.test.ts`、`test/operations.test.ts` |
| A-08 | 混合换行（`CRLF` + `LF`）文件可读，拒绝 `edit` 与 `write` 且磁盘字节不变 | PASS | `test/acceptance.test.ts`、`test/operations.test.ts`、`test/regressions.test.ts` |
| A-09 | 不可映射字符（如 `䶇` 写入 GBK）被闸门 1 拦截，不产生 `0x3F` | PASS | `test/gates.test.ts`、`test/acceptance.test.ts` |
| A-10 | 截断或未知字节序列判为 `UNKNOWN`，拒绝写入 | PASS | `test/classify.test.ts`、`test/resolve.test.ts`、`test/gates.test.ts` |
| A-11 | PNG/JPEG/GIF/WebP/BMP 图片原样读取并返回 `image` 内容块 | PASS | `test/operations.test.ts`、`test/acceptance.test.ts` |
| A-12 | GBK 与 UTF-8 混合目录搜索中文，双侧命中且不重复计数 | PASS | `test/grep.test.ts`、`test/acceptance.test.ts`、`test/perf/grep-scale.test.ts` |
| A-13 | `grep` 支持 `glob`、`literal`、`ignoreCase`、`context`、`limit` 与 `AbortSignal` 取消 | PASS | `test/grep.test.ts`、`test/perf/grep-scale.test.ts` |
| A-14 | 默认排除 `.git`、`.svn`、`.hg`、`node_modules` 副本 | PASS | `test/grep.test.ts`、`test/acceptance.test.ts` |
| A-15 | 配置文件 JSON 语法损坏时输出警告并按默认值保护受管文件 | PASS | `test/acceptance.test.ts`、`test/resolve.test.ts` |
| A-16 | 读取后文件被外部修改或删除，再次写入时检测基线冲突并拒写 | PASS | `test/acceptance.test.ts`、`test/operations.test.ts`、`test/regressions.test.ts` |
| A-17 | 落盘后自校验发现外部并发改写时报错并保留磁盘现场，不回滚覆盖外部新内容 | PASS | `test/gates.test.ts`、`test/regressions.test.ts` |
| A-18 | 只读文件或锁冲突写入失败时如实报错并清理 `.tmp` 临时文件 | PASS | `test/acceptance.test.ts`、`test/gates.test.ts` |
| A-19 | 同一文件 20 路并发写入串行化，无交错损坏与临时文件残留 | PASS | `test/concurrency.test.ts` |
| A-20 | 配置文件修改或会话重载后自动失效缓存 | PASS | `test/resolve.test.ts`、`test/edit-preview.test.ts` |
| A-21 | 子会话工具继承 | 未覆盖 | 取决于宿主子会话创建方式，已在 [`README.zh-CN.md`](../../README.zh-CN.md) 边界表说明 |
| A-22 | 宿主真实加载器加载 `src/index.ts` 与 RPC 模式启动 | PASS | `test/host-integration.test.ts` |
| A-23 | 非 UTF-8 文件 `edit` 预览 diff 计算与缓存失效 | PASS | `test/edit-preview.test.ts` |
| A-24 | `npm pack --dry-run` 打包清单与干净目录加载验证 | PASS | `tools/check-release.mjs` |

## 2. 测试套件分布

| 测试文件 | 覆盖内容 |
|---|---|
| `test/classify.test.ts` | 16 类样本编码判定、UTF-8 优先级、单字节排除、1MB 判定延迟与缓存 |
| `test/converter.test.ts` | 编码别名规整、GB 族识别、不可映射字符检测与 `\uXXXX` 转义 |
| `test/regressions.test.ts` | GBK 合法问号与 Emoji；UTF-8/UTF-16 行尾与 BOM；读取后外部删除与重命名前冲突检测；跨平台路径键；不支持的 Shell 编码透传；Rust 正则；POSIX 权限与符号链接拦截（按平台条件执行） |
| `test/config.test.ts` | `.pi-charset.json` 向上查找、override 特异度评分与配置校验 |
| `test/resolve.test.ts` | 读写决策矩阵、`writeIntent` 判定、UTF-8 保护、BOM 规则与配置热更新 |
| `test/gates.test.ts` | 闸门 1（`error`/`escape`/`drop-to-gb18030`）、闸门 2（写后回读保留磁盘现场）、闸门 3 |
| `test/roundtrip.test.ts` | 12 种编码 `read -> write` 逐字节无损往返、纯 ASCII 转 GBK、`CRLF` 幂等性 |
| `test/utf8-protect.test.ts` | GBK 目录树内 UTF-8 文件保护与整树混合编码读写校验 |
| `test/line-endings.test.ts` | `CRLF`、`LF`、`MIXED` 与 `NONE` 行尾识别与还原 |
| `test/operations.test.ts` | `read`/`write`/`edit` 工具操作、`newFileLineEnding`、混合换行拦截、SHA-1 基线校验 |
| `test/grep.test.ts` | 多趟编码搜索、逐文件判定过滤、上下文按文件编码解码、零配置多编码搜索 |
| `test/edit-preview.test.ts` | 同步预览路由缓存、GB 文件异步 diff 预览、单字节 `force` 路由 |
| `test/shell.test.ts` | 流式 Shell 输出转码、跨块多字节拆分、尾部截断 UTF-8 识别、单文件读取命令识别 |
| `test/sysnote.test.ts` | 条件式系统提示注入与 `tool_result` 消息队列 |
| `test/zero-config.test.ts` | 零配置自适应读写编辑与同目录邻居编码推断 |
| `test/scan-init.test.ts` | `tools/scan-encoding.mjs` 参数校验、`--init` 工程声明提取、最窄编码选择与 `--damaged` |
| `test/concurrency.test.ts` | 单文件 20 路并发串行化写入与多文件并发写入 |
| `test/host-integration.test.ts` | 扩展注册、`/charset-status` + `/charset-init` + `/charset-scan` 脚手架命令与 `discoverAndLoadExtensions` 加载器验证 |
| `test/perf/io-latency.test.ts` | 300 次 8.7KB GBK 读写循环与 1MB 文件读写延迟 |
| `test/perf/grep-scale.test.ts` | 2000 个 GBK/UTF-8 混合文件搜索与 `AbortSignal` 取消延迟 |
