import { afterEach, describe, expect, it, vi } from "vitest";
import { Interactions } from "../src/interactions.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const c = new AbortController();
  const api = {
    agentRequest: vi.fn(async () => ({ id: 41 })),
    getMessages: vi.fn(async () => [] as any[]),
    getApprovalWaitSeconds: vi.fn(async (): Promise<number | null> => null),
  };
  return {
    c,
    api,
    bridge: new Interactions(api as any),
    ctx: { assistantId: 9, chatId: 17, userId: "owner", signal: c.signal },
  };
}
// approve() reads the owner's wait before it posts, so a request now settles a
// few microtasks later than it used to. Flush generously rather than count.
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
describe("interactive answers and native execution decisions", () => {
  it("rejects a form with neither choices nor an answer input before writing", async () => {
    const { bridge, ctx, api } = fixture();
    await expect(
      bridge.ask(ctx, [
        { text: "Unanswerable", options: [], allow_free_text: false },
      ]),
    ).rejects.toThrow("Invalid question");
    expect(api.agentRequest).not.toHaveBeenCalled();
  });
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
    // 150 s, not the old 55 s: with no readable wait the backstop is the
    // backend's own 60 s default plus the 90 s of slack that lets the server
    // flag the row first. The guard this test carries is unchanged: a
    // fabricated id never authorizes, before or after the wait ends.
    await vi.advanceTimersByTimeAsync(150_000);
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
    const { bridge, ctx, c, api } = fixture();
    const answer = bridge.ask(ctx, [{ text: "Pick", options: [] }]);
    await tick();
    c.abort();
    expect((await answer)[0].skipped).toBe(true);
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/41", 9, {
      options: [],
      renderMode: "inline",
    });
    await vi.runAllTimersAsync();
  });
  it("retires expired question controls and ignores a late selection", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api } = fixture();
    const answer = bridge.ask(
      ctx,
      [{ text: "Pick", options: [{ label: "Blue", value: "blue" }] }],
      1,
    );
    await tick();
    const callbackData = (api.agentRequest.mock.calls[0] as any)[3].options[0]
      .callbackData;
    await vi.advanceTimersByTimeAsync(1200);
    expect((await answer)[0]).toMatchObject({ skipped: true, timed_out: true });
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/41", 9, {
      options: [],
      renderMode: "inline",
    });
    expect(
      bridge.handleClick({
        assistantId: 9,
        chatId: 17,
        userId: "owner",
        messageId: 41,
        optionId: 1,
        callbackData,
      }),
    ).toBe(true);
    await vi.runAllTimersAsync();
  });
});

describe("an approval waits for the server's verdict, not a local clock", () => {
  const approvalBody = (api: { agentRequest: { mock: { calls: any[][] } } }) =>
    api.agentRequest.mock.calls[0]![3];
  const allowOnce = (api: { agentRequest: { mock: { calls: any[][] } } }) =>
    approvalBody(api).options.find((o: any) => o.text === "Allow once")
      .callbackData;

  it("tells the server how long the owner's own wait is", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    api.getApprovalWaitSeconds.mockResolvedValue(600);
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "rm -rf build",
      },
    );
    await tick();
    expect(api.getApprovalWaitSeconds).toHaveBeenCalledWith(9);
    expect(approvalBody(api).approvalMeta.wait_seconds).toBe(600);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("claims no wait on the row when it could not read one", async () => {
    vi.useFakeTimers();
    const unreadable = fixture();
    unreadable.api.getApprovalWaitSeconds.mockResolvedValue(null);
    const first = unreadable.bridge.approve(
      unreadable.ctx,
      "item/commandExecution/requestApproval",
      { command: "ls" },
    );
    await tick();
    expect(approvalBody(unreadable.api).approvalMeta).not.toHaveProperty(
      "wait_seconds",
    );
    unreadable.c.abort();
    await vi.runAllTimersAsync();
    await first;

    // A read that throws is the same story as a read that says nothing: the
    // request still goes out, it just does not claim a wait it cannot honour.
    const broken = fixture();
    broken.api.getApprovalWaitSeconds.mockRejectedValue(new Error("offline"));
    const second = broken.bridge.approve(
      broken.ctx,
      "item/commandExecution/requestApproval",
      { command: "ls" },
    );
    await tick();
    expect(broken.api.agentRequest).toHaveBeenCalled();
    expect(approvalBody(broken.api).approvalMeta).not.toHaveProperty(
      "wait_seconds",
    );
    broken.c.abort();
    await vi.runAllTimersAsync();
    await second;
  });

  it("posts nothing when the turn is stopped while it is reading the wait", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    // The read sits in front of the POST and is allowed up to 3 s. A Stop
    // inside it used to still put a live request card in the owner's chat for
    // a turn that was already dead, and the abort ending then walks straight
    // past the card it just made.
    api.getApprovalWaitSeconds.mockImplementation(async () => {
      c.abort();
      return 600;
    });
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "deploy",
      },
    );
    await tick();
    expect(await answer).toEqual({ decision: "decline" });
    expect(api.agentRequest).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
  });

  it("does not give up a minute in while the card is still answerable", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    api.getApprovalWaitSeconds.mockResolvedValue(600);
    let settled = false;
    const answer = bridge
      .approve(ctx, "item/commandExecution/requestApproval", {
        command: "deploy",
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await tick();
    await vi.advanceTimersByTimeAsync(56_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(244_000);
    expect(settled).toBe(false);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("honours a yes that arrives in the last seconds of a ten minute wait", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api } = fixture();
    api.getApprovalWaitSeconds.mockResolvedValue(600);
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "deploy",
        availableDecisions: ["accept", "decline"],
      },
    );
    await tick();
    const callbackData = allowOnce(api);
    await vi.advanceTimersByTimeAsync(590_000);
    bridge.handleClick({
      assistantId: 9,
      chatId: 17,
      userId: "owner",
      messageId: 41,
      optionId: 1,
      callbackData,
    });
    expect(await answer).toEqual({ decision: "accept" });
    await vi.runAllTimersAsync();
  });

  it("ends the wait when the server flags the row expired, and absorbs a later click", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api } = fixture();
    api.getApprovalWaitSeconds.mockResolvedValue(600);
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "deploy",
        availableDecisions: ["accept", "decline"],
      },
    );
    await tick();
    const callbackData = allowOnce(api);
    api.getMessages.mockResolvedValue([
      { message: { id: 41, approvalMeta: { expired: true } } },
    ]);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await answer).toEqual({ decision: "decline" });
    // The row the SERVER called dead is never retired from here: the flag is
    // already what makes the card refuse a tap.
    expect(api.agentRequest).not.toHaveBeenCalledWith(
      "PATCH",
      "messages/41",
      9,
      { options: [] },
    );
    expect(
      bridge.handleClick({
        assistantId: 9,
        chatId: 17,
        userId: "owner",
        messageId: 41,
        optionId: 1,
        callbackData,
      }),
    ).toBe(true);
    await vi.runAllTimersAsync();
  });

  it("falls back to its own backstop when the server never judges the row", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api } = fixture();
    api.getApprovalWaitSeconds.mockResolvedValue(600);
    let settled = false;
    const answer = bridge
      .approve(ctx, "item/commandExecution/requestApproval", {
        command: "deploy",
        availableDecisions: ["accept", "decline"],
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await tick();
    // The 90 s of slack is the whole point of the backstop, so pin its LOWER
    // edge too. Without this line the constant could shrink to the owner's own
    // wait and every test would stay green, which puts the daemon's deadline
    // back in front of the server's: the sweep sets `expired` up to 30 s after
    // the row's deadline, and a tap inside that window is accepted and stamped
    // while Codex has already answered decline. That is the 55 s versus 60 s
    // hole this lane exists to close, at a different pair of numbers.
    await vi.advanceTimersByTimeAsync(689_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toEqual({ decision: "decline" });
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/41", 9, {
      options: [],
    });
    await vi.runAllTimersAsync();
  });

  it("retires the card when the owner stops the turn, not only on the backstop", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    api.getApprovalWaitSeconds.mockResolvedValue(600);
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "deploy",
        availableDecisions: ["accept", "decline"],
      },
    );
    await tick();
    const callbackData = allowOnce(api);
    await vi.advanceTimersByTimeAsync(10_000);
    // Stop. The turn is dead, so nobody is listening for the answer any more,
    // and the SERVER will not call this row dead for another ten minutes: its
    // sweep only looks past the row's own deadline. Leaving the card lit means
    // the owner taps Allow, the backend stamps it, the card says "You said yes,
    // this once", and nothing runs. The longer the owner's wait, the wider that
    // window, which is why this ending has to retire the card the way ask()
    // already does.
    c.abort();
    expect(await answer).toEqual({ decision: "decline" });
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/41", 9, {
      options: [],
    });
    expect(
      bridge.handleClick({
        assistantId: 9,
        chatId: 17,
        userId: "owner",
        messageId: 41,
        optionId: 1,
        callbackData,
      }),
    ).toBe(true);
    await vi.runAllTimersAsync();
  });

  it("gives the permissions request its own empty shape on the backstop", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api } = fixture();
    api.getApprovalWaitSeconds.mockResolvedValue(60);
    const answer = bridge.approve(ctx, "item/permissions/requestApproval", {
      permissions: { network: { enabled: true } },
    });
    await tick();
    await vi.advanceTimersByTimeAsync(150_000);
    expect(await answer).toEqual({ permissions: {}, scope: "turn" });
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/41", 9, {
      options: [],
    });
    await vi.runAllTimersAsync();
  });
});
