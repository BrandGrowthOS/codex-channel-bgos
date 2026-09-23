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
 *  1. MASK the WHOLE patch (`redactOutput`), before anything is cut. A cut
 *     first hands a rule half a token: the anchor it matches on (`Bearer `,
 *     `KEY=`) is sliced off, the pattern stops matching, and the rest of the
 *     value ships in the clear. Masking first also means `hidden_lines` is
 *     counted over the whole file, so a secret past line 400 is still
 *     reported even though the line itself was never going to be sent.
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
import { redactOutput } from "./redact-output.js";
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
/** Bytes left for the stage 1 fields (route, risk, request id, wait). */
const META_RESERVE_BYTES = 1_024;

/** The one line a redacted private key block becomes. */
const PRIVATE_KEY_BODY = "[private key removed]";
/** Any END marker closes the block, whatever the key type says. */
const PRIVATE_KEY_END = "-----END";

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
    if (after[j] === PRIVATE_KEY_BODY) {
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
 * Exactly one parent, and never past a `~`: widening is a privacy cost as
 * well as a fix, since the segments above a file carry the account name on
 * every desktop, which is the whole reason `shortenPath` cut them off. One
 * segment separates two checkouts, which is the case this actually fires for,
 * and a `~` path is already relative to a home the wire refuses to name.
 */
function distinctPath(
  short: string,
  full: string,
  sameFile: boolean,
  used: Map<string, string>,
): string {
  if (!sameFile && !short.startsWith("~")) {
    const wider = tailOf(full, 3);
    if (wider && wider !== short && !used.has(wider)) return wider;
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
 */
function cutFileToBytes(file: DiffWireFile, over: () => number): boolean {
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

/** The serialised size of what this card would put in the column, in bytes. */
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

    const masked = redactOutput(row.raw);
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
