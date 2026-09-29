import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPendingPlan,
  loadPendingPlans,
  recordPendingPlan,
} from "../src/pending-plans-store.js";

/**
 * The disk half of the plan restart contract (see `sweepMissedPlanAnswers` in
 * plan-lane.ts). A plan answer reaches this plugin on the WS click alone and
 * nothing replays it, so what the next boot can read back is exactly what this
 * file survived with, and the cases worth pinning are the round trip, the
 * forgetting, and what a damaged file does.
 *
 * MUTATION PROOFS, run by hand against this tree:
 *  - dropping the `entries.some` guard in recordPendingPlan turns the
 *    idempotence case red, and a boot would deliver one answer twice.
 *  - dropping any field from the validator in loadPendingPlans turns the half
 *    written case red: an entry with no chat, no assistant or no user would
 *    come back and the sweep would read and PATCH against `undefined`.
 *  - returning something other than [] from a failed parse turns the damaged
 *    file case red, and a boot would throw on a file it should ignore.
 */
describe("the durable record of open plan cards", () => {
  let tempHome: string;
  const original = process.env.CODEX_BGOS_HOME;
  const entry = {
    id: 501,
    chatId: 20,
    assistantId: 10,
    userId: "owner",
    at: 1789932968000,
  };

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-plans-"));
    process.env.CODEX_BGOS_HOME = tempHome;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_BGOS_HOME;
    else process.env.CODEX_BGOS_HOME = original;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("reads back what it recorded, and records a card only once", () => {
    expect(loadPendingPlans()).toEqual([]);
    recordPendingPlan(entry);
    recordPendingPlan({ ...entry, chatId: 99 });
    expect(loadPendingPlans()).toEqual([entry]);
    const raw = readFileSync(join(tempHome, "bgos_pending_plans.json"), "utf8");
    expect(JSON.parse(raw)).toEqual([entry]);
  });

  it("forgets one card without disturbing the others", () => {
    recordPendingPlan(entry);
    recordPendingPlan({ ...entry, id: 502 });
    clearPendingPlan(501);
    expect(loadPendingPlans()).toEqual([{ ...entry, id: 502 }]);
  });

  it("drops a half written entry and ignores a damaged file", () => {
    writeFileSync(
      join(tempHome, "bgos_pending_plans.json"),
      JSON.stringify([
        entry,
        // Missing ONLY the user, which is the id the sweep's read is made as:
        // each clause of the validator is load bearing on its own.
        { id: 502, chatId: 20, assistantId: 10, at: 1789932968000 },
        { ...entry, id: 503, assistantId: 0 },
        { chatId: 20 },
      ]),
    );
    expect(loadPendingPlans()).toEqual([entry]);
    writeFileSync(join(tempHome, "bgos_pending_plans.json"), "{ not json");
    expect(loadPendingPlans()).toEqual([]);
  });

  it("refuses an entry with no user at all, rather than writing a read it cannot make", () => {
    recordPendingPlan({ ...entry, userId: "" });
    expect(loadPendingPlans()).toEqual([]);
  });
});
