/**
 * BgosApi.postHeartbeat + setStatus (contracts C1 + C4).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

describe("BgosApi telemetry endpoints", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("postHeartbeat POSTs the DTO to /integrations/heartbeat", async () => {
    server.stage("POST", "/api/v1/integrations/heartbeat", 204, null);
    await makeApi(baseUrl).postHeartbeat({
      daemonVersion: "0.11.0",
      uptimeS: 42,
      wsConnected: true,
      lastError: null,
    });
    const req = server.requests.at(-1)!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/v1/integrations/heartbeat");
    expect(req.body).toMatchObject({
      daemonVersion: "0.11.0",
      uptimeS: 42,
      wsConnected: true,
      lastError: null,
    });
  });

  it("setStatus PATCHes /integrations/assistants/:id/status", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/5/status", 200, {});
    await makeApi(baseUrl).setStatus(5, { statusText: "working on it" });
    const req = server.requests.at(-1)!;
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("/api/v1/integrations/assistants/5/status");
    expect(req.body).toMatchObject({ statusText: "working on it" });
  });

  it("setStatus clears with an empty string", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/5/status", 200, {});
    await makeApi(baseUrl).setStatus(5, { statusText: "" });
    expect(server.requests.at(-1)!.body).toMatchObject({ statusText: "" });
  });
});
