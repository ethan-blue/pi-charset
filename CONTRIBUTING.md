# Contributing

English | [简体中文](./CONTRIBUTING.zh-CN.md)

## Prerequisites

- Node.js `>= 22.19.0`
- `ripgrep` (`rg`) available on `PATH` or under `~/.pi/agent/bin/`

## Setup

```bash
npm ci
npm run verify
```

## Development Guidelines

- **Code Comments**: Write concise, factual English comments in source, tooling, and test files. Comment non-obvious invariants, edge cases, and platform semantics rather than restating syntax.
- **Documentation**: Keep English (`README.md`, `CHANGELOG.md`, `docs/*.md`) and Simplified Chinese (`README.zh-CN.md`, `CHANGELOG.zh-CN.md`, `docs/zh-CN/*.md`) synchronized whenever user-visible behavior, configuration, or CLI options change.
- **Tests**: Add regression coverage in `test/` for every bug fix or gate behavior change. Avoid committing binary test fixtures; generate byte buffers in `test/fixtures/build.ts` or in-memory within tests.
- **Verification**: Run `npm run verify` (`typecheck` + `vitest` + `check:release`) before opening a pull request.

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` new user-facing capability
- `fix:` bug fix or encoding safety fix
- `docs:` documentation updates
- `test:` test additions or refactors
- `chore:` build, CI, dependency, or release maintenance

For release procedures, see [docs/RELEASING.md](./docs/RELEASING.md).
