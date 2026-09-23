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
 * `approvalMeta` there), so a pathological patch can satisfy this one and
 * still be refused by that one, and a refused create costs the owner the whole
 * card and the agent its answer. `fitsApprovalMeta` below is this side's
 * insurance: it never sends more than the caps above allow, it only sends
 * LESS when the serialised form would not have been accepted at all.
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
    // No body to read is drawn the same way a binary body is: the card says
    // "can't preview" and offers no panel. The wire has no third word for it.
    const binary = raw.length === 0 || isBinaryPatch(raw);
    return {
      path: shortenPath(change.path, ctx),
      kind: wireChangeKind(change.kind, binary),
      added: counts.added,
      removed: counts.removed,
      binary,
      raw,
    };
  });

  const rows = seen.slice(0, DIFF_FILES_MAX);
  // A 21st file is counted in `file_count` and in the totals and has no row.
  let anyLeftOut = seen.length > rows.length;

  const files: DiffWireFile[] = [];
  let spent = 0;
  const summaryFiles: ChangeSummaryFile[] = rows.map((row) => {
    if (row.binary)
      return {
        path: row.path,
        kind: row.kind,
        added: row.added,
        removed: row.removed,
        preview: "binary" as const,
      };

    const masked = redactOutput(row.raw);
    const hidden = hiddenLineCount(row.raw, masked);
    const lines = masked.split("\n");
    // A trailing newline splits into one empty last element. Dropping it here
    // keeps a 400 line patch from reporting itself cut short by one line.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const head = lines.slice(0, DIFF_LINES_PER_FILE);
    let omitted = lines.length - head.length;
    // Whole lines dropped is not the only way a file is cut short: a single
    // line longer than the whole budget is cut INSIDE, and that file is
    // truncated with no line missing. The flag and the count answer different
    // questions and neither is derivable from the other.
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
        omitted += head.length - 1;
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
  // drop the diff entirely rather than send one the server would refuse: a
  // 400 costs the owner the card, and the plain line is the part that matters.
  while (diff && metaBytes(summary, diff, tool) > APPROVAL_META_BYTES_MAX) {
    diff.files.pop();
    // The diff entries are the `ok` rows in order, so the one a drop costs is
    // the LAST row still reading `ok`. Matching on the path would pick the
    // wrong one when a patch touches the same shortened path twice.
    const row = [...summary.files].reverse().find((file) => file.preview === "ok");
    if (row) row.preview = "too_large";
    diff = diff.files.length > 0 ? { truncated: true, files: diff.files } : undefined;
  }
  if (!diff) for (const row of summary.files) if (row.preview === "ok") row.preview = "too_large";

  return {
    change_summary: summary,
    diff,
    ask: askSentence(summaryFiles[0]?.path ?? "", seen.length),
    tool,
  };
}
