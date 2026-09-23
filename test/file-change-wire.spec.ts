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
 *  - let `distinctPath` hand a collision straight back -> "gives every row on
 *    the wire its own name" and "numbers two changes to the SAME file" go red
 *  - make `cutFileToBytes` answer false at once (drop the last file instead of
 *    re-cutting it) -> "cuts a mostly non ASCII patch to fit the byte cap" and
 *    "stays under the byte cap" go red
 *  - pass `unreadable` where `binaryBody` goes, so an absent body overwrites
 *    the change kind again -> "keeps the change's own word when the body is
 *    missing" goes red
 *  - stop counting the line the cut landed INSIDE (`head.length - 1`) ->
 *    "draws the cut note on a minified file" goes red
 *  - stop setting `anyLeftOut` on a binary row -> "says a binary file was left
 *    out of the panels" goes red
 *  - drop the `omitted_lines += 1` from cutFileToBytes's inside-a-line branch
 *    -> "counts the line the BYTE cap cut inside" goes red, which is the same
 *    silence the unit cap's own bump exists to prevent
 *  - widen a path collision by exactly ONE parent and then number it ->
 *    "keeps widening past one parent" goes red, and two checkouts of one repo
 *    read as two changes to one file
 *  - drop META_RESERVE_BYTES to 0 -> "counts the line the BYTE cap cut inside"
 *    goes red on its byte assertion, because the block the SERVER weighs
 *    carries four fields this side's own measurement does not
 *  - drop REQUEST_STRINGS_RESERVE_BYTES out of META_RESERVE_BYTES -> "leaves
 *    room for the two strings a request card can carry" goes red, which is the
 *    same failure one stage later: a field added to ApprovalMeta eats the
 *    headroom and the server answers the create with a 400
 *  - call `redactOutput` instead of `redactPatch` in buildDiffForWire (drop
 *    the gutter from the collapsed key block) -> "keeps the gutter of the line
 *    it replaced" goes red, and so does the app's own
 *    diffModel "a collapsed private key block" case
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  APPROVAL_META_BYTES_MAX,
  DIFF_FILES_MAX,
  DIFF_LINES_PER_FILE,
  DIFF_UNITS_TOTAL,
  REQUEST_REASON_MAX_UNITS,
  REQUEST_RULE_TEXT_MAX_UNITS,
  type FileChangeWire,
  askSentence,
  buildDiffForWire,
  hiddenLineCount,
  isBinaryPatch,
  toolLines,
  wireChangeKind,
} from "../src/file-change-wire.js";
import { APPROVAL_HOLD_SECONDS } from "../src/interactions.js";
import { redactOutput, redactPatch } from "../src/redact-output.js";

const CWD = "/work/project";
const ctx = { cwd: CWD, home: "/home/owner" };

/**
 * The block the SERVER measures, which is not the three keys this file builds.
 *
 * `metaBytes` in the source weighs `{change_summary, diff, tool}` and adds
 * META_RESERVE_BYTES as a stand in for the six fields that can ride beside
 * them: stage 1's four, and stage 5's `reason` and `rule_text`. A test that weighs those same three keys asserts only that the
 * implementation agrees with itself, and can never catch the one way that
 * constant fails: a field added to `ApprovalMeta` eats the headroom, the
 * daemon starts posting bodies the server answers with a 400, and a 400 costs
 * the owner the whole card. So every byte cap case here weighs the REAL
 * `approvalMeta`, exactly as `interactions.approve` assembles it.
 */
function approvalMetaBytes(wire: FileChangeWire): number {
  return Buffer.byteLength(
    JSON.stringify({
      tool: wire.tool,
      agent_route: "codex-9",
      risk: "high",
      request_id: randomUUID(),
      wait_seconds: APPROVAL_HOLD_SECONDS,
      change_summary: wire.change_summary,
      diff: wire.diff,
    }),
    "utf8",
  );
}

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

describe("a collapsed key block stays a unified diff line", () => {
  // THE MISMATCH THIS PINS (P2 stage 4 reconciliation). The redactor collapses
  // a private key block into ONE line. Bare, that line is not a diff body
  // line, and the app's `diffModel.parsePatch` ends a hunk at the first line
  // inside it that begins with none of the three body markers, because it may
  // not classify a line by what a header looks like (removing the source line
  // `--` writes the diff line `---`). So a bare placeholder inside a hunk cost
  // the panel EVERY line of that file after the key. The gutter is the fix,
  // and it is one character.
  const KEY_IN_A_HUNK =
    "@@ -1,8 +1,10 @@\n" +
    " alpha\n" +
    "-beta\n" +
    "+beta (edited)\n" +
    "+-----BEGIN RSA PRIVATE KEY-----\n" +
    "+MIIEpAIBAAKCAQEAxq3fL0k2vZ9tN0pQmS1a8dYb2ZrW7cVhTgKqPnLmJoIuHyGf\n" +
    "+EdCbAzYxWvUtSrQpOnMlKjIhGfEdCbAzYxWvUtSrQpOnMlKjIhGfEdCbAzYxWvUt\n" +
    "+-----END RSA PRIVATE KEY-----\n" +
    " gamma\n" +
    "+epsilon\n" +
    " omega\n";

  it("keeps the gutter of the line it replaced, so every body line after it is still a body line", () => {
    const sent = buildDiffForWire(
      [change(`${CWD}/keys.ts`, { type: "update" }, KEY_IN_A_HUNK)],
      ctx,
    )!.diff!.files[0]!;
    const lines = sent.patch.split("\n");
    const at = lines.findIndex((line) => line.includes("[private key removed]"));
    expect(at).toBeGreaterThan(0);
    // The placeholder is an ADDED line, because the block it stands for was
    // added. Not the bare string, which is what shipped before this fix.
    expect(lines[at]).toBe("+[private key removed]");
    expect(lines).not.toContain("[private key removed]");
    // And nothing after it was lost on the wire.
    expect(lines.slice(at + 1)).toEqual([" gamma", "+epsilon", " omega"]);
    // Every line from the first hunk header on begins with a body marker, so
    // a reader that stops at the first one that does not reads the whole file.
    const hunkAt = lines.findIndex((line) => line.startsWith("@@"));
    for (const line of lines.slice(hunkAt + 1)) {
      expect(" +-".includes(line.charAt(0))).toBe(true);
    }
    // The count is still the BLOCK's four lines, not the one they became.
    expect(sent.hidden_lines).toBe(4);
  });

  it("leaves the placeholder bare where there is no gutter to keep", () => {
    // A key printed above the first hunk header has no body marker of its own,
    // and inventing one would be a lie about the format.
    expect(
      redactPatch("-----BEGIN PRIVATE KEY-----\nbody one\n-----END PRIVATE KEY-----\n"),
    ).toContain("\n[private key removed]");
  });

  it("is the one thing that differs from the output masker", () => {
    const raw = "+-----BEGIN PRIVATE KEY-----\n+body one\n+-----END PRIVATE KEY-----";
    expect(redactOutput(raw).split("\n")[1]).toBe("[private key removed]");
    expect(redactPatch(raw).split("\n")[1]).toBe("+[private key removed]");
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

  it("reads the gutter-carrying placeholder as the block it stands for", () => {
    // The count must not change because the placeholder gained a character:
    // it counts the lines the block HAD, not the line it became.
    const raw = "+-----BEGIN PRIVATE KEY-----\n+body one\n+-----END PRIVATE KEY-----\n gamma\n";
    expect(hiddenLineCount(raw, redactPatch(raw))).toBe(3);
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

  it("keeps the change's own word when the body is missing, and still offers no panel", () => {
    // A body that is a binary MARKER makes the kind `binary`. A body that is
    // simply absent says nothing about the change: a delete is still a delete
    // and that word is the one thing the owner needs off this card. Both are
    // unreadable, so both say `can't preview` and neither opens.
    const wire = buildDiffForWire(
      [
        { path: "old.ts", kind: { type: "delete" }, diff: "" },
        { path: "moved.ts", kind: { type: "update", move_path: "elsewhere.ts" } },
        { path: "vendor/blob", kind: { type: "teleport" }, diff: { not: "a string" } },
      ],
      ctx,
    )!;
    expect(wire.change_summary.files).toEqual([
      { path: "old.ts", kind: "delete", added: 0, removed: 0, preview: "binary" },
      { path: "moved.ts", kind: "rename", added: 0, removed: 0, preview: "binary" },
      { path: "vendor/blob", kind: "update", added: 0, removed: 0, preview: "binary" },
    ]);
    expect(wire.tool).toBe("old.ts (delete)\nmoved.ts (rename)\nvendor/blob (update)");
    expect(wire.diff).toBeUndefined();
  });

  it("gives every row on the wire its own name, because the app joins on it", () => {
    // `shortenPath` keeps the basename and ONE parent outside the cwd, so two
    // repositories collapse onto one string. The app finds a row's patch by
    // that string, so a collision would open the FIRST file's change under the
    // SECOND file's name, on the one card that asks the owner to authorise it.
    const wire = buildDiffForWire(
      [
        change("/repo-one/src/index.ts", { type: "update" }, "@@ -1 +1 @@\n-one\n+ONE\n"),
        change("/repo-two/src/index.ts", { type: "update" }, "@@ -1 +1 @@\n-two\n+TWO\n"),
      ],
      { home: "/home/owner" },
    )!;
    const names = wire.change_summary.files.map((f) => f.path);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(["src/index.ts", "repo-two/src/index.ts"]);
    // The two lists are written from one row, so they carry the same string,
    // and each name resolves to its OWN patch the way the app resolves it.
    expect(wire.diff!.files.map((f) => f.path)).toEqual(names);
    for (const [i, name] of names.entries())
      expect(wire.diff!.files.find((f) => f.path === name)!.patch).toContain(
        i === 0 ? "+ONE" : "+TWO",
      );
  });

  it("keeps widening past one parent, because three checkouts of one repo is ordinary", () => {
    // `shortenPath` keeps the basename and ONE parent, so three checkouts of
    // one repository collapse onto one string. Widening by exactly one parent
    // and then NUMBERING gave `src/i.ts`, `proj/src/i.ts` and `src/i.ts (2)`,
    // so two DIFFERENT files read on the card as two changes to one file, on
    // the one card whose whole job is to say what the owner is authorising.
    // The numbering is for what its own sentence says: the SAME file twice.
    const wire = buildDiffForWire(
      [
        change("/a/proj/src/i.ts", { type: "update" }, "@@ -1 +1 @@\n-a\n+A\n"),
        change("/b/proj/src/i.ts", { type: "update" }, "@@ -1 +1 @@\n-b\n+B\n"),
        change("/c/proj/src/i.ts", { type: "update" }, "@@ -1 +1 @@\n-c\n+C\n"),
      ],
      { home: "/home/owner" },
    )!;
    const names = wire.change_summary.files.map((f) => f.path);
    expect(names).toEqual(["src/i.ts", "proj/src/i.ts", "c/proj/src/i.ts"]);
    expect(new Set(names).size).toBe(3);
    // Not a numbered row anywhere: every one of them is a different file.
    for (const name of names) expect(name).not.toContain("(2)");
    for (const [i, name] of names.entries())
      expect(wire.diff!.files.find((f) => f.path === name)!.patch).toContain(
        ["+A", "+B", "+C"][i]!,
      );
  });

  it("numbers two changes to the SAME file, which no parent segment can separate", () => {
    // The runtime does announce a rewrite and the rename of one file as two
    // changes. There is no longer tail to fall back on, so the row is numbered
    // rather than left to shadow the other one.
    const wire = buildDiffForWire(
      [
        change(`${CWD}/a.ts`, { type: "update" }, "@@ -1 +1 @@\n-first\n+FIRST\n"),
        change(`${CWD}/a.ts`, { type: "update", move_path: "b.ts" }, "@@ -1 +1 @@\n-second\n+SECOND\n"),
      ],
      ctx,
    )!;
    expect(wire.change_summary.files.map((f) => f.path)).toEqual(["a.ts", "a.ts (2)"]);
    expect(wire.change_summary.files[1]!.kind).toBe("rename");
    expect(wire.diff!.files.find((f) => f.path === "a.ts (2)")!.patch).toContain("+SECOND");
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

  it("draws the cut note on a minified file, because a line cut inside is a line not sent", () => {
    // One line, longer than the whole budget, cut INSIDE it. The app's note
    // reads `omitted_lines` and nothing else, so leaving the count at zero
    // made this cut silent: a patch that stops mid line with no note, at the
    // one moment the design asks to be loud.
    const sent = buildDiffForWire(
      [change("bundle.js", "update", `+${"a".repeat(DIFF_UNITS_TOTAL + 500)}`)],
      ctx,
    )!.diff!.files[0]!;
    expect(sent.truncated).toBe(true);
    expect(sent.omitted_lines).toBeGreaterThan(0);
  });

  it("says a binary file was left out of the panels", () => {
    // `diff.truncated` means the panels are not the whole change, and a file
    // nobody can preview keeps its row and rides no panel at all.
    const wire = buildDiffForWire(
      [
        change("logo.png", { type: "update" }, "GIT binary patch\nliteral 12\nzcmZ\n"),
        change("notes.md", { type: "update" }, HUNK),
      ],
      ctx,
    )!;
    expect(wire.diff!.files).toHaveLength(1);
    expect(wire.diff!.truncated).toBe(true);
  });

  it("cuts a mostly non ASCII patch to fit the byte cap instead of losing it whole", () => {
    // 400 lines of Arabic: well inside the line cap and inside the unit cap,
    // and two bytes a character past the column's byte cap. The loop used to
    // POP whole files, so the one file on this card lost its panel entirely
    // and tens of thousands of units of headroom went unspent. An AR file is
    // an ordinary edit in a product that ships AR beside EN.
    const lines: string[] = [];
    for (let i = 0; i < DIFF_LINES_PER_FILE; i++) lines.push(`+${"\u0639".repeat(130)}`);
    const wire = buildDiffForWire([change("ar.md", "update", lines.join("\n"))], ctx)!;
    const sent = wire.diff!.files[0]!;
    expect(wire.change_summary.files[0]!.preview).toBe("ok");
    expect(sent.patch.length).toBeGreaterThan(0);
    expect(sent.patch.startsWith("+\u0639")).toBe(true);
    expect(sent.truncated).toBe(true);
    expect(sent.omitted_lines).toBeGreaterThan(0);
    expect(approvalMetaBytes(wire)).toBeLessThanOrEqual(APPROVAL_META_BYTES_MAX);
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
    expect(approvalMetaBytes(wire)).toBeLessThanOrEqual(APPROVAL_META_BYTES_MAX);
    // Under the cap AND still there: an absent diff satisfies a byte cap
    // trivially, which is how a one file card once lost its whole panel here.
    expect(wire.diff!.files.length).toBeGreaterThan(0);
    expect(wire.diff!.files[0]!.patch.length).toBeGreaterThan(0);
    // The plain line survives whatever the body costs: it is the part that is
    // never gated and never cut.
    expect(wire.change_summary.file_count).toBe(2);
  });

  it("counts the line the BYTE cap cut inside, so a minified file still says it was cut", () => {
    // ONE line of 60,000 Arabic characters: inside the 65,536 unit cap, and
    // twice the 96 KB byte cap. So the unit cut never fires and the only cut
    // that does is the byte one, landing INSIDE the single line. That path
    // used to set `truncated` and leave `omitted_lines` at zero, and the app
    // draws "Cut short: {n} more lines not sent" from that number alone, so
    // the card fell back to the weaker note that cannot say how much is
    // missing. A line that arrived in pieces did not arrive.
    const wire = buildDiffForWire(
      [change("bundle.min.js", "update", `+${"\u0639".repeat(60_000)}`)],
      ctx,
    )!;
    const sent = wire.diff!.files[0]!;
    expect(sent.patch.length).toBeLessThan(60_001);
    expect(sent.truncated).toBe(true);
    expect(sent.omitted_lines).toBeGreaterThan(0);
    // Counted ONCE, however many byte passes the cut took.
    expect(sent.omitted_lines).toBe(1);
    // And the block the server weighs still fits, which is what makes this the
    // case that catches a stale META_RESERVE_BYTES: the cut lands on the cap
    // exactly, so the stage 1 fields have nowhere to hide.
    expect(approvalMetaBytes(wire)).toBeLessThanOrEqual(APPROVAL_META_BYTES_MAX);
  });

  it("leaves room for the two strings a request card can carry, at their worst", () => {
    // The two stage 5 strings do NOT ride a file change card today: a file
    // change request carries no exec policy amendment, so no always tier and
    // no rule, and its `reason` arrives as an explicit null. They are counted
    // anyway, because the reserve is this file's stand in for every
    // ApprovalMeta field it does not weigh and the ONE way that constant fails
    // is a field being added to the interface and quietly eating the headroom:
    // the daemon then posts a body the server answers with a 400 and the owner
    // loses the whole card. A field that exists is a field that can ride.
    //
    // Worst case on purpose. A control character leaves JSON.stringify as the
    // six byte escape `\u0001`, which is the most one UTF-16 unit can cost
    // inside a JSON string; a three byte BMP character costs three and a
    // surrogate pair four bytes for its two units.
    const wire = buildDiffForWire(
      [change("bundle.min.js", "update", `+${"\u0639".repeat(60_000)}`)],
      ctx,
    )!;
    const bytes = Buffer.byteLength(
      JSON.stringify({
        tool: wire.tool,
        agent_route: "codex-9",
        risk: "high",
        request_id: randomUUID(),
        wait_seconds: APPROVAL_HOLD_SECONDS,
        change_summary: wire.change_summary,
        diff: wire.diff,
        reason: "\u0001".repeat(REQUEST_REASON_MAX_UNITS),
        rule_text: "\u0001".repeat(REQUEST_RULE_TEXT_MAX_UNITS),
      }),
      "utf8",
    );
    expect(bytes).toBeLessThanOrEqual(APPROVAL_META_BYTES_MAX);
    // Still a panel underneath all that, which is what makes the case mean
    // something: an absent diff satisfies a byte cap trivially.
    expect(wire.diff!.files[0]!.patch.length).toBeGreaterThan(0);
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

/**
 * THE TWO SHAPES THE BACKEND NOW REFUSES OUTRIGHT, PINNED ON THIS SIDE TOO.
 *
 * The server's `ApprovalMetaDto` gained two constraints after this stage's
 * review: `DiffRidesWithSummary` refuses a `diff.files[]` entry whose `path`
 * is not on a summary row whose `preview` is `ok`, and
 * `SummaryPathsAreDistinct` refuses two rows naming one file. Both were
 * already this builder's rules and neither was checked anywhere; both are now
 * a 400, and a 400 costs the owner the whole card, so what used to be a card
 * that drew oddly is now a card that does not arrive.
 *
 * Asserted as an INVARIANT over cards built by the paths that can actually
 * break it rather than as one more example, because the shape that would break
 * it is the byte cap's `dropLast`: it pops the last diff entry and flips the
 * last `ok` row to `too_large`, so a drop that moved one and not the other
 * leaves exactly the orphan the server refuses.
 */
describe("every card this builder writes is one the server will accept", () => {
  const drawable = (wire: FileChangeWire) => {
    const paths = wire.change_summary.files.map((f) => f.path);
    // SummaryPathsAreDistinct: the app pairs a row to its patch with a find on
    // this string, so two rows sharing one open the same change twice.
    expect(new Set(paths).size).toBe(paths.length);
    const openable = new Set(
      wire.change_summary.files.filter((f) => f.preview === "ok").map((f) => f.path),
    );
    // DiffRidesWithSummary: a patch whose path is on no openable row has no
    // button anywhere on the card, so it is bytes nothing can reach.
    for (const file of wire.diff?.files ?? []) expect(openable.has(file.path)).toBe(true);
    // And the other direction, which is this builder's own rule rather than
    // the server's: an `ok` row promises a patch, so the two lists pair up
    // exactly and neither side carries a name the other does not.
    expect(wire.diff?.files.map((f) => f.path) ?? []).toEqual([...openable]);
  };

  const big = (lines: number) => {
    const body = ["@@ -1,400 +1,400 @@"];
    for (let i = 0; i < lines; i++) body.push(`+${"\u00e9".repeat(160)}`);
    return body.join("\n");
  };

  it("a plain two file card", () => {
    drawable(
      buildDiffForWire(
        [
          change(`${CWD}/calc.py`, { type: "update" }, HUNK),
          change(`${CWD}/notes.md`, { type: "add" }, "@@ -0,0 +1 @@\n+one\n"),
        ],
        ctx,
      )!,
    );
  });

  it("a card with a binary row, which offers no entry at all", () => {
    drawable(
      buildDiffForWire(
        [
          change("logo.png", { type: "update" }, "GIT binary patch\nliteral 1234\nzcmZ\n"),
          change("notes.md", { type: "update" }, HUNK),
        ],
        ctx,
      )!,
    );
  });

  it("a card the BYTE cap dropped files from, which is the shape that can orphan one", () => {
    // Four heavy files: the loop drops from the end until the block fits, and
    // every drop has to flip its row to `too_large` in the same step.
    const wire = buildDiffForWire(
      Array.from({ length: 4 }, (_, i) => change(`${CWD}/f${i}.txt`, "update", big(200))),
      ctx,
    )!;
    expect(wire.change_summary.files.some((f) => f.preview === "too_large")).toBe(true);
    expect(approvalMetaBytes(wire)).toBeLessThanOrEqual(APPROVAL_META_BYTES_MAX);
    drawable(wire);
  });

  it("a card whose rows were disambiguated, including the numbered one", () => {
    drawable(
      buildDiffForWire(
        [
          change("/repo-one/src/index.ts", { type: "update" }, "@@ -1 +1 @@\n-one\n+ONE\n"),
          change("/repo-two/src/index.ts", { type: "update" }, "@@ -1 +1 @@\n-two\n+TWO\n"),
          change(`${CWD}/a.ts`, { type: "update" }, "@@ -1 +1 @@\n-first\n+FIRST\n"),
          change(
            `${CWD}/a.ts`,
            { type: "update", move_path: "b.ts" },
            "@@ -1 +1 @@\n-second\n+SECOND\n",
          ),
        ],
        { home: "/home/owner", cwd: CWD },
      )!,
    );
  });

  it("a card with more files than either list may carry", () => {
    drawable(
      buildDiffForWire(
        Array.from({ length: DIFF_FILES_MAX + 3 }, (_, i) =>
          change(`${CWD}/f${i}.ts`, "update", "@@ -1 +1 @@\n-a\n+A\n"),
        ),
        ctx,
      )!,
    );
  });
});
