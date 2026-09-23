/**
 * The one gate through which a diff BODY leaves this machine.
 *
 * Rule 2 in `activity-markers.ts` used to read "a diff body never leaves the
 * machine". It now reads: a diff body leaves the machine in exactly one case:
 * on a file change approval card, masked by the redactor, cut to 400 lines a
 * file and 64 KB in all, and never on an activity row. THIS FILE IS THAT ONE
 * CASE, and the only caller is `interactions.approve` on
 * `item/fileChange/requestApproval`. An activity row still carries a path, a
 * change word and two integers and nothing else, and the guard in
 * `test/activity-markers.spec.ts` that asserts the string "diff" never appears
 * in a ROW is deliberately left alone.
 *
 * Why the exception is narrow enough to be worth making: the card is the one
 * surface where the owner is asked to AUTHORIZE a change, and today it says
 * the literal "Apply file changes" with no path, no count and no kind, while
 * the activity trail beside it already names the file. A person cannot answer
 * a question that does not say what it is asking.
 *
 * THE ORDER IS THE CONTRACT, and it is the same one `output-tail.ts` states
 * for command output, applied to the other end of the string:
 *
 *  1. MASK the WHOLE patch (`redactPatch`), before anything is cut. A cut
 *     first hands a rule half a token: the anchor it matches on (`Bearer `,
 *     `KEY=`) is sliced off, the pattern stops matching, and the rest of the
 *     value ships in the clear. Masking first also means `hidden_lines` is
 *     counted over the whole file, so a secret past line 400 is still
 *     reported even though the line itself was never going to be sent.
 *     `redactPatch` and not `redactOutput`: the two differ by ONE character,
 *     the gutter a collapsed private key block keeps, and that character is
 *     what keeps the masked text a unified diff the app can still parse past
 *     the block. `redact-output.ts` says what goes wrong without it.
 *  2. CUT the HEAD. A diff's meaning is at its START (the first hunk is what
 *     the owner reads), which is the opposite of a command's output, so
 *     `tailClip` from `output-tail.ts` is the wrong helper here and is never
 *     called: at most 400 lines a file, then at most 65,536 UTF-16 units of
 *     patch text across the whole card, spent in file order on LINE
 *     boundaries. `clipText` is the head clip and its surrogate guard is the
 *     one that matters here, because a cut inside a line is the only cut that
 *     can split a surrogate pair and Postgres refuses a lone surrogate inside
 *     JSONB.
 *
 * The daemon's cap and the server's cap are in DIFFERENT UNITS on purpose
 * (65,536 UTF-16 units of patch text here, 98,304 bytes of serialised
 * `approvalMeta` there), so a patch that is mostly non ASCII can satisfy this
 * one and still be refused by that one, and a refused create costs the owner
 * the whole card and the agent its answer. The loop at the end of
 * `buildDiffForWire` is this side's insurance: it never sends more than the
 * caps above allow, and when the serialised form would not have been accepted
 * it sends LESS, by dropping trailing files and then by re-cutting the last
 * one that survives. It drops the panel only when not one readable character
 * of it fits, because the plain line is the part that always has to arrive.
 */
import { clipText } from "./clip-text.js";
import {
  changeKindWord,
  countDiffLines,
  shortenPath,
  type ItemContext,
} from "./activity-markers.js";
import { redactPatch } from "./redact-output.js";
import type {
  ChangeKind,
  ChangeSummary,
  ChangeSummaryFile,
  DiffWire,
  DiffWireFile,
} from "./types.js";

/** Rows in `change_summary.files` and entries in `diff.files`. */
export const DIFF_FILES_MAX = 20;
/** Lines of ONE file's patch that may be sent. The head, never the tail. */
export const DIFF_LINES_PER_FILE = 400;
/** UTF-16 units of patch text across the whole card. */
export const DIFF_UNITS_TOTAL = 65_536;
/**
 * The server's own cap on the serialised `approvalMeta` column, in BYTES. A
 * body past it is refused with a 400, which costs the card, so this side stays
 * under it rather than discovering it.
 */
export const APPROVAL_META_BYTES_MAX = 98_304;
/**
 * UTF-16 units of `approvalMeta.reason`, the agent's own plain words for WHY
 * it is asking, and of `approvalMeta.rule_text`, what an always answer would
 * save. The backend's DTO REFUSES a longer string rather than clipping it, so
 * the writer clips to these and this file counts what it clipped to.
 *
 * They live here, beside the column's byte cap, because the byte accounting
 * below is the only thing in this repo that has to know both numbers at once;
 * `interactions.ts` imports them for the clip and cannot export them back
 * (this module is its dependency, not the other way round).
 */
export const REQUEST_REASON_MAX_UNITS = 280;
export const REQUEST_RULE_TEXT_MAX_UNITS = 500;
/**
 * Bytes ONE UTF-16 unit can cost inside a serialised JSON string, worst case.
 * Six, because a control character leaves `JSON.stringify` as the six byte
 * escape `\u0001`; a three byte BMP character costs three and a surrogate PAIR
 * costs four bytes for its two units, so neither reaches this.
 */
const JSON_STRING_BYTES_PER_UNIT = 6;
/** `"reason":"",` and `"rule_text":"",`: the keys, quotes and separators. */
const REQUEST_STRING_KEY_BYTES = 32;
/**
 * What the two request card strings can take out of the column between them.
 *
 * They do NOT ride a file change card today: a file change request carries no
 * exec policy amendment, so no always tier and no rule, and its `reason`
 * arrives as an explicit null. But the reserve is this file's stand in for
 * every `ApprovalMeta` field it does not weigh, and the ONE way that constant
 * fails is a field being added to the interface and quietly eating the
 * headroom: the daemon then posts a body the server answers with a 400 and the
 * owner loses the whole card. A field that exists is a field that can ride, so
 * it is counted from the day it exists rather than from the day it first does.
 */
const REQUEST_STRINGS_RESERVE_BYTES =
  (REQUEST_REASON_MAX_UNITS + REQUEST_RULE_TEXT_MAX_UNITS) *
    JSON_STRING_BYTES_PER_UNIT +
  REQUEST_STRING_KEY_BYTES;
/**
 * Bytes left for every `approvalMeta` field this file does not weigh: stage
 * 1's four (route, risk, request id, wait) and stage 5's two strings.
 */
const META_RESERVE_BYTES = 1_024 + REQUEST_STRINGS_RESERVE_BYTES;

/** The one line a redacted private key block becomes. */
const PRIVATE_KEY_BODY = "[private key removed]";
/** Any END marker closes the block, whatever the key type says. */
const PRIVATE_KEY_END = "-----END";
/** The three characters a unified diff's body lines begin with. */
const DIFF_GUTTERS = " +-";

/**
 * Is this the one line a key block became? `redactPatch` keeps the gutter of
 * the first body line it replaced, so the placeholder arrives as
 * `+[private key removed]` inside a hunk and bare outside one (a key printed
 * above the first `@@` has no gutter to keep).
 */
function isKeyBodyPlaceholder(line: string): boolean {
  if (line === PRIVATE_KEY_BODY) return true;
  return (
    line.length === PRIVATE_KEY_BODY.length + 1 &&
    DIFF_GUTTERS.includes(line.charAt(0)) &&
    line.slice(1) === PRIVATE_KEY_BODY
  );
}

/** A patch body git wrote instead of text, in either spelling. */
const BINARY_PATCH_RE = /^(?:GIT binary patch|Binary files? .* differ)/m;

/** The clip `shortenPath` applies, mirrored here for the disambiguated form. */
const PATH_MAX = 200;

type Rec = Record<string, any>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null;
}

/**
 * How many lines the redactor ALTERED or REMOVED in this text.
 *
 * The redactor does exactly two things to a line: it rewrites it in place, or
 * it drops a whole private key block and leaves one placeholder line where the
 * block was. So the two line lists can be walked in step, and neither a real
 * diff of the two nor a second copy of the rules is needed. The count is what
 * the card says out loud ("{n} lines hidden because they look like secrets"),
 * so it counts the BLOCK's own lines rather than the single line it became.
 */
export function hiddenLineCount(original: string, masked: string): number {
  const before = original.split(/\r?\n/);
  const after = masked.split("\n");
  let i = 0;
  let j = 0;
  let hidden = 0;
  while (i < before.length && j < after.length) {
    if (after[j] === before[i]) {
      i += 1;
      j += 1;
      continue;
    }
    if (isKeyBodyPlaceholder(after[j]!)) {
      // A whole block collapsed into one placeholder: consume the original
      // lines up to and including the END marker, and count every one of them.
      while (i < before.length) {
        const line = before[i]!;
        i += 1;
        hidden += 1;
        if (line.includes(PRIVATE_KEY_END)) break;
      }
      j += 1;
      continue;
    }
    hidden += 1;
    i += 1;
    j += 1;
  }
  // A key block with no END marker eats the rest of the text.
  return hidden + (before.length - i);
}

/**
 * The change kind, in the five words the wire accepts, read off either
 * protocol shape through `changeKindWord` (the object `{type, move_path}` of
 * the app server v2 protocol and the plain string of the older SDK one).
 *
 * An `update` that carries a `move_path` is a RENAME, which is the one kind
 * the word alone does not tell you. A word this plugin has never heard of
 * becomes `update`: the wire has five values and refusing the whole card over
 * a sixth word would cost the owner the ask.
 */
export function wireChangeKind(kind: unknown, binary: boolean): ChangeKind {
  if (binary) return "binary";
  const word = changeKindWord(kind).toLowerCase();
  const moved =
    isRecord(kind) && typeof kind.move_path === "string" && kind.move_path.length > 0;
  if (moved) return "rename";
  if (word === "add" || word === "added" || word === "addition") return "add";
  if (word === "delete" || word === "deleted" || word === "deletion" || word === "remove")
    return "delete";
  if (word === "rename" || word === "renamed" || word === "move" || word === "moved")
    return "rename";
  return "update";
}

/** True for a patch body that is not text a person can read. */
export function isBinaryPatch(raw: string): boolean {
  return raw.includes("\u0000") || BINARY_PATCH_RE.test(raw);
}

/** Segments of a path in either separator, with the empties dropped. */
function segmentsOf(text: string): string[] {
  return text.split(/[\\/]+/).filter((part) => part.length > 0);
}

/**
 * The last `count` segments of a path, joined with the separator it used.
 *
 * Never the path itself: the leading root is what `shortenPath` exists to
 * drop, and a widened name is still a shortened one.
 */
function tailOf(full: string, count: number): string {
  const sep = full.includes("\\") ? "\\" : "/";
  const parts = segmentsOf(full);
  return clipText(parts.slice(-count).join(sep), PATH_MAX);
}

/**
 * THE PATH IS THE JOIN KEY, so the wire has to make it unique.
 *
 * `shortenPath` is deliberately lossy: outside the thread's cwd and outside
 * home it keeps the basename and ONE parent segment, so `/repo-one/src/x.ts`
 * and `/repo-two/src/x.ts` both become `src/x.ts`. The runtime can also
 * announce two changes for the SAME file (a rewrite and the rename of it).
 * Either way two rows would carry one string, and the app pairs a row to its
 * patch by that string (`diffModel.diffFileFor` is a `find` on the path), so
 * the second row would open the FIRST row's patch: the owner shown the wrong
 * change under the right name, on the one card whose whole job is to say what
 * they are authorising. The card this fires for is USUALLY a patch outside the
 * workspace, which is exactly the case `shortenPath` shortens hardest.
 *
 * So a collision between two DIFFERENT files is widened back out by one
 * parent segment, and two changes to the SAME file, which no tail could ever
 * separate, are numbered. Both lists take the SAME string, because both are
 * written from this one row.
 *
 * ONE SEGMENT AT A TIME, as far as it takes, and never past a `~` or as far
 * as the root: widening is a privacy cost as well as a fix, since the
 * segments above a file carry the account name on every desktop, which is the
 * whole reason `shortenPath` cut them off, so each step is paid for by a
 * collision that is still unresolved. It used to widen by exactly ONE parent
 * and then fall through to the numbering, which is wrong for a case that is
 * not exotic at all: three checkouts of one repo (`/a/proj/src/i.ts`,
 * `/b/proj/src/i.ts`, `/c/proj/src/i.ts`) gave `src/i.ts`, `proj/src/i.ts`
 * and `src/i.ts (2)`, so two DIFFERENT files read on the card as two changes
 * to one file. The numbering is reserved for what its own sentence says: two
 * changes to the SAME file, which no tail could ever separate, and a
 * collision no widening resolved.
 *
 * The walk stops before the root separator, so an absolute path never arrives
 * whole (`/c/proj/src/i.ts` widens at most to `c/proj/src/i.ts`), and it
 * stops at a `~` segment, which names a home the wire refuses to name.
 */
function distinctPath(
  short: string,
  full: string,
  sameFile: boolean,
  used: Map<string, string>,
): string {
  if (!sameFile && !short.startsWith("~")) {
    const parts = segmentsOf(full);
    for (let count = 3; count <= parts.length; count += 1) {
      const added = parts[parts.length - count]!;
      if (added.startsWith("~")) break;
      const wider = tailOf(full, count);
      if (!wider || wider === short) continue;
      if (!used.has(wider)) return wider;
    }
  }
  const base = clipText(short, PATH_MAX - 8);
  for (let n = 2; n <= DIFF_FILES_MAX + 1; n += 1) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate)) return candidate;
  }
  return short;
}

/** The serialised cost of a string in the column's own unit. */
function byteLength(text: string): number {
  try {
    return Buffer.byteLength(text, "utf8");
  } catch {
    return text.length * 4;
  }
}

/**
 * Cut ONE file's patch down by BYTES until the whole card fits the server's
 * cap, rather than dropping the file and sending no panel at all.
 *
 * The two caps are in different units (UTF-16 units of patch text here, bytes
 * of serialised `approvalMeta` there), and a patch that is mostly non ASCII
 * spends two or three bytes on every unit. Arabic prose, an `ar.json`, an
 * emoji heavy file: ordinary edits in a product that ships AR beside EN. The
 * belt and braces loop below used to POP whole files, so a one file card lost
 * its diff entirely and the owner got no panel even with the switch on, while
 * tens of thousands of units of headroom went unspent.
 *
 * Trailing lines go first (the head is the meaning), and a single line that
 * still will not fit is cut inside it through `clipText`, whose surrogate
 * guard is the one that matters: Postgres refuses a lone surrogate in JSONB.
 * False when not even one readable character fits, and the caller then drops
 * the file as before.
 *
 * EITHER cut counts, and the cut INSIDE a line counts too. There are two
 * places a file is cut inside a line on this wire, this one and the unit cap
 * in `buildDiffForWire`, and a count only the other one bumps leaves this one
 * SILENT: the app draws "Cut short: {n} more lines not sent" from
 * `omitted_lines` alone, so a minified file that fits the unit cap and not
 * the byte cap shipped `truncated: true` with a zero beside it and fell back
 * to the weaker, countless note. A line that arrived in pieces did not
 * arrive, which is what the wire type's own docblock says the count means, so
 * it is counted ONCE however many byte passes the cut takes.
 */
function cutFileToBytes(file: DiffWireFile, over: () => number): boolean {
  let countedInsideCut = false;
  for (let guard = 0; guard < 64 && over() > 0; guard += 1) {
    const lines = file.patch.split("\n");
    if (lines.length > 1) {
      let need = over();
      let dropped = 0;
      while (lines.length > 1 && need > 0) {
        const line = lines.pop()!;
        need -= byteLength(line) + 1;
        dropped += 1;
      }
      file.patch = lines.join("\n");
      file.omitted_lines += dropped;
      file.truncated = true;
      continue;
    }
    const line = lines[0] ?? "";
    const room = byteLength(line) - over();
    if (room <= 0) return false;
    // The units that fit in `room` bytes, by halving rather than by stepping:
    // a 60,000 character line of two byte characters would otherwise cost
    // 30,000 slices of it.
    let lo = 0;
    let hi = Math.min(line.length, room);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (byteLength(line.slice(0, mid)) <= room) lo = mid;
      else hi = mid - 1;
    }
    if (lo <= 0) return false;
    const cut = clipText(line, lo);
    if (cut.length === 0) return false;
    file.patch = cut;
    file.truncated = true;
    if (!countedInsideCut) {
      file.omitted_lines += 1;
      countedInsideCut = true;
    }
  }
  return over() <= 0;
}

/**
 * The ask sentence: the card's title, the message body and the push body.
 *
 * It names the FIRST file and counts the rest, because a title is one line on
 * a phone and a list of twelve paths is not a sentence. `reason` wins over it
 * when the runtime fills one; the live probe saw `reason: null` explicitly on
 * every file change request, which is why this exists at all.
 */
export function askSentence(firstPath: string, fileCount: number): string {
  if (fileCount <= 1) return `Change ${firstPath}`;
  const more = fileCount - 1;
  return `Change ${firstPath} and ${more} more ${more === 1 ? "file" : "files"}`;
}

/**
 * `approvalMeta.tool`: one `path (kind)` per line.
 *
 * It is NOT the ask sentence, and the difference is deliberate. An app that
 * predates this stage draws `tool` in its mono panel and `text` as the title,
 * so it shows the ask over the file list, which is already better than
 * "Apply file changes" over nothing. An app that has the stage draws the plain
 * line and the rows from `change_summary` instead.
 */
export function toolLines(files: ChangeSummaryFile[], fileCount: number): string {
  const lines = files.map((file) => `${file.path} (${file.kind})`);
  const rest = fileCount - files.length;
  if (rest > 0) lines.push(`and ${rest} more ${rest === 1 ? "file" : "files"}`);
  return lines.join("\n");
}

export interface FileChangeWire {
  /** Always, whenever the item was seen at all. */
  change_summary: ChangeSummary;
  /** Only when at least one file's patch survived the mask and the cap. */
  diff?: DiffWire;
  /** The ask sentence for `text`. */
  ask: string;
  /** The `path (kind)` list for `approvalMeta.tool`. */
  tool: string;
}

/**
 * The serialised size of what this card would put in the column, in bytes:
 * the three keys this file builds, plus the reserve standing in for the six it
 * does not.
 */
function metaBytes(summary: ChangeSummary, diff: DiffWire | undefined, tool: string): number {
  try {
    return (
      Buffer.byteLength(JSON.stringify({ change_summary: summary, diff, tool }), "utf8") +
      META_RESERVE_BYTES
    );
  } catch {
    // An unserialisable value cannot be sent at all; treat it as over the cap.
    return APPROVAL_META_BYTES_MAX + 1;
  }
}

/**
 * The summary the card always carries and the capped, masked diff it carries
 * when there is one, built from the `changes[{path, kind, diff}]` array the
 * runtime announced on `item/started` and the host joined on `itemId`.
 *
 * Null when the item named no file at all, which is the case the caller posts
 * exactly as it did before this stage: the literal "Apply file changes", no
 * fields, no diff. A join that missed is the same case, and it must be,
 * because nothing in the protocol orders `item/started` in front of the
 * approval request; ten milliseconds was measured, not promised.
 */
export function buildDiffForWire(
  changes: unknown,
  ctx: ItemContext = {},
): FileChangeWire | null {
  const list = Array.isArray(changes) ? (changes as unknown[]) : [];
  const named = list.filter(
    (change) =>
      isRecord(change) && typeof change.path === "string" && change.path.trim().length > 0,
  ) as Rec[];
  if (named.length === 0) return null;

  let totalAdded = 0;
  let totalRemoved = 0;
  const seen = named.map((change) => {
    const raw = typeof change.diff === "string" ? change.diff : "";
    const counts = countDiffLines(raw);
    totalAdded += counts.added;
    totalRemoved += counts.removed;
    // Two different questions, and they used to share one answer. A body that
    // is a BINARY MARKER makes the kind `binary`, because that is what the
    // change is. A body that is simply ABSENT (the join saw the item before
    // the runtime filled the patch, or the change carries none) says nothing
    // about the change: a delete is still a delete and a rename still a
    // rename, and those are the words the owner needs. Both are unreadable,
    // so both draw `can't preview` and neither is offered a panel.
    const binaryBody = isBinaryPatch(raw);
    const unreadable = raw.length === 0 || binaryBody;
    return {
      path: shortenPath(change.path, ctx),
      full: change.path as string,
      kind: wireChangeKind(change.kind, binaryBody),
      added: counts.added,
      removed: counts.removed,
      binary: unreadable,
      raw,
    };
  });

  const rows = seen.slice(0, DIFF_FILES_MAX);
  // A 21st file is counted in `file_count` and in the totals and has no row.
  let anyLeftOut = seen.length > rows.length;

  // Every row on the wire gets its own name, because the app pairs a row to
  // its patch BY the name. See `distinctPath`.
  const usedPaths = new Map<string, string>();
  for (const row of rows) {
    const taken = usedPaths.get(row.path);
    if (taken !== undefined)
      row.path = distinctPath(row.path, row.full, taken === row.full, usedPaths);
    usedPaths.set(row.path, row.full);
  }

  const files: DiffWireFile[] = [];
  let spent = 0;
  const summaryFiles: ChangeSummaryFile[] = rows.map((row) => {
    if (row.binary) {
      // No `diff.files` entry rides for this row, which is what the block
      // flag means by "left out": `diff.truncated` says the panel set is not
      // the whole change, and a file nobody can preview is exactly that.
      anyLeftOut = true;
      return {
        path: row.path,
        kind: row.kind,
        added: row.added,
        removed: row.removed,
        preview: "binary" as const,
      };
    }

    const masked = redactPatch(row.raw);
    const hidden = hiddenLineCount(row.raw, masked);
    const lines = masked.split("\n");
    // A trailing newline splits into one empty last element. Dropping it here
    // keeps a 400 line patch from reporting itself cut short by one line.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const head = lines.slice(0, DIFF_LINES_PER_FILE);
    let omitted = lines.length - head.length;
    // Whole lines dropped is not the only way a file is cut short: a single
    // line longer than the whole budget is cut INSIDE it. That used to set
    // the flag and leave the count at zero, which made the cut SILENT: the
    // app draws "Cut short: {n} more lines not sent" from `omitted_lines`
    // alone, and zero draws nothing, so a minified file stopped mid line with
    // no note at all. A line that arrived in pieces did not arrive, so it
    // counts. The flag stays beside the count as a belt and braces.
    let cutInside = false;

    const remaining = DIFF_UNITS_TOTAL - spent;
    let patch = head.join("\n");
    if (remaining <= 0) {
      anyLeftOut = true;
      return {
        path: row.path,
        kind: row.kind,
        added: row.added,
        removed: row.removed,
        preview: "too_large" as const,
      };
    }
    if (patch.length > remaining) {
      const fit: string[] = [];
      let used = 0;
      for (const line of head) {
        const cost = fit.length === 0 ? line.length : line.length + 1;
        if (used + cost > remaining) break;
        fit.push(line);
        used += cost;
      }
      if (fit.length === 0) {
        // Not one whole line fits. A line longer than the WHOLE budget can
        // never fit in any budget, so it is cut inside (a minified file is one
        // line and dropping it whole would send nothing at all); a line that
        // merely does not fit in what is LEFT might have fit on its own, and a
        // fragment of it would say less than the row already says.
        if (spent > 0) {
          anyLeftOut = true;
          return {
            path: row.path,
            kind: row.kind,
            added: row.added,
            removed: row.removed,
            preview: "too_large" as const,
          };
        }
        patch = clipText(head[0] ?? "", remaining);
        cutInside = true;
        // The lines behind it, AND the line the cut landed inside: the panel
        // is short by that much of the file, and the note says so.
        omitted += head.length;
      } else {
        patch = fit.join("\n");
        omitted += head.length - fit.length;
      }
    }
    spent += patch.length;
    files.push({
      path: row.path,
      patch,
      truncated: omitted > 0 || cutInside,
      omitted_lines: omitted,
      hidden_lines: hidden,
    });
    return {
      path: row.path,
      kind: row.kind,
      added: row.added,
      removed: row.removed,
      preview: "ok" as const,
    };
  });

  const summary: ChangeSummary = {
    file_count: seen.length,
    total_added: totalAdded,
    total_removed: totalRemoved,
    files: summaryFiles,
  };
  const tool = toolLines(summaryFiles, seen.length);
  let diff: DiffWire | undefined =
    files.length > 0
      ? { truncated: anyLeftOut || files.some((file) => file.truncated), files }
      : undefined;

  // The server's cap is on the SERIALISED column and this side's is on the
  // patch text, so the two can disagree on a patch that is mostly newlines or
  // mostly non ASCII. Drop whole files from the END until the body fits, and
  // never send one the server would refuse: a 400 costs the owner the card,
  // and the plain line is the part that matters.
  //
  // The LAST surviving file is re-cut rather than dropped. Popping it would
  // empty `diff.files`, take the whole panel with it and spend none of the
  // headroom the unit cap left, which on a one file card means the owner sees
  // no change at all with the switch on.
  const dropLast = () => {
    diff!.files.pop();
    // The diff entries are the `ok` rows in order, so the one a drop costs is
    // the LAST row still reading `ok`. The path would serve as a key now that
    // the rows are disambiguated, but the order is what actually built this
    // list, so the order is what reads it.
    const row = [...summary.files].reverse().find((file) => file.preview === "ok");
    if (row) row.preview = "too_large";
  };
  while (diff && metaBytes(summary, diff, tool) > APPROVAL_META_BYTES_MAX) {
    if (diff.files.length > 1) {
      dropLast();
      diff = { truncated: true, files: diff.files };
      continue;
    }
    const only = diff.files[0]!;
    const over = () => metaBytes(summary, diff!, tool) - APPROVAL_META_BYTES_MAX;
    if (cutFileToBytes(only, over)) {
      diff = { truncated: true, files: diff.files };
      break;
    }
    dropLast();
    diff = undefined;
  }
  if (!diff) for (const row of summary.files) if (row.preview === "ok") row.preview = "too_large";

  return {
    change_summary: summary,
    diff,
    ask: askSentence(summaryFiles[0]?.path ?? "", seen.length),
    tool,
  };
}
