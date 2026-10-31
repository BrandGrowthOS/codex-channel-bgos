#!/usr/bin/env node
// Fetch the plugin's copy of the HOAI browser shim at the ref pinned in
// vendor/hoai-browser-mcp.vendor.json, so test/browser-shim-vendor.spec.ts can
// compare this repo's vendored copy against it.
//
// WHY. The spec's cross-tree case only runs when HOAI_BROWSER_SHIM_SOURCE
// points at a second copy of the shim. CI never set it, so a copy that drifted
// stayed green. bgos-claude-plugin is public and ships the same bytes as
// bin/hoai-browser-mcp.mjs, so CI downloads that one file from
// raw.githubusercontent.com at the pinned commit: no token, no secret, no repo
// variable, nothing to expire. test.yml and publish.yml run this before
// `npm test`.
//
// THE ONE PLACE THE REF LIVES is `pluginRef` in the vendor json, next to the
// sha256 it must agree with. To bump it, change that line (a full commit sha,
// never a branch or tag, so what CI compares to cannot move under it).
//
// Usage:
//   node scripts/fetch-plugin-shim.mjs            # when GITHUB_ENV is set (Actions), also exports HOAI_BROWSER_SHIM_SOURCE through it
//   node scripts/fetch-plugin-shim.mjs --out DIR   # choose where the file goes
// Locally it prints the path; export HOAI_BROWSER_SHIM_SOURCE=<that path> to arm the spec.
//
// It deliberately does NOT compare hashes: the spec does, and a red spec is the
// signal. It fails only when the pin fields are malformed or the file cannot be
// fetched at all.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pin = JSON.parse(
  readFileSync(join(ROOT, "vendor", "hoai-browser-mcp.vendor.json"), "utf8"),
);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const { pluginRepository: repo, pluginRef: ref, pluginPath: path } = pin;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? ""))
  fail(`vendor json pluginRepository is not owner/name: ${repo}`);
if (!/^[0-9a-f]{40}$/.test(ref ?? ""))
  fail(`vendor json pluginRef must be a full 40 character commit sha: ${ref}`);
if (!/^[A-Za-z0-9_./-]+$/.test(path ?? "") || path.split("/").includes(".."))
  fail(`vendor json pluginPath is not a plain relative path: ${path}`);

const outFlag = process.argv.indexOf("--out");
if (outFlag >= 0 && !process.argv[outFlag + 1]) fail("--out needs a directory");
const outDir = resolve(
  outFlag >= 0
    ? process.argv[outFlag + 1]
    : join(process.env.RUNNER_TEMP || tmpdir(), "plugin-shim"),
);
const dest = join(outDir, "hoai-browser-mcp.mjs");
const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

let bytes;
let lastError = "";
for (let attempt = 1; attempt <= 3 && !bytes; attempt++) {
  let retry = true;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
    else {
      lastError = `HTTP ${res.status}`;
      // A 4xx other than 429 (a ref or path that does not exist) never heals.
      retry = res.status === 429 || res.status >= 500;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  if (!bytes && !retry) break;
  if (!bytes && attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
}
if (!bytes)
  fail(
    `could not fetch the plugin shim from ${url} (${lastError}). The cross-tree comparison cannot run, and in CI that fails the suite on purpose.`,
  );

mkdirSync(outDir, { recursive: true });
writeFileSync(dest, bytes);
const sha = createHash("sha256").update(bytes).digest("hex");
console.log(`plugin shim ${repo}@${ref}:${path}`);
console.log(`  saved to ${dest}`);
console.log(`  sha256   ${sha}`);

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `HOAI_BROWSER_SHIM_SOURCE=${dest}\n`);
  console.log("  exported HOAI_BROWSER_SHIM_SOURCE for the following steps");
} else {
  console.log(`  arm the spec with: HOAI_BROWSER_SHIM_SOURCE=${dest}`);
}
