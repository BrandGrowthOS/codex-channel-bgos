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
 * This daemon ENFORCES pause and resume. Deliberately NOT declared here.
 *
 * Codex has no autonomous loop on this channel: every turn is started by an
 * owner message, a click, a command, a scheduled wake or a meeting turn, so
 * there is nothing to suspend. What this release does do is honest but
 * invisible: a paused mission stops taking progress writes and is not closed
 * at turn end. Stage 6 turns this token on together with the native goal lane.
 */
export const MISSION_PAUSE = "mission_pause";

export const DECLARED_CAPABILITIES: readonly string[] = Object.freeze([
  MISSION_EVENTS,
]);
