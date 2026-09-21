/**
 * How many lines an edit put in and took out.
 *
 * The app server protocol carries NO line counts: a `fileChange` item is
 * `{ id, changes, status }` and every change is `{ path, kind, diff }`, so the
 * plugin counts or nobody does. Two integers leave this machine; the patch
 * body never does.
 *
 * MUTATION PROOFS (each test names the change that must turn it red):
 *  - drop the "+++" and "---" guard -> "never the file headers" goes red
 *  - set a count to 1 per diff instead of adding -> "every line of a pure add" goes red
 *  - drop the non string guard -> "zero and zero for nothing it can read" goes red
 *  - count only changes[0] -> "sums across every change" goes red
 *  - set both counts even at zero -> "absent when there is nothing to count" goes red
 *  - count on the patchUpdated arm -> "from the completed item and nowhere else" goes red
 *  - skip the header prefixes inside a hunk -> "a body line of its own" goes red
 *  - count on the phase alone -> "a change that never landed" goes red
 *  - send a count past the ceiling -> "past the ceiling the wire accepts" goes red
 */
import { describe, expect, it } from "vitest";

import {
  countDiffLines,
  entryFromItem,
  rowFromProgressNotification,
} from "../src/activity-markers.js";
import { LINE_COUNT_MAX } from "../src/tool-progress.js";

const UNIFIED =
  "--- a/src/a.ts\n" +
  "+++ b/src/a.ts\n" +
  "@@ -1,3 +1,3 @@\n" +
  " keep me\n" +
  "-old line\n" +
  "+new line\n" +
  "\\ No newline at end of file\n";

function editItem(
  changes: unknown[],
  status = "completed",
): Record<string, unknown> {
  return { id: "fc1", type: "fileChange", status, changes };
}

describe("countDiffLines", () => {
  it("counts the changed lines and never the file headers", () => {
    expect(countDiffLines(UNIFIED)).toEqual({ added: 1, removed: 1 });
  });

  it("counts every line of a pure add", () => {
    expect(countDiffLines("+one\n+two\n+three\n")).toEqual({
      added: 3,
      removed: 0,
    });
    expect(countDiffLines("-one\n-two\n")).toEqual({ added: 0, removed: 2 });
  });

  it("counts a body line of its own that begins with two pluses or minuses", () => {
    // A unified diff prepends ONE character to a source line, so a SQL or Lua
    // comment arrives as `---` and a C style increment as `+++`. Only the
    // header lines before the first hunk are skipped.
    expect(countDiffLines("@@ -1 +1 @@\n++i;\n")).toEqual({
      added: 1,
      removed: 0,
    });
    expect(countDiffLines("@@ -1 +1 @@\n--i;\n")).toEqual({
      added: 0,
      removed: 1,
    });

    const sql =
      "--- a/q.sql\n" +
      "+++ b/q.sql\n" +
      "@@ -1,4 +1,3 @@\n" +
      "-- first comment\n" +
      "--- drop this comment\n" +
      " SELECT 1;\n" +
      "+++i;\n" +
      "+ok;\n";
    expect(countDiffLines(sql)).toEqual({ added: 2, removed: 2 });

    // A diff that never opens a hunk is headers only, and headers are not
    // lines an edit moved.
    expect(countDiffLines("--- a/q.sql\n+++ b/q.sql\n")).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it("answers zero and zero for nothing it can read", () => {
    expect(countDiffLines("")).toEqual({ added: 0, removed: 0 });
    expect(countDiffLines(undefined)).toEqual({ added: 0, removed: 0 });
    expect(countDiffLines(" context only\n@@ -1 +1 @@\n")).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

describe("an edit row's line counts", () => {
  it("sums across every change, not only the one the row names", () => {
    const row = entryFromItem(
      editItem([
        { path: "src/a.ts", kind: { type: "update" }, diff: UNIFIED },
        { path: "src/b.ts", kind: { type: "add" }, diff: "+one\n+two\n" },
      ]),
      "completed",
    )!;
    expect(row.card.linesAdded).toBe(3);
    expect(row.card.linesRemoved).toBe(1);
    // The body itself still never leaves the machine.
    expect(JSON.stringify(row)).not.toContain("new line");
    expect(JSON.stringify(row)).not.toContain("diff");
  });

  it("leaves both absent when there is nothing to count", () => {
    const empty = entryFromItem(editItem([]), "completed")!;
    expect(empty.card).not.toHaveProperty("linesAdded");
    expect(empty.card).not.toHaveProperty("linesRemoved");

    const noDiff = entryFromItem(
      editItem([{ path: "src/a.ts", kind: "update" }]),
      "completed",
    )!;
    expect(noDiff.card).not.toHaveProperty("linesAdded");
    expect(noDiff.card).not.toHaveProperty("linesRemoved");

    // An add with nothing removed carries the one count it measured.
    const addOnly = entryFromItem(
      editItem([{ path: "src/a.ts", kind: { type: "add" }, diff: "+one\n" }]),
      "completed",
    )!;
    expect(addOnly.card.linesAdded).toBe(1);
    expect(addOnly.card).not.toHaveProperty("linesRemoved");
  });

  it("counts nothing for a change that never landed", () => {
    // The owner refused the patch, or it did not apply. The row is drawn, in
    // its error colour, and it claims no lines: the folded head sums the
    // counted rows, so a count here reads as an edit that happened.
    for (const status of ["declined", "failed", "interrupted"]) {
      const row = entryFromItem(
        editItem(
          [{ path: "src/a.ts", kind: { type: "update" }, diff: UNIFIED }],
          status,
        ),
        "completed",
      )!;
      expect(row.card.status).toBe("error");
      expect(row.card.path).toBe("src/a.ts");
      expect(row.card).not.toHaveProperty("linesAdded");
      expect(row.card).not.toHaveProperty("linesRemoved");
    }

    // The same item completed carries both counts, so the case above is the
    // status and nothing else.
    const landed = entryFromItem(
      editItem([{ path: "src/a.ts", kind: { type: "update" }, diff: UNIFIED }]),
      "completed",
    )!;
    expect(landed.card.linesAdded).toBe(1);
    expect(landed.card.linesRemoved).toBe(1);
  });

  it("leaves both counts absent past the ceiling the wire accepts", () => {
    // The platform declares an integer from zero to a million on both counts
    // and refuses the WHOLE patch above it, which costs the card for the rest
    // of the turn. A generated file rewritten in one apply_patch reaches it.
    const huge = "@@ -0,0 +1,1000001 @@\n" + "+x\n".repeat(LINE_COUNT_MAX + 1);
    expect(countDiffLines(huge)).toEqual({
      added: LINE_COUNT_MAX + 1,
      removed: 0,
    });

    const row = entryFromItem(
      editItem([{ path: "src/generated.ts", kind: { type: "update" }, diff: huge }]),
      "completed",
    )!;
    // Both, not only the one over the line: half a pair reads as a measured
    // zero on the other half.
    expect(row.card).not.toHaveProperty("linesAdded");
    expect(row.card).not.toHaveProperty("linesRemoved");
    expect(row.card.path).toBe("src/generated.ts");
  });

  it("takes its counts from the completed item and from nowhere else", () => {
    const running = entryFromItem(
      { ...editItem([{ path: "src/a.ts", kind: "update", diff: UNIFIED }]) },
      "started",
    )!;
    expect(running.card).not.toHaveProperty("linesAdded");
    expect(running.card).not.toHaveProperty("linesRemoved");

    // A number that ticks up mid flight and then changes is a number the
    // owner learns to distrust, so a live patch update sends none.
    const patched = rowFromProgressNotification(
      "item/fileChange/patchUpdated",
      {
        threadId: "thread-1",
        itemId: "fc1",
        changes: [{ path: "src/a.ts", kind: "update", diff: UNIFIED }],
      },
    )!;
    expect(patched.card).not.toHaveProperty("linesAdded");
    expect(patched.card).not.toHaveProperty("linesRemoved");
  });
});
