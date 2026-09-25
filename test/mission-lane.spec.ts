import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { missionAbortOutcome } from "../src/abort-cause.js";
import { BgosApi } from "../src/bgos-api.js";
import { MissionLane, type MissionLaneOptions } from "../src/mission-lane.js";
import { STOP_PAUSE_REASON } from "../src/session-controls-contract.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function todo(
  items: Array<{ text: string; completed: boolean }>,
  id = "todo-1",
) {
  return { id, type: "todo_list" as const, items };
}

function mission(
  id: number,
  progress: { current: number; total: number; label?: string },
) {
  return {
    id,
    assistantId: 7,
    title: "Plan",
    status: "active",
    origin: "derived",
    progress,
  };
}

function startTurn(
  lane: MissionLane,
  params: Parameters<MissionLane["beginTurn"]>[0],
) {
  const turnToken = lane.beginTurn(params);
  return {
    turnToken,
    handleTodoList(
      event: Omit<
        Parameters<MissionLane["handleTodoList"]>[0],
        "turnToken"
      >,
    ) {
      return lane.handleTodoList({ ...event, turnToken });
    },
    finalizeTurn(
      result: Omit<
        Parameters<MissionLane["finalizeTurn"]>[0],
        "turnToken"
      >,
    ) {
      return lane.finalizeTurn({ ...result, turnToken });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MissionLane (Codex todo_list)", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  const lanes: MissionLane[] = [];

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const current = lanes.splice(0);
    try {
      await Promise.all(current.map((lane) => lane.dispose()));
    } finally {
      await server.stop();
    }
  });

  function makeLane(debounceMs = 600): MissionLane {
    const lane = new MissionLane(makeApi(baseUrl), { debounceMs });
    lanes.push(lane);
    return lane;
  }

  it("creates a derived mission from the first plan with at least three steps", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(101, { current: 1, total: 3, label: "steps" }) },
    );
    const lane = makeLane();
    const promptTitle = "Audit " + "x".repeat(210);
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 42,
      prompt: `  ${promptTitle}  \nThis line is not the title`,
    });

    await turn.handleTodoList({
      chatId: 42,
      eventType: "item.started",
      item: todo([
        { text: "Inventory", completed: true },
        { text: "Verify", completed: false },
        { text: "Report", completed: false },
      ]),
    });

    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      // Per chat scope (stage 5): the active read names the chat, so two chats
      // of one agent cannot be handed each other's mission.
      "GET /api/v1/integrations/assistants/7/missions/active?chatId=42",
      "POST /api/v1/integrations/assistants/7/missions",
    ]);
    expect(server.requests[1]!.headers["x-bgos-pairing"]).toBe(
      "pair_" + "x".repeat(30),
    );
    expect(server.requests[1]!.body).toEqual({
      title: promptTitle.slice(0, 200),
      chatId: 42,
      progress: { current: 1, total: 3, label: "steps" },
      origin: "derived",
      firstFeedText: "Planned 3 steps",
    });
  });

  /**
   * Stage 6. A chat whose work is a native goal already has a mission, and
   * the first plan of that goal's own first turn would otherwise create a
   * SECOND one: attachMission only steps aside for a self reported mission,
   * and a goal mission is derived like this lane's own.
   */
  it("stands down completely for a chat the native goal lane owns", async () => {
    const lane = new MissionLane(makeApi(baseUrl), {
      debounceMs: 600,
      goalOwnsChat: (chatId) => chatId === 42,
    });
    lanes.push(lane);
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 42,
      prompt: "Make the page fast",
    });

    await turn.handleTodoList({
      chatId: 42,
      eventType: "item.started",
      item: todo([
        { text: "Measure", completed: false },
        { text: "Fix", completed: false },
        { text: "Measure again", completed: false },
      ]),
    });

    // Not even the active read: this chat is not this lane's at all.
    expect(server.requests).toHaveLength(0);
  });

  it("still creates one for a chat the goal lane does not own", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(101, { current: 0, total: 3, label: "steps" }) },
    );
    const lane = new MissionLane(makeApi(baseUrl), {
      debounceMs: 600,
      goalOwnsChat: (chatId) => chatId === 42,
    });
    lanes.push(lane);
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 44,
      prompt: "Make the page fast",
    });

    await turn.handleTodoList({
      chatId: 44,
      eventType: "item.started",
      item: todo([
        { text: "Measure", completed: false },
        { text: "Fix", completed: false },
        { text: "Measure again", completed: false },
      ]),
    });

    expect(server.requests.map((r) => r.method)).toEqual(["GET", "POST"]);
  });

  it("does not create a mission for a two-step plan", async () => {
    const lane = makeLane();
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 43,
      prompt: "Small task",
    });

    await turn.handleTodoList({
      chatId: 43,
      eventType: "item.started",
      item: todo([
        { text: "One", completed: false },
        { text: "Two", completed: false },
      ]),
    });
    await turn.handleTodoList({
      chatId: 43,
      eventType: "item.updated",
      item: todo([
        { text: "One", completed: true },
        { text: "Two", completed: false },
        { text: "A later third step", completed: false },
      ]),
    });

    expect(server.requests).toEqual([]);
  });

  it("ignores todo updates and finalization from an older overlapping turn", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(201, { current: 0, total: 3 }) },
    );
    const lane = makeLane(10_000);
    const items = [
      { text: "First", completed: false },
      { text: "Second", completed: false },
      { text: "Third", completed: false },
    ];
    const olderTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 53,
      prompt: "Older turn",
    });
    await olderTurn.handleTodoList({
      chatId: 53,
      eventType: "item.started",
      item: todo(items),
    });

    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: mission(201, { current: 0, total: 3 }) },
    );
    const newerTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 53,
      prompt: "Newer turn",
    });
    await newerTurn.handleTodoList({
      chatId: 53,
      eventType: "item.started",
      item: todo(items, "todo-2"),
    });

    await olderTurn.handleTodoList({
      chatId: 53,
      eventType: "item.updated",
      item: todo([
        { text: "First", completed: true },
        { text: "Second", completed: true },
        { text: "Third", completed: false },
      ]),
    });
    await olderTurn.finalizeTurn({
      chatId: 53,
      finalText: "Older summary",
    });
    expect(server.requests.filter((request) => request.method === "PATCH"))
      .toHaveLength(0);

    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/201/progress",
      200,
      { ok: true, mission: mission(201, { current: 1, total: 3 }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/201/complete",
      200,
      { ok: true, mission: mission(201, { current: 1, total: 3 }) },
    );
    await newerTurn.handleTodoList({
      chatId: 53,
      eventType: "item.updated",
      item: todo([
        { text: "First", completed: true },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });
    await newerTurn.finalizeTurn({
      chatId: 53,
      finalText: "Newer summary",
    });

    const patches = server.requests.filter(
      (request) => request.method === "PATCH",
    );
    expect(patches.map((request) => request.body)).toEqual([
      {
        progress: { current: 1, total: 3 },
        feedEntry: { kind: "worked", text: "First" },
      },
      { summary: "Newer summary" },
    ]);
  });

  it("waits for an older in-flight finalizer across rapid replacement turns", async () => {
    const olderTerminal = deferred<ReturnType<typeof mission>>();
    const getActiveMission = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mission(401, { current: 0, total: 3 }));
    const createMission = vi
      .fn()
      .mockResolvedValueOnce(mission(401, { current: 0, total: 3 }))
      .mockResolvedValueOnce(mission(402, { current: 0, total: 3 }));
    const patchMissionProgress = vi
      .fn()
      .mockResolvedValue(mission(402, { current: 1, total: 3 }));
    const completeMission = vi
      .fn()
      .mockReturnValueOnce(olderTerminal.promise)
      .mockResolvedValueOnce(mission(402, { current: 1, total: 3 }));
    const api = {
      getActiveMission,
      createMission,
      patchMissionProgress,
      completeMission,
      failMission: vi.fn(),
    } as unknown as BgosApi;
    const lane = new MissionLane(api, { debounceMs: 0 });
    lanes.push(lane);
    const items = [
      { text: "First", completed: false },
      { text: "Second", completed: false },
      { text: "Third", completed: false },
    ];
    const olderTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 57,
      prompt: "Older plan",
    });
    await olderTurn.handleTodoList({
      chatId: 57,
      eventType: "item.started",
      item: todo(items),
    });

    const olderFinalizing = olderTurn.finalizeTurn({
      chatId: 57,
      finalText: "Older summary",
    });
    await vi.waitFor(() => {
      expect(completeMission).toHaveBeenCalledTimes(1);
    });
    startTurn(lane, {
      assistantId: 7,
      chatId: 57,
      prompt: "Intermediate turn",
    });
    const newerTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 57,
      prompt: "Newer plan",
    });
    const newerAttaching = newerTurn.handleTodoList({
      chatId: 57,
      eventType: "item.started",
      item: todo(items, "todo-2"),
    });
    expect(getActiveMission).toHaveBeenCalledTimes(1);
    expect(createMission).toHaveBeenCalledTimes(1);

    olderTerminal.resolve(mission(401, { current: 0, total: 3 }));
    await Promise.all([olderFinalizing, newerAttaching]);
    expect(getActiveMission).toHaveBeenCalledTimes(2);
    expect(createMission).toHaveBeenCalledTimes(2);

    await newerTurn.handleTodoList({
      chatId: 57,
      eventType: "item.updated",
      item: todo([
        { text: "First", completed: true },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });
    await newerTurn.finalizeTurn({
      chatId: 57,
      finalText: "Newer summary",
    });

    expect(
      completeMission.mock.calls.map((call) => call[1]),
    ).toEqual([401, 402]);
    expect(patchMissionProgress.mock.calls[0]?.[1]).toBe(402);
  });

  it("swallows an active lookup failure without replacing an unknown mission", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      500,
      { message: "temporarily unavailable" },
    );
    const lane = makeLane();
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 52,
      prompt: "Long task",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await turn.handleTodoList({
      chatId: 52,
      eventType: "item.started",
      item: todo([
        { text: "One", completed: false },
        { text: "Two", completed: false },
        { text: "Three", completed: false },
      ]),
    });
    warn.mockRestore();

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.method).toBe("GET");
  });

  it("coalesces rapid updates into one progress PATCH with the latest worked step", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(102, { current: 0, total: 3, label: "steps" }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/102/progress",
      200,
      { ok: true, mission: mission(102, { current: 2, total: 3 }) },
    );
    const lane = makeLane(100);
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 44,
      prompt: "Long task",
    });
    await turn.handleTodoList({
      chatId: 44,
      eventType: "item.started",
      item: todo([
        { text: "First step", completed: false },
        { text: "Second step", completed: false },
        { text: "Third step", completed: false },
      ]),
    });

    await turn.handleTodoList({
      chatId: 44,
      eventType: "item.updated",
      item: todo([
        { text: "First step", completed: true },
        { text: "Second step", completed: false },
        { text: "Third step", completed: false },
      ]),
    });
    await turn.handleTodoList({
      chatId: 44,
      eventType: "item.updated",
      item: todo([
        { text: "First step", completed: true },
        { text: "Second step", completed: true },
        { text: "Third step", completed: false },
      ]),
    });
    const progressPatches = () => server.requests.filter(
      (r) => r.method === "PATCH" && r.url.endsWith("/missions/102/progress"),
    );
    await expect
      .poll(() => progressPatches().length, {
        timeout: 2_000,
        interval: 20,
      })
      .toBe(1);
    const stableSince = Date.now();
    await expect
      .poll(
        () =>
          progressPatches().length === 1 &&
          Date.now() - stableSince >= 250,
        { timeout: 750, interval: 20 },
      )
      .toBe(true);

    const patches = progressPatches();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({
      progress: { current: 2, total: 3 },
      feedEntry: { kind: "worked", text: "Second step" },
    });
  }, 10_000);

  it("drains updates received during a progress PATCH before completion", async () => {
    const firstPatch = deferred<ReturnType<typeof mission>>();
    const secondPatch = deferred<ReturnType<typeof mission>>();
    const patchMissionProgress = vi
      .fn()
      .mockReturnValueOnce(firstPatch.promise)
      .mockReturnValueOnce(secondPatch.promise);
    const completeMission = vi
      .fn()
      .mockResolvedValue(mission(202, { current: 2, total: 3 }));
    const api = {
      getActiveMission: vi.fn().mockResolvedValue(null),
      createMission: vi
        .fn()
        .mockResolvedValue(mission(202, { current: 0, total: 3 })),
      patchMissionProgress,
      completeMission,
      failMission: vi.fn(),
    } as unknown as BgosApi;
    const lane = new MissionLane(api, { debounceMs: 0 });
    lanes.push(lane);
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 54,
      prompt: "Concurrent progress",
    });
    await turn.handleTodoList({
      chatId: 54,
      eventType: "item.started",
      item: todo([
        { text: "First", completed: false },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });

    const firstUpdate = turn.handleTodoList({
      chatId: 54,
      eventType: "item.updated",
      item: todo([
        { text: "First", completed: true },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });
    await vi.waitFor(() => {
      expect(patchMissionProgress).toHaveBeenCalledTimes(1);
    });

    const secondUpdate = turn.handleTodoList({
      chatId: 54,
      eventType: "item.updated",
      item: todo([
        { text: "First", completed: true },
        { text: "Second", completed: true },
        { text: "Third", completed: false },
      ]),
    });
    const finalizing = turn.finalizeTurn({
      chatId: 54,
      finalText: "All done",
    });
    expect(completeMission).not.toHaveBeenCalled();

    firstPatch.resolve(mission(202, { current: 1, total: 3 }));
    await vi.waitFor(() => {
      expect(patchMissionProgress).toHaveBeenCalledTimes(2);
    });
    expect(completeMission).not.toHaveBeenCalled();

    secondPatch.resolve(mission(202, { current: 2, total: 3 }));
    await Promise.all([firstUpdate, secondUpdate, finalizing]);

    expect(
      patchMissionProgress.mock.calls.map((call) => call[2]),
    ).toEqual([
      {
        progress: { current: 1, total: 3 },
        feedEntry: { kind: "worked", text: "First" },
      },
      {
        progress: { current: 2, total: 3 },
        feedEntry: { kind: "worked", text: "Second" },
      },
    ]);
    expect(completeMission).toHaveBeenCalledTimes(1);
    expect(patchMissionProgress.mock.invocationCallOrder[1]).toBeLessThan(
      completeMission.mock.invocationCallOrder[0]!,
    );
  });

  it("flushes pending progress before completing with a word-boundary summary", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(103, { current: 0, total: 3, label: "steps" }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/103/progress",
      200,
      { ok: true, mission: mission(103, { current: 1, total: 3 }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/103/complete",
      200,
      { ok: true, mission: { ...mission(103, { current: 1, total: 3 }), status: "completed" } },
    );
    const lane = makeLane(10_000);
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 45,
      prompt: "Finish task",
    });
    await turn.handleTodoList({
      chatId: 45,
      eventType: "item.started",
      item: todo([
        { text: "First", completed: false },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });
    await turn.handleTodoList({
      chatId: 45,
      eventType: "item.updated",
      item: todo([
        { text: "First", completed: true },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });

    const finalText = "word ".repeat(125) + "tail";
    await turn.finalizeTurn({ chatId: 45, finalText });

    const patches = server.requests.filter((r) => r.method === "PATCH");
    expect(patches.map((r) => r.url)).toEqual([
      "/api/v1/integrations/assistants/7/missions/103/progress",
      "/api/v1/integrations/assistants/7/missions/103/complete",
    ]);
    const expectedSummary = "word ".repeat(99) + "word";
    expect((patches[1]!.body as { summary: string }).summary).toBe(
      expectedSummary,
    );
    expect(expectedSummary.length).toBeLessThanOrEqual(500);
  });

  it("skips progress PATCHes for an empty plan snapshot", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(203, { current: 0, total: 3 }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/203/complete",
      200,
      { ok: true, mission: mission(203, { current: 0, total: 3 }) },
    );
    const lane = makeLane(0);
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 55,
      prompt: "Plan may disappear",
    });
    await turn.handleTodoList({
      chatId: 55,
      eventType: "item.started",
      item: todo([
        { text: "First", completed: false },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });
    await turn.handleTodoList({
      chatId: 55,
      eventType: "item.updated",
      item: todo([]),
    });
    await turn.finalizeTurn({ chatId: 55, finalText: "Done" });

    expect(
      server.requests.filter((request) =>
        request.url.endsWith("/missions/203/progress"),
      ),
    ).toHaveLength(0);
    expect(
      server.requests.filter((request) =>
        request.url.endsWith("/missions/203/complete"),
      ),
    ).toHaveLength(1);
  });

  it("detects newly completed work by item text across plan reshaping", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(204, { current: 2, total: 3 }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/204/progress",
      200,
      { ok: true, mission: mission(204, { current: 2, total: 2 }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/204/progress",
      200,
      { ok: true, mission: mission(204, { current: 3, total: 3 }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/204/complete",
      200,
      { ok: true, mission: mission(204, { current: 3, total: 3 }) },
    );
    const lane = makeLane(0);
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 56,
      prompt: "Reshape plan",
    });
    await turn.handleTodoList({
      chatId: 56,
      eventType: "item.started",
      item: todo([
        { text: "One", completed: false },
        { text: "Two", completed: true },
        { text: "Three", completed: true },
      ]),
    });
    await turn.handleTodoList({
      chatId: 56,
      eventType: "item.updated",
      item: todo([
        { text: "Three", completed: true },
        { text: "Two", completed: true },
      ]),
    });
    await turn.handleTodoList({
      chatId: 56,
      eventType: "item.updated",
      item: todo([
        { text: "Two", completed: true },
        { text: "Three", completed: true },
        { text: "One", completed: true },
      ]),
    });
    await turn.finalizeTurn({ chatId: 56, finalText: "Done" });

    const progress = server.requests.filter((request) =>
      request.url.endsWith("/missions/204/progress"),
    );
    expect(progress.map((request) => request.body)).toEqual([
      { progress: { current: 2, total: 2 } },
      {
        progress: { current: 3, total: 3 },
        feedEntry: { kind: "worked", text: "One" },
      },
    ]);
  });

  it("does not complete when the turn did not create a mission", async () => {
    const lane = makeLane();
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 46,
      prompt: "Small task",
    });
    await turn.handleTodoList({
      chatId: 46,
      eventType: "item.started",
      item: todo([
        { text: "One", completed: false },
        { text: "Two", completed: false },
      ]),
    });

    await turn.finalizeTurn({ chatId: 46, finalText: "Done." });

    expect(server.requests).toEqual([]);
  });

  it("fails a created mission with the short error summary", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(104, { current: 0, total: 3, label: "steps" }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/104/fail",
      500,
      { message: "temporarily unavailable" },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/104/fail",
      200,
      { ok: true, mission: { ...mission(104, { current: 0, total: 3 }), status: "failed" } },
    );
    const lane = makeLane();
    const turn = startTurn(lane, {
      assistantId: 7,
      chatId: 47,
      prompt: "Risky task",
    });
    await turn.handleTodoList({
      chatId: 47,
      eventType: "item.started",
      item: todo([
        { text: "One", completed: false },
        { text: "Two", completed: false },
        { text: "Three", completed: false },
      ]),
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await turn.finalizeTurn({
      chatId: 47,
      error: "  network\n exploded  ",
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();

    const failed = server.requests.filter((r) =>
      r.url.endsWith("/missions/104/fail"),
    );
    expect(failed).toHaveLength(2);
    expect(failed.map((request) => request.body)).toEqual([
      { summary: "network exploded" },
      { summary: "network exploded" },
    ]);
  });

  it("fails every managed mission when disposed", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(301, { current: 0, total: 3 }) },
    );
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/8/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/8/missions",
      201,
      { ok: true, mission: mission(302, { current: 0, total: 3 }) },
    );
    const lane = makeLane();
    const items = [
      { text: "One", completed: false },
      { text: "Two", completed: false },
      { text: "Three", completed: false },
    ];
    const firstTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 70,
      prompt: "First managed plan",
    });
    const secondTurn = startTurn(lane, {
      assistantId: 8,
      chatId: 71,
      prompt: "Second managed plan",
    });
    await firstTurn.handleTodoList({
      chatId: 70,
      eventType: "item.started",
      item: todo(items),
    });
    await secondTurn.handleTodoList({
      chatId: 71,
      eventType: "item.started",
      item: todo(items, "todo-2"),
    });
    startTurn(lane, {
      assistantId: 7,
      chatId: 70,
      prompt: "Replacement turn without a plan",
    });
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/301/fail",
      500,
      { message: "shutdown failure" },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/8/missions/302/fail",
      200,
      { ok: true, mission: mission(302, { current: 0, total: 3 }) },
    );

    const failMission = vi.spyOn(BgosApi.prototype, "failMission");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await lane.dispose();
    const failOptions = failMission.mock.calls.map((call) => call[3]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    failMission.mockRestore();

    const failed = server.requests.filter(
      (request) =>
        request.method === "PATCH" && request.url.endsWith("/fail"),
    );
    expect(failed.map((request) => request.url).sort()).toEqual([
      "/api/v1/integrations/assistants/7/missions/301/fail",
      "/api/v1/integrations/assistants/8/missions/302/fail",
    ]);
    expect(failed.map((request) => request.body)).toEqual([
      { summary: "Daemon stopped before the plan finished" },
      { summary: "Daemon stopped before the plan finished" },
    ]);
    expect(failOptions).toEqual([
      { timeout: 3_000 },
      { timeout: 3_000 },
    ]);
  });

  it("adopts only a process-owned mission stored for the same chat", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(107, { current: 0, total: 3, label: "steps" }) },
    );
    const lane = makeLane();
    const items = [
      { text: "One", completed: false },
      { text: "Two", completed: false },
      { text: "Three", completed: false },
    ];
    const originalTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 49,
      prompt: "Original plan",
    });
    await originalTurn.handleTodoList({
      chatId: 49,
      eventType: "item.started",
      item: todo(items),
    });
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/107/complete",
      500,
      { message: "temporarily unavailable" },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/107/complete",
      500,
      { message: "still unavailable" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await originalTurn.finalizeTurn({ chatId: 49, finalText: "Done." });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    const completeAttempts = server.requests.filter((request) =>
      request.url.endsWith("/missions/107/complete"),
    );
    expect(completeAttempts).toHaveLength(2);
    expect(completeAttempts.map((request) => request.body)).toEqual([
      { summary: "Done." },
      { summary: "Done." },
    ]);

    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: mission(107, { current: 0, total: 3, label: "steps" }) },
    );
    const continuedTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 49,
      prompt: "Continue plan",
    });
    await continuedTurn.handleTodoList({
      chatId: 49,
      eventType: "item.started",
      item: todo(items, "todo-2"),
    });
    expect(
      server.requests.filter(
        (r) => r.method === "POST" && r.url.endsWith("/missions"),
      ),
    ).toHaveLength(1);

    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: mission(107, { current: 0, total: 3, label: "steps" }) },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(108, { current: 0, total: 3, label: "steps" }) },
    );
    const otherChatTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 50,
      prompt: "Other chat plan",
    });
    await otherChatTurn.handleTodoList({
      chatId: 50,
      eventType: "item.started",
      item: todo(items, "todo-3"),
    });

    const creates = server.requests.filter(
      (r) => r.method === "POST" && r.url.endsWith("/missions"),
    );
    expect(creates).toHaveLength(2);
    expect(creates[1]!.body).toMatchObject({ title: "Other chat plan" });
  });

  it("clears a stale mission after a progress 404 so the next plan creates again", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(105, { current: 0, total: 3, label: "steps" }) },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/105/progress",
      404,
      { message: "mission not found" },
    );
    const lane = makeLane(0);
    const firstTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 48,
      prompt: "First plan",
    });
    const initial = [
      { text: "One", completed: false },
      { text: "Two", completed: false },
      { text: "Three", completed: false },
    ];
    await firstTurn.handleTodoList({
      chatId: 48,
      eventType: "item.started",
      item: todo(initial),
    });
    await firstTurn.handleTodoList({
      chatId: 48,
      eventType: "item.updated",
      item: todo([{ text: "One", completed: true }, ...initial.slice(1)]),
    });
    await firstTurn.finalizeTurn({ chatId: 48, finalText: "Done." });

    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(106, { current: 0, total: 3, label: "steps" }) },
    );
    const secondTurn = startTurn(lane, {
      assistantId: 7,
      chatId: 48,
      prompt: "Second plan",
    });
    await secondTurn.handleTodoList({
      chatId: 48,
      eventType: "item.started",
      item: todo(initial, "todo-2"),
    });

    const creates = server.requests.filter(
      (r) => r.method === "POST" && r.url.endsWith("/missions"),
    );
    expect(creates).toHaveLength(2);
    expect(creates[1]!.body).toMatchObject({ title: "Second plan" });
    expect(
      server.requests.some((r) => r.url.endsWith("/missions/105/complete")),
    ).toBe(false);
  });
});

describe("MissionLane per chat scope and owner controls (stage 5)", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  const lanes: MissionLane[] = [];

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const current = lanes.splice(0);
    try {
      await Promise.all(current.map((lane) => lane.dispose()));
    } finally {
      await server.stop();
    }
  });

  function makeLane(debounceMs = 0): MissionLane {
    const lane = new MissionLane(makeApi(baseUrl), { debounceMs });
    lanes.push(lane);
    return lane;
  }

  const steps = [
    { text: "One", completed: false },
    { text: "Two", completed: false },
    { text: "Three", completed: false },
  ];

  function stageCreate(
    assistantId: number,
    missionId: number,
    body: Record<string, unknown> = {},
  ) {
    server.stage(
      "GET",
      `/api/v1/integrations/assistants/${assistantId}/missions/active`,
      200,
      { mission: null },
    );
    server.stage(
      "POST",
      `/api/v1/integrations/assistants/${assistantId}/missions`,
      201,
      {
        ok: true,
        mission: {
          id: missionId,
          assistantId,
          title: "Plan",
          status: "active",
          origin: "derived",
          progress: { current: 0, total: 3, label: "steps" },
          ...body,
        },
      },
    );
  }

  async function attach(lane: MissionLane, chatId: number, prompt: string) {
    const turn = startTurn(lane, { assistantId: 7, chatId, prompt });
    await turn.handleTodoList({
      chatId,
      eventType: "item.started",
      item: todo(steps, `todo-${chatId}`),
    });
    return turn;
  }

  function progressPatches(missionId: number) {
    return server.requests.filter(
      (r) => r.method === "PATCH" && r.url.endsWith(`/missions/${missionId}/progress`),
    );
  }

  it("sends the chat on the create body and on the active read", async () => {
    stageCreate(7, 301, { chatId: 42 });
    const lane = makeLane();
    await attach(lane, 42, "First plan");

    const active = server.requests.find((r) => r.method === "GET")!;
    expect(active.url).toContain("chatId=42");
    const create = server.requests.find((r) => r.method === "POST")!;
    expect(create.body).toMatchObject({ chatId: 42, title: "First plan" });
  });

  it("keeps a second chat's tracking when the backend echoes a chatId", async () => {
    stageCreate(7, 301, { chatId: 42 });
    const lane = makeLane();
    const first = await attach(lane, 42, "Chat A plan");

    stageCreate(7, 302, { chatId: 43 });
    await attach(lane, 43, "Chat B plan");

    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/progress", 200, {
      ok: true,
    });
    await first.handleTodoList({
      chatId: 42,
      eventType: "item.updated",
      item: todo([{ text: "One", completed: true }, ...steps.slice(1)], "todo-42"),
    });
    expect(progressPatches(301)).toHaveLength(1);
  });

  it("still evicts the other chat when the backend echoes no chatId", async () => {
    stageCreate(7, 301);
    const lane = makeLane();
    const first = await attach(lane, 42, "Chat A plan");

    stageCreate(7, 302);
    await attach(lane, 43, "Chat B plan");

    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/progress", 200, {
      ok: true,
    });
    await first.handleTodoList({
      chatId: 42,
      eventType: "item.updated",
      item: todo([{ text: "One", completed: true }, ...steps.slice(1)], "todo-42"),
    });
    expect(progressPatches(301)).toHaveLength(0);
  });

  it("refuses to adopt an open mission that belongs to another chat", async () => {
    stageCreate(7, 301, { chatId: 42 });
    const lane = makeLane();
    // The mission stays tracked: this chat created it and still holds it, so
    // every OTHER adopt condition is satisfied and only the chat can refuse.
    await attach(lane, 42, "Chat A plan");

    server.stage("GET", "/api/v1/integrations/assistants/7/missions/active", 200, {
      mission: {
        id: 301,
        assistantId: 7,
        chatId: 99,
        title: "Plan",
        status: "active",
        origin: "derived",
        progress: { current: 0, total: 3, label: "steps" },
      },
    });
    server.stage("POST", "/api/v1/integrations/assistants/7/missions", 201, {
      ok: true,
      mission: { id: 303, assistantId: 7, chatId: 42, title: "Plan", status: "active", origin: "derived", progress: null },
    });
    await attach(lane, 42, "Chat A second plan");

    const creates = server.requests.filter(
      (r) => r.method === "POST" && r.url.endsWith("/missions"),
    );
    expect(creates).toHaveLength(2);
    expect(creates[1]!.body).toMatchObject({ title: "Chat A second plan", chatId: 42 });
  });

  it("stamps a self write BEFORE its own complete goes out, so a racing frame is still ours", async () => {
    // The gateway emits mission_completed from inside the request that closes
    // the mission, so the frame can reach this daemon before the PATCH
    // response does. Stamped after the response, that frame would be read as
    // the OWNER marking the mission done and the model would be told a lie.
    // How many requests the server had already seen at each stamp.
    const stampedAfter: number[] = [];
    const lane = new MissionLane(makeApi(baseUrl), {
      debounceMs: 0,
      onSelfWrite: (missionId) => {
        expect(missionId).toBe(401);
        stampedAfter.push(server.requests.length);
      },
    });
    lanes.push(lane);
    server.stage("GET", "/api/v1/integrations/assistants/7/missions/active", 200, {
      mission: null,
    });
    server.stage("POST", "/api/v1/integrations/assistants/7/missions", 201, {
      ok: true,
      mission: { id: 401, assistantId: 7, chatId: 42, title: "Plan", status: "active", origin: "derived", progress: null },
    });
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/401/complete", 200, {
      ok: true,
      mission: { id: 401 },
    });

    const turn = startTurn(lane, { assistantId: 7, chatId: 42, prompt: "Chat A plan" });
    await turn.handleTodoList({
      chatId: 42,
      eventType: "item.started",
      item: todo(steps, "todo-42"),
    });
    await turn.finalizeTurn({ chatId: 42, finalText: "Done." });

    const completeIndex = server.requests.findIndex((r) =>
      r.url.endsWith("/missions/401/complete"),
    );
    expect(completeIndex).toBeGreaterThanOrEqual(0);
    // ONE stamp, for the close and nothing else. It was taken while the
    // server had not yet seen the complete, which is the whole point: the
    // frame that races the response finds the stamp already there.
    expect(stampedAfter).toHaveLength(1);
    expect(stampedAfter[0]).toBe(completeIndex);
  });

  it("does NOT stamp its own create, because that stamp could only arrive late", async () => {
    // The id exists only once the response is back, while the gateway emits
    // mission_created from inside that request. A stamp taken after it is an
    // orphan: it answers for no frame of its own and then waits to be eaten
    // by the owner's next Set aside of the same mission. It would buy
    // nothing even if it won the race, because mission_created carries
    // createdByAssistant and the control lane already skips on that.
    const stamped: number[] = [];
    const lane = new MissionLane(makeApi(baseUrl), {
      debounceMs: 0,
      onSelfWrite: (missionId) => stamped.push(missionId),
    });
    lanes.push(lane);
    stageCreate(7, 501, { chatId: 42 });
    await attach(lane, 42, "Chat A plan");
    expect(stamped).toEqual([]);
  });

  it("noteClosed during a turn means no complete and no fail at the end", async () => {
    stageCreate(7, 301, { chatId: 42 });
    const lane = makeLane();
    const turn = await attach(lane, 42, "Chat A plan");

    lane.noteClosed(301);
    await turn.finalizeTurn({ chatId: 42, finalText: "All done." });

    expect(server.requests.some((r) => r.url.endsWith("/missions/301/complete"))).toBe(false);
    expect(server.requests.some((r) => r.url.endsWith("/missions/301/fail"))).toBe(false);
  });

  it("notePaused holds progress and leaves the mission open at turn end", async () => {
    stageCreate(7, 301, { chatId: 42 });
    const lane = makeLane();
    const turn = await attach(lane, 42, "Chat A plan");

    lane.notePaused(301);
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/progress", 200, {
      ok: true,
    });
    await turn.handleTodoList({
      chatId: 42,
      eventType: "item.updated",
      item: todo([{ text: "One", completed: true }, ...steps.slice(1)], "todo-42"),
    });
    expect(progressPatches(301)).toHaveLength(0);

    await turn.finalizeTurn({ chatId: 42, finalText: "Stopped here." });
    expect(server.requests.some((r) => r.url.endsWith("/missions/301/complete"))).toBe(false);
    expect(server.requests.some((r) => r.url.endsWith("/missions/301/fail"))).toBe(false);
  });

  it("noteResumed flushes the snapshot the pause held back", async () => {
    stageCreate(7, 301, { chatId: 42 });
    const lane = makeLane();
    const turn = await attach(lane, 42, "Chat A plan");

    lane.notePaused(301);
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/progress", 200, {
      ok: true,
    });
    await turn.handleTodoList({
      chatId: 42,
      eventType: "item.updated",
      item: todo([{ text: "One", completed: true }, ...steps.slice(1)], "todo-42"),
    });
    expect(progressPatches(301)).toHaveLength(0);

    lane.noteResumed(301);
    await vi.waitFor(() => expect(progressPatches(301)).toHaveLength(1));
    expect(progressPatches(301)[0]!.body).toMatchObject({
      progress: { current: 1, total: 3 },
    });
  });
});

/**
 * An owner Stop pauses the chat's open mission, and never fails it (P6 stage
 * 3, C-32, spec 4.2 and section 10).
 *
 * Before this stage the abort of an owner Stop unwound into finalizeTurn with
 * an error, and the card read Did not finish. Now the adapter reads the
 * abort's cause first and hands an owner Stop to stoppedByOwner, which pauses
 * with the contract's reason; the owner's next message in that chat resumes
 * exactly that pause and nothing else. A daemon restart keeps the promise:
 * the first owner turn in a chat asks the server once, and dispose leaves a
 * paused mission paused.
 */
describe("MissionLane: an owner Stop pauses, never fails (P6 stage 3)", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  const lanes: MissionLane[] = [];

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const current = lanes.splice(0);
    try {
      await Promise.all(current.map((lane) => lane.dispose()));
    } finally {
      await server.stop();
    }
  });

  const steps = [
    { text: "One", completed: false },
    { text: "Two", completed: false },
    { text: "Three", completed: false },
  ];
  const oneDone = [{ text: "One", completed: true }, ...steps.slice(1)];

  function lane(options: MissionLaneOptions = {}, api = makeApi(baseUrl)): MissionLane {
    const made = new MissionLane(api, { debounceMs: 0, ...options });
    lanes.push(made);
    return made;
  }

  function snapshot(
    id: number,
    status: "active" | "paused",
    extra: Record<string, unknown> = {},
  ) {
    return {
      id,
      assistantId: 7,
      chatId: 42,
      title: "Plan",
      status,
      origin: "derived",
      progress: { current: 0, total: 3, label: "steps" },
      ...extra,
    };
  }

  function stageCreate(missionId: number, chatId = 42) {
    server.stage("GET", "/api/v1/integrations/assistants/7/missions/active", 200, {
      mission: null,
    });
    server.stage("POST", "/api/v1/integrations/assistants/7/missions", 201, {
      ok: true,
      mission: snapshot(missionId, "active", { chatId }),
    });
  }

  function stageActive(mission: Record<string, unknown> | null) {
    server.stage("GET", "/api/v1/integrations/assistants/7/missions/active", 200, {
      mission,
    });
  }

  function stagePause(missionId: number, pausedReason: string | null = STOP_PAUSE_REASON) {
    server.stage(
      "PATCH",
      `/api/v1/integrations/assistants/7/missions/${missionId}/pause`,
      200,
      { ok: true, mission: snapshot(missionId, "paused", { pausedReason }) },
    );
  }

  function stageResume(missionId: number) {
    server.stage(
      "PATCH",
      `/api/v1/integrations/assistants/7/missions/${missionId}/resume`,
      200,
      { ok: true, mission: snapshot(missionId, "active", { pausedReason: null }) },
    );
  }

  async function attach(target: MissionLane, chatId: number, prompt: string) {
    const turn = startTurn(target, { assistantId: 7, chatId, prompt });
    await turn.handleTodoList({
      chatId,
      eventType: "item.started",
      item: todo(steps, `todo-${chatId}`),
    });
    return turn;
  }

  function hits(pattern: RegExp) {
    return server.requests.filter((r) => pattern.test(r.url.split("?")[0]!));
  }

  const creates = () =>
    server.requests.filter((r) => r.method === "POST" && r.url.endsWith("/missions"));

  it("pauses the turn's mission with the contract reason, stamped before the PATCH, and never fails it", async () => {
    const stampedAt: number[] = [];
    const target = lane({
      onSelfWrite: (missionId) => {
        expect(missionId).toBe(301);
        stampedAt.push(server.requests.length);
      },
    });
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    stagePause(301);

    target.noteStopRequested(42);
    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });

    const pause = server.requests.findIndex((r) => r.url.endsWith("/missions/301/pause"));
    expect(pause).toBeGreaterThanOrEqual(0);
    expect(server.requests[pause]!.method).toBe("PATCH");
    expect(server.requests[pause]!.body).toEqual({ reason: "Stopped by you" });
    // ONE stamp, taken while the server had not yet seen the pause: the
    // mission_paused frame that races the answer is still read as ours.
    expect(stampedAt).toEqual([pause]);
    expect(hits(/\/missions\/301\/(fail|complete)$/)).toHaveLength(0);
  });

  it("flushes the progress it was holding before it pauses", async () => {
    const target = lane({ debounceMs: 60_000 });
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/progress", 200, {
      ok: true,
      mission: snapshot(301, "active"),
    });
    await turn.handleTodoList({ chatId: 42, eventType: "item.updated", item: todo(oneDone, "todo-42") });
    expect(hits(/\/missions\/301\/progress$/)).toHaveLength(0);
    stagePause(301);

    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });

    expect(
      server.requests.filter((r) => r.method === "PATCH").map((r) => r.url.split("/").pop()),
    ).toEqual(["progress", "pause"]);
    expect(hits(/\/missions\/301\/progress$/)[0]!.body).toMatchObject({
      progress: { current: 1, total: 3 },
    });
  });

  it("still fails on a real error, even with a Stop open for the chat", async () => {
    const target = lane();
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/fail", 200, {
      ok: true,
      mission: snapshot(301, "active", { status: "failed" }),
    });

    target.noteStopRequested(42);
    await turn.finalizeTurn({ chatId: 42, error: "Connection lost" });

    expect(hits(/\/missions\/301\/fail$/).map((r) => r.body)).toEqual([
      { summary: "Connection lost" },
    ]);
    expect(hits(/\/pause$/)).toHaveLength(0);
  });

  it.each([
    ["new", "Started a new conversation before the plan finished"],
    ["shutdown", "Daemon stopped before the plan finished"],
    ["revoked", "The pairing was revoked before the plan finished"],
  ] as const)("still fails for %s, with that cause's own words", async (cause, words) => {
    const target = lane();
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/fail", 200, {
      ok: true,
      mission: snapshot(301, "active", { status: "failed" }),
    });

    const outcome = missionAbortOutcome(cause);
    expect(outcome.kind).toBe("fail");
    await turn.finalizeTurn({
      chatId: 42,
      error: outcome.kind === "fail" ? outcome.summary : null,
    });

    expect(hits(/\/missions\/301\/fail$/).map((r) => r.body)).toEqual([{ summary: words }]);
    expect(hits(/\/pause$/)).toHaveLength(0);
  });

  it("adopts its own derived mission while it is paused, rather than making a second one", async () => {
    // The canAdopt paused branch, untested before this stage. A turn nobody
    // typed (a wake) runs after a Stop paused the chat's mission: its plan
    // lands on that mission, not on a new one, and writes nothing to it while
    // it is paused, and its end closes nothing.
    const target = lane();
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    stagePause(301);
    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });

    stageActive(snapshot(301, "paused", { pausedReason: STOP_PAUSE_REASON }));
    const wake = startTurn(target, { assistantId: 7, chatId: 42, prompt: "Scheduled check" });
    await wake.handleTodoList({ chatId: 42, eventType: "item.started", item: todo(steps, "todo-wake") });
    await wake.handleTodoList({ chatId: 42, eventType: "item.updated", item: todo(oneDone, "todo-wake") });
    await wake.finalizeTurn({ chatId: 42, finalText: "Checked." });

    expect(creates()).toHaveLength(1);
    expect(hits(/\/missions\/301\/progress$/)).toHaveLength(0);
    expect(hits(/\/missions\/301\/(fail|complete|resume)$/)).toHaveLength(0);
  });

  it("resumes, on the owner's next turn, the mission its own Stop paused, stamped before the PATCH", async () => {
    const stamps: string[] = [];
    const target = lane({
      onSelfWrite: (missionId) => stamps.push(`${missionId}@${server.requests.length}`),
    });
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    stagePause(301);
    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });

    stageActive(snapshot(301, "paused", { pausedReason: STOP_PAUSE_REASON }));
    stageResume(301);
    await target.noteOwnerTurn(42, 7);

    const resume = server.requests.findIndex((r) => r.url.endsWith("/missions/301/resume"));
    expect(resume).toBeGreaterThanOrEqual(0);
    expect(server.requests[resume]!.method).toBe("PATCH");
    expect(stamps.at(-1)).toBe(`301@${resume}`);

    // Writing continues: the owner's turn adopts the same mission and its
    // progress goes out, because the lane no longer holds it as paused.
    stageActive(snapshot(301, "active"));
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/progress", 200, {
      ok: true,
      mission: snapshot(301, "active"),
    });
    const next = startTurn(target, {
      assistantId: 7,
      chatId: 42,
      prompt: "Continue from where you stopped.",
    });
    await next.handleTodoList({ chatId: 42, eventType: "item.started", item: todo(steps, "todo-next") });
    await next.handleTodoList({ chatId: 42, eventType: "item.updated", item: todo(oneDone, "todo-next") });
    expect(creates()).toHaveLength(1);
    expect(hits(/\/missions\/301\/progress$/)).toHaveLength(1);
  });

  it("leaves an owner's own Pause alone when the lane already knew of it: no pause write, no resume", async () => {
    const target = lane();
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    // The owner paused it in the Mission view; the frame reached the lane.
    target.notePaused(301);

    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });
    expect(hits(/\/pause$/)).toHaveLength(0);

    stageActive(snapshot(301, "paused", { pausedReason: null }));
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/resume$/)).toHaveLength(0);
  });

  it("leaves an owner's own Pause alone when the server answers with their reason", async () => {
    const target = lane();
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    // The owner's Pause landed on the server a moment before the Stop and
    // its frame has not arrived: the server answers UNCHANGED, reason null.
    stagePause(301, null);
    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });
    expect(hits(/\/missions\/301\/pause$/)).toHaveLength(1);

    stageActive(snapshot(301, "paused", { pausedReason: null }));
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/resume$/)).toHaveLength(0);
  });

  it("never resumes a mission paused with any reason but the exact contract one", async () => {
    const target = lane();
    for (const pausedReason of ["Waiting for the invoice", "stopped by you", "Stopped by you."]) {
      stageActive(snapshot(301, "paused", { pausedReason }));
      // A fresh chat each time, so the first owner turn reads the server.
      await target.noteOwnerTurn(40 + pausedReason.length, 7);
    }
    expect(hits(/\/missions\/active$/)).toHaveLength(3);
    expect(hits(/\/resume$/)).toHaveLength(0);
  });

  it("a Resume that races the Stop's own pause waits for it, so the mission ends active", async () => {
    const api = makeApi(baseUrl);
    const gate = deferred<void>();
    const realPause = api.pauseMission.bind(api);
    vi.spyOn(api, "pauseMission").mockImplementation(async (...args) => {
      await gate.promise;
      return realPause(...args);
    });
    const target = lane({}, api);
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    const before = server.requests.length;
    stagePause(301);
    stageActive(snapshot(301, "paused", { pausedReason: STOP_PAUSE_REASON }));
    stageResume(301);

    target.noteStopRequested(42);
    const stopping = target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });
    const owner = target.noteOwnerTurn(42, 7);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Nothing of the owner's turn went out while the pause was still open.
    expect(server.requests.length).toBe(before);
    gate.resolve();
    await Promise.all([stopping, owner]);

    expect(
      server.requests
        .slice(before)
        .map((r) => `${r.method} ${r.url.split("?")[0]!.split("/").pop()}`),
    ).toEqual(["PATCH pause", "GET active", "PATCH resume"]);
  });

  it("after a restart, the first owner turn reads the chat once, resumes a Stop pause and adopts it", async () => {
    // A fresh lane is a daemon that just started: no memory of the Stop.
    const target = lane();
    stageActive(snapshot(301, "paused", { pausedReason: STOP_PAUSE_REASON }));
    stageResume(301);
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/missions\/301\/resume$/)).toHaveLength(1);

    // The derived mission is this lane's own again, so the plan adopts it.
    stageActive(snapshot(301, "active"));
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/progress", 200, {
      ok: true,
      mission: snapshot(301, "active"),
    });
    const turn = startTurn(target, {
      assistantId: 7,
      chatId: 42,
      prompt: "Continue from where you stopped.",
    });
    await turn.handleTodoList({ chatId: 42, eventType: "item.started", item: todo(steps, "todo-r") });
    await turn.handleTodoList({ chatId: 42, eventType: "item.updated", item: todo(oneDone, "todo-r") });
    expect(creates()).toHaveLength(0);
    expect(hits(/\/missions\/301\/progress$/)).toHaveLength(1);

    // Once per chat per process: the next owner turn asks nothing.
    const reads = hits(/\/missions\/active$/).length;
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/missions\/active$/)).toHaveLength(reads);
  });

  it("dispose leaves a paused mission paused, and still fails a mission whose turn was running", async () => {
    const target = lane();
    stageCreate(301, 42);
    const stopped = await attach(target, 42, "Chat A plan");
    stagePause(301);
    await target.stoppedByOwner({ chatId: 42, turnToken: stopped.turnToken, assistantId: 7 });

    stageCreate(302, 43);
    await attach(target, 43, "Chat B plan");
    stageCreate(303, 44);
    await attach(target, 44, "Chat C plan");
    // The owner paused chat C's mission from the Mission view.
    target.notePaused(303);

    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/302/fail", 200, {
      ok: true,
      mission: snapshot(302, "active", { status: "failed" }),
    });
    await target.dispose();

    expect(hits(/\/fail$/).map((r) => [r.url.split("/").at(-2), r.body])).toEqual([
      ["302", { summary: "Daemon stopped before the plan finished" }],
    ]);
  });

  it("/new forgets the chat's Stop pause, so a later message does not resume work from the discarded context", async () => {
    const target = lane();
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    stagePause(301);
    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });

    target.clearStopMarker(42);
    const before = server.requests.length;
    await target.noteOwnerTurn(42, 7);
    expect(server.requests.length).toBe(before);
  });

  it("a Stop between turns opens nothing, so the next owner turn is not held back", async () => {
    const target = lane();
    target.noteStopRequested(42);
    stageActive(null);
    const startedAt = Date.now();
    await target.noteOwnerTurn(42, 7);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(hits(/\/pause$/)).toHaveLength(0);
  });

  it("a turn that ended on its own settles an open Stop too", async () => {
    const target = lane();
    const turn = startTurn(target, { assistantId: 7, chatId: 42, prompt: "Small task" });
    target.noteStopRequested(42);
    await turn.finalizeTurn({ chatId: 42, finalText: "Done." });
    stageActive(null);
    const startedAt = Date.now();
    await target.noteOwnerTurn(42, 7);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("waits for an unsettled Stop only as long as its bound, then goes on", async () => {
    const target = lane({ stopSettleMaxMs: 50 });
    startTurn(target, { assistantId: 7, chatId: 42, prompt: "Stuck task" });
    target.noteStopRequested(42);
    stageActive(null);
    const startedAt = Date.now();
    await target.noteOwnerTurn(42, 7);
    const waited = Date.now() - startedAt;
    expect(waited).toBeGreaterThanOrEqual(45);
    expect(waited).toBeLessThan(2_000);
    expect(hits(/\/missions\/active$/)).toHaveLength(1);
  });

  it("pauses the chat's open mission from the server when the turn managed none, owner started or not", async () => {
    const target = lane();
    const turn = startTurn(target, { assistantId: 7, chatId: 42, prompt: "Keep going" });
    stageActive(snapshot(501, "active", { origin: "self_report" }));
    stagePause(501);
    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });
    expect(hits(/\/missions\/501\/pause$/).map((r) => r.body)).toEqual([
      { reason: "Stopped by you" },
    ]);

    stageActive(snapshot(501, "paused", { origin: "self_report", pausedReason: STOP_PAUSE_REASON }));
    stageResume(501);
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/missions\/501\/resume$/)).toHaveLength(1);
  });

  it("never pauses a mission that belongs to another chat, and pauses nothing when there is none", async () => {
    const target = lane();
    const other = startTurn(target, { assistantId: 7, chatId: 42, prompt: "Chat A" });
    stageActive(snapshot(601, "active", { chatId: 99 }));
    await target.stoppedByOwner({ chatId: 42, turnToken: other.turnToken, assistantId: 7 });

    const none = startTurn(target, { assistantId: 7, chatId: 43, prompt: "Chat B" });
    stageActive(null);
    await target.stoppedByOwner({ chatId: 43, turnToken: none.turnToken, assistantId: 7 });

    expect(hits(/\/pause$/)).toHaveLength(0);
  });

  it("holds the native goal locally BEFORE the pause PATCH, and gives it back on the owner's next turn", async () => {
    const order: string[] = [];
    const target = lane({
      goalOwnsChat: (chatId) => chatId === 42,
      pauseGoalForChat: async (chatId) => {
        order.push(`goal paused ${chatId} @${server.requests.length}`);
      },
      resumeGoalForMission: async (missionId) => {
        order.push(`goal resumed ${missionId} @${server.requests.length}`);
      },
    });
    const turn = startTurn(target, { assistantId: 7, chatId: 42, prompt: "Keep working" });
    stageActive(snapshot(701, "active", { keepWorking: true }));
    stagePause(701);
    await target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 });
    const pause = server.requests.findIndex((r) => r.url.endsWith("/missions/701/pause"));
    expect(order).toEqual([`goal paused 42 @${pause}`]);

    stageActive(snapshot(701, "paused", { keepWorking: true, pausedReason: STOP_PAUSE_REASON }));
    stageResume(701);
    await target.noteOwnerTurn(42, 7);
    const resume = server.requests.findIndex((r) => r.url.endsWith("/missions/701/resume"));
    expect(order).toEqual([`goal paused 42 @${pause}`, `goal resumed 701 @${resume + 1}`]);

    // A goal's mission belongs to the goal lane, which closes nothing on
    // shutdown: resuming it must not hand it to the plan lane's dispose.
    await target.dispose();
    expect(hits(/\/missions\/701\/fail$/)).toHaveLength(0);
  });

  it("a pause the server refused leaves the mission as the server has it, and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = lane();
    stageCreate(301);
    const turn = await attach(target, 42, "Ship the strip");
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/pause", 409, {
      message: "Mission 301 is completed; it cannot be paused.",
    });
    await expect(
      target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    // Not held as paused: the next plan adopts it and its progress goes out.
    stageActive(snapshot(301, "active"));
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/301/progress", 200, {
      ok: true,
      mission: snapshot(301, "active"),
    });
    const next = startTurn(target, { assistantId: 7, chatId: 42, prompt: "Next" });
    await next.handleTodoList({ chatId: 42, eventType: "item.started", item: todo(steps, "todo-n") });
    await next.handleTodoList({ chatId: 42, eventType: "item.updated", item: todo(oneDone, "todo-n") });
    expect(hits(/\/missions\/301\/progress$/)).toHaveLength(1);
    expect(hits(/\/resume$/)).toHaveLength(0);
  });

  /**
   * A goal chat whose pause PATCH fails (review F2). The goal was held
   * BEFORE the PATCH, so a failure left it held with nothing to give it
   * back: the chat was already checked, no Stop marker was recorded, and the
   * owner's next turn asked nothing. Keep working then read On it with no
   * loop running, until a restart.
   */
  function goalLane(order: string[]) {
    return lane({
      goalOwnsChat: (chatId) => chatId === 42,
      pauseGoalForChat: async (chatId) => {
        order.push(`goal paused ${chatId}`);
      },
      resumeGoalForMission: async (missionId) => {
        order.push(`goal resumed ${missionId}`);
      },
    });
  }

  async function stopWithFailedPause(target: MissionLane) {
    // An owner turn before the Stop: the chat is checked, as in a live chat.
    stageActive(snapshot(701, "active", { keepWorking: true }));
    await target.noteOwnerTurn(42, 7);
    const turn = startTurn(target, { assistantId: 7, chatId: 42, prompt: "Keep working" });
    stageActive(snapshot(701, "active", { keepWorking: true }));
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/701/pause", 502, {
      message: "Bad gateway",
    });
    await expect(
      target.stoppedByOwner({ chatId: 42, turnToken: turn.turnToken, assistantId: 7 }),
    ).resolves.toBeUndefined();
  }

  it("a failed pause in a goal chat keeps the goal held, and the owner's next turn gives it back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const order: string[] = [];
    const target = goalLane(order);
    await stopWithFailedPause(target);
    // Held, not given back at once: that would start a continuation turn
    // the moment after the owner pressed Stop.
    expect(order).toEqual(["goal paused 42"]);

    // The pause never landed: the server still has the mission active.
    stageActive(snapshot(701, "active", { keepWorking: true }));
    await target.noteOwnerTurn(42, 7);
    expect(order).toEqual(["goal paused 42", "goal resumed 701"]);
    expect(hits(/\/resume$/)).toHaveLength(0);

    // Once: the owner's following turn asks nothing more.
    const reads = hits(/\/missions\/active$/).length;
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/missions\/active$/)).toHaveLength(reads);
    expect(order).toEqual(["goal paused 42", "goal resumed 701"]);
  });

  it("a pause whose answer was lost but which landed is resumed on the owner's next turn, goal included", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const order: string[] = [];
    const target = goalLane(order);
    await stopWithFailedPause(target);

    // A timeout can land on the server after the answer is lost.
    stageActive(snapshot(701, "paused", { keepWorking: true, pausedReason: STOP_PAUSE_REASON }));
    stageResume(701);
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/missions\/701\/resume$/)).toHaveLength(1);
    expect(order).toEqual(["goal paused 42", "goal resumed 701"]);
  });

  it("after a failed pause the owner's next turn reads the chat again, and an owner's own Pause since then stands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const order: string[] = [];
    const target = goalLane(order);
    await stopWithFailedPause(target);
    const reads = hits(/\/missions\/active$/).length;

    // The owner paused it from the Mission view before writing again.
    stageActive(snapshot(701, "paused", { keepWorking: true, pausedReason: null }));
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/missions\/active$/)).toHaveLength(reads + 1);
    expect(hits(/\/resume$/)).toHaveLength(0);
    expect(order).toEqual(["goal paused 42"]);
  });

  it("an owner turn whose read fails never throws, and the next owner turn asks again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = lane();
    server.stage("GET", "/api/v1/integrations/assistants/7/missions/active", 500, {
      message: "temporarily unavailable",
    });
    await expect(target.noteOwnerTurn(42, 7)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    stageActive(snapshot(301, "paused", { pausedReason: STOP_PAUSE_REASON }));
    stageResume(301);
    await target.noteOwnerTurn(42, 7);
    expect(hits(/\/missions\/active$/)).toHaveLength(2);
    expect(hits(/\/missions\/301\/resume$/)).toHaveLength(1);
  });
});
