/**
 * The adapter's half of the model and effort report (P5 stage 7, C-26, S15):
 * the host says WHAT a chat is running, the adapter decides whether and when
 * it leaves, and `BgosApi.reportSessionSettings` is the one place the route
 * is built.
 *
 *  - The listener names the chat's assistant (`assistantForChat`) and sends
 *    nothing for a chat whose agent it cannot name.
 *  - An unchanged value (reportedAt aside) is not sent again; a failed send
 *    forgets its key so the next source retries.
 *  - Two reports for one chat leave in order, never racing (the backend's
 *    last write wins, so order is the daemon's job).
 *  - At connect, after identity and never awaited, every stored chat with a
 *    model is reported, one chat at a time, FORCED (the dedupe map is empty
 *    at boot and the app may be drawing a value from the daemon that died).
 *  - A 404 from an older backend, or any other failure, is swallowed: a row
 *    the app cannot draw never costs a turn or a boot.
 *
 * The first case drives a REAL adapter and a REAL host: a runtime
 * notification in, the PATCH out.
 *
 * No em or en dashes anywhere in this file.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import { BgosApi } from "../src/bgos-api.js";
import type { SessionReport } from "../src/session-report.js";

const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/session-report-wire.json", import.meta.url),
    "utf8",
  ),
);

let home: string;
const envBefore = process.env.CODEX_BGOS_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-session-report-wiring-"));
  process.env.CODEX_BGOS_HOME = home;
});
afterEach(() => {
  if (envBefore === undefined) delete process.env.CODEX_BGOS_HOME;
  else process.env.CODEX_BGOS_HOME = envBefore;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const settle = () => new Promise((r) => setTimeout(r, 10));

function report(patch: Partial<SessionReport> = {}): SessionReport {
  return {
    model: "gpt-5.6-sol",
    effort: "medium",
    serviceTier: null,
    rerouted: false,
    reportedAt: "2026-09-26T09:30:00.000Z",
    ...patch,
  };
}

/** A deferred promise, to hold a PATCH open. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A real adapter over a temp home, with the HTTP call replaced. */
function realAdapter(owned: Array<[number, string]>, threads = {}) {
  writeFileSync(join(home, "threads.json"), JSON.stringify(threads));
  const adapter = new CodexAdapter(
    {
      baseUrl: "http://127.0.0.1:9",
      pairingToken: "t".repeat(32),
      reconnect: { initialDelayMs: 1, maxDelayMs: 2 },
    } as any,
    { ok: true, mode: "chatgpt", label: "codex login (test)" },
  ) as any;
  for (const [id, route] of owned) adapter.assistantToRoute.set(id, route);
  adapter.identityReady = true;
  const sent = vi.fn(async () => {});
  adapter.api.reportSessionSettings = sent;
  return { adapter, sent };
}

describe("the listener: a report the host makes reaches BGOS as the chat's own agent", () => {
  it("a runtime notification in, the PATCH out (real adapter, real host)", async () => {
    const { adapter, sent } = realAdapter([[10, "codex"]], { 20: "thread-20" });
    adapter.host.notification("thread/settings/updated", {
      ...structuredClone(wire.threadSettingsUpdated),
      threadId: "thread-20",
    });
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent).toHaveBeenCalledWith(
      10,
      20,
      expect.objectContaining({
        model: "gpt-5.6-sol",
        effort: "medium",
        serviceTier: null,
        rerouted: false,
      }),
    );
    adapter.host.close();
  });

  it("names the agent from the chat, and sends nothing for a chat it cannot name", async () => {
    const { adapter, sent } = realAdapter([
      [10, "codex"],
      [11, "codex-2"],
    ]);
    adapter.noteSessionSettings(20, report());
    await settle();
    expect(sent).not.toHaveBeenCalled();
    adapter.chatToAssistant.set(20, 11);
    adapter.noteSessionSettings(20, report());
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent).toHaveBeenCalledWith(11, 20, report());
    adapter.host.close();
  });

  it("the host's option is the adapter's listener", () => {
    const source = readFileSync("src/adapter.ts", "utf8");
    expect(source).toContain(
      "onSessionSettings: (chatId, report) =>\n        this.noteSessionSettings(chatId, report),",
    );
  });
});

describe("the send: dedupe, order, forget on failure, never a throw", () => {
  function harness() {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const sent = vi.fn(async (..._args: unknown[]) => {});
    Object.assign(adapter, { api: { reportSessionSettings: sent } });
    return { adapter, sent };
  }

  it("an unchanged value is not sent again, whatever its time", async () => {
    const { adapter, sent } = harness();
    await adapter.reportSessionSettings(10, 20, report());
    await adapter.reportSessionSettings(
      10,
      20,
      report({ reportedAt: "2026-09-26T09:31:00.000Z" }),
    );
    expect(sent).toHaveBeenCalledTimes(1);
    await adapter.reportSessionSettings(10, 20, report({ effort: "high" }));
    await adapter.reportSessionSettings(10, 20, report({ rerouted: true }));
    await adapter.reportSessionSettings(10, 20, report());
    expect(sent).toHaveBeenCalledTimes(4);
    // Per chat: another chat's identical value is its own report.
    await adapter.reportSessionSettings(10, 21, report());
    expect(sent).toHaveBeenCalledTimes(5);
  });

  it("a failed send forgets its key, so the next source retries", async () => {
    const { adapter, sent } = harness();
    sent.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { response: { status: 404 } }),
    );
    await expect(
      adapter.reportSessionSettings(10, 20, report()),
    ).resolves.toBeUndefined();
    await adapter.reportSessionSettings(10, 20, report());
    expect(sent).toHaveBeenCalledTimes(2);
    await adapter.reportSessionSettings(10, 20, report());
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("a network error is swallowed too, and the listener never throws", async () => {
    const { adapter, sent } = harness();
    sent.mockRejectedValue(new Error("ECONNREFUSED"));
    Object.assign(adapter, {
      assistantForChat: () => 10,
    });
    expect(() => adapter.noteSessionSettings(20, report())).not.toThrow();
    await settle();
    await expect(
      adapter.reportSessionSettings(10, 20, report({ effort: "low" })),
    ).resolves.toBeUndefined();
  });

  it("two reports for one chat leave in order: the second waits for the first", async () => {
    const { adapter, sent } = harness();
    const first = deferred();
    sent.mockImplementationOnce(() => first.promise);
    const a = adapter.reportSessionSettings(10, 20, report({ effort: "low" }));
    const b = adapter.reportSessionSettings(10, 20, report({ effort: "high" }));
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![2]).toMatchObject({ effort: "low" });
    first.resolve();
    await Promise.all([a, b]);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1]![2]).toMatchObject({ effort: "high" });
  });

  it("another chat is not held behind the first chat's slow report", async () => {
    const { adapter, sent } = harness();
    const first = deferred();
    sent.mockImplementationOnce(() => first.promise);
    const a = adapter.reportSessionSettings(10, 20, report());
    await adapter.reportSessionSettings(10, 21, report());
    expect(sent).toHaveBeenCalledTimes(2);
    first.resolve();
    await a;
  });

  it("forced sends the same value again (the connect cutover)", async () => {
    const { adapter, sent } = harness();
    await adapter.reportSessionSettings(10, 20, report());
    await adapter.reportSessionSettings(10, 20, report(), { force: true });
    expect(sent).toHaveBeenCalledTimes(2);
  });
});

describe("the connect sweep", () => {
  /**
   * The real `start()` against a daemon made of stubs (the
   * adapter-plan-sweep-wiring.spec.ts shape), with the host's stored reports
   * given and the PATCH held open by the test.
   */
  function fixture(
    stored: Array<[number, SessionReport]>,
    identity = true,
  ) {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const sent = vi.fn(async (..._args: unknown[]) => {});
    Object.assign(adapter, {
      started: false,
      fatalLatched: true,
      ownerId: "owner-1",
      host: {
        preflight: vi.fn(async () => {}),
        storedSessionReports: vi.fn(() => stored),
      },
      ws: {
        on: vi.fn(),
        connect: vi.fn(async () => {}),
        triggerBackfill: vi.fn(async () => {}),
        connectedSince: null,
      },
      heartbeat: { start: vi.fn(), recordInbound: vi.fn() },
      outbound: {},
      toolProgress: {},
      api: { reportSessionSettings: sent },
      planLane: { adopt: vi.fn() },
      assistantToRoute: new Map([[10, "codex"]]),
      chatToAssistant: new Map(),
      identityReady: false,
      loadServedCapabilities: vi.fn(async () => {}),
      refreshIdentity: vi.fn(async () => identity),
      scheduleIdentityRetry: vi.fn(),
      startPollLoop: vi.fn(),
      reportStoredPlanModes: vi.fn(async () => {}),
      sweepMissedPlanAnswers: vi.fn(async () => {}),
      sweepOrphanedApprovals: vi.fn(async () => {}),
    });
    return { adapter, sent };
  }

  it("runs after identity, never awaited, one chat at a time, forced", async () => {
    const { adapter, sent } = fixture([
      [20, report()],
      [21, report({ model: "gpt-5.5", effort: "low" })],
    ]);
    // A value the dedupe map already holds for chat 20: forced sends it anyway.
    await adapter.reportSessionSettings(10, 20, report());
    sent.mockClear();
    const first = deferred();
    sent.mockImplementationOnce(() => first.promise);

    await adapter.start();
    // start() is back while the first report is still in flight.
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent).toHaveBeenCalledWith(10, 20, report());
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(sent.mock.calls[1]).toEqual([
      10,
      21,
      report({ model: "gpt-5.5", effort: "low" }),
    ]);
    expect(adapter.refreshIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.host.storedSessionReports.mock.invocationCallOrder[0],
    );
    clearInterval(adapter.spoolTimer);
  });

  it("does not run when identity fails (the chat's agent is unknown)", async () => {
    // The positive first: the same fixture with identity DOES sweep.
    const ok = fixture([[20, report()]], true);
    await ok.adapter.start();
    await vi.waitFor(() => expect(ok.sent).toHaveBeenCalledTimes(1));
    clearInterval(ok.adapter.spoolTimer);

    const { adapter, sent } = fixture([[20, report()]], false);
    await adapter.start();
    await settle();
    expect(adapter.host.storedSessionReports).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    clearInterval(adapter.spoolTimer);
  });

  it("a host that cannot list its stored chats never breaks the boot", async () => {
    const { adapter } = fixture([]);
    adapter.host.storedSessionReports = vi.fn(() => {
      throw new Error("store unreadable");
    });
    await expect(adapter.start()).resolves.toBeUndefined();
    await settle();
    // It was asked, and it threw: the boot went on regardless.
    expect(adapter.host.storedSessionReports).toHaveBeenCalledTimes(1);
    clearInterval(adapter.spoolTimer);
  });
});

describe("BgosApi.reportSessionSettings: the route, built in one place", () => {
  it("PATCHes the chat's session-settings route with the five fields in order", async () => {
    const api = new BgosApi({
      baseUrl: "http://127.0.0.1:9",
      pairingToken: "t".repeat(32),
    } as any) as any;
    const request = vi.fn(async () => ({ data: { ok: true, applied: true } }));
    api.http = { request };
    // Given in a scrambled order: the body is built from the named fields.
    await api.reportSessionSettings(111, 222, {
      reportedAt: "2026-09-26T09:30:00.000Z",
      rerouted: false,
      serviceTier: null,
      effort: "medium",
      model: "gpt-5.6-sol",
      extra: "never sent",
    });
    expect(request).toHaveBeenCalledTimes(1);
    const call = (request.mock.calls[0] as any[])[0];
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe(
      "integrations/assistants/111/chats/222/session-settings",
    );
    expect(Object.keys(call.data)).toEqual([
      "model",
      "effort",
      "serviceTier",
      "rerouted",
      "reportedAt",
    ]);
    expect(call.data).toEqual({
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      rerouted: false,
      reportedAt: "2026-09-26T09:30:00.000Z",
    });
  });
});
