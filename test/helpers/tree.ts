import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface TreeSpecLike {
  dir: string;
  files: { rel: string; buf: Buffer }[];
}

export function writeTree(base: string, files: { rel: string; buf: Buffer }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    const abs = path.join(base, ...f.rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.buf);
    map.set(f.rel, abs);
  }
  return map;
}

export function writeSpecTree(spec: TreeSpecLike): Map<string, string> {
  return writeTree(spec.dir, spec.files);
}

export const readBytes = (abs: string): Buffer => readFileSync(abs);

export function putConfig(dir: string, cfg: Record<string, unknown> | string): string {
  const p = path.join(dir, ".pi-charset.json");
  writeFileSync(p, typeof cfg === "string" ? cfg : JSON.stringify(cfg, null, 2), "utf-8");
  return p;
}
