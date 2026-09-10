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
  };
  const interactions = { ask: vi.fn() };
  const run = vi.fn();
  const router = new NativeCommands({
    host: host as any,
    interactions: interactions as any,
    ownerId: () => "owner",
    status: () => "connected",
    run,
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
  return { host, interactions, run, router, args, sendText };
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
