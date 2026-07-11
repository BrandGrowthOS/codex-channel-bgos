/**
 * BgosWs.triggerBackfill: disk-cursor authority, single-flight coalescing,
 * storm guard, and cold-start seed (contract C3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import { loadLastId, saveLastId } from "../src/last-id-store.js";
import type { InboundMessagePayload } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function msg(id: number): Record<string, unknown> {
  return { assistantId: 1, chatId: 200, messageId: id, userId: "u", text: "x" };
}

describe("BgosWs.triggerBackfill", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalCodexBgosHome = process.env.CODEX_BGOS_HOME;
  const originalStorm = process.env.CODEX_BGOS_BACKFILL_STORM_LIMIT;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "codex-backfill-test-"));
    process.env.CODEX_BGOS_HOME = tempHome;
    delete process.env.CODEX_BGOS_BACKFILL_STORM_LIMIT;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodexBgosHome === undefined) delete process.env.CODEX_BGOS_HOME;
    else process.env.CODEX_BGOS_HOME = originalCodexBgosHome;
    if (originalStorm === undefined) delete process.env.CODEX_BGOS_BACKFILL_STORM_LIMIT;
    else process.env.CODEX_BGOS_BACKFILL_STORM_LIMIT = originalStorm;
  });

  it("normal path: emits each message since the disk cursor, then backfill_ok", async () => {
    saveLastId(10);
    server.stage("GET", "/api/v1/integrations/inbound", 200, {
      messages: [msg(11), msg(12)],
    });
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const emitted: InboundMessagePayload[] = [];
    let ok = false;
    ws.on("inbound_message", (m) => emitted.push(m));
    ws.on("backfill_ok", () => (ok = true));

    await ws.triggerBackfill();

    expect(emitted.map((m) => m.messageId)).toEqual([11, 12]);
    expect(ok).toBe(true);
  });

  it("single-flight: concurrent calls coalesce onto one HTTP request", async () => {
    saveLastId(10);
    server.stage("GET", "/api/v1/integrations/inbound", 200, {
      messages: [msg(11)],
    });
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    await Promise.all([ws.triggerBackfill(), ws.triggerBackfill(), ws.triggerBackfill()]);
    const inboundReqs = server.requests.filter((r) =>
      r.url.startsWith("/api/v1/integrations/inbound"),
    );
    expect(inboundReqs).toHaveLength(1);
  });

  it("storm guard: fast-forwards cursor + skips dispatch + emits backfill_storm", async () => {
    process.env.CODEX_BGOS_BACKFILL_STORM_LIMIT = "2";
    saveLastId(10);
    server.stage("GET", "/api/v1/integrations/inbound", 200, {
      messages: [msg(11), msg(12), msg(13)],
    });
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const emitted: InboundMessagePayload[] = [];
    let stormCount = -1;
    ws.on("inbound_message", (m) => emitted.push(m));
    ws.on("backfill_storm", (n) => (stormCount = n));

    await ws.triggerBackfill();

    expect(emitted).toHaveLength(0); // dispatch skipped
    expect(stormCount).toBe(3);
    expect(loadLastId()).toBe(13); // cursor fast-forwarded to newest
  });

  it("cold-start seed: initial backfill from cursor 0 seeds WITHOUT dispatch", async () => {
    // cursor is 0 (fresh temp home). Page 1 has history; page 2 is empty.
    server.stage("GET", "/api/v1/integrations/inbound", 200, {
      messages: [msg(50), msg(51), msg(52)],
    });
    server.stage("GET", "/api/v1/integrations/inbound", 200, { messages: [] });
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const emitted: InboundMessagePayload[] = [];
    ws.on("inbound_message", (m) => emitted.push(m));

    await ws.triggerBackfill({ initial: true });

    expect(emitted).toHaveLength(0); // history NOT replayed
    expect(loadLastId()).toBe(52); // cursor seeded to newest
  });

  it("non-initial backfill from cursor 0 dispatches normally (fresh message)", async () => {
    // cursor 0 but this is a poll tick, not the initial backfill: a genuinely
    // new message must dispatch, not be swallowed.
    server.stage("GET", "/api/v1/integrations/inbound", 200, {
      messages: [msg(5)],
    });
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const emitted: InboundMessagePayload[] = [];
    ws.on("inbound_message", (m) => emitted.push(m));

    await ws.triggerBackfill(); // no initial flag

    expect(emitted.map((m) => m.messageId)).toEqual([5]);
  });

  it("backfill error surfaces backfill_error + error events", async () => {
    saveLastId(10);
    // No staged response -> 404 -> axios rejects.
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    let backfillErr = false;
    let genericErr = false;
    ws.on("backfill_error", () => (backfillErr = true));
    ws.on("error", () => (genericErr = true));

    await ws.triggerBackfill();

    expect(backfillErr).toBe(true);
    expect(genericErr).toBe(true);
  });
});
