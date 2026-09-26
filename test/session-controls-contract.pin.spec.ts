/**
 * `src/session-controls-contract.ts` is COPIED byte for byte from BGOS
 * (backend/src/integrations/session-controls-contract.ts) and into the Claude
 * Code plugin (lib/session-controls-contract.ts), P6 stage 3 (C-32), spec
 * section 6. If you change it here, the other two copies are now wrong, and
 * without this pin nothing would tell you.
 *
 * WHAT IS COPIED AND WHY. The file names the two tokens a daemon declares
 * (`sessions_library`, `stop_pauses_mission`), the three Sessions ops that
 * ride the voice_rpc frame, the reason this daemon writes when an owner Stop
 * pauses a mission, the two stop confirmations, the Resume sentence, the
 * limits and the refusal codes. A drift on either side is silent: a token
 * spelled differently is stored and never matched, an op spelled differently
 * is dropped by a normalizer, and a reason spelled differently is never
 * resumed by this daemon and never localised by the app. So the spelling is
 * held by a hash.
 *
 * THE OTHER HALVES. BGOS
 * backend/src/integrations/session-controls-contract.pin.spec.ts and
 * bgos-claude-plugin test/session-controls-contract.pin.test.ts pin the SAME
 * digest on their copies. No repo's CI can read another, which is why each
 * side carries the literal.
 *
 * WHEN THIS FAILS, and it is meant to, the fix is not to silence it:
 *   1. Make the same edit to the BGOS copy and the Claude copy, so the three
 *      files are byte for byte identical (LF, no BOM).
 *   2. Put the new sha256 in SHA256 below AND in both other pin specs.
 *   3. Ship all three in one set of PRs. A change in one tree only is the
 *      defect this exists to catch.
 *
 * MUTATION PROOF (recorded 2026-09-25 through the P6 test lock, file restored
 * byte for byte and re-hashed to the digest below): one byte flipped in THIS
 * copy (`Stopped by you` to `Stopped by yon` in the STOP_PAUSE_REASON
 * literal, line 83) -> 2 of 9 red: "still has the bytes BGOS and the Claude
 * plugin are pinned to" and "carries the stop words and the Resume sentence
 * exactly".
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as contract from "../src/session-controls-contract.js";
import {
  LIST_SESSIONS,
  RENAME_SESSION,
  RESUME_SESSION,
  RESUME_TURN_TEXT,
  SESSION_BRANCH_MAX,
  SESSION_CONTROL_TOKENS,
  SESSION_ERROR_CODES,
  SESSION_ID_PATTERN,
  SESSION_OPS,
  SESSION_PREVIEW_MAX,
  SESSION_QUERY_MAX,
  SESSION_RENAME_MAX,
  SESSION_TITLE_MAX,
  SESSIONS_LIBRARY,
  SESSIONS_LIST_MAX,
  STOP_CONFIRMATION_COOPERATIVE,
  STOP_CONFIRMATION_HARD,
  STOP_PAUSE_REASON,
  STOP_PAUSES_MISSION,
} from "../src/session-controls-contract.js";

/** The digest the BGOS and Claude plugin pins hold too. */
const SHA256 =
  "5dccdd879c095f79c3b495fc26d39703dc8fb1454adc16f3fe991ebb6dd3e448";

const FILE = fileURLToPath(
  new URL("../src/session-controls-contract.ts", import.meta.url),
);
const GITATTRIBUTES = fileURLToPath(new URL("../.gitattributes", import.meta.url));

// backend/src/dto/integrations/pair-exchange.dto.ts CAPABILITY_TOKEN_REGEX
const TOKEN_GRAMMAR = /^[a-z][a-z0-9_]{0,63}$/;

/** An en dash or an em dash, spelled as escapes so this file carries neither. */
const DASH = new RegExp("[\\u2013\\u2014]");

describe("the session controls contract shared with BGOS and the Claude plugin", () => {
  it("still has the bytes BGOS and the Claude plugin are pinned to", () => {
    const digest = createHash("sha256").update(readFileSync(FILE)).digest("hex");
    expect({ file: "session-controls-contract.ts", digest }).toEqual({
      file: "session-controls-contract.ts",
      digest: SHA256,
    });
  });

  it("names exactly sessions_library and stop_pauses_mission, in that order, in the token grammar", () => {
    expect([...SESSION_CONTROL_TOKENS]).toEqual([
      "sessions_library",
      "stop_pauses_mission",
    ]);
    expect(SESSIONS_LIBRARY).toBe("sessions_library");
    expect(STOP_PAUSES_MISSION).toBe("stop_pauses_mission");
    expect(Object.isFrozen(SESSION_CONTROL_TOKENS)).toBe(true);
    for (const token of SESSION_CONTROL_TOKENS) {
      expect(token, token).toMatch(TOKEN_GRAMMAR);
    }
  });

  it("spells the three ops, and nothing else rides the list", () => {
    expect([...SESSION_OPS]).toEqual([
      "list_sessions",
      "resume_session",
      "rename_session",
    ]);
    expect([LIST_SESSIONS, RESUME_SESSION, RENAME_SESSION]).toEqual([
      "list_sessions",
      "resume_session",
      "rename_session",
    ]);
    expect(Object.isFrozen(SESSION_OPS)).toBe(true);
  });

  it("carries the stop words and the Resume sentence exactly, with no dash in any of them", () => {
    expect(STOP_PAUSE_REASON).toBe("Stopped by you");
    expect(STOP_CONFIRMATION_HARD).toBe("Stopped.");
    expect(STOP_CONFIRMATION_COOPERATIVE).toBe("Asked to stop.");
    expect(RESUME_TURN_TEXT).toBe("Continue from where you stopped.");
    // Plain text on every channel: a leading slash would make it a command,
    // and this daemon's own command parser would take it.
    expect(RESUME_TURN_TEXT.startsWith("/")).toBe(false);
    for (const words of [
      STOP_PAUSE_REASON,
      STOP_CONFIRMATION_HARD,
      STOP_CONFIRMATION_COOPERATIVE,
      RESUME_TURN_TEXT,
    ]) {
      expect(words).not.toMatch(DASH);
    }
  });

  it("holds the limits and the refusal codes both sides validate against", () => {
    expect({
      SESSIONS_LIST_MAX,
      SESSION_TITLE_MAX,
      SESSION_PREVIEW_MAX,
      SESSION_BRANCH_MAX,
      SESSION_RENAME_MAX,
      SESSION_QUERY_MAX,
    }).toEqual({
      SESSIONS_LIST_MAX: 50,
      SESSION_TITLE_MAX: 120,
      SESSION_PREVIEW_MAX: 200,
      SESSION_BRANCH_MAX: 60,
      SESSION_RENAME_MAX: 80,
      SESSION_QUERY_MAX: 80,
    });
    expect([...SESSION_ERROR_CODES]).toEqual([
      "busy",
      "not_found",
      "unsupported",
      "invalid",
      "failed",
    ]);
    expect(Object.isFrozen(SESSION_ERROR_CODES)).toBe(true);
    // The id grammar at its edges: a Codex thread id and a Claude session
    // UUID pass; a space, a slash and a 129th character do not.
    expect(SESSION_ID_PATTERN.test("thr_019a:abc-DEF.1")).toBe(true);
    expect(SESSION_ID_PATTERN.test("0b9f5a52-7a0e-4c1f-9d7e-3f2c1b0a9e8d")).toBe(true);
    expect(SESSION_ID_PATTERN.test("a".repeat(128))).toBe(true);
    expect(SESSION_ID_PATTERN.test("a".repeat(129))).toBe(false);
    expect(SESSION_ID_PATTERN.test("")).toBe(false);
    expect(SESSION_ID_PATTERN.test("a b")).toBe(false);
    expect(SESSION_ID_PATTERN.test("../etc")).toBe(false);
  });

  it("exports exactly the values named above, so a new one cannot slip in beside the pin", () => {
    expect(Object.keys(contract).sort()).toEqual(
      [
        "LIST_SESSIONS",
        "RENAME_SESSION",
        "RESUME_SESSION",
        "RESUME_TURN_TEXT",
        "SESSION_BRANCH_MAX",
        "SESSION_CONTROL_TOKENS",
        "SESSION_ERROR_CODES",
        "SESSION_ID_PATTERN",
        "SESSION_OPS",
        "SESSION_PREVIEW_MAX",
        "SESSION_QUERY_MAX",
        "SESSION_RENAME_MAX",
        "SESSION_TITLE_MAX",
        "SESSIONS_LIBRARY",
        "SESSIONS_LIST_MAX",
        "STOP_CONFIRMATION_COOPERATIVE",
        "STOP_CONFIRMATION_HARD",
        "STOP_PAUSE_REASON",
        "STOP_PAUSES_MISSION",
      ].sort(),
    );
  });

  it("is erasable TypeScript only, because the Claude plugin strips its copy with node", () => {
    // Every top level statement is an exported const, an interface or a
    // type alias, and nothing else: no enum, namespace, decorator or class.
    const source = ts.createSourceFile(
      FILE,
      readFileSync(FILE, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const offenders: string[] = [];
    for (const statement of source.statements) {
      const modifiers = ts.canHaveModifiers(statement)
        ? ts.getModifiers(statement)
        : undefined;
      const exported = (modifiers ?? []).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      const allowed =
        exported &&
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          (ts.isVariableStatement(statement) &&
            (statement.declarationList.flags & ts.NodeFlags.Const) !== 0));
      if (!allowed) {
        offenders.push(
          `${ts.SyntaxKind[statement.kind]}: ${statement.getText(source).slice(0, 60)}`,
        );
      }
    }
    expect(offenders).toEqual([]);
    // Positive control: the walk saw the file, not an empty parse.
    expect(source.statements.length).toBeGreaterThan(20);
  });

  it("has no imports, no CR and no BOM, so every toolchain reads the same bytes", () => {
    const bytes = readFileSync(FILE);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const code = bytes
      .toString("utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    // This repo's .gitattributes keeps a Windows checkout LF, without which
    // this digest is unreadable on the machines that build.
    expect(readFileSync(GITATTRIBUTES, "utf8")).toMatch(/^\*\s+text=auto eol=lf$/m);
  });

  it("hashes the very file this spec imports, not a copy that merely matches", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).toContain(`export const STOP_PAUSE_REASON = '${STOP_PAUSE_REASON}';`);
    expect(text).toContain(`export const SESSIONS_LIBRARY = '${SESSIONS_LIBRARY}';`);
    expect(text).toContain(
      `export const STOP_PAUSES_MISSION = '${STOP_PAUSES_MISSION}';`,
    );
  });
});
