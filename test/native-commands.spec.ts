import { describe, it, expect, vi } from "vitest";
import {
  NativeCommands,
  STEER_UNCONFIRMED_TEXT,
  parseNativeCommand,
  normalizeNativeCommand,
  reviewTarget,
  usageSummary,
} from "../src/native-commands.js";
import { RequestTimeoutError } from "../src/app-server.js";

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
    // The pair `/plan` and `/code` actually move: the mode AND the read only
    // sandbox that is the only thing about plan mode the runtime enforces.
    // It answers whether the lock took, which is what the daemon reports.
    setPlanMode: vi.fn(async (_id: number, on: boolean) => ({ enforced: on })),
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
  const onSessionMode = vi.fn(async () => {});
  const onPlanEnforcement = vi.fn(async () => {});
  const router = new NativeCommands({
    host: host as any,
    interactions: interactions as any,
    ownerId: () => "owner",
    status: () => "connected",
    run,
    goalLane: goalLane as any,
    onSessionMode,
    onPlanEnforcement,
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
  return {
    host,
    interactions,
    run,
    router,
    args,
    sendText,
    goalLane,
    onSessionMode,
    onPlanEnforcement,
  };
}
describe("the session mode BGOS is told about", () => {
  /**
   * The app draws the plan mode chip off a report from the daemon, not off a
   * guess, and Codex's mode is per CHAT. Reported after the store and before
   * the turn: a chip that arrives after the plan card has landed is a chip that
   * was never useful.
   */
  it("reports plan on /plan and default on /code, per chat", async () => {
    const s = setup();
    await s.router.handle(s.args("plan"));
    // NOT `updateSettings({ mode })`. Plan mode without the read only sandbox
    // is a mode the runtime does not enforce, which the live probe of
    // 2026-09-23 proved by writing a file inside it, so the mode and the
    // sandbox move together through one seam on the host.
    expect(s.host.setPlanMode).toHaveBeenCalledWith(20, true);
    expect(s.host.updateSettings).not.toHaveBeenCalled();
    expect(s.onSessionMode).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 20, assistantId: 10 }),
      "plan",
      false,
      true,
    );
    await s.router.handle(s.args("code"));
    expect(s.host.setPlanMode).toHaveBeenLastCalledWith(20, false);
    expect(s.onSessionMode).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: 20 }),
      "default",
      false,
      false,
    );
  });

  /**
   * THE HONESTY BIT, AND IT IS MEASURED.
   *
   * `enforced` was the constant `CODEX_PLAN_MODE_ENFORCED = false` until the
   * sandbox was coupled to the mode. The app words the plan chip differently
   * for the two, so a hopeful `true` is a promise the owner acts on: it is now
   * whatever the host says actually took, and a host that could not apply the
   * read only sandbox reports the convention it really has.
   */
  it("reports the enforcement the host actually applied, not a constant", async () => {
    const s = setup();
    s.host.setPlanMode.mockResolvedValueOnce({ enforced: false } as never);
    await s.router.handle(s.args("plan"));
    expect(s.onSessionMode).toHaveBeenCalledWith(
      expect.anything(),
      "plan",
      false,
      false,
    );
    // And the line the owner reads does not claim the lock either.
    expect(s.sendText).toHaveBeenCalledWith("Plan mode is on.");
    s.sendText.mockClear();
    await s.router.handle(s.args("plan"));
    expect(s.sendText).toHaveBeenCalledWith(
      "Plan mode is on. This chat is read only until you answer a plan.",
    );
  });

  it("marks /plan <task> as the TYPED door, and bare /plan as the mode's", async () => {
    const s = setup();
    await s.router.handle(s.args("plan", "add retry to the uploader"));
    expect(s.onSessionMode).toHaveBeenCalledWith(
      expect.anything(),
      "plan",
      true,
      true,
    );
    // And the task still runs, in the mode that was just set.
    expect(s.run).toHaveBeenCalledWith(
      expect.anything(),
      "add retry to the uploader",
    );
    s.onSessionMode.mockClear();
    s.run.mockClear();
    await s.router.handle(s.args("plan", "on"));
    expect(s.onSessionMode).toHaveBeenCalledWith(
      expect.anything(),
      "plan",
      false,
      true,
    );
    expect(s.run).not.toHaveBeenCalled();
  });

  it("reads /plan off as coding mode", async () => {
    const s = setup();
    await s.router.handle(s.args("plan", "off"));
    expect(s.host.setPlanMode).toHaveBeenCalledWith(20, false);
    expect(s.onSessionMode).toHaveBeenCalledWith(
      expect.anything(),
      "default",
      false,
      false,
    );
  });

  /**
   * An owner who narrows the chat by hand SPENDS plan mode's memory.
   *
   * Without this, `/permissions read-only` typed while a plan is waiting would
   * be undone by the Go ahead that follows: `/plan` had remembered
   * "workspace", and the restore would hand back a workspace the owner had
   * just taken away. The explicit choice is the one to keep.
   */
  it("forgets the permission plan mode remembered when the owner picks one", async () => {
    const s = setup();
    await s.router.handle(s.args("permissions", "read-only"));
    expect(s.host.updateSettings).toHaveBeenCalledWith(20, {
      permission: "read-only",
      permissionBeforePlan: undefined,
    });
  });

  /**
   * THE LOCK CAN MOVE WITHOUT THE MODE MOVING, and the app has to hear it.
   *
   * `/permissions workspace` typed while a plan is waiting hands the files
   * back and leaves `mode: "plan"` alone, so no `onSessionMode` fires and the
   * chip goes on reading `read only until you answer` over a chat that is not
   * read only any more. That sentence is the whole promise this lane made, so
   * an unreported change here is the lane's own defect coming back.
   */
  it("re-reports the enforcement when the owner opens a planning chat back up", async () => {
    const s = setup();
    s.host.updateSettings.mockResolvedValueOnce({
      mode: "plan",
      permission: "workspace",
    } as never);
    await s.router.handle(s.args("permissions", "workspace"));
    expect(s.onPlanEnforcement).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 20, assistantId: 10 }),
      false,
    );
    // NOT through onSessionMode: the mode did not change, and that arm would
    // clear the typed door a `/plan <task>` left behind.
    expect(s.onSessionMode).not.toHaveBeenCalled();
  });

  it("re-reports a lock the owner put on by hand, and says nothing in a coding chat", async () => {
    const s = setup();
    s.host.updateSettings.mockResolvedValueOnce({
      mode: "plan",
      permission: "read-only",
    } as never);
    await s.router.handle(s.args("permissions", "read-only"));
    expect(s.onPlanEnforcement).toHaveBeenCalledWith(expect.anything(), true);

    // An ordinary coding chat has no chip to correct, so there is nothing to
    // report and a report would put a plan mode on a chat nobody switched.
    s.onPlanEnforcement.mockClear();
    s.host.updateSettings.mockResolvedValueOnce({
      mode: "default",
      permission: "read-only",
    } as never);
    await s.router.handle(s.args("permissions", "read-only"));
    expect(s.onPlanEnforcement).not.toHaveBeenCalled();
  });
});

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

/**
 * `/steer`, and the HOAI tray's Send now that rides it (P5 stage 5, C-27,
 * Build C, 0.15.0).
 *
 * Before 0.15.0 a steer that landed answered "Correction delivered to the
 * current response." as an ordinary reply. HOAI reads any ordinary reply as
 * the agent being done, so confirming a correction INTO a running turn marked
 * that turn finished: the working line and Stop went away for the rest of it.
 * And a steer with nothing to steer (no turn running yet, the turn had just
 * ended, a review or a compaction) answered "No response is ready for a
 * correction" and dropped the owner's words. Send now is pressed exactly near
 * a turn's end, which is when that race is likeliest.
 *
 * Now a landed steer posts nothing (the owner's own message and its delivered
 * tick are the receipt, and the turn's own reply answers it). A steer with
 * nothing to steer runs the text ONCE as a normal message through the per
 * chat queue (`deps.run`), never both and never an error line. A steer Codex
 * did not answer in time is not run a second time, because it may have
 * landed, and one line says so.
 */
describe("a steer with nothing to steer runs as a normal message, and a landed steer posts no reply", () => {
  const NO_TURN =
    "No response is ready for a correction. Send a normal message or wait for Codex to start.";

  it("steers a running turn once and posts nothing", async () => {
    const s = setup();
    await s.router.handle(s.args("steer", "Keep the public API"));
    expect(s.host.steer).toHaveBeenCalledTimes(1);
    expect(s.host.steer).toHaveBeenCalledWith(20, "Keep the public API");
    expect(s.run).not.toHaveBeenCalled();
    expect(s.sendText).not.toHaveBeenCalled();
  });

  it("with no running turn, runs the text once as a normal message and posts nothing", async () => {
    const s = setup();
    s.host.steer.mockRejectedValueOnce(new Error(NO_TURN) as never);
    await s.router.handle(s.args("steer", "Keep the public API"));
    expect(s.host.steer).toHaveBeenCalledTimes(1);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(s.run).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: 10, chatId: 20 }),
      "Keep the public API",
    );
    expect(s.sendText).not.toHaveBeenCalled();
  });

  it.each([
    ["the turn it named has just ended", "expected turn id turn-1 does not match the active turn"],
    ["no turn is active in the runtime", "no active turn to steer"],
    ["a review turn cannot be steered", "activeTurnNotSteerable: review"],
    ["a compaction cannot be steered", "activeTurnNotSteerable: compact"],
  ])(
    "runs it once when the runtime refuses the steer (%s)",
    async (_why, refusal) => {
      const s = setup();
      s.host.steer.mockRejectedValueOnce(new Error(refusal) as never);
      await s.router.handle(s.args("steer", "Use the staging database"));
      expect(s.host.steer).toHaveBeenCalledTimes(1);
      expect(s.run).toHaveBeenCalledTimes(1);
      expect(s.run.mock.calls[0]![1]).toBe("Use the staging database");
      expect(s.sendText).not.toHaveBeenCalled();
    },
  );

  it("never both: a landed steer is not also run, and a refused one is not steered twice", async () => {
    const landed = setup();
    await landed.router.handle(landed.args("steer", "one"));
    expect(landed.host.steer.mock.calls.length + landed.run.mock.calls.length).toBe(1);
    const refused = setup();
    refused.host.steer.mockRejectedValueOnce(new Error(NO_TURN) as never);
    await refused.router.handle(refused.args("steer", "two"));
    expect(refused.host.steer).toHaveBeenCalledTimes(1);
    expect(refused.run).toHaveBeenCalledTimes(1);
  });

  it("a steer Codex did not answer in time is not run again, and one line says so", async () => {
    const s = setup();
    s.host.steer.mockRejectedValueOnce(
      new RequestTimeoutError("Codex turn/steer timed out.") as never,
    );
    await s.router.handle(s.args("steer", "Keep the public API"));
    expect(s.host.steer).toHaveBeenCalledTimes(1);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.sendText).toHaveBeenCalledTimes(1);
    expect(s.sendText).toHaveBeenCalledWith(STEER_UNCONFIRMED_TEXT);
    expect(STEER_UNCONFIRMED_TEXT).toBe(
      "Codex did not confirm the correction in time, so it was not sent a second time. If Codex does not act on it, send it again as a normal message.",
    );
  });

  it.each(["", "   ", "\n\t"])(
    "an empty /steer (%j) still answers its usage line, and neither steers nor runs",
    async (blank) => {
      const s = setup();
      await s.router.handle(s.args("steer", blank));
      expect(s.host.steer).not.toHaveBeenCalled();
      expect(s.run).not.toHaveBeenCalled();
      expect(s.sendText).toHaveBeenCalledWith(
        "Use /steer followed by your correction while Codex is responding.",
      );
    },
  );

  it("steers and runs the correction without the blank edges a tagged frame keeps", async () => {
    // A slash command frame's args arrive untrimmed (inbound-handler.ts reads
    // commandArgs as sent); the text parser trims. Both reach the same words.
    const landed = setup();
    await landed.router.handle(landed.args("steer", "  Keep the public API \n"));
    expect(landed.host.steer).toHaveBeenCalledWith(20, "Keep the public API");
    const refused = setup();
    refused.host.steer.mockRejectedValueOnce(new Error(NO_TURN) as never);
    await refused.router.handle(refused.args("steer", "  Keep the public API \n"));
    expect(refused.run.mock.calls[0]![1]).toBe("Keep the public API");
  });

  it.each([true, false])(
    "a typed /steer behaves exactly like the app's Send now (a turn running: %s)",
    async (running) => {
      const typed = setup();
      const tray = setup();
      if (!running) {
        typed.host.steer.mockRejectedValueOnce(new Error(NO_TURN) as never);
        tray.host.steer.mockRejectedValueOnce(new Error(NO_TURN) as never);
      }
      // Typed: the owner's own words, read by the text parser.
      const parsed = parseNativeCommand("/steer Keep the public API");
      await typed.router.handle({
        ...typed.args("steer"),
        command: normalizeNativeCommand(parsed!),
      });
      // The tray: the slash command frame's name and args.
      await tray.router.handle(tray.args("steer", "Keep the public API"));
      expect(typed.host.steer.mock.calls).toEqual(tray.host.steer.mock.calls);
      expect(typed.run.mock.calls.map((c) => c[1])).toEqual(
        tray.run.mock.calls.map((c) => c[1]),
      );
      expect(typed.sendText.mock.calls).toEqual(tray.sendText.mock.calls);
      expect(tray.sendText).not.toHaveBeenCalled();
      // Not equal by both doing nothing: each tried the steer once, and ran
      // the words only when there was nothing to steer.
      expect(typed.host.steer).toHaveBeenCalledTimes(1);
      expect(typed.run).toHaveBeenCalledTimes(running ? 0 : 1);
    },
  );

  it("is refused for anyone but the owner, and then neither steers nor runs", async () => {
    const s = setup();
    await s.router.handle(
      s.args("steer", "Keep the public API", { senderUserId: "guest" }),
    );
    expect(s.host.steer).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
    expect(String(s.sendText.mock.calls[0]![0])).toContain(
      "Only this agent's owner",
    );
  });
});
