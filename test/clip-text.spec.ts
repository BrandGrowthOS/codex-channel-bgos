/**
 * One clip for every field this plugin puts on the wire. A bare
 * `slice(0, max)` can cut a surrogate pair in half, and Postgres refuses a
 * lone surrogate inside JSONB, so the backend rejects the whole row rather
 * than drawing it short.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { clipText } from "../src/clip-text.js";

/** Halves of a surrogate pair with no partner. */
function loneSurrogates(text: string): number {
  let lone = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) lone += 1;
      else i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) lone += 1;
  }
  return lone;
}

describe("clipText", () => {
  it("drops the dangling half of a character at the cut", () => {
    // "ab" + 😀 (two code units): a clip at 3 lands between the halves.
    const text = "ab\u{1F600}cd";
    expect(clipText(text, 3)).toBe("ab");
    expect(loneSurrogates(clipText(text, 3))).toBe(0);
    // A clip at 4 keeps the whole pair.
    expect(clipText(text, 4)).toBe("ab\u{1F600}");
    expect(loneSurrogates(clipText(text, 4))).toBe(0);
  });

  it("is never longer than max and never shorter than max - 1", () => {
    const text = "\u{1F600}".repeat(200);
    for (const max of [1, 2, 3, 40, 119, 120, 199, 200]) {
      const clipped = clipText(text, max);
      expect(clipped.length).toBeLessThanOrEqual(max);
      expect(clipped.length).toBeGreaterThanOrEqual(max - 1);
      expect(loneSurrogates(clipped)).toBe(0);
    }
  });

  it("leaves a string that already fits exactly as it is", () => {
    expect(clipText("hello", 5)).toBe("hello");
    expect(clipText("hello", 50)).toBe("hello");
    expect(clipText("", 10)).toBe("");
  });

  it("answers an empty string for a non string, or no room at all", () => {
    expect(clipText(undefined, 10)).toBe("");
    expect(clipText(42, 10)).toBe("");
    expect(clipText({ path: "x" }, 10)).toBe("");
    expect(clipText("hello", 0)).toBe("");
    expect(clipText("hello", -3)).toBe("");
  });

  it("is the clip both senders use", () => {
    for (const file of ["src/activity-markers.ts", "src/tool-progress.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('from "./clip-text.js"');
      // The four bare slices this replaced, so a regression is loud.
      for (const bare of [
        ".slice(0, 16)",
        ".slice(0, 119)",
        ".slice(0, 120)",
        ".slice(0, 200)",
        ".slice(0, max)",
      ]) {
        expect(source).not.toContain(bare);
      }
    }
  });
});
