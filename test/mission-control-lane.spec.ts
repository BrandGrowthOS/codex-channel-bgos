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
  const steer = vi.fn(opts.steer ?? (async () => {}));
  const missionLane = {
    notePaused: vi.fn(),
    noteResumed: vi.fn(),
    noteClosed: vi.fn(),
  };
  let now = NOW;
  const lane = new MissionControlLane({
    host: { steer },
    missionLane,
    chatsForAssistant: () => opts.chats ?? [],
    isOwned: () => opts.owned ?? true,
    now: () => now,
  });
  return {
    lane,
    steer,
    missionLane,
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
