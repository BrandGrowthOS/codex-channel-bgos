import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexHost,
  appServerInput,
  type RunTurnResult,
} from "../src/codex-host.js";
import { verifyModel } from "../src/setup/verify-model.js";

class Server extends EventEmitter {
  onRequest: any;
  next = 0;
  start = vi.fn(async () => {});
  close = vi.fn(() => this.emit("closed", new Error("closed")));
  /** The one goal this fake holds, as the real server holds one per thread. */
  goal: any = null;
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/start")
      return { thread: { id: `thread-${++this.next}` } };
    if (method === "thread/resume") return { thread: { id: p.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${p.threadId}` } };
    if (method === "thread/fork")
      return { thread: { id: `fork-${++this.next}` } };
    if (method === "thread/goal/set") {
      this.goal = {
        threadId: p.threadId,
        objective: p.objective ?? this.goal?.objective ?? "",
        status: p.status ?? this.goal?.status ?? "active",
        tokenBudget: p.tokenBudget ?? this.goal?.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 7,
        createdAt: 1789932968,
        updatedAt: 1789932968,
        // A field a newer runtime adds, which this daemon must drop rather
        // than carry through untyped.
        goalId: "01a0c051-goal",
      };
      return { goal: this.goal };
    }
    if (method === "thread/goal/get") return { goal: this.goal };
    if (method === "thread/goal/clear") {
      const had = this.goal !== null;
      this.goal = null;
      return { cleared: had };
    }
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
describe("native Codex host contracts", () => {
  let home: string, server: Server, host: CodexHost;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-host-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      tools: [
        {
          type: "function",
          name: "reply",
          description: "reply",
          inputSchema: { type: "object" },
        },
      ],
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  it("preserves project instructions and literal backslashes", async () => {
    writeFileSync(join(home, "AGENTS.md"), "User instructions");
    host.applyAgentHints("HOAI instructions");
    const message = String.raw`C:\Users\Renée & Co\notes.md`;
    const task = host.runTurn(17, message);
    await vi.waitFor(() => expect(server.next).toBe(1));
    expect(server.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        cwd: home,
        developerInstructions: "HOAI instructions",
        dynamicTools: expect.arrayContaining([
          expect.objectContaining({ name: "reply" }),
        ]),
      }),
    );
    await vi.waitFor(() =>
      expect(server.request).toHaveBeenCalledWith(
        "turn/start",
        expect.objectContaining({ input: appServerInput(message) }),
      ),
    );
    server.finish("thread-1", message);
    expect((await task).replyText).toBe(message);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(
      "User instructions",
    );
  });
  it("serializes one chat while another can run and stops only the requested chat", async () => {
    const one = host.runTurn(1, "first"),
      two = host.runTurn(1, "second"),
      other = host.runTurn(2, "other");
    await vi.waitFor(() =>
      expect(
        server.request.mock.calls.filter((c) => c[0] === "turn/start"),
      ).toHaveLength(2),
    );
    await host.stopTurn(1);
    expect(server.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
    });
    server.finish("thread-1", "first");
    await one;
    await vi.waitFor(() =>
      expect(
        server.request.mock.calls.filter((c) => c[0] === "turn/start"),
      ).toHaveLength(3),
    );
    server.finish("thread-1", "second");
    server.finish("thread-2", "other");
    expect((await two).replyText).toBe("second");
    expect((await other).replyText).toBe("other");
  });
  it("an already cancelled turn never reaches the model", async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      host.runTurn(1, "cancelled", { signal: c.signal }),
    ).rejects.toThrow();
    expect(server.request).not.toHaveBeenCalled();
  });
  it("sends the final answer without duplicating preparatory commentary", async () => {
    const task = host.runTurn(1, "test");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      item: { id: "commentary", type: "agentMessage", text: "I will check." },
    });
    server.finish("thread-1", "Verified.");
    expect((await task).replyText).toBe("Verified.");
  });
  /**
   * Stage 7: the turn's own clock, from `turn/completed` and from nowhere
   * else. Both ends arrive on that one notification, in UNIX SECONDS, and
   * both are nullable.
   *
   * MUTATION PROOFS:
   *  - carrying `startedAt` through as milliseconds turns 2026 into 1970 and
   *    the converted case goes red
   *  - reading a null `completedAt` as a zero gives a 56 year turn and the
   *    "no clock" case goes red
   *  - filling the clock anywhere but from the completed turn makes the
   *    watchdog case carry one
   */
  it("carries the turn clock the runtime reported, converted from seconds", async () => {
    const task = host.runTurn(1, "work");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "turn/completed", {
      threadId: "thread-1",
      turn: {
        status: "completed",
        // The live shape from the gate capture: seconds, not milliseconds.
        startedAt: 1789932968,
        completedAt: 1789932983,
        durationMs: 15143,
      },
    });
    const result = await task;
    expect(result.turnStartedAtMs).toBe(1789932968000);
    expect(result.turnFinishedAtMs).toBe(1789932983000);
  });
  it("reports NO clock when the runtime left either end null", async () => {
    const task = host.runTurn(1, "work");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "turn/completed", {
      threadId: "thread-1",
      turn: { status: "completed", startedAt: 1789932968, completedAt: null },
    });
    const result = await task;
    // Absent, never a zero: a zero here is a turn that started in 1970.
    expect(result.turnStartedAtMs).toBeUndefined();
    expect(result.turnFinishedAtMs).toBeUndefined();
  });
  it("carries no clock from the watchdog, because no turn ever completed", async () => {
    const task = host.runDetached(1, "slow", {}, true, 1);
    const result = await task;
    expect(result.error).toMatch(/timed out/);
    expect(result.turnStartedAtMs).toBeUndefined();
    expect(result.turnFinishedAtMs).toBeUndefined();
  });
  it("upgrades a legacy thread with tools without deleting its history", async () => {
    host.close();
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({ "17": "legacy" }),
    );
    server = new Server();
    const base = server.request.getMockImplementation()!;
    server.request.mockImplementation(async (method, p) =>
      method === "thread/read"
        ? ({
            thread: {
              turns: [
                {
                  items: [
                    {
                      type: "userMessage",
                      content: [
                        {
                          type: "text",
                          text: String.raw`Remember C:\notes\task.md`,
                        },
                      ],
                    },
                    { type: "agentMessage", text: "Remembered" },
                  ],
                },
              ],
            },
          } as any)
        : base(method, p),
    );
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      tools: [
        {
          type: "function",
          name: "reply",
          description: "reply",
          inputSchema: { type: "object" },
        },
      ],
    });
    const result = host.runTurn(17, "continue");
    await vi.waitFor(() => expect(server.next).toBe(1));
    expect(server.request).not.toHaveBeenCalledWith(
      "thread/resume",
      expect.anything(),
    );
    expect(server.request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({
        developerInstructions: expect.stringContaining("legacy remains saved"),
      }),
    );
    expect(
      JSON.parse(readFileSync(join(home, "previous-threads.json"), "utf8"))[
        "17:legacy"
      ],
    ).toBe("legacy");
    server.finish("thread-1", "Continued");
    await result;
    host.close();
    const again = host.runTurn(17, "next");
    await vi.waitFor(() =>
      expect(server.request).toHaveBeenCalledWith(
        "thread/resume",
        expect.objectContaining({ threadId: "thread-1" }),
      ),
    );
    server.finish("thread-1", "Next");
    await again;
  });
  it("drains a final plan update before allowing mission finalization", async () => {
    let finish: () => void = () => {};
    const plan = new Promise<void>((r) => {
      finish = r;
    });
    let done = false;
    const result = host
      .runTurn(1, "plan", { onTodoList: () => plan })
      .then(() => {
        done = true;
      });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "turn/plan/updated", {
      threadId: "thread-1",
      plan: [{ step: "test", status: "completed" }],
    });
    server.finish("thread-1", "Done");
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await result;
    expect(done).toBe(true);
  });
  it("hands the raw three state plan to onPlan and drains it before the turn resolves", async () => {
    let release: () => void = () => {};
    const written = new Promise<void>((r) => {
      release = r;
    });
    const seen: unknown[] = [];
    let done = false;
    const result = host
      .runTurn(1, "plan", {
        onPlan: (signal) => {
          seen.push(signal);
          return written;
        },
      })
      .then(() => {
        done = true;
      });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "turn/plan/updated", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      plan: [
        { step: "Read the spec", status: "completed" },
        { step: "Write the lane", status: "in_progress" },
        { step: "Run the suite", status: "pending" },
      ],
    });
    server.finish("thread-1", "Done");
    // A macrotask tick drains every microtask, so `done` can only still be
    // false if the plan callback itself is holding the turn open.
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    release();
    await result;
    expect(seen).toEqual([
      {
        turnId: "turn-thread-1",
        plan: [
          { step: "Read the spec", status: "completed" },
          { step: "Write the lane", status: "in_progress" },
          { step: "Run the suite", status: "pending" },
        ],
      },
    ]);
    expect(done).toBe(true);
  });
  it("refuses approval requests with no active requesting turn", async () => {
    expect(
      await server.onRequest("item/commandExecution/requestApproval", {
        threadId: "missing",
      }),
    ).toEqual({ decision: "decline" });
  });
  it("rejects a setup whose selected model cannot actually run", async () => {
    server.request.mockImplementation(async (method, p) => {
      if (method === "thread/start") return { thread: { id: "probe" } } as any;
      if (method === "turn/start")
        queueMicrotask(() =>
          server.emit("notification", "turn/completed", {
            threadId: "probe",
            turn: {
              status: "failed",
              error: {
                message: "The model requires a newer version of Codex.",
              },
            },
          }),
        );
      return {};
    });
    await expect(verifyModel(server as any)).rejects.toThrow(
      /runtime needs an update/,
    );
    expect(server.listenerCount("notification")).toBe(1); // only the host listener remains
  });
});

/**
 * The goal half of the host (mission program stage 6).
 *
 * Every case here turns on one fact the feasibility gate proved live: while a
 * goal is active the app server runs turns nobody asked for, so the goal
 * notifications and the first `turn/started` of a continuation arrive when
 * `this.active` holds nothing for the thread. The shipped turn guard drops
 * all of it, which is what these tests stand against.
 */
describe("the Codex goal lane's half of the host", () => {
  let home: string, server: Server, host: CodexHost;
  let goalUpdates: Array<{ chatId: number; goal: unknown }>;
  let adopted: number[];
  let delivered: RunTurnResult[];
  let cards: Array<{ name: string; status: string }>;
  let holdGoal: boolean;
  const liveGoal = (threadId: string, patch: Record<string, unknown> = {}) => ({
    threadId,
    objective: "a file named done.txt exists in this folder containing the word done",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1789932968,
    updatedAt: 1789932968,
    ...patch,
  });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-goal-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    goalUpdates = [];
    adopted = [];
    delivered = [];
    cards = [];
    holdGoal = false;
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      onGoalUpdate: (chatId, goal) => {
        goalUpdates.push({ chatId, goal });
        // A lane that is slow, or wedged, must never hold a turn open.
        return holdGoal ? new Promise<void>(() => {}) : undefined;
      },
      onAdoptedTurn: (chatId) => {
        adopted.push(chatId);
        return {
          callbacks: {
            onTool: (card) => {
              cards.push({ name: card.name, status: card.status });
            },
          },
          deliver: (result) => {
            delivered.push(result);
          },
        };
      },
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  /** One finished turn, which is what binds this chat to a durable thread. */
  async function bindThread(chatId: number): Promise<string> {
    const task = host.runTurn(chatId, "hello");
    await vi.waitFor(() => expect(server.next).toBeGreaterThan(0));
    const threadId = `thread-${server.next}`;
    server.finish(threadId, "hi");
    await task;
    return threadId;
  }

  it("hands a goal update to the lane when no turn of ours is open", async () => {
    const threadId = await bindThread(5);
    server.emit("notification", "thread/goal/updated", {
      threadId,
      turnId: null,
      goal: liveGoal(threadId),
    });
    await vi.waitFor(() => expect(goalUpdates).toHaveLength(1));
    expect(goalUpdates[0]).toEqual({ chatId: 5, goal: liveGoal(threadId) });
    server.emit("notification", "thread/goal/cleared", { threadId });
    await vi.waitFor(() => expect(goalUpdates).toHaveLength(2));
    expect(goalUpdates[1]).toEqual({ chatId: 5, goal: null });
  });

  it("never lets the goal lane hold a turn open, because a goal outlives it", async () => {
    const threadId = await bindThread(6);
    holdGoal = true;
    const task = host.runTurn(6, "work");
    await vi.waitFor(() =>
      expect(
        server.request.mock.calls.filter((c) => c[0] === "turn/start"),
      ).toHaveLength(2),
    );
    server.emit("notification", "thread/goal/updated", {
      threadId,
      turnId: "01a0c055-ba0f-7e40-b4fb-a9a7d849539c",
      goal: liveGoal(threadId, { timeUsedSeconds: 1 }),
    });
    await vi.waitFor(() => expect(goalUpdates).toHaveLength(1));
    server.finish(threadId, "finished");
    expect((await task).replyText).toBe("finished");
  });

  it("sets and pauses the goal on the chat's own durable thread", async () => {
    const threadId = await bindThread(7);
    const goal = await host.setGoal(7, "done.txt exists and says done");
    expect(server.request).toHaveBeenLastCalledWith("thread/goal/set", {
      threadId,
      objective: "done.txt exists and says done",
    });
    expect(goal?.objective).toBe("done.txt exists and says done");
    expect(goal?.status).toBe("active");
    // A pause carries the status and nothing else: the objective stays where
    // it is, and a key this request does not take is a serde error at the
    // app server rather than a field it quietly ignores.
    await host.setGoal(7, null, { status: "paused" });
    expect(server.request).toHaveBeenLastCalledWith("thread/goal/set", {
      threadId,
      status: "paused",
    });
    await host.setGoal(7, "done.txt exists and says done", {
      tokenBudget: 120000,
    });
    expect(server.request).toHaveBeenLastCalledWith("thread/goal/set", {
      threadId,
      objective: "done.txt exists and says done",
      tokenBudget: 120000,
    });
  });

  it("reads the goal back in the lane's own eight field shape", async () => {
    const threadId = await bindThread(8);
    expect(await host.getGoal(8)).toBeNull();
    await host.setGoal(8, "ship the lane");
    expect(await host.getGoal(8)).toEqual({
      threadId,
      objective: "ship the lane",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 7,
      createdAt: 1789932968,
      updatedAt: 1789932968,
    });
    expect(server.request).toHaveBeenCalledWith("thread/goal/get", {
      threadId,
    });
  });

  it("clears the goal and says whether there was one to clear", async () => {
    const threadId = await bindThread(9);
    await host.setGoal(9, "something to finish");
    expect(await host.clearGoal(9)).toBe(true);
    expect(server.request).toHaveBeenLastCalledWith("thread/goal/clear", {
      threadId,
    });
    expect(await host.clearGoal(9)).toBe(false);
  });

  it("never puts a goal on an ephemeral consult thread", async () => {
    const threadId = await bindThread(10);
    await host.setGoal(10, "persisted threads only");
    await host.getGoal(10);
    await host.clearGoal(10);
    const goalCalls = server.request.mock.calls.filter((c) =>
      String(c[0]).startsWith("thread/goal/"),
    );
    expect(goalCalls).toHaveLength(3);
    expect(goalCalls.every((c) => c[1].threadId === threadId)).toBe(true);
    expect(server.request.mock.calls.some((c) => c[1]?.ephemeral === true)).toBe(
      false,
    );
  });

  it("turns a refused goal into a sentence the owner can act on", async () => {
    await bindThread(11);
    const base = server.request.getMockImplementation()!;
    server.request.mockImplementation(async (method, p) => {
      if (method === "thread/goal/set")
        throw new Error(
          "401 Unauthorized: Missing bearer or basic authentication in header",
        );
      return base(method, p);
    });
    await expect(host.setGoal(11, "anything")).rejects.toThrow(
      /sign in again/,
    );
  });

  it("adopts a continuation turn the app server started by itself", async () => {
    const threadId = await bindThread(12);
    server.emit("notification", "turn/started", {
      threadId,
      turn: { id: "01a0c051-997e-7b92-9f2e-472d1c429061", status: "inProgress" },
    });
    expect(adopted).toEqual([12]);
    server.emit("notification", "item/started", {
      threadId,
      item: { id: "c1", type: "commandExecution", command: "yarn test" },
    });
    server.emit("notification", "item/completed", {
      threadId,
      item: { id: "m1", type: "agentMessage", text: "done.txt now says done." },
    });
    server.emit("notification", "turn/completed", {
      threadId,
      turn: { status: "completed" },
    });
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(cards).toEqual([{ name: "shell", status: "running" }]);
    expect(delivered[0].replyText).toBe("done.txt now says done.");
    expect(delivered[0].turnCompleted).toBe(true);
    expect(delivered[0].threadId).toBe(threadId);
  });

  it("forks an invisible consult without asking for a deferred goal continuation", async () => {
    const threadId = await bindThread(13);
    const task = host.runDetached(13, "read only consult");
    await vi.waitFor(() =>
      expect(
        server.request.mock.calls.some(
          (c) => c[0] === "turn/start" && String(c[1].threadId).startsWith("fork-"),
        ),
      ).toBe(true),
    );
    const fork = server.request.mock.calls.find((c) => c[0] === "thread/fork")![1];
    expect(fork.threadId).toBe(threadId);
    expect(fork.ephemeral).toBe(true);
    expect(fork).not.toHaveProperty("deferGoalContinuation");
    server.finish(
      String(
        server.request.mock.calls.find(
          (c) => c[0] === "turn/start" && String(c[1].threadId).startsWith("fork-"),
        )![1].threadId,
      ),
      "consulted",
    );
    expect((await task).replyText).toBe("consulted");
  });

  it("leaves the owner's own fork exactly as it was", async () => {
    const threadId = await bindThread(14);
    const forked = await host.forkThread(14);
    expect(forked).toMatch(/^fork-/);
    expect(server.request).toHaveBeenLastCalledWith("thread/fork", {
      threadId,
      cwd: home,
    });
  });
});
