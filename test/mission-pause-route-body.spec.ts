/**
 * The daemon's own Pause and Resume of a mission (P6 stage 3, C-32, spec 4.2
 * step 7).
 *
 * An owner Stop pauses the chat's open mission with the contract's reason,
 * and the owner's next message resumes it. Both go out on the PAIRING family
 * of the mission routes (`missions.controller.ts` pauseAsPairing and
 * resumeAsPairing), never the app's user family, and both answer
 * `{ ok, mission }`. The lane reads `mission.pausedReason` from the pause
 * answer to learn whether the pause is its own: a mission the owner had
 * already paused comes back unchanged, with the owner's reason.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { STOP_PAUSE_REASON } from "../src/session-controls-contract.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const TOKEN = "pair_" + "x".repeat(30);

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: TOKEN,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function snapshot(status: "active" | "paused", pausedReason: string | null) {
  return {
    id: 301,
    assistantId: 7,
    chatId: 42,
    title: "Plan",
    status,
    origin: "derived",
    progress: { current: 1, total: 3, label: "steps" },
    pausedReason,
  };
}

describe("pauseMission and resumeMission on the pairing routes", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("pauses with exactly the reason, on the pairing route, and hands back the snapshot", async () => {
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/301/pause",
      200,
      { ok: true, mission: snapshot("paused", STOP_PAUSE_REASON) },
    );

    const mission = await makeApi(baseUrl).pauseMission(7, 301, {
      reason: STOP_PAUSE_REASON,
    });

    expect(mission).toMatchObject({ id: 301, status: "paused", pausedReason: "Stopped by you" });
    const request = server.requests.at(-1)!;
    expect(`${request.method} ${request.url}`).toBe(
      "PATCH /api/v1/integrations/assistants/7/missions/301/pause",
    );
    // PauseMissionDto declares `reason` and nothing else: the body carries
    // exactly that, so the whitelist has nothing to strip.
    expect(request.body).toEqual({ reason: "Stopped by you" });
    expect(request.headers["x-bgos-pairing"]).toBe(TOKEN);
  });

  it("sends an empty body when no reason is given, never a null reason", async () => {
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/301/pause",
      200,
      { ok: true, mission: snapshot("paused", null) },
    );
    await makeApi(baseUrl).pauseMission(7, 301);
    expect(server.requests.at(-1)!.body).toEqual({});
  });

  it("resumes on the pairing route with an empty body and hands back the snapshot", async () => {
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/301/resume",
      200,
      { ok: true, mission: snapshot("active", null) },
    );

    const mission = await makeApi(baseUrl).resumeMission(7, 301);

    expect(mission).toMatchObject({ id: 301, status: "active", pausedReason: null });
    const request = server.requests.at(-1)!;
    expect(`${request.method} ${request.url}`).toBe(
      "PATCH /api/v1/integrations/assistants/7/missions/301/resume",
    );
    expect(request.body).toEqual({});
    expect(request.headers["x-bgos-pairing"]).toBe(TOKEN);
  });

  it("lets a refusal through with its status, so the lane can leave the mission as the server has it", async () => {
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/301/pause",
      409,
      { message: "Mission 301 is completed; it cannot be paused." },
    );
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/301/resume",
      409,
      { message: "Mission 301 is active; it cannot be resumed." },
    );
    const api = makeApi(baseUrl);
    await expect(api.pauseMission(7, 301, { reason: STOP_PAUSE_REASON })).rejects.toMatchObject({
      response: { status: 409 },
    });
    await expect(api.resumeMission(7, 301)).rejects.toMatchObject({
      response: { status: 409 },
    });
  });
});
