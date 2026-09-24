import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexHost,
  OWNER_BLOCKING_TOOLS,
  ROW_CHANGES_MAX,
  appServerInput,
  rememberChanges,
  waitsForOwner,
  type RunTurnResult,
} from "../src/codex-host.js";
import { verifyModel } from "../src/setup/verify-model.js";
import {
  GOLD_PNG,
  imageItem,
  itemCompleted,
  itemStarted,
  probe401Turn,
} from "./fixtures/image-generation.js";

class Server extends EventEmitter {
  onRequest: any;
  next = 0;
  start = vi.fn(async () => {});
  close = vi.fn(() => this.emit("closed", new Error("closed")));
  /** The one goal this fake holds, as the real server holds one per thread. */
  goal: any = null;
  /**
   * Thread metadata per thread id, which this fake did not answer before
   * stage 8. Without it a name lookup reads an undefined thread in every
   * host test here, so the fake is extended BEFORE the host is: a name case
   * cannot go green against a fake that answers nothing, and a settle case
   * cannot tell "the runtime says it stopped" from "the fake said nothing".
   */
  threads: Record<string, any> = {};
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/start")
      return { thread: { id: `thread-${++this.next}` } };
    if (method === "thread/read")
      return { thread: this.threads[p.threadId] ?? { id: p.threadId } };
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
  /**
   * THE WATCHDOG IS A BUDGET FOR SILENCE, NOT FOR THE OWNER'S THINKING.
   *
   * An approval may now hold a turn for up to APPROVAL_HOLD_SECONDS (1800 s,
   * interactions.ts), and this watchdog is armed for 30 minutes from TURN
   * START, which is always earlier than the card. At the ceiling it therefore
   * always won: the turn was interrupted, the request answered decline on the
   * owner's behalf, and the longest wait the card advertises could never be
   * served. So it pauses while a request is parked and resumes with what is
   * left.
   *
   * MUTATION PROOFS, run by hand against this tree:
   *  - calling `turn.callbacks.onRequest` in the host's `onRequest` without the
   *    park/resume wrap turns the parked case red: the turn times out while the
   *    owner is still holding it.
   *  - making `resumeWatchdog` a no-op never re-arms the budget, so the parked
   *    case fails on its own timeout instead of seeing the turn end.
   *  - parking unconditionally, i.e. never resuming, turns the control case red
   *    the same way: an ordinary turn would never time out again.
   *  - parking on EVERY request instead of the owner-facing ones turns the tool
   *    call case red: a call that never returns would wedge the turn forever.
   *  - dropping ANY ONE entry from the park list (renaming it, typo'ing it,
   *    deleting it) turns that entry's row of the table below red. The list was
   *    trusted rather than enforced until then: only the approval method was
   *    exercised, so the other three could be broken with the suite green.
   *  - the `ask_user_input` row is the one that was WRONG rather than untested.
   *    It is a HOAI tool, so it arrives as an ordinary `item/tool/call` and the
   *    method-only gate let the watchdog run while the blocking carousel sat in
   *    front of the owner for up to 600 s.
   */
  /** Holds one request open from the moment the turn is registered, which is
   *  the earliest a card could be raised, and hands back the release. */
  function parkRequest(method: string, extra: Record<string, unknown> = {}) {
    let release: (value: unknown) => void = () => {};
    const held = new Promise<unknown>((resolve) => (release = resolve));
    const base = server.request.getMockImplementation()!;
    const parked: { promise: Promise<unknown> | null } = { promise: null };
    server.request.mockImplementation(async (name: string, p: any) => {
      if (name === "turn/start" && !parked.promise)
        parked.promise = server.onRequest(method, {
          threadId: p.threadId,
          ...extra,
        });
      return base(name, p);
    });
    const task = host.runDetached(
      1,
      "work",
      { onRequest: () => held },
      false,
      50,
    );
    return { task, parked, release };
  }

  it.each([
    ["item/commandExecution/requestApproval", {}],
    ["item/fileChange/requestApproval", {}],
    ["item/permissions/requestApproval", {}],
    ["item/tool/requestUserInput", {}],
    ["mcpServer/elicitation/request", {}],
    ["item/tool/call", { tool: "ask_user_input" }],
  ] as Array<[string, Record<string, unknown>]>)(
    "does not spend the turn's watchdog while the owner holds %s %j",
    async (method, extra) => {
      const { task, parked, release } = parkRequest(method, extra);
      let done = false;
      void task.then(() => (done = true));
      await vi.waitFor(() => expect(parked.promise).not.toBeNull());
      // Five watchdogs' worth of wall clock with the owner still holding.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(done).toBe(false);
      release({ decision: "decline" });
      await parked.promise;
      // Paused, not cancelled: the remaining budget runs again once the owner is
      // no longer the thing being waited on.
      expect((await task).error).toMatch(/timed out/);
    },
  );
  it.each([[{}], [{ tool: "send_message" }]])(
    "still counts a tool call %j, because nobody is holding that one",
    async (extra) => {
      // The same never-answered request, with the one method that is the model
      // talking to itself. A call that hangs is the silence this clock is for.
      const { task, parked, release } = parkRequest("item/tool/call", extra);
      await vi.waitFor(() => expect(parked.promise).not.toBeNull());
      expect((await task).error).toMatch(/timed out/);
      release({});
      await parked.promise;
    },
  );
  it("still spends the watchdog on a turn with nothing parked", async () => {
    const result = await host.runDetached(1, "work", {}, false, 50);
    expect(result.error).toMatch(/timed out/);
  });
  /**
   * The park list names ONE blocking HOAI tool, and the runtime hands the gate
   * a tool name and nothing else, so the pairing is checked against the source
   * that actually blocks: every `case` in `HoaiTools.call` that delegates to
   * `this.interactions` must be in OWNER_BLOCKING_TOOLS. Add a second blocking
   * tool there and forget the park list, and this goes red rather than the
   * owner's carousel silently spending the watchdog again.
   */
  /**
   * THE PLAN THE MODEL PROPOSED.
   *
   * A live probe on 2026-09-23 against the vendored app server at 0.154.0
   * (docs/learnings/codex-plan-mode-wire.md) showed the runtime lifting the
   * model's `<proposed_plan>` block out of the message into its own item:
   * `item/started` with an empty text, `item/plan/delta` while it streams, then
   * `item/completed` with the whole markdown. `entryFromItem` returns null for
   * a plan item, so before this branch existed the plan reached nobody and the
   * owner got only the sentence that came before it.
   */
  it("hands over the plan a plan item carries, once, when it is finished", async () => {
    const seen: Array<{ text: string; itemId: string; turnId: string | null }> = [];
    const task = host.runTurn(1, "plan it", {
      onPlanProposal: (signal) => {
        seen.push(signal);
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    const plan = "## Add retry\n\n1. Add the helper";
    // The empty opener is not a plan.
    server.emit("notification", "item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "turn-1-plan", type: "plan", text: "" },
    });
    // Neither is a partial.
    server.emit("notification", "item/plan/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "turn-1-plan",
      delta: "## Add re",
    });
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "turn-1-plan", type: "plan", text: plan },
    });
    server.finish("thread-1", "I explored it. Here is the plan.");
    const result = await task;
    expect(seen).toEqual([
      { text: plan, itemId: "turn-1-plan", turnId: "turn-1" },
    ]);
    // And the turn's own reply is what the runtime left in the message, which
    // is exactly why the card has to carry the plan.
    expect(result.replyText).toBe("I explored it. Here is the plan.");
    expect(result.sawPlanProposal).toBe(true);
  });

  it("ignores a plan item's OPENER even when the runtime fills its text", async () => {
    // The `!started` half of the guard, which nothing held: the existing case
    // opens with an EMPTY text, so `item.text.trim()` carried it alone. A
    // runtime that ever put the whole plan on `item/started` as well would
    // post two cards for one plan, the second superseding the first, for no
    // reason the owner could see.
    const seen: string[] = [];
    const task = host.runTurn(1, "plan it", {
      onPlanProposal: (signal) => {
        seen.push(signal.text);
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "turn-1-plan", type: "plan", text: "## Add retry\n\n1. Add the helper" },
    });
    server.finish("thread-1", "Here is the plan.");
    const result = await task;
    expect(seen).toEqual([]);
    expect(result.sawPlanProposal).toBeUndefined();
  });

  it("says nothing about a plan on a turn that proposed none", async () => {
    const seen: string[] = [];
    const task = host.runTurn(1, "just answer", {
      onPlanProposal: (signal) => {
        seen.push(signal.text);
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.finish("thread-1", "No plan needed.");
    const result = await task;
    expect(seen).toEqual([]);
    expect(result.sawPlanProposal).toBeUndefined();
  });

  it("never draws a plan item as an activity row", async () => {
    const rows: string[] = [];
    const task = host.runTurn(1, "plan it", {
      onTool: (card) => {
        rows.push(card.name);
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "turn-1-plan", type: "plan", text: "## A plan\n\n1. Do it" },
    });
    server.finish("thread-1", "done");
    await task;
    expect(rows).toEqual([]);
  });

  /**
   * `propose_plan` RETURNS AT ONCE, so it must stay off the park list.
   *
   * The plan wait has no end by design: the owner's tap arrives as a click and
   * starts the next turn. A `propose_plan` on this list would park the turn's
   * 30 minute budget on an answer that may come tomorrow, and the comment above
   * `execute` is explicit that the budget is for the model's silence and
   * nothing else.
   */
  it("names the chats it has stored in plan mode, and only those", () => {
    // The mode is per chat and persisted, so a restart has to be able to
    // report what it came back holding. The STORE is the truth, not the
    // running threads: a chat with no thread yet still has a mode.
    writeFileSync(
      join(home, "session-settings.json"),
      JSON.stringify({
        "20": { mode: "plan", model: "one" },
        "21": { mode: "default", model: "one" },
        "22": { model: "one" },
        "23": { mode: "plan" },
        bogus: { mode: "plan" },
      }),
    );
    const fresh = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: new Server() as any,
    });
    try {
      expect(fresh.planModeChats().sort((a, b) => a - b)).toEqual([20, 23]);
    } finally {
      fresh.close();
    }
  });

  it("keeps propose_plan off the park list, because nothing waits on it", () => {
    expect(OWNER_BLOCKING_TOOLS.has("propose_plan")).toBe(false);
    expect(waitsForOwner("item/tool/call", { tool: "propose_plan" })).toBe(false);
  });

  it("keeps OWNER_BLOCKING_TOOLS equal to the tools that block on a person", () => {
    const source = readFileSync(
      new URL("../src/hoai-tools.ts", import.meta.url),
      "utf8",
    );
    const body = source.slice(source.indexOf("  async call("));
    expect(body.length).toBeGreaterThan(0);
    const blocking = new Set<string>();
    let current: string | null = null;
    for (const line of body.split("\n")) {
      const label = /^\s*case "([a-z0-9_]+)":/.exec(line);
      if (label) current = label[1];
      if (line.includes("this.interactions.") && current) blocking.add(current);
    }
    expect([...blocking].sort()).toEqual([...OWNER_BLOCKING_TOOLS].sort());
  });
  it.each([
    ["item/commandExecution/requestApproval", {}, true],
    ["item/fileChange/requestApproval", {}, true],
    ["item/permissions/requestApproval", {}, true],
    ["item/tool/requestUserInput", {}, true],
    ["mcpServer/elicitation/request", {}, true],
    ["item/tool/call", { tool: "ask_user_input" }, true],
    ["item/tool/call", { tool: "send_message" }, false],
    ["item/tool/call", {}, false],
    ["item/tool/call", { tool: 7 }, false],
    ["turn/started", {}, false],
  ] as Array<[string, Record<string, unknown>, boolean]>)(
    "waitsForOwner(%s, %j) is %s",
    (method, params, expected) => {
      expect(waitsForOwner(method, params)).toBe(expected);
    },
  );
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

  /**
   * The file change join: the item that says WHICH files, met with the approval
   * request that asks about them.
   *
   * A live probe on app server 0.154.0 (four runs) settles the ordering this
   * rests on: `item/started` carries `changes[{path, kind, diff}]` complete and
   * arrives about ten milliseconds BEFORE `item/fileChange/requestApproval`, and
   * `params.itemId` equals `item.id` exactly. It also settles what cannot be
   * leaned on: `item/fileChange/patchUpdated` fired ZERO times, so the branch
   * that writes the cache from it is a courtesy and never the source.
   *
   * Ten milliseconds is a measurement, not a guarantee: the two arrive on the
   * same pipe from the same process, one a notification and one a request, and
   * nothing in the protocol orders them. So the join tolerates a miss and never
   * holds the RPC.
   *
   * THE HOST enriches the params rather than handing interactions a lookup,
   * because that is one edit here against three at the adapter's `onRequest`
   * call sites, and it covers the adopted goal turn for free.
   *
   * MUTATION PROOFS, run by hand against this tree:
   *  - forwarding `params` instead of the enriched object turns the first case
   *    red.
   *  - keeping the entry past `item/completed` turns the second case red.
   *  - overwriting a `changes` the runtime itself sent turns the third case red.
   *  - dropping the ROW_CHANGES_MAX eviction turns the bound case red.
   */
  describe("a file change approval is joined to the item that announced it", () => {
    const CHANGES = [
      {
        path: "/work/project/calc.py",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1 @@\n-old\n+new\n",
      },
    ];
    function startEdit(id = "call_3") {
      server.emit("notification", "item/started", {
        threadId: "thread-1",
        startedAtMs: 1790152546803,
        item: {
          id,
          type: "fileChange",
          status: "inProgress",
          cwd: "/work/project",
          changes: CHANGES,
        },
      });
    }

    it("hands the approval the change list and the thread's working directory", async () => {
      const seen: Array<{ method: string; params: any }> = [];
      const task = host.runTurn(1, "edit", {
        onRequest: async (method, params) => {
          seen.push({ method, params });
          return { decision: "decline" };
        },
      });
      await vi.waitFor(() => expect(server.next).toBe(1));
      startEdit();
      expect(
        await server.onRequest("item/fileChange/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-thread-1",
          itemId: "call_3",
          startedAtMs: 1790152546803,
          reason: null,
          grantRoot: null,
        }),
      ).toEqual({ decision: "decline" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.params.changes).toEqual(CHANGES);
      expect(seen[0]!.params.cwd).toBe("/work/project");
      // Nothing the runtime sent is lost in the enrichment.
      expect(seen[0]!.params.itemId).toBe("call_3");
      expect(seen[0]!.params.reason).toBeNull();
      server.finish("thread-1", "done");
      await task;
    });

    it("forgets the change list the moment the item settles, and never blocks on a miss", async () => {
      const seen: any[] = [];
      const task = host.runTurn(1, "edit", {
        onRequest: async (_method, params) => {
          seen.push(params);
          return { decision: "decline" };
        },
      });
      await vi.waitFor(() => expect(server.next).toBe(1));
      startEdit();
      server.emit("notification", "item/completed", {
        threadId: "thread-1",
        item: {
          id: "call_3",
          type: "fileChange",
          status: "completed",
          changes: CHANGES,
        },
      });
      // By now the owner has answered or nobody ever asked them, so the body is
      // dropped rather than kept for the rest of the turn.
      await server.onRequest("item/fileChange/requestApproval", {
        threadId: "thread-1",
        itemId: "call_3",
      });
      // And an item this turn never saw is simply a miss: the params go through
      // untouched and the card posts as it did before this stage.
      await server.onRequest("item/fileChange/requestApproval", {
        threadId: "thread-1",
        itemId: "never-seen",
      });
      expect(seen).toHaveLength(2);
      for (const params of seen) {
        expect(params).not.toHaveProperty("changes");
        expect(JSON.stringify(params)).not.toContain("+new");
      }
      server.finish("thread-1", "done");
      await task;
    });

    it("never overwrites a change list the runtime itself sent", async () => {
      const seen: any[] = [];
      const task = host.runTurn(1, "edit", {
        onRequest: async (_method, params) => {
          seen.push(params);
          return { decision: "decline" };
        },
      });
      await vi.waitFor(() => expect(server.next).toBe(1));
      startEdit();
      const own = [{ path: "other.ts", kind: "add", diff: "+x\n" }];
      await server.onRequest("item/fileChange/requestApproval", {
        threadId: "thread-1",
        itemId: "call_3",
        changes: own,
        cwd: "/elsewhere",
      });
      expect(seen[0]!.changes).toEqual(own);
      expect(seen[0]!.cwd).toBe("/elsewhere");
      server.finish("thread-1", "done");
      await task;
    });

    it("holds at most ROW_CHANGES_MAX change lists, oldest evicted", () => {
      // The one thing a cache of patch BODIES must not do is grow. It is also
      // never written to disk: a restart takes the child app server, the turn
      // and the RPC together, so there is nothing a store could replay.
      const turn = { rowChanges: new Map<string, unknown[]>() };
      for (let i = 0; i < ROW_CHANGES_MAX + 4; i++)
        rememberChanges(turn, `call_${i}`, [{ path: `f${i}`, diff: "+x" }]);
      expect(turn.rowChanges.size).toBe(ROW_CHANGES_MAX);
      expect(turn.rowChanges.has("call_0")).toBe(false);
      expect(turn.rowChanges.has(`call_${ROW_CHANGES_MAX + 3}`)).toBe(true);
      // Nothing to remember is not an entry.
      rememberChanges(turn, "call_empty", []);
      rememberChanges(turn, "", CHANGES);
      expect(turn.rowChanges.has("call_empty")).toBe(false);
      expect(turn.rowChanges.has("")).toBe(false);
    });
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
  /** A row write left in flight, which is what every row write really is. */
  let toolHold: Promise<void> | null;
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
    toolHold = null;
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
              // Every row is an HTTP POST or PATCH to BGOS, so a write still
              // in flight when the turn ends is the ordinary case.
              return toolHold ?? undefined;
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

  /**
   * The thread is given up at `turn/completed`, before anything is awaited.
   *
   * The turn's end waits for this turn's queued row writes and then for one
   * thread read per live helper, and the runtime starts its next
   * continuation turn inside that window: goal turns are all continuation
   * turns and the runtime drives them back to back. A thread this host still
   * holds cannot be adopted, so that turn's rows, markers and reply would
   * reach nobody, and its messages would land on the turn that already ended
   * and be delivered as the owner's answer.
   *
   * MUTATION: settle first and release the thread inside the `.then` and
   * both halves go red, the adoption and the reply text.
   */
  it("adopts a continuation that starts while the finished turn is still settling", async () => {
    const threadId = await bindThread(15);
    let release!: () => void;
    toolHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.emit("notification", "turn/started", {
      threadId,
      turn: { id: "turn-first", status: "inProgress" },
    });
    server.emit("notification", "item/started", {
      threadId,
      item: { id: "c1", type: "commandExecution", command: "yarn test" },
    });
    server.emit("notification", "item/completed", {
      threadId,
      item: { id: "m1", type: "agentMessage", text: "the first turn's answer" },
    });
    server.emit("notification", "turn/completed", {
      threadId,
      turn: { status: "completed" },
    });
    // A macrotask drains every microtask: the turn is still open only
    // because its row write has not landed.
    await new Promise((r) => setTimeout(r, 0));
    server.emit("notification", "turn/started", {
      threadId,
      turn: { id: "turn-continuation", status: "inProgress" },
    });
    expect(adopted).toEqual([15, 15]);
    server.emit("notification", "item/completed", {
      threadId,
      item: { id: "m2", type: "agentMessage", text: "the continuation's text" },
    });

    release();
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    // The answer of the turn that ended, and not the text of the turn that
    // started after it.
    expect(delivered[0].replyText).toBe("the first turn's answer");

    // And the continuation still holds the thread: the finished turn gives
    // the thread up, it does not take away the one that replaced it.
    server.emit("notification", "turn/completed", {
      threadId,
      turn: { status: "completed" },
    });
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(delivered[1].replyText).toBe("the continuation's text");
  });

  /**
   * The same window, with the OWNER's own turn as the one settling, which is
   * the shape a goal chat is in most of the time: the owner asks something,
   * the runtime answers and carries straight on with the goal.
   *
   * MUTATION: delete the thread's entry unconditionally when a turn finishes
   * and this goes red, because the owner's turn then takes away the
   * continuation that replaced it and nothing that turn says is ever
   * delivered.
   */
  it("keeps the continuation that replaced the owner's own settling turn", async () => {
    const threadId = await bindThread(16);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = host.runTurn(16, "and another thing", {
      onTool: () => held,
    });
    await vi.waitFor(() =>
      expect(
        server.request.mock.calls.filter((c) => c[0] === "turn/start").length,
      ).toBe(2),
    );
    server.emit("notification", "item/started", {
      threadId,
      item: { id: "c2", type: "commandExecution", command: "yarn test" },
    });
    server.emit("notification", "item/completed", {
      threadId,
      item: { id: "m3", type: "agentMessage", text: "the owner's answer" },
    });
    server.emit("notification", "turn/completed", {
      threadId,
      turn: { status: "completed" },
    });
    await new Promise((r) => setTimeout(r, 0));
    server.emit("notification", "turn/started", {
      threadId,
      turn: { id: "turn-continuation", status: "inProgress" },
    });
    expect(adopted).toEqual([16]);

    release();
    expect((await owner).replyText).toBe("the owner's answer");
    server.emit("notification", "item/completed", {
      threadId,
      item: { id: "m4", type: "agentMessage", text: "the continuation's text" },
    });
    server.emit("notification", "turn/completed", {
      threadId,
      turn: { status: "completed" },
    });
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].replyText).toBe("the continuation's text");
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
    // No goal flag and no `ephemeral`: the owner's fork is theirs to keep.
    // `excludeTurns` (stage 4, C-21) only keeps the fork's REPLY small: the
    // runtime still copies every turn into the new thread, it just does not
    // send them all back in one line (see the 0.154.0 ThreadForkParams).
    expect(server.request).toHaveBeenLastCalledWith("thread/fork", {
      threadId,
      cwd: home,
      excludeTurns: true,
    });
  });
});

/**
 * Stage 8: the host wiring behind a child agent's row.
 *
 * The protocol carries no name for a child anywhere on the parent's stream;
 * the only place one exists is the CHILD's own thread, as the nickname or
 * the role the runtime gave it. This host reads that metadata once per child
 * and never resumes the thread, because a resume attaches a subscription to
 * a thread this daemon has no chat to attribute items to.
 *
 * MUTATION PROOFS (each performed, each restored):
 *  - leave the `Server` fake's thread metadata branch out and every name
 *    case below falls back to the literal and goes red, which is why the
 *    fake is extended before the host is
 *  - read the role before the nickname and the preference case goes red
 *  - drop the per process name cache and the "once per thread" case goes red
 *  - ignore a terminal metadata read at the turn's end and the settled case
 *    goes red; settle a child the read left active and the still working
 *    case goes red
 */
describe("a child agent's name and its last look at the turn's end", () => {
  let home: string, server: Server, host: CodexHost;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-child-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  /** One turn that spawns `children`, then ends. Every row it drew. */
  async function runWithChildren(
    children: Record<string, { status: string; message?: string }>,
  ): Promise<Array<{ card: any; itemId: string }>> {
    const cards: Array<{ card: any; itemId: string }> = [];
    const task = host.runTurn(17, "delegate", {
      onTool: (card, itemId) => {
        cards.push({ card, itemId });
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/started", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      startedAtMs: 1789932968000,
      item: {
        id: "col1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        agentsStates: children,
      },
    });
    server.emit("notification", "turn/completed", {
      threadId: "thread-1",
      turn: {
        status: "completed",
        startedAt: 1789932968,
        completedAt: 1789932983,
      },
    });
    await task;
    return cards;
  }

  it("names a child by its nickname, then its role, then the literal", async () => {
    server.threads["t-nick"] = {
      agentNickname: "quiet-otter",
      agentRole: "reviewer",
      status: { type: "active", activeFlags: [] },
    };
    server.threads["t-role"] = {
      agentNickname: null,
      agentRole: "reviewer",
      status: { type: "active", activeFlags: [] },
    };
    // t-none is absent from the fake's map: the runtime named it nothing.
    const cards = await runWithChildren({
      "t-nick": { status: "running" },
      "t-role": { status: "running" },
      "t-none": { status: "running" },
    });

    const named = new Map(cards.map((c) => [c.itemId, c.card.name]));
    expect(named.get("t-nick")).toBe("quiet-otter");
    expect(named.get("t-role")).toBe("reviewer");
    expect(named.get("t-none")).toBe("helper");
  });

  it("reads a child's thread once, however many items mention it", async () => {
    server.threads["t9"] = {
      agentNickname: "quiet-otter",
      status: { type: "active", activeFlags: [] },
    };
    const task = host.runTurn(17, "delegate", {
      onTool: () => {},
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    for (const id of ["col1", "col2", "col3"]) {
      server.emit("notification", "item/started", {
        threadId: "thread-1",
        turnId: "turn-thread-1",
        startedAtMs: 1789932968000,
        item: {
          id,
          type: "collabAgentToolCall",
          tool: "wait",
          status: "inProgress",
          agentsStates: { t9: { status: "completed", message: "Done." } },
        },
      });
    }
    server.emit("notification", "turn/completed", {
      threadId: "thread-1",
      turn: { status: "completed" },
    });
    await task;

    const reads = server.request.mock.calls.filter(
      (c) => c[0] === "thread/read" && c[1]?.threadId === "t9",
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]![1]).toMatchObject({ includeTurns: false });
  });

  it("never resumes a child's thread, only reads it", async () => {
    server.threads["t9"] = { agentRole: "reviewer", status: { type: "idle" } };
    await runWithChildren({ t9: { status: "running", message: "Working" } });

    expect(
      server.request.mock.calls.filter((c) => c[0] === "thread/resume"),
    ).toEqual([]);
  });

  /**
   * The review item the plan names, as close to green as it gets: a fake
   * answers a read and a resume the same way, so the file itself is read.
   *
   * MUTATION PROOF: point `readChildThread` at `thread/resume` and both the
   * block case and the count case go red.
   */
  it("reads a child thread and resumes only the owner's own", () => {
    const source = readFileSync("src/codex-host.ts", "utf8");
    const at = source.indexOf("private readChildThread");
    expect(at).toBeGreaterThan(0);
    const block = source.slice(at, source.indexOf("\n  }", at));
    expect(block).toContain('"thread/read"');
    expect(block).not.toContain("thread/resume");
    // The two resumes this daemon has are the owner's own /resume and the
    // tool version upgrade, each on a thread from this process's chat map.
    // A third is a new call site, and a child's thread is the one thread
    // this daemon must never subscribe to.
    expect(source.match(/"thread\/resume"/g) ?? []).toHaveLength(2);
  });

  it("settles a helper the turn ended on when its own thread says it stopped", async () => {
    server.threads["t9"] = {
      agentNickname: "quiet-otter",
      status: { type: "idle" },
    };
    const cards = await runWithChildren({
      t9: { status: "running", message: "Checked the migration." },
    });

    const last = cards.filter((c) => c.itemId === "t9").at(-1)!;
    expect(last.card).toMatchObject({
      name: "quiet-otter",
      status: "done",
      result: "Checked the migration.",
    });
    // The receipt difference, never a wall clock: 1789932983 - 1789932968.
    expect(last.card.durationMs).toBe(15000);
    // A settled row says what the child ended with, not what it was doing.
    expect(last.card.detail).toBeUndefined();
  });

  /**
   * The "Work continues" line is computed AFTER the turn's last read.
   *
   * Computed before it, a turn whose only live helper was settled by that
   * read still posted "1 subagent is still working" moments before the card
   * closed, which is a line about a helper that had already finished.
   *
   * MUTATION: compute the marker before the settle and this goes red.
   */
  it("never says work continues about a helper the turn's last read settled", async () => {
    server.threads["t9"] = { status: { type: "idle" } };
    const markers: Array<{ kind: string }> = [];
    const task = host.runTurn(17, "delegate", {
      onTool: () => {},
      onActivityMarker: (marker) => {
        markers.push(marker);
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/started", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      startedAtMs: 1789932968000,
      item: {
        id: "col1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        agentsStates: { t9: { status: "running" } },
      },
    });
    server.emit("notification", "turn/completed", {
      threadId: "thread-1",
      turn: { status: "completed" },
    });
    const result = await task;

    expect(result.helpersStillRunning).toBeUndefined();
    expect(markers).toEqual([]);
  });

  it("leaves a helper running when its own thread exposes nothing", async () => {
    // `notLoaded` is the runtime declining to say, not an answer.
    server.threads["t9"] = { status: { type: "notLoaded" } };
    const cards = await runWithChildren({
      t9: { status: "running", message: "Working" },
    });

    const last = cards.filter((c) => c.itemId === "t9").at(-1)!;
    expect(last.card.status).toBe("running");
    expect(last.card.result).toBeUndefined();
  });

  it("tells the adapter a helper outlived the turn, and stays quiet when none did", async () => {
    server.threads["t9"] = { status: { type: "active", activeFlags: [] } };
    const live = host.runTurn(17, "delegate", { onTool: () => {} });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/started", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      startedAtMs: 1789932968000,
      item: {
        id: "col1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        agentsStates: { t9: { status: "running" } },
      },
    });
    server.emit("notification", "turn/completed", {
      threadId: "thread-1",
      turn: { status: "completed" },
    });
    expect((await live).helpersStillRunning).toBe(true);

    host.resetChat(17);
    const settled = host.runTurn(17, "delegate", { onTool: () => {} });
    await vi.waitFor(() => expect(server.next).toBe(2));
    server.emit("notification", "item/completed", {
      threadId: "thread-2",
      turnId: "turn-thread-2",
      item: {
        id: "col2",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        agentsStates: { t8: { status: "completed", message: "All good." } },
      },
    });
    server.emit("notification", "turn/completed", {
      threadId: "thread-2",
      turn: { status: "completed" },
    });
    // Nothing was left working, so the card closes the way it always has.
    expect((await settled).helpersStillRunning).toBeUndefined();
  });
});

/**
 * STAGE 4 (C-21): a picture the runtime's image generation tool finished is
 * KEPT on the turn and handed back on the result, never posted from inside
 * the notification loop. A standard post mid turn marks a Codex agent done for
 * the rest of the turn (gap 04), so the adapter posts it at the end instead.
 *
 * The item fixtures are the schema's (the live probe could not make a
 * picture, see test/fixtures/image-generation.ts); the envelopes and the
 * failed turn are the probe's own.
 *
 * MUTATION PROOFS, recorded in docs/reports/2026-09-24-p5-s4-image-posts:
 *  - collecting on `item/started` too turns the started only case red;
 *  - a `return` after the collection (copying the plan branch) turns the row
 *    case red, because the row is never built;
 *  - dropping the seed in execute() turns the adopted hand over red;
 *  - leaving `images` out of result() turns every result case red.
 */
describe("pictures a turn made", () => {
  let home: string, server: Server, host: CodexHost;
  let adopted: number[];
  let delivered: RunTurnResult[];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-images-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    adopted = [];
    delivered = [];
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      onAdoptedTurn: (chatId) => {
        adopted.push(chatId);
        return {
          callbacks: {},
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

  it("keeps a finished picture on the result once, however often it completes", async () => {
    const task = host.runTurn(1, "draw a gold circle");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit(
      "notification",
      "item/started",
      itemStarted(imageItem({ status: "inProgress", result: "" }), "thread-1"),
    );
    server.emit("notification", "item/completed", itemCompleted(imageItem(), "thread-1"));
    // The same item completing twice (a replay, a second notification) is
    // still one picture: the turn keys them on the item id.
    server.emit("notification", "item/completed", itemCompleted(imageItem(), "thread-1"));
    server.finish("thread-1", "Here is the gold circle.");
    const result = await task;
    expect(result.replyText).toBe("Here is the gold circle.");
    expect(result.images).toHaveLength(1);
    const [image] = result.images!;
    expect(image!.bytes!.equals(GOLD_PNG)).toBe(true);
    expect(image).toMatchObject({
      itemId: "ig_01a0d1ba2874",
      mimeType: "image/png",
      revisedPrompt: "A plain gold circle centred on a dark charcoal background",
    });
    expect(image).not.toHaveProperty("result");
  });

  it("hands a proposed plan the pictures finished before it, so they can post ahead of its card", async () => {
    // Finding 2: a picture posted AFTER the plan card runs the backend's done
    // over the card's blocked ("Waiting on your go ahead"). The card is
    // posted from inside the turn, so the pictures it must follow have to
    // reach the adapter there too.
    const signals: any[] = [];
    const task = host.runTurn(1, "plan a logo", {
      onPlanProposal: (signal) => {
        signals.push(signal);
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/completed", itemCompleted(imageItem(), "thread-1"));
    server.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-thread-1",
      item: { id: "plan-1", type: "plan", text: "## Logo\n\n1. Draw it" },
    });
    server.finish("thread-1", "");
    await task;
    expect(signals).toHaveLength(1);
    expect(signals[0].images.map((i: any) => i.itemId)).toEqual([
      "ig_01a0d1ba2874",
    ]);
  });

  it("adds nothing on item/started alone, even when the runtime fills the result early", async () => {
    const task = host.runTurn(1, "draw");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/started", itemStarted(imageItem(), "thread-1"));
    server.finish("thread-1", "Still drawing.");
    expect((await task).images ?? []).toHaveLength(0);
  });

  it("carries a refused picture with its failure, and no bytes", async () => {
    const failure = {
      type: "usageLimitExceeded",
      limitId: "image_generation",
      resetsAt: 1790240000,
    };
    const task = host.runTurn(1, "draw");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit(
      "notification",
      "item/completed",
      itemCompleted(imageItem({ result: "", failure, savedPath: null }), "thread-1"),
    );
    server.finish("thread-1", "");
    const [image] = (await task).images!;
    expect(image!.failure).toEqual(failure);
    expect(image!.bytes).toBeUndefined();
  });

  it("keeps two pictures in the order they finished", async () => {
    const task = host.runTurn(1, "draw two");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit(
      "notification",
      "item/completed",
      itemCompleted(imageItem({ id: "exec-2", revisedPrompt: "second" }), "thread-1"),
    );
    server.emit(
      "notification",
      "item/completed",
      itemCompleted(imageItem({ id: "exec-1", revisedPrompt: "first" }), "thread-1"),
    );
    server.finish("thread-1", "Two.");
    expect((await task).images!.map((i) => i.itemId)).toEqual(["exec-2", "exec-1"]);
  });

  it("still draws the image row on both phases, named from savedPath", async () => {
    const cards: Array<{ itemId: string; card: any }> = [];
    const task = host.runTurn(1, "draw", {
      onTool: (card, itemId) => {
        cards.push({ itemId, card });
      },
    });
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit(
      "notification",
      "item/started",
      itemStarted(imageItem({ status: "inProgress", result: "" }), "thread-1"),
    );
    server.emit("notification", "item/completed", itemCompleted(imageItem(), "thread-1"));
    server.emit(
      "notification",
      "item/completed",
      itemCompleted(
        imageItem({
          id: "ig_refused",
          result: "",
          savedPath: null,
          failure: { type: "usageLimitExceeded", limitId: "image_generation" },
        }),
        "thread-1",
      ),
    );
    server.finish("thread-1", "Done.");
    await task;
    expect(cards.map((c) => [c.itemId, c.card.name, c.card.status])).toEqual([
      ["ig_01a0d1ba2874", "image_generation", "running"],
      ["ig_01a0d1ba2874", "image_generation", "done"],
      ["ig_refused", "image_generation", "error"],
    ]);
    expect(cards[1]!.card.path).toMatch(/ig_01a0d1ba2874\.png$/);
    // The base64 never rides a row.
    expect(JSON.stringify(cards)).not.toContain(GOLD_PNG.toString("base64").slice(0, 40));
  });

  it("hands the watchdog's result the pictures finished before it fired", async () => {
    const task = host.runDetached(1, "draw", {}, false, 300);
    await vi.waitFor(() =>
      expect(server.request.mock.calls.some((c) => c[0] === "turn/start")).toBe(true),
    );
    server.emit("notification", "item/completed", itemCompleted(imageItem(), "thread-1"));
    const result = await task;
    expect(result.error).toMatch(/timed out/);
    expect(result.images).toHaveLength(1);
  });

  it("carries a picture through a turn that then failed, on the probe's own 401 shape", async () => {
    const task = host.runTurn(1, "draw");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "item/completed", itemCompleted(imageItem(), "thread-1"));
    server.emit("notification", "turn/completed", probe401Turn("thread-1"));
    const result = await task;
    expect(result.error).toBe(
      "Codex needs you to sign in again. Reconnect this agent in HOAI, then retry.",
    );
    expect(result.images).toHaveLength(1);
  });

  it("hands the pictures an adopted turn finished to the owner turn that takes its thread", async () => {
    const first = host.runTurn(20, "hello");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.finish("thread-1", "hi");
    await first;
    server.emit("notification", "turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-continuation", status: "inProgress" },
    });
    expect(adopted).toEqual([20]);
    server.emit("notification", "item/completed", itemCompleted(imageItem(), "thread-1"));

    // The owner asks something while the continuation runs: the owner's turn
    // takes the thread and the adopted turn is released without delivering.
    const owner = host.runTurn(20, "and make it bigger");
    await vi.waitFor(() =>
      expect(
        server.request.mock.calls.filter((c) => c[0] === "turn/start").length,
      ).toBe(2),
    );
    server.finish("thread-1", "Here it is.");
    const result = await owner;
    expect(result.images?.map((i) => i.itemId)).toEqual(["ig_01a0d1ba2874"]);
    expect(delivered).toHaveLength(0);
  });
});

/**
 * Stage 4 (C-21), finding 4: no past turn rides a resume, a fork or a read.
 *
 * The runtime stores every picture's full base64 `result` in the rollout, and
 * `thread/resume`, `thread/fork` and `thread/read {includeTurns:true}` all
 * hydrate `thread.turns` unless told not to. A chat with about six pictures
 * then answers one resume with a single line over the app server client's
 * 16 MiB cap (src/app-server.ts), which closes the connection and fails every
 * live turn on the daemon, for every chat, again on every later resume. The
 * wire was measured on the vendored 0.154.0 binary by the review: 14.23 MiB
 * for five pictures without the flag, 3.9 KB with it.
 *
 * The 0.154.0 schema (`codex app-server generate-ts --experimental`):
 *  - ThreadResumeParams.excludeTurns and ThreadForkParams.excludeTurns: "When
 *    true, return only thread metadata ... without populating
 *    `thread.turns`. Full-history hydration is deprecated for paginated
 *    threads; use this with `thread/turns/list` and `thread/items/list`."
 *  - ThreadReadParams.includeTurns: "Full-history hydration is deprecated for
 *    paginated threads; prefer a metadata-only read and page with
 *    `thread/turns/list` and `thread/items/list`."
 *  - ThreadTurnsListParams: cursor, limit, sortDirection (defaults to
 *    descending), itemsView (defaults to summary). Probed on 0.154.0: the
 *    summary view of a turn carries its userMessage and agentMessage items.
 *
 * MUTATION PROOFS: drop `excludeTurns` from either resume, or from the fork,
 * and that case goes red; point the migration back at `thread/read
 * {includeTurns:true}` and the migration cases go red.
 */
describe("no past turn rides a resume, a fork or a read", () => {
  let home: string, server: Server, host: CodexHost;
  const tools = [
    {
      type: "function" as const,
      name: "reply",
      description: "reply",
      inputSchema: { type: "object" },
    },
  ];
  function makeHost(): CodexHost {
    return new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      tools,
    });
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-history-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    host = makeHost();
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  async function bindThread(chatId: number): Promise<string> {
    const task = host.runTurn(chatId, "hello");
    await vi.waitFor(() => expect(server.next).toBeGreaterThan(0));
    const threadId = `thread-${server.next}`;
    server.finish(threadId, "hi");
    await task;
    return threadId;
  }
  const callsOf = (method: string) =>
    server.request.mock.calls.filter((c) => c[0] === method).map((c) => c[1]);

  it("resumes a chat's thread after a restart with excludeTurns", async () => {
    const threadId = await bindThread(30);
    host.close();
    const again = host.runTurn(30, "next");
    await vi.waitFor(() => expect(callsOf("thread/resume")).toHaveLength(1));
    expect(callsOf("thread/resume")[0]).toMatchObject({
      threadId,
      excludeTurns: true,
    });
    server.finish(threadId, "Next");
    await again;
  });

  it("resumes a saved conversation with excludeTurns", async () => {
    const threadId = await bindThread(31);
    await host.resumeSavedThread(31, threadId);
    expect(callsOf("thread/resume")).toEqual([
      expect.objectContaining({ threadId, excludeTurns: true }),
    ]);
  });

  it("forks the owner's thread with excludeTurns", async () => {
    await bindThread(32);
    await host.forkThread(32);
    expect(callsOf("thread/fork")).toEqual([
      expect.objectContaining({ excludeTurns: true }),
    ]);
  });

  it("never reads a thread with its turns, anywhere", async () => {
    await bindThread(33);
    await host.savedThreads(33);
    for (const params of callsOf("thread/read"))
      expect(params.includeTurns).not.toBe(true);
  });

  describe("the legacy tool upgrade carries recent text from paged summary turns", () => {
    function legacyHost(chatId: number): void {
      host.close();
      writeFileSync(
        join(home, "threads.json"),
        JSON.stringify({ [chatId]: "legacy" }),
      );
      host = makeHost();
    }
    const turn = (user: string, agent: string) => ({
      id: `turn-${user}`,
      itemsView: "summary",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: `u-${user}`,
          content: [{ type: "text", text: user, text_elements: [] }],
        },
        { type: "agentMessage", id: `a-${user}`, text: agent },
      ],
    });

    it("pages newest first and keeps the conversation in its own order", async () => {
      legacyHost(40);
      const base = server.request.getMockImplementation()!;
      server.request.mockImplementation(async (method: string, p: any) => {
        if (method === "thread/turns/list")
          return p.cursor === "older"
            ? { data: [turn("first ask", "first answer")], nextCursor: null }
            : {
                data: [turn("second ask", "second answer")],
                nextCursor: "older",
              };
        return base(method, p);
      });
      const task = host.runTurn(40, "continue");
      await vi.waitFor(() => expect(callsOf("thread/start")).toHaveLength(1));
      expect(callsOf("thread/turns/list")).toEqual([
        {
          threadId: "legacy",
          itemsView: "summary",
          sortDirection: "desc",
          limit: 4,
        },
        {
          threadId: "legacy",
          itemsView: "summary",
          sortDirection: "desc",
          limit: 4,
          cursor: "older",
        },
      ]);
      for (const params of callsOf("thread/read"))
        expect(params.includeTurns).not.toBe(true);
      const instructions = String(
        callsOf("thread/start")[0].developerInstructions,
      );
      expect(instructions).toContain("legacy remains saved");
      const order = ["first ask", "first answer", "second ask", "second answer"]
        .map((text) => instructions.indexOf(text));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      server.finish("thread-1", "Continued");
      await task;
    });

    it("stops paging once the text budget is spent", async () => {
      legacyHost(41);
      const base = server.request.getMockImplementation()!;
      server.request.mockImplementation(async (method: string, p: any) => {
        if (method === "thread/turns/list")
          return {
            data: [turn("ask", "x".repeat(70_000))],
            nextCursor: "older",
          };
        return base(method, p);
      });
      const task = host.runTurn(41, "continue");
      await vi.waitFor(() => expect(callsOf("thread/start")).toHaveLength(1));
      expect(callsOf("thread/turns/list")).toHaveLength(1);
      server.finish("thread-1", "Continued");
      await task;
    });

    it("still upgrades the thread when a history page cannot be read", async () => {
      legacyHost(42);
      const base = server.request.getMockImplementation()!;
      server.request.mockImplementation(async (method: string, p: any) => {
        if (method === "thread/turns/list") throw new Error("not indexed");
        return base(method, p);
      });
      const task = host.runTurn(42, "continue");
      await vi.waitFor(() => expect(callsOf("thread/start")).toHaveLength(1));
      expect(String(callsOf("thread/start")[0].developerInstructions)).toContain(
        "legacy remains saved",
      );
      server.finish("thread-1", "Continued");
      await task;
    });
  });
});
