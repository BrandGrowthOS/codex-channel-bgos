import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { abortCauseOf, abortWith, type AbortCause } from "../src/abort-cause.js";
import { CodexAdapter } from "../src/adapter.js";
import { MissionLane } from "../src/mission-lane.js";
import {
  RESUME_TURN_TEXT,
  STOP_CONFIRMATION_HARD,
  STOP_PAUSE_REASON,
} from "../src/session-controls-contract.js";

function fixture(pendingMenu = false, running = false) {
  // Exercise the actual frame handler without starting a daemon or model.
  const adapter = Object.create(CodexAdapter.prototype) as any;
  const controller = new AbortController();
  Object.assign(adapter, {
    getRouteForAssistant: vi.fn((id) => (id === 10 ? "codex" : undefined)),
    refreshScopeRateLimited: vi.fn(async () => {}),
    rpcSeen: new Set(),
    // handleControl records which agent a chat belongs to (the Agent Browser
    // relay needs it), so the harness carries the same cache the real adapter has.
    chatToAssistant: new Map<number, number>(),
    turnControllers: new Map(running ? [[20, new Set([controller])]] : []),
    generations: new Map(),
    nativeCommands: { cancel: vi.fn(() => pendingMenu) },
    host: { stopTurn: vi.fn(async () => {}) },
    outbound: { sendText: vi.fn(async () => ({ id: 1 })) },
    // P6 stage 3: the Stop opens the chat's settle on the mission lane
    // before it aborts, so a racing Resume waits for the pause.
    missionLane: { noteStopRequested: vi.fn() },
    api: {
      postVoiceRpcAck: vi.fn(async () => {}),
      postVoiceRpcResult: vi.fn(async () => {}),
    },
  });
  const frame = {
    rpcId: "stop-1",
    op: "stop_turn",
    assistantId: "10",
    chatId: "20",
    payload: {},
  };
  return { adapter, controller, frame };
}

describe("native Stop control completion", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "acknowledges the visible Stop button with menu=%s and turn=%s",
    async (menu, running) => {
      const { adapter, controller, frame } = fixture(menu, running);
      await adapter.handleControl(frame);
      expect(adapter.nativeCommands.cancel).toHaveBeenCalledWith(20);
      expect(adapter.host.stopTurn).toHaveBeenCalledWith(20);
      expect(controller.signal.aborted).toBe(running);
      expect(adapter.outbound.sendText).toHaveBeenCalledWith({
        assistantId: 10,
        chatId: 20,
        text: "Stopped.",
      });
      expect(adapter.api.postVoiceRpcResult).toHaveBeenCalledWith("stop-1", {
        ok: true,
        payload: { stopped: menu || running, supported: true },
      });
      await adapter.handleControl(frame);
      expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
    },
  );
  it("records which agent the chat belongs to, for the Agent Browser relay", async () => {
    const { adapter, frame } = fixture();
    await adapter.handleControl(frame);
    expect(adapter.chatToAssistant.get(20)).toBe(10);
  });
  it("does not stop or acknowledge a different assistant's chat", async () => {
    const { adapter, frame } = fixture(true);
    await adapter.handleControl({ ...frame, assistantId: "99" });
    expect(adapter.nativeCommands.cancel).not.toHaveBeenCalled();
    expect(adapter.host.stopTurn).not.toHaveBeenCalled();
    expect(adapter.outbound.sendText).not.toHaveBeenCalled();
  });
  it.each(["result", "rejection"])(
    "does not turn an intentional stop into a red agent error or delayed reply (%s)",
    async (completion) => {
      const { adapter } = fixture();
      const reply = {
        sendTyping: vi.fn(async () => {}),
        finalizeTurn: vi.fn(async () => {}),
        sendText: vi.fn(async () => {}),
      };
      adapter.missionLane = {
        beginTurn: vi.fn(() => 1),
        finalizeTurn: vi.fn(async () => {}),
      };
      // The turn asks the mission control lane whether the owner changed a
      // mission since the last turn. Nothing queued here, so the input passes
      // through untouched.
      adapter.missionControl = { applyBulletin: (_chatId: number, input: unknown) => input };
      adapter.outbound.sendAgentError = vi.fn();
      adapter.host.runTurn = vi.fn(async () => {
        for (const controller of adapter.turnControllers.get(20))
          controller.abort();
        if (completion === "rejection") throw new Error("Stopped by you.");
        return {
          error: "Stopped by you.",
          replyText: "Late partial response",
          turnCompleted: false,
        };
      });
      await adapter.executeAndReply(10, 20, "Wait then reply", reply);
      expect(adapter.outbound.sendAgentError).not.toHaveBeenCalled();
      expect(reply.sendText).not.toHaveBeenCalled();
      expect(reply.finalizeTurn).toHaveBeenCalledTimes(1);
      expect(adapter.turnControllers.size).toBe(0);
    },
  );
  it("keeps genuine native failures visible when the user did not stop", async () => {
    const { adapter } = fixture();
    const reply = {
      sendTyping: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
    };
    adapter.missionLane = {
      beginTurn: vi.fn(() => 1),
      finalizeTurn: vi.fn(async () => {}),
    };
    adapter.missionControl = { applyBulletin: (_chatId: number, input: unknown) => input };
    adapter.outbound.sendAgentError = vi.fn(async () => {});
    adapter.host.runTurn = vi.fn(async () => ({
      error: "Connection lost",
      replyText: "",
      turnCompleted: false,
    }));
    await adapter.executeAndReply(10, 20, "Work", reply);
    expect(adapter.outbound.sendAgentError).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      reason: "Connection lost",
    });
  });
});

/**
 * An owner Stop pauses the chat's open mission and never fails it (P6 stage
 * 3, C-32, spec 4.2).
 *
 * Every abort of a turn now carries its cause, and the turn's unwind reads the
 * cause BEFORE it touches the mission: on both paths, the aborted return and
 * the catch, which used to fail the mission first and only then look at the
 * signal. An owner Stop pauses; /new, a shutdown and a revoked pairing fail
 * with their own words; a real error fails as it always did.
 */
describe("an owner Stop pauses the mission, never fails it (P6 stage 3)", () => {
  function dispatchFixture() {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const controller = new AbortController();
    const order: string[] = [];
    Object.assign(adapter, {
      chatToAssistant: new Map<number, number>(),
      turnControllers: new Map([[20, new Set([controller])]]),
      generations: new Map(),
      lastInput: new Map([[20, "the last input"]]),
      lastNativeOptions: new Map(),
      nativeCommands: { handle: vi.fn(async () => false), cancel: vi.fn(() => false) },
      host: { stopTurn: vi.fn(async () => {}), resetChat: vi.fn() },
      missionLane: {
        noteStopRequested: vi.fn(() => order.push(`settle, aborted=${controller.signal.aborted}`)),
        clearStopMarker: vi.fn(() => order.push(`forget, aborted=${controller.signal.aborted}`)),
      },
    });
    const replyHandle = { sendText: vi.fn(async () => {}) };
    const args = (name: string) => ({
      origin: "bgos",
      agentRoute: "codex",
      assistantId: 10,
      chatId: 20,
      messageId: 5,
      userId: "owner-1",
      text: `/${name}`,
      attachments: [],
      systemPrompt: "",
      replyHandle,
      command: { name, args: "" },
      messageType: "slash_command",
      senderType: "user",
    });
    return { adapter, controller, order, replyHandle, args };
  }

  function turnFixture(
    run: (adapter: any) => Promise<unknown>,
  ) {
    const { adapter } = fixture();
    const reply = {
      sendTyping: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
    };
    adapter.missionLane = {
      beginTurn: vi.fn(() => 1),
      finalizeTurn: vi.fn(async () => {}),
      stoppedByOwner: vi.fn(async () => {}),
      noteOwnerTurn: vi.fn(async () => {}),
    };
    adapter.missionControl = { applyBulletin: (_chatId: number, input: unknown) => input };
    adapter.outbound.sendAgentError = vi.fn(async () => {});
    adapter.host.runTurn = vi.fn(async () => run(adapter));
    // whoami's answer: only this person coming back resumes a Stop pause.
    adapter.ownerId = "owner-1";
    return { adapter, reply };
  }

  function abortAll(adapter: any, cause: AbortCause) {
    for (const controller of adapter.turnControllers.get(20)) abortWith(controller, cause);
  }

  it("the Stop button opens the chat's settle, THEN aborts with owner_stop, and still says Stopped. once", async () => {
    const { adapter, controller, frame } = fixture(false, true);
    const aborted: boolean[] = [];
    adapter.missionLane.noteStopRequested = vi.fn(() => aborted.push(controller.signal.aborted));
    await adapter.handleControl(frame);
    await adapter.handleControl(frame);

    expect(adapter.missionLane.noteStopRequested).toHaveBeenCalledWith(20);
    expect(aborted).toEqual([false]);
    expect(abortCauseOf(controller.signal)).toBe("owner_stop");
    expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
    expect(adapter.outbound.sendText).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      text: STOP_CONFIRMATION_HARD,
    });
  });

  it("/stop opens the chat's settle, THEN aborts with owner_stop, and says Stopped.", async () => {
    const { adapter, controller, order, replyHandle, args } = dispatchFixture();
    await adapter.codexDispatch(args("stop"));
    expect(order).toEqual(["settle, aborted=false"]);
    expect(abortCauseOf(controller.signal)).toBe("owner_stop");
    expect(replyHandle.sendText).toHaveBeenCalledWith(STOP_CONFIRMATION_HARD);
    expect(adapter.missionLane.clearStopMarker).not.toHaveBeenCalled();
  });

  it("/new aborts with new, and forgets the chat's Stop pause so nothing resumes it from the discarded context", async () => {
    const { adapter, controller, order, args } = dispatchFixture();
    await adapter.codexDispatch(args("new"));
    expect(abortCauseOf(controller.signal)).toBe("new");
    expect(adapter.missionLane.noteStopRequested).not.toHaveBeenCalled();
    expect(adapter.missionLane.clearStopMarker).toHaveBeenCalledWith(20);
    expect(order).toEqual(["forget, aborted=true"]);
    expect(adapter.host.resetChat).toHaveBeenCalledWith(20);
  });

  it("a daemon shutdown aborts a running turn with shutdown", async () => {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    const controller = new AbortController();
    Object.assign(adapter, {
      started: true,
      pollTimer: null,
      spoolTimer: null,
      identityRetryTimer: null,
      secretsWatcher: null,
      secretsStatTimer: null,
      secretsDebounce: null,
      nativeCommands: { close: vi.fn() },
      meetings: { stop: vi.fn() },
      voiceTasks: new Map(),
      turnControllers: new Map([[20, new Set([controller])]]),
      host: { close: vi.fn() },
      heartbeat: { stop: vi.fn() },
      ws: { disconnect: vi.fn() },
      toolProgress: { dispose: vi.fn() },
      missionControl: { dispose: vi.fn() },
      goalLane: { dispose: vi.fn() },
      missionLane: { dispose: vi.fn(async () => {}) },
      stepsLane: { dispose: vi.fn(async () => {}) },
      commandsSync: { flushAll: vi.fn(async () => {}) },
    });
    await adapter.stop();
    expect(abortCauseOf(controller.signal)).toBe("shutdown");
    expect(adapter.missionLane.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["revoked", "rotated"] as const)(
    "the fatal latch (%s) aborts a running turn with revoked",
    (reason) => {
      const adapter = Object.create(CodexAdapter.prototype) as any;
      const controller = new AbortController();
      Object.assign(adapter, {
        fatalLatched: false,
        fatalNotified: false,
        pollTimer: null,
        identityRetryTimer: null,
        turnControllers: new Map([[20, new Set([controller])]]),
        voiceTasks: new Map(),
        meetings: { stop: vi.fn() },
        nativeCommands: { close: vi.fn() },
        host: { close: vi.fn() },
        heartbeat: {
          setNetEnabled: vi.fn(),
          setLastError: vi.fn(),
          setWsConnected: vi.fn(),
        },
        ws: { disconnect: vi.fn() },
        startSecretsWatch: vi.fn(),
      });
      adapter.enterFatalLatch(reason, "Pairing revoked");
      expect(abortCauseOf(controller.signal)).toBe("revoked");
    },
  );

  it.each(["result", "rejection"])(
    "an owner Stop PAUSES the turn's mission and never fails it (%s)",
    async (completion) => {
      const { adapter, reply } = turnFixture(async (target) => {
        abortAll(target, "owner_stop");
        if (completion === "rejection") throw new Error("Turn interrupted");
        return { error: "Turn interrupted", replyText: "partial", turnCompleted: false };
      });
      await expect(
        adapter.executeAndReply(10, 20, "Work", reply),
      ).resolves.toBeUndefined();
      expect(adapter.missionLane.stoppedByOwner).toHaveBeenCalledWith({
        chatId: 20,
        turnToken: 1,
        assistantId: 10,
      });
      // The catch used to fail the mission BEFORE it looked at the signal.
      expect(adapter.missionLane.finalizeTurn).not.toHaveBeenCalled();
      expect(adapter.outbound.sendAgentError).not.toHaveBeenCalled();
      expect(reply.sendText).not.toHaveBeenCalled();
      expect(reply.finalizeTurn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["new", "Started a new conversation before the plan finished", "result"],
    ["new", "Started a new conversation before the plan finished", "rejection"],
    ["shutdown", "Daemon stopped before the plan finished", "result"],
    ["shutdown", "Daemon stopped before the plan finished", "rejection"],
    ["revoked", "The pairing was revoked before the plan finished", "result"],
    ["revoked", "The pairing was revoked before the plan finished", "rejection"],
  ] as const)(
    "%s still FAILS the mission with its own words (%s, %s)",
    async (cause, words, completion) => {
      const { adapter, reply } = turnFixture(async (target) => {
        abortAll(target, cause);
        if (completion === "rejection") throw new Error("Turn interrupted");
        return { error: "Turn interrupted", replyText: "", turnCompleted: false };
      });
      await adapter.executeAndReply(10, 20, "Work", reply);
      expect(adapter.missionLane.finalizeTurn).toHaveBeenCalledTimes(1);
      expect(adapter.missionLane.finalizeTurn).toHaveBeenCalledWith({
        chatId: 20,
        turnToken: 1,
        error: words,
      });
      expect(adapter.missionLane.stoppedByOwner).not.toHaveBeenCalled();
    },
  );

  it("a real error in the catch branch still fails with its message, and is rethrown", async () => {
    const { adapter, reply } = turnFixture(async () => {
      throw new Error("Codex died");
    });
    await expect(adapter.executeAndReply(10, 20, "Work", reply)).rejects.toThrow("Codex died");
    expect(adapter.missionLane.finalizeTurn).toHaveBeenCalledWith({
      chatId: 20,
      turnToken: 1,
      error: "Codex died",
    });
    expect(adapter.missionLane.stoppedByOwner).not.toHaveBeenCalled();
  });

  it.each([
    ["a typed message", { userId: "owner-1", senderType: "user", messageId: 5 }, true],
    ["a message with no sender type (the REST backfill)", { userId: "owner-1", messageId: 5 }, true],
    ["a button the owner clicked", { userId: "owner-1" }, true],
    ["a scheduled wake", { userId: "owner-1", senderType: "system" }, false],
    ["a peer agent's message", { userId: "owner-1", senderType: "agent", peerConversationId: 9 }, false],
    ["a side thread from a peer", { userId: "owner-1", senderType: "user", peerConversationId: 9 }, false],
    ["a meeting turn", { userId: "owner-1", chatKind: "meeting" }, false],
    ["a turn with no person on it", {}, false],
    ["a turn with no source at all", undefined, false],
    // D11 says OWNER authored, as the Claude plugin reads it: another person
    // in a group chat or on a shared agent is not the owner coming back.
    [
      "a group member's message, not the owner's",
      { userId: "owner-1", senderUserId: "member-2", senderType: "user", senderRelationship: "member" },
      false,
    ],
    [
      "a shared agent's recipient writing to it",
      { userId: "recipient-3", senderUserId: "recipient-3", senderType: "user", senderRelationship: "shared_recipient" },
      false,
    ],
    ["a message whose sender is blank", { userId: "owner-1", senderUserId: "", senderType: "user" }, false],
    [
      "the owner named as the sender in a group chat",
      { userId: "owner-1", senderUserId: "owner-1", senderType: "user", chatKind: "group" },
      true,
    ],
  ] as const)("asks the mission lane about the owner's return for %s: %s", async (_label, source, owner) => {
    const { adapter, reply } = turnFixture(async () => ({
      error: null,
      replyText: "done",
      turnCompleted: true,
    }));
    await adapter.executeAndReply(10, 20, "Work", reply, source);
    if (owner) {
      expect(adapter.missionLane.noteOwnerTurn).toHaveBeenCalledWith(20, 10);
      expect(adapter.missionLane.noteOwnerTurn.mock.invocationCallOrder[0]).toBeLessThan(
        adapter.missionLane.beginTurn.mock.invocationCallOrder[0],
      );
    } else {
      expect(adapter.missionLane.noteOwnerTurn).not.toHaveBeenCalled();
    }
  });

  it("never counts a turn as the owner's before the daemon knows who its owner is", async () => {
    const { adapter, reply } = turnFixture(async () => ({
      error: null,
      replyText: "done",
      turnCompleted: true,
    }));
    adapter.ownerId = "";
    await adapter.executeAndReply(10, 20, "Work", reply, { userId: "owner-1", senderType: "user" });
    expect(adapter.missionLane.noteOwnerTurn).not.toHaveBeenCalled();
  });

  it("waits for the owner's return to be settled BEFORE the turn begins", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, reply } = turnFixture(async () => ({
      error: null,
      replyText: "done",
      turnCompleted: true,
    }));
    adapter.missionLane.noteOwnerTurn = vi.fn(() => gate);
    const running = adapter.executeAndReply(10, 20, RESUME_TURN_TEXT, reply, {
      userId: "owner-1",
      senderType: "user",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.missionLane.beginTurn).not.toHaveBeenCalled();
    release();
    await running;
    expect(adapter.missionLane.beginTurn).toHaveBeenCalledTimes(1);
  });

  it("end to end: the Stop button in a goal chat holds the goal, THEN pauses the mission, and the Resume turn puts both back", async () => {
    const order: string[] = [];
    let reads = 0;
    const mission = (status: "active" | "paused", pausedReason: string | null) => ({
      id: 701,
      assistantId: 10,
      chatId: 20,
      title: "Plan",
      status,
      origin: "derived",
      progress: null,
      keepWorking: true,
      pausedReason,
    });
    const api = {
      getActiveMission: vi.fn(async () => {
        reads += 1;
        // The first owner turn's read, the Stop's read, the Resume's read.
        return reads < 3 ? mission("active", null) : mission("paused", STOP_PAUSE_REASON);
      }),
      pauseMission: vi.fn(async (_a: number, id: number, body: { reason?: string }) => {
        order.push(`PATCH pause ${id} "${body.reason}"`);
        return mission("paused", body.reason ?? null);
      }),
      resumeMission: vi.fn(async (_a: number, id: number) => {
        order.push(`PATCH resume ${id}`);
        return mission("active", null);
      }),
      failMission: vi.fn(async () => {
        order.push("PATCH fail");
      }),
      completeMission: vi.fn(async () => {
        order.push("PATCH complete");
      }),
      postVoiceRpcAck: vi.fn(async () => {}),
      postVoiceRpcResult: vi.fn(async () => {}),
    };
    const goalLane = {
      owns: (chatId: number) => chatId === 20,
      pauseForChat: vi.fn(async (chatId: number) => {
        order.push(`goal held ${chatId}`);
        return null;
      }),
      noteResumed: vi.fn(async (missionId: number) => {
        order.push(`goal given back ${missionId}`);
      }),
    };
    const { adapter, frame } = fixture();
    adapter.ownerId = "owner-1";
    adapter.api = api;
    adapter.goalLane = goalLane;
    // Built with the adapter's own wiring of these options (pinned below).
    adapter.missionLane = new MissionLane(api as never, {
      goalOwnsChat: (chatId) => goalLane.owns(chatId),
      pauseGoalForChat: (chatId) => goalLane.pauseForChat(chatId),
      resumeGoalForMission: (missionId) => goalLane.noteResumed(missionId),
      onSelfWrite: (missionId) => order.push(`stamp ${missionId}`),
    });
    adapter.missionControl = { applyBulletin: (_chatId: number, input: unknown) => input };
    adapter.toolProgress = { sendToolStart: vi.fn(async () => {}) };
    adapter.outbound.sendAgentError = vi.fn(async () => {});
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    adapter.host.runTurn = vi.fn(
      (_chatId: number, _input: unknown, callbacks: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          callbacks.signal.addEventListener(
            "abort",
            () => resolve({ error: "Turn interrupted", replyText: "", turnCompleted: false }),
            { once: true },
          );
          started();
        }),
    );
    const reply = {
      sendTyping: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
    };
    const owner = { userId: "owner-1", senderType: "user", messageId: 5 } as const;

    const turn = adapter.executeAndReply(10, 20, "Ship the strip", reply, owner);
    await running;
    await adapter.handleControl(frame);
    await turn;

    expect(order).toEqual([
      "stamp 701",
      "goal held 20",
      `PATCH pause 701 "${STOP_PAUSE_REASON}"`,
    ]);
    expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
    expect(adapter.outbound.sendText).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      text: "Stopped.",
    });

    // The owner presses Resume: the sentence is an ordinary owner message.
    adapter.host.runTurn = vi.fn(async () => ({
      error: null,
      replyText: "Picking up from the second step.",
      turnCompleted: true,
      finalAgentMessageText: "Picking up from the second step.",
    }));
    await adapter.executeAndReply(10, 20, RESUME_TURN_TEXT, reply, owner);

    expect(order).toEqual([
      "stamp 701",
      "goal held 20",
      `PATCH pause 701 "${STOP_PAUSE_REASON}"`,
      "stamp 701",
      "PATCH resume 701",
      "goal given back 701",
    ]);
    expect(api.failMission).not.toHaveBeenCalled();
  });
});

/**
 * The adapter hands the mission lane the goal lane's hold and give back.
 * Constructor arguments, so nothing else in the suite notices one going
 * missing: without the hold a goal chat's runtime could start a continuation
 * turn after the owner's Stop, before the mission_paused echo arrived.
 */
describe("the Stop wiring of the mission lane", () => {
  const source = readFileSync(new URL("../src/adapter.ts", import.meta.url), "utf8");

  it("hands the mission lane the goal lane's hold and give back", () => {
    const start = source.indexOf("new MissionLane(");
    expect(start).toBeGreaterThan(0);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toContain("pauseGoalForChat: (chatId) => this.goalLane.pauseForChat(chatId)");
    expect(construction).toContain(
      "resumeGoalForMission: (missionId) => this.goalLane.noteResumed(missionId)",
    );
  });
});
