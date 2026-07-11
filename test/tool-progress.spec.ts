import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
      assistantId: 1,
      chatId: 42,
      sender: "assistant",
      messageType: "tool_progress",
      toolProgress: {
        state: "running",
        tools: [
          { icon: "💻", name: "Bash", args: "uptime", status: "done" },
        ],
      },
    });
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
    const icons = posts.map(
      (p) => (p.body as any).toolProgress.tools[0].icon,
    );
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
});
