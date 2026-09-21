/**
 * The mission listener on the WS client, and its dedupe.
 *
 * THE DOUBLE DELIVERY GUARD. A Codex socket sits in BOTH `pairing:<id>` and
 * `assistant:<id>`. The gateway builds one event object and emits it to an
 * array of rooms, and socket.io then delivers one copy per socket, but this
 * daemon cannot control which backend version it is talking to: a daemon in
 * the field outlives a backend deploy and the reverse. So the dedupe lives
 * here, it is inert against a backend that sends one copy, and it must hold
 * BEFORE the backend's assistant room emit ships, not after.
 */
import { describe, expect, it, vi } from "vitest";

import type { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import { MISSION_EVENT_TYPES, type MissionEventFrame } from "../src/mission-events.js";

const hoisted = vi.hoisted(() => ({
  sockets: [] as Array<{
    deliver: (event: string, payload: unknown) => void;
    emit: (event: string, payload: unknown) => void;
    disconnect: () => void;
    io: { on: (event: string, fn: () => void) => void };
  }>,
}));

vi.mock("socket.io-client", () => ({
  io: () => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const socket = {
      on(event: string, fn: (payload: unknown) => void) {
        const list = handlers.get(event) ?? [];
        list.push(fn);
        handlers.set(event, list);
        return socket;
      },
      emit: () => {},
      disconnect: () => {},
      io: { on: () => {} },
      deliver(event: string, payload: unknown) {
        for (const fn of handlers.get(event) ?? []) fn(payload);
      },
    };
    hoisted.sockets.push(socket as never);
    return socket;
  },
}));

const CFG = {
  baseUrl: "http://127.0.0.1:1",
  pairingToken: "pair_" + "x".repeat(30),
  reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
} as never;

function missionPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_type: "mission_paused",
    user_id: "user_2abc",
    assistant_id: 7,
    chat_id: 4403,
    mission: {
      id: 91,
      assistantId: 7,
      title: "Ship the strip",
      status: "paused",
      origin: "derived",
      updatedAt: "2026-09-20T12:00:00.000Z",
    },
    timestamp: "2026-09-20T12:00:00.500Z",
    ...overrides,
  };
}

async function connected() {
  hoisted.sockets.length = 0;
  const ws = new BgosWs(CFG, {} as BgosApi);
  const frames: MissionEventFrame[] = [];
  ws.on("mission_event", (frame) => frames.push(frame));
  await ws.connect();
  const socket = hoisted.sockets[0]!;
  return { ws, socket, frames };
}

describe("BgosWs mission listener", () => {
  it("registers every one of the eight mission frames", async () => {
    const { socket, frames } = await connected();
    for (const type of MISSION_EVENT_TYPES) {
      socket.deliver(type, missionPayload({ event_type: type, timestamp: `t-${type}` }));
    }
    expect(frames.map((f) => f.eventType)).toEqual([...MISSION_EVENT_TYPES]);
  });

  it("emits exactly one mission_event for one delivery", async () => {
    const { socket, frames } = await connected();
    socket.deliver("mission_paused", missionPayload());
    expect(frames).toHaveLength(1);
    expect(frames[0]!.mission.id).toBe(91);
    expect(frames[0]!.chatId).toBe(4403);
  });

  it("emits exactly ONE mission_event when the same event arrives twice", async () => {
    const { socket, frames } = await connected();
    // The pairing room copy and the assistant room copy of one logical event.
    socket.deliver("mission_paused", missionPayload());
    socket.deliver("mission_paused", missionPayload());
    expect(frames).toHaveLength(1);
  });

  it("passes two different events that name one mission", async () => {
    const { socket, frames } = await connected();
    socket.deliver("mission_paused", missionPayload());
    socket.deliver(
      "mission_resumed",
      missionPayload({ event_type: "mission_resumed", timestamp: "2026-09-20T12:05:00.000Z" }),
    );
    expect(frames.map((f) => f.eventType)).toEqual(["mission_paused", "mission_resumed"]);
  });

  it("clears the dedupe on disconnect so a reconnect replay is not swallowed", async () => {
    const { socket, frames } = await connected();
    socket.deliver("mission_paused", missionPayload());
    expect(frames).toHaveLength(1);
    socket.deliver("disconnect", undefined);
    socket.deliver("mission_paused", missionPayload());
    expect(frames).toHaveLength(2);
  });

  it("drops a malformed payload without throwing and without emitting", async () => {
    const { socket, frames } = await connected();
    expect(() => socket.deliver("mission_paused", null)).not.toThrow();
    expect(() => socket.deliver("mission_paused", { mission: { id: 0 } })).not.toThrow();
    expect(() => socket.deliver("mission_paused", "junk")).not.toThrow();
    expect(frames).toHaveLength(0);
  });

  it("bounds the dedupe set so a long lived daemon cannot grow it forever", async () => {
    const { ws, socket, frames } = await connected();
    for (let i = 0; i < 260; i += 1) {
      socket.deliver(
        "mission_ticked",
        missionPayload({ event_type: "mission_ticked", timestamp: `2026-09-20T12:00:${i}.000Z` }),
      );
    }
    expect(frames).toHaveLength(260);
    const seen = (ws as unknown as { missionSeen: Set<string> }).missionSeen;
    expect(seen.size).toBeLessThanOrEqual(200);
  });
});
