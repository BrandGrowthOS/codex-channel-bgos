/**
 * Mission event normalizer (mission program stage 5).
 *
 * The gateway builds ONE event object and emits it to every room a socket may
 * sit in, so the pairing copy and the assistant copy of one logical event are
 * byte identical. That is what makes `missionEventKey` an exact dedupe key
 * rather than a heuristic, and it is pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  MISSION_EVENT_TYPES,
  missionEventKey,
  normalizeMissionEvent,
} from "../src/mission-events.js";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    event_type: "mission_paused",
    user_id: "user_2abc",
    assistant_id: 7,
    chat_id: 4403,
    mission: {
      id: 91,
      assistantId: 7,
      chatId: 4403,
      title: "Ship the strip",
      status: "paused",
      origin: "derived",
      progress: { current: 1, total: 3, label: "steps" },
      doneWhen: "the strip renders",
      pausedReason: "waiting on the owner",
      createdByAssistant: false,
      miniGoals: [
        {
          id: 1,
          name: "Draw it",
          doneWhen: "the tag is filled",
          done: false,
          doneAt: null,
          evidence: null,
        },
      ],
      updatedAt: "2026-09-20T12:00:00.000Z",
    },
    timestamp: "2026-09-20T12:00:00.500Z",
    ...overrides,
  };
}

describe("normalizeMissionEvent", () => {
  it("normalizes a snake_case envelope with a camelCase mission, for all eight types", () => {
    expect(MISSION_EVENT_TYPES).toHaveLength(8);
    for (const type of MISSION_EVENT_TYPES) {
      const frame = normalizeMissionEvent(type, envelope({ event_type: type }));
      expect(frame, type).not.toBeNull();
      expect(frame!.eventType).toBe(type);
      expect(frame!.userId).toBe("user_2abc");
      expect(frame!.assistantId).toBe(7);
      expect(frame!.chatId).toBe(4403);
      expect(frame!.mission.id).toBe(91);
      expect(frame!.mission.title).toBe("Ship the strip");
      expect(frame!.mission.pausedReason).toBe("waiting on the owner");
      expect(frame!.mission.createdByAssistant).toBe(false);
      expect(frame!.mission.miniGoals).toHaveLength(1);
      expect(frame!.timestamp).toBe("2026-09-20T12:00:00.500Z");
    }
  });

  it("accepts the camelCase envelope variant too", () => {
    const frame = normalizeMissionEvent("mission_completed", {
      eventType: "mission_completed",
      userId: "user_2abc",
      assistantId: 7,
      chatId: "4403",
      tickedGoalId: "2",
      clearedBy: "owner",
      clearReason: "marked_done",
      mission: { id: 91, title: "Ship it", status: "completed", origin: "derived" },
      timestamp: "2026-09-20T12:00:01.000Z",
    });
    expect(frame).not.toBeNull();
    expect(frame!.assistantId).toBe(7);
    expect(frame!.chatId).toBe(4403);
    expect(frame!.tickedGoalId).toBe(2);
    expect(frame!.clearedBy).toBe("owner");
    expect(frame!.clearReason).toBe("marked_done");
  });

  it("reads the snake_case clear pair and the ticked goal", () => {
    const frame = normalizeMissionEvent(
      "mission_abandoned",
      envelope({
        event_type: "mission_abandoned",
        cleared_by: "owner",
        clear_reason: "set_aside",
        ticked_goal_id: 3,
      }),
    );
    expect(frame!.clearedBy).toBe("owner");
    expect(frame!.clearReason).toBe("set_aside");
    expect(frame!.tickedGoalId).toBe(3);
  });

  it("leaves the clear pair undefined on a backend that does not send it", () => {
    const frame = normalizeMissionEvent("mission_abandoned", envelope());
    expect(frame!.clearedBy).toBeUndefined();
    expect(frame!.clearReason).toBeUndefined();
  });

  it("drops a junk clear pair rather than passing it through", () => {
    const frame = normalizeMissionEvent(
      "mission_abandoned",
      envelope({ cleared_by: "nobody", clear_reason: "because" }),
    );
    expect(frame!.clearedBy).toBeUndefined();
    expect(frame!.clearReason).toBeUndefined();
  });

  it("returns null for a missing or zero assistant id", () => {
    expect(normalizeMissionEvent("mission_paused", envelope({ assistant_id: 0 }))).toBeNull();
    const noAssistant = envelope();
    delete (noAssistant as Record<string, unknown>).assistant_id;
    expect(normalizeMissionEvent("mission_paused", noAssistant)).toBeNull();
    expect(normalizeMissionEvent("mission_paused", envelope({ assistant_id: -4 }))).toBeNull();
  });

  it("returns null for a missing mission and for a non integer mission id", () => {
    expect(normalizeMissionEvent("mission_paused", envelope({ mission: undefined }))).toBeNull();
    expect(normalizeMissionEvent("mission_paused", envelope({ mission: { id: 1.5 } }))).toBeNull();
    expect(normalizeMissionEvent("mission_paused", envelope({ mission: { id: "abc" } }))).toBeNull();
    expect(normalizeMissionEvent("mission_paused", envelope({ mission: { id: 0 } }))).toBeNull();
  });

  it("returns null for a type this daemon does not know", () => {
    expect(normalizeMissionEvent("mission_teleported", envelope())).toBeNull();
  });

  it("accepts an unknown status so a new backend status is not silenced", () => {
    const frame = normalizeMissionEvent(
      "mission_updated",
      envelope({ mission: { id: 91, title: "Ship it", status: "hibernating" } }),
    );
    expect(frame).not.toBeNull();
    expect(frame!.mission.status).toBe("hibernating");
  });

  /**
   * Stage 6. The goal lane learns the owner's Keep working instruction and
   * their turn limit from the mission_created frame it already receives, and
   * nowhere else: there is no extra fetch. A field this normalizer drops is a
   * cap the daemon cannot hold, so each one is read here in both shapes.
   */
  it("carries the effort, the Keep working switch and the turn cap", () => {
    const base = envelope().mission;
    const camel = normalizeMissionEvent(
      "mission_created",
      envelope({
        event_type: "mission_created",
        mission: {
          ...base,
          effort: { used: 3, budget: 20, unit: "turns" },
          keepWorking: true,
          turnCap: 20,
        },
      }),
    );
    expect(camel!.mission.effort).toEqual({ used: 3, budget: 20, unit: "turns" });
    expect(camel!.mission.keepWorking).toBe(true);
    expect(camel!.mission.turnCap).toBe(20);

    const snake = normalizeMissionEvent(
      "mission_created",
      envelope({
        event_type: "mission_created",
        mission: { ...base, keep_working: true, turn_cap: 40 },
      }),
    );
    expect(snake!.mission.keepWorking).toBe(true);
    expect(snake!.mission.turnCap).toBe(40);
  });

  it("keeps a null turn cap null, because off is not the same as twenty", () => {
    const frame = normalizeMissionEvent(
      "mission_updated",
      envelope({
        mission: { ...envelope().mission, keepWorking: false, turnCap: null },
      }),
    );
    expect(frame!.mission.keepWorking).toBe(false);
    expect(frame!.mission.turnCap).toBeNull();
  });

  it("leaves all three ABSENT on a backend older than the columns", () => {
    const frame = normalizeMissionEvent("mission_created", envelope({ event_type: "mission_created" }));
    expect(frame!.mission).not.toHaveProperty("effort");
    expect(frame!.mission).not.toHaveProperty("keepWorking");
    expect(frame!.mission).not.toHaveProperty("turnCap");
  });

  it("never throws on junk shapes", () => {
    const junk: unknown[] = [
      null,
      undefined,
      0,
      "",
      "mission_paused",
      [],
      {},
      { mission: null },
      { assistant_id: {}, mission: { id: 3 } },
      { assistant_id: 7, mission: [] },
    ];
    for (const raw of junk) {
      expect(() => normalizeMissionEvent("mission_paused", raw)).not.toThrow();
      expect(normalizeMissionEvent("mission_paused", raw)).toBeNull();
    }
  });
});

describe("missionEventKey", () => {
  it("is identical for two copies of one event and different for two events a millisecond apart", () => {
    const pairingCopy = normalizeMissionEvent("mission_paused", envelope())!;
    const assistantCopy = normalizeMissionEvent("mission_paused", envelope())!;
    expect(missionEventKey(pairingCopy)).toBe(missionEventKey(assistantCopy));

    const later = normalizeMissionEvent(
      "mission_paused",
      envelope({ timestamp: "2026-09-20T12:00:00.501Z" }),
    )!;
    expect(missionEventKey(later)).not.toBe(missionEventKey(pairingCopy));
  });

  it("is different for two different types of one mission", () => {
    const paused = normalizeMissionEvent("mission_paused", envelope())!;
    const resumed = normalizeMissionEvent(
      "mission_resumed",
      envelope({ event_type: "mission_resumed" }),
    )!;
    expect(missionEventKey(paused)).not.toBe(missionEventKey(resumed));
  });

  it("falls back to the mission updatedAt when the envelope carries no timestamp", () => {
    const noTimestamp = envelope();
    delete (noTimestamp as Record<string, unknown>).timestamp;
    const frame = normalizeMissionEvent("mission_paused", noTimestamp)!;
    expect(frame.timestamp).toBe("");
    expect(missionEventKey(frame)).toBe("mission_paused|91|2026-09-20T12:00:00.000Z");
  });
});
