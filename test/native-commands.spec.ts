import { describe, it, expect, vi } from "vitest";
import {
  NativeCommands,
  parseNativeCommand,
  normalizeNativeCommand,
  reviewTarget,
  usageSummary,
} from "../src/native-commands.js";

const models = ["one", "two"].map((model, i) => ({
  model,
  id: model,
  displayName: model,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "low" },
    { reasoningEffort: "medium" },
  ],
  supportsPersonality: !i,
  serviceTiers: [],
}));
function setup() {
  const host = {
    sessionSettings: vi.fn(async () => ({ model: "one", effort: "medium" })),
    listModels: vi.fn(async () => models),
    updateSettings: vi.fn(async (_id, v) => v),
    contextUsage: vi.fn(),
    steer: vi.fn(async () => {}),
    savedThreads: vi.fn(async () => [
      { id: "saved", name: "Saved conversation" },
    ]),
    resumeSavedThread: vi.fn(async () => {}),
    setGoal: vi.fn(async () => null),
    getGoal: vi.fn(async () => ({
      threadId: "thread-20",
      objective: "the sign up page loads in under 2 seconds",
      status: "active",
      tokenBudget: null,
      tokensUsed: 1234,
      timeUsedSeconds: 1140,
      createdAt: 1789932968,
      updatedAt: 1789932999,
    })),
    clearGoal: vi.fn(async () => true),
  };
  const interactions = { ask: vi.fn() };
  const run = vi.fn();
  const goalLane = {
    setFromChat: vi.fn(async () => 101),
    clearForChat: vi.fn(async () => true),
    pauseForChat: vi.fn(async () => null),
    resumeForChat: vi.fn(async () => null),
  };
  const router = new NativeCommands({
    host: host as any,
    interactions: interactions as any,
    ownerId: () => "owner",
    status: () => "connected",
    run,
    goalLane: goalLane as any,
  });
  const sendText = vi.fn(async () => ({ id: 1 }));
  const args = (name: string, text = "", extra = {}) =>
    ({
      assistantId: 10,
      chatId: 20,
      userId: "owner",
      command: { name, args: text },
      replyHandle: { sendText },
      ...extra,
    }) as any;
  return { host, interactions, run, router, args, sendText, goalLane };
}
describe("native controls", () => {
  it("keeps literal paths and argument backslashes intact", () => {
    expect(parseNativeCommand(String.raw`\model two high`)).toEqual({
      name: "model",
      args: "two high",
    });
    expect(
      parseNativeCommand(
        String.raw`/review inspect C:\Users\Renée & Co\notes.md`,
      ),
    ).toEqual({
      name: "review",
      args: String.raw`inspect C:\Users\Renée & Co\notes.md`,
    });
    for (const text of [
      String.raw`\\server\share`,
      String.raw`\Users\test`,
      "/Users/test",
      "C:\\test",
    ])
      expect(parseNativeCommand(text)).toBeUndefined();
    expect(normalizeNativeCommand({ name: "CLEAR", args: "" }).name).toBe(
      "new",
    );
  });
  it("selects actual catalog model and effort without submitting a prompt", async () => {
    const s = setup();
    s.interactions.ask
      .mockResolvedValueOnce([{ picked_option_value: "two" }])
      .mockResolvedValueOnce([{ picked_option_value: "low" }]);
    await s.router.handle(s.args("model"));
    expect(s.host.updateSettings).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        model: "two",
        effort: "low",
        personality: "none",
      }),
    );
    expect(s.run).not.toHaveBeenCalled();
    expect(s.sendText).toHaveBeenCalledWith(
      expect.stringContaining("context is preserved"),
    );
  });
  it("does not mutate on skipped picker, unavailable model or another user", async () => {
    const s = setup();
    s.interactions.ask.mockResolvedValue([{ skipped: true }]);
    await s.router.handle(s.args("model"));
    await s.router.handle(s.args("model", "nonexistent"));
    await s.router.handle(
      s.args("model", "two low", { senderUserId: "guest" }),
    );
    expect(s.host.updateSettings).not.toHaveBeenCalled();
    expect(s.sendText).toHaveBeenLastCalledWith(
      expect.stringContaining("owner"),
    );
  });
  it("pages a larger account catalog within six options and changes only the final selection", async () => {
    const s = setup();
    s.host.listModels.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        ...models[0],
        model: `model${index + 1}`,
        id: `model${index + 1}`,
        displayName: `Model ${index + 1}`,
      })),
    );
    for (const value of [
      "__next_page",
      "__previous_page",
      "__next_page",
      "model6",
      "low",
    ])
      s.interactions.ask.mockResolvedValueOnce([
        { picked_option_value: value },
      ]);
    await s.router.handle(s.args("model"));
    expect(s.interactions.ask).toHaveBeenCalledTimes(5);
    for (const call of s.interactions.ask.mock.calls) {
      expect(call[1][0].options.length).toBeLessThanOrEqual(6);
    }
    expect(s.host.updateSettings).toHaveBeenCalledTimes(1);
    expect(s.host.updateSettings).toHaveBeenCalledWith(
      20,
      expect.objectContaining({ model: "model6", effort: "low" }),
    );
    expect(s.run).not.toHaveBeenCalled();
  });
  it("never interprets agent/system text as native control", async () => {
    const s = setup();
    for (const senderType of ["agent", "system"])
      expect(
        await s.router.handle(s.args("model", "two", { senderType })),
      ).toBe(false);
    expect(s.host.listModels).not.toHaveBeenCalled();
  });
  it.each(["model", "effort", "permissions", "personality", "fast", "resume"])(
    "finishes a cancelled %s picker with a reply and no state change",
    async (name) => {
      const s = setup();
      s.interactions.ask.mockResolvedValue([{ skipped: true }]);
      await s.router.handle(s.args(name));
      expect(s.sendText).toHaveBeenCalledTimes(1);
      expect(s.sendText).toHaveBeenCalledWith(
        "Selection cancelled. No changes were made.",
      );
      expect(s.host.updateSettings).not.toHaveBeenCalled();
      expect(s.host.resumeSavedThread).not.toHaveBeenCalled();
      expect(s.run).not.toHaveBeenCalled();
    },
  );
  it("leaves the model unchanged when its second reasoning picker is cancelled", async () => {
    const s = setup();
    s.interactions.ask
      .mockResolvedValueOnce([{ picked_option_value: "two" }])
      .mockResolvedValueOnce([{ skipped: true }]);
    await s.router.handle(s.args("model"));
    expect(s.host.updateSettings).not.toHaveBeenCalled();
    expect(s.sendText).toHaveBeenCalledTimes(1);
    expect(s.sendText).toHaveBeenCalledWith(
      "Selection cancelled. No changes were made.",
    );
  });
  it("replies when the account catalog offers no options instead of staying busy", async () => {
    const s = setup();
    s.host.listModels.mockResolvedValue([]);
    await s.router.handle(s.args("model"));
    expect(s.interactions.ask).not.toHaveBeenCalled();
    expect(s.sendText).toHaveBeenCalledTimes(1);
    expect(s.sendText).toHaveBeenCalledWith(
      "No options are available for this control right now.",
    );
  });
  it("cancels an old menu when a new control arrives", async () => {
    const s = setup();
    let complete: (v: any) => void = () => {};
    s.interactions.ask.mockImplementationOnce(
      () =>
        new Promise((r) => {
          complete = r;
        }),
    );
    const pending = s.router.handle(s.args("model"));
    await vi.waitFor(() => expect(s.interactions.ask).toHaveBeenCalled());
    await s.router.handle(s.args("effort", "low"));
    complete([{ picked_option_value: "two" }]);
    await pending;
    expect(s.host.updateSettings).toHaveBeenCalledTimes(1);
    expect(s.sendText).toHaveBeenCalledTimes(1);
  });
  it("routes review and steering through native operations", async () => {
    const s = setup();
    await s.router.handle(s.args("review", "branch main"));
    expect(s.run).toHaveBeenCalledWith(expect.anything(), "branch main", {
      reviewTarget: { type: "baseBranch", branch: "main" },
    });
    await s.router.handle(s.args("steer", "Preserve the current files"));
    expect(s.host.steer).toHaveBeenCalledWith(20, "Preserve the current files");
    expect(reviewTarget("commit abc1234")).toEqual({
      type: "commit",
      sha: "abc1234",
      title: null,
    });
    expect(() => reviewTarget("commit malicious;exit")).toThrow();
    expect(() => reviewTarget("branch   ")).toThrow(/branch name/);
  });
  it("reports unavailable limits as unavailable and never redeems credits", () => {
    expect(usageSummary({})).toContain("unavailable");
    expect(
      usageSummary({ rateLimits: { primary: { usedPercent: 120 } } }),
    ).toContain("0% remaining");
  });
});

/**
 * `/goal` (mission program stage 6).
 *
 * It was refused by this bridge until the daemon could really carry one out.
 * Now it is a native control like /steer: the condition becomes a mission the
 * owner can see AND a native thread goal the runtime works toward, and none
 * of the five forms is ever passed to the model as a prompt.
 */
describe("the goal control", () => {
  it("sets a goal through the lane, and never sends it to the model", async () => {
    const s = setup();
    await s.router.handle(
      s.args("goal", "the sign up page loads in under 2 seconds"),
    );
    expect(s.goalLane.setFromChat).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      objective: "the sign up page loads in under 2 seconds",
    });
    expect(s.run).not.toHaveBeenCalled();
    expect(String(s.sendText.mock.calls[0]![0])).toContain("20 turns");
  });

  it("reads the goal back in the runtime's own words", async () => {
    const s = setup();
    await s.router.handle(s.args("goal"));
    expect(s.host.getGoal).toHaveBeenCalledWith(20);
    const said = String(s.sendText.mock.calls[0]![0]);
    expect(said).toContain("the sign up page loads in under 2 seconds");
    expect(said).toContain("active");
    expect(said).toContain("19m");
    expect(said).toContain("1,234");
    expect(s.goalLane.setFromChat).not.toHaveBeenCalled();
  });

  it("says plainly when there is no goal to read", async () => {
    const s = setup();
    s.host.getGoal.mockResolvedValue(null as never);
    await s.router.handle(s.args("goal"));
    expect(String(s.sendText.mock.calls[0]![0])).toContain("No goal is set");
  });

  it("clears, holds and restarts the goal", async () => {
    const s = setup();
    await s.router.handle(s.args("goal", "clear"));
    expect(s.goalLane.clearForChat).toHaveBeenCalledWith(20);
    await s.router.handle(s.args("goal", "pause"));
    expect(s.goalLane.pauseForChat).toHaveBeenCalledWith(20);
    await s.router.handle(s.args("goal", "resume"));
    expect(s.goalLane.resumeForChat).toHaveBeenCalledWith(20);
    expect(s.goalLane.setFromChat).not.toHaveBeenCalled();
  });

  it("says so when there was no goal to clear", async () => {
    const s = setup();
    s.goalLane.clearForChat.mockResolvedValue(false as never);
    await s.router.handle(s.args("goal", "clear"));
    expect(String(s.sendText.mock.calls[0]![0])).toContain("no goal");
  });

  it("treats a condition that starts with a control word as a condition", async () => {
    const s = setup();
    await s.router.handle(s.args("goal", "clear the design backlog"));
    expect(s.goalLane.setFromChat).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "clear the design backlog" }),
    );
    expect(s.goalLane.clearForChat).not.toHaveBeenCalled();
  });

  it("is refused for anyone but the owner, like every other native control", async () => {
    const s = setup();
    await s.router.handle(
      s.args("goal", "do the thing", { userId: "someone-else" }),
    );
    expect(s.goalLane.setFromChat).not.toHaveBeenCalled();
    expect(String(s.sendText.mock.calls[0]![0])).toContain(
      "Only this agent's owner",
    );
  });

  it("turns a refusal from the runtime into a sentence the owner can act on", async () => {
    const s = setup();
    s.goalLane.setFromChat.mockRejectedValue(
      new Error("Codex could not set the goal: goals feature is disabled.") as never,
    );
    await s.router.handle(s.args("goal", "the tests pass"));
    expect(String(s.sendText.mock.calls[0]![0])).toContain(
      "goals feature is disabled",
    );
  });

  it("is listed in /help, which is the same list the slash picker gets", async () => {
    const s = setup();
    await s.router.handle(s.args("help"));
    expect(String(s.sendText.mock.calls[0]![0])).toContain("`/goal`");
  });
});
