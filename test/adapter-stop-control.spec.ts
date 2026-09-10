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
  it("does not stop or acknowledge a different assistant's chat", async () => {
    const { adapter, frame } = fixture(true);
    await adapter.handleControl({ ...frame, assistantId: "99" });
    expect(adapter.nativeCommands.cancel).not.toHaveBeenCalled();
    expect(adapter.host.stopTurn).not.toHaveBeenCalled();
    expect(adapter.outbound.sendText).not.toHaveBeenCalled();
  });
});
