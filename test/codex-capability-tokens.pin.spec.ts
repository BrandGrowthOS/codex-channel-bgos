/**
 * `src/codex-capability-tokens.ts` is COPIED from BGOS. If you change it
 * here, the copy there is now wrong, and without this pin nothing would tell
 * you.
 *
 * WHAT IS COPIED AND WHY. The BGOS canon tells this daemon's agent that the
 * host fills `reason` and `rule_text` only when the daemon declares
 * `request_reason`, whatever its version (BGOS
 * backend/src/integrations/capability-canon.ts, REQUEST_REASON). The canon
 * gates on BGOS backend/src/integrations/codex-capability-tokens.ts, and this
 * daemon declares from its copy here (src/declared-capabilities.ts). A token
 * spelled differently on the two sides is not an error anywhere: the
 * heartbeat grammar accepts it, BGOS stores it, and the agent is simply never
 * told. So the spelling is held by a hash, not by a sentence.
 *
 * THE OTHER HALF. BGOS backend/src/integrations/codex-capability-tokens.pin.spec.ts
 * pins the SAME digest on its copy, so editing the file here fails this suite
 * and editing it there fails that one. Neither repo's CI can read the other,
 * which is why each side carries the literal.
 *
 * WHEN THIS FAILS, and it is meant to, the fix is not to silence it: make
 * the same edit to the BGOS copy so the two files are byte for byte identical
 * (LF, no BOM), put the new sha256 in SHA256 below AND in the BGOS pin spec,
 * and ship both in one pair of PRs.
 *
 * MUTATION PROOF (recorded 2026-09-24, run through the test lock, file
 * restored byte for byte from a pristine copy and re-hashed to the digest
 * below): one byte flipped in this repo's copy (`request_reason` to
 * `request_reasom` in the REQUEST_REASON literal, byte 2352) -> 7 of 1049
 * red in 4 files: both pins here ("still has the bytes" and "names exactly
 * request_reason"), the declared list's request_reason case, both heartbeat
 * list pins, and both canon fetch cases in test/capabilities.spec.ts. The
 * BGOS pin spec records the same flip on its own copy.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODEX_CAPABILITY_TOKENS,
  REQUEST_REASON as FILE_REQUEST_REASON,
} from "../src/codex-capability-tokens.js";
import {
  DECLARED_CAPABILITIES,
  REQUEST_REASON,
} from "../src/declared-capabilities.js";

/** The digest BGOS backend/src/integrations/codex-capability-tokens.pin.spec.ts pins too. */
const SHA256 =
  "ec5f6625a4134414b899873f7c6d7dfa61d8a98fc6e143e653c10d4b4370c063";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "src", "codex-capability-tokens.ts");
const DECLARED = join(HERE, "..", "src", "declared-capabilities.ts");
const REPO_ROOT = join(HERE, "..");

/** Block and line comments removed, so a word in a comment is not code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("the Codex capability token file shared with BGOS", () => {
  it("still has the bytes the BGOS copy is pinned to", () => {
    const digest = createHash("sha256").update(readFileSync(FILE)).digest("hex");
    expect({ file: "codex-capability-tokens.ts", digest }).toEqual({
      file: "codex-capability-tokens.ts",
      digest: SHA256,
    });
  });

  it("names exactly request_reason", () => {
    expect([...CODEX_CAPABILITY_TOKENS]).toEqual(["request_reason"]);
    expect(FILE_REQUEST_REASON).toBe("request_reason");
    expect(Object.isFrozen(CODEX_CAPABILITY_TOKENS)).toBe(true);
    for (const token of CODEX_CAPABILITY_TOKENS) {
      // BGOS backend/src/dto/integrations/pair-exchange.dto.ts's token grammar
      expect(token).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
  });

  it("is DECLARED, from the file, so the canon tells this daemon the request reason clause", () => {
    expect(REQUEST_REASON).toBe(FILE_REQUEST_REASON);
    expect(DECLARED_CAPABILITIES).toContain(FILE_REQUEST_REASON);
    // Every token the file names is declared: the file lists only what this
    // release does, and a token named there but not declared would leave its
    // sentence untold on every daemon.
    for (const token of CODEX_CAPABILITY_TOKENS) {
      expect(DECLARED_CAPABILITIES).toContain(token);
    }
    // And the declared list has no spelling of its own: it imports the token
    // from the file, so a second spelling cannot creep in beside the pinned
    // one and quietly win.
    const declared = withoutComments(readFileSync(DECLARED, "utf8"));
    expect(declared).toMatch(
      /^import \{ REQUEST_REASON \} from "\.\/codex-capability-tokens\.js";$/m,
    );
    expect(declared).not.toMatch(/['"`]request_reason['"`]/);
  });

  it("has no imports and no CR, so both toolchains read the same bytes", () => {
    const bytes = readFileSync(FILE);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const code = withoutComments(bytes.toString("utf8"));
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    // This repo's .gitattributes keeps every text file LF on a Windows
    // checkout, without which this digest is unreadable where it is built.
    const attrs = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8");
    expect(attrs).toMatch(/^\*\s+text=auto eol=lf$/m);
  });

  it("a changed byte is actually caught, so a passing pin is not vacuous", () => {
    const real = readFileSync(FILE);
    const tampered = Buffer.concat([real, Buffer.from("\n")]);
    expect(createHash("sha256").update(tampered).digest("hex")).not.toBe(SHA256);
  });
});
