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
import {
  SESSIONS_LIBRARY,
  STOP_PAUSES_MISSION,
} from "./session-controls-contract.js";

import { REQUEST_REASON } from "./codex-capability-tokens.js";

/**
 * This daemon fills `approvalMeta.reason` from the model's `exec_command`
 * justification and `approvalMeta.rule_text` from the exec policy amendment
 * (P2 stage 5). Declared from the release that carries that code.
 *
 * The BGOS canon tells this daemon's agent "the host fills reason ... so
 * write the justification for the owner" ONLY when the daemon declares this
 * token, never by version: PR #16 of this repo is numbered 0.14.0 on the same
 * base without stage 5, and no PR can reserve a number, so a 0.13.0 floor
 * would have told a 0.14.0 daemon built from #16 something false. The
 * spelling lives in `codex-capability-tokens.ts`, a file copied byte for byte
 * from BGOS `backend/src/integrations/`, and both repos pin its sha256
 * (here: test/codex-capability-tokens.pin.spec.ts). Re-exported so the
 * declared list and its tests read one name.
 */
export { REQUEST_REASON };

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

/**
 * `stop_pauses_mission`, spelled by the contract file shared with BGOS and the
 * Claude plugin (P6 stage 3, C-32). Declared from 0.16.0.
 *
 * An owner Stop, the app's Stop button or `/stop`, PAUSES the chat's open
 * mission with the reason "Stopped by you" instead of failing it, and the
 * owner's next message in that chat resumes it. The abort carries its cause
 * (abort-cause.ts) and the mission lane does the pause and the resume.
 * BGOS serves the Codex canon's Stop sentence only to a daemon that declares
 * this, so the token ships in the same release as the code that keeps it.
 */
export { STOP_PAUSES_MISSION };

/**
 * `sessions_library`, spelled by the same contract file (P6 stage 3, C-32).
 * Declared from 0.16.0.
 *
 * This daemon answers list_sessions, resume_session and rename_session on
 * the control lane: the threads THIS HOAI chat has used (the set /resume
 * offers), resumed into the chat or renamed through the runtime's own
 * thread/name/set. BGOS shows the Sessions circle, and forwards a Sessions
 * request, only for a pairing that declares it, so the token ships in the
 * same release as the answers.
 */
export { SESSIONS_LIBRARY };

/**
 * This daemon answers `changes_rpc` (op `diff`, scope `uncommitted`) with
 * read only Git in its working folder. Declared from the release that ships
 * the handler (src/changes-handler.ts).
 *
 * The owner's Changes panel sends a frame only to a pairing that declared
 * this token, and shows "Update its BGOS connector" to one that has not. The
 * owner's per agent switch is enforced by the backend, never read here.
 */
export const CHANGES_RPC = "changes_rpc";

export const DECLARED_CAPABILITIES: readonly string[] = Object.freeze([
  MISSION_EVENTS,
  MISSION_GOAL_LOOP,
  MISSION_PAUSE,
  REQUEST_REASON,
  STOP_PAUSES_MISSION,
  SESSIONS_LIBRARY,
  CHANGES_RPC,
]);
