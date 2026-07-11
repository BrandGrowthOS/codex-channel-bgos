/**
 * Outbound attachment classification + intrinsic-dimension sniffing.
 *
 * Why this exists: the BGOS backend stores `isImage`/`isVideo`/`isAudio`/
 * `isDocument` on a message_file VERBATIM - it does NOT derive them from the
 * MIME type (`row.isImage = dto.isImage ?? null`). The frontend renders a
 * file as an inline image/video ONLY when the matching flag is `true`;
 * otherwise it falls back to a generic document card. So an outbound image
 * sent WITHOUT `isImage: true` silently renders as a non-image download card
 * (the live "agent images don't show in BGOS" bug, 2026-05-31). Every
 * outbound attachment must therefore carry these flags.
 */

export interface MediaKindFlags {
  isImage: boolean;
  isVideo: boolean;
  isAudio: boolean;
  isDocument: boolean;
}

/** Map a MIME type to BGOS's four mutually-exclusive attachment-kind flags. */
export function classifyMedia(mime: string): MediaKindFlags {
  const m = (mime || "").toLowerCase();
  const isImage = m.startsWith("image/");
  const isVideo = m.startsWith("video/");
  const isAudio = m.startsWith("audio/");
  return {
    isImage,
    isVideo,
    isAudio,
    // Anything that isn't recognized media is a document (the download-card
    // fallback). Mutually exclusive with the three above.
    isDocument: !(isImage || isVideo || isAudio),
  };
}

/** Wrap raw base64 as a data URI. The client feeds inline `fileData` straight
 *  into `<Image source={{ uri }}>`, which needs a real URI - bare base64
 *  won't load. (The `/send-message` path also accepts/coerces this; the
 *  `/messages` path stores it verbatim and renders it directly.) */
export function toInlineDataUri(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/**
 * Best-effort intrinsic (width, height) for the common image formats,
 * dependency-free (no image library). Returns `{}` for anything it can't
 * parse - width/height are optional (the frontend measures the image when
 * they're absent), so a miss only costs a brief initial-layout aspect
 * imprecision. Fully guarded: a malformed header yields `{}`, never throws.
 */
export function sniffImageDimensions(
  data: Uint8Array,
): { width?: number; height?: number } {
  const b = data;
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // PNG: 8-byte sig, then an IHDR chunk with width/height as big-endian u32.
    if (
      b.length >= 24 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52
    ) {
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    // GIF: 'GIF8' then logical-screen width/height little-endian.
    if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    }
    // JPEG: scan for a Start-Of-Frame (SOFn) marker carrying dimensions.
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1];
        i += 2;
        // SOF0..SOF15 except DHT(C4)/JPG(C8)/DAC(CC) carry the frame size.
        if (
          marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        ) {
          return { height: dv.getUint16(i + 3), width: dv.getUint16(i + 5) };
        }
        if (i + 2 > b.length) break;
        i += dv.getUint16(i); // skip this segment
      }
      return {};
    }
    // WebP (RIFF container): VP8 (lossy) / VP8L (lossless) / VP8X (extended).
    if (
      b.length >= 30 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    ) {
      const fmt = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (fmt === "VP8 ") {
        return {
          width: dv.getUint16(26, true) & 0x3fff,
          height: dv.getUint16(28, true) & 0x3fff,
        };
      }
      if (fmt === "VP8L") {
        const b1 = b[21], b2 = b[22], b3 = b[23], b4 = b[24];
        return {
          width: (((b2 & 0x3f) << 8) | b1) + 1,
          height: (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) + 1,
        };
      }
      if (fmt === "VP8X") {
        return {
          width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
          height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
        };
      }
    }
  } catch {
    return {};
  }
  return {};
}
