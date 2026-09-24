/**
 * Fixtures for the stage 4 (C-21) picture tests.
 *
 * WHERE THESE SHAPES COME FROM, and what is not real. The live probe on
 * 2026-09-24 (docs/reports/2026-09-24-p5-s4-image-posts/probe.md) could not
 * make a picture: this machine's Codex is not logged in, so no
 * `imageGeneration` item was ever seen on the wire. So:
 *
 *  - The ENVELOPES are real. `item/started` carries `{item, threadId, turnId,
 *    startedAtMs}` and `item/completed` carries `{item, threadId, turnId,
 *    completedAtMs}`, copied from the probe's raw.jsonl (the userMessage and
 *    agentMessage lines), ids included.
 *  - The FAILED TURN is real: `PROBE_401_TURN` is the probe's own
 *    `turn/completed` params, verbatim except the request id and cf-ray,
 *    which are shortened.
 *  - The ITEM is the schema's, not the wire's: the seven fields the 0.154.0
 *    binary serialises for `ImageGenerationItem`, in its own order (id,
 *    status, revisedPrompt, result, transparentBackground, failure,
 *    savedPath), plus the `type` tag. The status strings are guesses the code
 *    must not depend on, and the ids come in two styles because under code
 *    mode a picture may arrive with an `exec-` id.
 */
import { deflateSync } from "node:zlib";

/** The probe's live thread and turn, reused so the envelopes are the real ones. */
export const PROBE_THREAD = "01a0d1b7-8827-74c2-8882-b5d8555d38e5";
export const PROBE_TURN = "01a0d1b7-88b9-7411-a15b-26c69d8782f0";

/** A real, valid solid colour RGB PNG, built without an image library. */
export function pngBytes(w: number, h: number): Buffer {
  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]!;
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(
    Array.from({ length: h }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xc8)]),
    ),
  );
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A gold circle on a dark background, as the probe asked for, in 64 by 64. */
export const GOLD_PNG = pngBytes(64, 64);

/**
 * One `ImageGenerationItem`, in the schema's own field order. A finished
 * picture by default; pass `failure` and `result: ""` for a refused one.
 */
export function imageItem(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "imageGeneration",
    id: "ig_01a0d1ba2874",
    status: "completed",
    revisedPrompt: "A plain gold circle centred on a dark charcoal background",
    result: GOLD_PNG.toString("base64"),
    transparentBackground: false,
    failure: null,
    savedPath:
      "C:\\Users\\owner\\.codex\\generated_images\\01a0d1b7-8827-74c2-8882-b5d8555d38e5\\ig_01a0d1ba2874.png",
    ...patch,
  };
}

/** The real `item/started` envelope around an item. */
export function itemStarted(
  item: Record<string, unknown>,
  threadId = PROBE_THREAD,
): Record<string, unknown> {
  return { item, threadId, turnId: PROBE_TURN, startedAtMs: 1790224861751 };
}

/** The real `item/completed` envelope around an item. */
export function itemCompleted(
  item: Record<string, unknown>,
  threadId = PROBE_THREAD,
): Record<string, unknown> {
  return { item, threadId, turnId: PROBE_TURN, completedAtMs: 1790224861752 };
}

/** The probe's own failed turn: a 401 that never reached the model. */
export function probe401Turn(threadId = PROBE_THREAD): Record<string, unknown> {
  return {
    threadId,
    turn: {
      id: PROBE_TURN,
      items: [],
      itemsView: "notLoaded",
      status: "failed",
      error: {
        message:
          "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a3ff...-DXB, request id: req_a6a0...",
        codexErrorInfo: "other",
        additionalDetails: null,
        misalignment: null,
      },
      startedAt: 1790224861,
      completedAt: 1790224876,
      durationMs: 14853,
    },
  };
}
