import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BgosApi, type ReplaceStepsBody } from "../src/bgos-api.js";
import { CodexAdapter } from "../src/adapter.js";
import {
  CLEAR_DEADLINE_MS,
  StepsLane,
  STEPS_KEEPALIVE_MS,
  stepsChatKindAdmits,
} from "../src/steps-lane.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function stepsPath(assistantId: number, chatId: number): string {
  return `/api/v1/integrations/assistants/${assistantId}/chats/${chatId}/steps`;
}

function plan(items: Array<[string, string]>) {
  return items.map(([step, status]) => ({ step, status }));
}

describe("StepsLane (Codex plan snapshots)", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  const lanes: StepsLane[] = [];

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    const current = lanes.splice(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await Promise.all(current.map((lane) => lane.dispose()));
    } finally {
      vi.restoreAllMocks();
      await server.stop();
    }
  });

  function makeLane(debounceMs = 600): StepsLane {
    const lane = new StepsLane(makeApi(baseUrl), { debounceMs });
    lanes.push(lane);
    return lane;
  }

  function puts(assistantId = 7, chatId = 42) {
    return server.requests.filter(
      (r) => r.method === "PUT" && r.url === stepsPath(assistantId, chatId),
    );
  }

  it("replaces the whole snapshot with the three plan statuses mapped", async () => {
    server.stage("PUT", stepsPath(7, 42), 200, { ok: true });
    const lane = makeLane(0);

    await lane.handlePlan({
      assistantId: 7,
      chatId: 42,
      turnId: "turn-9",
      plan: plan([
        ["Read the failing spec", "completed"],
        ["Write the steps lane", "in_progress"],
        ["Run the suite", "pending"],
        ["Ship it", "queued"],
      ]),
    });

    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({
      turnId: "turn-9",
      steps: [
        { text: "Read the failing spec", status: "done" },
        { text: "Write the steps lane", status: "running" },
        { text: "Run the suite", status: "pending" },
        { text: "Ship it", status: "pending" },
      ],
    });
  });

  it("clips each step to 200 characters and the list to 30 steps", async () => {
    server.stage("PUT", stepsPath(7, 42), 200, { ok: true });
    const lane = makeLane(0);

    await lane.handlePlan({
      assistantId: 7,
      chatId: 42,
      turnId: null,
      plan: plan([
        ["L".repeat(250), "in_progress"],
        ...Array.from(
          { length: 39 },
          (_, i) => [`Step ${i}`, "pending"] as [string, string],
        ),
      ]),
    });

    const body = puts()[0]!.body as {
      turnId?: string;
      steps: Array<{ text: string; status: string }>;
    };
    expect(body.steps).toHaveLength(30);
    expect(body.steps[0]!.text).toHaveLength(200);
    expect(body.turnId).toBeUndefined();
  });

  it("does not resend a snapshot identical to the last one", async () => {
    server.stage("PUT", stepsPath(7, 42), 200, { ok: true });
    server.stage("PUT", stepsPath(7, 42), 200, { ok: true });
    const lane = makeLane(0);
    const same = {
      assistantId: 7,
      chatId: 42,
      turnId: "turn-9",
      plan: plan([["Read the failing spec", "in_progress"]]),
    };

    await lane.handlePlan(same);
    await lane.handlePlan({
      ...same,
      plan: plan([["Read the failing spec", "in_progress"]]),
    });
    expect(puts()).toHaveLength(1);

    await lane.handlePlan({
      ...same,
      plan: plan([["Read the failing spec", "completed"]]),
    });
    expect(puts()).toHaveLength(2);
    expect((puts()[1]!.body as { steps: unknown[] }).steps).toEqual([
      { text: "Read the failing spec", status: "done" },
    ]);
  });

  it("coalesces rapid plan updates into one later PUT carrying the newest list", async () => {
    for (let i = 0; i < 4; i += 1)
      server.stage("PUT", stepsPath(7, 42), 200, { ok: true });
    const lane = makeLane(600);

    await lane.handlePlan({
      assistantId: 7,
      chatId: 42,
      turnId: "turn-9",
      plan: plan([["One", "in_progress"]]),
    });
    expect(puts()).toHaveLength(1);

    await lane.handlePlan({
      assistantId: 7,
      chatId: 42,
      turnId: "turn-9",
      plan: plan([["One", "completed"]]),
    });
    await lane.handlePlan({
      assistantId: 7,
      chatId: 42,
      turnId: "turn-9",
      plan: plan([
        ["One", "completed"],
        ["Two", "in_progress"],
      ]),
    });
    expect(puts()).toHaveLength(1);

    await expect
      .poll(() => puts().length, { timeout: 2_000, interval: 20 })
      .toBe(2);
    const stableSince = Date.now();
    await expect
      .poll(() => puts().length === 2 && Date.now() - stableSince >= 250, {
        timeout: 750,
        interval: 20,
      })
      .toBe(true);
    expect((puts()[1]!.body as { steps: unknown[] }).steps).toEqual([
      { text: "One", status: "done" },
      { text: "Two", status: "running" },
    ]);
  }, 10_000);

  it("clears the chat with an empty list when the turn ends", async () => {
    server.stage("PUT", stepsPath(7, 42), 200, { ok: true });
    server.stage("PUT", stepsPath(7, 42), 200, { ok: true });
    const lane = makeLane(0);

    await lane.handlePlan({
      assistantId: 7,
      chatId: 42,
      turnId: "turn-9",
      plan: plan([["One", "in_progress"]]),
    });
    await lane.finalizeTurn(42);
    // The clear goes out in the background now, so the reply never waits on
    // it. It still has to land, and it still has to be an empty snapshot.
    await lane._internal.clearsSettled;

    expect(puts()).toHaveLength(2);
    expect(puts()[1]!.body).toEqual({ steps: [] });
    expect(lane._internal.activeChats).toEqual([]);

    await lane.finalizeTurn(42);
    expect(puts()).toHaveLength(2);
  });

  it("clears every chat it is holding when the daemon is disposed", async () => {
    for (const chatId of [42, 43])
      for (let i = 0; i < 2; i += 1)
        server.stage("PUT", stepsPath(7, chatId), 200, { ok: true });
    const lane = makeLane(0);

    await lane.handlePlan({
      assistantId: 7,
      chatId: 42,
      turnId: "turn-9",
      plan: plan([["One", "in_progress"]]),
    });
    await lane.handlePlan({
      assistantId: 7,
      chatId: 43,
      turnId: "turn-10",
      plan: plan([["Other", "in_progress"]]),
    });
    await lane.dispose();

    expect(puts(7, 42)[1]!.body).toEqual({ steps: [] });
    expect(puts(7, 43)[1]!.body).toEqual({ steps: [] });
    expect(lane._internal.activeChats).toEqual([]);
  });

  it("a 404 from an older backend silences that chat and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    server.stage("PUT", stepsPath(7, 43), 200, { ok: true });
    const lane = makeLane(0);
    const update = (chatId: number, text: string) =>
      lane.handlePlan({
        assistantId: 7,
        chatId,
        turnId: "turn-9",
        plan: plan([[text, "in_progress"]]),
      });

    await expect(update(42, "One")).resolves.toBeUndefined();
    expect(puts()).toHaveLength(1);
    await update(42, "Two");
    await lane.finalizeTurn(42);
    await update(42, "Three");
    expect(puts()).toHaveLength(1);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("chat=42")),
    ).toHaveLength(1);

    await update(43, "Elsewhere");
    expect(puts(7, 43)).toHaveLength(1);
  });

  it("a 403 silences the chat while a 5xx keeps being retried", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    server.stage("PUT", stepsPath(7, 42), 403, { message: "nope" });
    server.stage("PUT", stepsPath(7, 42), 200, { ok: true });
    server.stage("PUT", stepsPath(7, 44), 500, { message: "later" });
    server.stage("PUT", stepsPath(7, 44), 200, { ok: true });
    const lane = makeLane(0);
    const update = (chatId: number, text: string) =>
      lane.handlePlan({
        assistantId: 7,
        chatId,
        turnId: "turn-9",
        plan: plan([[text, "in_progress"]]),
      });

    // A room chat, another assistant's chat or an unscoped assistant all
    // answer 403 and will answer 403 forever. Stop asking.
    await expect(update(42, "One")).resolves.toBeUndefined();
    await update(42, "Two");
    expect(puts(7, 42)).toHaveLength(1);
    expect(lane._internal.silencedChats).toEqual([42]);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("chat=42")),
    ).toHaveLength(1);

    // A 500 is the backend having a bad minute. The next snapshot still goes.
    await update(44, "One");
    await update(44, "Two");
    expect(puts(7, 44)).toHaveLength(2);
    expect(lane._internal.silencedChats).toEqual([42]);
  });
});

describe("the adapter's steps wiring", () => {
  function fixture(runTurn: (callbacks: any) => Promise<unknown>) {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const stepsLane = {
      handlePlan: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
    };
    Object.assign(adapter, {
      turnControllers: new Map(),
    planCardFailures: new Set(),
      ownerId: "owner-1",
      missionLane: {
        beginTurn: vi.fn(() => 1),
        finalizeTurn: vi.fn(async () => {}),
      },
      missionControl: { applyBulletin: (_chatId: number, input: unknown) => input },
      stepsLane,
      toolProgress: { sendToolStart: vi.fn(async () => {}) },
      outbound: { sendAgentError: vi.fn(async () => {}) },
      api: {},
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
      sendText: vi.fn(async () => {}),
    };
    return { adapter, reply, stepsLane };
  }

  const planned = [
    { step: "Read the spec", status: "in_progress" },
    { step: "Write the lane", status: "pending" },
  ];

  it("hands every plan update to the steps lane and clears it when the turn ends", async () => {
    const { adapter, reply, stepsLane } = fixture(async (cb) => {
      await cb.onPlan?.({ turnId: "turn-3", plan: planned });
      return { error: "Connection lost", replyText: "", turnCompleted: false };
    });

    await adapter.executeAndReply(10, 20, "Work", reply);

    expect(stepsLane.handlePlan).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      turnId: "turn-3",
      plan: planned,
    });
    expect(stepsLane.finalizeTurn).toHaveBeenCalledWith(20);
  });

  it("clears the steps when the user stops the turn", async () => {
    const { adapter, reply, stepsLane } = fixture(async (cb) => {
      await cb.onPlan?.({ turnId: "turn-3", plan: planned });
      for (const controller of adapter.turnControllers.get(20))
        controller.abort();
      return {
        error: "Stopped by you.",
        replyText: "Late partial",
        turnCompleted: false,
      };
    });

    await adapter.executeAndReply(10, 20, "Work", reply);

    expect(stepsLane.handlePlan).toHaveBeenCalledTimes(1);
    expect(stepsLane.finalizeTurn).toHaveBeenCalledWith(20);
  });

  it("clears the steps when the turn throws", async () => {
    const { adapter, reply, stepsLane } = fixture(async (cb) => {
      await cb.onPlan?.({ turnId: "turn-3", plan: planned });
      throw new Error("Codex died");
    });

    await expect(
      adapter.executeAndReply(10, 20, "Work", reply),
    ).rejects.toThrow("Codex died");
    expect(stepsLane.finalizeTurn).toHaveBeenCalledWith(20);
  });

  it("never wires a room turn to the lane, so a room chat cannot PUT", async () => {
    let sawOnPlan = true;
    const { adapter, reply, stepsLane } = fixture(async (cb) => {
      sawOnPlan = cb.onPlan !== undefined;
      await cb.onPlan?.({ turnId: "turn-3", plan: planned });
      return { error: null, replyText: "done", turnCompleted: true };
    });

    await adapter.executeAndReply(10, 20, "Work", reply, { chatKind: "room" });

    expect(sawOnPlan).toBe(false);
    expect(stepsLane.handlePlan).not.toHaveBeenCalled();
    expect(stepsLane.finalizeTurn).not.toHaveBeenCalled();
  });

  it("still wires a DM turn, and an absent kind reads as a DM", async () => {
    for (const chatKind of ["main", undefined]) {
      const { adapter, reply, stepsLane } = fixture(async (cb) => {
        await cb.onPlan?.({ turnId: "turn-3", plan: planned });
        return { error: null, replyText: "done", turnCompleted: true };
      });

      await adapter.executeAndReply(10, 20, "Work", reply, { chatKind });

      expect(stepsLane.handlePlan).toHaveBeenCalledTimes(1);
      expect(stepsLane.finalizeTurn).toHaveBeenCalledWith(20);
    }
  });
});

// ---------------------------------------------------------------------------
// The paths that need a server which answers when WE say so: a write still in
// flight, a clear the backend refuses, a plan that runs longer than the
// record's own lifetime. A stub api keeps every one of them deterministic.
// ---------------------------------------------------------------------------

interface FakeCall {
  assistantId: number;
  chatId: number;
  body: ReplaceStepsBody;
  options?: { timeout?: number };
}

function fakeApi(
  respond: (call: FakeCall, index: number) => Promise<void> = async () => {},
) {
  const calls: FakeCall[] = [];
  const api = {
    replaceSteps: async (
      assistantId: number,
      chatId: number,
      body: ReplaceStepsBody,
      options?: { timeout?: number },
    ): Promise<void> => {
      const call: FakeCall = {
        assistantId,
        chatId,
        body: JSON.parse(JSON.stringify(body)) as ReplaceStepsBody,
        options,
      };
      calls.push(call);
      await respond(call, calls.length - 1);
    },
  };
  return { api: api as unknown as BgosApi, calls };
}

function httpError(status: number): Error {
  const err = new Error(`HTTP ${status}`) as Error & {
    response: { status: number };
  };
  err.response = { status };
  return err;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Watch the interval the keepalive runs on. A stopped keepalive has to be
 * observable as a CLEARED timer: a turn whose state is gone already makes no
 * request, so counting requests alone would pass on a leaked timer.
 */
function trackIntervals(): {
  created: unknown[];
  cleared: unknown[];
  unrefed: unknown[];
} {
  const created: unknown[] = [];
  const cleared: unknown[] = [];
  const unrefed: unknown[] = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    handler: () => void,
    ms?: number,
  ) => {
    const handle = realSetInterval(handler, ms) as unknown as {
      unref?: () => unknown;
    };
    const original = handle.unref?.bind(handle);
    handle.unref = () => {
      unrefed.push(handle);
      return original?.();
    };
    created.push(handle);
    return handle;
  }) as unknown as typeof globalThis.setInterval);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(((
    handle: unknown,
  ) => {
    cleared.push(handle);
    realClearInterval(handle as ReturnType<typeof setInterval>);
  }) as unknown as typeof globalThis.clearInterval);
  return { created, cleared, unrefed };
}

/** Let every queued microtask and one macrotask run. */
async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function onePlan(chatId = 42, text = "One", status = "in_progress") {
  return {
    assistantId: 7,
    chatId,
    turnId: "turn-9",
    plan: plan([[text, status]]),
  };
}

describe("StepsLane (write ordering, clear retries, keepalive)", () => {
  const lanes: StepsLane[] = [];

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    const current = lanes.splice(0);
    try {
      await Promise.all(current.map((lane) => lane.dispose()));
    } finally {
      vi.restoreAllMocks();
    }
  });

  function track(lane: StepsLane): StepsLane {
    lanes.push(lane);
    return lane;
  }

  it("lets a snapshot write already in flight land before it clears the turn", async () => {
    const gate = deferred();
    const { api, calls } = fakeApi(async (_call, index) => {
      if (index === 0) await gate.promise;
    });
    const lane = track(new StepsLane(api, { debounceMs: 0 }));

    const planned = lane.handlePlan(onePlan());
    await settle();
    expect(calls).toHaveLength(1);

    const ended = lane.finalizeTurn(42);
    await settle();
    // The clear must NOT overtake the snapshot: a clear that lands first is
    // written back over by the stale list and the plan stays on screen.
    expect(calls).toHaveLength(1);

    gate.resolve();
    await planned;
    await ended;
    await lane._internal.clearsSettled;
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ steps: [] });
  });

  it("lets a snapshot write already in flight land before dispose clears", async () => {
    const gate = deferred();
    const { api, calls } = fakeApi(async (_call, index) => {
      if (index === 0) await gate.promise;
    });
    const lane = new StepsLane(api, { debounceMs: 0 });

    const planned = lane.handlePlan(onePlan());
    await settle();
    expect(calls).toHaveLength(1);

    const stopped = lane.dispose();
    await settle();
    expect(calls).toHaveLength(1);

    gate.resolve();
    await planned;
    await stopped;
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ steps: [] });
  });

  it("does not let a stuck write hold up the shutdown clear", async () => {
    const stuck = deferred();
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length > 0) await stuck.promise;
    });
    const lane = new StepsLane(api, { debounceMs: 0, disposeTimeoutMs: 120 });

    const planned = lane.handlePlan(onePlan());
    await settle();
    expect(calls).toHaveLength(1);

    const startedAt = Date.now();
    await lane.dispose();

    // A frozen step must still come off the screen, and a stopping daemon
    // must still stop, even when the write it was waiting for never answers.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ steps: [] });

    stuck.resolve();
    await planned;
  });

  it("retries a turn end clear the backend refused", async () => {
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0 && calls.length === 2) {
        throw httpError(503);
      }
    });
    const lane = track(new StepsLane(api, { debounceMs: 0 }));

    await lane.handlePlan(onePlan());
    await lane.finalizeTurn(42);
    await lane._internal.clearsSettled;

    expect(calls).toHaveLength(3);
    expect(calls[1]!.body).toEqual({ steps: [] });
    expect(calls[2]!.body).toEqual({ steps: [] });
  });

  it("gives up on a clear the backend keeps refusing", async () => {
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) throw httpError(500);
    });
    const lane = track(new StepsLane(api, { debounceMs: 0 }));

    await lane.handlePlan(onePlan());
    await lane.finalizeTurn(42);
    await lane._internal.clearsSettled;

    // One snapshot plus a bounded number of clear attempts, never a loop.
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).every((c) => c.body.steps.length === 0)).toBe(true);
  });

  it("does not retry a clear the chat was silenced on", async () => {
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) throw httpError(403);
    });
    const lane = track(new StepsLane(api, { debounceMs: 0 }));

    await lane.handlePlan(onePlan());
    await lane.finalizeTurn(42);
    await lane._internal.clearsSettled;

    expect(calls).toHaveLength(2);
    expect(lane._internal.silencedChats).toEqual([42]);
  });

  it("bounds the dispose clear with the shutdown budget", async () => {
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) throw httpError(500);
    });
    const lane = new StepsLane(api, { debounceMs: 0 });

    await lane.handlePlan(onePlan());
    await lane.dispose();

    const clears = calls.slice(1);
    expect(clears.length).toBeGreaterThan(1);
    for (const clear of clears) {
      expect(clear.options?.timeout).toBeGreaterThan(0);
      expect(clear.options?.timeout).toBeLessThanOrEqual(3_000);
    }
    // Every retry eats into the same budget rather than restarting it.
    expect(clears[1]!.options!.timeout).toBeLessThan(
      clears[0]!.options!.timeout!,
    );
  });

  it("re PUTs an unchanged snapshot while the plan is still in flight", async () => {
    const { api, calls } = fakeApi();
    const lane = track(new StepsLane(api, { debounceMs: 0, keepaliveMs: 25 }));

    await lane.handlePlan(onePlan());
    expect(calls).toHaveLength(1);

    // A single step that outlives the record would otherwise make every Steps
    // surface vanish mid turn, because only a write restamps the record.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 2_000,
      interval: 10,
    });
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(calls[2]!.body).toEqual(calls[0]!.body);
  });

  it("stops the keepalive when the turn ends", async () => {
    const timers = trackIntervals();
    const { api, calls } = fakeApi();
    const lane = track(new StepsLane(api, { debounceMs: 0, keepaliveMs: 25 }));

    await lane.handlePlan(onePlan());
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2_000,
      interval: 10,
    });
    expect(timers.created).toHaveLength(1);

    await lane.finalizeTurn(42);
    expect(timers.cleared).toContain(timers.created[0]);
    await lane._internal.clearsSettled;

    const settledAt = calls.length;
    await settle(120);
    expect(calls).toHaveLength(settledAt);
  });

  it("stops the keepalive on dispose", async () => {
    const timers = trackIntervals();
    const { api, calls } = fakeApi();
    const lane = new StepsLane(api, { debounceMs: 0, keepaliveMs: 25 });

    await lane.handlePlan(onePlan());
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 2_000,
      interval: 10,
    });
    expect(timers.created).toHaveLength(1);

    await lane.dispose();
    expect(timers.cleared).toContain(timers.created[0]);

    const settledAt = calls.length;
    await settle(120);
    expect(calls).toHaveLength(settledAt);
  });

  it("stops the keepalive for a chat the backend refuses", async () => {
    const timers = trackIntervals();
    const { api, calls } = fakeApi(async () => {
      throw httpError(403);
    });
    const lane = track(new StepsLane(api, { debounceMs: 0, keepaliveMs: 25 }));

    await lane.handlePlan(onePlan());
    expect(calls).toHaveLength(1);
    expect(timers.cleared).toContain(timers.created[0]);

    await settle(120);
    expect(calls).toHaveLength(1);
  });

  it("unrefs the keepalive timer so a live plan never holds the process open", async () => {
    const timers = trackIntervals();
    const { api } = fakeApi();
    const lane = track(new StepsLane(api, { debounceMs: 0, keepaliveMs: 500 }));

    await lane.handlePlan(onePlan());

    expect(timers.created).toHaveLength(1);
    expect(timers.unrefed).toEqual(timers.created);
  });

  it("keeps the shipped keepalive well inside the record's own lifetime", () => {
    expect(STEPS_KEEPALIVE_MS).toBe(90_000);
    // The backend sweeps a record three minutes after its last write.
    expect(STEPS_KEEPALIVE_MS).toBeLessThan(180_000);
  });

  it("silences the chat on every permanent refusal", async () => {
    for (const status of [400, 401, 403, 404, 405, 409, 422]) {
      const { api, calls } = fakeApi(async () => {
        throw httpError(status);
      });
      const lane = track(new StepsLane(api, { debounceMs: 0 }));

      await lane.handlePlan(onePlan(42, "One"));
      await lane.handlePlan(onePlan(42, "Two"));

      expect({ status, calls: calls.length }).toEqual({ status, calls: 1 });
      expect(lane._internal.silencedChats).toEqual([42]);
    }
  });

  it("keeps retrying a refusal that can clear by itself", async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const { api, calls } = fakeApi(async () => {
        throw httpError(status);
      });
      const lane = track(new StepsLane(api, { debounceMs: 0 }));

      await lane.handlePlan(onePlan(42, "One"));
      await lane.handlePlan(onePlan(42, "Two"));

      expect({ status, calls: calls.length }).toEqual({ status, calls: 2 });
      expect(lane._internal.silencedChats).toEqual([]);
    }
  });

  it("never silences a chat on a network error", async () => {
    const { api, calls } = fakeApi(async () => {
      throw new Error("socket hang up");
    });
    const lane = track(new StepsLane(api, { debounceMs: 0 }));

    await lane.handlePlan(onePlan(42, "One"));
    await lane.handlePlan(onePlan(42, "Two"));

    expect(calls).toHaveLength(2);
    expect(lane._internal.silencedChats).toEqual([]);
  });

  // -- the turn end clear must never hold up the owner's reply --------------
  // `adapter.ts` awaits `finalizeTurn` BEFORE it sends the reply, and every
  // request in the clear carries axios's 30 s default. Uncapped, one hung but
  // connected backend parks the owner's answer for two minutes.

  it("resolves the turn end before the clear's write is answered", async () => {
    const gate = deferred();
    let answered = false;
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) {
        await gate.promise;
        answered = true;
      }
    });
    const lane = track(new StepsLane(api, { debounceMs: 0 }));

    await lane.handlePlan(onePlan());
    expect(calls).toHaveLength(1);

    const ended = lane.finalizeTurn(42);
    const outcome = await Promise.race([
      ended.then(() => "ended"),
      settle(250).then(() => "waited on the clear"),
    ]);
    expect(outcome).toBe("ended");
    expect(answered).toBe(false);
    expect(lane._internal.pendingClears).toEqual([42]);

    // The clear still goes out; it just goes out behind the reply.
    await vi.waitFor(() => expect(calls).toHaveLength(2), {
      timeout: 2_000,
      interval: 10,
    });
    gate.resolve();
    await lane._internal.clearsSettled;
    expect(answered).toBe(true);
    expect(calls[1]!.body).toEqual({ steps: [] });
    expect(lane._internal.pendingClears).toEqual([]);
  });

  it("still lands the clear when the backend answers late but in budget", async () => {
    let answered = 0;
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) {
        await settle(120);
        answered += 1;
      }
    });
    const lane = track(
      new StepsLane(api, { debounceMs: 0, clearDeadlineMs: 1_000 }),
    );

    await lane.handlePlan(onePlan());
    await lane.finalizeTurn(42);
    expect(answered).toBe(0);

    await lane._internal.clearsSettled;
    expect(answered).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ steps: [] });
    // A slow answer is a landed clear, not a failure worth retrying.
    expect(calls.filter((c) => c.body.steps.length === 0)).toHaveLength(1);
    expect(lane._internal.pendingClears).toEqual([]);
  });

  it("gives up on a clear the backend never answers, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hang = deferred();
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) await hang.promise;
    });
    const lane = track(
      new StepsLane(api, { debounceMs: 0, clearDeadlineMs: 300 }),
    );

    await lane.handlePlan(onePlan());
    const startedAt = Date.now();
    await lane.finalizeTurn(42);
    const endedAfter = Date.now() - startedAt;
    await lane._internal.clearsSettled;
    const clearedAfter = Date.now() - startedAt;

    // The turn was done immediately; only the clear spent the budget.
    expect(endedAfter).toBeLessThan(150);
    expect(clearedAfter).toBeGreaterThanOrEqual(250);
    expect(clearedAfter).toBeLessThan(3_000);
    // One attempt, no retry storm against a backend that answers nothing.
    expect(calls).toHaveLength(2);
    expect(
      warn.mock.calls.filter((c) =>
        String(c[0]).includes("steps clear gave up"),
      ),
    ).toHaveLength(1);
    expect(lane._internal.pendingClears).toEqual([]);

    hang.resolve();
  });

  it("never lets a late clear blank the next turn's first snapshot", async () => {
    const gate = deferred();
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) {
        await gate.promise;
        throw httpError(500);
      }
    });
    const lane = track(
      new StepsLane(api, { debounceMs: 0, clearDeadlineMs: 2_000 }),
    );

    await lane.handlePlan(onePlan(42, "One"));
    await lane.finalizeTurn(42);
    await vi.waitFor(() => expect(calls).toHaveLength(2), {
      timeout: 2_000,
      interval: 10,
    });

    // A new turn opens while the previous turn's clear is still going out.
    const next = lane.handlePlan(onePlan(42, "Two"));
    await settle(30);
    expect(calls).toHaveLength(2);

    const resumedAt = Date.now();
    gate.resolve();
    await next;
    const heldBack = Date.now() - resumedAt;
    await lane._internal.clearsSettled;
    await settle(30);

    // The clear failed, but the new turn owns the chat now: no retry lands on
    // top of its first snapshot, which stays the last write on the wire.
    expect(calls).toHaveLength(3);
    // And it stands down at once rather than making the new turn wait out a
    // 200 ms backoff it can no longer do anything useful with.
    expect(heldBack).toBeLessThan(150);
    expect(calls[2]!.body).toEqual({
      turnId: "turn-9",
      steps: [{ text: "Two", status: "running" }],
    });
    expect(calls.filter((c) => c.body.steps.length === 0)).toHaveLength(1);
  });


  it("stands a retrying clear down as soon as a new turn opens", async () => {
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) throw httpError(500);
    });
    const lane = track(
      new StepsLane(api, { debounceMs: 0, clearDeadlineMs: 2_000 }),
    );

    await lane.handlePlan(onePlan(42, "One"));
    await lane.finalizeTurn(42);
    // The first attempt has failed and the retry is sitting in its backoff.
    await vi.waitFor(() => expect(calls).toHaveLength(2), {
      timeout: 2_000,
      interval: 5,
    });

    const next = lane.handlePlan(onePlan(42, "Two"));
    await next;
    await lane._internal.clearsSettled;
    await settle(400);

    // The retry woke up into a chat it no longer owns and wrote nothing.
    expect(calls.filter((c) => c.body.steps.length === 0)).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body).toEqual({
      turnId: "turn-9",
      steps: [{ text: "Two", status: "running" }],
    });
  });

  it("waits for a turn end clear still going out when it shuts down", async () => {
    const gate = deferred();
    let answered = 0;
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) {
        await gate.promise;
        answered += 1;
      }
    });
    const lane = new StepsLane(api, {
      debounceMs: 0,
      clearDeadlineMs: 5_000,
      disposeTimeoutMs: 500,
    });

    await lane.handlePlan(onePlan());
    await lane.finalizeTurn(42);
    await vi.waitFor(() => expect(calls).toHaveLength(2), {
      timeout: 2_000,
      interval: 5,
    });

    // The turn is over but its clear is not: a daemon that stops here without
    // waiting leaves the finished plan on screen for the backend's sweep.
    setTimeout(() => gate.resolve(), 50);
    await lane.dispose();
    expect(answered).toBe(1);
  });

  it("never lets a stuck turn end clear hold the shutdown open", async () => {
    const stuck = deferred();
    const { api, calls } = fakeApi(async (call) => {
      if (call.body.steps.length === 0) await stuck.promise;
    });
    const lane = new StepsLane(api, {
      debounceMs: 0,
      clearDeadlineMs: 5_000,
      disposeTimeoutMs: 200,
    });

    await lane.handlePlan(onePlan());
    await lane.finalizeTurn(42);
    await vi.waitFor(() => expect(calls).toHaveLength(2), {
      timeout: 2_000,
      interval: 5,
    });

    const startedAt = Date.now();
    await lane.dispose();
    const stoppedAfter = Date.now() - startedAt;

    // It waits, but on the shutdown budget, not on the clear's own.
    expect(stoppedAfter).toBeGreaterThanOrEqual(150);
    expect(stoppedAfter).toBeLessThan(2_000);

    stuck.resolve();
  });

  it("keeps the shipped clear budget well under axios's own default", () => {
    expect(CLEAR_DEADLINE_MS).toBe(5_000);
    // Three attempts on axios's 30 s default is what this budget replaces.
    expect(CLEAR_DEADLINE_MS).toBeLessThan(30_000);
  });
});

describe("stepsChatKindAdmits", () => {
  it("admits a DM and reads an absent kind as one", () => {
    expect(stepsChatKindAdmits("main")).toBe(true);
    expect(stepsChatKindAdmits(undefined)).toBe(true);
    expect(stepsChatKindAdmits(null)).toBe(true);
    expect(stepsChatKindAdmits("")).toBe(true);
  });

  it("refuses every chat the backend's write gate refuses", () => {
    for (const kind of ["room", "meeting", "a2a", "group", "topic", "Main"]) {
      expect({ kind, admitted: stepsChatKindAdmits(kind) }).toEqual({
        kind,
        admitted: false,
      });
    }
  });
});
