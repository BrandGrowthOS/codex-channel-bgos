/**
 * The SECOND narrow mission snapshot (src/hoai-shared/missions.ts) used to
 * know only three statuses, so a paused or failed mission either failed the
 * type check or was rendered as something it is not. Both now exist on the
 * wire and both reach the agent, so the summary has to speak them.
 */
import { describe, expect, it } from "vitest";

import { formatMissionSummary, type MissionSnapshot } from "../src/hoai-shared/missions.js";

function snapshot(status: MissionSnapshot["status"]): MissionSnapshot {
  return {
    id: 91,
    title: "Ship the strip",
    status,
    miniGoals: [
      { id: 1, name: "Draw it", doneWhen: "the tag is filled", done: true, doneAt: null, evidence: null },
      { id: 2, name: "Test it", doneWhen: "the render test passes", done: false, doneAt: null, evidence: null },
    ],
  };
}

describe("formatMissionSummary across every wire status", () => {
  it("names a paused mission and does not point at the next goal", () => {
    const text = formatMissionSummary(snapshot("paused"));
    expect(text).toContain("(paused)");
    expect(text).not.toContain("Next:");
  });

  it("names a failed mission and does not point at the next goal", () => {
    const text = formatMissionSummary(snapshot("failed"));
    expect(text).toContain("(failed)");
    expect(text).not.toContain("Next:");
  });

  it("still points at the next open goal while a mission is active", () => {
    expect(formatMissionSummary(snapshot("active"))).toContain("Next: 2. Test it");
  });
});
