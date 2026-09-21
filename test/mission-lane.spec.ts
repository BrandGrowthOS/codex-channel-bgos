import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { MissionLane } from "../src/mission-lane.js";
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
