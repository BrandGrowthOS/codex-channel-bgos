import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapter.js";

function fixture(pendingMenu = false, running = false) {
  // Exercise the actual frame handler without starting a daemon or model.
  const adapter = Object.create(CodexAdapter.prototype) as any;
  const controller = new AbortController();
  Object.assign(adapter, {
    getRouteForAssistant: vi.fn((id) => (id === 10 ? "codex" : undefined)),
    refreshScopeRateLimited: vi.fn(async () => {}),
    rpcSeen: new Set(),
    // handleControl records which agent a chat belongs to (the Agent Browser
    // relay needs it), so the harness carries the same cache the real adapter has.
    chatToAssistant: new Map<number, number>(),
    turnControllers: new Map(running ? [[20, new Set([controller])]] : []),
    generations: new Map(),
    nativeCommands: { cancel: vi.fn(() => pendingMenu) },
    host: { stopTurn: vi.fn(async () => {}) },
    outbound: { sendText: vi.fn(async () => ({ id: 1 })) },
    api: {
      postVoiceRpcAck: vi.fn(async () => {}),
      postVoiceRpcResult: vi.fn(async () => {}),
    },
  });
  const frame = {
    rpcId: "stop-1",
    op: "stop_turn",
    assistantId: "10",
    chatId: "20",
    payload: {},
  };
  return { adapter, controller, frame };
}

describe("native Stop control completion", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "acknowledges the visible Stop button with menu=%s and turn=%s",
    async (menu, running) => {
      const { adapter, controller, frame } = fixture(menu, running);
      await adapter.handleControl(frame);
      expect(adapter.nativeCommands.cancel).toHaveBeenCalledWith(20);
      expect(adapter.host.stopTurn).toHaveBeenCalledWith(20);
      expect(controller.signal.aborted).toBe(running);
      expect(adapter.outbound.sendText).toHaveBeenCalledWith({
        assistantId: 10,
        chatId: 20,
        text: "Stopped.",
      });
      expect(adapter.api.postVoiceRpcResult).toHaveBeenCalledWith("stop-1", {
        ok: true,
        payload: { stopped: menu || running, supported: true },
      });
      await adapter.handleControl(frame);
      expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
    },
  );
  it("records which agent the chat belongs to, for the Agent Browser relay", async () => {
    const { adapter, frame } = fixture();
    await adapter.handleControl(frame);
    expect(adapter.chatToAssistant.get(20)).toBe(10);
  });
  it("does not stop or acknowledge a different assistant's chat", async () => {
    const { adapter, frame } = fixture(true);
    await adapter.handleControl({ ...frame, assistantId: "99" });
    expect(adapter.nativeCommands.cancel).not.toHaveBeenCalled();
    expect(adapter.host.stopTurn).not.toHaveBeenCalled();
    expect(adapter.outbound.sendText).not.toHaveBeenCalled();
  });
  it.each(["result", "rejection"])(
    "does not turn an intentional stop into a red agent error or delayed reply (%s)",
    async (completion) => {
      const { adapter } = fixture();
      const reply = {
        sendTyping: vi.fn(async () => {}),
        finalizeTurn: vi.fn(async () => {}),
        sendText: vi.fn(async () => {}),
      };
      adapter.missionLane = {
        beginTurn: vi.fn(() => 1),
        finalizeTurn: vi.fn(async () => {}),
      };
      // The turn asks the mission control lane whether the owner changed a
      // mission since the last turn. Nothing queued here, so the input passes
      // through untouched.
      adapter.missionControl = { applyBulletin: (_chatId: number, input: unknown) => input };
      adapter.outbound.sendAgentError = vi.fn();
      adapter.host.runTurn = vi.fn(async () => {
        for (const controller of adapter.turnControllers.get(20))
          controller.abort();
        if (completion === "rejection") throw new Error("Stopped by you.");
        return {
          error: "Stopped by you.",
          replyText: "Late partial response",
          turnCompleted: false,
        };
      });
      await adapter.executeAndReply(10, 20, "Wait then reply", reply);
      expect(adapter.outbound.sendAgentError).not.toHaveBeenCalled();
      expect(reply.sendText).not.toHaveBeenCalled();
      expect(reply.finalizeTurn).toHaveBeenCalledTimes(1);
      expect(adapter.turnControllers.size).toBe(0);
    },
  );
  it("keeps genuine native failures visible when the user did not stop", async () => {
    const { adapter } = fixture();
    const reply = {
      sendTyping: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
    };
    adapter.missionLane = {
      beginTurn: vi.fn(() => 1),
      finalizeTurn: vi.fn(async () => {}),
    };
    adapter.missionControl = { applyBulletin: (_chatId: number, input: unknown) => input };
    adapter.outbound.sendAgentError = vi.fn(async () => {});
    adapter.host.runTurn = vi.fn(async () => ({
      error: "Connection lost",
      replyText: "",
      turnCompleted: false,
    }));
    await adapter.executeAndReply(10, 20, "Work", reply);
    expect(adapter.outbound.sendAgentError).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      reason: "Connection lost",
    });
  });
});
