/**
 * The plan level and the plan chip on the SOCKET.
 *
 * `inbound-handler.spec.ts` proves the level reaches the turn once it is on
 * the event; this file proves the WS client puts it there. The normalizer
 * accepts camelCase and snake_case for every other field on this envelope and
 * a field it does not name is simply dropped, silently, which is the whole
 * failure mode: the backend would be sending the owner's plan level and the
 * agent would never hear about it.
 *
 * MUTATION PROOF, run against this tree: deleting the `planPolicy` branch from
 * `normalizeInboundMessage` in src/bgos-ws.ts turns the level cases red;
 * restoring it turns them green and leaves the file's sha256 unchanged.
 */
import { describe, expect, it, vi } from "vitest";

import type { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";

const hoisted = vi.hoisted(() => ({
  sockets: [] as Array<{
    deliver: (event: string, payload: unknown) => void;
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

async function connected() {
  hoisted.sockets.length = 0;
  const ws = new BgosWs(CFG, {} as BgosApi);
  const messages: Array<Record<string, unknown>> = [];
  const clicks: Array<Record<string, unknown>> = [];
  ws.on("inbound_message", (m) => messages.push(m as never));
  ws.on("inbound_click", (c) => clicks.push(c as never));
  await ws.connect();
  return { socket: hoisted.sockets[0]!, messages, clicks };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    assistant_id: 9,
    chat_id: 4403,
    message_id: 77,
    user_id: "user_2abc",
    text: "add retry",
    ...overrides,
  };
}

describe("the inbound envelope carries the owner's plan level", () => {
  it("reads it in camelCase and in snake_case", async () => {
    const { socket, messages } = await connected();
    socket.deliver("inbound_message", message({ planPolicy: "always" }));
    socket.deliver(
      "inbound_message",
      message({ message_id: 78, plan_policy: "risky_jobs" }),
    );
    expect(messages[0]!.planPolicy).toBe("always");
    expect(messages[1]!.planPolicy).toBe("risky_jobs");
  });

  it("omits it rather than inventing one when the backend sends none", async () => {
    const { socket, messages } = await connected();
    socket.deliver("inbound_message", message());
    expect(messages[0]).not.toHaveProperty("planPolicy");
  });
});

describe("a plan chip arrives on the click lane that already exists", () => {
  it("keeps the code and the typed words the armed composer sent", async () => {
    // One stimulus, never a click plus a message: on Codex a second message
    // would start a second turn.
    const { socket, clicks } = await connected();
    socket.deliver("inbound_click", {
      assistant_id: 9,
      chat_id: 4403,
      message_id: 501,
      callback_data: "plan:change",
      custom_text: "Skip the second step.",
      user_id: "user_2abc",
    });
    expect(clicks[0]).toMatchObject({
      callbackData: "plan:change",
      customText: "Skip the second step.",
      messageId: 501,
    });
  });
});
