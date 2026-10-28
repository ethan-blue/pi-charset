#!/usr/bin/env node
// Synchronize src/version.ts and README version badges with package.json during `npm version`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const version = pkg.version;

fs.writeFileSync(
  path.join(root, "src/version.ts"),
  `// Synchronized with package.json version.\nexport const PLUGIN_VERSION = "${version}";\n`,
  "utf-8",
);

const badgeVersion = version.replace(/-/g, "--");
for (const readme of ["README.md", "README.zh-CN.md"]) {
  const abs = path.join(root, readme);
  if (!fs.existsSync(abs)) continue;
  const updated = fs
    .readFileSync(abs, "utf-8")
    .replace(/badge\/version-[0-9A-Za-z.-]+-blue\.svg/g, `badge/version-${badgeVersion}-blue.svg`);
  fs.writeFileSync(abs, updated, "utf-8");
}

execFileSync(process.execPath, [path.join(here, "check-release.mjs"), "--no-pack"], {
  cwd: root,
  stdio: "inherit",
});
