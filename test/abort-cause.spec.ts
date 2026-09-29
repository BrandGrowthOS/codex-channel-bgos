/**
 * Why a turn was aborted, and what that means for the chat's open mission
 * (P6 stage 3, C-32, spec 4.2 step 1).
 *
 * Before this stage every abort unwound the same way: the mission failed with
 * "Stopped by you.", so an owner who pressed Stop read Did not finish. Now the
 * abort carries its cause, and only an owner Stop pauses. `/new`, a daemon
 * shutdown and a revoked pairing still fail, each with its own words, because
 * with a Stop now pausing under the reason "Stopped by you", a `/new` failing
 * with "Stopped by you." would print the same words on a failed card.
 */
import { describe, expect, it } from "vitest";

import {
  abortCauseOf,
  abortWith,
  missionAbortOutcome,
  type AbortCause,
} from "../src/abort-cause.js";

const CAUSES: AbortCause[] = ["owner_stop", "new", "shutdown", "revoked"];

/** An en dash or an em dash, spelled as escapes so this file carries neither. */
const DASH = new RegExp("[\\u2013\\u2014]");

describe("abort causes", () => {
  it.each(CAUSES)("reads back the cause it was aborted with (%s)", (cause) => {
    const controller = new AbortController();
    abortWith(controller, cause);
    expect(controller.signal.aborted).toBe(true);
    expect(abortCauseOf(controller.signal)).toBe(cause);
  });

  it("keeps the reason an AbortError, because the host and the tools rethrow it", () => {
    // `signal.throwIfAborted()` throws `signal.reason`. The host's run and
    // the HOAI tools call it, and whatever catches it reads `.message`, as it
    // did for a plain abort(). A bare object there would print
    // "[object Object]" into a tool error.
    const controller = new AbortController();
    abortWith(controller, "owner_stop");
    const reason = controller.signal.reason as Error & { bgosAbortCause?: string };
    expect(reason).toBeInstanceOf(Error);
    expect(reason.name).toBe("AbortError");
    expect(reason.message).toBe("This operation was aborted");
    expect(reason.bgosAbortCause).toBe("owner_stop");
    expect(() => controller.signal.throwIfAborted()).toThrow(
      "This operation was aborted",
    );
  });

  it("keeps the FIRST cause: a later abort, tagged or not, changes nothing", () => {
    // The turn's own finally block aborts its controller once more after
    // the turn is over, with no cause. That must not wipe the owner's Stop.
    const controller = new AbortController();
    abortWith(controller, "owner_stop");
    abortWith(controller, "shutdown");
    controller.abort();
    expect(abortCauseOf(controller.signal)).toBe("owner_stop");
  });

  it("reads unknown for a signal that is not aborted, a plain abort, or a foreign reason", () => {
    expect(abortCauseOf(new AbortController().signal)).toBe("unknown");

    const plain = new AbortController();
    plain.abort();
    expect(abortCauseOf(plain.signal)).toBe("unknown");

    const text = new AbortController();
    text.abort("owner_stop");
    expect(abortCauseOf(text.signal)).toBe("unknown");

    const bogus = new AbortController();
    bogus.abort({ bgosAbortCause: "whatever" });
    expect(abortCauseOf(bogus.signal)).toBe("unknown");

    const inherited = new AbortController();
    inherited.abort(Object.create({ bgosAbortCause: "owner_stop" }));
    expect(abortCauseOf(inherited.signal)).toBe("unknown");
  });

  it("pauses the mission only for an owner Stop", () => {
    expect(missionAbortOutcome("owner_stop")).toEqual({ kind: "pause" });
  });

  it("fails the mission for /new, a shutdown, a revoked pairing and an unknown abort, each with its own words", () => {
    expect(missionAbortOutcome("new")).toEqual({
      kind: "fail",
      summary: "Started a new conversation before the plan finished",
    });
    expect(missionAbortOutcome("shutdown")).toEqual({
      kind: "fail",
      summary: "Daemon stopped before the plan finished",
    });
    expect(missionAbortOutcome("revoked")).toEqual({
      kind: "fail",
      summary: "The pairing was revoked before the plan finished",
    });
    expect(missionAbortOutcome("unknown")).toEqual({
      kind: "fail",
      summary: "Stopped before the plan finished",
    });
  });

  it("never fails a mission with the words a Stop pause now carries", () => {
    const summaries = (["new", "shutdown", "revoked", "unknown"] as const).map(
      (cause) => {
        const outcome = missionAbortOutcome(cause);
        return outcome.kind === "fail" ? outcome.summary : "";
      },
    );
    for (const summary of summaries) {
      expect(summary.length).toBeGreaterThan(0);
      expect(summary.toLowerCase()).not.toContain("stopped by you");
      expect(summary).not.toMatch(DASH);
      // D6: nothing this stage writes says a run was cut short.
      expect(summary).not.toMatch(/interrupted|cut off|unfinished/i);
    }
    // Four causes, four different sentences: the card says which one it was.
    expect(new Set(summaries).size).toBe(4);
  });
});
