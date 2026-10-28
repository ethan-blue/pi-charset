# 版本发布规范

[English](../RELEASING.md) | 简体中文

---

## 版本号策略

`pi-charset` 遵循[语义化版本（SemVer）](https://semver.org/lang/zh-CN/)：
- **修订号（Patch，`0.1.x`）**：编码边界问题修复、跨平台兼容修复、性能优化与文档修正。
- **次版本号（Minor，`0.x.0`）**：向下兼容的新配置项、新命令或工具能力增强。
- **主版本号（Major，`x.0.0`）**：`.pi-charset.json` 结构不兼容变更、默认门禁策略变更，或最低支持的 Node / Pi 宿主版本上调。

## 发版一致性门禁

每次发版通过 `npm run check:release` 强制校验以下 5 处版本信息完全一致：
1. `package.json` 中的 `version`
2. `package-lock.json` 中的顶层 `version` 与 `packages[""].version`
3. `src/version.ts` 中的 `PLUGIN_VERSION`
4. [`CHANGELOG.md`](../../CHANGELOG.md) 中的 `## [<version>] - YYYY-MM-DD` 章节
5. [`CHANGELOG.zh-CN.md`](../../CHANGELOG.zh-CN.md) 中的 `## [<version>] - YYYY-MM-DD` 章节

此外，`npm run check:release` 还会自动校验：
- `package.json` 的 Pi 扩展清单规范（`keywords` 含 `pi-package`、`pi.extensions` 入口文件存在）；
- 全仓所有 Markdown 文档中的相对路径链接是否全部有效；
- `npm pack --dry-run` 打包产物白名单是否干净（不含测试样本、临时文件或快照目录）。

## 标准发版步骤

### 1. 更新中英文变更日志

在 [`CHANGELOG.md`](../../CHANGELOG.md) 与 [`CHANGELOG.zh-CN.md`](../../CHANGELOG.zh-CN.md) 顶部同步新增 `## [<version>] - YYYY-MM-DD` 章节；如需同步更新文档中的示例固定标签（如 `@v0.1.x`），一并修改后提交到 `main` 分支（或先暂存）。

### 2. 运行全量校验

```bash
npm run verify
```

### 3. 升级版本号并生成 Git 标签

`package.json` 已配置 npm `"version"` 生命周期钩子（`tools/sync-version.mjs`），执行 `npm version` 时会自动同步更新 `src/version.ts`、运行发版门禁检查，并将 `src/version.ts` 一并纳入发版提交与 `vX.Y.Z` 标签：

```bash
npm version patch -m "chore(release): v%s"
# 或指定具体版本号：
# npm version 0.2.0 -m "chore(release): v%s"
```

### 4. 推送分支与标签

```bash
git push origin main --follow-tags
```

## 自动化发布流水线（`.github/workflows/release.yml`）

推送 `v*.*.*` 标签后，GitHub Actions 会自动触发 `.github/workflows/release.yml`：
1. **跨平台验证（`verify`）**：在 Ubuntu 与 Windows 上执行 `npm ci`、`node tools/check-release.mjs --tag vX.Y.Z`、`npm run typecheck` 与 `npm test`。
2. **创建 GitHub Release（`github-release`）**：从 `CHANGELOG.md` 自动提取对应版本的发布说明，执行 `npm pack` 生成 `.tgz` 归档包，并创建附带安装包产物的 GitHub Release。
3. **可选 npm 官方源发布（`npm-publish`）**：当仓库变量 `ENABLE_NPM_PUBLISH` 设为 `true` 时，通过 GitHub OIDC Trusted Publishing 自动执行 `npm publish --provenance --access public`。
