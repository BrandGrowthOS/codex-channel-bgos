import { describe, it, expect } from "vitest";
import { toolCardFromItem, RunAccumulator } from "../src/event-mapper.js";

// Minimal synthetic Codex events/items (shapes per @openai/codex-sdk 0.144.1).
const ev = (e: unknown) => e as any;

describe("toolCardFromItem (Codex item -> tool_progress card)", () => {
  it("maps a command_execution item", () => {
    const card = toolCardFromItem({
      id: "i1",
      type: "command_execution",
      command: "ls -la /tmp",
      aggregated_output: "",
      status: "in_progress",
    } as any);
    expect(card).toEqual({ icon: "⚡", name: "shell", args: "ls -la /tmp", status: "running" });
  });

  it("maps a file_change item with completed status to done", () => {
    const card = toolCardFromItem({
      id: "i2",
      type: "file_change",
      changes: [
        { path: "a.ts", kind: "add" },
        { path: "b.ts", kind: "update" },
      ],
      status: "completed",
    } as any);
    expect(card?.icon).toBe("✏️");
    expect(card?.name).toBe("edit");
    expect(card?.status).toBe("done");
    expect(card?.args).toContain("a.ts");
    expect(card?.args).toContain("b.ts");
  });

  it("maps an mcp_tool_call item", () => {
    const card = toolCardFromItem({
      id: "i3",
      type: "mcp_tool_call",
      server: "github",
      tool: "list_prs",
      arguments: { repo: "x" },
      status: "completed",
    } as any);
    expect(card?.icon).toBe("🔌");
    expect(card?.name).toBe("github.list_prs");
    expect(card?.status).toBe("done");
  });

  it("maps a web_search item to done", () => {
    const card = toolCardFromItem({
      id: "i4",
      type: "web_search",
      query: "codex sdk docs",
    } as any);
    expect(card).toEqual({ icon: "🔎", name: "web_search", args: "codex sdk docs", status: "done" });
  });

  it("returns null for agent_message and reasoning items", () => {
    expect(toolCardFromItem({ id: "a", type: "agent_message", text: "hi" } as any)).toBeNull();
    expect(toolCardFromItem({ id: "r", type: "reasoning", text: "thinking" } as any)).toBeNull();
    expect(toolCardFromItem({ id: "t", type: "todo_list", items: [] } as any)).toBeNull();
  });

  it("truncates long args to 120 chars", () => {
    const long = "x".repeat(500);
    const card = toolCardFromItem({
      id: "i5",
      type: "command_execution",
      command: long,
      aggregated_output: "",
      status: "in_progress",
    } as any);
    expect(card!.args!.length).toBeLessThanOrEqual(120);
  });
});

describe("RunAccumulator (fold a run's event stream)", () => {
  it("surfaces every todo_list event without treating it as a tool", () => {
    const acc = new RunAccumulator();
    const started = ev({
      type: "item.started",
      item: {
        id: "todo-1",
        type: "todo_list",
        items: [
          { text: "Inspect", completed: false },
          { text: "Implement", completed: false },
          { text: "Verify", completed: false },
        ],
      },
    });
    const updated = ev({
      ...started,
      type: "item.updated",
      item: {
        ...started.item,
        items: [
          { text: "Inspect", completed: true },
          { text: "Implement", completed: false },
          { text: "Verify", completed: false },
        ],
      },
    });
    const completed = ev({ ...updated, type: "item.completed" });

    expect(acc.handle(started)).toEqual({
      eventType: "item.started",
      item: started.item,
    });
    expect(acc.handle(updated)).toEqual({
      eventType: "item.updated",
      item: updated.item,
    });
    expect(acc.handle(completed)).toEqual({
      eventType: "item.completed",
      item: completed.item,
    });
    expect(acc.tools()).toEqual([]);
    expect(acc.hadToolActivity).toBe(false);
  });

  it("captures the thread id from thread.started", () => {
    const acc = new RunAccumulator();
    expect(
      acc.handle(ev({ type: "thread.started", thread_id: "thread_123" })),
    ).toBeUndefined();
    expect(acc.threadId).toBe("thread_123");
  });

  it("accumulates agent_message text as the reply", () => {
    const acc = new RunAccumulator();
    acc.handle(ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Hello." } }));
    expect(acc.replyText).toBe("Hello.");
  });

  it("joins multiple agent_message items with a blank line", () => {
    const acc = new RunAccumulator();
    acc.handle(ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "One." } }));
    acc.handle(ev({ type: "item.completed", item: { id: "m2", type: "agent_message", text: "Two." } }));
    expect(acc.replyText).toBe("One.\n\nTwo.");
  });

  it("tracks a tool card through started -> completed and keeps one entry per id", () => {
    const acc = new RunAccumulator();
    acc.handle(ev({ type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } }));
    expect(acc.tools()).toHaveLength(1);
    expect(acc.tools()[0].status).toBe("running");
    acc.handle(ev({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "ok", exit_code: 0, status: "completed" } }));
    expect(acc.tools()).toHaveLength(1);
    expect(acc.tools()[0].status).toBe("done");
  });

  it("preserves tool order across multiple tools", () => {
    const acc = new RunAccumulator();
    acc.handle(ev({ type: "item.started", item: { id: "c1", type: "command_execution", command: "a", aggregated_output: "", status: "in_progress" } }));
    acc.handle(ev({ type: "item.started", item: { id: "c2", type: "web_search", query: "b" } }));
    expect(acc.tools().map((t) => t.name)).toEqual(["shell", "web_search"]);
  });

  it("captures usage from turn.completed", () => {
    const acc = new RunAccumulator();
    const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 2 };
    expect(acc.turnCompleted).toBe(false);
    acc.handle(ev({ type: "turn.completed", usage }));
    expect(acc.usage).toEqual(usage);
    expect(acc.turnCompleted).toBe(true);
  });

  it("captures a turn.failed error", () => {
    const acc = new RunAccumulator();
    acc.handle(ev({ type: "turn.failed", error: { message: "rate limited" } }));
    expect(acc.error).toBe("rate limited");
  });

  it("captures a top-level error event", () => {
    const acc = new RunAccumulator();
    acc.handle(ev({ type: "error", message: "boom" }));
    expect(acc.error).toBe("boom");
  });

  it("reports tool activity only after a tool item appears", () => {
    const acc = new RunAccumulator();
    expect(acc.hadToolActivity).toBe(false);
    acc.handle(ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "hi" } }));
    expect(acc.hadToolActivity).toBe(false);
    acc.handle(ev({ type: "item.started", item: { id: "c1", type: "web_search", query: "x" } }));
    expect(acc.hadToolActivity).toBe(true);
  });
});
