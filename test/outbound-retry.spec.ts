/**
 * Outbound retry policy (contract C3): retry backoff ONLY for the safe
 * network-error class + 429; ambiguous (timeout / 5xx) no-retry; spool after
 * 3 failed safe-class retries + replay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosOutbound } from "../src/outbound.js";
import { classifyOutboundError } from "../src/outbound-retry.js";
import { loadOutbox } from "../src/outbox.js";
import type { BgosApi } from "../src/bgos-api.js";

function netErr(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}
function httpErr(status: number, headers?: Record<string, unknown>): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, headers },
  });
}

/** Fake BgosApi exposing just the send surface BgosOutbound uses. */
function fakeApi(postImpl: () => Promise<{ id: number }>): BgosApi {
  return {
    postMessage: vi.fn(postImpl),
    sendMessage: vi.fn(postImpl),
  } as unknown as BgosApi;
}

describe("classifyOutboundError", () => {
  it("marks the safe connection-error class retriable", () => {
    for (const c of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
      expect(classifyOutboundError(netErr(c)).retriable).toBe(true);
    }
  });
  it("marks a socket hang up (pre-response) retriable", () => {
    expect(classifyOutboundError(netErr("ECONNRESET", "socket hang up")).retriable).toBe(true);
  });
  it("marks 429 retriable and parses Retry-After seconds", () => {
    const cls = classifyOutboundError(httpErr(429, { "retry-after": "2" }));
    expect(cls.retriable).toBe(true);
    expect(cls.retryAfterMs).toBe(2000);
  });
  it("marks timeouts (ECONNABORTED) ambiguous / no-retry", () => {
    expect(classifyOutboundError(netErr("ECONNABORTED", "timeout")).retriable).toBe(false);
  });
  it("marks 5xx ambiguous / no-retry", () => {
    expect(classifyOutboundError(httpErr(503)).retriable).toBe(false);
  });
  it("marks other 4xx not retriable", () => {
    expect(classifyOutboundError(httpErr(404)).retriable).toBe(false);
  });
});

describe("BgosOutbound retry + spool", () => {
  let tempHome: string;
  const originalCodexBgosHome = process.env.CODEX_BGOS_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-outbox-test-"));
    process.env.CODEX_BGOS_HOME = tempHome;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodexBgosHome === undefined) delete process.env.CODEX_BGOS_HOME;
    else process.env.CODEX_BGOS_HOME = originalCodexBgosHome;
  });

  it("retries the safe class then succeeds (no spool)", async () => {
    let calls = 0;
    const api = fakeApi(async () => {
      calls += 1;
      if (calls < 3) throw netErr("ECONNREFUSED");
      return { id: 42 };
    });
    const out = new BgosOutbound(api);
    out.setSleepFn(async () => {}); // no real backoff waits

    const res = await out.sendText({ assistantId: 1, chatId: 2, text: "hi" });
    expect(res.id).toBe(42);
    expect(calls).toBe(3);
    expect(loadOutbox()).toHaveLength(0);
  });

  it("does NOT retry an ambiguous failure and reports lastError", async () => {
    const api = fakeApi(async () => {
      throw httpErr(500);
    });
    const out = new BgosOutbound(api);
    out.setSleepFn(async () => {});
    const lastError = vi.fn();
    out.setLastErrorReporter(lastError);

    await expect(
      out.sendText({ assistantId: 1, chatId: 2, text: "hi" }),
    ).rejects.toBeTruthy();
    // exactly one attempt (no retry)
    expect((api.postMessage as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
    expect(lastError).toHaveBeenCalledWith("outbound_failed", expect.any(String));
    expect(loadOutbox()).toHaveLength(0); // ambiguous is never spooled
  });

  it("spools after 3 failed safe-class retries, then replay drains it", async () => {
    let failing = true;
    const api = fakeApi(async () => {
      if (failing) throw netErr("ECONNREFUSED");
      return { id: 7 };
    });
    const out = new BgosOutbound(api);
    out.setSleepFn(async () => {});

    await expect(
      out.sendText({ assistantId: 1, chatId: 2, text: "queued" }),
    ).rejects.toBeTruthy();

    // 1 initial + 3 retries = 4 attempts, then spool.
    expect((api.postMessage as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(4);
    const spooled = loadOutbox();
    expect(spooled).toHaveLength(1);
    expect(spooled[0].payload.text).toBe("queued");

    // Network recovers -> replay drains the spool.
    failing = false;
    await out.replaySpool();
    expect(loadOutbox()).toHaveLength(0);
  });
});
