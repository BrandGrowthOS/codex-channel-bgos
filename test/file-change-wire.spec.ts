/**
 * The one gate a diff body leaves this machine through.
 *
 * Rule 2 in src/activity-markers.ts is now "a diff body leaves the machine in
 * exactly one case: on a file change approval card, masked by the redactor,
 * cut to 400 lines a file and 64 KB in all, and never on an activity row".
 * This file holds that one case to its own terms. The ROW guard in
 * test/activity-markers.spec.ts is untouched and still asserts the string
 * "diff" never appears in a row.
 *
 * The masker is `src/redact-output.ts`, the thirteen rule port this plugin
 * already ships, used here as a NEW CONSUMER and not re-implemented: the four
 * shapes the spec names are tested against it below so that a rule dropped
 * from the port turns this file red as well as its own.
 *
 * MUTATION PROOFS (each names the source change that must turn it red; run by
 * hand against this tree, restore, and the file hashes identical):
 *  - cut before masking in buildDiffForWire (mask the joined head instead of
 *    the whole patch) -> "counts a secret the cap was going to drop anyway"
 *    goes red, which is the whole reason for the order
 *  - delete the `private_key_block` rule from RULES in redact-output.ts ->
 *    "a private key block" goes red
 *  - delete the `bearer_token` rule -> "a bearer token" goes red
 *  - delete the `generic_secret_assignment` rule -> "an .env style assignment"
 *    goes red
 *  - delete the `connection_string_password` rule -> "a URL with credentials"
 *    goes red
 *  - keep the TAIL of a file instead of the head (call tailClip) -> "keeps the
 *    head of a file and never its tail" goes red
 *  - drop the clipText call on the inside-a-line cut -> "never leaves half a
 *    character behind" goes red
 *  - spend the budget by characters instead of on line boundaries -> "spends
 *    the budget in file order, on line boundaries" goes red
 *  - count added and removed across every change instead of per change ->
 *    "counts added and removed per FILE" goes red
 *  - drop the 20 row cap -> "counts a 21st file and gives it no row" goes red
 *  - let a binary patch through as `ok` -> "says can't preview" goes red
 *  - name the files in `text` and the sentence in `tool` -> "the ask sentence
 *    and the file list are different strings" goes red
 */
import { describe, expect, it } from "vitest";

import {
  APPROVAL_META_BYTES_MAX,
  DIFF_FILES_MAX,
  DIFF_LINES_PER_FILE,
  DIFF_UNITS_TOTAL,
  askSentence,
  buildDiffForWire,
  hiddenLineCount,
  isBinaryPatch,
  toolLines,
  wireChangeKind,
} from "../src/file-change-wire.js";
import { redactOutput } from "../src/redact-output.js";

const CWD = "/work/project";
const ctx = { cwd: CWD, home: "/home/owner" };

function change(path: string, kind: unknown, diff: string) {
  return { path, kind, diff };
}
const HUNK =
  "--- a/calc.py\n" +
  "+++ b/calc.py\n" +
  "@@ -1,3 +1,4 @@\n" +
  " alpha\n" +
  "-beta\n" +
  "+beta (edited)\n" +
  "+delta\n" +
  " gamma\n";

describe("the four secret shapes, against the redactor this plugin already ships", () => {
  it("hides a private key block, body and all, and counts every line of it", () => {
    const patch =
      "@@ -1,5 +1,5 @@\n" +
      "+-----BEGIN RSA PRIVATE KEY-----\n" +
      "+MIIEowIBAAKCAQEAx7Vn9QmM1oMhk2H3Yt7Q0Zr6Bv1cLpNq8sTuVwXyZaBcDeFg\n" +
      "+hIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrS\n" +
      "+-----END RSA PRIVATE KEY-----\n" +
      " keep this line\n";
    const wire = buildDiffForWire([change("secrets.pem", { type: "add" }, patch)], ctx)!;
    const sent = wire.diff!.files[0]!;
    expect(sent.patch).toContain("[private key removed]");
    expect(sent.patch).not.toContain("MIIEowIBAAKCAQEAx7Vn9QmM1oMhk2H3Yt7Q0Zr6Bv1cLpNq8sTuVwXyZaBcDeFg");
    expect(sent.patch).toContain(" keep this line");
    // The BEGIN line, the two body lines and the END line: four, not the one
    // line they became. The count is what the card says out loud.
    expect(sent.hidden_lines).toBe(4);
  });

  it("hides a bearer token and keeps the line around it readable", () => {
    const patch =
      "@@ -1 +1 @@\n" +
      '+  const header = "Bearer abcd1234efgh5678ijkl9012mnop";\n';
    const sent = buildDiffForWire([change("src/auth.ts", "update", patch)], ctx)!.diff!
      .files[0]!;
    expect(sent.patch).not.toContain("abcd1234efgh5678ijkl9012mnop");
    expect(sent.patch).toContain("Bearer abcd...");
    expect(sent.patch).toContain("const header");
    expect(sent.hidden_lines).toBe(1);
  });

  it("hides an .env style assignment whose value is long and high entropy", () => {
    const patch =
      "@@ -1,2 +1,2 @@\n" +
      "-DATABASE_TOKEN=old\n" +
      "+DATABASE_TOKEN=9f2b7c4a1e8d3f6b0c5a2e7d4b1f8c3a\n";
    const sent = buildDiffForWire([change(".env", "update", patch)], ctx)!.diff!.files[0]!;
    expect(sent.patch).not.toContain("9f2b7c4a1e8d3f6b0c5a2e7d4b1f8c3a");
    expect(sent.patch).toContain("DATABASE_TOKEN=9f2b...");
    // The short old value was never a secret worth a rule, so the line the
    // owner needs to read the change survives.
    expect(sent.patch).toContain("-DATABASE_TOKEN=old");
    expect(sent.hidden_lines).toBe(1);
  });

  it("hides the password in a URL with credentials and keeps the scheme and host", () => {
    const patch =
      "@@ -1 +1 @@\n" +
      "+DATABASE_URL=postgres://admin:s3cr3tpassw0rd@db.internal:5432/app\n";
    const sent = buildDiffForWire([change(".env", "update", patch)], ctx)!.diff!.files[0]!;
    expect(sent.patch).not.toContain("s3cr3tpassw0rd");
    expect(sent.patch).toContain("postgres://admin:s3cr...@db.internal:5432/app");
    expect(sent.hidden_lines).toBe(1);
  });

  it("counts a secret the cap was going to drop anyway, because the mask runs first", () => {
    // THE ORDER IS THE CONTRACT. Masking the WHOLE patch before any cut is
    // what makes this number honest: the secret is on line 500, the cap keeps
    // 400, and the owner is still told a line was hidden. Cut first and the
    // rule never sees the line, the count reads zero, and the only thing the
    // card could say about it would be a lie by omission.
    const body: string[] = ["@@ -1,600 +1,600 @@"];
    for (let i = 0; i < 600; i++)
      body.push(i === 499 ? "+API_KEY=9f2b7c4a1e8d3f6b0c5a2e7d4b1f8c3a" : `+line ${i}`);
    const sent = buildDiffForWire([change("src/big.ts", "update", body.join("\n"))], ctx)!
      .diff!.files[0]!;
    expect(sent.hidden_lines).toBe(1);
    expect(sent.truncated).toBe(true);
    expect(sent.omitted_lines).toBe(601 - DIFF_LINES_PER_FILE);
    // And the value itself is nowhere, cut or not.
    expect(sent.patch).not.toContain("9f2b7c4a1e8d3f6b0c5a2e7d4b1f8c3a");
  });

  it("counts nothing hidden in a clean patch, and changes not one character of it", () => {
    const sent = buildDiffForWire([change("calc.py", { type: "update" }, HUNK)], ctx)!
      .diff!.files[0]!;
    expect(sent.hidden_lines).toBe(0);
    expect(sent.patch).toBe(HUNK.replace(/\n$/, ""));
  });
});

describe("hiddenLineCount", () => {
  it("counts a rewritten line once and a removed block whole", () => {
    const raw = "a\nBearer abcd1234efgh5678ijkl9012mnop\nb\n";
    expect(hiddenLineCount(raw, redactOutput(raw))).toBe(1);
    expect(hiddenLineCount("nothing\nto see\n", redactOutput("nothing\nto see\n"))).toBe(0);
  });

  it("counts an unterminated key block to the end of the text", () => {
    const raw = "-----BEGIN PRIVATE KEY-----\nbody one\nbody two";
    expect(hiddenLineCount(raw, redactOutput(raw))).toBe(3);
  });
});

describe("buildDiffForWire: the summary every card carries", () => {
  it("counts added and removed per FILE, and the totals across every change", () => {
    const wire = buildDiffForWire(
      [
        change(`${CWD}/calc.py`, { type: "update" }, HUNK),
        change(`${CWD}/CHANGELOG.md`, { type: "add" }, "@@ -0,0 +1,4 @@\n+a\n+b\n+c\n+d\n"),
      ],
      ctx,
    )!;
    expect(wire.change_summary).toMatchObject({
      file_count: 2,
      total_added: 6,
      total_removed: 1,
    });
    expect(wire.change_summary.files).toEqual([
      { path: "calc.py", kind: "update", added: 2, removed: 1, preview: "ok" },
      { path: "CHANGELOG.md", kind: "add", added: 4, removed: 0, preview: "ok" },
    ]);
  });

  it("shortens an absolute path against the thread's own working directory", () => {
    const wire = buildDiffForWire([change(`${CWD}/src/a.ts`, "update", HUNK)], ctx)!;
    expect(wire.change_summary.files[0]!.path).toBe("src/a.ts");
    // No cwd in hand: the tail with one parent segment, so the row still says
    // where, and never the account name in a leading /Users/<someone>.
    const bare = buildDiffForWire([change("/Users/kc/secret/a.ts", "update", HUNK)], {})!;
    expect(bare.change_summary.files[0]!.path).toBe("secret/a.ts");
  });

  it("counts a 21st file and gives it no row", () => {
    const changes = Array.from({ length: 21 }, (_, i) =>
      change(`f${i}.txt`, { type: "add" }, "@@ -0,0 +1 @@\n+one\n"),
    );
    const wire = buildDiffForWire(changes, ctx)!;
    expect(wire.change_summary.file_count).toBe(21);
    expect(wire.change_summary.total_added).toBe(21);
    expect(wire.change_summary.files).toHaveLength(DIFF_FILES_MAX);
    expect(wire.diff!.files).toHaveLength(DIFF_FILES_MAX);
    // A file with no row is a file left out, and the card says so.
    expect(wire.diff!.truncated).toBe(true);
  });

  it("says can't preview for a binary patch, and offers no diff entry for it", () => {
    const wire = buildDiffForWire(
      [
        change("logo.png", { type: "update" }, "GIT binary patch\nliteral 1234\nzcmZ\n"),
        change("notes.md", { type: "update" }, HUNK),
      ],
      ctx,
    )!;
    expect(wire.change_summary.files[0]).toMatchObject({
      kind: "binary",
      preview: "binary",
    });
    expect(wire.diff!.files.map((f) => f.path)).toEqual(["notes.md"]);
    expect(JSON.stringify(wire)).not.toContain("zcmZ");

    expect(isBinaryPatch("Binary files a/x.png and b/x.png differ\n")).toBe(true);
    expect(isBinaryPatch(HUNK)).toBe(false);
  });

  it("treats a change with no readable body the same way, rather than inventing a word", () => {
    const wire = buildDiffForWire([{ path: "vendor/blob", kind: "update" }], ctx)!;
    expect(wire.change_summary.files[0]).toMatchObject({
      kind: "binary",
      preview: "binary",
      added: 0,
      removed: 0,
    });
    expect(wire.diff).toBeUndefined();
  });

  it("answers null when the item named no file at all, so the card posts as it did before", () => {
    expect(buildDiffForWire([], ctx)).toBeNull();
    expect(buildDiffForWire(undefined, ctx)).toBeNull();
    expect(buildDiffForWire([{ kind: "update", diff: HUNK }], ctx)).toBeNull();
  });
});

describe("buildDiffForWire: the kinds, in both protocol shapes", () => {
  it("reads the app server object and the older string alike", () => {
    expect(wireChangeKind({ type: "add", move_path: null }, false)).toBe("add");
    expect(wireChangeKind("delete", false)).toBe("delete");
    expect(wireChangeKind({ type: "update" }, false)).toBe("update");
    // The one kind the word alone does not tell you.
    expect(wireChangeKind({ type: "update", move_path: "src/b.ts" }, false)).toBe("rename");
    expect(wireChangeKind("rename", false)).toBe("rename");
    // A word this plugin has never heard of is still a change, and refusing
    // the whole card over a sixth word would cost the owner the ask.
    expect(wireChangeKind({ type: "teleport" }, false)).toBe("update");
    expect(wireChangeKind(undefined, false)).toBe("update");
    // Binary wins over every word, because the row cannot be opened either way.
    expect(wireChangeKind({ type: "add" }, true)).toBe("binary");
  });
});

describe("buildDiffForWire: the caps, and the order they are applied in", () => {
  it("keeps the head of a file and never its tail", () => {
    // The opposite of a command's output, and the reason output-tail's
    // tailClip is never called here: a patch's first hunk is what the owner
    // opened the card to read.
    const lines = ["@@ -1,500 +1,500 @@"];
    for (let i = 0; i < 500; i++) lines.push(`+line ${i}`);
    const sent = buildDiffForWire([change("src/big.ts", "update", lines.join("\n"))], ctx)!
      .diff!.files[0]!;
    const kept = sent.patch.split("\n");
    expect(kept).toHaveLength(DIFF_LINES_PER_FILE);
    expect(kept[0]).toBe("@@ -1,500 +1,500 @@");
    expect(kept[1]).toBe("+line 0");
    expect(sent.patch).not.toContain("+line 499");
    expect(sent.truncated).toBe(true);
    expect(sent.omitted_lines).toBe(101);
  });

  it("spends the budget in file order, on line boundaries, and leaves the rest out", () => {
    const wide = (label: string) => {
      const lines = [`@@ ${label} @@`];
      for (let i = 0; i < DIFF_LINES_PER_FILE; i++) lines.push("+".padEnd(200, "x"));
      return lines.join("\n");
    };
    const wire = buildDiffForWire(
      [
        change("first.ts", "update", wide("first")),
        // One line, longer than anything the first file can leave behind.
        change("second.ts", "update", `+${"y".repeat(300)}`),
      ],
      ctx,
    )!;
    const first = wire.diff!.files[0]!;
    expect(wire.diff!.files).toHaveLength(1);
    expect(first.path).toBe("first.ts");
    expect(first.patch.length).toBeLessThanOrEqual(DIFF_UNITS_TOTAL);
    // Whole lines, every one of them: half a line of a patch is noise, and
    // the budget is spent on line boundaries for exactly that reason.
    for (const line of first.patch.split("\n").slice(1))
      expect(line).toHaveLength(200);
    expect(first.truncated).toBe(true);
    // The second file keeps its ROW and its counts and loses only its body:
    // a line that does not fit in what is LEFT might have fit on its own, so
    // a fragment of it would say less than the row already says.
    expect(wire.change_summary.files[1]).toMatchObject({
      path: "second.ts",
      preview: "too_large",
      added: 1,
    });
    expect(wire.diff!.truncated).toBe(true);
  });

  it("never leaves half a character behind when one line is bigger than the whole budget", () => {
    // A minified file is one line. Dropping it whole would send nothing at
    // all, so it is cut INSIDE, and the cut is the only one in this module
    // that can land between the two halves of a surrogate pair. Postgres
    // refuses a lone surrogate inside JSONB and would reject the whole card.
    const line = `+${"a".repeat(DIFF_UNITS_TOTAL - 2)}\u{1D11E}`;
    const sent = buildDiffForWire([change("bundle.js", "update", line)], ctx)!.diff!.files[0]!;
    expect(sent.patch.length).toBeLessThanOrEqual(DIFF_UNITS_TOTAL);
    const last = sent.patch.charCodeAt(sent.patch.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(sent.truncated).toBe(true);
  });

  it("stays under the byte cap the server enforces on the whole column", () => {
    // The two caps are in different units on purpose (UTF-16 units of patch
    // text here, bytes of serialised approvalMeta there), so a patch that is
    // mostly non ASCII satisfies this side and would still be refused with a
    // 400 by that one. A refused create costs the owner the card entirely.
    const lines = ["@@ -1,400 +1,400 @@"];
    for (let i = 0; i < DIFF_LINES_PER_FILE - 1; i++) lines.push(`+${"\u00e9".repeat(160)}`);
    const wire = buildDiffForWire(
      [change("a.txt", "update", lines.join("\n")), change("b.txt", "update", lines.join("\n"))],
      ctx,
    )!;
    const bytes = Buffer.byteLength(
      JSON.stringify({
        change_summary: wire.change_summary,
        diff: wire.diff,
        tool: wire.tool,
      }),
      "utf8",
    );
    expect(bytes).toBeLessThanOrEqual(APPROVAL_META_BYTES_MAX);
    // The plain line survives whatever the body costs: it is the part that is
    // never gated and never cut.
    expect(wire.change_summary.file_count).toBe(2);
  });
});

describe("the two strings the daemon writes", () => {
  it("names the first file and counts the rest", () => {
    expect(askSentence("calc.py", 1)).toBe("Change calc.py");
    expect(askSentence("calc.py", 2)).toBe("Change calc.py and 1 more file");
    expect(askSentence("calc.py", 4)).toBe("Change calc.py and 3 more files");
  });

  it("the ask sentence and the file list are different strings", () => {
    const wire = buildDiffForWire(
      [
        change(`${CWD}/calc.py`, { type: "update" }, HUNK),
        change(`${CWD}/notes.md`, { type: "add" }, "@@ -0,0 +1 @@\n+one\n"),
      ],
      ctx,
    )!;
    // The title is the sentence; the mono panel an older app draws is the
    // list. An app that predates this stage then shows the ask over the paths,
    // which is already better than "Apply file changes" over nothing.
    expect(wire.ask).toBe("Change calc.py and 1 more file");
    expect(wire.tool).toBe("calc.py (update)\nnotes.md (add)");
  });

  it("says how many files the list left out", () => {
    const rows = Array.from({ length: DIFF_FILES_MAX }, (_, i) => ({
      path: `f${i}.txt`,
      kind: "add" as const,
      added: 1,
      removed: 0,
      preview: "ok" as const,
    }));
    expect(toolLines(rows, 22).split("\n").at(-1)).toBe("and 2 more files");
    expect(toolLines(rows, 21).split("\n").at(-1)).toBe("and 1 more file");
    expect(toolLines(rows.slice(0, 1), 1)).toBe("f0.txt (add)");
  });
});
