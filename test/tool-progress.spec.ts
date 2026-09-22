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

  it("keeps a path sticky, and a tool row's detail, and its output too", async () => {
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
      output: "ok\nfinished",
      exitCode: 0,
    });
    // A later event that simply knows less: a file a row touched does not
    // become unknown, a tool row's detail is a qualifier rather than a state,
    // and an mcp progress line that carries no output is not evidence that
    // the command printed nothing.
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
      output: "ok\nfinished",
      exitCode: 0,
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

/**
 * Stage 7 of the Mission program (C-30): what a command printed, the code it
 * exited with, the lines an edit moved, and the turn's own clock.
 *
 * MUTATION PROOFS, one per test below:
 *  - a falsy check on `exitCode` in the entry build drops the zero case
 *  - a falsy check on `linesAdded` drops the legal zero case
 *  - dropping the wire side tail clip lets an oversized output through
 *  - sending a count the wire refuses breaks the "past the wire's ceiling" case
 *  - sending the meta in `drain` too breaks the "final PATCH only" case
 *  - clearing the noted clock after the no card early return leaks a finished
 *    turn's clock onto the next turn's card
 *  - spending the budget from the FRONT, or not spending it at all, breaks
 *    the newest rows case
 *  - replacing the in place merge with the new entry alone blanks a shell
 *    row's output on the next progress line
 */
describe("ToolProgressOrchestrator (stage 7: output, the exit code, the counts, the clock)", () => {
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

  it("carries the four stage 7 row fields, and only when they are present", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9800 });
    server.stage("PATCH", "/api/v1/messages/9800", 200, { id: 9800 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 80,
      toolName: "shell",
      icon: "⚡",
      itemId: "cmd1",
      status: "error",
      kind: "tool",
      output: "line one\nline two",
      exitCode: 3,
    });
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 80,
      toolName: "edit",
      icon: "✏️",
      itemId: "fc1",
      status: "done",
      kind: "tool",
      path: "src/a.ts",
      linesAdded: 12,
      linesRemoved: 4,
    });
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 80,
      toolName: "Read",
      itemId: "rd1",
      status: "done",
    });

    const rows = (patches(9800).at(-1)!.body as any).toolProgress.tools;
    // The newline is the whole point of the block the owner opens, so it
    // survives the wire exactly as the mapper handed it over.
    expect(rows[0]).toEqual({
      icon: "⚡",
      name: "shell",
      status: "error",
      kind: "tool",
      output: "line one\nline two",
      exitCode: 3,
    });
    expect(rows[1]).toEqual({
      icon: "✏️",
      name: "edit",
      status: "done",
      kind: "tool",
      path: "src/a.ts",
      linesAdded: 12,
      linesRemoved: 4,
    });
    // A row that measured nothing carries nothing: no empty string, no zero.
    expect(rows[2]).toEqual({ icon: "📖", name: "Read", status: "done" });
  });

  it("keeps a legal zero: a successful exit code and a zero count both survive", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9810 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 81,
      toolName: "shell",
      itemId: "cmd0",
      status: "done",
      exitCode: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });

    const row = (server.requests[0]!.body as any).toolProgress.tools[0];
    expect(row.exitCode).toBe(0);
    expect(row.linesAdded).toBe(0);
    expect(row.linesRemoved).toBe(0);
  });

  it("drops a pair of counts past the wire's ceiling, rather than lose the card", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9815 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    // The platform declares zero to a million on both counts and refuses the
    // WHOLE patch above it, and a refusal is not recovered: the same row
    // rides every later patch, so the card freezes where it is. The row keeps
    // its path and its status and simply has no counts.
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 815,
      toolName: "edit",
      itemId: "fc9",
      status: "done",
      path: "src/generated.ts",
      linesAdded: 1_000_001,
      linesRemoved: 4,
    });

    const row = (server.requests[0]!.body as any).toolProgress.tools[0];
    expect(row.path).toBe("src/generated.ts");
    expect(row).not.toHaveProperty("linesAdded");
    expect(row).not.toHaveProperty("linesRemoved");
  });

  it("cuts an oversized output to its TAIL at the wire, never in half", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9820 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    // A caller that did not cap its own output: the platform refuses the whole
    // PATCH over 2048, and the cost of a refusal is the card for the rest of
    // the turn, so the wire cuts it here rather than lose the card.
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 82,
      toolName: "shell",
      itemId: "cmd2",
      status: "done",
      output: "\u{1F600}".repeat(1200) + "END",
    });

    const row = (server.requests[0]!.body as any).toolProgress.tools[0];
    expect(row.output.length).toBeLessThanOrEqual(2048);
    expect(row.output.endsWith("END")).toBe(true);
    expect(loneSurrogates(row.output)).toBe(0);
  });

  it("sends the turn's clock on the FINAL patch and on no running one", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9830 });
    server.stage("PATCH", "/api/v1/messages/9830", 200, { id: 9830 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 83,
      toolName: "shell",
      itemId: "cmd1",
      status: "running",
    });
    orch.noteTurnMeta(83, {
      startedAtMs: 1789932968000,
      finishedAtMs: 1789932983000,
    });
    // A running patch, which happens while the turn is still going.
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 83,
      toolName: "Read",
      itemId: "rd1",
      status: "done",
    });
    await orch.finalizeTurn(83);

    const bodies = patches(9830).map((r) => (r.body as any).toolProgress);
    const running = bodies.filter((b) => b.state === "running");
    expect(running.length).toBeGreaterThan(0);
    for (const body of running) {
      expect(body.startedAt).toBeUndefined();
      expect(body.finishedAt).toBeUndefined();
    }
    const final = bodies.at(-1)!;
    expect(final.state).toBe("done");
    expect(final.startedAt).toBe("2026-09-20T19:36:08.000Z");
    expect(final.finishedAt).toBe("2026-09-20T19:36:23.000Z");
  });

  it("closes a card with no clock at all when the runtime reported none", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9840 });
    server.stage("PATCH", "/api/v1/messages/9840", 200, { id: 9840 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 84,
      toolName: "shell",
      itemId: "cmd1",
      status: "done",
    });
    await orch.finalizeTurn(84);

    const final = (patches(9840).at(-1)!.body as any).toolProgress;
    expect(final.state).toBe("done");
    expect("startedAt" in final).toBe(false);
    expect("finishedAt" in final).toBe(false);
  });

  it("never lets one turn's clock reach the next turn's card", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9850 });
    server.stage("PATCH", "/api/v1/messages/9850", 200, { id: 9850 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    // A turn that ran NO tools has no card to close, so the finalize returns
    // early. The clock it reported must still be forgotten, or the next turn
    // opens a card and closes it with the previous turn's minutes.
    orch.noteTurnMeta(85, {
      startedAtMs: 1789932968000,
      finishedAtMs: 1789932983000,
    });
    await orch.finalizeTurn(85);

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 85,
      toolName: "shell",
      itemId: "cmd1",
      status: "done",
    });
    await orch.finalizeTurn(85);

    const final = (patches(9850).at(-1)!.body as any).toolProgress;
    expect("startedAt" in final).toBe(false);
    expect("finishedAt" in final).toBe(false);
  });

  it("spends the card's output budget on the NEWEST rows, and never drops a row", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9860 });
    server.stage("PATCH", "/api/v1/messages/9860", 200, { id: 9860 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    // Six rows of 2000 characters each against a 8192 character card budget:
    // the last four fit, the fifth from the end would not, and nothing older
    // than it keeps its output either.
    for (let i = 1; i <= 6; i += 1) {
      await orch.sendToolStart({
        assistantId: 1,
        chatId: 86,
        toolName: `shell-${i}`,
        itemId: `cmd-${i}`,
        status: "done",
        output: String(i).repeat(2000),
        exitCode: i,
      });
    }
    await orch.finalizeTurn(86);

    const rows = (patches(9860).at(-1)!.body as any).toolProgress.tools;
    expect(rows).toHaveLength(6);
    expect(rows.map((r: any) => r.output === undefined)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    // The budget spends output and never a row, and never a row's exit code:
    // the chip the owner reads is not what costs the card its bytes.
    expect(rows.map((r: any) => r.exitCode)).toEqual([1, 2, 3, 4, 5, 6]);
    const spent = rows
      .map((r: any) => (r.output ? r.output.length : 0))
      .reduce((a: number, b: number) => a + b, 0);
    expect(spent).toBeLessThanOrEqual(8192);
  });
});

/**
 * Stage 8 of the Mission program (C-34): a child agent is a row, so a row now
 * carries its own identity, its own start and what the child finally said.
 *
 * MUTATION PROOFS, one per test below:
 *  - dropping any one of the three copies in `sendToolStart` breaks the
 *    "only when they are present" case
 *  - adding `id` or `startedAt` to what `clearsDetail` deletes breaks the
 *    sticky case, which is the one that matters live: a child reports a
 *    state, then a terminal state with no qualifier, and its start must not
 *    vanish with its state word
 *  - counting every row in `buildSummary` turns "Used 3 tools" into
 *    "Used 7 tools" and breaks the summary case
 *  - dropping rows from the BACK in `clipToCap` breaks the cap case, because
 *    the children are the newest rows on the card
 */
describe("ToolProgressOrchestrator (stage 8: a child agent's row)", () => {
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

  it("carries the three stage 8 row fields, and only when they are present", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9900 });
    server.stage("PATCH", "/api/v1/messages/9900", 200, { id: 9900 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 90,
      toolName: "scout",
      icon: "👥",
      itemId: "thread-child-1",
      status: "done",
      kind: "subagent",
      id: "thread-child-1",
      startedAt: "2026-09-21T10:00:00.000Z",
      result: "ran 42 tests, all green",
      durationMs: 12000,
    });
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 90,
      toolName: "Read",
      itemId: "rd1",
      status: "done",
    });

    const first = (server.requests[0]!.body as any).toolProgress.tools[0];
    expect(first).toEqual({
      icon: "👥",
      name: "scout",
      status: "done",
      kind: "subagent",
      id: "thread-child-1",
      startedAt: "2026-09-21T10:00:00.000Z",
      result: "ran 42 tests, all green",
      durationMs: 12000,
    });
    // An ordinary tool row carries none of the three, as an empty string or
    // otherwise: absent means absent on this wire.
    const second = (patches(9900).at(-1)!.body as any).toolProgress.tools[1];
    expect(second).toEqual({ icon: "📖", name: "Read", status: "done" });
  });

  it("keeps a child row's id and start across a merge, and clears only its state word", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9910 });
    server.stage("PATCH", "/api/v1/messages/9910", 200, { id: 9910 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 0,
    });

    await orch.sendToolStart({
      assistantId: 1,
      chatId: 91,
      toolName: "scout",
      icon: "👥",
      itemId: "thread-child-1",
      status: "running",
      kind: "subagent",
      id: "thread-child-1",
      startedAt: "2026-09-21T10:00:00.000Z",
      detail: "reading the spec",
    });
    // The same child, now finished, with no qualifier left to report.
    await orch.sendToolStart({
      assistantId: 1,
      chatId: 91,
      toolName: "scout",
      icon: "👥",
      itemId: "thread-child-1",
      status: "done",
      kind: "subagent",
      id: "thread-child-1",
      startedAt: "2026-09-21T10:00:00.000Z",
      result: "all green",
      durationMs: 12000,
    });

    const row = (patches(9910).at(-1)!.body as any).toolProgress.tools[0];
    expect(row).toEqual({
      icon: "👥",
      name: "scout",
      status: "done",
      kind: "subagent",
      id: "thread-child-1",
      startedAt: "2026-09-21T10:00:00.000Z",
      result: "all green",
      durationMs: 12000,
    });
  });

  it("counts the agent's own tools in the summary, and never its helpers", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9920 });
    server.stage("PATCH", "/api/v1/messages/9920", 200, { id: 9920 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    for (const name of ["Bash", "Read", "Edit"]) {
      await orch.sendToolStart({
        assistantId: 1,
        chatId: 92,
        toolName: name,
        itemId: `tool-${name}`,
        status: "done",
      });
    }
    for (let i = 1; i <= 4; i += 1) {
      await orch.sendToolStart({
        assistantId: 1,
        chatId: 92,
        toolName: "helper",
        icon: "👥",
        itemId: `child-${i}`,
        status: "done",
        kind: "subagent",
        id: `child-${i}`,
      });
    }
    await orch.finalizeTurn(92);

    const body = patches(9920).at(-1)!.body as any;
    // Seven rows on the card, three of them the agent's own work.
    expect(body.toolProgress.tools).toHaveLength(7);
    expect(body.text).toBe("Used 3 tools · Bash, Read, Edit");
  });

  it("holds the card inside the 50 row cap with child rows in the same array", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 9930 });
    server.stage("PATCH", "/api/v1/messages/9930", 200, { id: 9930 });
    const orch = new ToolProgressOrchestrator(makeApi(baseUrl), {
      debounceMs: 5000,
    });

    for (let i = 1; i <= 48; i += 1) {
      await orch.sendToolStart({
        assistantId: 1,
        chatId: 93,
        toolName: `tool-${i}`,
        itemId: `item-${i}`,
        status: "done",
      });
    }
    for (let i = 1; i <= 4; i += 1) {
      await orch.sendToolStart({
        assistantId: 1,
        chatId: 93,
        toolName: "helper",
        icon: "👥",
        itemId: `child-${i}`,
        status: "running",
        kind: "subagent",
        id: `child-${i}`,
        startedAt: "2026-09-21T10:00:00.000Z",
      });
    }
    await orch.finalizeTurn(93);

    const tools = (patches(9930).at(-1)!.body as any).toolProgress
      .tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(50);
    // The children are the newest rows, so the front drop keeps every one.
    expect(tools.slice(-4).map((t) => t.id)).toEqual([
      "child-1",
      "child-2",
      "child-3",
      "child-4",
    ]);
    expect(tools[0]).toMatchObject({ name: "earlier", args: "3 earlier tools" });
    expect(tools[1]!.name).toBe("tool-4");
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
