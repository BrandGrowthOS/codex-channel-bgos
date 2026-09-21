/**
 * MissionControlLane: what the daemon does with each mission frame.
 *
 * Two rules carry the whole design. The bulletin is queued BEFORE the steer
 * and cleared only when the steer resolves, so a steer that lands on a turn
 * about to finish still leaves the note for the next turn (double telling is
 * harmless, missing the telling is the bug). And the steer list is exactly
 * the two owner authored STOP events: interrupting a model mid thought for
 * anything else is an interruption the owner did not ask for.
 */
import { describe, expect, it, vi } from "vitest";

import { MissionControlLane, SELF_WRITE_TTL_MS } from "../src/mission-control.js";
import { normalizeMissionEvent, type MissionEventFrame } from "../src/mission-events.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function frame(
  type: string,
  overrides: Record<string, unknown> = {},
  mission: Record<string, unknown> = {},
): MissionEventFrame {
  const parsed = normalizeMissionEvent(type, {
    event_type: type,
    user_id: "user_2abc",
    assistant_id: 7,
    chat_id: 4403,
    mission: {
      id: 91,
      assistantId: 7,
      title: "Ship the strip",
      status: "active",
      origin: "derived",
      doneWhen: "the tag is filled",
      updatedAt: "2026-09-20T12:00:00.000Z",
      ...mission,
    },
    timestamp: `2026-09-20T12:00:00.${String(Math.floor(Math.random() * 900) + 100)}Z`,
    ...overrides,
  });
  if (!parsed) throw new Error(`test frame did not normalize: ${type}`);
  return parsed;
}

function makeLane(
  opts: { owned?: boolean; chats?: number[]; steer?: () => Promise<void> } = {},
) {
  const order: string[] = [];
  const innerSteer = opts.steer ?? (async () => {});
  const steer = vi.fn(async (_chatId: number, _text: string) => {
    order.push("steer");
    await innerSteer();
  });
  const missionLane = {
    notePaused: vi.fn(),
    noteResumed: vi.fn(),
    noteClosed: vi.fn(),
  };
  const goalLane = {
    armFromMission: vi.fn(async () => {
      order.push("arm");
    }),
    noteUpdated: vi.fn(async () => {
      order.push("updated");
    }),
    notePaused: vi.fn(async () => {
      order.push("goalPaused");
    }),
    noteResumed: vi.fn(async () => {
      order.push("goalResumed");
    }),
    noteClosed: vi.fn(async () => {
      order.push("goalClosed");
    }),
  };
  let now = NOW;
  const logs: string[] = [];
  const noteChat = vi.fn((_chatId: number, _assistantId: number) => {
    order.push("noteChat");
  });
  const lane = new MissionControlLane({
    host: { steer },
    missionLane,
    goalLane,
    noteChat,
    log: (message) => logs.push(message),
    chatsForAssistant: () => opts.chats ?? [],
    isOwned: () => opts.owned ?? true,
    now: () => now,
  });
  return {
    lane,
    steer,
    missionLane,
    goalLane,
    noteChat,
    order,
    logs,
    setNow(ms: number) {
      now = ms;
    },
    /** What the next turn in this chat would be told, or "" for nothing. */
    drain(chatId: number): string {
      const out = lane.applyBulletin(chatId, "PROMPT");
      return out === "PROMPT" ? "" : String(out).replace(/\n\nPROMPT$/, "");
    },
  };
}

describe("MissionControlLane", () => {
  it("set aside forgets the mission, queues the bulletin and steers once", async () => {
    const { lane, steer, missionLane, drain } = makeLane();
    await lane.handle(frame("mission_abandoned", { cleared_by: "owner", clear_reason: "set_aside" }));
    expect(missionLane.noteClosed).toHaveBeenCalledWith(91);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]![0]).toBe(4403);
    // The steer resolved, so the note was consumed and the next turn is clean.
    expect(drain(4403)).toBe("");
  });

  it("a steer that throws leaves the note queued and does not throw out of handle", async () => {
    const { lane, drain } = makeLane({
      steer: async () => {
        throw new Error(
          "No response is ready for a correction. Send a normal message or wait for Codex to start.",
        );
      },
    });
    await expect(
      lane.handle(frame("mission_abandoned", { cleared_by: "owner" })),
    ).resolves.toBeUndefined();
    expect(drain(4403)).toContain('set the mission "Ship the strip" aside');
  });

  it("marked done for a mission this daemon never managed still tells the model", async () => {
    const { lane, drain, missionLane } = makeLane({
      steer: async () => {
        throw new Error("no live turn");
      },
    });
    await lane.handle(
      frame("mission_completed", { cleared_by: "owner", clear_reason: "marked_done" }, { origin: "self_report" }),
    );
    expect(missionLane.noteClosed).toHaveBeenCalledWith(91);
    expect(drain(4403)).toContain('marked the mission "Ship the strip" as done');
  });

  it("a cleared_by agent completion queues nothing and does not steer", async () => {
    const { lane, steer, drain, missionLane } = makeLane();
    await lane.handle(frame("mission_completed", { cleared_by: "agent", clear_reason: "marked_done" }));
    expect(missionLane.noteClosed).toHaveBeenCalledWith(91);
    expect(steer).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");
  });

  it("a mission the daemon created itself queues nothing", async () => {
    const { lane, drain } = makeLane();
    await lane.handle(frame("mission_created", {}, { createdByAssistant: true }));
    expect(drain(4403)).toBe("");
  });

  it("an owner started mission queues one note naming the title and the done when", async () => {
    const { lane, drain } = makeLane();
    await lane.handle(frame("mission_created", {}, { createdByAssistant: false }));
    const told = drain(4403);
    expect(told).toContain('started the mission "Ship the strip"');
    expect(told).toContain("Done when: the tag is filled");
  });

  it("a mission the daemon itself just wrote is skipped when the backend sends no cleared_by", async () => {
    const { lane, drain, steer } = makeLane({
      steer: async () => {
        throw new Error("no live turn");
      },
    });
    lane.noteSelfWrite(91);
    await lane.handle(frame("mission_completed"));
    expect(steer).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");
    // The stamp is consumed: a LATER owner clear of the same mission still tells.
    await lane.handle(frame("mission_abandoned"));
    expect(drain(4403)).toContain("aside");
  });

  it("a tick does not eat a self write stamp that a later frame still needs", async () => {
    // The stamp is set before the write goes out, so any frame can arrive in
    // between. Only the frames that could be narrated may consume it.
    const { lane, drain, steer } = makeLane({
      steer: async () => {
        throw new Error("no live turn");
      },
    });
    lane.noteSelfWrite(91);
    await lane.handle(frame("mission_ticked", { ticked_goal_id: 1 }));
    await lane.handle(frame("mission_updated"));
    await lane.handle(frame("mission_completed"));
    expect(steer).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");
  });

  it("a stamp that outlived its own write does not swallow the owner's next clear", async () => {
    // A stamp is taken just before a write and the frame that write emits
    // arrives in seconds. One still sitting there much later is an orphan:
    // no frame of its own ever came, and letting it answer for the owner's
    // Set aside would leave the model chasing a mission that is over.
    const { lane, drain, setNow, steer } = makeLane({
      steer: async () => {
        throw new Error("no live turn");
      },
    });
    lane.noteSelfWrite(91);
    setNow(NOW + SELF_WRITE_TTL_MS + 1);
    await lane.handle(frame("mission_abandoned"));
    expect(steer).toHaveBeenCalledTimes(1);
    expect(drain(4403)).toContain("aside");
  });

  it("a spent stamp answers for nothing, so the owner's clear still tells", async () => {
    // The write landed and closed nothing, so the daemon gives its stamp
    // back. A tick of any goal but the last is exactly that case.
    const { lane, drain, steer } = makeLane({
      steer: async () => {
        throw new Error("no live turn");
      },
    });
    lane.noteSelfWrite(91);
    lane.dropSelfWrite(91);
    await lane.handle(frame("mission_completed"));
    expect(steer).toHaveBeenCalledTimes(1);
    expect(drain(4403)).toContain("marked the mission");
  });

  it("a replace tells nothing, while a set aside still tells", async () => {
    // Creating a mission in a chat sets the open one aside. The
    // mission_created that follows carries the whole news, so narrating the
    // replace as well would tell an agent the owner just handed fresh work
    // to that its mission no longer exists and it should wait.
    const { lane, steer, missionLane, drain } = makeLane({
      steer: async () => {
        throw new Error("no live turn");
      },
    });
    await lane.handle(
      frame("mission_abandoned", { cleared_by: "owner", clear_reason: "replaced" }),
    );
    // The lane still stops writing to a mission that is over.
    expect(missionLane.noteClosed).toHaveBeenCalledWith(91);
    expect(steer).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");

    await lane.handle(
      frame("mission_abandoned", { cleared_by: "owner", clear_reason: "set_aside" }),
    );
    expect(steer).toHaveBeenCalledTimes(1);
    expect(drain(4403)).toContain("aside");
  });

  it("a tick queues nothing and does not steer", async () => {
    const { lane, steer, drain } = makeLane();
    await lane.handle(frame("mission_ticked", { ticked_goal_id: 2 }));
    expect(steer).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");
  });

  it("an edit queues nothing and does not steer", async () => {
    const { lane, steer, drain } = makeLane();
    await lane.handle(frame("mission_updated", {}, { title: "Ship the strip, again" }));
    expect(steer).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");
  });

  it("a failure forgets the mission and queues nothing, because it is always the agent's own write", async () => {
    const { lane, steer, drain, missionLane } = makeLane();
    await lane.handle(frame("mission_failed"));
    expect(missionLane.noteClosed).toHaveBeenCalledWith(91);
    expect(steer).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");
  });

  it("pause and resume tell the model and move the lane, without interrupting a live turn", async () => {
    const { lane, steer, missionLane, drain } = makeLane();
    await lane.handle(frame("mission_paused", {}, { status: "paused", pausedReason: "waiting on design" }));
    expect(missionLane.notePaused).toHaveBeenCalledWith(91);
    await lane.handle(frame("mission_resumed", {}, { status: "active" }));
    expect(missionLane.noteResumed).toHaveBeenCalledWith(91);
    expect(steer).not.toHaveBeenCalled();
    const told = drain(4403);
    expect(told).toContain("paused the mission");
    expect(told).toContain("reason: waiting on design");
    expect(told).toContain("resumed the mission");
    expect(told.indexOf("paused the mission")).toBeLessThan(told.indexOf("resumed the mission"));
  });

  it("steers for the two owner authored STOP events and for nothing else", async () => {
    const { lane, steer } = makeLane({
      steer: async () => {
        throw new Error("no live turn");
      },
    });
    for (const type of [
      "mission_created",
      "mission_ticked",
      "mission_updated",
      "mission_paused",
      "mission_resumed",
      "mission_failed",
    ]) {
      await lane.handle(frame(type, { cleared_by: "owner" }));
    }
    expect(steer).not.toHaveBeenCalled();
    await lane.handle(frame("mission_completed", { cleared_by: "owner" }));
    await lane.handle(frame("mission_abandoned", { cleared_by: "owner" }));
    expect(steer).toHaveBeenCalledTimes(2);
  });

  it("caps a chat's queue at four notes, evicting the oldest", async () => {
    const { lane, drain } = makeLane();
    for (const reason of ["one", "two", "three", "four", "five"]) {
      await lane.handle(frame("mission_paused", {}, { pausedReason: reason }));
    }
    const told = drain(4403);
    expect(told.split("\n")).toHaveLength(4);
    expect(told).not.toContain("reason: one");
    expect(told).toContain("reason: five");
  });

  it("drops a note older than six hours at drain rather than delivering it", async () => {
    const { lane, drain, setNow } = makeLane();
    await lane.handle(frame("mission_paused"));
    setNow(NOW + 6 * 60 * 60 * 1000 + 1);
    expect(drain(4403)).toBe("");
  });

  it("ignores a frame for an assistant this daemon does not own", async () => {
    const { lane, missionLane, drain } = makeLane({ owned: false });
    await lane.handle(frame("mission_abandoned", { cleared_by: "owner" }));
    expect(missionLane.noteClosed).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");
  });

  it("with no chat on the frame, tells every chat of that assistant it has served", async () => {
    const { lane, drain } = makeLane({ chats: [11, 12] });
    await lane.handle(frame("mission_paused", { chat_id: undefined }, { chatId: undefined }));
    expect(drain(11)).toContain("paused the mission");
    expect(drain(12)).toContain("paused the mission");
  });

  it("with no chat on the frame and no chat served, invents none", async () => {
    const { lane, drain, missionLane } = makeLane({ chats: [] });
    await lane.handle(
      frame("mission_abandoned", { chat_id: undefined, cleared_by: "owner" }, { chatId: undefined }),
    );
    // The lane still stops writing to the mission; it just has nobody to tell.
    expect(missionLane.noteClosed).toHaveBeenCalledWith(91);
    expect(drain(4403)).toBe("");
  });

  it("returns the turn input unchanged by identity when nothing is queued", () => {
    const { lane } = makeLane();
    const input = "Message:\nhello";
    expect(lane.applyBulletin(4403, input)).toBe(input);
  });

  it("consumes a bulletin exactly once", async () => {
    const { lane, drain } = makeLane();
    await lane.handle(frame("mission_paused"));
    expect(drain(4403)).not.toBe("");
    expect(drain(4403)).toBe("");
  });
});

/**
 * Stage 6: the owner's decisions reach the RUNTIME's own goal, not only the
 * model. A pause that leaves the loop running would be a button that changes
 * nothing, which is the whole reason this channel refused to claim a pause
 * control until it had one.
 */
/** What every frame of the test mission tells the goal lane about its goal. */
const GOAL_CONTEXT = {
  assistantId: 7,
  chatId: 4403,
  objective: "the tag is filled",
  turnCap: null,
  keepWorking: true,
};
/** The same mission with the owner's Keep working switch off. */
const GOAL_CONTEXT_OFF = { ...GOAL_CONTEXT, keepWorking: false };

describe("MissionControlLane and the native goal", () => {
  it("arms the goal when the owner starts a mission with Keep working on", async () => {
    const { lane, goalLane } = makeLane();
    await lane.handle(
      frame("mission_created", {}, {
        createdByAssistant: false,
        keepWorking: true,
        turnCap: 40,
      }),
    );
    expect(goalLane.armFromMission).toHaveBeenCalledWith({
      assistantId: 7,
      chatId: 4403,
      missionId: 91,
      // The owner's own test for the mission is the condition to work toward.
      objective: "the tag is filled",
      turnCap: 40,
    });
  });

  it("falls back to the title when the owner wrote no Done when", async () => {
    const { lane, goalLane } = makeLane();
    await lane.handle(
      frame("mission_created", {}, {
        createdByAssistant: false,
        keepWorking: true,
        doneWhen: null,
        turnCap: null,
      }),
    );
    expect(goalLane.armFromMission).toHaveBeenCalledWith(
      expect.objectContaining({ objective: "Ship the strip", turnCap: null }),
    );
  });

  it("arms nothing for an ordinary mission, which is most of them", async () => {
    const { lane, goalLane } = makeLane();
    await lane.handle(frame("mission_created", {}, { createdByAssistant: false }));
    expect(goalLane.armFromMission).not.toHaveBeenCalled();
  });

  it("arms nothing for a mission the daemon created itself", async () => {
    const { lane, goalLane } = makeLane();
    await lane.handle(
      frame("mission_created", {}, { createdByAssistant: true, keepWorking: true }),
    );
    expect(goalLane.armFromMission).not.toHaveBeenCalled();
  });

  it("names the chat's agent BEFORE it arms, or the goal's turns have no agent", async () => {
    const { lane, noteChat, order } = makeLane();
    await lane.handle(
      frame("mission_created", {}, { createdByAssistant: false, keepWorking: true }),
    );
    expect(noteChat).toHaveBeenCalledWith(4403, 7);
    // Arming starts the thread, and the thread's config is where the agent is
    // named, so a pair recorded afterwards is a pair recorded too late.
    expect(order.indexOf("noteChat")).toBeLessThan(order.indexOf("arm"));
  });

  it("names no agent for a mission that arms no goal", async () => {
    const { lane, noteChat } = makeLane();
    await lane.handle(frame("mission_created", {}, { createdByAssistant: false }));
    expect(noteChat).not.toHaveBeenCalled();
  });

  it("tells the model its mission started BEFORE it arms, because a set starts a turn", async () => {
    const { lane, goalLane, drain } = makeLane();
    let toldWhenArmed = "";
    goalLane.armFromMission.mockImplementation(async () => {
      toldWhenArmed = drain(4403);
    });
    await lane.handle(
      frame("mission_created", {}, { createdByAssistant: false, keepWorking: true }),
    );
    expect(toldWhenArmed).toContain('started the mission "Ship the strip"');
  });

  it("holds the goal on Pause and starts it again on Resume", async () => {
    const { lane, goalLane } = makeLane();
    await lane.handle(frame("mission_paused", { cleared_by: "owner" }, { keepWorking: true }));
    expect(goalLane.notePaused).toHaveBeenCalledWith(91, GOAL_CONTEXT);
    await lane.handle(frame("mission_resumed", { cleared_by: "owner" }, { keepWorking: true }));
    expect(goalLane.noteResumed).toHaveBeenCalledWith(91, GOAL_CONTEXT);
  });

  /**
   * The lane's own state does not survive a daemon restart and the runtime's
   * goal does, so a control that could only name a mission id reached nothing
   * at all: the owner's Pause was a no op against a goal still running. The
   * frame carries the chat, the condition and the cap, so it is passed on.
   */
  it("hands every control the chat and the condition, not only the mission id", async () => {
    const { lane, goalLane } = makeLane();
    await lane.handle(frame("mission_abandoned", { cleared_by: "owner" }, { keepWorking: true }));
    expect(goalLane.noteClosed).toHaveBeenCalledWith(91, GOAL_CONTEXT);
    await lane.handle(
      frame("mission_updated", {}, { keepWorking: true, turnCap: 30 }),
    );
    expect(goalLane.noteUpdated).toHaveBeenCalledWith(
      { missionId: 91, keepWorking: true, turnCap: 30 },
      { ...GOAL_CONTEXT, turnCap: 30 },
    );
  });

  it("says a mission with no chat of its own carries no goal context", async () => {
    const { lane, goalLane } = makeLane();
    await lane.handle(
      frame("mission_paused", { cleared_by: "owner", chat_id: null }, { chatId: null, keepWorking: true }),
    );
    expect(goalLane.notePaused).toHaveBeenCalledWith(91, null);
  });

  it("clears the goal BEFORE it steers the model off a mission that is over", async () => {
    const { lane, goalLane, order } = makeLane();
    await lane.handle(
      frame("mission_abandoned", { cleared_by: "owner", clear_reason: "set_aside" }),
    );
    expect(goalLane.noteClosed).toHaveBeenCalledWith(91, GOAL_CONTEXT_OFF);
    expect(order).toEqual(["goalClosed", "steer"]);
  });

  it("clears the goal on a completion the agent wrote itself, and says nothing", async () => {
    const { lane, goalLane, steer, drain } = makeLane();
    await lane.handle(frame("mission_completed", { cleared_by: "agent" }));
    // The mission is closed either way, so the runtime must stop working
    // toward it; the model wrote this one, so it is told nothing.
    expect(goalLane.noteClosed).toHaveBeenCalledWith(91, GOAL_CONTEXT_OFF);
    expect(steer).not.toHaveBeenCalled();
    expect(drain(4403)).toBe("");
  });

  it("hands a raised cap to the lane, and still narrates nothing", async () => {
    const { lane, goalLane, drain, steer } = makeLane();
    await lane.handle(
      frame("mission_updated", {}, { keepWorking: true, turnCap: 30 }),
    );
    expect(goalLane.noteUpdated).toHaveBeenCalledWith(
      { missionId: 91, keepWorking: true, turnCap: 30 },
      { ...GOAL_CONTEXT, turnCap: 30 },
    );
    expect(drain(4403)).toBe("");
    expect(steer).not.toHaveBeenCalled();
  });

  it("touches the goal for no frame of an assistant this daemon does not own", async () => {
    const { lane, goalLane } = makeLane({ owned: false });
    await lane.handle(
      frame("mission_created", {}, { createdByAssistant: false, keepWorking: true }),
    );
    await lane.handle(frame("mission_abandoned", { cleared_by: "owner" }));
    expect(goalLane.armFromMission).not.toHaveBeenCalled();
    expect(goalLane.noteClosed).not.toHaveBeenCalled();
  });

  it("never throws out of handle when arming the goal fails", async () => {
    const { lane, goalLane, drain, logs } = makeLane();
    goalLane.armFromMission.mockRejectedValue(
      new Error("goals feature is disabled") as never,
    );
    await expect(
      lane.handle(
        frame("mission_created", {}, { createdByAssistant: false, keepWorking: true }),
      ),
    ).resolves.toBeUndefined();
    // The model still learns its mission started, which is the half that
    // works with no goal loop at all, and the reason is named as a goal
    // failure rather than swallowed as a broken frame.
    expect(drain(4403)).toContain('started the mission "Ship the strip"');
    expect(logs.join(" ")).toContain("goal arm failed for mission 91");
    expect(logs.join(" ")).toContain("goals feature is disabled");
  });
});
