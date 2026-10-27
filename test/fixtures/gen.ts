// Write fixture files to test/fixtures/out/ (invoked via npm run fixtures).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, mixedEncodingProjectTree } from "./build.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of FIXTURES) {
  writeFileSync(path.join(out, f.name), f.make());
}
const tree = mixedEncodingProjectTree(path.join(out, "mixed-tree"));
for (const f of tree.files) {
  const abs = path.join(tree.dir, ...f.rel.split("/"));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, f.buf);
}
console.log(`Generated ${FIXTURES.length} fixtures + ${tree.files.length} tree files -> ${out}`);
