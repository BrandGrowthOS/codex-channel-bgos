/**
 * The busy signal the supervisor's safe moment reads (finding 9: never
 * restart an agent mid job). Busy is ANY chat's turn running or queued,
 * across every chat, and every change is announced so the heartbeat file is
 * rewritten at once. A Codex background terminal (a live monitor a turn left
 * running, `thread/backgroundTerminals/list`) is a job too: the child counts
 * them when the supervisor asks it to stop, and an answer it cannot read
 * counts as busy.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexHost } from "../src/codex-host.js";

class Server extends EventEmitter {
  onRequest: any;
  next = 0;
  terminals: (threadId: string) => any = () => ({ data: [], nextCursor: null });
  start = vi.fn(async () => {});
  close = vi.fn(() => this.emit("closed", new Error("closed")));
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/start") return { thread: { id: `thread-${++this.next}` } };
    if (method === "thread/resume") return { thread: { id: p.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${p.threadId}` } };
    if (method === "thread/backgroundTerminals/list") return this.terminals(p.threadId);
    return {};
  });
  finish(id: string) {
    this.emit("notification", "item/completed", {
      threadId: id,
      item: { id: "message", type: "agentMessage", text: "done" },
    });
    this.emit("notification", "turn/completed", {
      threadId: id,
      turn: { status: "completed" },
    });
  }
}

describe("CodexHost busy signal across all chats", () => {
  let home: string, server: Server, host: CodexHost;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-host-busy-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      tools: [],
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const turnStarts = () =>
    server.request.mock.calls.filter((c) => c[0] === "turn/start").length;

  it("is busy from the moment a turn is queued until the last chat finishes, announcing each edge once", async () => {
    const changes: boolean[] = [];
    host.onBusyChange((busy) => changes.push(busy));
    expect(host.isAnyBusy()).toBe(false);
    const one = host.runTurn(1, "first");
    // Queued is busy already: the turn has not reached the runtime yet.
    expect(host.isAnyBusy()).toBe(true);
    // And it is announced at once, so the heartbeat file says so before the
    // supervisor can read "idle" for a turn that has started.
    expect(changes).toEqual([true]);
    const two = host.runTurn(2, "second");
    await vi.waitFor(() => expect(turnStarts()).toBe(2));
    server.finish("thread-1");
    await one;
    expect(host.isAnyBusy()).toBe(true);
    server.finish("thread-2");
    await two;
    await vi.waitFor(() => expect(host.isAnyBusy()).toBe(false));
    expect(changes).toEqual([true, false]);
  });

  it("a listener can be removed", async () => {
    const changes: boolean[] = [];
    const off = host.onBusyChange((busy) => changes.push(busy));
    off();
    const task = host.runTurn(1, "first");
    await vi.waitFor(() => expect(turnStarts()).toBe(1));
    server.finish("thread-1");
    await task;
    expect(changes).toEqual([]);
  });

  it("counts background terminals on every thread this process loaded", async () => {
    expect(await host.backgroundTerminalCount()).toBe(0);
    expect(server.request).not.toHaveBeenCalledWith(
      "thread/backgroundTerminals/list",
      expect.anything(),
    );
    const task = host.runTurn(1, "start a monitor");
    await vi.waitFor(() => expect(turnStarts()).toBe(1));
    server.finish("thread-1");
    await task;
    server.terminals = () => ({
      data: [{ id: "bg-1", command: "tail -f build.log" }],
      nextCursor: null,
    });
    expect(await host.backgroundTerminalCount()).toBe(1);
    expect(server.request).toHaveBeenCalledWith("thread/backgroundTerminals/list", {
      threadId: "thread-1",
    });
  });

  it("a runtime without the method has no background terminals", async () => {
    const task = host.runTurn(1, "hello");
    await vi.waitFor(() => expect(turnStarts()).toBe(1));
    server.finish("thread-1");
    await task;
    server.terminals = () => {
      throw new Error("Method not found: thread/backgroundTerminals/list");
    };
    expect(await host.backgroundTerminalCount()).toBe(0);
  });

  it("an answer it cannot read is not a zero (fails closed)", async () => {
    const task = host.runTurn(1, "hello");
    await vi.waitFor(() => expect(turnStarts()).toBe(1));
    server.finish("thread-1");
    await task;
    server.terminals = () => ({ something: "else" });
    await expect(host.backgroundTerminalCount()).rejects.toThrow();
    server.terminals = () => {
      throw new Error("Codex thread/backgroundTerminals/list timed out.");
    };
    await expect(host.backgroundTerminalCount()).rejects.toThrow("timed out");
  });
});
