// Post-build: tsc strips the shebang and executable bit from the CLI entry.
// Re-add both so `npx codex-channel-bgos ...` and the installed bin run directly.
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const bins = ["dist/cli.js"];
let missing = false;

for (const rel of bins) {
  const target = resolve(rel);
  if (!existsSync(target)) {
    console.error(`[finalize-daemon] missing build output: ${rel}`);
    missing = true;
    continue;
  }
  let contents = readFileSync(target, "utf8");
  if (!contents.startsWith("#!")) {
    contents = "#!/usr/bin/env node\n" + contents;
    writeFileSync(target, contents);
  }
  try {
    chmodSync(target, 0o755);
  } catch {
    // Windows best-effort: chmod is a no-op there.
  }
}

if (missing) process.exit(1);
