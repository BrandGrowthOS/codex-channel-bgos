/**
 * The tail of what a command printed, on its way to a tool row.
 *
 * Two steps, and the ORDER they are applied in is the contract:
 *
 *  1. The mask (`redactOutput`), over the WHOLE string. Nothing is cut
 *     first. A character cut hands the rules half a token: the anchor the
 *     rule matches on (`Bearer `, `KEY=`) is sliced off, the pattern stops
 *     matching, and the rest of that value ships in the clear, which is not
 *     a corner case but what a dense line of secrets does every time, since
 *     masking SHRINKS the text and the survivor then fits inside the final
 *     cut. A line cut is no safer: it can drop the BEGIN line of a private
 *     key and leave the body behind. Masking the whole string is unbounded
 *     work over a field the protocol leaves unbounded, and that cost is the
 *     price of the guarantee. Masking can also LENGTHEN a line, which is the
 *     other reason the cut is last.
 *  2. The last 200 lines, then the last 2048 UTF-16 code units.
 *
 * The END is the end that is kept, for the same reason the card drops rows
 * from the front: the end of a command is what the owner opened the row to
 * read. `clipText` in `clip-text.ts` keeps the FRONT and guards a trailing
 * high surrogate, which is right for a name, an args line or a path and
 * wrong for a tail, so this file has its own clip and that one is left
 * exactly as it is for its other callers.
 */
import { redactOutput } from "./redact-output.js";

/** Characters of output one row may carry. The platform enforces it too. */
export const OUTPUT_MAX = 2048;
/** Lines of output one row may carry. */
export const OUTPUT_LINES_MAX = 200;

/**
 * The LAST `max` UTF-16 code units, never leaving the dangling second half of
 * a character at the front: Postgres refuses a lone surrogate inside JSONB,
 * so the platform would reject the whole card rather than draw it short.
 */
export function tailClip(raw: unknown, max: number): string {
  const text = typeof raw === "string" ? raw : "";
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const first = cut.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut;
}

/** The masked, clipped tail of a command's output. Empty for nothing. */
export function buildOutputTail(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  if (text.length === 0) return "";
  const masked = redactOutput(text);
  const lines = masked.split("\n");
  const kept =
    lines.length > OUTPUT_LINES_MAX
      ? lines.slice(lines.length - OUTPUT_LINES_MAX)
      : lines;
  return tailClip(kept.join("\n"), OUTPUT_MAX);
}
