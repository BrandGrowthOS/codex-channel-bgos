import { describe, expect, it, vi } from "vitest";
import {
  buildPickerCatalog,
  applyPickerSelection,
} from "../src/model-effort-picker.js";
import type { CodexModel } from "../src/session-settings.js";
import { CodexAdapter } from "../src/adapter.js";
import { normalizeVoiceRpc } from "../src/voice-rpc.js";

const model = (efforts = ["low", "medium", "high", "ultra"]): CodexModel => ({
  id: "gpt-6.1-sol",
  model: "gpt-6.1-sol",
  displayName: "GPT-6.1 Sol",
  description: "Balanced coding",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
    reasoningEffort,
    description: "",
  })),
  supportsPersonality: false,
  serviceTiers: [],
  isDefault: true,
});

describe("model effort picker", () => {
  it("lists only confirmed session state, never the catalog default", async () => {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    Object.assign(adapter, {
      host: {
        listModels: async () => [model()],
        pickerCurrentReport: () => null,
        sessionSettings: async () => ({
          model: model().model,
          effort: "medium",
        }),
        pickerSessionId: () => "new:10",
      },
      getRouteForAssistant: () => "codex",
      rpcSeen: new Set(),
      chatToAssistant: new Map(),
      api: {
        postVoiceRpcAck: async () => {},
        postVoiceRpcResult: vi.fn(async () => {}),
      },
    });
    await adapter.handleControl(
      normalizeVoiceRpc({
        rpcId: "list-1",
        op: "list_model_effort",
        assistantId: 5,
        chatId: 10,
        payload: {},
      }),
    );
    expect(adapter.api.postVoiceRpcResult).toHaveBeenCalledWith(
      "list-1",
      expect.objectContaining({
        ok: true,
        payload: expect.objectContaining({ current: null }),
      }),
    );
  });
  it("routes an authenticated typed frame to the session once and announces only success", async () => {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const host = {
      listModels: vi.fn(async () => [model()]),
      updateSettings: vi.fn(async () => ({
        model: model().model,
        effort: "ultra",
      })),
      pickerSessionId: () => "thread-a",
    };
    Object.assign(adapter, {
      host,
      getRouteForAssistant: () => "codex",
      rpcSeen: new Set(),
      chatToAssistant: new Map(),
      outbound: { sendText: vi.fn(async () => ({})) },
      api: {
        postVoiceRpcAck: vi.fn(async () => {}),
        postVoiceRpcResult: vi.fn(async () => {}),
      },
    });
    const frame = normalizeVoiceRpc({
      rpcId: "pick-1",
      op: "apply_model_effort",
      assistantId: 5,
      chatId: 10,
      payload: { sessionId: "thread-a", model: model().model, effort: "ultra" },
    });
    expect(frame).not.toBeNull();
    await adapter.handleControl(frame);
    await adapter.handleControl(frame);
    expect(host.updateSettings).toHaveBeenCalledTimes(1);
    expect(adapter.api.postVoiceRpcResult).toHaveBeenCalledWith("pick-1", {
      ok: true,
      payload: {
        sessionId: "thread-a",
        current: { model: model().model, effort: "ultra" },
      },
    });
    expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
    host.updateSettings.mockRejectedValueOnce(Error("runtime rejected"));
    await adapter.handleControl({ ...frame, rpcId: "pick-2" });
    expect(adapter.api.postVoiceRpcResult).toHaveBeenLastCalledWith(
      "pick-2",
      expect.objectContaining({ ok: false }),
    );
    expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
  });
  it("uses runtime values with family names and the native Ultra label", () => {
    const catalog = buildPickerCatalog(
      [model()],
      { model: model().model, effort: "high" },
      "thread-a",
    );
    expect(catalog.models[0].label).toBe("GPT Sol");
    expect(catalog.models[0].id).toBe("gpt-6.1-sol");
    expect(catalog.models[0].efforts.map((e) => e.id)).toEqual([
      "low",
      "medium",
      "high",
      "ultra",
    ]);
    expect(catalog.models[0].efforts.at(-1)?.label).toBe("Ultra");
    expect(catalog.current).toEqual({ model: model().model, effort: "high" });
    expect(catalog.sessionId).toBe("thread-a");
  });
  it("never invents Ultra or aliases max to ultra", () => {
    const catalog = buildPickerCatalog([model(["low", "max"])], {}, "new:10");
    expect(catalog.models[0].efforts.map((e) => e.id)).toEqual(["low", "max"]);
    expect(catalog.current).toBeNull();
  });
  it("rejects unknown future levels instead of guessing their ordering", () => {
    const catalog = buildPickerCatalog(
      [model(["low", "future"])],
      {},
      "new:10",
    );
    expect(catalog.models[0].efforts[1]).toMatchObject({
      id: "future",
      enabled: false,
    });
  });
  it("passes a typed selection and session identity to the actual host control", async () => {
    const host = {
      listModels: vi.fn(async () => [model()]),
      updateSettings: vi.fn(async () => ({
        model: model().model,
        effort: "ultra",
      })),
    };
    const selection = {
      sessionId: "thread-a",
      model: model().model,
      effort: "ultra",
    };
    expect(await applyPickerSelection(host, 10, selection)).toEqual({
      model: model().model,
      effort: "ultra",
    });
    expect(host.updateSettings).toHaveBeenCalledWith(
      10,
      { model: model().model, effort: "ultra" },
      "thread-a",
    );
  });
  it.each(["ultracode", "future", "high\n/goal something"])(
    "refuses unsupported %s before a command",
    async (effort) => {
      const host = {
        listModels: vi.fn(async () => [model()]),
        updateSettings: vi.fn(),
      };
      await expect(
        applyPickerSelection(host, 10, {
          sessionId: "thread-a",
          model: model().model,
          effort,
        }),
      ).rejects.toThrow();
      expect(host.updateSettings).not.toHaveBeenCalled();
    },
  );
  it("keeps runtime failures as failures", async () => {
    const host = {
      listModels: vi.fn(async () => [model()]),
      updateSettings: vi.fn(async () => {
        throw Error("runtime rejected");
      }),
    };
    await expect(
      applyPickerSelection(host, 10, {
        sessionId: "thread-a",
        model: model().model,
        effort: "high",
      }),
    ).rejects.toThrow("runtime rejected");
  });
});
