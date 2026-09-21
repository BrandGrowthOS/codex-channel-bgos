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
import { describe, expect, it } from "vitest";

import {
  DECLARED_CAPABILITIES,
  MISSION_EVENTS,
  MISSION_PAUSE,
} from "../src/declared-capabilities.js";

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

  it("does NOT declare mission_pause in this release", () => {
    // Stage 6 turns this on together with the native goal lane, which is the
    // first thing on this channel a pause can actually suspend. Declaring it
    // now would put a Pause button in the owner's hand that changes nothing
    // they can see, and Kc's own rule is that a Pause that does nothing is
    // worse than no Pause. This test fails loudly the day someone adds the
    // token without adding the enforcement.
    expect(DECLARED_CAPABILITIES).not.toContain(MISSION_PAUSE);
  });

  it("is frozen, so one constant is the single source", () => {
    expect(Object.isFrozen(DECLARED_CAPABILITIES)).toBe(true);
  });
});
