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

describe("MissionLane (Codex todo_list)", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  const lanes: MissionLane[] = [];

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    for (const lane of lanes) lane.dispose();
    lanes.length = 0;
    await server.stop();
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
    lane.beginTurn({
      assistantId: 7,
      chatId: 42,
      prompt: `  ${promptTitle}  \nThis line is not the title`,
    });

    await lane.handleTodoList({
      chatId: 42,
      eventType: "item.started",
      item: todo([
        { text: "Inventory", completed: true },
        { text: "Verify", completed: false },
        { text: "Report", completed: false },
      ]),
    });

    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/v1/integrations/assistants/7/missions/active",
      "POST /api/v1/integrations/assistants/7/missions",
    ]);
    expect(server.requests[1]!.headers["x-bgos-pairing"]).toBe(
      "pair_" + "x".repeat(30),
    );
    expect(server.requests[1]!.body).toEqual({
      title: promptTitle.slice(0, 200),
      progress: { current: 1, total: 3, label: "steps" },
      origin: "derived",
      firstFeedText: "Planned 3 steps",
    });
  });

  it("does not create a mission for a two-step plan", async () => {
    const lane = makeLane();
    lane.beginTurn({ assistantId: 7, chatId: 43, prompt: "Small task" });

    await lane.handleTodoList({
      chatId: 43,
      eventType: "item.started",
      item: todo([
        { text: "One", completed: false },
        { text: "Two", completed: false },
      ]),
    });
    await lane.handleTodoList({
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

  it("swallows an active lookup failure without replacing an unknown mission", async () => {
    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      500,
      { message: "temporarily unavailable" },
    );
    const lane = makeLane();
    lane.beginTurn({ assistantId: 7, chatId: 52, prompt: "Long task" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await lane.handleTodoList({
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
    lane.beginTurn({ assistantId: 7, chatId: 44, prompt: "Long task" });
    await lane.handleTodoList({
      chatId: 44,
      eventType: "item.started",
      item: todo([
        { text: "First step", completed: false },
        { text: "Second step", completed: false },
        { text: "Third step", completed: false },
      ]),
    });

    await lane.handleTodoList({
      chatId: 44,
      eventType: "item.updated",
      item: todo([
        { text: "First step", completed: true },
        { text: "Second step", completed: false },
        { text: "Third step", completed: false },
      ]),
    });
    await lane.handleTodoList({
      chatId: 44,
      eventType: "item.updated",
      item: todo([
        { text: "First step", completed: true },
        { text: "Second step", completed: true },
        { text: "Third step", completed: false },
      ]),
    });
    await expect
      .poll(
        () =>
          server.requests.filter(
            (r) =>
              r.method === "PATCH" &&
              r.url.endsWith("/missions/102/progress"),
          ).length,
        { timeout: 5_000, interval: 20 },
      )
      .toBe(1);

    const patches = server.requests.filter(
      (r) => r.method === "PATCH" && r.url.endsWith("/missions/102/progress"),
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({
      progress: { current: 2, total: 3 },
      feedEntry: { kind: "worked", text: "Second step" },
    });
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
    lane.beginTurn({ assistantId: 7, chatId: 45, prompt: "Finish task" });
    await lane.handleTodoList({
      chatId: 45,
      eventType: "item.started",
      item: todo([
        { text: "First", completed: false },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });
    await lane.handleTodoList({
      chatId: 45,
      eventType: "item.updated",
      item: todo([
        { text: "First", completed: true },
        { text: "Second", completed: false },
        { text: "Third", completed: false },
      ]),
    });

    const finalText = "word ".repeat(125) + "tail";
    await lane.finalizeTurn({ chatId: 45, finalText });

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

  it("does not complete when the turn did not create a mission", async () => {
    const lane = makeLane();
    lane.beginTurn({ assistantId: 7, chatId: 46, prompt: "Small task" });
    await lane.handleTodoList({
      chatId: 46,
      eventType: "item.started",
      item: todo([
        { text: "One", completed: false },
        { text: "Two", completed: false },
      ]),
    });

    await lane.finalizeTurn({ chatId: 46, finalText: "Done." });

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
      200,
      { ok: true, mission: { ...mission(104, { current: 0, total: 3 }), status: "failed" } },
    );
    const lane = makeLane();
    lane.beginTurn({ assistantId: 7, chatId: 47, prompt: "Risky task" });
    await lane.handleTodoList({
      chatId: 47,
      eventType: "item.started",
      item: todo([
        { text: "One", completed: false },
        { text: "Two", completed: false },
        { text: "Three", completed: false },
      ]),
    });

    await lane.finalizeTurn({
      chatId: 47,
      error: "  network\n exploded  ",
    });

    const failed = server.requests.find((r) => r.url.endsWith("/missions/104/fail"));
    expect(failed?.body).toEqual({ summary: "network exploded" });
  });

  it("adopts a process-owned active mission and replaces a foreign one", async () => {
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
    lane.beginTurn({ assistantId: 7, chatId: 49, prompt: "Original plan" });
    await lane.handleTodoList({
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await lane.finalizeTurn({ chatId: 49, finalText: "Done." });
    warn.mockRestore();

    server.stage(
      "GET",
      "/api/v1/integrations/assistants/7/missions/active",
      200,
      { mission: mission(107, { current: 0, total: 3, label: "steps" }) },
    );
    lane.beginTurn({ assistantId: 7, chatId: 50, prompt: "Continue plan" });
    await lane.handleTodoList({
      chatId: 50,
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
      { mission: mission(999, { current: 0, total: 3, label: "steps" }) },
    );
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: mission(108, { current: 0, total: 3, label: "steps" }) },
    );
    lane.beginTurn({ assistantId: 7, chatId: 51, prompt: "Replacement plan" });
    await lane.handleTodoList({
      chatId: 51,
      eventType: "item.started",
      item: todo(items, "todo-3"),
    });

    const creates = server.requests.filter(
      (r) => r.method === "POST" && r.url.endsWith("/missions"),
    );
    expect(creates).toHaveLength(2);
    expect(creates[1]!.body).toMatchObject({ title: "Replacement plan" });
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
    lane.beginTurn({ assistantId: 7, chatId: 48, prompt: "First plan" });
    const initial = [
      { text: "One", completed: false },
      { text: "Two", completed: false },
      { text: "Three", completed: false },
    ];
    await lane.handleTodoList({
      chatId: 48,
      eventType: "item.started",
      item: todo(initial),
    });
    await lane.handleTodoList({
      chatId: 48,
      eventType: "item.updated",
      item: todo([{ text: "One", completed: true }, ...initial.slice(1)]),
    });
    await lane.finalizeTurn({ chatId: 48, finalText: "Done." });

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
    lane.beginTurn({ assistantId: 7, chatId: 48, prompt: "Second plan" });
    await lane.handleTodoList({
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
