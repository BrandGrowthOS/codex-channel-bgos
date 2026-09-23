import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_HOLD_SECONDS,
  Interactions,
  POLL_FAST_MS,
  POLL_FAST_WINDOW_MS,
  POLL_MAX_SPAN,
  POLL_SLOW_MS,
  coalesceReads,
  pollIntervalMs,
  retireOrphanedApprovals,
  storedWaitSeconds,
} from "../src/interactions.js";
import type {
  PendingApprovalEntry,
  PendingApprovalStore,
} from "../src/pending-approvals-store.js";

afterEach(() => vi.useRealTimers());
/**
 * The durable record of open cards, in memory. The daemon writes this to disk
 * (pending-approvals-store.ts); a unit test must not, and the behaviour worth
 * pinning here is what gets recorded and when it is forgotten.
 */
function memoryStore(seed: PendingApprovalEntry[] = []): PendingApprovalStore {
  let entries = [...seed];
  return {
    load: () => [...entries],
    record: (entry) => {
      if (!entries.some((e) => e.id === entry.id)) entries.push(entry);
    },
    clear: (id) => {
      entries = entries.filter((e) => e.id !== id);
    },
  };
}
/**
 * `created` is what the POST answers with, which is where the SERVER's own
 * stored wait comes back from. The default carries none, which is an older
 * backend that ignored the field.
 */
function fixture(created: Record<string, unknown> = { id: 41 }) {
  const c = new AbortController();
  const api = {
    agentRequest: vi.fn(async () => created),
    getMessages: vi.fn(
      async (
        _chatId: number,
        _userId: string,
        _cursor?: { beforeId?: number; limit?: number },
      ) => [] as any[],
    ),
  };
  const store = memoryStore();
  return {
    c,
    api,
    store,
    bridge: new Interactions(api as any, store),
    ctx: { assistantId: 9, chatId: 17, userId: "owner", signal: c.signal },
  };
}
// A request settles a few microtasks after its POST resolves. Flush generously
// rather than count: the exact number is nobody's contract.
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
    const { bridge, ctx } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 60 },
    });
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
    // 150 s, not the old 55 s: the server stored a 60 s wait on this row, and
    // the backstop is that plus the 90 s of slack that lets the server flag
    // the row first. The guard this test carries is unchanged: a fabricated id
    // never authorizes, before or after the wait ends.
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

  it("offers the longest it can hold, and asks the owner's settings nothing", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "rm -rf build",
      },
    );
    await tick();
    // The plugin offers and the server decides. There is exactly one call, the
    // POST of the card: no GET of the agent, and no per-request read of any
    // kind in front of a person who is waiting to see the card.
    expect(api.agentRequest).toHaveBeenCalledTimes(1);
    expect(api.agentRequest.mock.calls[0]!.slice(0, 2)).toEqual([
      "POST",
      "messages",
    ]);
    expect(approvalBody(api).approvalMeta.wait_seconds).toBe(
      APPROVAL_HOLD_SECONDS,
    );
    expect(APPROVAL_HOLD_SECONDS).toBe(1800);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("posts the card without awaiting anything first", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    // Not a style point. Wave A read the owner's wait before it posted, and
    // that read was allowed up to 3 s: three seconds of nothing, in front of
    // the one moment a person is actually waiting on this daemon. The POST is
    // now the first thing approve() does, so it is already on the wire before
    // this line runs, with no flush at all.
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "deploy",
      },
    );
    expect(api.agentRequest).toHaveBeenCalledTimes(1);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("waits by the number the SERVER stored, not the one it asked for", async () => {
    vi.useFakeTimers();
    // The owner chose five minutes, so the server clamped this daemon's half
    // hour down to 300 s and said so on the created message. Waiting our own
    // 1800 s here would leave the turn parked for twenty five minutes after
    // the card was already dead.
    const { bridge, ctx, c } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 300 },
    });
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
    await vi.advanceTimersByTimeAsync(389_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toEqual({ decision: "decline" });
    c.abort();
    await vi.runAllTimersAsync();
  });

  it("falls back to its own ceiling when the response carries no stored wait", async () => {
    vi.useFakeTimers();
    // An older backend strips or ignores `wait_seconds`, so the row on that
    // server lives 60 s. We cannot tell that from here, and guessing 60 s puts
    // this daemon's deadline back in front of the server's on every deployment
    // that DOES honour the field. Hold our full ceiling and let the server's
    // flag end the wait, which it will, 90 s before we would.
    const { bridge, ctx, c } = fixture();
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
    await vi.advanceTimersByTimeAsync((APPROVAL_HOLD_SECONDS + 89) * 1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toEqual({ decision: "decline" });
    c.abort();
    await vi.runAllTimersAsync();
  });

  it("trusts a stored wait only when it is a whole number the server could have stored", () => {
    expect(storedWaitSeconds({ approvalMeta: { wait_seconds: 1 } })).toBe(1);
    expect(
      storedWaitSeconds({ approvalMeta: { wait_seconds: APPROVAL_HOLD_SECONDS } }),
    ).toBe(APPROVAL_HOLD_SECONDS);
    // Everything a server that does not speak this field can hand back. Each
    // one means "no stored wait", never a shorter one: a bad number here would
    // silently move this daemon's deadline in front of the server's.
    for (const wait_seconds of [
      0,
      -1,
      APPROVAL_HOLD_SECONDS + 1,
      600.5,
      "600",
      null,
      true,
      Number.NaN,
    ])
      expect(storedWaitSeconds({ approvalMeta: { wait_seconds } })).toBeNull();
    expect(storedWaitSeconds({ approvalMeta: {} })).toBeNull();
    expect(storedWaitSeconds({ id: 41 })).toBeNull();
    expect(storedWaitSeconds(null)).toBeNull();
    expect(storedWaitSeconds(undefined)).toBeNull();
  });

  it("does not give up a minute in while the card is still answerable", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, c } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 600 },
    });
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
    const { bridge, ctx, api } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 600 },
    });
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
    const { bridge, ctx, api } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 600 },
    });
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
    const { bridge, ctx, api } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 600 },
    });
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
    // edge too. Without this line the constant could shrink to the stored wait
    // and every test would stay green, which puts the daemon's deadline back in
    // front of the server's: the sweep sets `expired` up to 30 s after the
    // row's deadline, and a tap inside that window is accepted and stamped
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
    const { bridge, ctx, api, c } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 600 },
    });
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

  it("posts nothing at all for a turn that was already stopped", async () => {
    // A card posted for a dead turn is not untidiness. With stage 1 it is also
    // a needsYou push at the owner's phone, and then a row this daemon strips
    // the buttons off a moment later, which the app still draws as a pending
    // request. One line at the head of approve() prevents all of that and
    // nothing was pinning it: deleting it left the whole file green.
    for (const [method, denied] of [
      ["item/commandExecution/requestApproval", { decision: "decline" }],
      ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ] as const) {
      const { bridge, ctx, api, c } = fixture();
      c.abort();
      expect(
        await bridge.approve(ctx, method, {
          command: "deploy",
          permissions: { network: { enabled: true } },
        }),
      ).toEqual(denied);
      expect(api.agentRequest).not.toHaveBeenCalled();
    }
  });

  it("reads the row it is waiting on, not the chat's newest page", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 600 },
    });
    // The chat moved on. In a meeting with other agents and other people, more
    // than a page of messages can land in the half hour a request may now sit
    // there, and this route answers with the NEWEST 50 rows when nobody says
    // otherwise. The poll is the expiry detector and the healing path, so a
    // poll that has lost sight of its own row reopens the exact defect this
    // lane closes: the owner taps Allow at minute three, the socket click is
    // dropped, and the daemon declines at minute thirty one off its backstop.
    // `beforeId` filters id < beforeId and the page is taken newest first, so
    // beforeId = id + 1 puts our row first whatever else arrived.
    api.getMessages.mockImplementation(async (_chatId, _userId, cursor) =>
      cursor?.beforeId === 42
        ? [{ message: { id: 41, approvalMeta: { expired: true } } }]
        : [{ message: { id: 900 } }, { message: { id: 901 } }],
    );
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "deploy",
        availableDecisions: ["accept", "decline"],
      },
    );
    await tick();
    await vi.advanceTimersByTimeAsync(1200);
    // Asserted before the answer on purpose: a poll that reads the tail never
    // settles this request at all, and a hung test says far less than a named
    // cursor that was not sent.
    expect(api.getMessages).toHaveBeenCalledWith(17, "owner", {
      beforeId: 42,
      limit: 1,
    });
    expect(await answer).toEqual({ decision: "decline" });
    await vi.runAllTimersAsync();
  });

  it("gives the permissions request its own empty shape on the backstop", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 60 },
    });
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

/**
 * THE POLL IS THE HEALING PATH, AND IT READS A WHOLE CHAT EVERY TIME.
 *
 * At the old flat 1.2 s, one request left open for half an hour is about 1,500
 * full history reads against one small host, for one person who has not looked
 * at their phone yet. The socket click is the fast path; this poll exists to
 * heal a dropped click and to notice the server's expiry flag, and neither
 * needs to be checked every second for thirty minutes.
 */
describe("the durable poll's cadence", () => {
  it("stays fast for the first minute of an approval, then backs off", () => {
    expect(pollIntervalMs({ ageMs: 0, backsOff: true })).toBe(POLL_FAST_MS);
    expect(
      pollIntervalMs({ ageMs: POLL_FAST_WINDOW_MS - 1, backsOff: true }),
    ).toBe(POLL_FAST_MS);
    expect(pollIntervalMs({ ageMs: POLL_FAST_WINDOW_MS, backsOff: true })).toBe(
      POLL_SLOW_MS,
    );
    expect(pollIntervalMs({ ageMs: 1_800_000, backsOff: true })).toBe(
      POLL_SLOW_MS,
    );
    expect([POLL_FAST_MS, POLL_SLOW_MS, POLL_FAST_WINDOW_MS]).toEqual([
      1200, 5000, 60_000,
    ]);
  });

  it("never backs a question off, whatever its age", () => {
    // A question is answered by a person reading a modal, and its whole life
    // is 600 s. It kept the 1.2 s poll before this change and it keeps it now.
    expect(pollIntervalMs({ ageMs: 599_000, backsOff: false })).toBe(
      POLL_FAST_MS,
    );
  });

  it("answers per request, so one entry's age never speaks for another", () => {
    // The pace is a property of ONE pending request, not of the map. A shared
    // answer for the whole map is what let a young question anywhere pull every
    // parked request back to 1.2 s; the loop now asks this per entry and reads
    // each row on its own clock (see the two cadence tests below).
    expect(pollIntervalMs({ ageMs: 1_000, backsOff: true })).toBe(POLL_FAST_MS);
    expect(pollIntervalMs({ ageMs: 900_000, backsOff: true })).toBe(
      POLL_SLOW_MS,
    );
  });

  it("reads the chat far less often once a request has been parked a minute", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 600 },
    });
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      {
        command: "deploy",
      },
    );
    await tick();
    api.getMessages.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_FAST_WINDOW_MS);
    // 60 s at 1.2 s is about 50 reads, and at 5 s it would be 12.
    expect(api.getMessages.mock.calls.length).toBeGreaterThan(40);
    api.getMessages.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getMessages.mock.calls.length).toBeLessThan(15);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  /**
   * Two pending requests, two chats, two ids. The shared fixture answers every
   * POST with the same id 41, and the pending map is keyed by id, so a test
   * about two live requests has to hand out real ones.
   */
  function twoChatFixture() {
    const c = new AbortController();
    let nextId = 41;
    const api = {
      agentRequest: vi.fn(async () => ({
        id: nextId++,
        approvalMeta: { wait_seconds: 600 },
      })),
      getMessages: vi.fn(
        async (
          _chatId: number,
          _userId: string,
          _cursor?: { beforeId?: number; limit?: number },
        ) => [] as any[],
      ),
    };
    const bridge = new Interactions(api as any, memoryStore());
    const ctx = {
      assistantId: 9,
      chatId: 17,
      userId: "owner",
      signal: c.signal,
    };
    const readsOf = (chatId: number) =>
      api.getMessages.mock.calls.filter((call) => call[0] === chatId).length;
    return { c, api, bridge, ctx, readsOf };
  }

  it("does not speed a parked request back up for a question in another chat", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c, readsOf } = twoChatFixture();
    const approval = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      { command: "deploy" },
    );
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    const question = bridge.ask({ ...ctx, chatId: 99 }, [
      { text: "Pick", options: [{ label: "Blue", value: "blue" }] },
    ]);
    await tick();
    api.getMessages.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    // The question is young and in front of a person, so it keeps 1.2 s. The
    // approval has been parked two minutes in a DIFFERENT chat and must stay on
    // the slow cadence: one shared sleep for the whole map meant a single
    // question anywhere pulled every parked request back to 1.2 s, which is
    // precisely the traffic this change exists to remove.
    expect(readsOf(99)).toBeGreaterThan(40);
    expect(readsOf(17)).toBeLessThan(15);
    c.abort();
    await vi.runAllTimersAsync();
    await Promise.all([approval, question]);
  });

  it("reads a newly raised request without waiting out the slow sleep", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c, readsOf } = twoChatFixture();
    const approval = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      { command: "deploy" },
    );
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    api.getMessages.mockClear();
    const question = bridge.ask({ ...ctx, chatId: 99 }, [
      { text: "Pick", options: [{ label: "Blue", value: "blue" }] },
    ]);
    await tick();
    // No clock has moved since the question was raised. The loop was parked on
    // a 5 s sleep and `wait()` settles that sleep, because `void this.poll()`
    // returns at once while the loop is already running: without the wake, the
    // newest request, the one somebody is most likely about to answer, healed a
    // dropped click up to five seconds later than it did before the backoff.
    expect(readsOf(99)).toBeGreaterThan(0);
    c.abort();
    await vi.runAllTimersAsync();
    await Promise.all([approval, question]);
  });

  it("keeps a question on the fast cadence for its whole life", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.ask(ctx, [
      { text: "Pick", options: [{ label: "Blue", value: "blue" }] },
    ]);
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    api.getMessages.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getMessages.mock.calls.length).toBeGreaterThan(40);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });
});

/**
 * ONE READ FOR THE ROWS THAT FALL DUE TOGETHER.
 *
 * Pinning the durable read to its own row fixed a real defect (a row pushed off
 * the tail page is a request whose dropped click can never heal) and cost one
 * request per PENDING ROW. An ask carousel is up to four rows in one chat on
 * one clock, so that was four times the traffic on the very path the backoff
 * had just quietened. Their ids are consecutive, so one page covers them.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - going back to one read per row (calling readDue once per entry) turns the
 *    carousel case red at four calls instead of one.
 *  - sizing the page by the COUNT of due rows instead of their id span turns
 *    the interleaved case red: the oldest question falls off the page.
 *  - raising POLL_MAX_SPAN past the gap in the split case, or lowering it below
 *    four, turns the grouping case red.
 */
describe("the durable poll coalesces the rows of one chat", () => {
  it("covers consecutive rows with one read and splits distant ones", () => {
    expect(coalesceReads([41, 42, 43, 44])).toEqual([[41, 42, 43, 44]]);
    // Unsorted in, ascending out: the map's insertion order is not the ids'.
    expect(coalesceReads([44, 41])).toEqual([[41, 44]]);
    // A lone approval and a carousel in the same chat are not one page: the
    // span between them is wider than any read should carry.
    expect(coalesceReads([41, 900, 901])).toEqual([[41], [900, 901]]);
    expect(coalesceReads([41, 41 + POLL_MAX_SPAN])).toEqual([
      [41],
      [41 + POLL_MAX_SPAN],
    ]);
    expect(coalesceReads([41, 41 + POLL_MAX_SPAN - 1])).toEqual([
      [41, 41 + POLL_MAX_SPAN - 1],
    ]);
    expect(POLL_MAX_SPAN).toBe(12);
  });

  /** Four questions in one chat, with the ids a real carousel gets. */
  function carouselFixture(ids: number[]) {
    const c = new AbortController();
    let next = 0;
    const api = {
      agentRequest: vi.fn(async () => ({ id: ids[next++] })),
      getMessages: vi.fn(
        async (
          _chatId: number,
          _userId: string,
          _cursor?: { beforeId?: number; limit?: number },
        ) => [] as any[],
      ),
    };
    return {
      c,
      api,
      bridge: new Interactions(api as any, memoryStore()),
      ctx: { assistantId: 9, chatId: 17, userId: "owner", signal: c.signal },
    };
  }
  const fourQuestions = [1, 2, 3, 4].map((n) => ({
    text: `Q${n}`,
    options: [{ label: "Blue", value: "blue" }],
  }));

  it("costs one request per tick for a four question carousel, not four", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = carouselFixture([41, 42, 43, 44]);
    const answers = bridge.ask(ctx, fourQuestions);
    await tick();
    api.getMessages.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(api.getMessages).toHaveBeenCalledTimes(1);
    // Newest first from beforeId, four rows deep: the whole carousel.
    expect(api.getMessages).toHaveBeenCalledWith(17, "owner", {
      beforeId: 45,
      limit: 4,
    });
    c.abort();
    await vi.runAllTimersAsync();
    await answers;
  });

  it("still reaches the oldest question when the chat interleaved a message", async () => {
    vi.useFakeTimers();
    // A message landed between the second and third question, so the four rows
    // are no longer four ids wide. A page sized to the COUNT would stop at 43
    // and leave question one unread for the rest of its life.
    const { bridge, ctx, api, c } = carouselFixture([41, 42, 44, 45]);
    const answers = bridge.ask(ctx, fourQuestions);
    await tick();
    api.getMessages.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(api.getMessages).toHaveBeenCalledTimes(1);
    expect(api.getMessages).toHaveBeenCalledWith(17, "owner", {
      beforeId: 46,
      limit: 5,
    });
    c.abort();
    await vi.runAllTimersAsync();
    await answers;
  });
});

/**
 * A RESTART TAKES THE TURN AND LEAVES THE CARD.
 *
 * The app server is a child of this daemon, so a restart mid wait ends the turn
 * and the request together and nothing can ever answer the card. The backend
 * refuses a late tap only by the row's `expired` flag, which its sweep sets at
 * the row's own deadline: with a stored wait of up to half an hour that is up
 * to half an hour of a live card for a turn that no longer exists. The owner
 * taps Allow, the card says "You said yes, this once", and nothing runs.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - dropping the `store.record` call in approve() empties the recorded case.
 *  - dropping the `store.clear` call after the wait leaves the entry behind and
 *    the same case goes red on the second assertion.
 *  - skipping the PATCH in retireOrphanedApprovals, or sending anything but
 *    `options: []`, turns the boot case red.
 *  - treating an answered or expired row as still open turns the settled case
 *    red: it would strip the buttons off a card the owner already answered.
 *  - clearing the entry when the PATCH throws turns the retry case red.
 */
describe("a restart retires the cards it can no longer answer", () => {
  it("records the card while the owner holds it and forgets it when the wait ends", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, store, c } = fixture({
      id: 41,
      approvalMeta: { wait_seconds: 600 },
    });
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      { command: "deploy" },
    );
    await tick();
    expect(store.load()).toEqual([
      {
        id: 41,
        chatId: 17,
        assistantId: 9,
        userId: "owner",
        at: expect.any(Number),
      },
    ]);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
    // This process answered it, so nothing is left for a later boot to retire.
    expect(store.load()).toEqual([]);
  });

  it("takes the buttons off a card nothing is listening to any more", async () => {
    const api = {
      agentRequest: vi.fn(async () => ({})),
      getMessages: vi.fn(async () => [
        { message: { id: 41, messageType: "approval_request" } },
      ]),
    };
    const store = memoryStore([
      { id: 41, chatId: 17, assistantId: 9, userId: "owner", at: Date.now() },
    ]);
    expect(await retireOrphanedApprovals(api as any, store)).toBe(1);
    expect(api.getMessages).toHaveBeenCalledWith(17, "owner", {
      beforeId: 42,
      limit: 1,
    });
    expect(api.agentRequest).toHaveBeenCalledWith("PATCH", "messages/41", 9, {
      options: [],
    });
    expect(store.load()).toEqual([]);
  });

  it("leaves a card the owner answered, or the server flagged, exactly as it is", async () => {
    const rows: Record<number, any> = {
      41: { id: 41, answeredAt: "now", answerPayload: { optionId: 7 } },
      42: { id: 42, approvalMeta: { expired: true } },
    };
    const api = {
      agentRequest: vi.fn(async () => ({})),
      getMessages: vi.fn(
        async (_chatId: number, _userId: string, cursor: any) => [
          { message: rows[cursor.beforeId - 1] },
        ],
      ),
    };
    const store = memoryStore([
      { id: 41, chatId: 17, assistantId: 9, userId: "owner", at: Date.now() },
      { id: 42, chatId: 17, assistantId: 9, userId: "owner", at: Date.now() },
    ]);
    expect(await retireOrphanedApprovals(api as any, store)).toBe(0);
    // An answered card keeps its record of what the owner chose, and an expired
    // one already refuses a tap: a PATCH here would only rewrite history.
    expect(api.agentRequest).not.toHaveBeenCalled();
    expect(store.load()).toEqual([]);
  });

  it("keeps the entry when the retiring write fails, so the next boot tries again", async () => {
    const api = {
      agentRequest: vi.fn(async () => {
        throw new Error("offline");
      }),
      getMessages: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    const store = memoryStore([
      { id: 41, chatId: 17, assistantId: 9, userId: "owner", at: Date.now() },
    ]);
    expect(await retireOrphanedApprovals(api as any, store)).toBe(0);
    // A row it could not read is treated as still open: retiring a card that
    // was already answered costs nothing, a live card for a dead turn is the
    // whole defect.
    expect(api.agentRequest).toHaveBeenCalledTimes(1);
    expect(store.load()).toHaveLength(1);
  });

  it("forgets a card too old for the server's own sweep to still be pending", async () => {
    const api = {
      agentRequest: vi.fn(async () => ({})),
      getMessages: vi.fn(async () => []),
    };
    const store = memoryStore([
      {
        id: 41,
        chatId: 17,
        assistantId: 9,
        userId: "owner",
        at: Date.now() - 25 * 60 * 60 * 1000,
      },
    ]);
    expect(await retireOrphanedApprovals(api as any, store)).toBe(0);
    expect(api.getMessages).not.toHaveBeenCalled();
    expect(store.load()).toEqual([]);
  });
});

/**
 * The file change card, after stage 4: it says WHICH files.
 *
 * Today a Codex file change ask is two generic sentences and three chips.
 * `params.command` is absent on a file change request and `params.reason`
 * arrives as an explicit `null` (a live probe on app server 0.154.0, four
 * runs), which `??` also falls through, so the owner reads "Codex needs your
 * approval to continue." over the literal "Apply file changes" and nothing in
 * the row names a file. The host joins the item that announced the change onto
 * these params by `itemId` (codex-host.ts, withFileChanges) and this method
 * turns the join into the ask sentence, the file list and the two capped,
 * masked fields on `approvalMeta`.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - dropping `change_summary` / `diff` off the typed ApprovalMeta and
 *    inlining them in the POST body leaves the fields on the wire and the
 *    compiler silent, which is the defect the typed interface exists to
 *    prevent; assign them under a camelCase name instead and the "carries the
 *    two fields" case goes red.
 *  - building the wire for every approval method rather than the file change
 *    one turns the command case red.
 *  - letting a miss hold or fail the RPC, instead of posting as before, turns
 *    the "join that missed" case red.
 *  - letting `reason` lose to the ask sentence turns the "reason wins" case
 *    red.
 *  - dropping META_RESERVE_BYTES to 0 in file-change-wire.ts turns the "posts
 *    an approvalMeta the server's byte cap accepts" case red: it weighs the
 *    posted block, which is what the server weighs, and not the three keys
 *    the daemon's own cut measures.
 */
describe("a file change approval names the files it is asking about", () => {
  const CHANGES = [
    {
      path: "/work/project/calc.py",
      kind: { type: "update", move_path: null },
      diff: "@@ -3,3 +3,4 @@\n alpha\n-beta\n+beta (edited)\n+delta\n gamma\n",
    },
    {
      path: "/work/project/CHANGELOG.md",
      kind: { type: "add" },
      diff: "@@ -0,0 +1 @@\n+entry\n",
    },
  ];

  it("carries the two fields, the ask sentence and the file list", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.approve(ctx, "item/fileChange/requestApproval", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "call_3",
      startedAtMs: 1790152546803,
      reason: null,
      grantRoot: null,
      // What the host joined on, off the `item/started` notification.
      changes: CHANGES,
      cwd: "/work/project",
    });
    await tick();
    const body = (api.agentRequest.mock.calls[0] as any)[3];
    expect(body.text).toBe("Change calc.py and 1 more file");
    expect(body.approvalMeta.tool).toBe("calc.py (update)\nCHANGELOG.md (add)");
    expect(body.approvalMeta.change_summary).toEqual({
      file_count: 2,
      total_added: 3,
      total_removed: 1,
      files: [
        { path: "calc.py", kind: "update", added: 2, removed: 1, preview: "ok" },
        { path: "CHANGELOG.md", kind: "add", added: 1, removed: 0, preview: "ok" },
      ],
    });
    expect(body.approvalMeta.diff.truncated).toBe(false);
    expect(body.approvalMeta.diff.files[0]).toEqual({
      path: "calc.py",
      patch: "@@ -3,3 +3,4 @@\n alpha\n-beta\n+beta (edited)\n+delta\n gamma",
      truncated: false,
      omitted_lines: 0,
      hidden_lines: 0,
    });
    // Stage 1's fields are exactly as stage 1 left them.
    expect(body.approvalMeta).toMatchObject({
      agent_route: "codex-9",
      risk: "high",
      wait_seconds: APPROVAL_HOLD_SECONDS,
    });
    // The session chip still arrives, through the `!availableDecisions`
    // fallback, because the runtime sends no such field on this method.
    expect(body.options.map((o: any) => o.text)).toEqual([
      "Allow once",
      "Allow for session",
      "Deny",
    ]);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("posts exactly as it did before stage 4 when the join missed", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    // Nothing in the protocol orders `item/started` in front of the request.
    // Ten milliseconds was measured, not promised, so a miss is an ordinary
    // outcome and it must never hold or fail the RPC.
    const answer = bridge.approve(ctx, "item/fileChange/requestApproval", {
      itemId: "call_3",
      reason: null,
      grantRoot: null,
    });
    await tick();
    const body = (api.agentRequest.mock.calls[0] as any)[3];
    expect(body.text).toBe("Codex needs your approval to continue.");
    expect(body.approvalMeta.tool).toBe("Apply file changes");
    expect(body.approvalMeta).not.toHaveProperty("change_summary");
    expect(body.approvalMeta).not.toHaveProperty("diff");
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("lets the runtime's own sentence win when it fills one", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.approve(ctx, "item/fileChange/requestApproval", {
      itemId: "call_3",
      reason: "This patch writes outside your workspace.",
      changes: CHANGES,
      cwd: "/work/project",
    });
    await tick();
    const body = (api.agentRequest.mock.calls[0] as any)[3];
    expect(body.text).toBe("This patch writes outside your workspace.");
    // The list is still the list: the title and the mono panel are two
    // strings and the reason only ever replaces the title.
    expect(body.approvalMeta.tool).toBe("calc.py (update)\nCHANGELOG.md (add)");
    expect(body.approvalMeta.change_summary.file_count).toBe(2);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("leaves a command approval and a permissions approval untouched", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.approve(
      ctx,
      "item/commandExecution/requestApproval",
      { command: "rm -rf build", changes: CHANGES },
    );
    await tick();
    const body = (api.agentRequest.mock.calls[0] as any)[3];
    expect(body.approvalMeta.tool).toBe("rm -rf build");
    expect(body.approvalMeta).not.toHaveProperty("change_summary");
    expect(body.approvalMeta).not.toHaveProperty("diff");
    // And no patch body rode along on a card that is not a file change.
    expect(JSON.stringify(body)).not.toContain("beta (edited)");
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("masks a secret in the patch before the card is created", async () => {
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.approve(ctx, "item/fileChange/requestApproval", {
      itemId: "call_4",
      reason: null,
      changes: [
        {
          path: "/work/project/.env",
          kind: { type: "update" },
          diff: "@@ -1 +1 @@\n+API_KEY=9f2b7c4a1e8d3f6b0c5a2e7d4b1f8c3a\n",
        },
      ],
      cwd: "/work/project",
    });
    await tick();
    const body = (api.agentRequest.mock.calls[0] as any)[3];
    expect(JSON.stringify(body)).not.toContain("9f2b7c4a1e8d3f6b0c5a2e7d4b1f8c3a");
    expect(body.approvalMeta.diff.files[0].hidden_lines).toBe(1);
    expect(body.text).toBe("Change .env");
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });

  it("posts an approvalMeta the server's byte cap accepts, measured on the WHOLE block", async () => {
    // The daemon weighs `{change_summary, diff, tool}` and adds a 1,024 byte
    // reserve as a stand in for the four stage 1 fields. Nothing measured the
    // block the SERVER measures, so the reserve going stale (the next field
    // added to ApprovalMeta) would show up as a 400 in production and as
    // green here, and a 400 costs the owner the whole card. This case weighs
    // the real posted body, off the mock, on a patch cut to the cap exactly.
    vi.useFakeTimers();
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.approve(ctx, "item/fileChange/requestApproval", {
      itemId: "call_5",
      reason: null,
      // One line, inside the unit cap and twice the byte cap, so the byte
      // cut lands on the limit and the stage 1 fields have nowhere to hide.
      changes: [
        {
          path: "/work/project/bundle.min.js",
          kind: { type: "update" },
          diff: `+${"\u0639".repeat(60_000)}`,
        },
      ],
      cwd: "/work/project",
    });
    await tick();
    const body = (api.agentRequest.mock.calls[0] as any)[3];
    expect(
      Buffer.byteLength(JSON.stringify(body.approvalMeta), "utf8"),
    ).toBeLessThanOrEqual(98_304);
    // Under the cap AND still a panel: an absent diff satisfies a byte cap
    // trivially, and the cut says how much of the file did not arrive.
    expect(body.approvalMeta.diff.files[0].patch.length).toBeGreaterThan(0);
    expect(body.approvalMeta.diff.files[0].omitted_lines).toBeGreaterThan(0);
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
  });
});
