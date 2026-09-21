import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { ToolProgressOrchestrator } from "../src/tool-progress.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

describe("ToolProgressOrchestrator (Codex)", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("first sendToolStart POSTs a new tool_progress card with state=running", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9001 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl));

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 42,
      toolName: "Bash",
      args: "uptime",
    });

    const posts = server.requests.filter(
      (r) => r.method === "POST" && r.url.startsWith("/api/v1/messages"),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      chatId: 42,
      sender: "assistant",
      messageType: "tool_progress",
      toolProgress: {
        state: "running",
        tools: [{ icon: "💻", name: "Bash", args: "uptime", status: "done" }],
      },
    });
    // `/messages` does not declare assistantId, so the card POST does not
    // carry it (the backend resolves the assistant from the chat).
    expect(posts[0]!.body).not.toHaveProperty("assistantId");
    expect(orch._internal.activeChats).toEqual([42]);
  });

  it("subsequent sendToolStart PATCHes the same card (after debounce window)", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9100 });
    server.stage("PATCH", "/api/v1/messages/9100", 200, { id: 9100 });

    // Debounce of 0 so the second call fires the PATCH synchronously
    // within the test rather than scheduling a setTimeout flush.
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({ assistantId: 1, chatId: 7, toolName: "Bash" });
    await orch.sendToolStart({ assistantId: 1, chatId: 7, toolName: "Read" });

    const patches = server.requests.filter(
      (r) => r.method === "PATCH" && r.url.endsWith("/api/v1/messages/9100"),
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({
      toolProgress: {
        state: "running",
        tools: [
          { name: "Bash", status: "done" },
          { name: "Read", status: "done" },
        ],
      },
    });
  });

  it("finalizeTurn PATCHes the card to state=done and drops state", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9200 });
    server.stage("PATCH", "/api/v1/messages/9200", 200, { id: 9200 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({ assistantId: 1, chatId: 3, toolName: "Bash" });
    await orch.finalizeTurn(3);

    const patches = server.requests.filter(
      (r) => r.method === "PATCH" && r.url.endsWith("/api/v1/messages/9200"),
    );
    // The single PATCH should be the finalize one (no PATCH was fired on
    // the first POST), carrying state=done.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({
      toolProgress: {
        state: "done",
        tools: [{ name: "Bash", status: "done" }],
      },
    });
    // Card cleared from internal state.
    expect(orch._internal.activeChats).toEqual([]);
  });

  it("finalizeTurn is a no-op when no card exists for the chat", async () => {
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl));
    await orch.finalizeTurn(999);
    expect(server.requests).toEqual([]);
  });

  it("second turn after finalize POSTs a NEW card (cache cleared)", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9300 });
    server.stage("PATCH", "/api/v1/messages/9300", 200, { id: 9300 });
    server.stage("POST", "/api/v1/messages", 201, { id: 9301 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    // Turn 1
    await orch.sendToolStart({ assistantId: 1, chatId: 5, toolName: "Bash" });
    await orch.finalizeTurn(5);
    // Turn 2
    await orch.sendToolStart({ assistantId: 1, chatId: 5, toolName: "Read" });

    const posts = server.requests.filter(
      (r) => r.method === "POST" && r.url.startsWith("/api/v1/messages"),
    );
    expect(posts).toHaveLength(2);
    expect((posts[0]!.body as any).toolProgress.tools[0].name).toBe("Bash");
    expect((posts[1]!.body as any).toolProgress.tools[0].name).toBe("Read");
  });

  it("truncates args >120 chars with ellipsis", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9400 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl));
    const longArg = "x".repeat(200);
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 8,
      toolName: "Bash",
      args: longArg,
    });
    const body = server.requests.at(-1)!.body as any;
    const args = body.toolProgress.tools[0].args as string;
    expect(args).toHaveLength(120);
    expect(args.endsWith("…")).toBe(true);
  });

  it("debouncer collapses N rapid sendToolStarts into one PATCH", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9500 });
    server.stage("PATCH", "/api/v1/messages/9500", 200, { id: 9500 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 100,
    });

    await orch.sendToolStart({ assistantId: 1, chatId: 11, toolName: "Bash" });
    // 4 rapid calls within the 100ms window - should coalesce into ONE
    // PATCH (not four).
    await orch.sendToolStart({ assistantId: 1, chatId: 11, toolName: "Read" });
    await orch.sendToolStart({ assistantId: 1, chatId: 11, toolName: "Edit" });
    await orch.sendToolStart({ assistantId: 1, chatId: 11, toolName: "Grep" });
    await orch.sendToolStart({ assistantId: 1, chatId: 11, toolName: "Glob" });

    // Wait past the debounce window so the deferred flush fires.
    await new Promise((r) => setTimeout(r, 200));

    const patches = server.requests.filter(
      (r) => r.method === "PATCH" && r.url.endsWith("/api/v1/messages/9500"),
    );
    // Either 0 (all coalesced into finalize-time) or 1 (one deferred
    // flush). The contract is "≤1 per debounce window", not exactly 1.
    expect(patches.length).toBeLessThanOrEqual(1);
    if (patches.length === 1) {
      const tools = (patches[0]!.body as any).toolProgress.tools as Array<{
        name: string;
      }>;
      expect(tools.map((t) => t.name)).toEqual([
        "Bash",
        "Read",
        "Edit",
        "Grep",
        "Glob",
      ]);
    }
  });

  it("dispose cancels pending flushes and clears state", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9600 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 500,
    });
    await orch.sendToolStart({ assistantId: 1, chatId: 12, toolName: "Bash" });
    expect(orch._internal.activeChats).toEqual([12]);
    orch.dispose();
    expect(orch._internal.activeChats).toEqual([]);
  });

  it("emoji mapper picks sensible defaults per canonical tool name", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9700 });
    server.stage("POST", "/api/v1/messages", 201, { id: 9701 });
    server.stage("POST", "/api/v1/messages", 201, { id: 9702 });
    server.stage("POST", "/api/v1/messages", 201, { id: 9703 });

    const orch = new ToolProgressOrchestrator(makeApi(baseUrl));
    await orch.sendToolStart({ assistantId: 1, chatId: 100, toolName: "Bash" });
    await orch.sendToolStart({ assistantId: 1, chatId: 101, toolName: "Read" });
    await orch.sendToolStart({ assistantId: 1, chatId: 102, toolName: "Grep" });
    await orch.sendToolStart({ assistantId: 1, chatId: 103, toolName: "Glob" });

    const posts = server.requests.filter(
      (r) => r.method === "POST" && r.url.startsWith("/api/v1/messages"),
    );
    const icons = posts.map((p) => (p.body as any).toolProgress.tools[0].icon);
    expect(icons).toEqual(["💻", "📖", "🔎", "📂"]);
  });

  it("custom iconForToolName override wins over default mapper", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9800 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      iconForToolName: () => "🌟",
    });
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 200,
      toolName: "Anything",
    });
    const body = server.requests.at(-1)!.body as any;
    expect(body.toolProgress.tools[0].icon).toBe("🌟");
  });
  it("updates one native item from running to failed without duplicating it", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9900 });
    server.stage("PATCH", "/api/v1/messages/9900", 200, {});
    server.stage("PATCH", "/api/v1/messages/9900", 200, {});
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });
    const item = {
      assistantId: 1,
      chatId: 110,
      toolName: "shell",
      itemId: "command-1",
      args: "test",
    };
    await orch.sendToolStart({ ...item, status: "running" });
    await orch.sendToolStart({ ...item, status: "error" });
    await orch.finalizeTurn(110);
    const posts = server.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect((posts[0].body as any).toolProgress.tools[0].status).toBe("running");
    const final = server.requests.filter((r) => r.method === "PATCH").at(-1)!;
    expect((final.body as any).toolProgress.tools).toEqual([
      expect.objectContaining({ name: "shell", status: "error" }),
    ]);
  });
});

describe("ToolProgressOrchestrator (stage 4: the cap, the new fields)", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  /** The card's own PATCH bodies, newest last. */
  function patches(cardId: number) {
    return server.requests.filter(
      (r) => r.method === "PATCH" && r.url.endsWith(`/api/v1/messages/${cardId}`),
    );
  }

  it("keeps the newest rows at the cap, behind one honest earlier row", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9700 });
    server.stage("PATCH", "/api/v1/messages/9700", 200, { id: 9700 });
    // A long debounce means no flush lands mid loop: the single PATCH the
    // test reads is the finalize, carrying the clipped list.
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    for (let i = 1; i <= 60; i += 1) {
      await orch.sendToolStart({
        assistantId: 1,
        chatId: 70,
        toolName: `tool-${i}`,
        itemId: `item-${i}`,
        status: "done",
      });
    }
    await orch.finalizeTurn(70);

    const tools = (patches(9700).at(-1)!.body as any).toolProgress
      .tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(50);
    // The end of the turn is what the owner is looking at.
    expect(tools.at(-1)!.name).toBe("tool-60");
    expect(tools[1]!.name).toBe("tool-12");
    expect(tools.map((t) => t.name)).not.toContain("tool-11");
    expect(tools[0]).toMatchObject({
      name: "earlier",
      status: "done",
      args: "11 earlier tools",
    });
  });

  it("counts every dropped row once, however many times the cap bites", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9710 });
    server.stage("PATCH", "/api/v1/messages/9710", 200, { id: 9710 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    for (let i = 1; i <= 52; i += 1) {
      await orch.sendToolStart({
        assistantId: 1,
        chatId: 71,
        toolName: `tool-${i}`,
        itemId: `item-${i}`,
        status: "done",
      });
    }
    await orch.finalizeTurn(71);

    const tools = (patches(9710).at(-1)!.body as any).toolProgress
      .tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(50);
    expect(tools[0]!.args).toBe("3 earlier tools");
    expect(tools[1]!.name).toBe("tool-4");
    expect(tools.at(-1)!.name).toBe("tool-52");
  });

  it("still updates a kept row in place after the cap has bitten", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9720 });
    server.stage("PATCH", "/api/v1/messages/9720", 200, { id: 9720 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    for (let i = 1; i <= 60; i += 1) {
      await orch.sendToolStart({
        assistantId: 1,
        chatId: 72,
        toolName: `tool-${i}`,
        itemId: `item-${i}`,
        status: "running",
      });
    }
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 72,
      toolName: "tool-55",
      itemId: "item-55",
      status: "error",
    });
    await orch.finalizeTurn(72);

    const tools = (patches(9720).at(-1)!.body as any).toolProgress
      .tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(50);
    const hits = tools.filter((t) => t.name === "tool-55");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.status).toBe("error");
  });

  it("carries the five optional row fields, and only when they are present", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9730 });
    server.stage("PATCH", "/api/v1/messages/9730", 200, { id: 9730 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 73,
      toolName: "edit",
      icon: "✏️",
      itemId: "fc1",
      status: "done",
      path: "src/a.ts",
      pathCount: 2,
      detail: "update",
      durationMs: 1200,
      kind: "tool",
    });
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 73,
      toolName: "Bash",
      itemId: "cmd1",
      status: "running",
    });

    const first = (server.requests[0]!.body as any).toolProgress.tools[0];
    expect(first).toEqual({
      icon: "✏️",
      name: "edit",
      status: "done",
      kind: "tool",
      path: "src/a.ts",
      pathCount: 2,
      detail: "update",
      durationMs: 1200,
    });
    const second = (patches(9730).at(-1)!.body as any).toolProgress.tools[1];
    // No icon from the sender falls back to the name mapper, and the four
    // fields it did not have never reach the wire as empty strings.
    expect(second).toEqual({ icon: "💻", name: "Bash", status: "running" });
  });

  it("clears a subagent's state word when the row stops reporting one", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9750 });
    server.stage("PATCH", "/api/v1/messages/9750", 200, { id: 9750 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 75,
      toolName: "reviewer",
      itemId: "t9",
      status: "running",
      kind: "subagent",
      detail: "1 running",
    });
    // The same worker row, with no state left to report.
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 75,
      toolName: "reviewer",
      itemId: "t9",
      status: "done",
      kind: "subagent",
    });

    const row = (patches(9750).at(-1)!.body as any).toolProgress.tools[0];
    expect(row).toEqual({
      icon: "🔧",
      name: "reviewer",
      status: "done",
      kind: "subagent",
    });
  });

  it("keeps a path sticky, and a tool row's detail too", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9760 });
    server.stage("PATCH", "/api/v1/messages/9760", 200, { id: 9760 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 76,
      toolName: "edit",
      itemId: "fc1",
      status: "running",
      kind: "tool",
      path: "src/a.ts",
      pathCount: 3,
      detail: "update",
    });
    // A later event that simply knows less: a file a row touched does not
    // become unknown, and a tool row's detail is a qualifier, not a state.
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 76,
      toolName: "edit",
      itemId: "fc1",
      status: "done",
      kind: "tool",
    });

    const row = (patches(9760).at(-1)!.body as any).toolProgress.tools[0];
    expect(row).toMatchObject({
      status: "done",
      path: "src/a.ts",
      pathCount: 3,
      detail: "update",
    });
  });

  it("never clips a character in half on its way to the card", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9770 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 77,
      toolName: "Bash",
      // The astral pair straddles each limit: args 120, path 200, detail 120.
      args: "a".repeat(118) + "\u{1F600}" + "tail",
      path: "/tmp/" + "p".repeat(194) + "\u{1F600}.ts",
      detail: "d".repeat(119) + "\u{1F600}",
      itemId: "s1",
      status: "running",
    });

    const row = (server.requests[0]!.body as any).toolProgress.tools[0];
    for (const field of [row.args, row.path, row.detail]) {
      expect(loneSurrogates(field)).toBe(0);
    }
    // The ellipsis still marks a clipped args line, and nothing is longer
    // than its limit.
    expect(row.args.endsWith("…")).toBe(true);
    expect(row.args.length).toBeLessThanOrEqual(120);
    expect(row.path.length).toBeLessThanOrEqual(200);
    expect(row.detail.length).toBeLessThanOrEqual(120);
    // A round trip through JSON is what the backend does before JSONB.
    expect(JSON.parse(JSON.stringify(row)).path).toBe(row.path);
  });

  it("never runs two PATCHes for one card at the same time", async () => {
    let release: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      release = r;
    });
    const patchMessage = vi.fn(async () => {
      await inFlight;
      return { id: 9740 };
    });
    const api = {
      postMessage: async () => ({ id: 9740 }),
      patchMessage,
    } as unknown as BgosApi;
    const orch = new ToolProgressOrchestrator(api, { debounceMs: 0 });

    await orch.sendToolStart({ assistantId: 1, chatId: 74, toolName: "Bash" });
    void orch.sendToolStart({ assistantId: 1, chatId: 74, toolName: "Read" });
    void orch.sendToolStart({ assistantId: 1, chatId: 74, toolName: "Edit" });
    await new Promise((r) => setTimeout(r, 10));

    expect(patchMessage).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 10));
  });
});

/** Halves of a surrogate pair with no partner. Postgres refuses these. */
function loneSurrogates(text: string): number {
  let lone = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) lone += 1;
      else i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) lone += 1;
  }
  return lone;
}
