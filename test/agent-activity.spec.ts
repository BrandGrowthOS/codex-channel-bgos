import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import { CodexHost } from "../src/codex-host.js";
import type { ActivityMarker } from "../src/activity-markers.js";

/**
 * The host fake from codex-host.spec.ts. It is not exported from there, so
 * the twenty lines are copied rather than reached across two spec files.
 */
class Server extends EventEmitter {
  onRequest: any;
  next = 0;
  start = vi.fn(async () => {});
  close = vi.fn(() => this.emit("closed", new Error("closed")));
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/start")
      return { thread: { id: `thread-${++this.next}` } };
    if (method === "thread/resume") return { thread: { id: p.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${p.threadId}` } };
    return {};
  });
  finish(id: string, text: string) {
    this.emit("notification", "item/completed", {
      threadId: id,
      item: { id: "message", type: "agentMessage", text },
    });
    this.emit("notification", "turn/completed", {
      threadId: id,
      turn: { status: "completed" },
    });
  }
}

describe("the Codex host's activity events", () => {
  let home: string, server: Server, host: CodexHost;
  const idle: Array<{ chatId: number; marker: ActivityMarker }> = [];

  beforeEach(() => {
    idle.length = 0;
    home = mkdtempSync(join(tmpdir(), "hoai-activity-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      onIdleActivityMarker: (chatId, marker) => {
        idle.push({ chatId, marker });
      },
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("gives an edit row its file path, straight from the item", async () => {
    const cards: any[] = [];
    const task = host.runTurn(17, "edit", {
      onTool: (card, itemId) => {
        cards.push({ card, itemId });
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: {
        id: "fc1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: { type: "update" }, diff: "-secret" },
          { path: "src/b.ts", kind: { type: "add" }, diff: "+x" },
        ],
      },
    });
    server.finish("thread-1", "Done");
    await task;

    expect(cards).toHaveLength(1);
    expect(cards[0].itemId).toBe("fc1");
    expect(cards[0].card).toMatchObject({
      name: "edit",
      args: "src/a.ts +1",
      path: "src/a.ts",
      pathCount: 2,
      kind: "tool",
    });
    expect(JSON.stringify(cards[0])).not.toContain("secret");
  });

  it("shortens a path against the cwd its own items reported", async () => {
    const cards: any[] = [];
    const task = host.runTurn(17, "edit", {
      onTool: (card, itemId) => {
        cards.push({ card, itemId });
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    // Only commandExecution carries a cwd. The host keeps the last one it saw
    // for the thread and every later row is shortened against it.
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: {
        id: "c1",
        type: "commandExecution",
        command: "ls",
        cwd: "/work/repo",
        status: "completed",
      },
    });
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: {
        id: "fc1",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "/work/repo/src/a.ts", kind: { type: "update" }, diff: "x" },
        ],
      },
    });
    server.finish("thread-1", "Done");
    await task;

    expect(cards.at(-1).card.path).toBe("src/a.ts");
    expect(cards.at(-1).card.args).toBe("src/a.ts");
    expect(JSON.stringify(cards)).not.toContain("/work/repo/src");
  });

  it("never re opens a row it already closed, and times it from the envelope", async () => {
    const cards: any[] = [];
    const task = host.runTurn(17, "search", {
      onTool: (card, itemId) => {
        cards.push({ card, itemId });
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    const item = {
      id: "m1",
      type: "mcpToolCall",
      server: "bgos",
      tool: "search",
    };
    server.emit("notification", "item/started", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      startedAtMs: 1_000,
      item,
    });
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      completedAtMs: 3_000,
      item: { ...item, status: "completed" },
    });
    // The server's last progress line, arriving after the item completed.
    server.emit("notification", "item/mcpToolCall/progress", {
      threadId: "thread-1",
      itemId: "m1",
      message: "page 9 of 9",
    });
    server.finish("thread-1", "Done");
    await task;

    expect(cards.map((c) => c.card.status)).toEqual(["running", "done"]);
    expect(cards.at(-1).card.durationMs).toBe(2_000);
  });

  it("keeps a marker's dedupe key unburned when no sink took it", async () => {
    // A turn with no onActivityMarker: nobody is listening, so the compaction
    // is not delivered and the key must stay free for the next announcement.
    const task = host.runTurn(17, "work");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "thread/compacted", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
    });
    server.finish("thread-1", "Done");
    await task;
    expect(idle).toEqual([]);

    server.emit("notification", "thread/compacted", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(idle.map((entry) => entry.marker.kind)).toEqual([
      "context_compacted",
    ]);
  });

  it("marks a compaction once, whichever notification announces it", async () => {
    const markers: ActivityMarker[] = [];
    const task = host.runTurn(17, "work", {
      onActivityMarker: (marker) => {
        markers.push(marker);
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/started", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: { id: "cc1", type: "contextCompaction" },
    });
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: { id: "cc1", type: "contextCompaction" },
    });
    server.emit("notification", "thread/compacted", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
    });
    server.finish("thread-1", "Done");
    await task;

    expect(markers.map((m) => m.kind)).toEqual(["context_compacted"]);
    expect(idle).toEqual([]);
  });

  it("marks the owner's own compaction, which runs outside any turn", async () => {
    const task = host.runTurn(17, "work");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.finish("thread-1", "Done");
    await task;
    // The chat is resolved from the thread map, not from an active turn.
    expect(JSON.parse(readFileSync(join(home, "threads.json"), "utf8"))).toEqual(
      { "17": "thread-1" },
    );

    server.emit("notification", "thread/compacted", {
      threadId: "thread-1",
      turnId: "compaction-turn",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(idle).toHaveLength(1);
    expect(idle[0]!.chatId).toBe(17);
    expect(idle[0]!.marker.kind).toBe("context_compacted");
  });

  it("drains a marker before the turn resolves", async () => {
    let release: () => void = () => {};
    const posted = new Promise<void>((r) => {
      release = r;
    });
    let done = false;
    const result = host
      .runTurn(17, "work", { onActivityMarker: () => posted })
      .then(() => {
        done = true;
      });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "thread/compacted", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
    });
    server.finish("thread-1", "Done");
    // A macrotask tick drains every microtask, so `done` can only still be
    // false if the marker callback itself is holding the turn open.
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    release();
    await result;
    expect(done).toBe(true);
  });

  it("says work continues only while a worker is still alive at the end", async () => {
    let expected = 0;
    async function run(workerStatus: string, turnStatus: string) {
      expected += 1;
      const markers: ActivityMarker[] = [];
      const task = host.runTurn(17, "delegate", {
        onActivityMarker: (marker) => {
          markers.push(marker);
        },
      });
      await vi.waitFor(() => expect(server.next).toBe(expected));
      const threadId = `thread-${expected}`;
      server.emit("notification", "item/completed", {
        threadId,
        turnId: `turn-${threadId}`,
        item: {
          id: "col1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          receiverThreadIds: ["t9"],
          agentsStates: { t9: { status: workerStatus } },
        },
      });
      server.emit("notification", "turn/completed", {
        threadId,
        turn: { status: turnStatus },
      });
      await task;
      return markers;
    }

    const still = await run("running", "completed");
    expect(still.map((m) => m.kind)).toEqual(["turn_continues"]);
    expect(still[0]!.payload.what).toBe("1 subagent is still working");

    host.resetChat(17);
    expect((await run("completed", "completed")).length).toBe(0);
    host.resetChat(17);
    // A turn the owner stopped is not a normal exit.
    expect((await run("running", "interrupted")).length).toBe(0);
  });
});

describe("the adapter's activity wiring", () => {
  function fixture(runTurn: (callbacks: any) => Promise<unknown>) {
    const order: string[] = [];
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const postMessage = vi.fn(async () => {
      order.push("marker");
      return { id: 1 };
    });
    Object.assign(adapter, {
      turnControllers: new Map(),
      ownerId: "owner-1",
      missionLane: {
        beginTurn: vi.fn(() => 1),
        finalizeTurn: vi.fn(async () => {}),
      },
      missionControl: { applyBulletin: (_chatId: number, input: unknown) => input },
      stepsLane: {
        handlePlan: vi.fn(async () => {}),
        finalizeTurn: vi.fn(async () => {}),
      },
      toolProgress: { sendToolStart: vi.fn(async () => {}) },
      outbound: { sendAgentError: vi.fn(async () => {}) },
      api: { postMessage },
      tools: { handleRequest: vi.fn(async () => ({})) },
      host: {
        runTurn: vi.fn(async (_chatId: number, _input: unknown, cb: any) =>
          runTurn(cb),
        ),
      },
    });
    const reply = {
      sendTyping: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
      sendText: vi.fn(async () => {
        order.push("reply");
      }),
    };
    return { adapter, reply, postMessage, order };
  }

  const marker: ActivityMarker = {
    kind: "context_compacted",
    payload: {},
    title: "Context compacted",
    text: "Context compacted: older conversation was summarized.",
  };

  it("posts a marker as an event message, inside the turn and before the reply", async () => {
    const { adapter, reply, postMessage, order } = fixture(async (cb) => {
      await cb.onActivityMarker?.(marker);
      return { error: null, replyText: "All done", turnCompleted: true };
    });

    await adapter.executeAndReply(10, 20, "Work", reply);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![0]).toMatchObject({
      assistantId: 10,
      chatId: 20,
      messageType: "event",
      eventMeta: {
        source: "agent",
        payload: { kind: "context_compacted" },
      },
    });
    expect(order).toEqual(["marker", "reply"]);
  });

  it("never lets a refused marker break the turn", async () => {
    const { adapter, reply, postMessage } = fixture(async (cb) => {
      await cb.onActivityMarker?.(marker);
      return { error: null, replyText: "All done", turnCompleted: true };
    });
    postMessage.mockRejectedValue(new Error("500 from BGOS"));

    await expect(
      adapter.executeAndReply(10, 20, "Work", reply),
    ).resolves.toBeUndefined();
    expect(reply.sendText).toHaveBeenCalledWith("All done");
  });

  it("hands every tool row's new fields to the card, unchanged", async () => {
    const { adapter, reply } = fixture(async (cb) => {
      await cb.onTool?.(
        {
          icon: "👥",
          name: "spawnAgent",
          args: "2 workers",
          status: "running",
          kind: "subagent",
          detail: "1 running, 1 done",
        },
        "col1",
      );
      return { error: null, replyText: "All done", turnCompleted: true };
    });

    await adapter.executeAndReply(10, 20, "Work", reply);

    expect(adapter.toolProgress.sendToolStart).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      toolName: "spawnAgent",
      icon: "👥",
      args: "2 workers",
      itemId: "col1",
      status: "running",
      kind: "subagent",
      detail: "1 running, 1 done",
    });
  });

  it("wires the host's idle marker sink to the chat's own assistant", () => {
    const source = readFileSync("src/adapter.ts", "utf8");
    expect(source).toContain("onIdleActivityMarker: (chatId, marker) =>");
    expect(source).toContain("this.assistantForChat(chatId)");
  });
});

describe("the plugin never reads the owner's switch", () => {
  /** Every .ts file under src/, so a new one cannot slip past the guard. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && full.endsWith(".ts") ? [full] : [];
    });
  }

  it("reads showTechnicalDetails nowhere in src/", () => {
    // Program rule: the plugin always sends and the app decides what to draw.
    // Gating a row here would blind the backend's live working status, which
    // it derives from the rows arriving.
    const offenders = sourceFiles("src").filter((file) =>
      /showTechnicalDetails|show_technical_details/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
    expect(sourceFiles("src").length).toBeGreaterThan(40);
  });
});
