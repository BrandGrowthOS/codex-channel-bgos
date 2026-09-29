/**
 * Bridge BGOS attachments ↔ Codex file paths.
 *
 * Direction 1 (BGOS → Codex): the user uploads an image/document/voice
 * note in the BGOS chat. The backend's `inbound_message` payload carries
 * a `files[]` array. `ingestBgosAttachment` writes one of those entries
 * to the local OS temp dir and returns `{ localPath, kind }` so Codex's
 * existing vision/document/voice pipelines (in the fork) can consume it.
 *
 * Direction 2 (Codex → BGOS): the agent emits a `MEDIA:/abs/path` line
 * in its reply (or a structured tool output). `publishMediaPath` turns
 * the local file into a `files[]` entry the WS `message` event expects:
 * inline base64 below `S3_THRESHOLD`, presigned S3 PUT above.
 *
 * The fork is responsible for plugging these into Codex's photo/document/
 * voice handlers - this module only provides the wire-level shims.
 */
import { createWriteStream, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BgosApi } from "./bgos-api.js";
import {
  MAX_ATTACHMENT_BYTES,
  AttachmentSizeError,
  assertDeclaredSizeOk,
  decodeBase64Capped,
  fetchAttachmentGuarded,
} from "./attachment-guard.js";
import {
  classifyMedia,
  sniffImageDimensions,
  toInlineDataUri,
} from "./media-classify.js";
import { resolveAllowedMediaPath } from "./media-guard.js";

/** Threshold below which we inline base64 in a single POST. Mirrors the
 *  policy in `openclaw-channel-bgos` and the memory note
 *  `bug_base64_body_limit.md`: 500 KB. Above the line we go via S3
 *  presigned PUT to avoid hitting the backend body-size limit. */
export const S3_THRESHOLD = 500 * 1024;

/** Inbound attachment shape - accepts both the camelCase wire format
 *  (`fileName`/`mimeType`) and Hermes/legacy snake-case (`filename`/`mime`)
 *  so this bridge stays robust to wire-format drift. */
export interface BgosInboundAttachment {
  /** Camel-case (canonical wire form). */
  fileName?: string;
  mimeType?: string;
  /** Snake-case alternative names backend has used historically. */
  filename?: string;
  mime?: string;
  size?: number;
  /** Either a presigned S3 GET URL OR a base64 data URL - backend always
   *  emits one or the other for files >500 KB / <500 KB respectively. */
  url?: string;
  dataUri?: string;
  fileData?: string;
  s3Key?: string;
}

/** Outbound files[] entry shape, matching `OutboundMessagePayload.files`. */
export interface BgosOutboundFileRef {
  fileName: string;
  fileMimeType: string;
  size: number;
  fileData?: string;
  s3Key?: string;
  // Classification flags - REQUIRED for the frontend to render an image/video
  // as such rather than a document card (backend stores them verbatim).
  isImage?: boolean;
  isVideo?: boolean;
  isAudio?: boolean;
  isDocument?: boolean;
  // Intrinsic image dimensions (px), when sniffable - drives aspect layout.
  width?: number;
  height?: number;
}

/** Coarse inbound classifier for Codex's existing pipelines. */
export type AttachmentKind = "photo" | "video" | "document" | "voice";

function inferKindFromMime(mime: string): AttachmentKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "photo";
  if (m.startsWith("video/")) return "video";
  // Voice notes are typically Opus/M4A; treat the audio family as "voice"
  // because Codex's voice pipeline (transcription) is the right consumer.
  if (m.startsWith("audio/")) return "voice";
  return "document";
}

/**
 * Decode a `data:<mime>;base64,...` URL into raw bytes.
 *
 * Throws if the input isn't a valid data URL - callers should fall back
 * to error handling, not silent ingestion of a malformed payload.
 */
function decodeDataUri(dataUri: string): Buffer {
  // Format: data:[<mime>];base64,<payload>
  const comma = dataUri.indexOf(",");
  if (comma === -1) throw new Error("invalid data URI: missing comma");
  const meta = dataUri.slice(0, comma);
  const payload = dataUri.slice(comma + 1);
  if (!meta.toLowerCase().includes("base64")) {
    // Unsupported (URL-encoded payloads are rare and we don't promise
    // to support them - agents would have to re-encode anyway).
    throw new Error("invalid data URI: only base64 encoding supported");
  }
  // Capped decode so a hostile backend cannot force a giant allocation.
  return decodeBase64Capped(payload);
}

/**
 * Download a BGOS attachment to a local tempfile and return its path +
 * inferred kind. Caller is responsible for cleaning the file up if
 * desired - Codex's existing pipelines tend to leak temp files anyway,
 * so we keep the lifetime contract loose and let OS temp cleanup handle
 * it.
 */
export async function ingestBgosAttachment(
  att: BgosInboundAttachment,
): Promise<{ localPath: string; kind: AttachmentKind; mimeType: string }> {
  const fileName = att.fileName || att.filename || "attachment";
  const mimeType = att.mimeType || att.mime || "application/octet-stream";
  const kind = inferKindFromMime(mimeType);

  // Build a unique temp path that preserves the original extension when
  // possible - Codex's vision/doc pipelines often sniff extensions.
  const ext = extname(fileName) || "";
  const baseName = `bgos-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}${ext}`;
  const localPath = join(tmpdir(), baseName);

  if (att.fileData) {
    // Inline base64; write directly under a size cap.
    await fsp.writeFile(localPath, decodeBase64Capped(att.fileData));
    return { localPath, kind, mimeType };
  }
  if (att.dataUri) {
    await fsp.writeFile(localPath, decodeDataUri(att.dataUri));
    return { localPath, kind, mimeType };
  }
  if (att.url) {
    // Presigned S3 URL. SECURITY: att.url is server-controlled, so validate it
    // against SSRF (no loopback / link-local / RFC1918 / cloud-metadata; every
    // redirect hop re-checked) BEFORE fetching, and stream to disk under a hard
    // byte cap so a hostile backend cannot fill the disk.
    const res = await fetchAttachmentGuarded(att.url);
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} for ${fileName}`);
    }
    if (!res.body) throw new Error(`download produced no body for ${fileName}`);
    // Reject an oversized declared length up front; the counting stream below
    // is the real cap for a lying/absent Content-Length.
    assertDeclaredSizeOk(res.headers.get("content-length"));
    let received = 0;
    const capStream = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > MAX_ATTACHMENT_BYTES) {
          cb(
            new AttachmentSizeError(
              `attachment ${fileName} exceeded the ${MAX_ATTACHMENT_BYTES} byte cap`,
            ),
          );
          return;
        }
        cb(null, chunk);
      },
    });
    // Node 18+ supports converting a fetch ReadableStream to a Node
    // Readable via Readable.fromWeb. The any-cast keeps the typecheck
    // narrow (lib.dom.d.ts inclusion varies by tsconfig).
    try {
      await pipeline(
        Readable.fromWeb(res.body as never),
        capStream,
        createWriteStream(localPath),
      );
    } catch (err) {
      // Remove any partial file so a capped/failed download leaves no litter.
      await fsp.unlink(localPath).catch(() => {});
      throw err;
    }
    return { localPath, kind, mimeType };
  }
  if (att.s3Key) {
    // We have an S3 key but no presigned URL - backend should have
    // included one. This shouldn't happen in practice; surface a useful
    // error rather than silently producing a missing file.
    throw new Error(
      `attachment ${fileName} has s3Key=${att.s3Key} but no fetch URL - ` +
        "backend should provide a presigned `url`",
    );
  }
  throw new Error(
    `attachment ${fileName} has no fetch path (no url/dataUri/fileData/s3Key)`,
  );
}

/**
 * Upload an outbound file referenced by absolute path. Returns a
 * `files[]` entry ready to attach to a `POST /messages` payload.
 *
 * Policy: inline base64 if the file is <`S3_THRESHOLD` bytes; otherwise
 * request a presigned PUT URL and stream the bytes to S3 directly.
 */
export async function publishMediaPath(
  api: BgosApi,
  filePath: string,
  opts: { fileName?: string; mimeType?: string } = {},
): Promise<BgosOutboundFileRef> {
  // SECURITY: validate the agent-supplied path against the allowlist
  // BEFORE reading any bytes. Throws (does not publish) on traversal,
  // out-of-root paths, sensitive locations, or escaping symlinks. This is
  // the single choke point for every outbound send path (sendFile /
  // sendImage / sendVideo / uploadFile), so the guard lives here. The
  // returned value is the resolved, symlink-free real path we read from.
  const safePath = resolveAllowedMediaPath(filePath);

  const stat = await fsp.stat(safePath);
  const size = stat.size;
  // Derive the display name from the ORIGINAL request (the real path may
  // differ after symlink resolution) unless the caller overrode it.
  const fileName = opts.fileName ?? filePath.split(/[\\/]/).pop() ?? "file";
  const mimeType = opts.mimeType ?? guessMimeType(fileName);
  const limit = mimeType.startsWith("video/")
    ? 100 * 1024 * 1024
    : mimeType.startsWith("image/")
      ? 10 * 1024 * 1024
      : 25 * 1024 * 1024;
  if (!stat.isFile() || size > limit)
    throw new Error(
      `Attachment must be a file no larger than ${limit / 1024 / 1024} MB.`,
    );

  // Read once up front: we need the bytes for both the inline path AND the
  // dimension sniff (images only). Files here are bounded by the media-guard.
  const bytes = await fsp.readFile(safePath);
  return publishMediaBytes(api, bytes, fileName, mimeType);
}

/** Remote media uses the same bounded, redirect-checked downloader as inbound files. */
export async function publishMediaUrl(
  api: BgosApi,
  url: string,
  opts: { fileName?: string; mimeType?: string } = {},
): Promise<BgosOutboundFileRef> {
  const name =
    opts.fileName ?? new URL(url).pathname.split("/").pop() ?? "attachment";
  const media = await ingestBgosAttachment({
    url,
    fileName: name,
    mimeType: opts.mimeType ?? guessMimeType(name),
  });
  try {
    return await publishMediaBytes(
      api,
      await fsp.readFile(media.localPath),
      name,
      media.mimeType,
    );
  } finally {
    await fsp.unlink(media.localPath).catch(() => {});
  }
}

/**
 * Upload bytes this process already holds, with no path and so no media
 * guard: the caller vouches for where they came from. Today that is exactly
 * one caller, a picture the Codex runtime generated, decoded off its own
 * `imageGeneration` item (stage 4, C-21). Never hand this anything an agent
 * named by path: that belongs to publishMediaPath, which checks the path
 * against the allowlist BEFORE reading a byte.
 *
 * The same caps, flags, dimensions and inline or S3 split as every other
 * outbound file, because it is the same function underneath.
 */
export function publishMediaBuffer(
  api: BgosApi,
  bytes: Buffer,
  opts: { fileName: string; mimeType: string },
): Promise<BgosOutboundFileRef> {
  return publishMediaBytes(api, bytes, opts.fileName, opts.mimeType);
}

async function publishMediaBytes(
  api: BgosApi,
  bytes: Buffer,
  fileName: string,
  mimeType: string,
): Promise<BgosOutboundFileRef> {
  const size = bytes.length;
  const limit = mimeType.startsWith("video/")
    ? 100 * 1024 * 1024
    : mimeType.startsWith("image/")
      ? 10 * 1024 * 1024
      : 25 * 1024 * 1024;
  if (size > limit)
    throw new Error(`Attachment exceeds the ${limit / 1024 / 1024} MB limit.`);
  const flags = classifyMedia(mimeType);
  const dims = flags.isImage ? sniffImageDimensions(bytes) : {};

  if (size < S3_THRESHOLD) {
    return {
      fileName,
      fileMimeType: mimeType,
      size,
      // data: URI so the client's <Image> can load it (bare base64 won't).
      fileData: toInlineDataUri(mimeType, bytes.toString("base64")),
      ...flags,
      ...dims,
    };
  }

  const presigned = await api.createUploadUrl({
    filename: fileName,
    mimeType,
    size,
  });
  const putRes = await fetch(presigned.upload_url, {
    signal: AbortSignal.timeout(120_000),
    method: "PUT",
    body: new Uint8Array(bytes),
    headers: { "Content-Type": mimeType },
  });
  if (!putRes.ok) {
    throw new Error(`S3 PUT failed: HTTP ${putRes.status} for ${fileName}`);
  }
  return {
    fileName,
    fileMimeType: mimeType,
    size,
    s3Key: presigned.s3_key,
    ...flags,
    ...dims,
  };
}

/** Minimal extension → MIME map covering BGOS's five rendered media kinds.
 *  Intentionally short - fall through to `application/octet-stream` for
 *  unknown types; the receiver still renders these as a download card. */
function guessMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
