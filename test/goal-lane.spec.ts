/**
 * The native goal lane (mission program stage 6).
 *
 * Every case here turns on one honesty rule and one ordering rule.
 *
 * The honesty rule: Codex has no separate judge, so this lane reports what
 * its runtime counted and NOTHING it did not. It never writes a checked feed
 * entry, never sends a verdict, and never fails a mission because the runtime
 * stopped: a stop is something the owner decides about, which is Needs you,
 * not Did not finish.
 *
 * The ordering rule: `thread/goal/set` starts a turn at once (the feasibility
 * gate watched it happen three times), so the lane is armed BEFORE the goal
 * is set. Set first and the first turn of the owner's own goal arrives for a
 * chat nothing is watching, and the whole of it is dropped on the floor.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import { GoalLane, GOAL_DEFAULT_TURN_CAP, formatGoalSeconds, goalStatusWord } from "../src/goal-lane.js";
import type { GoalFrameContext } from "../src/goal-lane.js";
import type { ThreadGoal, ThreadGoalStatus } from "../src/goal-protocol.js";
import { StopDiscards } from "../src/stop-discards.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function missionBody(id: number, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    mission: {
      id,
      assistantId: 7,
      title: "the sign up page loads in under 2 seconds",
      status: "active",
      origin: "derived",
      progress: null,
      chatId: 42,
      ...extra,
    },
  };
}

describe("GoalLane", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await server.stop();
  });

  /**
   * A host that holds one goal per chat, the way the app server holds one per
   * thread, so "the objective survives a pause" is a real assertion and not a
   * spy call count.
   */
  function makeHost() {
    const goals = new Map<number, ThreadGoal>();
    const order: string[] = [];
    const armedAtSet: boolean[] = [];
    // The chats this runtime already has a thread for. `threads.json` keeps
    // these across a restart, and a goal can only live on one, so a control
    // that finds no thread has nothing to act on and must never make one.
    const threads = new Set<number>();
    const host = {
      goals,
      order,
      armedAtSet,
      threads,
      hasThread: vi.fn((chatId: number) => threads.has(chatId)),
      setGoal: vi.fn(
        async (
          chatId: number,
          objective: string | null,
          opts: { status?: ThreadGoalStatus } = {},
        ) => {
          order.push(`set:${chatId}`);
          const previous = goals.get(chatId) ?? null;
          const goal: ThreadGoal = {
            threadId: `thread-${chatId}`,
            objective: objective ?? previous?.objective ?? "",
            status: opts.status ?? previous?.status ?? "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
            createdAt: 1789932968,
            updatedAt: 1789932999,
          };
          goals.set(chatId, goal);
          return goal;
        },
      ),
      clearGoal: vi.fn(async (chatId: number) => {
        order.push(`clear:${chatId}`);
        return goals.delete(chatId);
      }),
    };
    return host;
  }

  function makeLane(host = makeHost(), extra: Record<string, unknown> = {}) {
    const selfWrites: number[] = [];
    const lane = new GoalLane({
      api: makeApi(baseUrl),
      host,
      onSelfWrite: (missionId) => selfWrites.push(missionId),
      log: () => {},
      ...extra,
    });
    // Recorded at the moment the host is asked to set the goal, which is the
    // only place the arm before set rule can be observed.
    host.setGoal.mockImplementation(
      (async (chatId: number, objective: string | null, opts: { status?: ThreadGoalStatus } = {}) => {
        host.armedAtSet.push(lane.owns(chatId));
        host.order.push(`set:${chatId}`);
        const previous = host.goals.get(chatId) ?? null;
        const goal: ThreadGoal = {
          threadId: `thread-${chatId}`,
          objective: objective ?? previous?.objective ?? "",
          status: opts.status ?? previous?.status ?? "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
          createdAt: 1789932968,
          updatedAt: 1789932999,
        };
        host.goals.set(chatId, goal);
        return goal;
      }) as never,
    );
    return { lane, host, selfWrites };
  }

  const CONDITION = "the sign up page loads in under 2 seconds";

  function liveGoal(patch: Partial<ThreadGoal> = {}): ThreadGoal {
    return {
      threadId: "thread-42",
      objective: CONDITION,
      status: "active",
      tokenBudget: null,
      tokensUsed: 120,
      timeUsedSeconds: 1140,
      createdAt: 1789932968,
      updatedAt: 1789932999,
      ...patch,
    };
  }

  async function armed(lane: GoalLane, turnCap: number | null = 20) {
    await lane.armFromMission({
      assistantId: 7,
      chatId: 42,
      missionId: 101,
      objective: CONDITION,
      turnCap,
    });
  }

  it("creates a derived mission whose Done when IS the condition", async () => {
    server.stage("POST", "/api/v1/integrations/assistants/7/missions", 201, missionBody(101));
    const { lane, host } = makeLane();

    await lane.setFromChat({ assistantId: 7, chatId: 42, objective: CONDITION });

    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /api/v1/integrations/assistants/7/missions",
    ]);
    expect(server.requests[0]!.body).toEqual({
      title: CONDITION,
      doneWhen: CONDITION,
      chatId: 42,
      origin: "derived",
      firstFeedText: "Working toward this until it holds",
      // The loop IS running, with this cap, from the moment the goal is set.
      // A create that said nothing left the card drawing the Keep working
      // switch OFF and naming no limit for work already under way.
      keepWorking: true,
      turnCap: GOAL_DEFAULT_TURN_CAP,
    });
    expect(host.goals.get(42)!.objective).toBe(CONDITION);
    expect(lane.owns(42)).toBe(true);
  });

  it("arms BEFORE the goal is set, because a set starts a turn at once", async () => {
    server.stage("POST", "/api/v1/integrations/assistants/7/missions", 201, missionBody(101));
    const { lane, host } = makeLane();

    // Both doors, the typed /goal and the owner's own Keep working mission,
    // on two different chats so neither can be armed by the other.
    await lane.setFromChat({ assistantId: 7, chatId: 42, objective: CONDITION });
    await lane.armFromMission({
      assistantId: 7,
      chatId: 43,
      missionId: 102,
      objective: CONDITION,
      turnCap: 20,
    });

    expect(host.armedAtSet).toEqual([true, true]);
  });

  it("writes ONE run report per finished turn, and never a check and never a verdict", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    const { lane } = makeLane();
    await armed(lane);
    await lane.handleGoalUpdate(42, liveGoal());

    lane.noteTurnStarted(42);
    await lane.noteTurnFinished(42, { text: "Fixed the image sizes, the page is at 2.4 seconds" });

    const patch = server.requests.at(-1)!;
    expect(patch.url).toBe("/api/v1/integrations/assistants/7/missions/101/progress");
    expect(patch.body).toEqual({
      runReport: { turnsUsed: 1, turnCap: 20, workingMs: 1_140_000 },
      feedEntry: {
        kind: "worked",
        text: "Fixed the image sizes, the page is at 2.4 seconds",
      },
    });
    const wire = JSON.stringify(patch.body);
    expect(wire).not.toContain("checked");
    expect(wire).not.toContain("verdict");
  });

  it("sends no working time at all until the runtime has counted some", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    const { lane } = makeLane();
    await armed(lane);

    lane.noteTurnStarted(42);
    await lane.noteTurnFinished(42, {});

    expect(server.requests.at(-1)!.body).toEqual({
      runReport: { turnsUsed: 1, turnCap: 20 },
    });
  });

  it("PAUSES the goal at the cap and reports the stop, leaving the mission open", async () => {
    for (let i = 0; i < 2; i += 1)
      server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    server.stage("POST", "/api/v1/integrations/assistants/7/missions/101/stopped", 200, missionBody(101));
    const { lane, host } = makeLane();
    await armed(lane, 2);
    await lane.handleGoalUpdate(42, liveGoal());

    for (let i = 0; i < 2; i += 1) {
      lane.noteTurnStarted(42);
      await lane.noteTurnFinished(42, { text: `turn ${i}` });
    }

    expect(host.goals.get(42)!.status).toBe("paused");
    // The objective is still there, which is the whole reason the cap pauses
    // rather than clears: nothing has to be remembered and typed again.
    expect(host.goals.get(42)!.objective).toBe(CONDITION);
    const stopped = server.requests.at(-1)!;
    expect(stopped.method).toBe("POST");
    expect(stopped.url).toBe("/api/v1/integrations/assistants/7/missions/101/stopped");
    expect(stopped.body).toEqual({
      kind: "turn_cap",
      text: "Paused at 2 turns. The goal is kept, so more turns start it again.",
    });
  });

  it("reports the cap stop once, however many turns follow it", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    server.stage("POST", "/api/v1/integrations/assistants/7/missions/101/stopped", 200, missionBody(101));
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    const { lane } = makeLane();
    await armed(lane, 1);

    for (let i = 0; i < 2; i += 1) {
      lane.noteTurnStarted(42);
      await lane.noteTurnFinished(42, {});
    }

    const stops = server.requests.filter((r) => r.url.endsWith("/stopped"));
    expect(stops).toHaveLength(1);
  });

  it("a raised cap starts the same goal again, with its objective untouched", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    server.stage("POST", "/api/v1/integrations/assistants/7/missions/101/stopped", 200, missionBody(101));
    const { lane, host } = makeLane();
    await armed(lane, 1);
    lane.noteTurnStarted(42);
    await lane.noteTurnFinished(42, {});
    expect(host.goals.get(42)!.status).toBe("paused");

    await lane.noteUpdated({ missionId: 101, keepWorking: true, turnCap: 11 });

    expect(host.goals.get(42)!.status).toBe("active");
    expect(host.goals.get(42)!.objective).toBe(CONDITION);
    // The cap the owner just raised is the one the next run report carries.
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    lane.noteTurnStarted(42);
    await lane.noteTurnFinished(42, {});
    expect((server.requests.at(-1)!.body as { runReport: unknown }).runReport).toEqual({
      turnsUsed: 2,
      turnCap: 11,
    });
  });

  it("a mission_updated that raises nothing leaves a paused goal paused", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    server.stage("POST", "/api/v1/integrations/assistants/7/missions/101/stopped", 200, missionBody(101));
    const { lane, host } = makeLane();
    await armed(lane, 1);
    lane.noteTurnStarted(42);
    await lane.noteTurnFinished(42, {});

    await lane.noteUpdated({ missionId: 101, keepWorking: true, turnCap: 1 });

    expect(host.goals.get(42)!.status).toBe("paused");
  });

  it("a stalled goal reports a stop and NEVER a failed mission", async () => {
    server.stage("POST", "/api/v1/integrations/assistants/7/missions/101/stopped", 200, missionBody(101));
    const { lane } = makeLane();
    await armed(lane);

    await lane.handleGoalUpdate(42, liveGoal({ status: "blocked" }));

    const calls = server.requests.map((r) => `${r.method} ${r.url}`);
    expect(calls).toEqual([
      "POST /api/v1/integrations/assistants/7/missions/101/stopped",
    ]);
    expect(server.requests[0]!.body).toEqual({
      kind: "no_progress",
      text: "Stopped after three turns in a row that hit the same obstacle.",
    });
    expect(calls.some((c) => c.endsWith("/fail"))).toBe(false);
  });

  it("completes the mission as the agent's own word, with the run report and no verdict", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/complete", 200, missionBody(101, { status: "completed" }));
    const { lane, selfWrites } = makeLane();
    await armed(lane);
    lane.noteTurnStarted(42);

    await lane.handleGoalUpdate(42, liveGoal({ status: "complete" }));

    const complete = server.requests.at(-1)!;
    expect(complete.url).toBe("/api/v1/integrations/assistants/7/missions/101/complete");
    expect(complete.body).toEqual({
      runReport: { turnsUsed: 1, turnCap: 20, workingMs: 1_140_000 },
    });
    expect(JSON.stringify(complete.body)).not.toContain("verdict");
    // Stamped BEFORE the write, or the daemon's own completion comes back
    // looking like the owner marking the mission done.
    expect(selfWrites).toEqual([101]);
    expect(lane.owns(42)).toBe(false);
  });

  it("forgets a cleared goal locally and never abandons the mission", async () => {
    const { lane } = makeLane();
    await armed(lane);

    await lane.handleGoalUpdate(42, null);

    expect(lane.owns(42)).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it("does nothing at all when the runtime is waiting on the owner's plan", async () => {
    const { lane } = makeLane();
    await armed(lane);

    await lane.handleGoalUpdate(42, liveGoal({ status: "usageLimited" }));
    await lane.handleGoalUpdate(42, liveGoal({ status: "budgetLimited" }));

    expect(server.requests).toHaveLength(0);
    expect(lane.owns(42)).toBe(true);
  });

  it("clears the native goal when the owner closes the mission in the app", async () => {
    const { lane, host } = makeLane();
    await armed(lane);

    await lane.noteClosed(101);

    expect(host.clearGoal).toHaveBeenCalledWith(42);
    expect(lane.owns(42)).toBe(false);
  });

  it("holds and restarts the goal on the owner's Pause and Resume", async () => {
    const { lane, host } = makeLane();
    await armed(lane);

    await lane.notePaused(101);
    expect(host.goals.get(42)!.status).toBe("paused");
    await lane.noteResumed(101);
    expect(host.goals.get(42)!.status).toBe("active");
    expect(host.goals.get(42)!.objective).toBe(CONDITION);
  });

  /**
   * An owner Stop in a Keep working chat holds the goal, and the owner's next
   * turn resumes the mission and gives the goal back (P6 stage 3, D35). D36:
   * only a goal that was RUNNING when the Stop came is given back. One that
   * had already stood down, at its turn cap, for lack of progress, or because
   * the owner held it with /goal pause, stays held through the resume that
   * follows the Stop, from both of its doors: the mission lane's give back
   * and the mission_resumed echo. Starting it there would run a loop the
   * owner's Resume never asked for, past its own cap.
   */
  describe("a Stop gives the goal back only if it was running (D36)", () => {
    const frame: GoalFrameContext = {
      assistantId: 7,
      chatId: 42,
      objective: CONDITION,
      turnCap: 1,
      keepWorking: true,
    };

    /** The resume that follows the Stop, through both of its doors. */
    async function resumeAfterStop(lane: GoalLane) {
      // The mission lane's give back, on the owner's next turn.
      await lane.noteResumed(101);
      // The mission_resumed echo of that same resume.
      await lane.noteResumed(101, frame);
    }

    /** Every time anything asked the runtime to start the goal again. */
    function starts(host: ReturnType<typeof makeHost>): number {
      return host.setGoal.mock.calls.filter(
        (call) => (call[2] as { status?: string } | undefined)?.status === "active",
      ).length;
    }

    it("a running goal: the Stop says it was running, and the resume starts it again", async () => {
      const { lane, host } = makeLane();
      await armed(lane);

      await expect(lane.holdForStop(42)).resolves.toBe(true);
      expect(host.goals.get(42)!.status).toBe("paused");

      await resumeAfterStop(lane);
      expect(host.goals.get(42)!.status).toBe("active");
      expect(host.goals.get(42)!.objective).toBe(CONDITION);
    });

    it("a goal held at its cap stays held through the resume, and more turns still start it", async () => {
      server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
      server.stage("POST", "/api/v1/integrations/assistants/7/missions/101/stopped", 200, missionBody(101));
      const { lane, host } = makeLane();
      await armed(lane, 1);
      lane.noteTurnStarted(42);
      await lane.noteTurnFinished(42, {});
      expect(host.goals.get(42)!.status).toBe("paused");

      await expect(lane.holdForStop(42)).resolves.toBe(false);
      await resumeAfterStop(lane);

      expect(host.goals.get(42)!.status).toBe("paused");
      expect(starts(host)).toBe(0);
      // Still this lane's goal, for the owner's own answer to the stop.
      expect(lane.owns(42)).toBe(true);
      await lane.noteUpdated({ missionId: 101, keepWorking: true, turnCap: 11 });
      expect(host.goals.get(42)!.status).toBe("active");
    });

    it("a goal that stopped for lack of progress stays held through the resume", async () => {
      server.stage("POST", "/api/v1/integrations/assistants/7/missions/101/stopped", 200, missionBody(101));
      const { lane, host } = makeLane();
      await armed(lane);
      // The runtime's own rule: three turns in a row on the same obstacle.
      host.goals.set(42, liveGoal({ status: "blocked" }));
      await lane.handleGoalUpdate(42, liveGoal({ status: "blocked" }));

      await expect(lane.holdForStop(42)).resolves.toBe(false);
      await resumeAfterStop(lane);

      expect(host.goals.get(42)!.status).toBe("paused");
      expect(starts(host)).toBe(0);
    });

    it("a goal the owner held with /goal pause stays held through the resume, and /goal resume still starts it", async () => {
      const { lane, host } = makeLane();
      await armed(lane);
      // What /goal pause calls.
      await lane.pauseForChat(42);

      await expect(lane.holdForStop(42)).resolves.toBe(false);
      await resumeAfterStop(lane);

      expect(host.goals.get(42)!.status).toBe("paused");
      expect(starts(host)).toBe(0);
      // What /goal resume calls: the owner starting it again, which is theirs.
      await lane.resumeForChat(42);
      expect(host.goals.get(42)!.status).toBe("active");
    });

    it("the Stop's own hold and its mission_paused echo are not the owner's: a second Stop still finds the goal running", async () => {
      const { lane, host } = makeLane();
      await armed(lane);
      await lane.holdForStop(42);
      // The echo of the Stop's own pause, which reaches the lane as a Pause.
      await lane.notePaused(101, frame);

      await expect(lane.holdForStop(42)).resolves.toBe(true);
      await resumeAfterStop(lane);
      expect(host.goals.get(42)!.status).toBe("active");
    });

    /**
     * Review F1: the record of a Stop that found the goal NOT running lived
     * in memory only. A daemon restart between the Stop and the owner's next
     * message emptied it, the mission lane's first owner turn resumed the
     * Stop pause (D12), and the mission_resumed echo took the goal back from
     * its frame and started it: the loop the owner had held with /goal pause
     * ran again. The record is kept on disk, per chat, and read by the
     * process that comes back.
     */
    describe("across a daemon restart between the Stop and the resume (review F1)", () => {
      let dir: string;
      let file: string;

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "hoai-goal-kept-"));
        file = join(dir, "goal-kept-by-stop.json");
      });
      afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      /** One daemon process: its own lane, reading the record from disk. */
      function daemon(host: ReturnType<typeof makeHost>): GoalLane {
        return makeLane(host, { keptByStop: new StopDiscards(file) }).lane;
      }

      /** The runtime keeps the goal and its thread; the process keeps nothing. */
      async function heldThenStopped(): Promise<ReturnType<typeof makeHost>> {
        const host = makeHost();
        host.threads.add(42);
        const before = daemon(host);
        await armed(before);
        // What /goal pause calls. It writes nothing to the server, so the
        // mission's frame still says Keep working after the restart.
        await before.pauseForChat(42);
        await expect(before.holdForStop(42)).resolves.toBe(false);
        return host;
      }

      it("a goal the owner held with /goal pause stays held after the restart, through both doors", async () => {
        const host = await heldThenStopped();

        const after = daemon(host);
        expect(after.owns(42)).toBe(false);
        await resumeAfterStop(after);

        expect(host.goals.get(42)!.status).toBe("paused");
        expect(host.goals.get(42)!.objective).toBe(CONDITION);
        expect(starts(host)).toBe(0);
      });

      it("the owner's own answers still start it after the restart: /goal resume, and more turns", async () => {
        const host = await heldThenStopped();
        const after = daemon(host);
        await resumeAfterStop(after);
        expect(starts(host)).toBe(0);

        // /goal resume: the owner starting the loop again, which is theirs.
        await after.resumeForChat(42);
        expect(host.goals.get(42)!.status).toBe("active");
        // And it ends the record: a Pause and Resume from the Mission view,
        // even in a process after that, is the ordinary one again.
        await after.notePaused(101, frame);
        expect(host.goals.get(42)!.status).toBe("paused");
        await daemon(host).noteResumed(101, frame);
        expect(host.goals.get(42)!.status).toBe("active");

        // "Give it 10 more turns" after the restart starts it too.
        const other = await heldThenStopped();
        const later = daemon(other);
        await resumeAfterStop(later);
        await later.noteUpdated({ missionId: 101, keepWorking: true, turnCap: 11 }, frame);
        expect(other.goals.get(42)!.status).toBe("active");
      });

      it("a goal that WAS running at the Stop still comes back after the restart", async () => {
        const host = makeHost();
        host.threads.add(42);
        const before = daemon(host);
        await armed(before);
        // An earlier Stop kept it, and the owner started it again since.
        await before.pauseForChat(42);
        await expect(before.holdForStop(42)).resolves.toBe(false);
        await before.resumeForChat(42);
        await expect(before.holdForStop(42)).resolves.toBe(true);

        await resumeAfterStop(daemon(host));
        expect(host.goals.get(42)!.status).toBe("active");
      });

      it("a mission closed after the Stop takes the record with it", async () => {
        const host = await heldThenStopped();
        expect(new StopDiscards(file).has(42)).toBe(true);
        const after = daemon(host);
        await after.noteClosed(101, frame);
        expect(new StopDiscards(file).has(42)).toBe(false);
      });
    });
  });

  it("writes nothing for a chat it does not own", async () => {
    const { lane } = makeLane();

    lane.noteTurnStarted(99);
    await lane.noteTurnFinished(99, { text: "stray" });
    await lane.handleGoalUpdate(99, liveGoal({ status: "complete" }));

    expect(server.requests).toHaveLength(0);
  });

  it("a write that fails leaves the lane standing and the goal alone", async () => {
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 500, { error: "boom" });
    const { lane } = makeLane();
    await armed(lane);

    lane.noteTurnStarted(42);
    await expect(lane.noteTurnFinished(42, {})).resolves.toBeUndefined();
    expect(lane.owns(42)).toBe(true);
  });

  it("tells the card the loop is on, so it never draws the switch off mid run", async () => {
    server.stage("POST", "/api/v1/integrations/assistants/7/missions", 201, missionBody(101, { keepWorking: true, turnCap: 20 }));
    const { lane } = makeLane();

    await lane.setFromChat({ assistantId: 7, chatId: 42, objective: CONDITION });

    const created = server.requests[0]!.body as {
      keepWorking?: boolean;
      turnCap?: number;
    };
    expect(created.keepWorking).toBe(true);
    expect(created.turnCap).toBe(GOAL_DEFAULT_TURN_CAP);
  });

  /**
   * A native goal lives in the runtime's own store and outlives this daemon.
   * After a restart the lane holds nothing at all, so every frame driven
   * control used to resolve its chat through a Map that no longer had the
   * mission in it and return silently. The frame carries the chat, the
   * condition and the cap, which is enough to act on the goal the runtime
   * still holds.
   */
  describe("after a restart, with the mission's own frame as the only state", () => {
    function frameContext(patch: Partial<GoalFrameContext> = {}): GoalFrameContext {
      return {
        assistantId: 7,
        chatId: 42,
        objective: CONDITION,
        turnCap: 20,
        keepWorking: true,
        ...patch,
      };
    }

    /** A lane that never armed anything, on a chat whose thread survived. */
    function restarted() {
      const { lane, host } = makeLane();
      host.threads.add(42);
      host.goals.set(42, liveGoal({ status: "active" }));
      return { lane, host };
    }

    it("really holds the goal the runtime still has on the frame's chat", async () => {
      const { lane, host } = restarted();

      await lane.notePaused(101, frameContext());

      expect(host.goals.get(42)!.status).toBe("paused");
    });

    it("clears the goal of a mission the owner set aside while it was away", async () => {
      const { lane, host } = restarted();

      await lane.noteClosed(101, frameContext());

      expect(host.clearGoal).toHaveBeenCalledWith(42);
      expect(host.goals.has(42)).toBe(false);
    });

    it("takes the goal back on Resume, so the turns that follow are adopted", async () => {
      const { lane, host } = restarted();
      host.goals.set(42, liveGoal({ status: "paused" }));

      await lane.noteResumed(101, frameContext());

      expect(host.goals.get(42)!.status).toBe("active");
      // The half that matters: without the lane owning the chat again, the
      // runtime would work and every continuation turn would be dropped.
      expect(lane.owns(42)).toBe(true);
      expect(lane.missionFor(42)).toBe(101);
    });

    it("takes it back on more turns too, and counts them against the new cap", async () => {
      server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
      const { lane, host } = restarted();
      host.goals.set(42, liveGoal({ status: "paused" }));

      await lane.noteUpdated(
        { missionId: 101, keepWorking: true, turnCap: 30 },
        frameContext({ turnCap: 30 }),
      );

      expect(host.goals.get(42)!.status).toBe("active");
      lane.noteTurnStarted(42);
      await lane.noteTurnFinished(42, {});
      expect(
        (server.requests.at(-1)!.body as { runReport: { turnCap: number } }).runReport.turnCap,
      ).toBe(30);
    });

    it("never starts a thread for a chat that has none, because a goal lives on one", async () => {
      const { lane, host } = makeLane();

      await lane.notePaused(101, frameContext());
      await lane.noteResumed(101, frameContext());
      await lane.noteClosed(101, frameContext());
      await lane.noteUpdated(
        { missionId: 101, keepWorking: true, turnCap: 30 },
        frameContext({ turnCap: 30 }),
      );

      expect(host.setGoal).not.toHaveBeenCalled();
      expect(host.clearGoal).not.toHaveBeenCalled();
    });

    it("touches nothing for a mission whose Keep working is off, which is not a goal", async () => {
      const { lane, host } = restarted();
      const off = frameContext({ keepWorking: false });

      await lane.notePaused(101, off);
      await lane.noteResumed(101, off);
      await lane.noteClosed(101, off);

      expect(host.setGoal).not.toHaveBeenCalled();
      expect(host.clearGoal).not.toHaveBeenCalled();
      expect(lane.owns(42)).toBe(false);
    });

    it("gives the chat back when the runtime no longer holds that goal", async () => {
      const { lane, host } = restarted();
      host.setGoal.mockRejectedValueOnce(
        new Error("no goal is set for this thread") as never,
      );

      await lane.noteResumed(101, frameContext());

      // Keeping the claim would stand the plan lane down on this chat for
      // ever, for a loop that is not running.
      expect(lane.owns(42)).toBe(false);
    });

    it("still prefers the state it holds over anything a frame says", async () => {
      const { lane, host } = makeLane();
      host.threads.add(42);
      await armed(lane);

      await lane.notePaused(101, frameContext({ chatId: 999 }));

      expect(host.goals.get(42)!.status).toBe("paused");
      expect(host.goals.has(999)).toBe(false);
    });
  });

  it("defaults the cap to twenty when the owner set none", async () => {
    server.stage("POST", "/api/v1/integrations/assistants/7/missions", 201, missionBody(101));
    server.stage("PATCH", "/api/v1/integrations/assistants/7/missions/101/progress", 200, missionBody(101));
    const { lane } = makeLane();
    await lane.setFromChat({ assistantId: 7, chatId: 42, objective: CONDITION });

    lane.noteTurnStarted(42);
    await lane.noteTurnFinished(42, {});

    expect((server.requests.at(-1)!.body as { runReport: { turnCap: number } }).runReport.turnCap).toBe(
      GOAL_DEFAULT_TURN_CAP,
    );
  });
});

describe("the words a goal is read back in", () => {
  it("uses the runtime's own display words for its six states", () => {
    expect(goalStatusWord("active")).toBe("active");
    expect(goalStatusWord("paused")).toBe("paused");
    expect(goalStatusWord("blocked")).toBe("stalled");
    expect(goalStatusWord("usageLimited")).toBe("usage limited");
    expect(goalStatusWord("budgetLimited")).toBe("limited by budget");
    expect(goalStatusWord("complete")).toBe("complete");
  });

  it("prints a word for a state a newer runtime invents rather than nothing", () => {
    expect(goalStatusWord("hibernating" as never)).toBe("hibernating");
  });

  it("reads seconds back as minutes and hours, and says nothing about zero", () => {
    expect(formatGoalSeconds(0)).toBeNull();
    expect(formatGoalSeconds(45)).toBe("45s");
    expect(formatGoalSeconds(1140)).toBe("19m");
    expect(formatGoalSeconds(3660)).toBe("1h 1m");
  });
});
