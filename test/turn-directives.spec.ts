/**
 * The standing directive lines, and the guard that keeps the two framings
 * honest.
 *
 * MUTATION PROOF, run against this tree: dropping `planPolicySentence(...)`
 * from the list in src/turn-directives.ts turns the policy cases red;
 * restoring it turns them green and leaves the file's sha256 unchanged.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { turnDirectiveLines } from "../src/turn-directives.js";

describe("the lines a turn carries above the owner's words", () => {
  it("says nothing when the envelope carried nothing", () => {
    expect(turnDirectiveLines({})).toBe("");
    expect(turnDirectiveLines({ senderGuardrail: "   " })).toBe("");
  });

  it("carries the share guardrail and the plan level, each on its own line", () => {
    const lines = turnDirectiveLines({
      senderGuardrail: "A colleague sent this.",
      planPolicy: "always",
    });
    expect(lines).toBe(
      "A colleague sent this.\n" +
        "Plan policy: always first. Call propose_plan and wait for Go ahead before you change a single file.\n",
    );
  });

  it("carries the labelled sentence the backend really sends", () => {
    // The wire value is the server's whole sentence, not one of three enum
    // words. A framing that dropped it was the shipped defect.
    const lines = turnDirectiveLines({
      planPolicy:
        "Your owner's setting for when you show a plan before you change " +
        "anything. It applies in every chat and on every channel. Typing " +
        "/plan always shows a plan whatever this says, and this is a request " +
        "about how you work rather than something the platform can enforce: " +
        "show a plan first, every time, before you change a single file.",
    });
    expect(lines).toContain("show a plan first, every time");
    expect(lines).toContain("propose_plan");
    expect(lines.endsWith("\n")).toBe(true);
  });

  it("omits a level it was not given rather than inventing one", () => {
    expect(turnDirectiveLines({ planPolicy: "" })).toBe("");
    expect(turnDirectiveLines({ planPolicy: "   " })).toBe("");
  });
});

describe("both of the adapter's turn framings use it", () => {
  /**
   * A SOURCE GUARD, because this is the defect it is guarding against: the
   * ordinary framing and the native command framing were written apart, and
   * the plan policy line was added to one of them. A framing that interpolates
   * `senderGuardrail` by hand is a framing building its own line list again.
   */
  it("neither builds its own line list", () => {
    const source = readFileSync(
      new URL("../src/adapter.ts", import.meta.url),
      "utf8",
    );
    const framings = source
      .split("\n")
      .filter((line) => line.includes("HOAI event: assistant_id="));
    expect(framings).toHaveLength(2);
    for (const framing of framings) {
      expect(framing).toContain("turnDirectiveLines(args)");
      expect(framing).not.toContain("senderGuardrail");
      expect(framing).not.toContain("planPolicy");
    }
  });
});
