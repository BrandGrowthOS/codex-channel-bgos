import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyMedia,
  sniffImageDimensions,
} from "../src/media-classify.js";
import { publishMediaPath } from "../src/attachment-bridge.js";
import { BgosApi } from "../src/bgos-api.js";

/** A real, valid solid-color RGB PNG (no image lib). */
function pngBytes(w: number, h: number): Buffer {
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const tc = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tc));
    return Buffer.concat([len, tc, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  // raw scanlines (filter byte 0 + RGB pixels), zlib-stored via Node zlib
  const zlib = require("node:zlib");
  const raw = Buffer.concat(
    Array.from({ length: h }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x7f)]),
    ),
  );
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("media-classify", () => {
  it("classifies each MIME family into exactly one flag", () => {
    expect(classifyMedia("image/png")).toMatchObject({ isImage: true, isDocument: false });
    expect(classifyMedia("video/mp4")).toMatchObject({ isVideo: true, isImage: false });
    expect(classifyMedia("audio/ogg")).toMatchObject({ isAudio: true });
    expect(classifyMedia("application/pdf")).toMatchObject({ isDocument: true });
    expect(classifyMedia("")).toMatchObject({ isDocument: true });
    for (const mime of ["image/png", "video/mp4", "audio/ogg", "application/pdf"]) {
      const f = classifyMedia(mime);
      expect(Object.values(f).filter(Boolean).length).toBe(1);
    }
  });

  it("sniffs PNG dimensions and returns {} for non-images", () => {
    expect(sniffImageDimensions(pngBytes(640, 480))).toEqual({ width: 640, height: 480 });
    expect(sniffImageDimensions(Buffer.from("not an image"))).toEqual({});
  });
});

describe("publishMediaPath", () => {
  let root: string;
  const original = process.env.CODEX_BGOS_MEDIA_ROOT;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-media-"));
    process.env.CODEX_BGOS_MEDIA_ROOT = root;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_BGOS_MEDIA_ROOT;
    else process.env.CODEX_BGOS_MEDIA_ROOT = original;
    rmSync(root, { recursive: true, force: true });
  });

  it("inline image: data URI + isImage + dimensions", async () => {
    const p = join(root, "poster.png");
    writeFileSync(p, pngBytes(120, 90));
    const api = {} as BgosApi; // not used on the inline path
    const ref = await publishMediaPath(api, p);
    expect(ref.isImage).toBe(true);
    expect(ref.isDocument).toBe(false);
    expect(ref.width).toBe(120);
    expect(ref.height).toBe(90);
    expect(ref.fileData?.startsWith("data:image/png;base64,")).toBe(true);
    expect(ref.s3Key).toBeUndefined();
  });

  it("large file: presigned S3 path still classifies", async () => {
    const p = join(root, "big.png");
    writeFileSync(p, Buffer.concat([pngBytes(10, 10), Buffer.alloc(600 * 1024, 1)]));
    const createUploadUrl = vi
      .fn()
      .mockResolvedValue({ upload_url: "https://s3/put", s3_key: "k/1" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const api = { createUploadUrl } as unknown as BgosApi;
    const ref = await publishMediaPath(api, p);
    expect(createUploadUrl).toHaveBeenCalledOnce();
    expect(ref.s3Key).toBe("k/1");
    expect(ref.fileData).toBeUndefined();
    expect(ref.isImage).toBe(true);
    fetchSpy.mockRestore();
  });
});

describe("BgosApi.createUploadUrl", () => {
  it("uses the correct route + camelCase keys and normalizes the response", async () => {
    const api = new BgosApi({ baseUrl: "https://x", pairingToken: "t" } as never);
    const post = vi.fn().mockResolvedValue({ data: { uploadUrl: "https://s3/u", key: "k/9" } });
    (api as unknown as { http: { post: typeof post } }).http = { post } as never;

    const out = await api.createUploadUrl({ filename: "a.png", mimeType: "image/png", size: 123 });

    expect(post).toHaveBeenCalledWith("files/upload-url", {
      fileName: "a.png",
      contentType: "image/png",
      size: 123,
    });
    expect(out).toEqual({ upload_url: "https://s3/u", s3_key: "k/9" });
  });
});
