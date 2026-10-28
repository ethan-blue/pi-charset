#!/usr/bin/env node
// Extract the release notes section for a given version from CHANGELOG.md for GitHub Releases.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const rawArg = process.argv[2] ?? pkg.version;
const version = String(rawArg).replace(/^refs\/tags\//, "").replace(/^v/, "");
const tagRef = `v${version}`;

const content = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf-8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headerRe = new RegExp(`^## \\[${escaped}\\]\\s*-\\s*\\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
const match = headerRe.exec(content);

if (!match) {
  console.error(`[extract-changelog] Section "## [${version}]" not found in CHANGELOG.md`);
  process.exit(1);
}

const rest = content.slice(match.index + match[0].length);
const nextHeader = /^## \[/m.exec(rest);
const section = (nextHeader ? rest.slice(0, nextHeader.index) : rest).trim();

function refHasFile(ref, relFile) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${relFile}`], {
      cwd: root,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

const repoUrl = String(pkg.repository?.url ?? "")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
const zhBranchOrTag = refHasFile(tagRef, "CHANGELOG.zh-CN.md") ? tagRef : "main";
const zhLink = repoUrl ? `${repoUrl}/blob/${zhBranchOrTag}/CHANGELOG.zh-CN.md` : "./CHANGELOG.zh-CN.md";

process.stdout.write(`${section}\n\n---\n\n简体中文变更说明：[CHANGELOG.zh-CN.md](${zhLink})\n`);
