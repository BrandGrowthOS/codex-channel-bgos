/**
 * The changes lane's wiring (P7 stage 3, C-31; BGOS spec 10.2).
 *
 * The handler is only half of it: the socket has to hear `changes_rpc`,
 * normalize it and pass it on; the adapter has to hand it to the CHANGES
 * handler (built with the host's own folder and the scope rule every other
 * pairing room frame uses); and the API has to post to the changes routes.
 * Each seam is a constructor argument or a one line listener, so nothing
 * else in the suite would notice one going missing. These read the source
 * the way test/adapter-mission-wiring.spec.ts does, plus one behavioural case
 * over a fake socket and one over the API's own http client.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import type { ChangesRpcFrame } from "../src/changes-handler.js";

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

const WS = readFileSync("src/bgos-ws.ts", "utf8");
const ADAPTER = readFileSync("src/adapter.ts", "utf8");

/** From `start` to the `}` that closes the first `{` after it. */
function block(source: string, start: string): string {
  const from = source.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unclosed block after ${start}`);
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

describe("the socket hears changes_rpc", () => {
  it("names changes_rpc in its EventMap", () => {
    const lines = WS.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain("changes_rpc: [ChangesRpcFrame];");
  });

  it("normalizes with normalizeChangesRpc before it emits, in one place", () => {
    const handler = block(WS, 'socket.on("changes_rpc"');
    const normalized = handler.indexOf("normalizeChangesRpc(");
    const emitted = handler.indexOf('this.emitter.emit("changes_rpc"');
    expect(normalized).toBeGreaterThan(0);
    expect(emitted).toBeGreaterThan(normalized);
    expect(count(WS, 'socket.on("changes_rpc"')).toBe(1);
    expect(count(WS, 'this.emitter.emit("changes_rpc"')).toBe(1);
  });

  it("a normalized frame emitted by a fake socket reaches the handler once", async () => {
    hoisted.sockets.length = 0;
    const ws = new BgosWs(
      {
        baseUrl: "http://127.0.0.1:1",
        pairingToken: "pair_" + "x".repeat(30),
        reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
      } as never,
      {} as BgosApi,
    );
    const frames: ChangesRpcFrame[] = [];
    ws.on("changes_rpc", (frame) => frames.push(frame));
    await ws.connect();
    const socket = hoisted.sockets[0]!;

    socket.deliver("changes_rpc", {
      rpcId: "rpc-1",
      op: "diff",
      assistantId: 703,
      payload: { scope: "uncommitted", maxPatchBytes: 1_048_576 },
    });
    expect(frames).toEqual([
      {
        rpcId: "rpc-1",
        op: "diff",
        assistantId: "703",
        payload: { scope: "uncommitted", maxPatchBytes: 1_048_576 },
      },
    ]);

    // A frame with no rpcId is dropped at the socket.
    socket.deliver("changes_rpc", { op: "diff", assistantId: 703 });
    socket.deliver("changes_rpc", null);
    expect(frames).toHaveLength(1);
    ws.disconnect();
  });
});

describe("the adapter hands the frame to the changes handler", () => {
  it("builds the handler with the host's folder and the scope rule, after the host exists", () => {
    const construction = block(
      ADAPTER,
      "this.changesHandler = createChangesHandler(",
    );
    expect(construction).toContain("api: this.api,");
    expect(construction).toContain("workdir: this.host.workdir,");
    expect(construction).toContain(
      "owns: (id) => this.ownsAssistantForMission(Number(id)),",
    );
    // this.host is read at construction, so it must already exist.
    expect(ADAPTER.indexOf("this.host = new CodexHost(")).toBeGreaterThan(0);
    expect(
      ADAPTER.indexOf("this.changesHandler = createChangesHandler("),
    ).toBeGreaterThan(ADAPTER.indexOf("this.host = new CodexHost("));
    expect(count(ADAPTER, "createChangesHandler(")).toBe(1);
  });

  it("wires changes_rpc to the changes handler, and to nothing else", () => {
    const listener = block(ADAPTER, 'this.ws.on("changes_rpc"');
    expect(listener).toContain("void this.changesHandler(frame);");
    expect(listener).not.toContain("skillsHandler");
    expect(listener).not.toContain("handleControl");
    expect(count(ADAPTER, 'this.ws.on("changes_rpc"')).toBe(1);
  });
});

describe("the API posts to the changes lane", () => {
  it("posts the ack and the result to integrations/changes-rpc, with their own timeouts", async () => {
    const api = new BgosApi({
      baseUrl: "https://example.test",
      pairingToken: "pair-token",
    } as never);
    const http = (
      api as unknown as {
        http: {
          post: (
            url: string,
            body: unknown,
            config?: { timeout?: number },
          ) => Promise<{ data: unknown }>;
        };
      }
    ).http;
    const post = vi.spyOn(http, "post").mockResolvedValue({ data: {} });
    const body = {
      ok: false as const,
      error: { code: "too_slow", message: "slow" },
    };

    await api.changesRpcAck("rpc/1");
    await api.changesRpcResult("rpc/1", body);

    expect(post.mock.calls).toEqual([
      ["integrations/changes-rpc/rpc%2F1/ack", {}, { timeout: 3_000 }],
      ["integrations/changes-rpc/rpc%2F1/result", body, { timeout: 8_000 }],
    ]);
  });
});
