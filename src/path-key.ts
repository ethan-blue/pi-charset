import * as path from "node:path";

/**
 * Return a normalized path key for cross-platform in-memory caching.
 * On Windows (win32), file systems are case-insensitive by default, so paths are case-folded to lowercase.
 * On POSIX (linux, darwin, etc.), case is preserved to support case-distinct files.
 */
export function normalizePathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(filePath);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}
