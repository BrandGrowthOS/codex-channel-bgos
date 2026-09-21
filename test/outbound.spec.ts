import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { BgosOutbound } from "../src/outbound.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

describe("BgosOutbound (Codex)", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("sendText posts message_type=standard + sender=assistant", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 11 });
    const out = new BgosOutbound(makeApi(baseUrl));
    await out.sendText({ assistantId: 1, chatId: 2, text: "hi" });
    expect(server.requests.at(-1)!.body).toMatchObject({
      chatId: 2,
      sender: "assistant",
      text: "hi",
      messageType: "standard",
    });
    // `/messages` does not declare assistantId (CreateMessageDto), so the
    // backend strips it and logs it as an unknown field. It is not sent.
    expect(server.requests.at(-1)!.body).not.toHaveProperty("assistantId");
  });

  it("sendButtons posts message + options[] up to the inline limit", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 12 });
    const out = new BgosOutbound(makeApi(baseUrl));
    await out.sendButtons({
      assistantId: 1,
      chatId: 2,
      text: "Pick one",
      options: [
        { text: "A", callbackData: "pick:a" },
        { text: "B", callbackData: "pick:b" },
      ],
    });
    const body = server.requests.at(-1)!.body as Record<string, unknown>;
    expect(body.messageType).toBe("standard");
    expect(body.options).toEqual([
      { text: "A", callbackData: "pick:a" },
      { text: "B", callbackData: "pick:b" },
    ]);
  });

  it("sendButtons rejects > 6 options before hitting the network", () => {
    const out = new BgosOutbound(makeApi(baseUrl));
    const tooMany = Array.from({ length: 7 }, (_, i) => ({
      text: `Opt ${i}`,
      callbackData: `opt:${i}`,
    }));
    // sendButtons is non-async - it throws synchronously when the option
    // count is too high so the caller knows to re-emit.
    expect(() =>
      out.sendButtons({
        assistantId: 1,
        chatId: 2,
        text: "Too many",
        options: tooMany,
      }),
    ).toThrow(/exceeds inline limit/);
    // Server should not have been hit
    expect(server.requests).toHaveLength(0);
  });

  it("sendApprovalRequest emits ea: callback_data on the four default buttons", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 13 });
    const out = new BgosOutbound(makeApi(baseUrl));
    await out.sendApprovalRequest({
      assistantId: 1,
      chatId: 2,
      text: "rm -rf /",
      meta: {
        tool: "shell.exec",
        agent_route: "general",
        risk: "high",
        request_id: "req_42",
      },
    });
    const body = server.requests.at(-1)!.body as {
      messageType: string;
      options: Array<{ text: string; callbackData: string; style: string }>;
      approvalMeta: Record<string, unknown>;
    };
    expect(body.messageType).toBe("approval_request");
    expect(body.options.map((o) => o.callbackData)).toEqual([
      "ea:once:req_42",
      "ea:session:req_42",
      "ea:always:req_42",
      "ea:deny:req_42",
    ]);
    expect(body.approvalMeta).toMatchObject({
      tool: "shell.exec",
      risk: "high",
      request_id: "req_42",
    });
  });

  it("sendAskUserInput posts message_type=ask_user_input with the prompt as text", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 14 });
    const out = new BgosOutbound(makeApi(baseUrl));
    await out.sendAskUserInput({
      assistantId: 1,
      chatId: 2,
      prompt: "How long should the meeting be?",
      options: [
        { text: "30 min", callbackData: "30" },
        { text: "60 min", callbackData: "60" },
      ],
      modal: true,
    });
    const body = server.requests.at(-1)!.body as Record<string, unknown>;
    expect(body.messageType).toBe("ask_user_input");
    expect(body.text).toBe("How long should the meeting be?");
    expect(body.options).toHaveLength(2);
  });

  it("sendAgentError posts with message_type=agent_error", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 15 });
    const out = new BgosOutbound(makeApi(baseUrl));
    await out.sendAgentError({ assistantId: 1, chatId: 2, reason: "boom" });
    const body = server.requests.at(-1)!.body as Record<string, unknown>;
    expect(body.messageType).toBe("agent_error");
    expect((body.text as string).includes("boom")).toBe(true);
  });

  it("sendImage rejects a non-image MIME before hitting the network", () => {
    const out = new BgosOutbound(makeApi(baseUrl));
    // sendImage throws synchronously on the MIME mismatch - never reaches
    // the network or attachment-bridge.
    expect(() =>
      out.sendImage({
        assistantId: 1,
        chatId: 2,
        filePath: "/tmp/foo.bin",
        mimeType: "application/octet-stream",
      }),
    ).toThrow(/not image/);
  });

  it("sendVideo rejects a non-video MIME before hitting the network", () => {
    const out = new BgosOutbound(makeApi(baseUrl));
    expect(() =>
      out.sendVideo({
        assistantId: 1,
        chatId: 2,
        filePath: "/tmp/foo.bin",
        mimeType: "image/png",
      }),
    ).toThrow(/not video/);
  });

  it("sendTyping is a no-op (best-effort, swallows errors)", async () => {
    const out = new BgosOutbound(makeApi(baseUrl));
    await expect(
      out.sendTyping({ assistantId: 1, chatId: 2 }),
    ).resolves.toBeUndefined();
  });

  it("sendAsAgent strips the free-form name/color/avatar by default (anti-spoof)", async () => {
    // SECURITY: with CODEX_BGOS_ALLOW_INLINE_AGENT_NAME off (default), the
    // plugin must NOT forward the agent-supplied display name - only the
    // resolvable handles survive, and the backend resolves identity.
    delete process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME;
    server.stage("POST", "/api/v1/messages", 201, { id: 16 });
    const out = new BgosOutbound(makeApi(baseUrl));
    await out.sendAsAgent({
      assistantId: 1,
      chatId: 2,
      text: "From research perspective, ARR is up 23%.",
      agent: {
        peerId: 9,
        name: "Research",
        color: "#0EA5E9",
        avatarUrl: "https://example.com/research.png",
        type: "codex",
      },
    });
    const body = server.requests.at(-1)!.body as Record<string, unknown>;
    expect(body.messageType).toBe("standard");
    expect(body.sender).toBe("assistant");
    expect(body.fromAgent).toEqual({ peerId: 9, type: "codex" });
  });

  it("sendAsAgent forwards the full identity when CODEX_BGOS_ALLOW_INLINE_AGENT_NAME is on", async () => {
    process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME = "1";
    try {
      server.stage("POST", "/api/v1/messages", 201, { id: 16 });
      const out = new BgosOutbound(makeApi(baseUrl));
      await out.sendAsAgent({
        assistantId: 1,
        chatId: 2,
        text: "From research perspective, ARR is up 23%.",
        agent: {
          name: "Research",
          color: "#0EA5E9",
          avatarUrl: "https://example.com/research.png",
          type: "codex",
        },
      });
      const body = server.requests.at(-1)!.body as Record<string, unknown>;
      expect(body.fromAgent).toEqual({
        name: "Research",
        color: "#0EA5E9",
        avatarUrl: "https://example.com/research.png",
        type: "codex",
      });
    } finally {
      delete process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME;
    }
  });

  it("sendText with fromAgent strips the inline name by default but keeps the type", async () => {
    delete process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME;
    server.stage("POST", "/api/v1/messages", 201, { id: 17 });
    const out = new BgosOutbound(makeApi(baseUrl));
    await out.sendText({
      assistantId: 1,
      chatId: 2,
      text: "morning briefing",
      fromAgent: { name: "Briefing", color: "#FFD900", type: "codex" },
    });
    const body = server.requests.at(-1)!.body as Record<string, unknown>;
    expect(body.fromAgent).toEqual({ type: "codex" });
  });

  it("sendAsAgent rejects > 6 options synchronously", () => {
    const out = new BgosOutbound(makeApi(baseUrl));
    const tooMany = Array.from({ length: 7 }, (_, i) => ({
      text: `Opt ${i}`,
      callbackData: `opt:${i}`,
    }));
    expect(() =>
      out.sendAsAgent({
        assistantId: 1,
        chatId: 2,
        text: "agent says",
        agent: { name: "X" },
        options: tooMany,
      }),
    ).toThrow(/exceeds inline limit/);
    expect(server.requests).toHaveLength(0);
  });
});
