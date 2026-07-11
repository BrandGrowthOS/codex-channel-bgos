/**
 * Typing indicator (contract C4): WS `typing` emit + 1/3s per-chat throttle;
 * outbound.sendTyping delegates to the wired emitter and never throws.
 */
import { describe, expect, it, vi } from "vitest";

import { BgosWs } from "../src/bgos-ws.js";
import { BgosOutbound } from "../src/outbound.js";
import type { BgosApi } from "../src/bgos-api.js";

function makeWsWithFakeSocket(): {
  ws: BgosWs;
  emits: Array<{ event: string; payload: unknown }>;
} {
  const ws = new BgosWs({} as never, {} as BgosApi);
  const emits: Array<{ event: string; payload: unknown }> = [];
  (ws as unknown as { socket: unknown }).socket = {
    emit: (event: string, payload: unknown) => emits.push({ event, payload }),
  };
  return { ws, emits };
}

describe("typing", () => {
  it("emits a `typing` WS event with {chatId, assistantId}", () => {
    const { ws, emits } = makeWsWithFakeSocket();
    ws.emitTyping({ chatId: 9, assistantId: 3 });
    expect(emits).toHaveLength(1);
    expect(emits[0]).toEqual({
      event: "typing",
      payload: { chatId: 9, assistantId: 3 },
    });
  });

  it("throttles to 1 per 3s per chat", () => {
    const { ws, emits } = makeWsWithFakeSocket();
    ws.emitTyping({ chatId: 9, assistantId: 3 });
    ws.emitTyping({ chatId: 9, assistantId: 3 }); // throttled
    ws.emitTyping({ chatId: 10, assistantId: 3 }); // different chat -> allowed
    expect(emits).toHaveLength(2);
    expect((emits[1].payload as { chatId: number }).chatId).toBe(10);
  });

  it("emitTyping never throws when there is no socket", () => {
    const ws = new BgosWs({} as never, {} as BgosApi);
    expect(() => ws.emitTyping({ chatId: 1, assistantId: 1 })).not.toThrow();
  });

  it("outbound.sendTyping delegates to the wired emitter", async () => {
    const out = new BgosOutbound({} as BgosApi);
    const emitter = vi.fn();
    out.setTypingEmitter(emitter);
    await out.sendTyping({ assistantId: 4, chatId: 8 });
    expect(emitter).toHaveBeenCalledWith({ assistantId: 4, chatId: 8 });
  });

  it("outbound.sendTyping is a safe no-op without an emitter", async () => {
    const out = new BgosOutbound({} as BgosApi);
    await expect(out.sendTyping({ assistantId: 1, chatId: 2 })).resolves.toBeUndefined();
  });
});
