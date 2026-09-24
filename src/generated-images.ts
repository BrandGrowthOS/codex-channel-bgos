/**
 * A picture the runtime's image generation tool made, turned into something
 * this daemon can post: the bytes, a caption, or one plain line when the
 * runtime refused it. Pure, so every rule here is pinned without a host.
 *
 * Stage 4 (C-21). Three decisions from the P5 ledger shape this file:
 *
 *  1. BYTES, NOT A PATH. The item's `result` (base64) is decoded here, at the
 *     moment the item completes, capped at the 10 MB image limit before any
 *     allocation, and the string is dropped. A turn then holds a Buffer and
 *     never the base64 (a 1.9 MB PNG is about 2.6 MB of base64, held until the
 *     turn ends otherwise), nothing is written into the owner's repo (the
 *     media root IS the agent's workdir) and the media guard keeps its one
 *     root. `savedPath` is carried for the activity row and for dropping a
 *     `MEDIA:` line that names the same file, never read from disk: the tool's
 *     own save can fail ("failed to save generated image", "generated image
 *     destination already exists", seen in the 0.154.0 binary), so a picture
 *     can arrive with a `result` and no usable path.
 *  2. The caption is `Prompt: <revisedPrompt>`, on one line, clipped on a word
 *     boundary, and any em or en dash in the model's prompt becomes a comma,
 *     so nothing the owner reads carries one. No revised prompt, no caption:
 *     never a bare "Prompt:".
 *  3. A `usageLimitExceeded` failure posts one plain line naming the reset
 *     time, in UTC, the way `/usage` already names one (native-commands.ts).
 *
 * What the live probe could NOT settle (docs/reports/2026-09-24-p5-s4-image-
 * posts/probe.md, this machine's Codex is not logged in): the real status
 * strings, whether `result` is bare base64 or a `data:` URI, and whether a
 * revised prompt comes back at all. So nothing here reads `status`, both
 * `result` forms decode, and the MIME type comes from the bytes themselves.
 */
import type { RpcObject } from "./app-server.js";
import { decodeBase64Capped } from "./attachment-guard.js";
import { clipText } from "./clip-text.js";
import type {
  GeneratedImage,
  GeneratedImageFailure,
} from "./codex-host.js";

/** The image cap every outbound picture already has (attachment-bridge.ts). */
export const IMAGE_BYTES_MAX = 10 * 1024 * 1024;

/**
 * The longest revised prompt a caption carries, in UTF-16 units, the cut mark
 * included. Long enough for the one or two sentences an image model writes
 * back, short enough that the caption never outweighs the picture.
 */
export const IMAGE_CAPTION_PROMPT_MAX = 280;

const DATA_URI = /^data:([^;,]*)((?:;[^;,]*)*),/i;

/**
 * The picture's bytes and MIME type, or null when there is no picture to post:
 * no string, an empty one, a `data:` URI that is not base64, anything over the
 * image cap, or bytes that are not a PNG, JPEG, GIF or WebP.
 *
 * The bytes decide the MIME type, never a `data:` label: the backend stores
 * `isImage` verbatim and the app draws whatever it is told.
 */
export function decodeImageResult(
  raw: unknown,
): { bytes: Buffer; mimeType: string } | null {
  if (typeof raw !== "string") return null;
  let b64 = raw.trim();
  const uri = DATA_URI.exec(b64);
  if (uri) {
    if (!/;base64/i.test(uri[2] ?? "")) return null;
    b64 = b64.slice(uri[0].length);
  }
  if (!b64) return null;
  let bytes: Buffer;
  try {
    bytes = decodeBase64Capped(b64, IMAGE_BYTES_MAX);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const mimeType = sniffImageMime(bytes);
  return mimeType ? { bytes, mimeType } : null;
}

/** The four picture formats the app draws, read off their magic bytes. */
function sniffImageMime(b: Uint8Array): string | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  )
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return "image/webp";
  return null;
}

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A file name the gallery can show, built from the item id alone. */
function imageFileName(itemId: string, mimeType: string): string {
  const safe = itemId.replace(/[^A-Za-z0-9_]/g, "").slice(-24) || "1";
  return `codex-image-${safe}.${EXTENSION[mimeType] ?? "png"}`;
}

function readFailure(raw: unknown): GeneratedImageFailure | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return undefined;
  const failure = raw as RpcObject;
  if (typeof failure.type !== "string" || !failure.type) return undefined;
  const out: GeneratedImageFailure = { type: failure.type };
  if (typeof failure.limitId === "string") out.limitId = failure.limitId;
  if (typeof failure.resetsAt === "number" && Number.isFinite(failure.resetsAt))
    out.resetsAt = failure.resetsAt;
  return out;
}

/**
 * One finished `imageGeneration` item as the turn keeps it, or null when the
 * item has no id (it could not be deduped, and every real item has one).
 *
 * A failure is carried with its failure and no bytes, so the adapter can say
 * why. Otherwise the bytes are decoded now and the base64 goes no further.
 */
export function collectGeneratedImage(item: RpcObject): GeneratedImage | null {
  const itemId = typeof item.id === "string" ? item.id : "";
  if (!itemId) return null;
  const image: GeneratedImage = { itemId };
  if (typeof item.revisedPrompt === "string" && item.revisedPrompt.trim())
    image.revisedPrompt = item.revisedPrompt;
  if (typeof item.savedPath === "string" && item.savedPath)
    image.savedPath = item.savedPath;
  const failure = readFailure(item.failure);
  if (failure) {
    image.failure = failure;
    return image;
  }
  const decoded = decodeImageResult(item.result);
  if (decoded) {
    image.bytes = decoded.bytes;
    image.mimeType = decoded.mimeType;
    image.fileName = imageFileName(itemId, decoded.mimeType);
  }
  return image;
}

/** Every em and en dash (and their two rarer cousins) becomes a comma. */
function withoutDashes(text: string): string {
  let out = text.replace(/\s*[\u2012\u2013\u2014\u2015]+\s*/g, ", ");
  // A dash next to a comma the model already wrote would read ", ,".
  let previous = "";
  while (previous !== out) {
    previous = out;
    out = out.replace(/,\s*,/g, ",");
  }
  return out.replace(/^[\s,]+|[\s,]+$/g, "");
}

/** Cut on a word boundary, marked with an ellipsis, never through a pair. */
function clipOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = clipText(text, max - 1);
  const space = cut.lastIndexOf(" ");
  // A prompt with no space in its first half is one long token: cut it.
  if (space >= max / 2) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.]+$/, "")}\u2026`;
}

/** `Prompt: <revisedPrompt>`, or nothing at all without a revised prompt. */
export function imageCaption(revisedPrompt: unknown): string | undefined {
  if (typeof revisedPrompt !== "string") return undefined;
  const clean = withoutDashes(revisedPrompt.replace(/\s+/g, " ").trim());
  if (!clean) return undefined;
  return `Prompt: ${clipOnWord(clean, IMAGE_CAPTION_PROMPT_MAX)}`;
}

/** `2026-09-24 08:53 UTC` from epoch seconds, or milliseconds, or null. */
function resetTime(resetsAt: number | null | undefined): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0)
    return null;
  // Seconds on this protocol (the turn clock and /usage both are); a value
  // this large can only be milliseconds, and reading it as seconds would name
  // a year no owner will live to see.
  const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** The one plain line a refused picture posts in its place. */
export function imageFailureLine(failure: GeneratedImageFailure): string {
  if (failure.type === "usageLimitExceeded") {
    const when = resetTime(failure.resetsAt);
    const line =
      "Codex could not make a picture because the image generation limit is used up.";
    return when ? `${line} It resets ${when}.` : line;
  }
  return "Codex could not make a picture.";
}

/**
 * Whether a `MEDIA:` line names the file a posted picture was saved to.
 * Separators and repeats folded, and case folded on a Windows shaped path,
 * because a drive letter arrives in either case. A path written some other
 * way (relative, through a link) is simply not a match, and the media guard
 * then decides that line exactly as it decides any other.
 */
export function sameFilePath(a: string, b: string): boolean {
  const norm = (raw: string): string => {
    let path = raw.trim().replace(/[\\/]+/g, "/").replace(/\/$/, "");
    if (process.platform === "win32" || /^[a-zA-Z]:\//.test(path))
      path = path.toLowerCase();
    return path;
  };
  return a.trim() !== "" && norm(a) === norm(b);
}
