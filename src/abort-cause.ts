/**
 * Why a Codex turn was aborted, and what that means for the chat's open
 * mission (P6 stage 3, C-32, spec 4.2 step 1).
 *
 * Every abort of a turn used to unwind the same way: the mission failed with
 * "Stopped by you.", so an owner who pressed Stop read Did not finish on the
 * card. The abort now carries its cause and the unwind reads it FIRST:
 *
 *  - `owner_stop`: the app's Stop button (the `stop_turn` frame) or the
 *    owner's `/stop`. The mission PAUSES with the contract's reason.
 *  - `new`: the owner's `/new`. The context is gone, so the plan is over.
 *  - `shutdown`: the daemon is stopping (`stop()`).
 *  - `revoked`: the fatal latch, a revoked or rotated pairing.
 *
 * Those three still FAIL, as they always did, each with its own words: with a
 * Stop now pausing under "Stopped by you", a `/new` failing with "Stopped by
 * you." would print the same words on a failed card.
 *
 * The reason is an Error named AbortError, exactly what a plain `abort()`
 * leaves, plus one own field. `signal.throwIfAborted()` throws the reason, the
 * host's run and the HOAI tools call it, and whatever catches it reads
 * `.message`; a bare object there would print "[object Object]".
 */

export type AbortCause = "owner_stop" | "new" | "shutdown" | "revoked";

/** What an abort reads as. `unknown` is any abort this module did not tag. */
export type AbortCauseRead = AbortCause | "unknown";

const CAUSES: readonly AbortCause[] = Object.freeze([
  "owner_stop",
  "new",
  "shutdown",
  "revoked",
]);

/** The words a failed mission carries, per cause. Never "Stopped by you". */
const FAIL_SUMMARIES: Readonly<Record<Exclude<AbortCauseRead, "owner_stop">, string>> =
  Object.freeze({
    new: "Started a new conversation before the plan finished",
    // Today's words for a shutdown, unchanged (mission-lane.ts DISPOSE_SUMMARY).
    shutdown: "Daemon stopped before the plan finished",
    revoked: "The pairing was revoked before the plan finished",
    unknown: "Stopped before the plan finished",
  });

export type MissionAbortOutcome =
  | { kind: "pause" }
  | { kind: "fail"; summary: string };

/**
 * Abort with a cause. The FIRST abort of a controller wins, as the platform
 * rules: a later abort (the turn's own cleanup, a second stop) changes
 * nothing about why the turn ended.
 */
export function abortWith(controller: AbortController, cause: AbortCause): void {
  controller.abort(
    Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
      bgosAbortCause: cause,
    }),
  );
}

/** The cause a signal was aborted with, or `unknown`. */
export function abortCauseOf(signal: AbortSignal): AbortCauseRead {
  if (!signal.aborted) return "unknown";
  const reason: unknown = signal.reason;
  if (typeof reason !== "object" || reason === null) return "unknown";
  if (!Object.prototype.hasOwnProperty.call(reason, "bgosAbortCause")) return "unknown";
  const cause = (reason as { bgosAbortCause?: unknown }).bgosAbortCause;
  return (CAUSES as readonly unknown[]).includes(cause)
    ? (cause as AbortCause)
    : "unknown";
}

/** Pause for an owner Stop; fail, with that cause's own words, for the rest. */
export function missionAbortOutcome(cause: AbortCauseRead): MissionAbortOutcome {
  if (cause === "owner_stop") return { kind: "pause" };
  return { kind: "fail", summary: FAIL_SUMMARIES[cause] ?? FAIL_SUMMARIES.unknown };
}
