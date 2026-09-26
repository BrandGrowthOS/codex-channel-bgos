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
import {
  SESSION_REPORT_RETRY_FIRST_MS,
  SESSION_REPORT_RETRY_MAX_MS,
  type SessionReport,
} from "../src/session-report.js";

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
    const store = new Map<number, SessionReport>(stored);
    Object.assign(adapter, {
      started: false,
      fatalLatched: true,
      ownerId: "owner-1",
      host: {
        preflight: vi.fn(async () => {}),
        // The sweep lists the chats up front and builds each chat's report
        // when its turn comes (Phase B, decision 1): the map below is the
        // store as it is at that moment.
        storedSessionChats: vi.fn(() => [...store.keys()]),
        storedSessionReport: vi.fn((chatId: number) => store.get(chatId) ?? null),
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
    return { adapter, sent, store };
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
      adapter.host.storedSessionChats.mock.invocationCallOrder[0],
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
    expect(adapter.host.storedSessionChats).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    clearInterval(adapter.spoolTimer);
  });

  it("a host that cannot list its stored chats never breaks the boot", async () => {
    const { adapter } = fixture([]);
    adapter.host.storedSessionChats = vi.fn(() => {
      throw new Error("store unreadable");
    });
    await expect(adapter.start()).resolves.toBeUndefined();
    await settle();
    // It was asked, and it threw: the boot went on regardless.
    expect(adapter.host.storedSessionChats).toHaveBeenCalledTimes(1);
    clearInterval(adapter.spoolTimer);
  });
});

/**
 * P5 stage 7, Phase B, decision 1: the connect sweep can never overwrite a
 * newer report. Each chat's report is built when its turn in the sweep comes,
 * from the store as it is THEN, and a chat that already had a live report in
 * this process (one sent after the sweep began, or during the boot backfill
 * before it) is skipped: that report is this process's truth, and a forced
 * boot snapshot landing after it would be the last write and win.
 */
describe("Phase B: the sweep never overwrites a newer report", () => {
  function sweepFixture(stored: Array<[number, SessionReport]>) {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const sent = vi.fn(async (..._args: unknown[]) => {});
    const store = new Map<number, SessionReport>(stored);
    Object.assign(adapter, {
      api: { reportSessionSettings: sent },
      host: {
        storedSessionChats: vi.fn(() => [...store.keys()]),
        storedSessionReport: vi.fn((chatId: number) => store.get(chatId) ?? null),
      },
      assistantToRoute: new Map([[10, "codex"]]),
      chatToAssistant: new Map(),
      identityReady: true,
    });
    return { adapter, sent, store };
  }

  it("builds a chat's report when its turn comes, from the store as it is then", async () => {
    const { adapter, sent, store } = sweepFixture([
      [20, report()],
      [21, report({ model: "gpt-5.5", effort: "low" })],
    ]);
    const first = deferred();
    sent.mockImplementationOnce(() => first.promise);
    const sweep = adapter.reportStoredSessionSettings();
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    // While chat 20's PATCH is out, chat 21's store moves (a /model that
    // landed): the sweep must send the store as it is now, not at boot.
    store.set(21, report({ model: "gpt-6-astra", effort: "high" }));
    first.resolve();
    await sweep;
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1]![2]).toMatchObject({
      model: "gpt-6-astra",
      effort: "high",
    });
    expect(adapter.host.storedSessionReport).toHaveBeenCalledWith(21);
  });

  it("skips a chat whose live report was sent after the sweep began", async () => {
    const { adapter, sent } = sweepFixture([
      [20, report()],
      [21, report({ model: "gpt-5.5", effort: "low" })],
    ]);
    const first = deferred();
    sent.mockImplementationOnce(() => first.promise);
    const sweep = adapter.reportStoredSessionSettings();
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    // The owner's /model lands in chat 21 mid sweep: the live report goes.
    adapter.noteSessionSettings(21, report({ model: "gpt-5.5", effort: "high" }));
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    first.resolve();
    await sweep;
    await settle();
    // And the sweep's forced boot value for chat 21 never follows it.
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1]).toEqual([
      10,
      21,
      report({ model: "gpt-5.5", effort: "high" }),
    ]);
  });

  it("skips a chat whose live report went out before it began (the boot backfill's turn)", async () => {
    const { adapter, sent } = sweepFixture([[20, report()]]);
    adapter.noteSessionSettings(20, report({ model: "gpt-5.5", rerouted: true }));
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    await adapter.reportStoredSessionSettings();
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![2]).toMatchObject({ rerouted: true });
  });

  it("CONTROL: a chat with no live report is still swept, forced", async () => {
    const { adapter, sent } = sweepFixture([[20, report()]]);
    await adapter.reportSessionSettings(10, 20, report());
    sent.mockClear();
    await adapter.reportStoredSessionSettings();
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

/**
 * P5 stage 7, Phase B, decision 3: a failed report is RETRIED, per chat,
 * with a backoff that holds only the chat's latest value. The report is
 * idempotent (last write wins, an unchanged value is a no op), so a timeout
 * or a 5xx is safe to repeat; a refusal (4xx: an older backend's 404, a 400,
 * a 403) is permanent and is not.
 */
describe("Phase B: a failed report is retried, holding only the latest value", () => {
  function harness() {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const sent = vi.fn(async (..._args: unknown[]) => {});
    Object.assign(adapter, { api: { reportSessionSettings: sent } });
    return { adapter, sent };
  }
  const network = () => Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
  const http = (status: number) =>
    Object.assign(new Error(`HTTP ${status}`), { response: { status } });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a network failure is sent again after the first backoff, then stops once it lands", async () => {
    const { adapter, sent } = harness();
    sent.mockRejectedValueOnce(network());
    await adapter.reportSessionSettings(10, 20, report());
    expect(sent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SESSION_REPORT_RETRY_FIRST_MS - 1);
    expect(sent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1]).toEqual([10, 20, report()]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("a newer value arriving while one waits replaces it: only the latest is retried", async () => {
    const { adapter, sent } = harness();
    sent.mockRejectedValueOnce(http(503)).mockRejectedValueOnce(http(502));
    await adapter.reportSessionSettings(10, 20, report({ effort: "low" }));
    await adapter.reportSessionSettings(10, 20, report({ effort: "high" }));
    expect(sent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SESSION_REPORT_RETRY_MAX_MS);
    expect(sent).toHaveBeenCalledTimes(3);
    expect(sent.mock.calls[2]![2]).toMatchObject({ effort: "high" });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it("a later value that LANDS drops the waiting one: nothing older is ever re-sent", async () => {
    const { adapter, sent } = harness();
    sent.mockRejectedValueOnce(network());
    await adapter.reportSessionSettings(10, 20, report({ effort: "low" }));
    await adapter.reportSessionSettings(10, 20, report({ effort: "high" }));
    expect(sent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("the backoff doubles and is capped", async () => {
    const { adapter, sent } = harness();
    sent.mockRejectedValue(network());
    await adapter.reportSessionSettings(10, 20, report());
    const at: number[] = [];
    const start = Date.now();
    for (let i = 0; i < 12; i += 1) {
      const before = sent.mock.calls.length;
      while (sent.mock.calls.length === before)
        await vi.advanceTimersByTimeAsync(250);
      at.push(Date.now() - start);
    }
    const gaps = at.map((t, i) => t - (i === 0 ? 0 : at[i - 1]!));
    expect(gaps[0]).toBe(SESSION_REPORT_RETRY_FIRST_MS);
    expect(gaps[1]).toBe(SESSION_REPORT_RETRY_FIRST_MS * 2);
    expect(gaps[2]).toBe(SESSION_REPORT_RETRY_FIRST_MS * 4);
    expect(Math.max(...gaps)).toBe(SESSION_REPORT_RETRY_MAX_MS);
    expect(gaps.at(-1)).toBe(SESSION_REPORT_RETRY_MAX_MS);
  });

  it("a refusal is not retried: 400, 403, 404", async () => {
    for (const status of [400, 403, 404]) {
      const { adapter, sent } = harness();
      sent.mockRejectedValueOnce(http(status));
      await adapter.reportSessionSettings(10, 20, report());
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(sent).toHaveBeenCalledTimes(1);
    }
  });

  it("a 5xx, a 429 and a timeout are retried", async () => {
    for (const error of [
      http(500),
      http(429),
      Object.assign(new Error("timeout"), { code: "ECONNABORTED" }),
    ]) {
      const { adapter, sent } = harness();
      sent.mockRejectedValueOnce(error);
      await adapter.reportSessionSettings(10, 20, report());
      await vi.advanceTimersByTimeAsync(SESSION_REPORT_RETRY_FIRST_MS);
      expect(sent).toHaveBeenCalledTimes(2);
    }
  });

  it("per chat: another chat's failure never holds or re-sends this one", async () => {
    const { adapter, sent } = harness();
    sent.mockRejectedValueOnce(network());
    await adapter.reportSessionSettings(10, 20, report());
    await adapter.reportSessionSettings(10, 21, report());
    await vi.advanceTimersByTimeAsync(SESSION_REPORT_RETRY_FIRST_MS);
    expect(sent.mock.calls.map((c) => c[1])).toEqual([20, 21, 20]);
  });

  it("clearing the retries (stop, a revoked pairing) cancels every waiting one", async () => {
    const { adapter, sent } = harness();
    sent.mockRejectedValueOnce(network());
    await adapter.reportSessionSettings(10, 20, report());
    adapter.clearSessionReportRetries();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent).toHaveBeenCalledTimes(1);
    const source = readFileSync("src/adapter.ts", "utf8");
    const stop = source.slice(source.indexOf("  async stop(): Promise<void> {"));
    expect(stop.slice(0, stop.indexOf("\n  }\n"))).toContain(
      "this.clearSessionReportRetries();",
    );
    const latch = source.slice(source.indexOf("  private enterFatalLatch("));
    expect(latch.slice(0, latch.indexOf("\n  }\n"))).toContain(
      "this.clearSessionReportRetries();",
    );
  });
});

/**
 * P5 stage 7, Phase B, decision 3, second half: the connect sweep covers
 * EVERY agent this daemon serves. On a daemon with several agents a chat's
 * agent is known only from an event that named both, and the in memory map is
 * empty at boot, so the pair is also kept on disk (chat-assistants.json) and
 * the sweep reads it back, for an agent this daemon still owns.
 */
describe("Phase B: the sweep covers every agent a daemon serves", () => {
  it("names each stored chat's agent from the pairs kept on disk", async () => {
    writeFileSync(
      join(home, "session-settings.json"),
      JSON.stringify({
        20: { model: "gpt-5.5", effort: "low" },
        21: { model: "gpt-5.6-sol", effort: "medium" },
      }),
    );
    writeFileSync(
      join(home, "chat-assistants.json"),
      JSON.stringify({ 20: 11, 21: 10 }),
    );
    const { adapter, sent } = realAdapter([
      [10, "codex"],
      [11, "codex-2"],
    ]);
    await adapter.reportStoredSessionSettings();
    expect(sent.mock.calls.map((c: any[]) => [c[0], c[1]]).sort()).toEqual([
      [10, 21],
      [11, 20],
    ]);
    adapter.host.close();
  });

  it("the pair is kept on disk when an event names both, and read back by the next process", async () => {
    const first = realAdapter([
      [10, "codex"],
      [11, "codex-2"],
    ]);
    first.adapter.noteChatAssistant(20, 11);
    first.adapter.host.close();
    expect(
      JSON.parse(readFileSync(join(home, "chat-assistants.json"), "utf8")),
    ).toEqual({ 20: 11 });
    writeFileSync(
      join(home, "session-settings.json"),
      JSON.stringify({ 20: { model: "gpt-5.5" } }),
    );
    const next = realAdapter([
      [10, "codex"],
      [11, "codex-2"],
    ]);
    await next.adapter.reportStoredSessionSettings();
    expect(next.sent).toHaveBeenCalledTimes(1);
    expect(next.sent.mock.calls[0]!.slice(0, 2)).toEqual([11, 20]);
    next.adapter.host.close();
  });

  it("a pair naming an agent this daemon no longer owns is not used", async () => {
    writeFileSync(
      join(home, "session-settings.json"),
      JSON.stringify({ 20: { model: "gpt-5.5" } }),
    );
    writeFileSync(join(home, "chat-assistants.json"), JSON.stringify({ 20: 12 }));
    const { adapter, sent } = realAdapter([
      [10, "codex"],
      [11, "codex-2"],
    ]);
    await adapter.reportStoredSessionSettings();
    expect(sent).not.toHaveBeenCalled();
    adapter.host.close();
  });
});

/**
 * P5 stage 7, Phase B, decision 4: the adapter's half of the retraction. The
 * first time this process binds a chat to its agent, the host is asked
 * whether it holds anything for it; a chat it holds nothing for sends a
 * report with a null model, which clears the value another host left.
 */
describe("Phase B: the retraction reaches BGOS", () => {
  it("the first bind of a chat the daemon holds nothing for sends model null, once", async () => {
    const { adapter, sent } = realAdapter([[10, "codex"]]);
    adapter.noteChatAssistant(20, 10);
    adapter.noteChatBound(20);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent.mock.calls[0]!.slice(0, 2)).toEqual([10, 20]);
    expect(sent.mock.calls[0]![2]).toMatchObject({
      model: null,
      effort: null,
      serviceTier: null,
      rerouted: false,
    });
    // Once per process: the second message in the chat asks nothing.
    adapter.noteChatBound(20);
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
    adapter.host.close();
  });

  it("a chat with a thread binds without a retraction", async () => {
    const { adapter, sent } = realAdapter([[10, "codex"]], { 20: "thread-20" });
    adapter.noteChatAssistant(20, 10);
    adapter.noteChatBound(20);
    await settle();
    expect(sent).not.toHaveBeenCalled();
    adapter.host.close();
  });

  it("a stand in host without the seam never breaks a dispatch", () => {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    Object.assign(adapter, { host: {} });
    expect(() => adapter.noteChatBound(20)).not.toThrow();
  });

  it("the first message in an agent DM is the bind, after the chat's agent is noted, main chats only", () => {
    const source = readFileSync("src/adapter.ts", "utf8");
    const at = source.indexOf("  private async codexDispatch(");
    const body = source.slice(at, source.indexOf("await this.nativeCommands.handle(args)", at));
    const noted = body.indexOf("this.noteChatAssistant(args.chatId, args.assistantId);");
    const bound = body.indexOf("this.noteChatBound(args.chatId);");
    expect(noted).toBeGreaterThan(-1);
    expect(bound).toBeGreaterThan(noted);
    expect(body).toContain(
      'if (!args.chatKind || args.chatKind === "main")\n      this.noteChatBound(args.chatId);',
    );
    // After the meeting branch returned: a room never asks.
    expect(bound).toBeGreaterThan(body.indexOf('if (args.chatKind === "meeting") {'));
  });

  it("the retraction goes through BgosApi as the same five fields, model null", async () => {
    const api = new BgosApi({
      baseUrl: "http://127.0.0.1:9",
      pairingToken: "t".repeat(32),
    } as any) as any;
    const request = vi.fn(async () => ({ data: { ok: true, applied: true } }));
    api.http = { request };
    await api.reportSessionSettings(111, 222, {
      model: null,
      effort: null,
      serviceTier: null,
      rerouted: false,
      reportedAt: "2026-09-26T09:30:00.000Z",
    });
    const call = (request.mock.calls[0] as any[])[0];
    expect(Object.keys(call.data)).toEqual([
      "model",
      "effort",
      "serviceTier",
      "rerouted",
      "reportedAt",
    ]);
    expect(call.data.model).toBeNull();
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
