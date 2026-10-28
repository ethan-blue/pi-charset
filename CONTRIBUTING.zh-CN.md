# 参与贡献

[English](./CONTRIBUTING.md) | 简体中文

## 环境要求

- Node.js `>= 22.19.0`
- 系统 `PATH` 或 `~/.pi/agent/bin/` 中包含可用的 `ripgrep`（`rg`）

## 本地初始化

```bash
npm ci
npm run verify
```

## 开发约定

- **代码注释**：源码、工具脚本与测试文件统一使用简洁准确的英文注释，仅说明关键不变量、边界条件与跨平台行为差异，不重复解释语法表面含义。
- **双语文档同步**：凡涉及用户可见行为、配置字段或命令行参数的变更，需同步更新英文文档（`README.md`、`CHANGELOG.md`、`docs/*.md`）与简体中文文档（`README.zh-CN.md`、`CHANGELOG.zh-CN.md`、`docs/zh-CN/*.md`）。
- **测试要求**：修复缺陷或调整门禁逻辑时需在 `test/` 下补充对应回归测试。仓库不提交二进制测试样本，测试字节流在内存或 `test/fixtures/build.ts` 中构造。
- **提交前自检**：提交或发起 PR 前请确保 `npm run verify`（`typecheck` + `vitest` + `check:release`）全部通过。

## 提交信息规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 格式：
- `feat:` 新增功能
- `fix:` 缺陷或编码安全修复
- `docs:` 文档更新
- `test:` 测试增补或重构
- `chore:` 构建、CI、依赖或发版维护

版本发布流程请参见 [docs/zh-CN/RELEASING.md](./docs/zh-CN/RELEASING.md)。
