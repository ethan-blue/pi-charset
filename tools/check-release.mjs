#!/usr/bin/env node
// Pre-release and CI verification script:
// 1. Verifies version parity across package.json, package-lock.json, src/version.ts, and optional --tag vX.Y.Z.
// 2. Verifies Pi package manifest conventions (pi-package keyword and pi.extensions entrypoints).
// 3. Verifies matching release sections exist in both CHANGELOG.md and CHANGELOG.zh-CN.md.
// 4. Verifies all relative Markdown links across root and docs/**/*.md resolve on disk.
// 5. Verifies npm pack --dry-run contents against required and forbidden file patterns.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const argv = process.argv.slice(2);
const tagIdx = argv.indexOf("--tag");
const expectedTag = tagIdx >= 0 ? argv[tagIdx + 1] : null;
const skipPack = argv.includes("--no-pack");

function fail(msg) {
  errors.push(msg);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf-8"));
}

// 1. Version parity check
const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const versionSrc = fs.readFileSync(path.join(root, "src/version.ts"), "utf-8");
const pluginVersionMatch = /PLUGIN_VERSION\s*=\s*"([^"]+)"/.exec(versionSrc);
const pluginVersion = pluginVersionMatch ? pluginVersionMatch[1] : null;

const semverRe = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!semverRe.test(pkg.version)) {
  fail(`package.json version "${pkg.version}" is not valid SemVer`);
}
if (lock.version !== pkg.version) {
  fail(`package-lock.json version (${lock.version}) !== package.json version (${pkg.version})`);
}
if (lock.packages?.[""]?.version !== pkg.version) {
  fail(`package-lock.json packages[""].version (${lock.packages?.[""]?.version}) !== package.json version (${pkg.version})`);
}
if (pluginVersion !== pkg.version) {
  fail(`src/version.ts PLUGIN_VERSION (${pluginVersion}) !== package.json version (${pkg.version})`);
}
if (expectedTag !== null) {
  const normalizedTag = String(expectedTag || "").replace(/^refs\/tags\//, "");
  if (normalizedTag !== `v${pkg.version}`) {
    fail(`Git tag "${normalizedTag}" does not match package.json version "v${pkg.version}"`);
  }
}

// 2. Pi package manifest check
if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) {
  fail(`package.json keywords must include "pi-package"`);
}
if (!Array.isArray(pkg.pi?.extensions) || pkg.pi.extensions.length === 0) {
  fail(`package.json must declare non-empty pi.extensions`);
} else {
  for (const extRel of pkg.pi.extensions) {
    if (!fs.existsSync(path.join(root, extRel))) {
      fail(`package.json pi.extensions entry does not exist: ${extRel}`);
    }
  }
}
if (Array.isArray(pkg.pi?.skills)) {
  for (const skillRel of pkg.pi.skills) {
    const skillFile = path.join(root, skillRel, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      fail(`package.json pi.skills entry missing SKILL.md: ${skillRel}`);
      continue;
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(skillFile, "utf-8"));
    if (!fm || !/^name:\s*[a-z0-9-]+$/m.test(fm[1]) || !/^description:\s*\S+/m.test(fm[1])) {
      fail(`${skillRel}/SKILL.md is missing valid Agent Skills frontmatter (name + description)`);
    }
  }
}
if (Array.isArray(pkg.pi?.prompts)) {
  for (const promptRel of pkg.pi.prompts) {
    if (!fs.existsSync(path.join(root, promptRel))) {
      fail(`package.json pi.prompts entry does not exist: ${promptRel}`);
    }
  }
}

// 3. Changelog check (English & Simplified Chinese)
function extractSection(content, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^## \\[${escaped}\\]\\s*-\\s*\\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
  const m = headerRe.exec(content);
  if (!m) return null;
  const rest = content.slice(m.index + m[0].length);
  const nextHeader = /^## \[/m.exec(rest);
  return (nextHeader ? rest.slice(0, nextHeader.index) : rest).trim();
}

for (const changelogRel of ["CHANGELOG.md", "CHANGELOG.zh-CN.md"]) {
  const abs = path.join(root, changelogRel);
  if (!fs.existsSync(abs)) {
    fail(`Missing required changelog file: ${changelogRel}`);
    continue;
  }
  const body = extractSection(fs.readFileSync(abs, "utf-8"), pkg.version);
  if (!body) {
    fail(`${changelogRel} is missing a non-empty "## [${pkg.version}] - YYYY-MM-DD" section`);
  }
}

// 4. Relative Markdown link check
function collectMarkdownFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && !["docs", "skills", "prompts"].includes(entry.name)) continue;
      collectMarkdownFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
  return acc;
}

const mdFiles = collectMarkdownFiles(root);
for (const mdPath of mdFiles) {
  const raw = fs.readFileSync(mdPath, "utf-8");
  const withoutFences = raw.replace(/```[\s\S]*?```/g, "");
  const linkRe = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of withoutFences.matchAll(linkRe)) {
    const rawTarget = match[1].trim().split(/\s+/)[0];
    if (
      !rawTarget ||
      rawTarget.startsWith("#") ||
      /^(https?:|mailto:|git:|ssh:)/i.test(rawTarget)
    ) {
      continue;
    }
    const cleanTarget = rawTarget.split("#")[0];
    if (!cleanTarget) continue;
    const resolved = path.resolve(path.dirname(mdPath), cleanTarget);
    if (!fs.existsSync(resolved)) {
      const relDoc = path.relative(root, mdPath).replace(/\\/g, "/");
      fail(`${relDoc}: broken relative link "${rawTarget}"`);
    }
  }
}

// 5. Tarball whitelist check (npm pack --dry-run --json)
if (!skipPack) {
  try {
    const bundledNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const npmCli =
      process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)
        ? process.env.npm_execpath
        : fs.existsSync(bundledNpmCli)
          ? bundledNpmCli
          : null;
    const out = npmCli
      ? execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
          cwd: root,
          encoding: "utf-8",
          windowsHide: true,
        })
      : execFileSync("npm", ["pack", "--dry-run", "--json"], {
          cwd: root,
          encoding: "utf-8",
          shell: process.platform === "win32",
          windowsHide: true,
        });
    const parsed = JSON.parse(out);
    const files = (parsed[0]?.files ?? []).map((f) => f.path);
    const requiredFiles = [
      "package.json",
      "LICENSE",
      "README.md",
      "README.zh-CN.md",
      "CHANGELOG.md",
      "CHANGELOG.zh-CN.md",
      "src/index.ts",
      "skills/charset-rules/SKILL.md",
      "prompts/charset-setup.md",
      "tools/scan-encoding.mjs",
    ];
    for (const req of requiredFiles) {
      if (!files.includes(req)) {
        fail(`npm pack tarball is missing required file: ${req}`);
      }
    }
    for (const packed of files) {
      if (
        packed.startsWith("test/") ||
        packed.startsWith(".") ||
        packed.endsWith(".tmp") ||
        packed === "tools/check-release.mjs" ||
        packed === "tools/sync-version.mjs" ||
        packed === "tools/extract-changelog.mjs"
      ) {
        fail(`npm pack tarball includes unexpected internal/test file: ${packed}`);
      }
    }
  } catch (e) {
    fail(`npm pack --dry-run failed: ${e.message}`);
  }
}

if (errors.length > 0) {
  for (const err of errors) {
    console.error(`[check-release] ERROR: ${err}`);
  }
  process.exit(1);
}

console.log(
  `[check-release] OK: pi-charset v${pkg.version} (${mdFiles.length} markdown files verified${skipPack ? ", pack skipped" : ", tarball verified"})`,
);
