/**
 * `src/session-status-contract.ts` is COPIED byte for byte from BGOS
 * (backend/src/integrations/session-status-contract.ts) and into the Claude
 * Code plugin (lib/session-status-contract.ts), HOAI board row 9c3d6b2c,
 * session liveness. If you change it here, the other two copies are now
 * wrong, and without this pin nothing would tell you.
 *
 * WHAT IS COPIED AND WHY. The file is the status report a connection sends on
 * its heartbeat: the key it rides under, its fields, their types and limits,
 * the cadence the server's staleness rule depends on, and the parser the
 * server runs on it. This daemon sends four of its fields (`v`, `at`, `busy`,
 * `lastActivityAt`); test/heartbeat.spec.ts runs what it sends through the
 * shared parser. A drift on either side is silent: a field spelled
 * differently is ignored as unknown, a limit changed on one side drops every
 * report as bad. So the bytes are held by a hash.
 *
 * THE OTHER HALVES. BGOS
 * backend/src/integrations/session-status-contract.pin.spec.ts and
 * bgos-claude-plugin test/session-status-contract.pin.test.ts pin the SAME
 * digest on their copies. No repo's CI can read another, which is why each
 * side carries the literal.
 *
 * WHEN THIS FAILS, and it is meant to, the fix is not to silence it:
 *   1. Make the same edit to the BGOS copy and the Claude plugin copy, so the
 *      three files are byte for byte identical (LF, no BOM).
 *   2. Put the new sha256 in SHA256 below AND in both other pin specs.
 *   3. Ship all three in one set of PRs. A change in one tree only is the
 *      defect this exists to catch.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  SESSION_STATUS_KEY,
  SESSION_STATUS_VERSION,
} from "../src/session-status-contract.js";

/** The digest the BGOS and Claude plugin pins hold too. */
const SHA256 =
  "8cb8e5090e9fb98b04293d0100f01b0db623be18a4f96807eb2d6b5442dce371";

const FILE = fileURLToPath(
  new URL("../src/session-status-contract.ts", import.meta.url),
);
const GITATTRIBUTES = fileURLToPath(new URL("../.gitattributes", import.meta.url));

/** An en dash or an em dash, spelled as escapes so this file carries neither. */
const DASH = new RegExp("[\\u2013\\u2014]");

describe("the session status contract shared with BGOS and the Claude plugin", () => {
  it("still has the bytes BGOS and the Claude plugin are pinned to", () => {
    const digest = createHash("sha256").update(readFileSync(FILE)).digest("hex");
    expect({ file: "session-status-contract.ts", digest }).toEqual({
      file: "session-status-contract.ts",
      digest: SHA256,
    });
  });

  it("is LF, no BOM, no dash, and .gitattributes keeps it LF on Windows", () => {
    const bytes = readFileSync(FILE);
    expect(bytes[0]).not.toBe(0xef);
    const text = bytes.toString("utf8");
    expect(text.includes("\r")).toBe(false);
    expect(DASH.test(text)).toBe(false);
    expect(readFileSync(GITATTRIBUTES, "utf8")).toMatch(/^\*\s+text=auto eol=lf$/m);
  });

  it("imports nothing and uses only erasable TypeScript", () => {
    const text = readFileSync(FILE, "utf8");
    const source = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true);
    const banned: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isDecorator(node)
      ) {
        banned.push(ts.SyntaxKind[node.kind]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(banned).toEqual([]);
  });

  it("names the heartbeat key and the version this daemon sends", () => {
    expect(SESSION_STATUS_KEY).toBe("sessionStatus");
    expect(SESSION_STATUS_VERSION).toBe(1);
  });
});
