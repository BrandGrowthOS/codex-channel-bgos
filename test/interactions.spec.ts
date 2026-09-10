import { afterEach, describe, expect, it, vi } from "vitest";
import { Interactions } from "../src/interactions.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const c = new AbortController();
  const api = {
    agentRequest: vi.fn(async () => ({ id: 41 })),
    getMessages: vi.fn(async () => [] as any[]),
  };
  return {
    c,
    api,
    bridge: new Interactions(api as any),
    ctx: { assistantId: 9, chatId: 17, userId: "owner", signal: c.signal },
  };
}
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
describe("interactive answers and native execution decisions", () => {
  it("waits for the matching human and returns the original value without interpreting backslashes", async () => {
    vi.useFakeTimers();
    const { bridge, api, ctx, c } = fixture();
    const answer = bridge.ask(ctx, [
      {
        text: "Choose folder",
        options: [{ label: "Folder", value: String.raw`C:\Work & files\a.md` }],
      },
    ]);
    await tick();
    const data = (api.agentRequest.mock.calls[0] as any)[3].options[0]
      .callbackData;
    let done = false;
    void answer.then(() => (done = true));
    bridge.handleClick({
      assistantId: 9,
      chatId: 18,
      userId: "owner",
      messageId: 41,
      optionId: 1,
      callbackData: data,
    });
    bridge.handleClick({
      assistantId: 9,
      chatId: 17,
      userId: "someone-else",
      messageId: 41,
      optionId: 1,
      callbackData: data,
    });
    await tick();
    expect(done).toBe(false);
    bridge.handleClick({
      assistantId: 9,
      chatId: 17,
      userId: "owner",
      messageId: 41,
      optionId: 1,
      callbackData: data,
    });
    expect((await answer)[0].picked_option_value).toBe(
      String.raw`C:\Work & files\a.md`,
    );
    c.abort();
    await vi.runAllTimersAsync();
  });
  it("recovers a persisted answer when the WebSocket click was missed", async () => {
    vi.useFakeTimers();
    const { bridge, api, ctx, c } = fixture();
    const answer = bridge.ask(ctx, [
      { text: "Pick", options: [{ label: "Blue", value: "blue" }] },
    ]);
    await tick();
    const option = (api.agentRequest.mock.calls[0] as any)[3].options[0];
    api.getMessages.mockResolvedValue([
      {
        message: { id: 41, answeredAt: "now", answerPayload: { optionId: 7 } },
        messageOptions: [{ id: 7, ...option }],
      },
    ]);
    await vi.advanceTimersByTimeAsync(1200);
    expect((await answer)[0].picked_option_value).toBe("blue");
    c.abort();
    await vi.runAllTimersAsync();
  });
  it("expiry and stale or fabricated approval values cannot authorize a command", async () => {
    vi.useFakeTimers();
    const { bridge, ctx } = fixture();
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "write protected file",
        availableDecisions: ["accept", "decline"],
      },
    );
    await tick();
    bridge.handleClick({
      assistantId: 9,
      chatId: 17,
      userId: "owner",
      messageId: 41,
      optionId: 1,
      callbackData: "ea:once:wrong",
    });
    await vi.advanceTimersByTimeAsync(55_000);
    expect(await answer).toEqual({ decision: "decline" });
    expect(
      bridge.handleClick({
        assistantId: 9,
        chatId: 17,
        userId: "owner",
        messageId: 41,
        optionId: 1,
        callbackData: "ea:once:stale",
      }),
    ).toBe(true);
  });
  it("granting a supported scope returns exactly that native decision", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.approve(ctx, "item/permissions/requestApproval", {
      permissions: { network: { enabled: true } },
    });
    await tick();
    const option = (api.agentRequest.mock.calls[0] as any)[3].options.find(
      (o: any) => o.text === "Allow once",
    );
    bridge.handleClick({
      assistantId: 9,
      chatId: 17,
      userId: "owner",
      messageId: 41,
      optionId: 1,
      callbackData: option.callbackData,
    });
    expect(await answer).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
    });
    c.abort();
    await vi.runAllTimersAsync();
  });
  it("cancelling the requesting turn resolves every pending question", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, c } = fixture();
    const answer = bridge.ask(ctx, [{ text: "Pick", options: [] }]);
    await tick();
    c.abort();
    expect((await answer)[0].skipped).toBe(true);
    await vi.runAllTimersAsync();
  });
});
