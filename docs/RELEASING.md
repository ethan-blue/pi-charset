# Release Guide

English | [简体中文](./zh-CN/RELEASING.md)

---

## Versioning Policy

`pi-charset` follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):
- **Patch (`0.1.x`)**: Encoding edge-case fixes, platform compatibility fixes, performance improvements, and documentation updates.
- **Minor (`0.x.0`)**: Backward-compatible configuration options, commands, or tool capabilities.
- **Major (`x.0.0`)**: Breaking changes to `.pi-charset.json` schema, default gate behavior, or minimum supported Node/Pi versions.

## Version Invariants

Every release enforces strict synchronization across five artifacts via `npm run check:release`:
1. `package.json` (`version`)
2. `package-lock.json` (`version` and `packages[""].version`)
3. `src/version.ts` (`PLUGIN_VERSION`)
4. [`CHANGELOG.md`](../CHANGELOG.md) (`## [<version>] - YYYY-MM-DD`)
5. [`CHANGELOG.zh-CN.md`](../CHANGELOG.zh-CN.md) (`## [<version>] - YYYY-MM-DD`)

`npm run check:release` also validates Pi package manifest fields (`keywords` containing `pi-package` and `pi.extensions` entrypoints), relative Markdown links across all documentation files, and the `npm pack --dry-run` tarball file list.

## Step-by-Step Release Process

### 1. Update Changelogs

Add a new `## [<version>] - YYYY-MM-DD` section to both [`CHANGELOG.md`](../CHANGELOG.md) and [`CHANGELOG.zh-CN.md`](../CHANGELOG.zh-CN.md), and update version badges/pinned tag examples in `README.md`, `README.zh-CN.md`, `docs/INSTALL.md`, and `docs/zh-CN/INSTALL.md` if applicable.

Stage the changelog and documentation updates before running `npm version`, or commit them on `main` first.

### 2. Run Full Verification

```bash
npm run verify
```

### 3. Bump Version & Create Git Tag

`package.json` defines an npm `"version"` lifecycle hook (`tools/sync-version.mjs`) that automatically updates `src/version.ts`, validates both changelogs, and stages `src/version.ts` into the release commit:

```bash
npm version patch -m "chore(release): v%s"
# or explicit version:
# npm version 0.2.0 -m "chore(release): v%s"
```

### 4. Push Branch & Tag

```bash
git push origin main --follow-tags
```

## Automated Release Pipeline (`.github/workflows/release.yml`)

Pushing a `v*.*.*` tag triggers `.github/workflows/release.yml`:
1. **Cross-Platform Verification (`verify`)**: Runs `npm ci`, `node tools/check-release.mjs --tag vX.Y.Z`, `npm run typecheck`, and `npm test` on Ubuntu and Windows.
2. **GitHub Release (`github-release`)**: Extracts the matching section from `CHANGELOG.md`, builds the `.tgz` package via `npm pack`, and publishes a GitHub Release with the tarball attached.
3. **Optional npm Registry Publish (`npm-publish`)**: Runs `npm publish --provenance --access public` via GitHub OIDC Trusted Publishing when the repository variable `ENABLE_NPM_PUBLISH` is set to `true`.
