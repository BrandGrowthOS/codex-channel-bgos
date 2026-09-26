import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { abortCauseOf, abortWith, type AbortCause } from "../src/abort-cause.js";
import { CodexAdapter } from "../src/adapter.js";
import { GoalLane } from "../src/goal-lane.js";
import { MissionControlLane } from "../src/mission-control.js";
import { MissionLane } from "../src/mission-lane.js";
import { StopDiscards } from "../src/stop-discards.js";
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
    missionLane: { noteStopRequested: vi.fn(), stoppedGoalByOwner: vi.fn() },
    // No Keep working goal holds the chat, and no continuation turn runs
    // (D35 has its own cases below).
    goalLane: { missionFor: vi.fn(() => null) },
    adoptedTurns: new Map(),
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
        stoppedGoalByOwner: vi.fn(),
      },
      goalLane: { missionFor: vi.fn(() => null) },
      adoptedTurns: new Map(),
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
    // With the agent, so a restart's first /new can read the chat once.
    expect(adapter.missionLane.clearStopMarker).toHaveBeenCalledWith(20, 10);
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
      // The Stop's own hold: true, the goal was running (D36).
      holdForStop: vi.fn(async (chatId: number) => {
        order.push(`goal held ${chatId}`);
        return true;
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
      pauseGoalForChat: (chatId) => goalLane.holdForStop(chatId),
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
 * A Stop during a Keep working continuation turn (D35, review F1).
 *
 * The runtime starts a continuation turn by itself and the host adopts it
 * outside executeAndReply, so it has no turn controller: before this, the
 * Stop interrupted that one turn and nothing else. No pause, no goal hold,
 * the native goal still active, and the runtime free to start the next
 * continuation, so the mission kept reading On it. Now, when no turn the
 * owner asked for was aborted but Keep working holds the chat, the Stop
 * pauses the goal's mission as D10 pauses a running turn's: the goal held
 * first, THEN the interrupt, and the pause answered before the handler ends.
 * A chat with no goal and no running turn still pauses nothing.
 */
describe("a Stop in a Keep working chat pauses the goal's mission (D35)", () => {
  function goalStopStub(order: string[]) {
    return vi.fn(() => {
      order.push("pause started");
      return {
        held: Promise.resolve().then(() => {
          order.push("goal held");
        }),
        settled: new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push("pause answered");
            resolve();
          }, 10),
        ),
      };
    });
  }

  function keepWorking(adapter: any, order: string[]) {
    adapter.goalLane = { missionFor: vi.fn((chatId: number) => (chatId === 20 ? 701 : null)) };
    adapter.missionLane.stoppedGoalByOwner = goalStopStub(order);
    adapter.host.stopTurn = vi.fn(async () => {
      order.push("interrupt");
    });
  }

  it("the Stop button, with no turn of the owner's running: the goal held, THEN the interrupt, and the pause answered before the handler ends", async () => {
    const { adapter, frame } = fixture();
    const order: string[] = [];
    keepWorking(adapter, order);
    adapter.outbound.sendText = vi.fn(async () => {
      order.push("Stopped.");
      return { id: 1 };
    });

    await adapter.handleControl(frame);

    expect(adapter.missionLane.stoppedGoalByOwner).toHaveBeenCalledTimes(1);
    expect(adapter.missionLane.stoppedGoalByOwner).toHaveBeenCalledWith({
      chatId: 20,
      assistantId: 10,
      missionId: 701,
    });
    expect(order).toEqual(["pause started", "goal held", "interrupt", "Stopped.", "pause answered"]);
    expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
  });

  it("/stop, with no turn of the owner's running: the same pause, the goal held before the interrupt", async () => {
    const { adapter, replyHandle, args } = dispatchFixtureWithout();
    const order: string[] = [];
    keepWorking(adapter, order);
    replyHandle.sendText = vi.fn(async () => {
      order.push("Stopped.");
    });

    await adapter.codexDispatch(args("stop"));

    expect(adapter.missionLane.stoppedGoalByOwner).toHaveBeenCalledWith({
      chatId: 20,
      assistantId: 10,
      missionId: 701,
    });
    expect(order).toEqual(["pause started", "goal held", "interrupt", "Stopped.", "pause answered"]);
    expect(replyHandle.sendText).toHaveBeenCalledWith(STOP_CONFIRMATION_HARD);
  });

  it("a Stop with no goal and no running turn pauses nothing (the Stop between turns row)", async () => {
    const { adapter, frame } = fixture();
    await adapter.handleControl(frame);
    expect(adapter.goalLane.missionFor).toHaveBeenCalledWith(20);
    expect(adapter.missionLane.stoppedGoalByOwner).not.toHaveBeenCalled();

    const dispatch = dispatchFixtureWithout();
    await dispatch.adapter.codexDispatch(dispatch.args("stop"));
    expect(dispatch.adapter.missionLane.stoppedGoalByOwner).not.toHaveBeenCalled();
  });

  it("a Stop that aborts a turn the owner asked for leaves the pause to that turn's unwind (D10)", async () => {
    const { adapter, frame } = fixture(false, true);
    keepWorking(adapter, []);
    await adapter.handleControl(frame);
    expect(adapter.missionLane.stoppedGoalByOwner).not.toHaveBeenCalled();

    const dispatch = dispatchFixture();
    keepWorking(dispatch.adapter, []);
    await dispatch.adapter.codexDispatch(dispatch.args("stop"));
    expect(dispatch.adapter.missionLane.stoppedGoalByOwner).not.toHaveBeenCalled();
  });

  it("/new in a Keep working chat pauses nothing", async () => {
    const { adapter, args } = dispatchFixtureWithout();
    keepWorking(adapter, []);
    await adapter.codexDispatch(args("new"));
    expect(adapter.missionLane.stoppedGoalByOwner).not.toHaveBeenCalled();
  });

  /** /stop's harness with no turn of the owner's running in the chat. */
  function dispatchFixtureWithout() {
    const adapter = Object.create(CodexAdapter.prototype) as any;
    Object.assign(adapter, {
      chatToAssistant: new Map<number, number>(),
      turnControllers: new Map(),
      generations: new Map(),
      lastInput: new Map(),
      lastNativeOptions: new Map(),
      nativeCommands: { handle: vi.fn(async () => false), cancel: vi.fn(() => false) },
      host: { stopTurn: vi.fn(async () => {}), resetChat: vi.fn() },
      missionLane: {
        noteStopRequested: vi.fn(),
        clearStopMarker: vi.fn(async () => {}),
        stoppedGoalByOwner: vi.fn(),
      },
      goalLane: { missionFor: vi.fn(() => null) },
      adoptedTurns: new Map(),
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
    return { adapter, replyHandle, args };
  }

  function dispatchFixture() {
    const made = dispatchFixtureWithout();
    made.adapter.turnControllers = new Map([[20, new Set([new AbortController()])]]);
    return made;
  }

  /**
   * End to end, with the real mission lane and a real adopted continuation
   * turn: the failure the review found, step by step. The owner armed Keep
   * working, the runtime started a continuation turn on its own, and the
   * owner pressed Stop.
   */
  function continuationFixture() {
    const order: string[] = [];
    let paused = false;
    const mission = () => ({
      id: 701,
      assistantId: 10,
      chatId: 20,
      title: "Make the page load in under two seconds",
      status: paused ? "paused" : "active",
      origin: "derived",
      progress: null,
      keepWorking: true,
      pausedReason: paused ? STOP_PAUSE_REASON : null,
    });
    const api = {
      getActiveMission: vi.fn(async () => mission()),
      pauseMission: vi.fn(async (_a: number, id: number, body: { reason?: string }) => {
        order.push(`PATCH pause ${id} "${body.reason}"`);
        paused = true;
        return mission();
      }),
      resumeMission: vi.fn(async (_a: number, id: number) => {
        order.push(`PATCH resume ${id}`);
        paused = false;
        return mission();
      }),
      failMission: vi.fn(async () => {
        order.push("PATCH fail");
      }),
      completeMission: vi.fn(async () => {
        order.push("PATCH complete");
      }),
      setStatus: vi.fn(async () => {}),
      postVoiceRpcAck: vi.fn(async () => {}),
      postVoiceRpcResult: vi.fn(async () => {}),
    };
    const goalLane = {
      owns: (chatId: number) => chatId === 20,
      missionFor: (chatId: number) => (chatId === 20 ? 701 : null),
      noteTurnStarted: vi.fn(),
      noteTurnFinished: vi.fn(async () => {}),
      // The Stop's own hold: true, the goal was running (D36).
      holdForStop: vi.fn(async (chatId: number) => {
        order.push(`goal held ${chatId}`);
        return true;
      }),
      noteResumed: vi.fn(async (missionId: number) => {
        order.push(`goal given back ${missionId}`);
      }),
    };
    const { adapter, frame } = fixture();
    adapter.ownerId = "owner-1";
    adapter.chatToAssistant.set(20, 10);
    adapter.api = api;
    adapter.goalLane = goalLane;
    adapter.missionLane = new MissionLane(api as never, {
      goalOwnsChat: (chatId) => goalLane.owns(chatId),
      pauseGoalForChat: (chatId) => goalLane.holdForStop(chatId),
      resumeGoalForMission: (missionId) => goalLane.noteResumed(missionId),
      onSelfWrite: (missionId) => order.push(`stamp ${missionId}`),
    });
    adapter.missionControl = { applyBulletin: (_chatId: number, input: unknown) => input };
    adapter.tools = { handleRequest: vi.fn(async () => ({})) };
    adapter.toolProgress = {
      sendToolStart: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
      noteTurnMeta: vi.fn(),
    };
    adapter.outbound.sendAgentError = vi.fn(async () => {});
    adapter.host.stopTurn = vi.fn(async () => {
      order.push("interrupt");
    });
    return { adapter, frame, api, goalLane, order };
  }

  it("end to end: the Stop pauses the goal's mission and holds the goal before it interrupts; the interrupted turn is not a reply or an error; Resume puts both back", async () => {
    const { adapter, frame, api, goalLane, order } = continuationFixture();
    const continuation = adapter.adoptGoalTurn(20)!;
    expect(continuation).not.toBeNull();

    await adapter.handleControl(frame);

    expect(order).toContain(`PATCH pause 701 "${STOP_PAUSE_REASON}"`);
    expect(order.indexOf("stamp 701")).toBeLessThan(order.indexOf(`PATCH pause 701 "${STOP_PAUSE_REASON}"`));
    expect(order.indexOf("goal held 20")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("goal held 20")).toBeLessThan(order.indexOf("interrupt"));
    expect(api.failMission).not.toHaveBeenCalled();

    // The runtime reports the interrupted continuation turn back.
    await continuation.deliver({
      replyText: "I measured the page and started on the",
      finalAgentMessageText: "I measured the page and started on the",
      turnCompleted: false,
      error: "Stopped by you.",
      threadId: "thread-20",
    });
    // "Stopped." once, and nothing else: no half sentence, no red error.
    expect(adapter.outbound.sendText).toHaveBeenCalledTimes(1);
    expect(adapter.outbound.sendText).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      text: STOP_CONFIRMATION_HARD,
    });
    expect(adapter.outbound.sendAgentError).not.toHaveBeenCalled();
    // The goal lane still counts the turn it started.
    expect(goalLane.noteTurnFinished).toHaveBeenCalledWith(20, {
      text: "I measured the page and started on the",
      error: "Stopped by you.",
    });

    // The owner presses Resume: an ordinary owner message.
    adapter.host.runTurn = vi.fn(async () => ({
      error: null,
      replyText: "Picking up from the images.",
      turnCompleted: true,
      finalAgentMessageText: "Picking up from the images.",
    }));
    const reply = {
      sendTyping: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
    };
    await adapter.executeAndReply(10, 20, RESUME_TURN_TEXT, reply, {
      userId: "owner-1",
      senderType: "user",
      messageId: 6,
    });
    expect(order.slice(-3)).toEqual(["stamp 701", "PATCH resume 701", "goal given back 701"]);
    expect(api.failMission).not.toHaveBeenCalled();
  });

  it("a continuation turn that finished before the Stop reached it still delivers its reply", async () => {
    const { adapter, frame } = continuationFixture();
    const continuation = adapter.adoptGoalTurn(20)!;
    await adapter.handleControl(frame);

    await continuation.deliver({
      replyText: "The page now loads in 1.8 seconds.",
      finalAgentMessageText: "The page now loads in 1.8 seconds.",
      turnCompleted: true,
      error: null,
      threadId: "thread-20",
    });
    expect(adapter.outbound.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 20, text: "The page now loads in 1.8 seconds." }),
    );
  });

  it("a continuation turn with no Stop still shows a real error as an error", async () => {
    const { adapter } = continuationFixture();
    const continuation = adapter.adoptGoalTurn(20)!;
    await continuation.deliver({
      replyText: "",
      finalAgentMessageText: "",
      turnCompleted: false,
      error: "Codex could not finish the turn.",
      threadId: "thread-20",
    });
    expect(adapter.outbound.sendAgentError).toHaveBeenCalledWith({
      assistantId: 10,
      chatId: 20,
      reason: "Codex could not finish the turn.",
    });
  });
});

/**
 * A Stop resume gives the goal back only if the goal was running when the
 * Stop came (D36, found by the Codex review fix lane).
 *
 * End to end with the REAL goal lane, mission lane and mission control lane,
 * and with each mission frame delivered from inside the request that caused
 * it, as the gateway does, so the mission_resumed echo reaches the goal lane
 * exactly as it would live. The failure: a goal that had stopped itself at
 * its turn cap or for lack of progress (the goal held, the mission still
 * open), or that the owner held with /goal pause, got a typed /stop, and the
 * owner's next message handed the goal back and restarted the loop past its
 * own cap. Now the mission resumes, the goal stays held, and the message runs
 * as an ordinary turn. A goal that WAS running is still given back.
 */
describe("a Stop resume gives the goal back only if it was running (D36)", () => {
  const OBJECTIVE = "the page loads in under two seconds";

  /**
   * `keptFile` is the goal lane's record of a Stop that found the goal NOT
   * running (review F1). Each process reads it afresh, so `restart()` is a
   * daemon coming back: new lanes, nothing in memory, the same server and the
   * same runtime.
   */
  function realLanesFixture(keptFile?: string) {
    const { adapter, frame } = fixture();
    let status: "active" | "paused" = "active";
    let pausedReason: string | null = null;
    const snapshot = () => ({
      id: 701,
      assistantId: 10,
      chatId: 20,
      title: "Make the page load in under two seconds",
      doneWhen: OBJECTIVE,
      status,
      origin: "derived",
      progress: null,
      keepWorking: true,
      turnCap: 1,
      pausedReason,
    });
    const echo = (eventType: "mission_paused" | "mission_resumed") =>
      adapter.missionControl.handle({
        eventType,
        userId: "owner-1",
        assistantId: 10,
        chatId: 20,
        mission: snapshot(),
        timestamp: "",
      });
    const api = {
      getActiveMission: vi.fn(async () => snapshot()),
      pauseMission: vi.fn(async (_a: number, _id: number, body: { reason?: string }) => {
        status = "paused";
        pausedReason = body.reason ?? null;
        // The gateway emits the frame from inside the request.
        await echo("mission_paused");
        return snapshot();
      }),
      resumeMission: vi.fn(async () => {
        status = "active";
        pausedReason = null;
        await echo("mission_resumed");
        return snapshot();
      }),
      failMission: vi.fn(async () => {}),
      completeMission: vi.fn(async () => {}),
      createMission: vi.fn(async () => snapshot()),
      patchMissionProgress: vi.fn(async () => snapshot()),
      postMissionStopped: vi.fn(async () => snapshot()),
      postVoiceRpcAck: vi.fn(async () => {}),
      postVoiceRpcResult: vi.fn(async () => {}),
    };
    // The runtime's own goal for chat 20, as the app server keeps it.
    const runtime = { status: "none" as string, starts: 0 };
    const goalHost = {
      setGoal: vi.fn(
        async (_chatId: number, _objective: string | null, opts: { status?: string } = {}) => {
          runtime.status = opts.status ?? (runtime.status === "none" ? "active" : runtime.status);
          if (opts.status === "active") runtime.starts += 1;
          return null;
        },
      ),
      clearGoal: vi.fn(async () => true),
      hasThread: () => true,
    };
    /** One daemon process's lanes, wired into the adapter. */
    const lanes = (): GoalLane => {
      const goalLane = new GoalLane({
        api: api as never,
        host: goalHost,
        onSelfWrite: (missionId) => adapter.missionControl.noteSelfWrite(missionId),
        log: () => {},
        ...(keptFile ? { keptByStop: new StopDiscards(keptFile) } : {}),
      });
      // Built with the adapter's own wiring of these options (pinned below).
      const missionLane = new MissionLane(api as never, {
        onSelfWrite: (missionId) => adapter.missionControl.noteSelfWrite(missionId),
        goalOwnsChat: (chatId) => goalLane.owns(chatId),
        pauseGoalForChat: (chatId) => goalLane.holdForStop(chatId),
        resumeGoalForMission: (missionId) => goalLane.noteResumed(missionId),
      });
      Object.assign(adapter, {
        goalLane,
        missionLane,
        missionControl: new MissionControlLane({
          host: { steer: vi.fn(async () => {}) },
          missionLane,
          goalLane,
          noteChat: () => {},
          chatsForAssistant: () => [20],
          isOwned: (assistantId) => assistantId === 10,
          log: () => {},
        }),
      });
      return goalLane;
    };
    const goalLane = lanes();
    Object.assign(adapter, {
      ownerId: "owner-1",
      api,
      // What /stop needs beyond the Stop button's harness.
      lastInput: new Map(),
      lastNativeOptions: new Map(),
      nativeCommands: { handle: vi.fn(async () => false), cancel: vi.fn(() => false) },
      tools: { handleRequest: vi.fn(async () => ({})) },
      toolProgress: {
        sendToolStart: vi.fn(async () => {}),
        finalizeTurn: vi.fn(async () => {}),
        noteTurnMeta: vi.fn(),
      },
    });
    adapter.chatToAssistant.set(20, 10);
    adapter.outbound.sendAgentError = vi.fn(async () => {});
    adapter.host.resetChat = vi.fn();
    adapter.host.runTurn = vi.fn(async () => ({
      error: null,
      replyText: "It measured 2.4 seconds before you stopped it.",
      turnCompleted: true,
      finalAgentMessageText: "It measured 2.4 seconds before you stopped it.",
    }));
    const armed = () =>
      goalLane.armFromMission({
        assistantId: 10,
        chatId: 20,
        missionId: 701,
        objective: OBJECTIVE,
        turnCap: 1,
      });
    const stopTyped = () =>
      adapter.codexDispatch({
        origin: "bgos",
        agentRoute: "codex",
        assistantId: 10,
        chatId: 20,
        messageId: 5,
        userId: "owner-1",
        text: "/stop",
        attachments: [],
        systemPrompt: "",
        replyHandle: { sendText: vi.fn(async () => {}) },
        command: { name: "stop", args: "" },
        messageType: "slash_command",
        senderType: "user",
      });
    const reply = {
      sendTyping: vi.fn(async () => {}),
      finalizeTurn: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
    };
    const ownerWrites = () =>
      adapter.executeAndReply(10, 20, "How far did it get?", reply, {
        userId: "owner-1",
        senderType: "user",
        messageId: 6,
      });
    return {
      adapter,
      frame,
      api,
      goalLane,
      runtime,
      armed,
      stopTyped,
      ownerWrites,
      restart: lanes,
      state: () => ({ status, pausedReason }),
    };
  }

  type Fixture = ReturnType<typeof realLanesFixture>;

  it.each([
    [
      "held at its turn cap",
      async (f: Fixture) => {
        await f.armed();
        f.goalLane.noteTurnStarted(20);
        await f.goalLane.noteTurnFinished(20, { text: "Measured it at 2.4 seconds." });
      },
    ],
    [
      "stopped for lack of progress",
      async (f: Fixture) => {
        await f.armed();
        f.runtime.status = "blocked";
        await f.goalLane.handleGoalUpdate(20, {
          threadId: "thread-20",
          objective: OBJECTIVE,
          status: "blocked",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1789932968,
          updatedAt: 1789932999,
        });
      },
    ],
    [
      "held by the owner with /goal pause",
      async (f: Fixture) => {
        await f.armed();
        await f.goalLane.pauseForChat(20);
      },
    ],
  ])(
    "a goal %s: /stop pauses the mission, the owner's next message resumes it and runs as an ordinary turn, and the goal stays held",
    async (_why, standDown) => {
      const f = realLanesFixture();
      await standDown(f);
      expect(f.runtime.status).not.toBe("active");
      const startsBefore = f.runtime.starts;

      await f.stopTyped();
      expect(f.state()).toEqual({ status: "paused", pausedReason: STOP_PAUSE_REASON });

      await f.ownerWrites();

      // The mission the Stop paused is resumed, once, and never failed.
      expect(f.api.resumeMission).toHaveBeenCalledTimes(1);
      expect(f.state()).toEqual({ status: "active", pausedReason: null });
      expect(f.api.failMission).not.toHaveBeenCalled();
      // The goal stays where it had stood down: nothing started it again,
      // through the give back or through the mission_resumed echo.
      expect(f.runtime.status).toBe("paused");
      expect(f.runtime.starts).toBe(startsBefore);
      expect(f.goalLane.owns(20)).toBe(true);
      // And the owner's message is an ordinary turn, answered.
      expect(f.adapter.host.runTurn).toHaveBeenCalledTimes(1);
    },
  );

  it("a goal that WAS running: the Stop button holds it, and the owner's next message gives it back", async () => {
    const f = realLanesFixture();
    await f.armed();
    expect(f.runtime.status).toBe("active");

    await f.adapter.handleControl(f.frame);
    expect(f.runtime.status).toBe("paused");
    expect(f.state()).toEqual({ status: "paused", pausedReason: STOP_PAUSE_REASON });

    await f.ownerWrites();

    expect(f.api.resumeMission).toHaveBeenCalledTimes(1);
    expect(f.state()).toEqual({ status: "active", pausedReason: null });
    expect(f.runtime.status).toBe("active");
    expect(f.adapter.host.runTurn).toHaveBeenCalledTimes(1);
  });

  /**
   * Review F1: a daemon restart between the Stop and the owner's next
   * message. The runtime keeps the goal, held, and the server keeps the
   * pause; the new process keeps nothing but what is on disk. Its first
   * owner turn resumes the Stop pause (D12), and the mission_resumed echo
   * used to take the goal back from its frame and start it.
   */
  describe("across a daemon restart between the Stop and the owner's next message (review F1)", () => {
    let dir: string;
    const kept = () => join(dir, "goal-kept-by-stop.json");
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "hoai-goal-kept-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("a goal held with /goal pause: the message resumes the mission, runs as an ordinary turn, and the goal stays held", async () => {
      const f = realLanesFixture(kept());
      await f.armed();
      await f.goalLane.pauseForChat(20);
      const startsBefore = f.runtime.starts;
      await f.stopTyped();
      expect(f.state()).toEqual({ status: "paused", pausedReason: STOP_PAUSE_REASON });

      f.restart();
      expect(f.adapter.goalLane.owns(20)).toBe(false);
      await f.ownerWrites();

      expect(f.api.resumeMission).toHaveBeenCalledTimes(1);
      expect(f.state()).toEqual({ status: "active", pausedReason: null });
      expect(f.api.failMission).not.toHaveBeenCalled();
      expect(f.runtime.status).toBe("paused");
      expect(f.runtime.starts).toBe(startsBefore);
      expect(f.adapter.host.runTurn).toHaveBeenCalledTimes(1);
    });

    it("a goal that WAS running: the Stop button holds it, and after the restart the message still gives it back", async () => {
      const f = realLanesFixture(kept());
      await f.armed();
      await f.adapter.handleControl(f.frame);
      expect(f.runtime.status).toBe("paused");

      f.restart();
      await f.ownerWrites();

      expect(f.state()).toEqual({ status: "active", pausedReason: null });
      expect(f.runtime.status).toBe("active");
      expect(f.adapter.host.runTurn).toHaveBeenCalledTimes(1);
    });
  });

  it("a goal held at its cap: the Stop button the same, the goal stays held", async () => {
    const f = realLanesFixture();
    await f.armed();
    f.goalLane.noteTurnStarted(20);
    await f.goalLane.noteTurnFinished(20, { text: "Measured it at 2.4 seconds." });
    const startsBefore = f.runtime.starts;

    await f.adapter.handleControl(f.frame);
    await f.ownerWrites();

    expect(f.api.resumeMission).toHaveBeenCalledTimes(1);
    expect(f.runtime.status).toBe("paused");
    expect(f.runtime.starts).toBe(startsBefore);
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
    // The Stop's own hold, never the owner's /goal pause door: only it
    // records whether the goal was running, which the give back reads (D36).
    expect(construction).toContain("pauseGoalForChat: (chatId) => this.goalLane.holdForStop(chatId)");
    expect(construction).toContain(
      "resumeGoalForMission: (missionId) => this.goalLane.noteResumed(missionId)",
    );
  });

  it("hands the mission lane the discards file, so a /new outlives a restart (review F4)", () => {
    const start = source.indexOf("new MissionLane(");
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toMatch(/stopDiscards: new StopDiscards\(\s*join\(/);
    expect(construction).toContain('"stop-discards.json"');
  });

  it("hands the goal lane its kept file, so a Stop's D36 record outlives a restart (review F1)", () => {
    const start = source.indexOf("new GoalLane(");
    expect(start).toBeGreaterThan(0);
    const construction = source.slice(start, source.indexOf("});", start));
    expect(construction).toMatch(/keptByStop: new StopDiscards\(\s*join\(/);
    expect(construction).toContain('"goal-kept-by-stop.json"');
  });
});
