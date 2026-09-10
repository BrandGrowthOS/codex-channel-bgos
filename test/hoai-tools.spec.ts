import { describe, expect, it, vi } from "vitest";
import { HoaiTools, validateToolInput } from "../src/hoai-tools.js";
const context = () => ({
  assistantId: 9,
  chatId: 17,
  userId: "owner",
  signal: new AbortController().signal,
});
describe("typed HOAI boundary", () => {
  it("accepts a native free-text form through the real dynamic tool schema", async () => {
    const tools = new HoaiTools({} as any, () => "canon");
    const ask = vi
      .spyOn(tools.interactions, "ask")
      .mockResolvedValue([{ question: "Which word?", free_text: "TOPAZ" }]);
    const questions = [
      { text: "Which word?", options: [], allow_free_text: true },
    ];
    const result: any = await tools.handleRequest(
      "item/tool/call",
      { tool: "ask_user_input", arguments: { chat_id: "17", questions } },
      context(),
    );
    expect(result.success).toBe(true);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 17 }),
      questions,
      undefined,
    );
    expect(result.contentItems[0].text).toContain("TOPAZ");
  });
  it("preserves useful Boards refusal bodies without request credentials", async () => {
    const api = {
      agentRequest: vi.fn(async () => {
        throw Object.assign(new Error("Request failed with status code 400"), {
          response: {
            status: 400,
            data: {
              message: "Board ledger signing key is not configured",
              operation: "boards.ledger_unconfigured",
            },
          },
          config: { headers: { secret: "NEVER_SHOW" } },
        });
      }),
    };
    const tools = new HoaiTools(api as any, () => "canon");
    const result: any = await tools.handleRequest(
      "item/tool/call",
      { tool: "boards_create", arguments: { name: "QA" } },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.contentItems[0].text).toContain(
      "Board ledger signing key is not configured",
    );
    expect(result.contentItems[0].text).toContain("boards.ledger_unconfigured");
    expect(result.contentItems[0].text).not.toContain("NEVER_SHOW");
  });
  it("does not infer group authorship from the chat carrier", async () => {
    const api = {
      agentRequest: vi.fn(),
      getMessages: vi.fn(async () => [
        { message: { id: 5, sender: "assistant", assistantId: 9 } },
      ]),
    };
    const tools = new HoaiTools(api as any, () => "canon");
    await expect(
      tools.call(
        "edit_message",
        { message_id: "5", text: "replacement" },
        { ...context(), chatKind: "room" },
      ),
    ).rejects.toThrow(/Only this agent/);
    expect(api.agentRequest).not.toHaveBeenCalled();
  });
  it("never lets model arguments select another assistant or chat", async () => {
    const api = { agentRequest: vi.fn(async () => ({ id: 1 })) };
    const tools = new HoaiTools(api as any, () => "canon");
    await expect(
      tools.call("reply", { chat_id: "18", text: "wrong chat" }, context()),
    ).rejects.toThrow(/current event/);
    await tools.call(
      "reply",
      { chat_id: "17", assistant_id: 777, text: "correct chat" },
      context(),
    );
    expect(api.agentRequest).toHaveBeenCalledWith(
      "POST",
      "messages",
      9,
      expect.objectContaining({ assistantId: 9, chatId: 17 }),
    );
  });
  it("routes ordinary replies through the meeting floor check", async () => {
    const api = { agentRequest: vi.fn(async () => ({ id: 1 })) };
    const tools = new HoaiTools(api as any, () => "canon");
    await tools.call(
      "reply",
      { chat_id: "17", text: "Contribution" },
      { ...context(), meetingId: 3 },
    );
    expect(api.agentRequest).toHaveBeenCalledWith(
      "POST",
      "meetings/3/messages",
      9,
      { text: "Contribution", asAssistantId: 9 },
    );
  });
  it("returns real backend refusal as a failed tool result", async () => {
    const api = {
      agentRequest: vi.fn(async () => {
        throw {
          response: { status: 403, data: { message: "requires_introduction" } },
          config: { headers: { secret: "never display" } },
        };
      }),
    };
    const tools = new HoaiTools(api as any, () => "canon");
    const result: any = await tools.handleRequest(
      "item/tool/call",
      { tool: "list_peers", arguments: {} },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.contentItems[0].text).toBe("HTTP 403: requires_introduction");
  });
  it("supports native component union schemas while rejecting invalid values", () => {
    const schema = { type: ["string", "object"] };
    expect(() => validateToolInput({ title: "Card" }, schema)).not.toThrow();
    expect(() => validateToolInput("Card", schema)).not.toThrow();
    expect(() => validateToolInput(5, schema)).toThrow();
    expect(() => validateToolInput(1.2, { type: "integer" })).toThrow();
  });
  it("blocks edits to a person's message", async () => {
    const api = {
      agentRequest: vi.fn(),
      getMessages: vi.fn(async () => [{ message: { id: 5, sender: "user" } }]),
    };
    const tools = new HoaiTools(api as any, () => "canon");
    await expect(
      tools.call(
        "edit_message",
        { message_id: "5", text: "replacement" },
        context(),
      ),
    ).rejects.toThrow(/Only this agent/);
    expect(api.agentRequest).not.toHaveBeenCalled();
  });
});
