/**
 * Read this package's own version from its package.json exactly once at load.
 *
 * The daemon reports `daemonVersion` in the heartbeat DTO + the pair-exchange
 * body, and the local heartbeat file records it. Both `dist/version.js` (built)
 * and `src/version.ts` (tests) live one directory under the package root, so
 * `../package.json` resolves in both. Falls back to "0.0.0" if the file cannot
 * be read (never throws: a missing version must not block boot).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function getPackageVersion(): string {
  if (cached !== null) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    cached = typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
