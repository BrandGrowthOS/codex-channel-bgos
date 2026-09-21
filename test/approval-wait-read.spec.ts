/**
 * Reading the owner's own approval wait.
 *
 * This read sits in front of a request a person is waiting on, so it is
 * deliberately total: every failure is a null, and a null means the daemon
 * posts the request with no `wait_seconds` and behaves exactly as it did
 * before the setting existed. The range is the backend's own CHECK (60 to
 * 1800); anything outside it is treated as unreadable rather than clamped
 * here, because the server clamps and two opinions about a ceiling is how a
 * card and a daemon end up disagreeing about when a request is dead.
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

describe("the owner's approval wait, read off the agent itself", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("reads the agent's own row with the pairing it already holds", async () => {
    server.stage("GET", "/api/v1/assistants/9", 200, {
      id: 9,
      name: "Codex",
      approvalWaitSeconds: 600,
    });
    expect(await makeApi(baseUrl).getApprovalWaitSeconds(9)).toBe(600);
    const asked = server.requests.at(-1)!;
    expect(asked.url).toBe("/api/v1/assistants/9");
    expect(asked.headers["x-bgos-pairing"]).toBe("pair_" + "x".repeat(30));
  });

  it("treats a value the backend would not have stored as unreadable", async () => {
    const api = makeApi(baseUrl);
    for (const approvalWaitSeconds of [59, 1801, 600.5, "600", null]) {
      server.stage("GET", "/api/v1/assistants/9", 200, {
        id: 9,
        approvalWaitSeconds,
      });
      expect(await api.getApprovalWaitSeconds(9)).toBeNull();
    }
    // The floor and the ceiling themselves are legal, not off by one.
    for (const approvalWaitSeconds of [60, 1800]) {
      server.stage("GET", "/api/v1/assistants/9", 200, {
        id: 9,
        approvalWaitSeconds,
      });
      expect(await api.getApprovalWaitSeconds(9)).toBe(approvalWaitSeconds);
    }
  });

  it("gives up on a slow backend long before the client's ordinary patience", async () => {
    // Real timers on purpose: the thing under test is a wall-clock option on
    // one call. The axios instance's own default is 30 s, and this read sits in
    // front of a card a person is waiting to see, so 30 s of it would look to
    // the owner like the agent hanging before it even asks. Staged to answer at
    // 4 s: the 3 s timeout must win, and with the option gone the 200 arrives
    // and the read returns 600 instead of null.
    server.stage(
      "GET",
      "/api/v1/assistants/9",
      200,
      { id: 9, approvalWaitSeconds: 600 },
      4_000,
    );
    const startedAt = Date.now();
    expect(await makeApi(baseUrl).getApprovalWaitSeconds(9)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(3_800);
  }, 15_000);

  it("answers null rather than throwing when the read cannot be made", async () => {
    const api = makeApi(baseUrl);
    // A backend older than the column answers the route without the field.
    server.stage("GET", "/api/v1/assistants/9", 200, { id: 9, name: "Codex" });
    expect(await api.getApprovalWaitSeconds(9)).toBeNull();
    // A read someone else's pairing cannot make answers 200 + null.
    server.stage("GET", "/api/v1/assistants/9", 200, null);
    expect(await api.getApprovalWaitSeconds(9)).toBeNull();
    // A server error, and a 401, which every other method turns into a
    // PairingRevokedError. Neither may reach the approval: a revoked pairing
    // has bigger problems than a missing wait, and they are reported by the
    // calls that actually matter.
    server.stage("GET", "/api/v1/assistants/9", 500, { message: "boom" });
    expect(await api.getApprovalWaitSeconds(9)).toBeNull();
    server.stage("GET", "/api/v1/assistants/9", 401, { message: "revoked" });
    expect(await api.getApprovalWaitSeconds(9)).toBeNull();
    // Nothing staged at all: an unroutable read is still just a null.
    expect(await api.getApprovalWaitSeconds(9)).toBeNull();
  });
});
