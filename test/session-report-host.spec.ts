/**
 * The host's ONE report seam and its five sources (P5 stage 7, C-26, S11,
 * S12, S14, S16).
 *
 * `CodexHost` tells its `onSessionSettings(chatId, report)` listener what a
 * chat is really running, from:
 *   (a) every successful `updateSettings` (it covers /model, /effort, /fast,
 *       /personality, /permissions and plan mode in one place, because each
 *       stores the pair the next turn runs on);
 *   (b) the runtime's `thread/settings/updated`;
 *   (c) the runtime's `model/rerouted`, flagged;
 *   (d) the `thread/start` and `thread/resume` responses inside ensureThread;
 *   (e) the next `turn/started` in a chat whose last report was a reroute,
 *       unflagged again.
 * With S12's precedence: a chat with a STORED model reports the store (the
 * plugin re-asserts it on every `turn/start`, so it is what runs), a chat
 * with nothing stored reports the runtime's own value, and the plugin's
 * catalog guess is never reported.
 *
 * The fake app server answers with the RECORDED 0.154.0 shapes
 * (test/fixtures/session-report-wire.json), only the thread id swapped for
 * the one the test maps.
 *
 * No em or en dashes anywhere in this file.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexHost } from "../src/codex-host.js";
import type { SessionReport } from "../src/session-report.js";

const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/session-report-wire.json", import.meta.url),
    "utf8",
  ),
);
const models = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"].map((model, i) => ({
  model,
  id: model,
  displayName: model,
  description: "",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high", "ultra"].map(
    (reasoningEffort) => ({ reasoningEffort, description: "" }),
  ),
  supportsPersonality: false,
  serviceTiers: [],
  isDefault: i === 0,
}));

/** The recorded response, with the id the test maps. */
function withThread(response: any, id: string): any {
  const copy = structuredClone(response);
  copy.thread.id = id;
  return copy;
}

class Server extends EventEmitter {
  onRequest: any;
  rejectUpdate = false;
  start = vi.fn(async () => {});
  close = vi.fn();
  request = vi.fn(async (method: string, p: any): Promise<any> => {
    if (method === "model/list") return { data: models };
    if (method === "thread/start")
      return withThread(wire.threadStartResponse, "thread-new");
    if (method === "thread/resume")
      return withThread(wire.threadResumeResponse, p.threadId);
    if (method === "turn/start") return { turn: { id: `turn-${p.threadId}` } };
    if (method === "thread/settings/update" && this.rejectUpdate)
      throw Error("runtime rejected");
    return {};
  });
  note(method: string, params: any) {
    this.emit("notification", method, params);
  }
  finish(threadId: string) {
    this.note("item/completed", {
      threadId,
      item: { id: "message", type: "agentMessage", text: "done" },
    });
    this.note("turn/completed", { threadId, turn: { status: "completed" } });
  }
}

/** Let every scheduled report land. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/** The recorded notification's settings, for a thread the test maps. */
function settingsUpdated(threadId: string, patch: Record<string, unknown> = {}) {
  return {
    threadId,
    threadSettings: {
      ...structuredClone(wire.threadSettingsUpdated.threadSettings),
      ...patch,
    },
  };
}
/** The schema's own fields (ModelReroutedNotification, 0.154.0). */
function rerouted(threadId: string, toModel = "gpt-5.5") {
  return {
    threadId,
    turnId: `turn-${threadId}`,
    fromModel: "gpt-6-astra",
    toModel,
    reason: "highRiskCyberActivity",
  };
}

describe("the host's report seam", () => {
  let home: string;
  let server: Server;
  let host: CodexHost;
  let seen: Array<[number, SessionReport]>;
  const listener = (chatId: number, report: SessionReport) => {
    seen.push([chatId, report]);
  };
  /** Drop the reportedAt stamps, which are the daemon's clock. */
  const values = () =>
    seen.map(([chatId, { reportedAt: _at, ...rest }]) => [chatId, rest]);

  function build(threads: Record<string, string> = {}) {
    writeFileSync(join(home, "threads.json"), JSON.stringify(threads));
    host?.close();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      tools: [],
      onSessionSettings: listener,
    } as any);
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-session-report-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    seen = [];
    build();
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  describe("(a) a settings change that LANDS", () => {
    it("fires the stored pair once, for a chat with no thread yet", async () => {
      await host.updateSettings(10, { model: "gpt-5.6-sol", effort: "high" });
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(values()).toEqual([
        [
          10,
          {
            model: "gpt-5.6-sol",
            effort: "high",
            serviceTier: null,
            rerouted: false,
          },
        ],
      ]);
      expect(seen[0]![1].reportedAt).toMatch(/Z$/);
    });

    it("fires the stored pair for a chat with a thread, after the runtime took it", async () => {
      build({ 10: "persisted" });
      await host.updateSettings(10, { model: "gpt-5.5", effort: "low" });
      await vi.waitFor(() =>
        expect(values()).toContainEqual([
          10,
          { model: "gpt-5.5", effort: "low", serviceTier: null, rerouted: false },
        ]),
      );
      expect(server.request).toHaveBeenCalledWith(
        "thread/settings/update",
        expect.objectContaining({ threadId: "persisted", model: "gpt-5.5" }),
      );
    });

    it("a change the runtime REFUSES fires nothing", async () => {
      build({ 10: "persisted" });
      server.rejectUpdate = true;
      await expect(
        host.updateSettings(10, { model: "gpt-5.5", effort: "low" }),
      ).rejects.toThrow("runtime rejected");
      await settle();
      // The resume inside ensureThread reports the runtime's own value (the
      // positive, so a seam that fires nothing cannot pass this case); the
      // refused pair never appears.
      expect(values().map(([, v]) => (v as any).model)).toContain("gpt-5.6-sol");
      expect(values().map(([, v]) => (v as any).model)).not.toContain("gpt-5.5");
    });

    it("a change refused while busy, or invalid, fires nothing", async () => {
      await expect(
        host.updateSettings(10, { model: "absent-model" }),
      ).rejects.toThrow("not available");
      const first = host.updateSettings(10, { model: "gpt-5.6-sol" });
      await expect(host.updateSettings(10, { effort: "high" })).rejects.toThrow(
        "Stop",
      );
      await first;
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      await settle();
      expect(seen).toHaveLength(1);
      expect(seen[0]![1].model).toBe("gpt-5.6-sol");
    });
  });

  describe("(d) the thread's own answer when it is started or resumed", () => {
    it("thread/start: a chat with nothing stored reports the runtime's config default", async () => {
      const turn = host.runTurn(10, "hi");
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(values()).toEqual([
        [
          10,
          {
            model: "gpt-6-astra",
            effort: "ultra",
            serviceTier: null,
            rerouted: false,
          },
        ],
      ]);
      server.finish("thread-new");
      await turn;
    });

    it("thread/resume: a chat with nothing stored reports the thread's own pair", async () => {
      build({ 10: "persisted" });
      const turn = host.runTurn(10, "hi");
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(values()).toEqual([
        [
          10,
          {
            model: "gpt-5.6-sol",
            effort: "medium",
            serviceTier: null,
            rerouted: false,
          },
        ],
      ]);
      server.finish("persisted");
      await turn;
    });

    it("a chat with a stored model reports the STORE, whatever the runtime answered", async () => {
      build({ 10: "persisted" });
      await host.updateSettings(10, { model: "gpt-5.5", effort: "high" });
      await settle();
      seen = [];
      host.resetChat(10);
      const turn = host.runTurn(10, "hi");
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
      for (const [, report] of seen) {
        expect(report.model).toBe("gpt-5.5");
        expect(report.effort).toBe("high");
      }
      server.finish("thread-new");
      await turn;
    });

    it("an already loaded thread is not re-reported on every turn", async () => {
      const one = host.runTurn(10, "hi");
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      server.finish("thread-new");
      await one;
      const two = host.runTurn(10, "again");
      await vi.waitFor(() =>
        expect(
          server.request.mock.calls.filter(([m]) => m === "turn/start"),
        ).toHaveLength(2),
      );
      server.finish("thread-new");
      await two;
      expect(seen).toHaveLength(1);
    });
  });

  describe("(b) the runtime's thread/settings/updated", () => {
    it("reports the runtime's value for a mapped chat with nothing stored", async () => {
      build({ 10: "persisted" });
      server.note("thread/settings/updated", settingsUpdated("persisted"));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(values()).toEqual([
        [
          10,
          {
            model: "gpt-5.6-sol",
            effort: "medium",
            serviceTier: null,
            rerouted: false,
          },
        ],
      ]);
    });

    it("reports the STORED pair for a chat with a stored model (S12)", async () => {
      build({ 10: "persisted" });
      await host.updateSettings(10, { model: "gpt-5.5", effort: "high" });
      await settle();
      seen = [];
      server.note(
        "thread/settings/updated",
        settingsUpdated("persisted", { model: "gpt-6-astra", effort: "ultra" }),
      );
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(values()).toEqual([
        [10, { model: "gpt-5.5", effort: "high", serviceTier: null, rerouted: false }],
      ]);
    });

    it("an unmapped thread (a detached or ephemeral one) reports nothing", async () => {
      build({ 10: "persisted" });
      server.note("thread/settings/updated", settingsUpdated("ephemeral-1"));
      server.note("model/rerouted", rerouted("ephemeral-1"));
      await settle();
      expect(seen).toEqual([]);
      // The same notification for the MAPPED thread does report, once.
      server.note("thread/settings/updated", settingsUpdated("persisted"));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]![0]).toBe(10);
    });

    it("fires while a turn is running: the branch sits above the turn guard", async () => {
      build({ 10: "persisted" });
      const turn = host.runTurn(10, "hi");
      await vi.waitFor(() => expect(host.isBusy(10)).toBe(true));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      server.note(
        "thread/settings/updated",
        settingsUpdated("persisted", { model: "gpt-5.5", effort: "low" }),
      );
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(values()[1]).toEqual([
        10,
        { model: "gpt-5.5", effort: "low", serviceTier: null, rerouted: false },
      ]);
      server.finish("persisted");
      await turn;
    });
  });

  describe("(c) model/rerouted and (e) the next turn", () => {
    it("reports the model that ran, flagged, with the last effort", async () => {
      build({ 10: "persisted" });
      server.note("thread/settings/updated", settingsUpdated("persisted"));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      server.note("model/rerouted", rerouted("persisted"));
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(values()[1]).toEqual([
        10,
        { model: "gpt-5.5", effort: "medium", serviceTier: null, rerouted: true },
      ]);
    });

    it("the next turn/started reports the last runtime pair again, unflagged", async () => {
      build({ 10: "persisted" });
      server.note("thread/settings/updated", settingsUpdated("persisted"));
      server.note("model/rerouted", rerouted("persisted"));
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      server.note("turn/started", {
        threadId: "persisted",
        turn: { id: "turn-next" },
      });
      await vi.waitFor(() => expect(seen).toHaveLength(3));
      expect(values()[2]).toEqual([
        10,
        { model: "gpt-5.6-sol", effort: "medium", serviceTier: null, rerouted: false },
      ]);
      // A second turn with no reroute between reports nothing more.
      server.note("turn/started", {
        threadId: "persisted",
        turn: { id: "turn-after" },
      });
      await settle();
      expect(seen).toHaveLength(3);
    });

    it("for a chat with a stored model the next turn reports the STORE", async () => {
      build({ 10: "persisted" });
      await host.updateSettings(10, { model: "gpt-6-astra", effort: "high" });
      server.note("model/rerouted", rerouted("persisted"));
      await vi.waitFor(() =>
        expect(values().some(([, v]) => (v as any).rerouted)).toBe(true),
      );
      const before = seen.length;
      server.note("turn/started", {
        threadId: "persisted",
        turn: { id: "turn-next" },
      });
      await vi.waitFor(() => expect(seen.length).toBe(before + 1));
      expect(values().at(-1)).toEqual([
        10,
        { model: "gpt-6-astra", effort: "high", serviceTier: null, rerouted: false },
      ]);
    });

    it("a turn/started in a chat that was never rerouted reports nothing", async () => {
      build({ 10: "persisted" });
      server.note("thread/settings/updated", settingsUpdated("persisted"));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      seen = [];
      server.note("turn/started", {
        threadId: "persisted",
        turn: { id: "turn-plain" },
      });
      await settle();
      expect(seen).toEqual([]);
    });

    it("a reroute to a model that fails the pattern reports nothing", async () => {
      build({ 10: "persisted" });
      server.note("model/rerouted", rerouted("persisted", "gpt 5"));
      await settle();
      expect(seen).toEqual([]);
      // The same reroute to a model the route accepts does report.
      server.note("model/rerouted", rerouted("persisted"));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]![1]).toMatchObject({ model: "gpt-5.5", rerouted: true });
    });
  });

  describe("the connect sweep's source", () => {
    it("lists a report for every stored chat with a model, and only those", async () => {
      await host.updateSettings(10, { model: "gpt-5.5", effort: "low" });
      await host.updateSettings(11, { model: "gpt-5.6-sol", effort: "medium" });
      const reports = host.storedSessionReports();
      expect(
        reports
          .map(([chatId, { reportedAt: _at, ...rest }]) => [chatId, rest])
          .sort(),
      ).toEqual([
        [10, { model: "gpt-5.5", effort: "low", serviceTier: null, rerouted: false }],
        [11, { model: "gpt-5.6-sol", effort: "medium", serviceTier: null, rerouted: false }],
      ]);
    });

    it("skips a stored chat with no model", () => {
      writeFileSync(
        join(home, "session-settings.json"),
        JSON.stringify({ 12: { mode: "plan" }, 13: { model: "gpt-5.5" } }),
      );
      build();
      expect(host.storedSessionReports().map(([chatId]) => chatId)).toEqual([13]);
    });
  });
});

describe("CONTROL: a host with no listener behaves exactly as before", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-session-report-off-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("changes, starts and notifications run with nothing to tell", async () => {
    const server = new Server();
    writeFileSync(join(home, "threads.json"), JSON.stringify({ 10: "persisted" }));
    const host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      tools: [],
    });
    try {
      await host.updateSettings(10, { model: "gpt-5.5", effort: "low" });
      server.note("thread/settings/updated", settingsUpdated("persisted"));
      server.note("model/rerouted", rerouted("persisted"));
      server.note("turn/started", { threadId: "persisted", turn: { id: "t" } });
      const turn = host.runTurn(11, "hi");
      await vi.waitFor(() =>
        expect(server.request).toHaveBeenCalledWith(
          "turn/start",
          expect.objectContaining({ threadId: "thread-new" }),
        ),
      );
      server.finish("thread-new");
      await expect(turn).resolves.toMatchObject({ turnCompleted: true });
    } finally {
      host.close();
    }
  });
});
