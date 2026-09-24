import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_HOLD_SECONDS,
  EXECPOLICY_RULE_LEAD,
  Interactions,
  POLL_FAST_MS,
  POLL_FAST_WINDOW_MS,
  POLL_MAX_SPAN,
  POLL_SLOW_MS,
  coalesceReads,
  differingReason,
  execpolicyRuleText,
  soleActionCommand,
  titleCommandText,
  pollIntervalMs,
  retireOrphanedApprovals,
  storedWaitSeconds,
} from "../src/interactions.js";
import {
  APPROVAL_META_BYTES_MAX,
  COMMAND_TOOL_MAX_UNITS,
  REQUEST_REASON_MAX_UNITS,
} from "../src/file-change-wire.js";
import { clipWithEllipsis } from "../src/clip-text.js";
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

/**
 * Stage 5: a command approval says WHAT it would run, WHY the model is asking,
 * and WHAT pressing Always would save.
 *
 * All three come from params a `commandExecution` approval carries and this
 * daemon read none of before this stage. The shapes below are the ones a live
 * probe against app server 0.154.0 actually captured, twice, with a control
 * run beside them: `commandActions[0].command` is the command WITHOUT the
 * shell wrapper, `params.reason` is `exec_command`'s `justification` passed
 * through unaltered, and `proposedExecpolicyAmendment` is the WHOLE argv as a
 * string array, which stayed the whole argv even when the model supplied the
 * `prefix_rule` the tool schema advertises for narrowing it.
 *
 * The probe also proved the thing the rule sentence exists to say: answering
 * with the amendment APPENDED a permanent line to the owner's global
 * `~/.codex/rules/default.rules`, and the next identical command in the same
 * turn raised no approval at all, while the control's plain `accept` wrote
 * nothing and was asked again.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - drop the `askTitle` branch and let `text` fall back to the old
 *    `params.reason ?? generic` -> "reads the command back as the title" and
 *    "falls back to the wrapped command" go red.
 *  - drop the `trimmed === title.trim()` guard in `differingReason` -> "sends
 *    no reason when the sentence is already the title" goes red and the card
 *    reads one sentence twice.
 *  - stop quoting a token that holds whitespace in `execpolicyRuleText` ->
 *    "quotes only the tokens that hold whitespace" goes red and a three
 *    argument command reads as five.
 *  - use `clipText` in place of `clipWithEllipsis` -> "clips all three inside
 *    their caps" goes red on the ellipsis, and a cut command reads as a
 *    complete, shorter command.
 *  - send `rule_text` whenever the amendment is present, rather than only when
 *    the Always tier was offered -> "sends no rule beside a button that is not
 *    offered" goes red.
 *  - drop the `commandExecution &&` in front of the TITLE -> "sends neither
 *    string on a file change approval" goes red, because a file change that
 *    also carried a command would be retitled `Run git apply patch.diff`.
 *    That gate is the only one the METHOD owns: the reason is held off those
 *    cards by `differingReason` (on every other method the title IS that
 *    sentence) and the rule by the Always tier, not by a branch on the method,
 *    so a ternary in front of either would never change an answer. This list
 *    said otherwise until the stage 5 review ran it.
 *  - drop the `typeof first !== \"object\" || first === null` guard in
 *    `soleActionCommand` -> "survives every shape the runtime could put in
 *    commandActions" goes red on `[null]`, throwing inside an RPC the model is
 *    parked on.
 *  - raise or remove `COMMAND_TOOL_MAX_UNITS` on the non wire `tool` -> "cuts
 *    a runaway command inside the column the server will refuse" goes red, and
 *    a body past 98,304 bytes costs the owner the whole card.
 *  - assign either field under a camelCase name (`ruleText`) instead of on the
 *    typed ApprovalMeta -> "says what Always would save" goes red, which is
 *    the whole reason the interface is typed: the backend would drop it with a
 *    201 and no error.
 *  - run the clip BEFORE the mask in `titleCommandText` (fold, clip, then
 *    `redactOutput`) -> "draws the title on one line, with every secret in it
 *    masked" goes red: the title comes back as `... Bearer
 *    Zm9vYmFyYmF6cXV4cXV...` with 19 raw characters of the token, because the
 *    cut left one fewer than the bearer rule needs. Until the stage 5 review,
 *    that case put its secret PAST the cut, where both orders drop it, so the
 *    assertion could not fail.
 */
describe("a command approval says what it runs, why, and what Always would save", () => {
  /** The wrapper the runtime would really run, wrapped command and all. */
  const WRAPPED =
    '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command ' +
    "'echo exec-probe > probe.txt'";
  const AMENDMENT = [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "-Command",
    "echo exec-probe > probe.txt",
  ];
  /** The twelve fields the probe saw, in the order it saw them. */
  const COMMAND_PARAMS = {
    kind: "command",
    threadId: "t1",
    turnId: "turn-1",
    itemId: "call_1",
    startedAtMs: 1790152546803,
    environmentId: "local",
    reason: "Write probe.txt in the scratch directory",
    command: WRAPPED,
    cwd: "E:\\scratch",
    commandActions: [{ type: "unknown", command: "echo exec-probe > probe.txt" }],
    proposedExecpolicyAmendment: AMENDMENT,
    availableDecisions: [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: AMENDMENT } },
      "cancel",
    ],
  };

  async function post(params: Record<string, unknown>, method = "item/commandExecution/requestApproval") {
    const { bridge, ctx, api, c } = fixture();
    const answer = bridge.approve(ctx, method, params);
    await tick();
    const body = (api.agentRequest.mock.calls[0] as any)[3];
    c.abort();
    await vi.runAllTimersAsync();
    await answer;
    return body;
  }

  it("reads the command back as the title and the model's justification as the reason", async () => {
    vi.useFakeTimers();
    const body = await post(COMMAND_PARAMS);
    // The title is the ACTION's command, which is the string a person reads.
    expect(body.text).toBe("Run echo exec-probe > probe.txt");
    // The reason is the model's own sentence, untouched inside its cap, and not the
    // title, so the card says what AND why instead of one of them twice.
    expect(body.approvalMeta.reason).toBe("Write probe.txt in the scratch directory");
    // The mono panel keeps the literal argv the runtime would run: the title
    // moved, the evidence did not.
    expect(body.approvalMeta.tool).toBe(WRAPPED);
    // Stage 1's fields, untouched.
    expect(body.approvalMeta).toMatchObject({
      agent_route: "codex-9",
      risk: "high",
      wait_seconds: APPROVAL_HOLD_SECONDS,
    });
    // No session chip: `availableDecisions` on a real command approval does
    // not carry `acceptForSession`, and the amendment entry is what puts the
    // Always chip there.
    expect(body.options.map((o: any) => o.text)).toEqual([
      "Allow once",
      "Always allow this rule",
      "Deny",
    ]);
  });

  it("never EDITS the card it wrote, so the two sentences cannot fall off it", async () => {
    // WHAT THE SERVED CANON WARNS EVERY CHANNEL ABOUT, pinned here for this
    // one. A PATCH of a message REPLACES the whole approval metadata block,
    // so an edit that sets one field and leaves the two sentences out takes
    // both lines off a card that had them. This daemon is safe by SHAPE
    // rather than by care: its only later edit of an approval card is the
    // retire, and that body is `{ options: [] }` and nothing else, so the
    // column is never sent and never replaced.
    //
    // ALL THREE ENDINGS, because the one that matters most is the one a
    // Stop test cannot see: an ANSWERED card is the card the owner keeps
    // reading, and any edit of it would be the edit that takes both lines
    // off. So the answered ending asserts NO PATCH at all, and the two
    // endings that do retire (Stop and the backstop) assert every PATCH body
    // whole, so adding `approvalMeta` to it is a red test.
    vi.useFakeTimers();
    const patchesTo = (api: any) =>
      api.agentRequest.mock.calls.filter(
        (call: any) => call[0] === "PATCH" && call[1] === "messages/41",
      );

    // 1. Answered: the owner taps Allow once. The card is settled by the
    //    server, and this daemon never touches it again.
    {
      const { bridge, ctx, api, c } = fixture();
      const answer = bridge.approve(
        ctx,
        "item/commandExecution/requestApproval",
        COMMAND_PARAMS,
      );
      await tick();
      const created = (api.agentRequest.mock.calls[0] as any)[3];
      expect(created.approvalMeta.reason).toBe(
        "Write probe.txt in the scratch directory",
      );
      const once = created.options.find((o: any) =>
        o.callbackData.startsWith("ea:once:"),
      );
      bridge.handleClick({
        assistantId: 9,
        chatId: 17,
        userId: "owner",
        messageId: 41,
        optionId: 1,
        callbackData: once.callbackData,
      });
      expect(await answer).toEqual({ decision: "accept" });
      await vi.advanceTimersByTimeAsync(POLL_FAST_WINDOW_MS);
      expect(patchesTo(api)).toEqual([]);
      c.abort();
      await vi.runAllTimersAsync();
      expect(patchesTo(api)).toEqual([]);
    }

    // 2. Stop: the turn is aborted while the card waits.
    {
      const { bridge, ctx, api, c } = fixture();
      const answer = bridge.approve(
        ctx,
        "item/commandExecution/requestApproval",
        COMMAND_PARAMS,
      );
      await tick();
      c.abort();
      await vi.runAllTimersAsync();
      await answer;
      const patches = patchesTo(api);
      expect(patches.length).toBeGreaterThan(0);
      for (const call of patches) expect((call as any)[3]).toEqual({ options: [] });
    }

    // 3. The backstop: the server never judges the row.
    {
      const { bridge, ctx, api } = fixture({
        id: 41,
        approvalMeta: { wait_seconds: 60 },
      });
      const answer = bridge.approve(
        ctx,
        "item/commandExecution/requestApproval",
        COMMAND_PARAMS,
      );
      await tick();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(await answer).toEqual({ decision: "decline" });
      await vi.runAllTimersAsync();
      const patches = patchesTo(api);
      expect(patches.length).toBeGreaterThan(0);
      for (const call of patches) expect((call as any)[3]).toEqual({ options: [] });
    }
  });

  it("says what Always would save: this command and anything added after it, everywhere, until it is removed", async () => {
    vi.useFakeTimers();
    const body = await post(COMMAND_PARAMS);
    expect(body.approvalMeta.rule_text).toBe(
      "this command, and the same command with anything added after it, runs " +
        "without asking again, in every project on this computer, until you " +
        "remove the rule from your Codex rules file: " +
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command " +
        '"echo exec-probe > probe.txt"',
    );
    // The equality above is the whole assertion: the lead in is a frozen
    // constant, so a `not.toContain("exact")` beside it could not fail and
    // would only read as though something checked. What the offline check
    // proved (the saved line is a PREFIX rule, so `codex execpolicy check`
    // allows the same argv with anything added after it) is pinned by the
    // exact sentence, and recorded on EXECPOLICY_RULE_LEAD's own docblock.
  });

  it("quotes only the tokens that hold whitespace, so three arguments do not read as five", () => {
    expect(
      execpolicyRuleText(["C:\\Program Files\\PowerShell\\pwsh.exe", "-c", "ls a b"]),
    ).toBe(
      `${EXECPOLICY_RULE_LEAD}"C:\\Program Files\\PowerShell\\pwsh.exe" -c "ls a b"`,
    );
    // ANY whitespace, not only U+0020: a tab inside a token is as invisible
    // at a join as a space, and a bare join would read two arguments as three.
    expect(execpolicyRuleText(["printf", "a\tb"])).toBe(
      `${EXECPOLICY_RULE_LEAD}printf "a\tb"`,
    );
    // And an EMPTY token is drawn as `""`, not dropped: bare, `git commit -m
    // ""` would read `git commit -m ` with a trailing space nobody can see,
    // which is a different command from the one Always would save.
    expect(execpolicyRuleText(["git", "commit", "-m", ""])).toBe(
      `${EXECPOLICY_RULE_LEAD}git commit -m ""`,
    );
    // A shape this cannot render honestly gets no sentence at all, rather than
    // half a command. The Always button is offered on a truthy amendment, so
    // this is the case where the button ships with no claim beside it, which
    // is exactly where this stage started.
    expect(execpolicyRuleText(["git", 7])).toBeNull();
    expect(execpolicyRuleText([])).toBeNull();
    expect(execpolicyRuleText("git pull")).toBeNull();
    expect(execpolicyRuleText(undefined)).toBeNull();
  });

  it("survives every shape the runtime could put in commandActions", () => {
    // `commandActions` is one of the twelve fields a command approval carries
    // and this daemon read none of them before stage 5. The probed shape is
    // one entry with a string `command`; everything else here is a shape
    // nobody has seen, and the point is that an unseen shape falls back to the
    // wrapped command rather than THROWING inside an RPC the model is parked
    // on, which would hang the turn instead of costing a nicer title.
    expect(soleActionCommand([{ type: "unknown", command: " ls -la " }])).toBe(
      "ls -la",
    );
    expect(soleActionCommand([null])).toBeNull();
    expect(soleActionCommand([undefined])).toBeNull();
    expect(soleActionCommand(["ls"])).toBeNull();
    expect(soleActionCommand([{}])).toBeNull();
    expect(soleActionCommand([{ command: 42 }])).toBeNull();
    expect(soleActionCommand([{ command: "   " }])).toBeNull();
    expect(soleActionCommand([])).toBeNull();
    expect(soleActionCommand({ command: "ls" })).toBeNull();
    expect(soleActionCommand(undefined)).toBeNull();
    // MORE THAN ONE action is not a title: the schema lists one action per
    // piped or chained command, so the first of them is only part of what
    // runs, and the caller falls back to the whole wrapped command.
    expect(
      soleActionCommand([{ command: "ls" }, { command: "rm -rf /" }]),
    ).toBeNull();
  });

  it("titles a chained command by the WHOLE command, never by its first part", async () => {
    vi.useFakeTimers();
    // The title is the push body too, the only text a lock screen gets. Codex
    // parses `a && b` into one action per command, so titling from the first
    // action would put `Run git add -A` on the phone for a force push.
    const body = await post({
      command: "bash -lc 'git add -A && git push --force'",
      commandActions: [
        { type: "unknown", command: "git add -A" },
        { type: "unknown", command: "git push --force" },
      ],
      reason: "Publish the branch",
      availableDecisions: ["accept", "decline"],
    });
    expect(body.text).toBe("Run bash -lc 'git add -A && git push --force'");
    expect(body.approvalMeta.reason).toBe("Publish the branch");
  });

  it("draws the title on one line, with every secret in it masked", async () => {
    vi.useFakeTimers();
    // The title reaches APNs, FCM, the lock screen and the chat list preview,
    // where `tool` never goes. A heredoc keeps its newlines in the action's
    // command, and an inline bearer token is still a bearer token.
    const heredoc = await post({
      command: "powershell -Command python",
      commandActions: [
        { command: "python - <<'PY'\nimport shutil\nshutil.rmtree('build')\nPY" },
      ],
      availableDecisions: ["accept", "decline"],
    });
    expect(heredoc.text).toBe(
      "Run python - <<'PY' import shutil shutil.rmtree('build') PY",
    );
    expect(heredoc.text).not.toMatch(/[\r\n\t]/);
    const token = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    const bearer = await post({
      command: `curl -H 'Authorization: Bearer ${token}' https://api.example.com`,
      commandActions: [
        {
          command: `curl -H 'Authorization: Bearer ${token}' https://api.example.com`,
        },
      ],
      availableDecisions: ["accept", "decline"],
    });
    expect(bearer.text.startsWith("Run curl -H 'Authorization: Bearer ")).toBe(true);
    expect(bearer.text).not.toContain(token);
    expect(bearer.text).not.toContain("abcdefghijklmnop");
    // The mono panel keeps the literal argv: it is drawn only inside the app,
    // behind the card, and never rides a notification.
    expect(bearer.approvalMeta.tool).toContain(token);
    // Masked BEFORE the clip, so a cut can never leave half a secret the mask
    // no longer recognises. The secret sits INSIDE what the title keeps: the
    // raw command is 142 units, and a clip at 120 would keep `Bearer ` and the
    // first 19 characters of the token, one short of the 20 the bearer rule
    // needs, so a mask run after the clip would pass those 19 through. Masked
    // first, the token shrinks to four characters and the whole line fits.
    const bare = "Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4OTBhYmNk";
    const lead = `echo ${"a".repeat(87)} Bearer `;
    const raw = `${lead}${bare} x`;
    const cut = bare.slice(0, 19);
    // The precondition, so this case cannot pass for the wrong reason: the
    // raw line is over the cap, and the clip alone keeps the fragment.
    expect(raw.length).toBeGreaterThan(120);
    expect(clipWithEllipsis(raw, 120)).toBe(`${lead}${cut}\u2026`);
    const inside = titleCommandText(raw);
    expect(inside).toBe(`${lead}Zm9v... x`);
    expect(inside).not.toContain(cut);
  });

  it("keeps the old title on a request to type into a running process", async () => {
    vi.useFakeTimers();
    // `kind: writeStdin` asks to send INPUT to a terminal that is already
    // open, and carries no field holding the input. `Run python` over it would
    // tell the owner they are starting a program that is already running, so
    // the card reads exactly as it did before stage 5: the runtime's sentence
    // as the title, and no reason line repeating it.
    const body = await post({
      kind: "writeStdin",
      command: "python",
      commandActions: [{ command: "python" }],
      reason: "Answer the prompt in the running script",
      availableDecisions: ["accept", "decline"],
    });
    expect(body.text).toBe("Answer the prompt in the running script");
    expect(body.approvalMeta).not.toHaveProperty("reason");
    // And with no sentence at all, the generic line, never `Run python`.
    const bare = await post({
      kind: "writeStdin",
      command: "python",
      commandActions: [{ command: "python" }],
      availableDecisions: ["accept", "decline"],
    });
    expect(bare.text).toBe("Codex needs your approval to continue.");
    // The probed shape carries `kind: "command"` and still reads as one.
    const command = await post({ ...COMMAND_PARAMS, kind: "command" });
    expect(command.text).toBe("Run echo exec-probe > probe.txt");
  });

  it("holds the reason back whenever it would read as the title twice", () => {
    expect(differingReason("Write probe.txt", "Run echo hi")).toBe(
      "Write probe.txt",
    );
    // Trimmed on both sides before the comparison, so the same sentence with
    // different whitespace is still the same sentence.
    expect(differingReason("  Reconfigure the network.  ", "Reconfigure the network.")).toBeNull();
    expect(differingReason("Run ls", "  Run ls  ")).toBeNull();
    // A file change request sends an EXPLICIT null here, which is the case
    // this null check exists for; the rest are shapes nobody has seen.
    expect(differingReason(null, "Change calc.py")).toBeNull();
    expect(differingReason(undefined, "Change calc.py")).toBeNull();
    expect(differingReason(7, "Change calc.py")).toBeNull();
    expect(differingReason("   ", "Change calc.py")).toBeNull();
    // Clipped with the ellipsis inside the cap, because the backend refuses a
    // 281st unit rather than clipping it.
    const long = differingReason("b".repeat(400), "Run ls");
    expect(long).toHaveLength(REQUEST_REASON_MAX_UNITS);
    expect(long?.endsWith("\u2026")).toBe(true);
  });

  it("falls back to the wrapped command when the runtime sent no action", async () => {
    vi.useFakeTimers();
    const body = await post({
      command: "rm -rf build",
      reason: "Clear the stale build directory",
      availableDecisions: ["accept", "decline"],
    });
    // AND THIS EQUALITY IS THE PUSH BODY, not only the title. The backend
    // never puts `approvalMeta` on a notification (spec 4.2), so the phone
    // shows `text` and nothing else: from this release the owner's phone
    // reads the WRAPPED command back, where it used to read the model's
    // sentence, and the WHY cannot ride along. Deliberate (spec 4.3) and
    // written down in the comment above `actionCommand`, so the next edit of
    // `cardText` is an edit of the notification and this line goes red.
    expect(body.text).toBe("Run rm -rf build");
    expect(body.approvalMeta.reason).toBe("Clear the stale build directory");
    expect(body.approvalMeta).not.toHaveProperty("rule_text");
  });

  it("cuts a runaway command inside the column the server will refuse", async () => {
    vi.useFakeTimers();
    // `tool` is the literal argv, and on a command card nothing else in the
    // column is large: no summary, no diff. A body past 98,304 bytes is
    // refused with a 400, which costs the owner the card rather than a tail.
    // So the input is one that WOULD be refused unclipped: 110,000 units,
    // asserted over the cap below, so the byte check can actually fail.
    const runaway = "powershell -Command " + "x".repeat(110_000);
    const body = await post({
      command: runaway,
      reason: "Run the generated script",
      availableDecisions: ["accept", "decline"],
    });
    expect(
      Buffer.byteLength(
        JSON.stringify({ ...body.approvalMeta, tool: runaway }),
        "utf8",
      ),
    ).toBeGreaterThan(APPROVAL_META_BYTES_MAX);
    expect(body.approvalMeta.tool).toHaveLength(COMMAND_TOOL_MAX_UNITS);
    expect(body.approvalMeta.tool.endsWith("\u2026")).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(body.approvalMeta), "utf8"),
    ).toBeLessThan(APPROVAL_META_BYTES_MAX);
    // The title is the command too, under its own tighter cap, so the card
    // reads as a card and not as a file.
    expect(body.text.length).toBeLessThanOrEqual(125);
  });

  it("sends no reason when the sentence is already the title", async () => {
    vi.useFakeTimers();
    // Neither an action nor a command: the title falls back to the runtime's
    // sentence exactly as it did before this stage, so a reason line would
    // draw that same sentence a second time.
    const body = await post({
      reason: "Codex needs to reconfigure the network.",
      availableDecisions: ["accept", "decline"],
    });
    expect(body.text).toBe("Codex needs to reconfigure the network.");
    expect(body.approvalMeta).not.toHaveProperty("reason");
    // A blank sentence is not a sentence either.
    const blank = await post({ command: "ls", reason: "   " });
    expect(blank.text).toBe("Run ls");
    expect(blank.approvalMeta).not.toHaveProperty("reason");
  });

  it("clips all three inside their caps, ellipsis and all", async () => {
    vi.useFakeTimers();
    const body = await post({
      reason: "b".repeat(400),
      command: "wrapped",
      commandActions: [{ command: "a".repeat(300) }],
      proposedExecpolicyAmendment: ["c".repeat(700)],
      availableDecisions: [
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["c"] } },
      ],
    });
    // The backend REFUSES a string past its length rather than clipping it, so
    // one unit over costs the owner the whole card. Every cut is marked,
    // because a silent prefix renders as a complete, shorter command.
    expect(body.text).toBe(`Run ${"a".repeat(119)}\u2026`);
    expect(body.approvalMeta.reason).toHaveLength(280);
    expect(body.approvalMeta.reason.endsWith("\u2026")).toBe(true);
    expect(body.approvalMeta.reason.startsWith("bbb")).toBe(true);
    expect(body.approvalMeta.rule_text).toHaveLength(500);
    expect(body.approvalMeta.rule_text.endsWith("\u2026")).toBe(true);
    expect(body.approvalMeta.rule_text.startsWith(EXECPOLICY_RULE_LEAD)).toBe(true);
  });

  it("sends no rule beside a button that is not offered", async () => {
    vi.useFakeTimers();
    // The amendment is there and the runtime's own decision list does not
    // carry it, so stage 4's tier withholds the chip. A sentence about an
    // answer the owner cannot give would be worse than silence.
    const withheld = await post({
      command: "curl example.com",
      commandActions: [{ command: "curl example.com" }],
      proposedExecpolicyAmendment: AMENDMENT,
      availableDecisions: ["accept", "cancel"],
    });
    expect(withheld.options.map((o: any) => o.text)).toEqual(["Allow once", "Deny"]);
    expect(withheld.approvalMeta).not.toHaveProperty("rule_text");
    // And no amendment at all is the ordinary case on most commands.
    const plain = await post({
      command: "ls",
      commandActions: [{ command: "ls" }],
      availableDecisions: ["accept", "decline"],
    });
    expect(plain.options.map((o: any) => o.text)).toEqual([
      "Allow once",
      "Deny",
    ]);
    expect(plain.approvalMeta).not.toHaveProperty("rule_text");
  });

  it("sends neither string on a file change approval, which stage 4 owns", async () => {
    vi.useFakeTimers();
    const changes = [
      {
        path: "/work/project/calc.py",
        kind: { type: "update" },
        diff: "@@ -1 +1 @@\n-a\n+b\n",
      },
    ];
    const plain = await post(
      { itemId: "call_3", reason: null, changes, cwd: "/work/project" },
      "item/fileChange/requestApproval",
    );
    expect(plain.text).toBe("Change calc.py");
    expect(plain.approvalMeta).not.toHaveProperty("reason");
    expect(plain.approvalMeta).not.toHaveProperty("rule_text");
    // And when the runtime DOES fill a sentence on a file change, it stays the
    // title, exactly as stage 4 left it, rather than moving to a reason line.
    const withReason = await post(
      {
        itemId: "call_4",
        reason: "This patch writes outside your workspace.",
        changes,
        cwd: "/work/project",
      },
      "item/fileChange/requestApproval",
    );
    expect(withReason.text).toBe("This patch writes outside your workspace.");
    expect(withReason.approvalMeta).not.toHaveProperty("reason");
    // THE METHOD DECIDES, not the presence of a field. The host joins the
    // runtime's own item onto these params, so a file change request that also
    // carried a command would still be a file change, and its title is stage
    // 4's ask sentence rather than a command read back.
    const mixed = await post(
      {
        itemId: "call_5",
        reason: "This patch writes outside your workspace.",
        changes,
        cwd: "/work/project",
        command: "git apply patch.diff",
        commandActions: [{ command: "git apply patch.diff" }],
      },
      "item/fileChange/requestApproval",
    );
    expect(mixed.text).toBe("This patch writes outside your workspace.");
    expect(mixed.approvalMeta.tool).toBe("calc.py (update)");
    expect(mixed.approvalMeta).not.toHaveProperty("reason");
  });

  it("leaves a permissions approval exactly as it was", async () => {
    vi.useFakeTimers();
    const bare = await post(
      { permissions: { network: true } },
      "item/permissions/requestApproval",
    );
    expect(bare.text).toBe("Codex needs your approval to continue.");
    expect(bare.approvalMeta.tool).toBe('{"network":true}');
    // The real PermissionsRequestApprovalParams carries `reason`, so the case
    // that can fail is the one carrying everything a command request would:
    // a sentence, a command, one action and an amendment. The METHOD decides,
    // so the title is still the runtime's sentence (never `Run curl ...`),
    // no reason line repeats it, and no Always tier or rule is offered.
    const full = await post(
      {
        permissions: { network: true },
        reason: "Reach the package registry",
        command: "curl https://registry.example.com",
        commandActions: [{ command: "curl https://registry.example.com" }],
        proposedExecpolicyAmendment: ["curl", "https://registry.example.com"],
      },
      "item/permissions/requestApproval",
    );
    expect(full.text).toBe("Reach the package registry");
    expect(full.approvalMeta).not.toHaveProperty("reason");
    expect(full.approvalMeta).not.toHaveProperty("rule_text");
    expect(full.options.map((o: any) => o.callbackData.split(":")[1])).toEqual([
      "once",
      "session",
      "deny",
    ]);
  });
});
