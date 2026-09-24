/**
 * Where the mission bulletin joins a turn, and where it must NOT.
 *
 * Two orderings carry this. The bulletin is prefixed AFTER
 * missionLane.beginTurn, because beginTurn's prompt feeds titleFromPrompt,
 * which takes the FIRST LINE: prefix before it and every derived mission in a
 * turn that carried a bulletin is titled "HOAI mission update: ...". And the
 * drain happens in executeAndReply, not at compose time, because the composed
 * input is stored as `lastInput` and a note baked in there is re delivered on
 * every /retry and every button click resume.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { Input, UserInput } from "@openai/codex-sdk";

import { CodexAdapter } from "../src/adapter.js";
import { MissionControlLane } from "../src/mission-control.js";
import { normalizeMissionEvent } from "../src/mission-events.js";

function missionControl(steerThrows = true) {
  return new MissionControlLane({
    host: {
      steer: async () => {
        if (steerThrows) throw new Error("no live turn");
      },
    },
    missionLane: { notePaused: vi.fn(), noteResumed: vi.fn(), noteClosed: vi.fn() },
    chatsForAssistant: () => [],
    isOwned: () => true,
  });
}

function fixture(control: MissionControlLane) {
  const adapter = Object.create(CodexAdapter.prototype) as any;
  const runTurn = vi.fn(async () => ({
    error: null,
    replyText: "done",
    turnCompleted: true,
  }));
  const beginTurn = vi.fn(() => 1);
  Object.assign(adapter, {
    turnControllers: new Map(),
    planCardFailures: new Set(),
    lastInput: new Map<number, Input>(),
    ownerId: "owner-1",
    missionLane: { beginTurn, finalizeTurn: vi.fn(async () => {}) },
    goalLane: {
      owns: vi.fn(() => false),
      noteTurnStarted: vi.fn(),
      noteTurnFinished: vi.fn(async () => {}),
    },
    stepsLane: { handlePlan: vi.fn(async () => {}), finalizeTurn: vi.fn(async () => {}) },
    missionControl: control,
    toolProgress: { sendToolStart: vi.fn(async () => {}) },
    outbound: { sendAgentError: vi.fn(async () => {}) },
    api: {},
    tools: { handleRequest: vi.fn(async () => ({})) },
    host: { runTurn },
  });
  const reply = {
    sendTyping: vi.fn(async () => {}),
    finalizeTurn: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
  };
  return { adapter, reply, runTurn, beginTurn };
}

function pausedFrame(chatId: number) {
  return normalizeMissionEvent("mission_paused", {
    event_type: "mission_paused",
    user_id: "owner-1",
    assistant_id: 10,
    chat_id: chatId,
    mission: {
      id: 91,
      assistantId: 10,
      title: "Ship the strip",
      status: "paused",
      origin: "derived",
      pausedReason: "waiting on design",
      updatedAt: "2026-09-20T12:00:00.000Z",
    },
    timestamp: `2026-09-20T12:00:0${chatId % 9}.000Z`,
  })!;
}

describe("the adapter's mission bulletin wiring", () => {
  it("gives beginTurn the ORIGINAL prompt and runTurn the PREFIXED input", async () => {
    const control = missionControl();
    const { adapter, reply, runTurn, beginTurn } = fixture(control);
    await control.handle(pausedFrame(20));

    await adapter.executeAndReply(10, 20, "Fix the login bug\nsecond line", reply);

    expect(beginTurn).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      prompt: "Fix the login bug\nsecond line",
    });
    const sent = runTurn.mock.calls[0]![1] as string;
    expect(sent.startsWith("HOAI mission update:")).toBe(true);
    expect(sent).toContain("paused the mission");
    expect(sent.endsWith("Fix the login bug\nsecond line")).toBe(true);
  });

  it("hands runTurn the input unchanged BY IDENTITY when nothing is queued", async () => {
    const { adapter, reply, runTurn } = fixture(missionControl());
    const input: Input = "Plain work";
    await adapter.executeAndReply(10, 20, input, reply);
    expect(runTurn.mock.calls[0]![1]).toBe(input);
  });

  it("consumes the bulletin exactly once", async () => {
    const control = missionControl();
    const { adapter, reply, runTurn } = fixture(control);
    await control.handle(pausedFrame(20));

    await adapter.executeAndReply(10, 20, "First", reply);
    await adapter.executeAndReply(10, 20, "Second", reply);

    expect(String(runTurn.mock.calls[0]![1])).toContain("HOAI mission update:");
    expect(runTurn.mock.calls[1]![1]).toBe("Second");
  });

  it("leaves lastInput clean, so a /retry replay never re delivers a note", async () => {
    const control = missionControl();
    const { adapter, reply, runTurn } = fixture(control);
    const composed: Input = "HOAI event: assistant_id=10\n\nMessage:\nfix it";
    adapter.lastInput.set(20, composed);
    await control.handle(pausedFrame(20));

    await adapter.executeAndReply(10, 20, composed, reply);
    expect(String(runTurn.mock.calls[0]![1])).toContain("HOAI mission update:");
    // The stored input is what /retry replays. It must be the clean one.
    expect(adapter.lastInput.get(20)).toBe(composed);

    await adapter.executeAndReply(10, 20, adapter.lastInput.get(20), reply);
    expect(runTurn.mock.calls[1]![1]).toBe(composed);
  });

  it("keeps the image parts of a turn that carries a bulletin", async () => {
    const control = missionControl();
    const { adapter, reply, runTurn } = fixture(control);
    await control.handle(pausedFrame(20));
    const input: UserInput[] = [
      { type: "text", text: "look" },
      { type: "local_image", path: "/tmp/a.png" },
    ];

    await adapter.executeAndReply(10, 20, input, reply);

    const sent = runTurn.mock.calls[0]![1] as UserInput[];
    expect(sent).toHaveLength(3);
    expect(sent[0]!.type).toBe("text");
    expect(String((sent[0] as { text: string }).text)).toContain("HOAI mission update:");
    expect(sent[2]).toEqual({ type: "local_image", path: "/tmp/a.png" });
  });
});

describe("which assistants a mission frame is accepted for", () => {
  function owner(fields: Record<string, unknown>) {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    Object.assign(adapter, { assistantToRoute: new Map<number, string>(), ...fields });
    return (assistantId: number): boolean => adapter.ownsAssistantForMission(assistantId);
  }

  it("accepts a frame before the first scope load, because we do not yet KNOW what we own", () => {
    // The same exception assistantForChat makes: an empty assistantToRoute
    // before identity means unloaded, not empty, and a frame the backend
    // routed to this pairing is better evidence than an unloaded map.
    expect(owner({ identityReady: false })(7)).toBe(true);
  });

  it("refuses a frame for an assistant this daemon does not own once the scope is in", () => {
    const isOwned = owner({
      identityReady: true,
      assistantToRoute: new Map([[7, "codex"]]),
    });
    expect(isOwned(7)).toBe(true);
    expect(isOwned(8)).toBe(false);
  });
});

/**
 * The typed mission tools must reach the control lane's self write stamp.
 *
 * It is a constructor argument, so nothing else in the suite can notice it
 * going missing: an unstamped tool write comes back from a backend older than
 * stage 5 with no `cleared_by`, is read as the owner ending the mission, and
 * is narrated and steered into the very turn that made it. This reads the
 * wiring itself, the way the Claude plugin pins its own.
 */
describe("the mission self write wiring of the typed tools", () => {
  const source = readFileSync(
    new URL("../src/adapter.ts", import.meta.url),
    "utf8",
  );

  it("hands HoaiTools both halves of the stamp", () => {
    const start = source.indexOf("new HoaiTools(");
    expect(start).toBeGreaterThan(0);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toContain("missionControl.noteSelfWrite");
    expect(construction).toContain("missionControl.dropSelfWrite");
  });
});

/**
 * The continuation turn nobody asked for (mission program stage 6).
 *
 * While a goal is active the app server starts turns by itself. The host
 * offers each one to the adapter, and everything the owner sees of that work
 * depends on the adapter taking it: the tool cards, the typing indicator and
 * the reply itself all ride the same path an ordinary turn takes, or none of
 * them happens at all.
 */
describe("adopting a turn the app server started by itself", () => {
  function fixture(owns: boolean) {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const sendText = vi.fn(async () => ({ id: 1 }));
    const order: string[] = [];
    const goalLane = {
      owns: vi.fn(() => owns),
      noteTurnStarted: vi.fn(),
      noteTurnFinished: vi.fn(async () => {
        order.push("turnFinished");
      }),
    };
    const stepsLane = {
      handlePlan: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {
        order.push("stepsCleared");
      }),
    };
    const agentRequest = vi.fn(async () => ({}));
    Object.assign(adapter, {
      ownerId: "owner-1",
      identityReady: false,
      planCardFailures: new Set<number>(),
      // The chat's stop generation, which an adopted turn reads (Round 7).
      generations: new Map<number, number>(),
      chatToAssistant: new Map<number, number>([[20, 10]]),
      assistantToRoute: new Map<number, string>(),
      goalLane,
      stepsLane,
      outbound: {
        sendText: vi.fn(async (body: unknown) => {
          order.push("reply");
          return sendText(body as never);
        }),
        sendAgentError: vi.fn(async () => {}),
      },
      toolProgress: { sendToolStart: vi.fn(async () => {}) },
      tools: { handleRequest: vi.fn(async () => ({})) },
      api: { setStatus: vi.fn(async () => {}), agentRequest },
    });
    return { adapter, goalLane, stepsLane, sendText, agentRequest, order };
  }

  it("leaves a turn unadopted for a chat the goal lane does not own", () => {
    const { adapter, goalLane } = fixture(false);
    expect(adapter.adoptGoalTurn(20)).toBeNull();
    expect(goalLane.noteTurnStarted).not.toHaveBeenCalled();
  });

  it("counts the turn as it opens, because the cap is counted in turns", () => {
    const { adapter, goalLane } = fixture(true);
    expect(adapter.adoptGoalTurn(20)).not.toBeNull();
    expect(goalLane.noteTurnStarted).toHaveBeenCalledWith(20);
  });

  it("delivers the reply to the chat and then tells the lane the turn ended", async () => {
    const { adapter, goalLane, sendText } = fixture(true);
    const adopted = adapter.adoptGoalTurn(20)!;

    await adopted.deliver({
      replyText: "The page now loads in 1.8 seconds.",
      finalAgentMessageText: "The page now loads in 1.8 seconds.",
      turnCompleted: true,
      error: null,
      threadId: "thread-20",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: 10,
        chatId: 20,
        text: "The page now loads in 1.8 seconds.",
      }),
    );
    expect(goalLane.noteTurnFinished).toHaveBeenCalledWith(20, {
      text: "The page now loads in 1.8 seconds.",
      error: null,
    });
  });

  it("still ends the turn for the lane when the runtime failed it", async () => {
    const { adapter, goalLane } = fixture(true);
    const adopted = adapter.adoptGoalTurn(20)!;

    await adopted.deliver({
      replyText: "",
      finalAgentMessageText: "",
      turnCompleted: false,
      error: "Codex could not finish the turn.",
      threadId: "thread-20",
    });

    expect(goalLane.noteTurnFinished).toHaveBeenCalledWith(20, {
      text: "",
      error: "Codex could not finish the turn.",
    });
  });

  it("adopts nothing when the chat belongs to no assistant this daemon knows", () => {
    const { adapter } = fixture(true);
    expect(adapter.adoptGoalTurn(99)).toBeNull();
  });

  /**
   * The two notifications an adopted turn used to drop on the floor.
   *
   * A continuation turn raises `turn/plan/updated` and
   * `thread/tokenUsage/updated` exactly as a turn the owner asked for does,
   * and the host hands both to the turn's own callbacks. With neither wired,
   * the owner's live Steps stayed blank and the agent's context percentage
   * stopped moving for the whole autonomous run, which is the opposite of the
   * promise this channel ships: the goal's work reaches the owner between
   * messages exactly as it does inside a turn they asked for.
   */
  it("keeps the owner's live Steps in step during the goal's own turns", async () => {
    const { adapter, stepsLane } = fixture(true);
    const adopted = adapter.adoptGoalTurn(20)!;

    await adopted.callbacks.onPlan({
      turnId: "turn-7",
      plan: [
        { step: "measure the page", status: "completed" },
        { step: "shrink the images", status: "in_progress" },
      ],
    });

    expect(stepsLane.handlePlan).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      turnId: "turn-7",
      plan: [
        { step: "measure the page", status: "completed" },
        { step: "shrink the images", status: "in_progress" },
      ],
    });
  });

  it("keeps the agent's context reading moving while nobody is watching", async () => {
    const { adapter, agentRequest } = fixture(true);
    const adopted = adapter.adoptGoalTurn(20)!;

    adopted.callbacks.onUsage({
      modelContextWindow: 200_000,
      last: { inputTokens: 50_000 },
    });
    await Promise.resolve();

    expect(agentRequest).toHaveBeenCalledWith(
      "PATCH",
      "integrations/assistants/10/status",
      10,
      { contextPct: 25 },
    );
  });

  it("clears the finished list before the reply, the way an ordinary turn does", async () => {
    const { adapter, stepsLane, order } = fixture(true);
    const adopted = adapter.adoptGoalTurn(20)!;

    await adopted.deliver({
      replyText: "Done.",
      finalAgentMessageText: "Done.",
      turnCompleted: true,
      error: null,
      threadId: "thread-20",
    });

    expect(stepsLane.finalizeTurn).toHaveBeenCalledWith(20);
    // A list left on screen would be the previous turn's plan sitting under
    // the next turn's work, re sent by the lane's own keepalive for ever.
    expect(order).toEqual(["stepsCleared", "reply", "turnFinished"]);
  });
});

/**
 * The goal lane's wiring, read off the source the way the self write stamp
 * above is. Every one of these is a constructor argument or a host option, so
 * nothing else in the suite notices one going missing: the daemon would just
 * quietly stop arming goals, adopting turns or standing the plan lane down.
 */
describe("the goal lane wiring", () => {
  const source = readFileSync(
    new URL("../src/adapter.ts", import.meta.url),
    "utf8",
  );

  it("hands the host both goal options", () => {
    const start = source.indexOf("new CodexHost(");
    expect(start).toBeGreaterThan(0);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toContain("onGoalUpdate");
    expect(construction).toContain("onAdoptedTurn");
  });

  it("tells the plan lane which chats the goal lane owns", () => {
    const start = source.indexOf("new MissionLane(");
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toContain("goalOwnsChat");
    expect(construction).toContain("goalLane.owns");
  });

  it("hands the owner's decisions to the goal lane as well as to the model", () => {
    const start = source.indexOf("new MissionControlLane(");
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toContain("goalLane: this.goalLane");
    // Arming a goal starts this chat's thread, and the thread's config names
    // the agent, so the control lane records the pair before it arms. Without
    // this line a daemon owning two agents drops every continuation turn.
    expect(construction).toContain("noteChat");
  });

  it("gives the native goal command the lane, never the host alone", () => {
    const start = source.indexOf("new NativeCommands(");
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toContain("goalLane: this.goalLane");
  });

  it("stamps the goal lane's own writes so they are not read as the owner's", () => {
    const start = source.indexOf("new GoalLane(");
    expect(start).toBeGreaterThan(0);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toContain("missionControl.noteSelfWrite");
  });

  it("forgets every goal on shutdown, and fails no mission for it", () => {
    expect(source).toContain("this.goalLane.dispose()");
  });
});
