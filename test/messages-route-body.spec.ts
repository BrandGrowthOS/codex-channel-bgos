/**
 * The two message routes do not share one DTO.
 *
 * `POST /api/v1/send-message` reads `MessageWrapperDto`, which DECLARES
 * `assistantId` and needs it. `POST /api/v1/messages` reads
 * `CreateMessageDto`, which does not: the backend's global ValidationPipe
 * runs with `whitelist: true`, so the field is stripped before the service
 * sees it (the assistant is resolved from the chat) and the shadow
 * interceptor logs it as an unknown field on every card POST. So the plugin
 * stops sending it on that route, and keeps sending it on the other.
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

describe("the body each message route actually accepts", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("does not send assistantId to /messages, and changes nothing else", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 31 });
    await makeApi(baseUrl).postMessage({
      assistantId: 9,
      chatId: 4,
      sender: "assistant",
      text: "hi",
      messageType: "tool_progress",
      toolProgress: {
        state: "running",
        tools: [{ icon: "💻", name: "Bash", status: "running" }],
      },
    });

    const body = server.requests.at(-1)!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("assistantId");
    expect(body).toEqual({
      chatId: 4,
      sender: "assistant",
      text: "hi",
      messageType: "tool_progress",
      toolProgress: {
        state: "running",
        tools: [{ icon: "💻", name: "Bash", status: "running" }],
      },
    });
  });

  it("still sends assistantId to /send-message, which declares it", async () => {
    server.stage("POST", "/api/v1/send-message", 200, { message: { id: 32 } });
    await makeApi(baseUrl).sendMessage({
      assistantId: 9,
      chatId: 4,
      sender: "assistant",
      text: "peer reply",
    });

    expect(server.requests.at(-1)!.body).toMatchObject({
      assistantId: 9,
      chatId: 4,
      text: "peer reply",
    });
  });

  it("leaves the caller's own payload object untouched", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 33 });
    const payload = {
      assistantId: 9,
      chatId: 4,
      sender: "assistant" as const,
      text: "hi",
    };
    await makeApi(baseUrl).postMessage(payload);
    expect(payload.assistantId).toBe(9);
  });
});
