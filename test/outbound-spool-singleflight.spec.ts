/**
 * V2 regression: replaySpool must be single-flight. Concurrent callers (the 60s
 * spool timer, onReconnect, recover, WS flapping) would otherwise each load the
 * SAME spooled entries and re-send them; the backend insert is NOT idempotent,
 * so that double-sends the agent message. One in-flight run must serve them all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosOutbound } from "../src/outbound.js";
import { appendOutbox, loadOutbox } from "../src/outbox.js";
import type { BgosApi } from "../src/bgos-api.js";
import type { OutboundMessagePayload } from "../src/types.js";

describe("BgosOutbound.replaySpool single-flight", () => {
  let tempHome: string;
  const originalCodexBgosHome = process.env.CODEX_BGOS_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-spool-singleflight-"));
    process.env.CODEX_BGOS_HOME = tempHome;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodexBgosHome === undefined) delete process.env.CODEX_BGOS_HOME;
    else process.env.CODEX_BGOS_HOME = originalCodexBgosHome;
  });

  it("two concurrent replaySpool calls send a spooled entry exactly once", async () => {
    const payload: OutboundMessagePayload = {
      assistantId: 1,
      chatId: 2,
      sender: "assistant",
      text: "E",
      messageType: "standard",
    };
    appendOutbox({ ts: Date.now(), payload });
    expect(loadOutbox()).toHaveLength(1);

    let inFlight = 0;
    let maxConcurrent = 0;
    const send = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Hold the send open so a second overlapping run (if any) would be
      // observed as concurrent.
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { id: 99 };
    });
    const api = {
      postMessage: send,
      sendMessage: send,
    } as unknown as BgosApi;
    const out = new BgosOutbound(api);

    // Fire two replays concurrently (WS flap: reconnect + 60s timer overlap).
    await Promise.all([out.replaySpool(), out.replaySpool()]);

    expect(send).toHaveBeenCalledTimes(1); // exactly once for E, not twice
    expect(maxConcurrent).toBe(1); // never two overlapping replays
    expect(loadOutbox()).toHaveLength(0); // outbox drained
  });
});
