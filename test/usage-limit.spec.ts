import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import { CodexHost, friendlyCodexError } from "../src/codex-host.js";
import { GoalLane } from "../src/goal-lane.js";
import {
  USAGE_RESUME_MARGIN_MS,
  UsageResumeStore,
  isUsageLimitError,
  usageLimitLine,
  usageLimitReset,
} from "../src/usage-limit.js";
import { probe401Turn } from "./fixtures/image-generation.js";
import {
  USAGE_LIMIT_RAW,
  rateLimitsRead,
  sessionWindow,
  usageLimitTurn,
  weeklyWindow,
} from "./fixtures/usage-limit.js";

/**
 * Board row 5f610907: when the Codex account's usage runs out, the owner saw
 * the runtime's own refusal, with its upgrade and purchase links, in a red
 * error card, and a goal the limit stopped stayed stopped.
 *
 * Built on a recorded usage limit stream (test/fixtures/usage-limit.ts). On
 * the main this branch starts from, the host cases fail (the raw words come
 * back as the error) and the adapter cases fail (the raw words are posted as
 * an Agent error and nothing rests or resumes).
 */

const HOUR = 3600;
const NOW_MS = Date.UTC(2026, 10, 18, 13, 0, 0);
const NOW_S = NOW_MS / 1000;
const PLAIN_NO_TIME =
  "Codex has used up its usage for now and starts again by itself when the limit resets. You do not need to do anything.";

/** Nothing the runtime said reaches a line the owner reads. */
function expectNoRawWords(text: string): void {
  expect(text).not.toMatch(/https?:|chatgpt\.com|upgrade|purchase|credits|\bpro\b|\bplus\b|3:04/i);
}

class Server extends EventEmitter {
  next = 0;
  start = vi.fn(async () => {});
  close = vi.fn(() => this.emit("closed", new Error("closed")));
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/start") return { thread: { id: `thread-${++this.next}` } };
    if (method === "thread/read") return { thread: { id: p.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${p.threadId}` } };
    return {};
  });
}

const ASSISTANT = 10;
const CHAT = 20;
const MISSION = 77;
const OBJECTIVE = "All tests pass";

/**
 * The `Object.create(CodexAdapter.prototype)` harness of the other adapter
 * specs, with the real usage lane (wired by the adapter's own method) and a
 * real goal lane over a fake runtime that holds one goal.
 */
function fixture(opts: { read?: () => Promise<unknown>; storePath?: string } = {}) {
  const runtime = { goal: null as any };
  const host = {
    rateLimits: vi.fn(opts.read ?? (async () => rateLimitsRead({ session: sessionWindow(100, NOW_S + 2 * HOUR) }))),
    hasThread: vi.fn(() => true),
    setGoal: vi.fn(async (_chatId: number, objective: string | null, o?: any) => {
      runtime.goal = {
        threadId: "thread-1",
        objective: objective ?? runtime.goal?.objective ?? "",
        status: o?.status ?? runtime.goal?.status ?? "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      return runtime.goal;
    }),
    getGoal: vi.fn(async () => runtime.goal),
    clearGoal: vi.fn(async () => true),
  };
  const api = {
    setResting: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    postMessage: vi.fn(async () => ({ id: 1 })),
    createMission: vi.fn(),
    patchMissionProgress: vi.fn(async () => {}),
    completeMission: vi.fn(async () => {}),
    postMissionStopped: vi.fn(async () => {}),
  };
  const adapter = Object.create(CodexAdapter.prototype) as any;
  Object.assign(adapter, {
    planCardFailures: new Set(),
    host,
    api,
    outbound: { sendAgentError: vi.fn(async () => {}) },
  });
  adapter.goalLane = new GoalLane({
    api: api as any,
    host: {
      setGoal: (c, o, x) => host.setGoal(c, o, x),
      clearGoal: (c) => host.clearGoal(c),
      hasThread: (c) => host.hasThread(c),
      getGoal: (c) => host.getGoal(c),
    },
    log: () => {},
  });
  // An optional call: on a main without the lane the harness still builds,
  // so the end to end case fails on what the owner is shown, not on wiring.
  adapter.usageLimit = adapter.makeUsageLimitLane?.(
    new UsageResumeStore(opts.storePath ?? null),
  );
  const reply = {
    finalizeTurn: vi.fn(async () => {}),
    sendText: vi.fn(async () => ({ id: 2 })),
    sendFile: vi.fn(async () => ({ id: 3 })),
  };
  return { adapter, host, api, reply, runtime };
}

/** The refused turn as the host hands it over (see the host cases). */
function refusedResult() {
  return {
    error: usageLimitLine(),
    usageLimited: true as const,
    replyText: "",
    finalAgentMessageText: "",
    turnCompleted: false,
    threadId: "thread-1",
  };
}


async function publish(f: ReturnType<typeof fixture>) {
  await f.adapter.publishTurnResult({
    assistantId: ASSISTANT,
    chatId: CHAT,
    replyHandle: f.reply,
    result: refusedResult(),
    sentViaTool: false,
  });
}

/** Everything the chat or the status path was sent. */
function everythingSaid(f: ReturnType<typeof fixture>): string {
  return JSON.stringify([
    f.adapter.outbound.sendAgentError.mock.calls,
    f.reply.sendText.mock.calls,
    f.api.setResting.mock.calls,
    f.api.setStatus.mock.calls,
    f.api.postMessage.mock.calls,
  ]);
}


describe("the host: a turn the usage limit refused", () => {
  let home: string, server: Server, host: CodexHost;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-usage-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  async function refused(error: Record<string, unknown> = {}) {
    const task = host.runTurn(1, "keep going");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "turn/completed", usageLimitTurn("thread-1", error));
    return task;
  }

  it("says one plain line, never the runtime's words, and marks the turn", async () => {
    const result = await refused();
    expect(result.error).toBe(PLAIN_NO_TIME);
    expectNoRawWords(result.error!);
    expect(result.usageLimited).toBe(true);
  });

  it("knows the refusal by its words when an older runtime sends no code", async () => {
    const result = await refused({ codexErrorInfo: null });
    expect(result.error).toBe(PLAIN_NO_TIME);
    expect(result.usageLimited).toBe(true);
  });

  it("end to end: the owner never sees the runtime's words in an error card", async () => {
    const result = await refused();
    // This block runs on the real clock, so the reset is two hours from now.
    const at = Math.floor(Date.now() / 1000) + 2 * HOUR;
    const f = fixture({ read: async () => rateLimitsRead({ session: sessionWindow(100, at) }) });
    await f.adapter.publishTurnResult({
      assistantId: ASSISTANT,
      chatId: CHAT,
      replyHandle: f.reply,
      result,
      sentViaTool: false,
    });
    expect(f.adapter.outbound.sendAgentError).not.toHaveBeenCalled();
    expectNoRawWords(everythingSaid(f));
    expect(f.api.setResting).toHaveBeenCalledTimes(1);
  });

  it("leaves every other failure as it was", async () => {
    const task = host.runTurn(1, "hi");
    await vi.waitFor(() => expect(server.next).toBe(1));
    server.emit("notification", "turn/completed", probe401Turn("thread-1"));
    const result = await task;
    expect(result.error).toBe(
      "Codex needs you to sign in again. Reconnect this agent in HOAI, then retry.",
    );
    expect(result.usageLimited).toBeUndefined();
  });

  it("gives every other error path the plain line too", () => {
    expect(friendlyCodexError(new Error(USAGE_LIMIT_RAW))).toBe(PLAIN_NO_TIME);
    expect(friendlyCodexError(USAGE_LIMIT_RAW)).toBe(PLAIN_NO_TIME);
  });
});

describe("the rules", () => {
  it("tells a spent account from a rate limit and from anything else", () => {
    expect(isUsageLimitError({ message: "x", codexErrorInfo: "usageLimitExceeded" })).toBe(true);
    expect(isUsageLimitError({ message: USAGE_LIMIT_RAW, codexErrorInfo: null })).toBe(true);
    expect(isUsageLimitError(new Error(USAGE_LIMIT_RAW))).toBe(true);
    expect(isUsageLimitError({ message: "slow down", codexErrorInfo: "rateLimitExceeded" })).toBe(false);
    expect(isUsageLimitError({ message: "boom", codexErrorInfo: "other" })).toBe(false);
    expect(isUsageLimitError(null)).toBe(false);
  });

  it("reads the reset of the spent session window", () => {
    const at = NOW_S + 2 * HOUR;
    expect(
      usageLimitReset(rateLimitsRead({ session: sessionWindow(100, at), weekly: weeklyWindow(40, NOW_S + 90 * HOUR) }), NOW_MS),
    ).toEqual({ resetAt: new Date(at * 1000).toISOString(), resetsAtMs: at * 1000, limitKind: "session" });
  });

  it("waits for the LATEST reset when both windows are spent", () => {
    const weekly = NOW_S + 50 * HOUR;
    expect(
      usageLimitReset(rateLimitsRead({ session: sessionWindow(100, NOW_S + HOUR), weekly: weeklyWindow(100, weekly) }), NOW_MS),
    ).toMatchObject({ resetsAtMs: weekly * 1000, limitKind: "weekly" });
  });

  it("knows no reset when none is spent, a spent one has no time, or the time is past", () => {
    expect(usageLimitReset(rateLimitsRead({ session: sessionWindow(80, NOW_S + HOUR) }), NOW_MS)).toBeNull();
    expect(usageLimitReset(rateLimitsRead({ session: sessionWindow(100, null) }), NOW_MS)).toBeNull();
    expect(
      usageLimitReset(rateLimitsRead({ session: sessionWindow(100, NOW_S + HOUR), weekly: weeklyWindow(100, null) }), NOW_MS),
    ).toBeNull();
    expect(usageLimitReset(rateLimitsRead({ session: sessionWindow(100, NOW_S - 60) }), NOW_MS)).toBeNull();
    expect(usageLimitReset(null, NOW_MS)).toBeNull();
  });

  it("says the time relative to now, never a clock, a link or a plan", () => {
    const line = usageLimitLine(NOW_S + 2 * HOUR + 60, NOW_MS);
    expect(line).toBe(
      "Codex has used up its usage for now and starts again by itself in about 2 hours. You do not need to do anything.",
    );
    expectNoRawWords(line);
    expect(usageLimitLine(null, NOW_MS)).toBe(PLAIN_NO_TIME);
    expect(usageLimitLine(NOW_S - 10, NOW_MS)).toBe(PLAIN_NO_TIME);
  });
});

describe("the adapter: the agent rests, and its goal starts again after the reset", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-usage-adapter-"));
    vi.useFakeTimers({ now: NOW_MS });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it("rests the agent until the reset instead of posting the runtime's words", async () => {
    const f = fixture();
    await publish(f);
    expect(f.api.setResting).toHaveBeenCalledTimes(1);
    expect(f.api.setResting).toHaveBeenCalledWith(ASSISTANT, {
      resetAt: new Date((NOW_S + 2 * HOUR) * 1000).toISOString(),
      limitKind: "session",
    });
    // HOAI's resting line is the one line: no error card, no second line.
    expect(f.adapter.outbound.sendAgentError).not.toHaveBeenCalled();
    expect(f.reply.sendText).not.toHaveBeenCalled();
    expectNoRawWords(everythingSaid(f));
    // After the turn's card closed: a rest ends at the agent's next activity.
    expect(f.reply.finalizeTurn.mock.invocationCallOrder[0]).toBeLessThan(
      f.api.setResting.mock.invocationCallOrder[0]!,
    );
  });

  it("reports one rest for two refusals in one window", async () => {
    const f = fixture();
    await publish(f);
    await publish(f);
    expect(f.api.setResting).toHaveBeenCalledTimes(1);
    expect(f.reply.sendText).not.toHaveBeenCalled();
  });

  it("says the plain line once, with no time, when the reset is unknown", async () => {
    const f = fixture({ read: async () => { throw new Error("account read failed"); } });
    await publish(f);
    await publish(f);
    expect(f.reply.sendText).toHaveBeenCalledTimes(1);
    expect(f.reply.sendText).toHaveBeenCalledWith(PLAIN_NO_TIME);
    expect(f.api.setResting).not.toHaveBeenCalled();
    expect(f.adapter.outbound.sendAgentError).not.toHaveBeenCalled();
  });

  it("treats a reset already past as unknown, and plans no resume", async () => {
    const f = fixture({ read: async () => rateLimitsRead({ session: sessionWindow(100, NOW_S - 30) }) });
    await f.adapter.goalLane.armFromMission({ assistantId: ASSISTANT, chatId: CHAT, missionId: MISSION, objective: OBJECTIVE, turnCap: 20 });
    f.runtime.goal.status = "usageLimited";
    await publish(f);
    expect(f.reply.sendText).toHaveBeenCalledWith(PLAIN_NO_TIME);
    f.host.setGoal.mockClear();
    await vi.advanceTimersByTimeAsync(24 * HOUR * 1000);
    expect(f.host.setGoal).not.toHaveBeenCalled();
  });

  it("says the line relative to now when the rest cannot be reported", async () => {
    const f = fixture();
    f.api.setResting.mockRejectedValueOnce(new Error("404"));
    await publish(f);
    expect(f.reply.sendText).toHaveBeenCalledWith(
      "Codex has used up its usage for now and starts again by itself in about 2 hours. You do not need to do anything.",
    );
  });

  it("picks the goal back up ONCE after the reset, and never before it", async () => {
    const f = fixture();
    await f.adapter.goalLane.armFromMission({ assistantId: ASSISTANT, chatId: CHAT, missionId: MISSION, objective: OBJECTIVE, turnCap: 20 });
    f.runtime.goal.status = "usageLimited";
    await publish(f);
    await publish(f);
    f.host.setGoal.mockClear();
    // Up to a second before the reset plus its margin: nothing.
    await vi.advanceTimersByTimeAsync(2 * HOUR * 1000 + USAGE_RESUME_MARGIN_MS - 1000);
    expect(f.host.setGoal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.host.setGoal).toHaveBeenCalledTimes(1);
    expect(f.host.setGoal).toHaveBeenCalledWith(CHAT, null, { status: "active" });
    await vi.advanceTimersByTimeAsync(24 * HOUR * 1000);
    expect(f.host.setGoal).toHaveBeenCalledTimes(1);
  });

  it("leaves a goal the owner paused in the meantime where it is", async () => {
    const f = fixture();
    await f.adapter.goalLane.armFromMission({ assistantId: ASSISTANT, chatId: CHAT, missionId: MISSION, objective: OBJECTIVE, turnCap: 20 });
    f.runtime.goal.status = "usageLimited";
    await publish(f);
    await f.adapter.goalLane.pauseForChat(CHAT);
    f.host.setGoal.mockClear();
    await vi.advanceTimersByTimeAsync(3 * HOUR * 1000);
    expect(f.host.setGoal).not.toHaveBeenCalled();
  });

  it("plans no resume in a chat that runs no goal", async () => {
    const f = fixture();
    await publish(f);
    await vi.advanceTimersByTimeAsync(3 * HOUR * 1000);
    expect(f.host.getGoal).not.toHaveBeenCalled();
    expect(f.host.setGoal).not.toHaveBeenCalled();
  });

  it("after a restart inside the window: the same rest, and the goal still starts again", async () => {
    const storePath = join(home, "usage-resumes.json");
    const before = fixture({ storePath });
    await before.adapter.goalLane.armFromMission({ assistantId: ASSISTANT, chatId: CHAT, missionId: MISSION, objective: OBJECTIVE, turnCap: 20 });
    before.runtime.goal.status = "usageLimited";
    await publish(before);
    const first = before.api.setResting.mock.calls[0];
    before.adapter.usageLimit.dispose();

    // A new process: no goal state, the runtime still holds the goal.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    const after = fixture({ storePath });
    after.runtime.goal = { ...before.runtime.goal };
    after.adapter.usageLimit.restore();
    // The next refusal in the same window reports the SAME reset, which the
    // app keys its one line on, so the owner sees nothing new.
    await publish(after);
    expect(after.api.setResting.mock.calls[0]).toEqual(first);
    expect(after.reply.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * HOUR * 1000);
    expect(after.host.setGoal).toHaveBeenCalledTimes(1);
    expect(after.host.setGoal).toHaveBeenCalledWith(CHAT, null, { status: "active" });
    // Taken back into the lane before it started, so its turns are adopted.
    expect(after.adapter.goalLane.owns(CHAT)).toBe(true);
  });
});
