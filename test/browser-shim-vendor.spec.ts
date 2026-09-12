/**
 * The vendored browser shim is pinned by hash, not by a sentence.
 *
 * WHY THIS FILE EXISTS. `vendor/hoai-browser-mcp.mjs` is a byte-identical COPY
 * of the BGOS source of truth
 * (`frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs`), because
 * the shim is framework neutral: it never reads a plugin's files and takes its
 * relay credentials from env, so every channel plugin ships the same file and
 * only the launcher differs. A copy is only as good as the thing that notices
 * it has drifted, and for one round that thing was prose: the sha256 sat in a
 * commit message and a PR body, and nothing compared it to anything. The BGOS
 * shim was then fixed twice in the same week (the relay answer is the body's
 * `status`, not the HTTP code, because NestJS answers 201; and the pairing lane
 * must name the assistant, which the relay DTO requires on both lanes) and the
 * sibling plugin shipped a stale copy with a dead relay lane until a human
 * review caught it, which is not a mechanism.
 *
 * So the hash lives in `vendor/hoai-browser-mcp.vendor.json` and this spec
 * reads it. What each case buys:
 *
 *  - the pin vs the file on disk: a re-vendor can no longer land silently. It
 *    either matches the pin or it fails here, which forces whoever re-vendors
 *    to state the new hash in the tree (and to have looked at the diff).
 *  - LF, and the `.gitattributes` entry that guarantees it: without that entry
 *    `core.autocrlf` hands a Windows checkout a different byte sequence and the
 *    hash is unverifiable on disk for exactly the people most likely to check.
 *  - the cross-tree case: BGOS is a separate private repo and is NOT on this
 *    repo's CI runner, so this suite cannot compare the two on its own. It is
 *    opt-in through `HOAI_BROWSER_SHIM_SOURCE`, which is what the re-vendor
 *    checklist tells you to set on a machine that has both trees.
 *
 * What this still does NOT buy: nothing here fires when the BGOS shim changes
 * and this copy does not move. That check can only live on the BGOS side. The
 * behavioural cover for a copy that is WRONG rather than merely OLD is
 * `test/browser-mcp.spec.ts` (the shim is spawned for real against a fake HOAI
 * backend that enforces the assistant id).
 *
 * See docs/vendoring-the-hoai-browser-shim.md.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledShimPath } from "../src/browser-mcp.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIM = join(ROOT, "vendor", "hoai-browser-mcp.mjs");
const PIN = join(ROOT, "vendor", "hoai-browser-mcp.vendor.json");
const CHECKLIST = join(ROOT, "docs", "vendoring-the-hoai-browser-shim.md");
const BGOS_SOURCE =
  "frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs";

interface Pin {
  file: string;
  source: string;
  sha256: string;
  vendoredAt: string;
  why: string;
  howToUpdate: string;
  crossTreeCheck: string;
  alsoVendoredBy: string;
}

function pin(): Pin {
  return JSON.parse(readFileSync(PIN, "utf8")) as Pin;
}

/** The hash of a file's BYTES, which is the only claim worth pinning. */
function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("the vendored HOAI browser shim", () => {
  it("THE GUARD: hashes to the pinned sha256", () => {
    const expected = pin().sha256;
    const actual = sha256(SHIM);
    expect(
      actual,
      `vendor/hoai-browser-mcp.mjs is ${actual}, the pin says ${expected}. This file is a byte-identical ` +
        `copy of BGOS ${BGOS_SOURCE} and must never be edited here. If you re-vendored it deliberately, ` +
        "follow docs/vendoring-the-hoai-browser-shim.md: bump the hash in vendor/hoai-browser-mcp.vendor.json " +
        "and re-run the browser suites. If you did not, this copy has drifted from the BGOS source of truth " +
        "and the relay lane may be silently dead.",
    ).toBe(expected);
  });

  it("is the file the resolver actually bundles, so the pin guards the shipped copy", () => {
    // A pin on a file nothing launches would guard nothing.
    expect(sha256(bundledShimPath())).toBe(pin().sha256);
  });

  it("has a pin that names the file, the BGOS source and a real hash", () => {
    const p = pin();
    expect(p.file).toBe("vendor/hoai-browser-mcp.mjs");
    // A lowercase hex sha256, so the string compares byte for byte.
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.source).toMatch(
      /agent-browser[/\\]shim[/\\]hoai-browser-mcp\.mjs/,
    );
    expect(p.vendoredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.howToUpdate).toBe("docs/vendoring-the-hoai-browser-shim.md");
    // The pin itself says how to check the other tree.
    expect(p.crossTreeCheck).toMatch(/HOAI_BROWSER_SHIM_SOURCE/);
  });

  it("is LF, and .gitattributes is what keeps it that way", () => {
    const bytes = readFileSync(SHIM);
    // A CRLF copy has a different sha256 and cannot be verified on disk.
    expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
    expect(readFileSync(join(ROOT, ".gitattributes"), "utf8")).toMatch(
      /^vendor\/hoai-browser-mcp\.mjs text eol=lf$/m,
    );
  });

  it("has a re-vendor checklist naming the pin, this guard and the cross-tree variable", () => {
    expect(existsSync(CHECKLIST)).toBe(true);
    const text = readFileSync(CHECKLIST, "utf8");
    for (const needle of [
      "vendor/hoai-browser-mcp.vendor.json",
      "test/browser-shim-vendor.spec.ts",
      "HOAI_BROWSER_SHIM_SOURCE",
      BGOS_SOURCE,
    ])
      expect(text).toContain(needle);
  });
});

// The cross-tree comparison. BGOS is a separate private repo and is not on this
// repo's CI runner, so this is opt-in rather than a check this suite can make on
// its own: point HOAI_BROWSER_SHIM_SOURCE at the BGOS shim on a machine that has
// both trees (the re-vendor checklist tells you to) and it runs. Skipped
// otherwise, rather than pretending to check something it cannot reach.
const source = (process.env.HOAI_BROWSER_SHIM_SOURCE ?? "").trim();
const sourceReadable = source !== "" && existsSync(source);
describe("the BGOS source of truth", () => {
  it.skipIf(!sourceReadable)(
    "hashes to the same pin (opt-in: needs both trees, set HOAI_BROWSER_SHIM_SOURCE)",
    () => {
      const expected = pin().sha256;
      expect(
        sha256(source),
        `the BGOS shim at ${source} is not the file this repo vendors; re-vendor it deliberately per ` +
          "docs/vendoring-the-hoai-browser-shim.md and bump vendor/hoai-browser-mcp.vendor.json.",
      ).toBe(expected);
      // And the copy still matches, so the two trees agree.
      expect(sha256(SHIM)).toBe(expected);
    },
  );
});
