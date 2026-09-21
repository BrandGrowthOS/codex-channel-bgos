import { describe, expect, it } from "vitest";
import {
  goalFromNotification,
  normalizeThreadGoal,
} from "../src/goal-protocol.js";

/**
 * Every shape below is copied verbatim out of the stage 6 feasibility gate's
 * own capture of the live app server traffic (codex-cli 0.154.0), not typed
 * from memory and not read out of the SDK, which carries no goal types at
 * all.
 */
const LIVE_GOAL = {
  threadId: "01a0c055-b8e7-7410-b779-fb8ff74a9d76",
  objective: "inheritance probe objective",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 1,
  createdAt: 1789933238,
  updatedAt: 1789933240,
};

describe("the Codex thread goal on the wire", () => {
  it("normalizes the eight field camelCase goal the app server sends", () => {
    expect(normalizeThreadGoal(LIVE_GOAL)).toEqual({
      threadId: "01a0c055-b8e7-7410-b779-fb8ff74a9d76",
      objective: "inheritance probe objective",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 1,
      createdAt: 1789933238,
      updatedAt: 1789933240,
    });
  });

  it("casts a status this daemon has never heard of rather than rejecting the goal", () => {
    const goal = normalizeThreadGoal({ ...LIVE_GOAL, status: "hibernating" });
    expect(goal).not.toBeNull();
    expect(goal?.status).toBe("hibernating");
    expect(goal?.objective).toBe("inheritance probe objective");
  });

  it("drops a payload with no thread and never throws on junk", () => {
    expect(normalizeThreadGoal({ ...LIVE_GOAL, threadId: "" })).toBeNull();
    const { threadId: _dropped, ...noThread } = LIVE_GOAL;
    expect(normalizeThreadGoal(noThread)).toBeNull();
    expect(normalizeThreadGoal(null)).toBeNull();
    expect(normalizeThreadGoal("a goal")).toBeNull();
    expect(normalizeThreadGoal([LIVE_GOAL])).toBeNull();
  });

  it("reads a goal out of both goal notifications", () => {
    expect(
      goalFromNotification("thread/goal/updated", {
        threadId: "01a0c055-b8e7-7410-b779-fb8ff74a9d76",
        turnId: "01a0c055-ba0f-7e40-b4fb-a9a7d849539c",
        goal: LIVE_GOAL,
      }),
    ).toEqual({
      threadId: "01a0c055-b8e7-7410-b779-fb8ff74a9d76",
      turnId: "01a0c055-ba0f-7e40-b4fb-a9a7d849539c",
      goal: normalizeThreadGoal(LIVE_GOAL),
    });
    expect(
      goalFromNotification("thread/goal/updated", {
        threadId: "01a0c055-b8e7-7410-b779-fb8ff74a9d76",
        turnId: null,
        goal: LIVE_GOAL,
      })?.turnId,
    ).toBeNull();
    expect(
      goalFromNotification("thread/goal/cleared", {
        threadId: "01a0c055-c218-7132-b3dc-a487855ee5cc",
      }),
    ).toEqual({
      threadId: "01a0c055-c218-7132-b3dc-a487855ee5cc",
      turnId: null,
      goal: null,
    });
  });

  it("answers null for every method that is not a goal notification", () => {
    expect(
      goalFromNotification("turn/started", {
        threadId: "01a0c051-97e7-7013-884a-f477685adf5b",
        turn: { id: "01a0c051-997e-7b92-9f2e-472d1c429061" },
      }),
    ).toBeNull();
    expect(
      goalFromNotification("thread/goal/set", { threadId: "t", goal: LIVE_GOAL }),
    ).toBeNull();
    expect(goalFromNotification("thread/goal/updated", null)).toBeNull();
    expect(
      goalFromNotification("thread/goal/updated", { threadId: "t" }),
    ).toBeNull();
    expect(
      goalFromNotification("thread/goal/cleared", { threadId: "" }),
    ).toBeNull();
  });
});
