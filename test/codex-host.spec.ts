import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexHost, appServerInput } from "../src/codex-host.js";
import { verifyModel } from "../src/setup/verify-model.js";

class Server extends EventEmitter {
  onRequest: any;
  next = 0;
  start = vi.fn(async () => {});
  close = vi.fn(() => this.emit("closed", new Error("closed")));
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/start")
      return { thread: { id: `thread-${++this.next}` } };
    if (method === "thread/resume") return { thread: { id: p.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${p.threadId}` } };
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
