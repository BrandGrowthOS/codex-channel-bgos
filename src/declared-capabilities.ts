/**
 * The capability tokens this daemon declares to BGOS.
 *
 * Carried on the heartbeat, which REPLACES the stored array wholesale, so this
 * is always the daemon's full current set and never a delta. The backend reads
 * it to decide which controls the owner is shown, so a token here is a promise
 * to the person holding the phone, not documentation.
 *
 * Every token must match the backend's CAPABILITY_TOKEN_REGEX
 * (/^[a-z][a-z0-9_]{0,63}$/) and the array must stay at 32 or fewer entries: a
 * token that fails either is a 400 on the whole heartbeat, which would take
 * daemon liveness down with it.
 */

/** This daemon hears the eight mission events and tells its model in band. */
export const MISSION_EVENTS = "mission_events";

/**
 * The owner's "Keep working until it is done" can really arm this runtime's
 * own loop. Declared from 0.8.0.
 *
 * Codex has a native thread goal: the host sets one from the mission, the app
 * server starts continuation turns by itself, and this daemon counts them,
 * holds the owner's turn cap and reports the stop. That is a real loop, which
 * is the only thing this token is allowed to mean.
 */
export const MISSION_GOAL_LOOP = "mission_goal_loop";

/**
 * A separate judge reads this agent's work and this daemon reports its
 * verdict. DELIBERATELY NOT DECLARED, and not a thing this channel is waiting
 * for either.
 *
 * Codex has no checker. Its goal loop ends when the MODEL itself decides the
 * condition holds, with no second opinion anywhere in the protocol: there is
 * no verdict object, no reason string and no field that could carry one.
 * Declaring this would put a "Checked" tag on the owner's card for a check
 * that never ran, which is exactly the thing stage 6 exists to prevent. Its
 * Done says the agent's word, and that is the truth.
 */
export const MISSION_GOAL_CHECKS = "mission_goal_checks";

/**
 * This daemon ENFORCES pause and resume. Declared from 0.8.0.
 *
 * Stage 5 held it back and said so: every turn was started by an owner
 * message, a click, a command, a scheduled wake or a meeting turn, so there
 * was nothing to suspend and a Pause button would have changed nothing the
 * owner could see. The native goal is the thing a pause can now really stop:
 * `paused` is one of the runtime's own goal states, it keeps the objective,
 * and the next continuation turn does not start. The token and the
 * enforcement ship in the same release, which is the only honest order.
 */
export const MISSION_PAUSE = "mission_pause";

export const DECLARED_CAPABILITIES: readonly string[] = Object.freeze([
  MISSION_EVENTS,
  MISSION_GOAL_LOOP,
  MISSION_PAUSE,
]);
