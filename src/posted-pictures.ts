/**
 * What one turn's pictures did in the chat (stage 4, C-21), kept in one place
 * because a turn can post them from two places: just before a plan card
 * raised inside the turn, and at the end of the turn. Both share this record,
 * so a picture is dealt with once, the "finished without a text reply" guard
 * counts every answer the pictures gave, and a `MEDIA:` line naming one of
 * them again is dropped.
 *
 * The dedupe is by the FILE, never by how its path is spelled (review finding
 * 9). The runtime tells the model "if you need to use a generated image at
 * another path, copy it", so the second copy that can really post is a
 * workspace copy under another name; the saved copy itself sits under
 * ~/.codex/generated_images, outside the media root, where the guard refuses
 * it anyway. So a line is dropped when its file IS a posted picture's saved
 * copy (by real path) or holds the same bytes (sha256). The bytes are only
 * ever read from a path the media guard would send, only for a picture, and
 * only up to the image cap; a turn with no posted picture reads nothing.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

import type { GeneratedImage } from "./codex-host.js";
import { IMAGE_BYTES_MAX, sameFilePath } from "./generated-images.js";
import { resolveAllowedMediaPath } from "./media-guard.js";

export interface TurnPictures {
  /** Item ids already dealt with this turn: posted, queued, refused or reported. */
  handled: Set<string>;
  /**
   * Answers the pictures gave that reached the chat or will: a picture that
   * landed, a picture the outbox queued, and each plain line.
   */
  posted: number;
  /** The plain lines already posted this turn, so each one reads once. */
  lines: Set<string>;
  /** The runtime's saved copies of the pictures that landed or were queued. */
  savedPaths: string[];
  /** Their real paths, case folded where the file system folds case. */
  realPaths: Set<string>;
  /** The sha256 of those pictures' bytes. */
  hashes: Set<string>;
}

export function newTurnPictures(): TurnPictures {
  return {
    handled: new Set(),
    posted: 0,
    lines: new Set(),
    savedPaths: [],
    realPaths: new Set(),
    hashes: new Set(),
  };
}

/** The picture formats the app draws, by the extension a send is named by. */
const PICTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The file a path names: resolved the way the media guard resolves an agent's
 * path (against the working directory), symlinks and `..` collapsed when the
 * file exists, and case folded on Windows.
 */
function realPathKey(path: string): string {
  const abs = isAbsolute(path)
    ? path
    : resolve(process.env.CODEX_BGOS_WORKDIR ?? process.cwd(), path);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    real = resolve(abs);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** Record a picture that reached the chat, or that the outbox will deliver. */
export function rememberPostedPicture(
  ledger: TurnPictures,
  image: GeneratedImage,
): void {
  if (image.bytes) ledger.hashes.add(sha256(image.bytes));
  if (image.savedPath) {
    ledger.savedPaths.push(image.savedPath);
    ledger.realPaths.add(realPathKey(image.savedPath));
  }
}

/** Whether a `MEDIA:` line's file is a picture this turn already posted. */
export async function mediaLineIsPostedPicture(
  path: string,
  ledger: TurnPictures,
): Promise<boolean> {
  if (ledger.savedPaths.some((saved) => sameFilePath(saved, path)))
    return true;
  if (ledger.realPaths.size > 0 && ledger.realPaths.has(realPathKey(path)))
    return true;
  if (ledger.hashes.size === 0) return false;
  if (!PICTURE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  // Only a file the guard would send anyway: a line it refuses is refused by
  // `sendFile` exactly as before, and nothing outside the root is ever read.
  let safe: string;
  try {
    safe = resolveAllowedMediaPath(path);
  } catch {
    return false;
  }
  try {
    const info = await stat(safe);
    if (!info.isFile() || info.size > IMAGE_BYTES_MAX) return false;
    return ledger.hashes.has(sha256(await readFile(safe)));
  } catch {
    return false;
  }
}
