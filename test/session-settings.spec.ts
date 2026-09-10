import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexHost, conversationLabel } from "../src/codex-host.js";
import {
  SessionSettingsStore,
  nativeSettings,
  validateSettings,
} from "../src/session-settings.js";

const models = ["one", "two"].map((model, i) => ({
  model,
  id: model,
  displayName: model,
  description: "",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "" },
    { reasoningEffort: "high", description: "" },
  ],
  supportsPersonality: !i,
  serviceTiers: [],
  isDefault: !i,
}));
class Server extends EventEmitter {
  onRequest: any;
  start = vi.fn(async () => {});
  close = vi.fn();
  rejectUpdate = false;
  request = vi.fn(async (method: string, p: any): Promise<any> => {
    if (method === "model/list") return { data: models };
    if (method === "thread/start") return { thread: { id: "thread-new" } };
    if (method === "thread/resume") return { thread: { id: p.threadId } };
    if (method === "thread/settings/update" && this.rejectUpdate)
      throw Error("runtime rejected");
    return {};
  });
}
describe("durable native settings", () => {
  let home: string, server: Server, host: CodexHost;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-controls-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  it("persists per chat across a new host and sends native settings", async () => {
    await host.updateSettings(10, {
      model: "two",
      effort: "high",
      mode: "plan",
    });
    expect(server.request).not.toHaveBeenCalledWith(
      "thread/start",
      expect.anything(),
    );
    expect(nativeSettings(await host.sessionSettings(10))).toMatchObject({
      model: "two",
      effort: "high",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "two",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
    });
    expect((await host.sessionSettings(11)).model).toBe("one");
    const restarted = new SessionSettingsStore(
      join(home, "session-settings.json"),
    );
    expect(restarted.get(10)).toMatchObject({
      model: "two",
      effort: "high",
      mode: "plan",
    });
    expect(restarted.get(11)).toEqual({});
  });
  it("rolls back rejected native changes and rejects concurrent controls", async () => {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({ 10: "persisted" }),
    );
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
    });
    await host.updateSettings(10, { model: "one" });
    server.rejectUpdate = true;
    const changing = host.updateSettings(10, { model: "two" });
    await expect(host.updateSettings(10, { effort: "high" })).rejects.toThrow(
      "Stop",
    );
    await expect(changing).rejects.toThrow("runtime rejected");
    expect((await host.sessionSettings(10)).model).toBe("one");
    expect(
      new SessionSettingsStore(join(home, "session-settings.json")).get(10)
        .model,
    ).toBe("one");
  });
  it("rejects invalid model capabilities before changing anything", () => {
    expect(() => validateSettings({ model: "absent" }, models)).toThrow(
      "not available",
    );
    expect(() =>
      validateSettings({ model: "one", effort: "ultra" }, models),
    ).toThrow("supports");
    expect(() =>
      validateSettings({ model: "two", personality: "friendly" }, models),
    ).toThrow("personality");
    expect(() =>
      validateSettings({ model: "one", serviceTier: "priority" }, models),
    ).toThrow("tier");
    expect(nativeSettings({ permission: "read-only" })).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly" },
    });
  });
  it("never lets /resume reach another HOAI chat's native history", async () => {
    await expect(host.resumeSavedThread(10, "foreign")).rejects.toThrow(
      "does not belong",
    );
    expect(server.request).not.toHaveBeenCalledWith(
      "thread/resume",
      expect.anything(),
    );
  });
  it("keeps internal routing and user ids out of the conversation picker", () => {
    expect(
      conversationLabel({
        preview:
          "HOAI event: assistant_id=12, sender_user_id=private\n\nMessage:\nBuild the dashboard",
      }),
    ).toBe("Build the dashboard");
    expect(
      conversationLabel({
        preview: "HOAI event: assistant_id=12, sender_user_id=private",
      }),
    ).toBe("Saved conversation");
    expect(
      conversationLabel({ name: "My project", preview: "HOAI event: private" }),
    ).toBe("My project");
    expect(
      conversationLabel({
        preview: "HOAI event: private",
        createdAt: 1789074000,
      }),
    ).toMatch(/^Conversation · /);
  });
});
