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
 *     boundary, and no em or en dash in the model's prompt survives, so
 *     nothing the owner reads carries one: an en dash between two digits is a
 *     range and reads "to", every other one becomes a comma. No revised
 *     prompt, no caption: never a bare "Prompt:".
 *  3. A `usageLimitExceeded` failure posts one plain line saying the limit is
 *     used up for now and, when the runtime gave a reset time still ahead,
 *     roughly how long until it resets ("in about 2 hours"), relative to the
 *     moment the line posts (Round 6). Never a clock time: the plugin cannot
 *     know the viewer's zone and this host's zone need not be the owner's,
 *     while the bubble's own timestamp anchors a relative phrase. `/usage`
 *     keeps its UTC readout (native-commands.ts): the owner typed for that.
 *
 * What the live probe could NOT settle (docs/reports/2026-09-24-p5-s4-image-
 * posts/probe.md, this machine's Codex is not logged in): the real status
 * strings, whether `result` is bare base64 or a `data:` URI, and whether a
 * revised prompt comes back at all. So nothing here reads `status`, both
 * `result` forms decode, and the MIME type comes from the bytes themselves.
 */
import { shortenPath } from "./activity-markers.js";
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
 * back, short enough that the caption never outweighs the picture: two or
 * three lines on a phone, where 280 took about nine (Round 6).
 */
export const IMAGE_CAPTION_PROMPT_MAX = 200;

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

/**
 * A file name the gallery can show, built from the item id alone: its last 8
 * safe characters, so `codex-image-7c0d9f13.png` fits whole in the viewer
 * strip, the photos card, the Artifacts card and the saved file's name
 * (Round 6; the last 24 made it 40 characters, cut in the middle on a phone).
 * Nothing keys on it: the app keys on the row id, the upload is keyed server
 * side, and a `MEDIA:` duplicate is found by real path and sha256.
 */
function imageFileName(itemId: string, mimeType: string): string {
  const safe = itemId.replace(/[^A-Za-z0-9_]/g, "").slice(-8) || "1";
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
 *
 * `returnedOutput` records that the runtime handed back a non empty `result`
 * at all, BEFORE decoding, so the fact survives a result that is not a
 * picture or is over the cap (Round 5): Codex made something then, and the
 * line that says it could not be shown must say "made", never "tried". A
 * picture whose whole line was over the transport's cap arrives with no
 * `result` and `tooLarge: true` instead (src/app-server.ts, Round 8): the
 * runtime handed back more than this daemon can read, so that is "made" too.
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
  if (
    (typeof item.result === "string" && item.result.trim()) ||
    item.tooLarge === true
  )
    image.returnedOutput = true;
  const decoded = decodeImageResult(item.result);
  if (decoded) {
    image.bytes = decoded.bytes;
    image.mimeType = decoded.mimeType;
    image.fileName = imageFileName(itemId, decoded.mimeType);
  }
  return image;
}

/**
 * No em or en dash (or their two rarer cousins) survives. An en dash closed
 * up between two digits is a range, so it reads " to " (`2024 to 2026`,
 * `3 to 4 people`); a comma there would change what the prompt says. That
 * runs first, and every other dash becomes a comma. A spaced en dash is the
 * parenthetical dash, even between numbers, so it stays a pause.
 */
function withoutDashes(text: string): string {
  let out = text.replace(/(?<=\d)\u2013(?=\d)/g, " to ");
  out = out.replace(/\s*[\u2012\u2013\u2014\u2015]+\s*/g, ", ");
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long until the limit resets, said the way a person would: `in a
 * moment` under a minute, `in about 12 minutes` under an hour, `in about 5
 * hours` under two days, else `in about 3 days`. Each count is rounded and
 * the bucket is chosen by the ROUNDED count, so it never reads "about 60
 * minutes" or "about 48 hours". Null when there is no reset still ahead: none
 * given, not a finite positive number, or already past.
 */
function resetsIn(resetsAt: number | null | undefined, now: number): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0)
    return null;
  // Seconds on this protocol (the turn clock and /usage both are); a value
  // this large can only be milliseconds, and reading it as seconds would name
  // a year no owner will live to see.
  const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const left = ms - now;
  if (!Number.isFinite(left) || left <= 0) return null;
  if (left < MINUTE_MS) return "in a moment";
  const count = (n: number, unit: string): string =>
    `in about ${n} ${unit}${n === 1 ? "" : "s"}`;
  const minutes = Math.round(left / MINUTE_MS);
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.round(left / HOUR_MS);
  if (hours < 48) return count(hours, "hour");
  return count(Math.round(left / DAY_MS), "day");
}

/**
 * The plain line a picture posts in its place when it never reached the chat:
 * no bytes the app can draw (an empty or unreadable `result`, over the image
 * cap, a format the app does not draw, a save only item), or an upload that
 * failed after its retries and was not queued. The runtime has already told
 * the model the picture is "displayed to the user", so without a line the
 * owner never learns one was made (review finding 3).
 *
 * Which line is the re-review's item 2, and each claim has to be earned:
 *
 *  - A saved copy: Codex MADE it, and the line says where it is saved. That
 *    copy sits under the Codex home, outside the media root, so the owner has
 *    no other way to find it, and the model has been told not to resend it.
 *    The path is shortened by `shortenPath`, the one every activity row uses
 *    (under the home directory it reads `~\...`, anywhere else the file and
 *    its folder), because a full path carries the account name.
 *  - Bytes but no saved copy (the upload failed, the tool's own save did
 *    not): Codex made it, and there is no file to name.
 *  - A non empty `result` that did not decode (not a picture, over the cap)
 *    and no saved copy: the runtime still handed something over, so Codex
 *    made it (`returnedOutput`, Round 5). Saying "tried" there would be false.
 *    The same for a picture whose line was too large to read at all (Round
 *    8): its `result` was over 16 MiB of text.
 *  - None of those: Codex only TRIED. A generation that failed without a
 *    failure object (a failed status, an empty or absent result) made
 *    nothing, and the chat must not say a picture was made. Nothing here
 *    reads `status`, because its strings were never seen live; the absence
 *    of all three is the evidence.
 *
 * `home` is for tests; the daemon passes nothing and gets this machine's.
 */
export const IMAGE_MADE_NOT_SHOWN_LINE =
  "Codex made a picture, but it could not be shown here.";
/**
 * Round 6: the tried line says what happened. "Could not be shown" implied a
 * picture the chat could not draw, and this is exactly the case where nothing
 * came back.
 */
export const IMAGE_TRIED_NOT_SHOWN_LINE =
  "Codex tried to make a picture, but nothing came back.";

export function imageNotShownLine(
  image: Pick<GeneratedImage, "bytes" | "savedPath" | "returnedOutput">,
  ctx: { home?: string } = {},
): string {
  const where = image.savedPath
    ? shortenPath(image.savedPath, ctx.home ? { home: ctx.home } : {})
    : "";
  if (where) return `${IMAGE_MADE_NOT_SHOWN_LINE} It is saved at ${where}.`;
  if ((image.bytes && image.bytes.length > 0) || image.returnedOutput)
    return IMAGE_MADE_NOT_SHOWN_LINE;
  return IMAGE_TRIED_NOT_SHOWN_LINE;
}

/**
 * The one plain line a refused picture posts in its place. For the image
 * limit: `Codex has used up its picture limit for now. It resets in about 2
 * hours.`, the second sentence only while a reset is still ahead.
 *
 * `now` (epoch milliseconds) is what the reset is measured from. The adapter
 * reads its clock once a turn and passes it, so two pictures refused by the
 * same limit read as the same words and post as one line; alone, this reads
 * this machine's clock.
 */
export function imageFailureLine(
  failure: GeneratedImageFailure,
  ctx: { now?: number } = {},
): string {
  if (failure.type === "usageLimitExceeded") {
    const when = resetsIn(failure.resetsAt, ctx.now ?? Date.now());
    const line = "Codex has used up its picture limit for now.";
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
