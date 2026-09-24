import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyMedia,
  sniffImageDimensions,
} from "../src/media-classify.js";
import {
  publishMediaBuffer,
  publishMediaPath,
} from "../src/attachment-bridge.js";
import { BgosApi } from "../src/bgos-api.js";
import { BgosOutbound } from "../src/outbound.js";
import { buildReplyHandle } from "../src/inbound-handler.js";

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

/**
 * Stage 4 (C-21): a picture Codex made is posted from its BYTES, decoded off
 * the item's base64, and never from a path. So nothing lands in the owner's
 * repo (the media root IS the agent's workdir) and the media guard keeps its
 * one root. The bytes path must still carry the image cap, the kind flags,
 * the dimensions, and the outbound retry and spool every other send has.
 */
describe("publishMediaBuffer", () => {
  it("inlines a small picture with its flags and dimensions", async () => {
    const ref = await publishMediaBuffer({} as BgosApi, pngBytes(64, 48), {
      fileName: "codex-image-ig_1.png",
      mimeType: "image/png",
    });
    expect(ref).toMatchObject({
      fileName: "codex-image-ig_1.png",
      fileMimeType: "image/png",
      isImage: true,
      isDocument: false,
      width: 64,
      height: 48,
    });
    expect(ref.fileData?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("takes the presigned S3 path above the inline threshold", async () => {
    const createUploadUrl = vi
      .fn()
      .mockResolvedValue({ upload_url: "https://s3/put", s3_key: "k/2" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const bytes = Buffer.concat([pngBytes(10, 10), Buffer.alloc(600 * 1024, 1)]);
    const ref = await publishMediaBuffer(
      { createUploadUrl } as unknown as BgosApi,
      bytes,
      { fileName: "big.png", mimeType: "image/png" },
    );
    expect(ref.s3Key).toBe("k/2");
    expect(ref.isImage).toBe(true);
    fetchSpy.mockRestore();
  });

  it("refuses a picture over the 10 MB image cap", async () => {
    await expect(
      publishMediaBuffer({} as BgosApi, Buffer.alloc(10 * 1024 * 1024 + 1), {
        fileName: "huge.png",
        mimeType: "image/png",
      }),
    ).rejects.toThrow(/10 MB/);
  });
});

describe("BgosOutbound.sendImageBytes", () => {
  function fakeApi(post: () => Promise<{ id: number }>) {
    return { postMessage: vi.fn(post), sendMessage: vi.fn(post) };
  }

  it("posts one standard message: the caption as text, the picture as its file", async () => {
    const api = fakeApi(async () => ({ id: 7 }));
    const out = new BgosOutbound(api as unknown as BgosApi);
    const sent = await out.sendImageBytes({
      assistantId: 10,
      chatId: 20,
      bytes: pngBytes(32, 32),
      fileName: "codex-image-ig_1.png",
      mimeType: "image/png",
      caption: "Prompt: A plain gold circle",
    });
    expect(sent).toEqual({ id: 7 });
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    const payload = (api.postMessage.mock.calls[0] as unknown[])[0] as any;
    expect(payload).toMatchObject({
      assistantId: 10,
      chatId: 20,
      sender: "assistant",
      text: "Prompt: A plain gold circle",
      messageType: "standard",
    });
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toMatchObject({
      fileName: "codex-image-ig_1.png",
      isImage: true,
      width: 32,
      height: 32,
    });
  });

  it("sends an empty text when there is no caption, exactly like sendFile", async () => {
    const api = fakeApi(async () => ({ id: 1 }));
    const out = new BgosOutbound(api as unknown as BgosApi);
    await out.sendImageBytes({
      assistantId: 10,
      chatId: 20,
      bytes: pngBytes(8, 8),
      fileName: "codex-image-1.png",
      mimeType: "image/png",
    });
    expect((api.postMessage.mock.calls[0] as any[])[0].text).toBe("");
  });

  it("refuses a picture over the 10 MB cap before anything is posted", async () => {
    const api = fakeApi(async () => ({ id: 1 }));
    const out = new BgosOutbound(api as unknown as BgosApi);
    await expect(
      out.sendImageBytes({
        assistantId: 10,
        chatId: 20,
        bytes: Buffer.alloc(10 * 1024 * 1024 + 1),
        fileName: "huge.png",
        mimeType: "image/png",
      }),
    ).rejects.toThrow(/10 MB/);
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it("refuses bytes that are not labelled as a picture", async () => {
    const api = fakeApi(async () => ({ id: 1 }));
    const out = new BgosOutbound(api as unknown as BgosApi);
    await expect(
      out.sendImageBytes({
        assistantId: 10,
        chatId: 20,
        bytes: Buffer.from("text"),
        fileName: "notes.txt",
        mimeType: "text/plain",
      }),
    ).rejects.toThrow(/image/);
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it("rides the same retry as every other send", async () => {
    let calls = 0;
    const api = fakeApi(async () => {
      calls += 1;
      if (calls < 2)
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      return { id: 9 };
    });
    const out = new BgosOutbound(api as unknown as BgosApi);
    out.setSleepFn(async () => {});
    await expect(
      out.sendImageBytes({
        assistantId: 10,
        chatId: 20,
        bytes: pngBytes(8, 8),
        fileName: "codex-image-1.png",
        mimeType: "image/png",
      }),
    ).resolves.toEqual({ id: 9 });
    expect(api.postMessage).toHaveBeenCalledTimes(2);
  });

  it("goes out on the peer route a reply handle carries", async () => {
    const outbound = { sendImageBytes: vi.fn(async () => ({ id: 3 })) };
    const handle = buildReplyHandle(
      { outbound: outbound as unknown as BgosOutbound },
      { assistantId: 10, chatId: 20, replyVia: "send-message", replyToId: 55 },
    );
    const bytes = pngBytes(8, 8);
    await handle.sendImageBytes(
      { bytes, fileName: "codex-image-1.png", mimeType: "image/png" },
      "Prompt: a circle",
    );
    expect(outbound.sendImageBytes).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      bytes,
      fileName: "codex-image-1.png",
      mimeType: "image/png",
      caption: "Prompt: a circle",
      replyVia: "send-message",
      replyToId: 55,
    });
  });
});
