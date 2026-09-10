import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BgosApi } from "../src/bgos-api.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

describe("native tool route transport", () => {
  let server: MockBgosServer;
  let api: BgosApi;
  beforeEach(async () => {
    server = new MockBgosServer();
    api = new BgosApi({
      baseUrl: await server.start(),
      pairingToken: "qa-token",
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
  });
  afterEach(async () => {
    await server.stop();
  });

  it("sends an encoded board name intact with its caller identity", async () => {
    const name = "Résumé & Release_v1.2's board";
    const route = `integrations/assistants/7/boards/${encodeURIComponent(name)}/describe?format=json`;
    server.stage("GET", `/api/v1/${route.split("?")[0]}`, 200, { name });
    expect(await api.agentRequest("GET", route, 7)).toEqual({ name });
    const request = server.requests.at(-1)!;
    expect(decodeURIComponent(request.url)).toContain(name);
    expect(request.headers["x-caller-assistant-id"]).toBe("7");
  });

  it.each([
    "https://example.test/messages",
    "//example.test/messages",
    "/messages",
    "integrations/../messages",
    "integrations/%2e%2e/messages",
    "integrations/%2f..%2fmessages",
    "integrations/%5cmessages",
    "integrations/%00",
    "integrations/%broken",
    "messages#fragment",
  ])("rejects unsafe route %s before sending", async (route) => {
    await expect(api.agentRequest("GET", route, 7)).rejects.toThrow(
      "Invalid HOAI tool route",
    );
    expect(server.requests).toHaveLength(0);
  });
});
