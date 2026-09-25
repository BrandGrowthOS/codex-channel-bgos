/**
 * What this daemon TELLS the app it can do.
 *
 * The backend stores the array wholesale on every heartbeat and the app turns
 * it into the owner's buttons, so a token here is a promise to the person
 * holding the phone. Two guards: the token must pass the backend's own regex
 * (a token that fails it 400s the WHOLE heartbeat, taking daemon liveness
 * down with it), and `mission_pause` must stay out until there is a loop to
 * suspend.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DECLARED_CAPABILITIES,
  MISSION_EVENTS,
  MISSION_GOAL_CHECKS,
  MISSION_GOAL_LOOP,
  MISSION_PAUSE,
} from "../src/declared-capabilities.js";
import {
  SESSIONS_LIBRARY,
  STOP_PAUSES_MISSION,
} from "../src/session-controls-contract.js";

// backend/src/dto/integrations/pair-exchange.dto.ts CAPABILITY_TOKEN_REGEX
const CAPABILITY_TOKEN_REGEX = /^[a-z][a-z0-9_]{0,63}$/;

describe("DECLARED_CAPABILITIES", () => {
  it("declares that this daemon hears mission events", () => {
    expect(DECLARED_CAPABILITIES).toContain(MISSION_EVENTS);
  });

  it("every token passes the backend's capability token regex", () => {
    for (const token of DECLARED_CAPABILITIES) {
      expect(token, token).toMatch(CAPABILITY_TOKEN_REGEX);
    }
  });

  it("stays inside the backend's ArrayMaxSize of 32", () => {
    expect(DECLARED_CAPABILITIES.length).toBeLessThanOrEqual(32);
  });

  it("declares mission_pause, because a pause now really stops the work", () => {
    // Stage 5 held this back on purpose: there was no loop to suspend, so a
    // Pause button would have changed nothing the owner could see. Stage 6
    // gives the runtime its own goal with a native paused status, and the
    // owner's Pause holds it. The token and the enforcement ship together,
    // which is the only order in which either is honest.
    expect(DECLARED_CAPABILITIES).toContain(MISSION_PAUSE);
  });

  it("declares mission_goal_loop, because Keep working really arms one", () => {
    expect(DECLARED_CAPABILITIES).toContain(MISSION_GOAL_LOOP);
  });

  it("NEVER declares mission_goal_checks, because this channel has no judge", () => {
    // Codex has no separate checker and is not getting one: it runs a
    // continuation loop and the model itself decides it is done. Declaring
    // the token would put a Checked tag on the owner's card for a check that
    // never ran, which is the exact thing this whole stage exists to stop.
    expect(DECLARED_CAPABILITIES).not.toContain(MISSION_GOAL_CHECKS);
  });

  it("is frozen, so one constant is the single source", () => {
    expect(Object.isFrozen(DECLARED_CAPABILITIES)).toBe(true);
  });

  it("declares stop_pauses_mission, spelled by the contract file, because an owner Stop now pauses the mission", () => {
    // P6 stage 3 (C-32). BGOS serves the Codex canon's Stop sentence ("your
    // host pauses the chat's open mission with the reason Stopped by you")
    // only to a daemon that declares this, so the token ships in the same
    // release as the code that keeps it.
    expect(STOP_PAUSES_MISSION).toBe("stop_pauses_mission");
    expect(DECLARED_CAPABILITIES).toContain(STOP_PAUSES_MISSION);
    expect(DECLARED_CAPABILITIES.filter((t) => t === STOP_PAUSES_MISSION)).toHaveLength(1);
  });

  it("declares stop_pauses_mission only beside the code that keeps the promise", () => {
    // The token and its enforcement travel together. If the Stop's abort
    // stopped carrying its cause, or the lane stopped pausing with the
    // contract's reason, the token would be a promise nothing keeps; the
    // mission lane and adapter specs hold the behaviour, this holds the tie.
    const read = (file: string) =>
      readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    const adapter = read("adapter.ts");
    const lane = read("mission-lane.ts");
    expect(adapter).toContain('abortWith(controller, "owner_stop")');
    expect(adapter).toContain("this.missionLane.stoppedByOwner(");
    expect(adapter).toContain("this.missionLane.noteOwnerTurn(");
    expect(lane).toContain("reason: STOP_PAUSE_REASON");
    expect(lane).toContain("active.pausedReason === STOP_PAUSE_REASON");
  });

  it("does NOT declare sessions_library yet: this daemon does not answer the Sessions ops in this item", () => {
    // Wave E of the same release answers list_sessions, resume_session and
    // rename_session and flips this, deliberately. Declared before then, the
    // app would show a Sessions circle whose every request times out.
    expect(DECLARED_CAPABILITIES).not.toContain(SESSIONS_LIBRARY);
  });
});
