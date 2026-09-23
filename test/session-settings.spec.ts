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
  /**
   * PLAN MODE IS TWO SETTINGS, and only one of them refuses a write.
   *
   * The live probe of 2026-09-23 ran `exec_command` and wrote a file with
   * `collaborationMode: { mode: "plan" }` on the thread and on the turn, with
   * no approval raised, because the mode rewrites `developer_instructions` and
   * leaves `sandboxPolicy` alone. So `/plan` sets the read only sandbox too,
   * and `enforced` is measured off what was actually stored.
   */
  it("sets the sandbox with the mode, and gives the access back", async () => {
    await host.updateSettings(10, { model: "one" });
    expect(await host.setPlanMode(10, true)).toEqual({ enforced: true });
    const planning = await host.sessionSettings(10);
    expect(planning.mode).toBe("plan");
    expect(planning.permission).toBe("read-only");
    expect(nativeSettings(planning)).toMatchObject({
      sandboxPolicy: { type: "readOnly" },
      collaborationMode: { mode: "plan" },
    });
    expect(host.planWaitEnforcedIn(10)).toBe(true);

    expect(await host.setPlanMode(10, false)).toEqual({ enforced: false });
    const coding = await host.sessionSettings(10);
    expect(coding.mode).toBe("default");
    expect(coding.permission).toBe("workspace");
    expect(coding.permissionBeforePlan).toBeUndefined();
    expect(host.planWaitEnforcedIn(10)).toBe(false);
  });

  it("carries the lock, and the memory, across a daemon restart", async () => {
    // Chat 10 was narrowed by the owner; chat 11 is an ordinary workspace
    // chat. Both go into plan mode, then the daemon dies mid plan.
    await host.updateSettings(10, { model: "one", permission: "read-only" });
    await host.updateSettings(11, { model: "one" });
    await host.setPlanMode(10, true);
    await host.setPlanMode(11, true);
    const restarted = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: new Server() as any,
    });
    try {
      expect(restarted.planModeChats().sort()).toEqual([10, 11]);
      // Reported as real locks, because they still are: both halves came off
      // disk together.
      expect(restarted.planWaitEnforcedIn(10)).toBe(true);
      expect(restarted.planWaitEnforcedIn(11)).toBe(true);
      await restarted.setPlanMode(10, false);
      await restarted.setPlanMode(11, false);
      // The owner's narrowing survives Go ahead.
      expect((await restarted.sessionSettings(10)).permission).toBe("read-only");
      // And the ordinary chat gets its workspace back. WITHOUT THE MEMORY ON
      // DISK this is where it stays read only for ever: the only permission a
      // restarted daemon can see is the one plan mode itself wrote.
      expect((await restarted.sessionSettings(11)).permission).toBe("workspace");
    } finally {
      restarted.close();
    }
  });

  it("keeps plan mode when the runtime refuses the sandbox, and says it is not enforced", async () => {
    // A plan mode with no lock is worse than no plan mode only if we LIE about
    // it. `updateSettings` rolls the whole patch back and throws, so the pair
    // is retried as the mode alone and the honest false goes to the app.
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
    let seen = 0;
    server.request.mockImplementation(async (method: string, p: any) => {
      if (method === "model/list") return { data: models };
      if (method === "thread/start") return { thread: { id: "thread-new" } };
      if (method === "thread/resume") return { thread: { id: p.threadId } };
      if (method === "thread/settings/update") {
        seen += 1;
        // Refuse the READ ONLY sandbox specifically, which is the half the
        // pair adds. The retry still carries the chat's existing workspace
        // sandbox and is taken.
        if (p.sandboxPolicy?.type === "readOnly")
          throw new Error("sandbox refused");
      }
      return {};
    });
    expect(await host.setPlanMode(10, true)).toEqual({ enforced: false });
    expect(seen).toBe(2);
    const settings = await host.sessionSettings(10);
    expect(settings.mode).toBe("plan");
    expect(settings.permission).toBe("workspace");
    expect(host.planWaitEnforcedIn(10)).toBe(false);
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

describe("the chats this daemon has left in plan mode", () => {
  /**
   * Codex's mode is per chat and persisted, so a daemon that restarts comes
   * back with chats still in plan mode and an app drawing no chip for any of
   * them. The store had no way to enumerate itself, which is why it could not
   * be reported at connect.
   */
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-plan-store-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("lists every chat it has a setting for, cleaned", () => {
    const file = join(home, "settings.json");
    const store = new SessionSettingsStore(file);
    store.set(20, { mode: "plan", model: "one" });
    store.set(21, { mode: "default", model: "one" });
    store.set(22, { model: "one" });
    expect(new SessionSettingsStore(file).entries().sort()).toEqual([
      [20, { mode: "plan", model: "one" }],
      [21, { mode: "default", model: "one" }],
      [22, { model: "one" }],
    ]);
  });

  it("keeps the permission plan mode is holding for the owner", () => {
    // THE MEMORY SURVIVES A RESTART, which is the reason it is a stored field
    // and not a Map in the daemon. A daemon that stops mid plan and comes back
    // has to know what to hand over on Go ahead; without this, the restore
    // would be a hardcoded "workspace" that widens a chat the owner narrowed.
    const file = join(home, "settings.json");
    const store = new SessionSettingsStore(file);
    store.set(20, { mode: "plan", permission: "read-only", permissionBeforePlan: "workspace" });
    expect(new SessionSettingsStore(file).get(20)).toEqual({
      mode: "plan",
      permission: "read-only",
      permissionBeforePlan: "workspace",
    });
    // Whitelisted like the rest: a value this store does not know is dropped
    // rather than written back out.
    store.set(21, { permissionBeforePlan: "sudo" } as never);
    expect(new SessionSettingsStore(file).get(21)).toEqual({});
  });

  it("never sends the remembered permission to the runtime", () => {
    // It is the daemon's own bookkeeping. `thread/settings/update` would not
    // know what to do with it, and a settings update the runtime rejects rolls
    // the whole patch back.
    expect(
      nativeSettings({
        model: "one",
        permission: "read-only",
        permissionBeforePlan: "workspace",
      }),
    ).not.toHaveProperty("permissionBeforePlan");
  });

  it("gives back a copy, so a caller cannot edit the store through it", () => {
    const store = new SessionSettingsStore(join(home, "settings.json"));
    store.set(20, { mode: "plan" });
    const entry = store.entries()[0]![1];
    entry.mode = "default";
    expect(store.get(20).mode).toBe("plan");
  });
});
