/**
 * keepalive-plan: the PURE decisions of the watcher's keep-alive sweep
 * (design sections 5 and 6, findings 7 to 9, gaps G1, G3, G5, G10).
 *
 * The sweep (lib/watcher-keepalive.mjs) reads the disk, the process table and
 * the backend, then asks THIS module what to do. Nothing here touches a file, a
 * process or the network, so every rule is a table in
 * test/keepalive-plan.test.ts and a one-line mutant of any guard turns a named
 * row red. The rules, in the order the sweep applies them per agent:
 *
 *   consent      only an id the backend cleared (always_on, this machine) is
 *                acted on, and only while the switch is on. A failed fetch
 *                falls back to a cached answer younger than 24 h, else OFF: the
 *                sweep pauses rather than act on stale consent (design 3.4, the
 *                second half of the G3 fix). A 401 or 403 is the backend refusing
 *                this watcher's pairing: OFF, never the cache.
 *   supervise    `none` + a known folder => install the product supervisor
 *                (G1, G7); no folder => needs_first_launch. NEVER over a
 *                bespoke or discovered job or a verified keepalive.json: a
 *                second supervisor racing the first is G11.
 *   pending      a canonical generation 1 supervisor => upgrade_pending
 *                (findings 7 and 8: v1 starts a fresh session and has no tmux,
 *                so no remote compact); running != installed => update_pending
 *                (G5); a daemon too old to publish its state is judged by time.
 *   safe moment  the design 6 table. Unknown is UNSAFE: a guard that fails open
 *                would kill a live job (finding 9, G10). A turn flag nothing
 *                has backed for 2 h (no activity, no job) is stale, not busy.
 *                The 10 min quiet window needs a state whose turnSignal is
 *                'hooks'; without it turnInFlight is unknown and the legacy 30
 *                min window applies (with the job scan, as for no state).
 *   task start   a Windows task whose launcher is dead is started at once
 *                when no session of the agent runs: no live daemon, and a
 *                process table that lists no claude of it. Only a table that
 *                cannot rule a session out (unreadable, or a daemon of record
 *                alive with no claude visible above it) keeps the 30 min
 *                quiet window (board row 69337efa). A start that waits is
 *                `waiting_idle` with its reason and, when known, restartAt.
 *   gates        1 restart per agent per 30 min, 3 attempts per target version
 *                then `failed` (visible, never a silent retry loop), 1 restart
 *                per sweep (a fleet converges one agent at a time), a failed
 *                install retried at most once an hour; a Windows task whose
 *                launcher is dead started at most once per 30 min and 3 times
 *                per death episode, then `failed task_start_failed`, and a
 *                start is that sweep's one restart.
 *   report       the heartbeat entry: waitingSince after 24 h of waiting_idle,
 *                and `pending` (update or upgrade) on every wait for one,
 *                which is what the app needs before it may offer Restart now
 *                (design 6, 13); and restartAt on a waiting task start.
 *
 * Plain JavaScript, node >= 18, no imports at all, import-safe.
 */

// -- Contract constants ---------------------------------------------------------------

/** ~/.bgos-plugin-state/<id>/agent-state.json, written by the daemon (design 7). */
export const AGENT_STATE_FILE_NAME = 'agent-state.json'
export const AGENT_STATE_SCHEMA_VERSION = 1
/** Fresh = written in the last 120 s by a live pid (design 6, first row). */
export const AGENT_STATE_FRESH_MS = 120_000
/** Quiet window when the daemon publishes its state WITH its hook turn signal. */
export const QUIET_WINDOW_MS = 10 * 60_000
/** agent-state.json `turnSignal`: 'hooks' once the daemon has accepted a hook
 *  event from its own session in this process; anything else (absent, 'none')
 *  means turnInFlight is not backed by hooks, so a false there is UNKNOWN. */
export const TURN_SIGNAL_HOOKS = 'hooks'
/** Quiet window for a daemon that publishes no state: it cannot say a turn is in
 *  flight, so silence has to be longer before it counts as idle. */
export const LEGACY_QUIET_WINDOW_MS = 30 * 60_000
/** <statedir>/launch-status: one line, `<stamp> outcome=<word> key=value ...`
 *  (bin/bgos-agent run.sh and bin/hoai-core.mjs launchStatusLine). */
export const LAUNCH_STATUS_FILE_NAME = 'launch-status'
/** run.sh's singleton wait rewrites launch-status every 5 s; a wait older than
 *  this is not one in progress (run.sh moved on, or died waiting). */
export const LAUNCH_STATUS_FRESH_MS = 120_000
/** A turn flag with NO activity from any source for this long, and no
 *  background job under claude, is stale: an interrupted turn (Esc, a crash
 *  mid tool) never gets its Stop hook, so the flag alone would hold the agent
 *  in waiting_idle forever. */
export const STALE_TURN_MS = 2 * 60 * 60_000
export const RESTART_MIN_INTERVAL_MS = 30 * 60_000
export const MAX_ATTEMPTS_PER_TARGET = 3
export const MAX_RESTARTS_PER_SWEEP = 1
/** Not in the design text: installs are not restarts, but each one runs
 *  `bun install`, so a fleet of seven installed in one sweep would block the
 *  watcher's job polling for minutes. One per sweep, same convergence idea. */
export const MAX_INSTALLS_PER_SWEEP = 1
export const INSTALL_RETRY_MS = 60 * 60_000
/** A Windows agent task whose launcher is dead gets the restart limits (a
 *  `schtasks /Run` IS the restart there): one start per agent per 30 min ... */
export const TASK_START_MIN_INTERVAL_MS = RESTART_MIN_INTERVAL_MS
/** ... and 3 per launcher death episode, then `failed task_start_failed`. */
export const MAX_TASK_STARTS_PER_EPISODE = MAX_ATTEMPTS_PER_TARGET
/** A launcher that has stayed alive this long ends its death episode. */
export const LAUNCHER_STABLE_MS = 10 * 60_000
/** After this long in waiting_idle the heartbeat carries waitingSince and the app
 *  offers Restart now (design 6, "or ask", decision D6). */
export const WAITING_ASK_AFTER_MS = 24 * 60 * 60_000
/** ~/.bgos-agent/watcher/keepalive.json older than this is not consent (design 3.4). */
export const KEEPALIVE_CACHE_MAX_AGE_MS = 24 * 60 * 60_000
export const KEEPALIVE_CACHE_SCHEMA_VERSION = 1
/** <statedir>/supervisor-generation of a v2 supervisor; absent means 1. */
export const SUPERVISOR_GENERATION_CURRENT = 2
export const UPGRADE_TARGET = 'supervisor-generation-2'
/** The backend bounds every heartbeat string (design 8). */
export const REPORT_STRING_MAX = 120

export const AGENT_STATES = Object.freeze([
  'supervised',
  'installing',
  'needs_first_launch',
  'upgrade_pending',
  'update_pending',
  'waiting_idle',
  'restarted',
  'failed',
])

export const UNSAFE_REASONS = Object.freeze([
  'turn_in_flight',
  'pending_messages',
  'pending_permission',
  'background_job',
  'recent_activity',
  'process_tree_unreadable',
])

// -- Small helpers ---------------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+[-\w.]*$/
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A pid worth signalling or probing: an integer above 1 (pid 1 is init). */
function pidOf(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : null
}

function countOf(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function digitsId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim()
  return null
}

function msOf(value) {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function clip(value, max = REPORT_STRING_MAX) {
  const text = String(value ?? '')
  return text.length > max ? text.slice(0, max) : text
}

// -- agent-state.json (design 7) ------------------------------------------------------------

/**
 * @typedef {{
 *   assistantId: string, pid: number, claudePid: number | null,
 *   runningVersion: string | null, pendingRestartVersion: string | null,
 *   turnInFlight: boolean, pendingMessages: number, pendingPermissions: number,
 *   activeOperations: number, lastActivityAtMs: number | null, sessionId: string | null,
 *   updatedAtMs: number, turnSignal: 'hooks' | 'none',
 * }} AgentState
 */

/**
 * Parse the daemon's published state, FAIL CLOSED: any malformed load-bearing
 * field makes the whole file null, which the sweep reads as "this daemon
 * publishes no state" and judges by the stricter legacy rules (30 min quiet,
 * the process tree). A half-trusted file is worse than none: a missing
 * turnInFlight read as false would let a restart through mid turn.
 * @param {string | null | undefined} raw
 * @param {string | number | null} [expectedId]
 * @returns {AgentState | null}
 */
export function parseAgentState(raw, expectedId = null) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.schemaVersion !== AGENT_STATE_SCHEMA_VERSION) return null
  const assistantId = digitsId(parsed.assistantId)
  if (!assistantId) return null
  if (expectedId != null && assistantId !== String(expectedId)) return null
  const pid = pidOf(parsed.pid)
  if (pid === null) return null
  const claudePid = parsed.claudePid == null ? null : pidOf(parsed.claudePid)
  if (parsed.claudePid != null && claudePid === null) return null
  if (typeof parsed.turnInFlight !== 'boolean') return null
  const pendingMessages = countOf(parsed.pendingMessages)
  const pendingPermissions = countOf(parsed.pendingPermissions)
  const activeOperations = countOf(parsed.activeOperations)
  if (pendingMessages === null || pendingPermissions === null || activeOperations === null) return null
  const updatedAtMs = msOf(parsed.updatedAt)
  if (updatedAtMs === null) return null
  const lastActivityAtMs = parsed.lastActivityAt == null ? null : msOf(parsed.lastActivityAt)
  if (parsed.lastActivityAt != null && lastActivityAtMs === null) return null
  const version = (v) => (typeof v === 'string' && VERSION_RE.test(v.trim()) ? v.trim() : null)
  const sessionId = typeof parsed.sessionId === 'string' && UUID_RE.test(parsed.sessionId.trim()) ? parsed.sessionId.trim() : null
  return {
    assistantId,
    pid,
    claudePid,
    runningVersion: version(parsed.runningVersion),
    pendingRestartVersion: version(parsed.pendingRestartVersion),
    turnInFlight: parsed.turnInFlight,
    pendingMessages,
    pendingPermissions,
    activeOperations,
    lastActivityAtMs,
    sessionId,
    updatedAtMs,
    // Not load-bearing for the parse (a daemon from before the field is still
    // a state), but it decides which quiet window applies: only the exact word
    // vouches for turnInFlight.
    turnSignal: parsed.turnSignal === TURN_SIGNAL_HOOKS ? TURN_SIGNAL_HOOKS : 'none',
  }
}

/**
 * Fresh = updatedAt within 120 s (either side, so a clock jump cannot make an
 * old file look new) AND the writing daemon is alive. A stale file from a dead
 * daemon would otherwise vouch for an idle agent that is in fact mid turn under
 * a NEW daemon that has not written yet.
 * @param {AgentState | null} state
 * @param {{ now: number, pidAlive: (pid: number) => boolean }} probe
 */
export function isAgentStateFresh(state, { now, pidAlive }) {
  if (!state) return false
  if (Math.abs(now - state.updatedAtMs) > AGENT_STATE_FRESH_MS) return false
  return Boolean(pidAlive(state.pid))
}

// -- The pairing lock (a daemon of any version, lib/pairing-lock.ts) ------------------------------

/** The holder refreshes its heartbeat every 5 s and a rival reclaims it after
 *  15 s (lib/pairing-lock.ts). A minute is generous on purpose: this only ever
 *  says "a session of this agent runs", and erring that way waits, never acts. */
export const PAIRING_LOCK_FRESH_MS = 60_000

/**
 * `<credentials>.lock` (mirror of lib/pairing-lock.ts parseLockRecord, which the
 * plain-JS watcher bundle cannot import): {pid, heartbeatAt, bootedAt?}, else null.
 * @param {string | null | undefined} raw
 * @returns {{ pid: number, heartbeatAt: number } | null}
 */
export function parsePairingLock(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const pid = Number(parsed.pid)
  const heartbeatAt = Number(parsed.heartbeatAt)
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!Number.isFinite(heartbeatAt) || heartbeatAt < 0) return null
  return { pid, heartbeatAt }
}

// -- The background job marker (finding 9) ---------------------------------------------------

/**
 * Claude Code runs every Bash and Monitor tool command as
 * `$SHELL -c source <config>/shell-snapshots/snapshot-...`, a child of the
 * claude process that outlives the turn when backgrounded (measured
 * 2026-10-06: every Bash tool process carries it, MCP servers never do).
 * Either slash style, case-insensitively: a Windows path may be spelled
 * either way, and over-matching only ever makes the sweep WAIT.
 * @param {string | null | undefined} command
 */
export function isBackgroundJobCommand(command) {
  if (typeof command !== 'string' || !command) return false
  return /shell-snapshots[\\/]+snapshot-/i.test(command)
}

// -- The safe moment (design 6) --------------------------------------------------------------

/**
 * @param {{
 *   running: boolean | null,           // false only when the agent is surely not running
 *   stateFresh: boolean,
 *   state: AgentState | null,
 *   descendants: string[] | null,      // the claude descendants' command lines; null = unreadable
 *   activityMs: Array<number | null | undefined>,  // lastActivityAt, events.jsonl mtime, transcript mtime
 *   now: number,
 * }} input
 * @returns {{ safe: boolean, reason: string }}
 */
export function decideSafeMoment(input) {
  // Restarting an agent that is not running is starting it.
  if (input.running === false) return { safe: true, reason: 'not_running' }
  const fresh = input.stateFresh === true && input.state ? input.state : null
  let staleTurn = false
  if (fresh) {
    if (fresh.turnInFlight) {
      // Only PROVABLY stale is stale: every activity source quiet for 2 h and
      // a readable tree with no job in it. Then the turn flag stops counting,
      // and every other check below still runs, so a stale turn hides no owed
      // reply or job and leads to the normal restart path, never a kill.
      staleTurn = isStaleTurn(input)
      if (!staleTurn) return { safe: false, reason: 'turn_in_flight' }
    }
    if (fresh.pendingMessages > 0) return { safe: false, reason: 'pending_messages' }
    if (fresh.pendingPermissions > 0) return { safe: false, reason: 'pending_permission' }
    // "a delivery is running" has no reason of its own in the design 6 table;
    // a delivery in flight is a message on its way, so it reports as one.
    if (fresh.activeOperations > 0) return { safe: false, reason: 'pending_messages' }
  }
  // Unknown running state, or a claude whose descendants could not be listed:
  // UNSAFE. Failing open here is exactly the kill finding 9 forbids.
  if (input.running !== true || !Array.isArray(input.descendants)) {
    return { safe: false, reason: 'process_tree_unreadable' }
  }
  if (input.descendants.some(isBackgroundJobCommand)) return { safe: false, reason: 'background_job' }
  // The short window trusts turnInFlight=false, which only a daemon that has
  // seen its own session's hook events can say (turnSignal 'hooks'). Without
  // that signal the turn is UNKNOWN (a marketplace install or custom config dir
  // whose hooks never reach the daemon): the legacy rule, 30 minutes of quiet
  // plus the job scan above, exactly as for a daemon that publishes nothing.
  const window = fresh && fresh.turnSignal === TURN_SIGNAL_HOOKS ? QUIET_WINDOW_MS : LEGACY_QUIET_WINDOW_MS
  const stamps = activityStamps(input.activityMs)
  if (stamps.length > 0) {
    const newest = Math.max(...stamps)
    // A stamp in the future (clock skew) reads as recent: waiting is the safe error.
    if (input.now - newest < window) return { safe: false, reason: 'recent_activity' }
  }
  return { safe: true, reason: staleTurn ? 'stale_turn' : 'idle' }
}

/** A restart marker younger than this is someone's PENDING request: a person's,
 *  or one the daemon's takeover still owes (stranded after 15 s, the session up
 *  60 s, the helper's claim seconds later). Older, it is stranded for good. */
export const MARKER_PENDING_MS = 5 * 60_000

/**
 * Is the session this restart was judged on still the one that runs, and old
 * enough? Asked right before the act, after the last await of the sweep (agent
 * 909, 2026-10-12 17:17:10): the sweep read the OLD daemon's state, awaited the
 * process listing, and meanwhile a person's marker restarted claude; the
 * sweep's '{}' then landed on the brand new session and restarted it again.
 * A fresh start never requests another restart:
 *   - the daemon judged is not the live one (another one, or none yet during a
 *     keep-alive backoff): fresh_start;
 *   - the launcher started claude (launch.json startedAt, rewritten before
 *     every launch since 0.44) or the newest claude started inside the quiet
 *     window the safe moment used: fresh_start;
 *   - on the marker tier only, a PENDING marker (under MARKER_PENDING_MS old
 *     and not older than this session) is never rewritten:
 *     restart_already_requested. A stranded one is rewritten, so a takeover
 *     sees a fresh request; another tier does not go through the marker.
 * A stamp in the future reads as recent; an unknown pid or stamp proves
 * nothing either way.
 * @param {{ now: number, windowMs: number, judgedDaemonPid: number | null, liveDaemonPid: number | null,
 *   launchStartedAtMs: number | null, newestClaudeStartedAtMs: number | null,
 *   markerMtimeMs: number | null, markerTier: boolean }} input
 * @returns {{ proceed: true } | { proceed: false, reason: 'restart_already_requested' | 'fresh_start' }}
 */
export function decideFreshStart(input) {
  const judged = input.judgedDaemonPid
  if (Number.isInteger(judged) && input.liveDaemonPid !== judged) return { proceed: false, reason: 'fresh_start' }
  for (const at of [input.launchStartedAtMs, input.newestClaudeStartedAtMs]) {
    if (typeof at === 'number' && Number.isFinite(at) && input.now - at < input.windowMs) return { proceed: false, reason: 'fresh_start' }
  }
  const marker = input.markerMtimeMs
  if (input.markerTier && typeof marker === 'number' && Number.isFinite(marker)) {
    const session = input.launchStartedAtMs
    const afterSession = !(typeof session === 'number' && Number.isFinite(session)) || marker >= session
    if (input.now - marker < MARKER_PENDING_MS && afterSession) return { proceed: false, reason: 'restart_already_requested' }
  }
  return { proceed: true }
}

/** The activity stamps that are real instants. */
function activityStamps(activityMs) {
  return (Array.isArray(activityMs) ? activityMs : []).filter((ms) => typeof ms === 'number' && Number.isFinite(ms))
}

/**
 * A turn flag nothing has backed for STALE_TURN_MS. Unknown is NOT stale: no
 * activity evidence at all, or a process tree that could not be read, keeps
 * the turn (failing open here would restart mid turn).
 * @param {{ descendants: string[] | null, activityMs: Array<number | null | undefined>, now: number }} input
 */
function isStaleTurn(input) {
  if (!Array.isArray(input.descendants) || input.descendants.some(isBackgroundJobCommand)) return false
  const stamps = activityStamps(input.activityMs)
  if (stamps.length === 0) return false
  return input.now - Math.max(...stamps) >= STALE_TURN_MS
}

// -- Pending restart (design 5 step 2) ---------------------------------------------------------

/**
 * @param {{
 *   canonical: boolean,               // installed by bin/bgos-agent (or the watcher's agent task)
 *   generation: number | null,        // <statedir>/supervisor-generation, absent = 1, canonical only
 *   stateFresh: boolean,
 *   runningVersion: string | null,
 *   pendingRestartVersion: string | null,
 *   installedVersion: string | null,
 *   claudeStartedAtMs: number | null,
 *   installLandedAtMs: number | null,
 * }} input
 * @returns {{ kind: 'upgrade_pending' | 'update_pending', target: string, reason: string } | null}
 */
export function decidePendingRestart(input) {
  // First: the reinstall that an upgrade is also restarts onto the installed
  // version, so one restart closes both gaps.
  if (input.canonical && typeof input.generation === 'number' && input.generation < SUPERVISOR_GENERATION_CURRENT) {
    return { kind: 'upgrade_pending', target: UPGRADE_TARGET, reason: 'supervisor_generation_1' }
  }
  if (input.stateFresh) {
    // A fresh daemon is the answer (review daemon F7): it reads
    // installed_plugins.json from ITS own config dir, while the watcher's
    // installedVersion may come from another one (its own ~/.claude when no
    // launch recipe names the agent's). null means nothing to restart onto,
    // and a named version is the target. A version equal to the running one
    // would restart onto the same code, so it is nothing too.
    const pending = input.pendingRestartVersion || null
    if (pending && pending !== input.runningVersion) {
      return { kind: 'update_pending', target: pending, reason: 'running_differs_from_installed' }
    }
    return null
  }
  // A stale or missing state cannot answer: the watcher's own reading of the
  // installed version is the fallback, judged by time below.
  // A daemon too old to publish its state: judged by time. Its claude started
  // before the installed version landed, so it is still running the old one.
  const started = input.claudeStartedAtMs
  const landed = input.installLandedAtMs
  if (typeof started === 'number' && Number.isFinite(started) && typeof landed === 'number' && Number.isFinite(landed) && started < landed) {
    return { kind: 'update_pending', target: input.installedVersion || `landed:${landed}`, reason: 'started_before_install' }
  }
  return null
}

// -- A hand-run session behind the canonical supervisor (decision D4) ---------------------------------

/**
 * The outcome word of a launch-status file, read from its FIRST line only
 * (the file is one line by contract), or null.
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function parseLaunchStatusOutcome(raw) {
  if (typeof raw !== 'string' || !raw) return null
  const line = raw.split(/\r?\n/)[0] ?? ''
  const match = /(?:^|\s)outcome=([A-Za-z0-9_.-]+)(?=\s|$)/.exec(line)
  return match ? match[1] : null
}

/**
 * Is the agent's claude a session a PERSON started by hand, with the canonical
 * supervisor waiting behind it? run.sh's singleton wait says so itself,
 * rewriting launch-status (`outcome=waiting-for-incumbent`) every 5 s while it
 * waits (decision D4: install now, take over when the manual session ends).
 * Such a claude has no launcher of ours above it: a service restart restarts
 * only the WAITING run.sh (nothing restarts, verify fails, 3 sweeps later the
 * agent reads `failed`), and the only other lever is a kill of a session
 * someone may be typing in. So the update waits, spends no attempt, and lands
 * by itself: the supervisor takes over on the installed version the moment the
 * person's session ends. A live hoai launcher (the marker restarts claude in
 * place) or a verified keepalive (its loop relaunches claude) is NOT a plain
 * hand-run session; those restart the normal way at a safe moment.
 * @param {{ canonical: boolean, launcherLive: boolean, keepaliveVerified: boolean,
 *   statusOutcome: string | null, statusAgeMs: number | null }} input
 * @returns {boolean}
 */
export function decideManualSession(input) {
  if (input.canonical !== true || input.launcherLive === true || input.keepaliveVerified === true) return false
  if (input.statusOutcome !== 'waiting-for-incumbent') return false
  return typeof input.statusAgeMs === 'number' && Math.abs(input.statusAgeMs) <= LAUNCH_STATUS_FRESH_MS
}

// -- A failed agent stays failed until something proves it is up (board row 84296679, fix 4) -------

/** launch-status outcomes that mean the launch did NOT come up (bin/bgos-agent run.sh, bin/hoai-core.mjs). */
const FAILED_LAUNCH_OUTCOMES = new Set([
  'exited-during-startup',
  'plugin-root-missing',
  'node-missing',
  'live-but-not-signed-in',
  'identity-mismatch',
  'no-live-marker',
])
/** A launch-status older than this is not a loop in progress. */
export const LAUNCH_FAILING_FRESH_MS = 15 * 60_000
/** Consecutive fast fails (run.sh's failcount) that make a launch loop a crash loop. */
export const CRASH_LOOP_FAILS = 3

/**
 * Does an agent that LOOKS supervised (its unit file is there, nothing is
 * pending) still have to read `failed`? kc-server, 2026-10-12, agent 871:
 * 10:42:33 verify FAILED (agent_deaf_after_restart) and the record said
 * `failed`; 26 s later the NEXT sweep classified the same agent by its unit
 * file alone (generation 2, canonical-file) and wrote `supervised (canonical)`
 * while claude crash looped. A failure is not undone by a quiet sweep: it
 * holds until something PROVES the agent up, and the proofs are the same ones
 * the sweep already trusts: a fresh published state (a live daemon), or a
 * claude of this agent running now. A launch that is itself failing (run.sh's
 * launch-status, or three fast fails) is `failed` even with no earlier record.
 *
 * `claudeRunning` is true, false, or null (the process table could not be
 * read): only a false lets the hold stand, so an unreadable table never turns
 * a healthy agent red.
 * @param {{ prevState?: string | null, prevReason?: string | null, fresh: boolean,
 *   claudeRunning: boolean | null, launchOutcome: string | null, failCount: number | null,
 *   statusAgeMs: number | null }} input
 * @returns {{ state: 'failed', reason: string } | null}
 */
export function decideHeldFailure(input) {
  if (input.fresh === true) return null
  if (input.claudeRunning !== false) return null
  if (input.prevState === 'failed' && typeof input.prevReason === 'string' && input.prevReason) {
    return { state: 'failed', reason: input.prevReason }
  }
  const outcome = typeof input.launchOutcome === 'string' ? input.launchOutcome : null
  const statusFresh = typeof input.statusAgeMs === 'number' && Math.abs(input.statusAgeMs) <= LAUNCH_FAILING_FRESH_MS
  if (!statusFresh) return null
  const failedOutcome = outcome !== null && (FAILED_LAUNCH_OUTCOMES.has(outcome) || outcome.startsWith('gate-'))
  if (failedOutcome) return { state: 'failed', reason: `launch_failing:${outcome}` }
  if (typeof input.failCount === 'number' && input.failCount >= CRASH_LOOP_FAILS) {
    return { state: 'failed', reason: 'launch_failing:fast_fails' }
  }
  return null
}

// -- Supervise (design 5 step 1) ----------------------------------------------------------------

/**
 * @param {{ cleared: boolean, supervisor: 'service' | 'launcher-live' | 'none',
 *   serviceVia: string | null, keepaliveVerified: boolean, keepaliveDeclared?: boolean,
 *   cwd: string | null }} input
 * @returns {{ action: 'install' | 'none', state: string | null, reason: string | null }}
 */
export function decideSupervise(input) {
  // The second half of the G3 fix: never a supervisor for an agent the backend
  // has not marked always-on, or its own daemon removes it again.
  if (!input.cleared) return { action: 'none', state: null, reason: 'not_cleared' }
  // A bespoke keepalive already relaunches this agent; a second supervisor
  // would race it (G11), even when its launchd job is not discoverable. A
  // DECLARED one (script alive, its claude between two relaunches) counts
  // here too: the moment its claude is down is exactly when an install would
  // land beside the loop. Only a restart needs the full verification.
  if (input.keepaliveVerified || input.keepaliveDeclared) return { action: 'none', state: 'supervised', reason: 'keepalive' }
  if (input.supervisor === 'service') {
    return { action: 'none', state: 'supervised', reason: input.serviceVia === 'canonical-file' ? 'canonical' : 'bespoke' }
  }
  // A live hoai launcher is NOT a reason to stop here. A hoai started by hand relaunches claude when
  // asked, but nothing brings IT back after a reboot or a closed terminal, so the agent still has no
  // supervisor in the sense of design 5 step 1 (the daemon's own reconcile applies the same rule:
  // lib/always-on-reconcile.ts). The service installed here waits behind the live session (run.sh's
  // singleton wait) and takes over when it ends, resuming the same pinned session (finding 7).
  // Measured in the M6 end to end run: this branch used to answer 'supervised (launcher)' and the
  // agent would not have come back after a reboot.
  if (input.supervisor !== 'none' && input.supervisor !== 'launcher-live') {
    return { action: 'none', state: 'supervised', reason: 'unknown_supervisor' }
  }
  const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : ''
  if (!cwd) return { action: 'none', state: 'needs_first_launch', reason: 'no_known_folder' }
  return { action: 'install', state: 'installing', reason: null }
}

/**
 * A Windows agent task runs hoai-core --keep-alive, which relaunches claude by
 * itself; the sweep starts the TASK only when that launcher is dead (design 4,
 * Windows bullet), and never beside a session of the agent:
 *   running      its live daemon (a fresh state, a held pairing lock) says one runs;
 *   sessionSeen  the process table's own answer (lib/process-tree.mjs
 *                findAgentClaudePids): true when a claude of the agent is
 *                listed, false when the table was read and rules one out,
 *                null (or absent) when it could not be read or rules nothing
 *                out (a daemon of record alive with no claude above it).
 * A table that rules the session out starts a crashed agent AT ONCE (board row
 * 69337efa): its activity stamps are then the dead session's own last writes,
 * and reading them as "maybe a session this watcher cannot see" kept agent 1078
 * down for 30 minutes. Only a table that rules nothing out keeps that rule:
 * there is no cwd lookup on Windows, so recent activity counts as "maybe
 * running".
 * @param {{ platform: string, canonicalTask: boolean, launcherLive: boolean,
 *   running: boolean | null, recentActivity: boolean, sessionSeen?: boolean | null }} input
 */
export function decideTaskStart(input) {
  if (input.platform !== 'win32' || input.canonicalTask !== true || input.launcherLive === true) return false
  if (input.running !== false || input.sessionSeen === true) return false
  if (input.sessionSeen === false) return true
  return input.recentActivity !== true
}

/**
 * Why a Windows agent task whose launcher is dead is not started, and when it
 * can be, as the record the sweep writes: `waiting_idle`, never `supervised`,
 * since the agent is down and nothing runs it (board row 69337efa).
 * `restartAtMs` is the moment the start can run if nothing changes, null when
 * nobody can know it:
 *   session_without_launcher  a session of the agent runs without its launcher
 *                             (F4): the start waits for that session to end.
 *   quiet_window              the table rules nothing out and the agent was
 *                             active: 30 min after its newest stamp.
 * Null when nothing here holds the start (decideTaskStart says start; the
 * gates may still hold it).
 * @param {{ running: boolean | null, sessionSeen: boolean | null,
 *   activityMs: Array<number | null | undefined>, now: number }} input
 * @returns {{ state: 'waiting_idle', reason: string, restartAtMs: number | null } | null}
 */
export function taskStartWait(input) {
  if (input.running !== false || input.sessionSeen === true) return { state: 'waiting_idle', reason: 'session_without_launcher', restartAtMs: null }
  if (input.sessionSeen === false) return null
  const stamps = activityStamps(input.activityMs)
  if (stamps.length === 0) return null
  const newest = Math.max(...stamps)
  if (input.now - newest >= LEGACY_QUIET_WINDOW_MS) return null
  return { state: 'waiting_idle', reason: 'quiet_window', restartAtMs: newest + LEGACY_QUIET_WINDOW_MS }
}

/**
 * The bookkeeping of one launcher DEATH EPISODE on a Windows agent task: the
 * task starts spent on it (`taskStarts`) and since when the launcher has been
 * seen alive without a break (`launcherAliveSince`). An episode ends only once
 * the launcher has STAYED alive LAUNCHER_STABLE_MS: one that comes back and
 * dies a minute later is the same failure, and resetting on every brief
 * revival would hand a crash loop a fresh 3 starts each time, which is the
 * unbounded `schtasks /Run` this exists to stop. Junk bookkeeping reads as none.
 * @param {Record<string, any> | null} prev
 * @param {{ launcherLive: boolean, now: number }} input
 * @returns {{ taskStarts: number, launcherAliveSince: string | null }}
 */
export function advanceLauncherEpisode(prev, { launcherLive, now }) {
  const base = isRecord(prev) ? prev : {}
  const taskStarts = countOf(base.taskStarts) ?? 0
  if (!launcherLive) return { taskStarts, launcherAliveSince: null }
  const aliveSinceMs = msOf(base.launcherAliveSince) ?? now
  return {
    taskStarts: now - aliveSinceMs >= LAUNCHER_STABLE_MS ? 0 : taskStarts,
    launcherAliveSince: new Date(aliveSinceMs).toISOString(),
  }
}

/**
 * May the sweep start a Windows agent task whose launcher is dead? The same
 * limits as an update restart (design 5): at most one start per agent per 30
 * min, at most 3 per death episode, then `failed task_start_failed`, visible
 * and never a silent `schtasks /Run` every minute; and, a start being this
 * platform's restart, the fleet's one restart per sweep. A start a limit holds
 * is a wait, said with when it can run (restartAtMs; null for the next sweep):
 * the agent is down meanwhile, so the row is `waiting_idle`, never
 * `supervised` (board row 69337efa; the task's own RestartCount only retries
 * an action of its own that failed, and this launcher was not one).
 * @param {{ now: number, lastTaskStartAtMs: number | null, taskStarts: number, restartsThisSweep?: number }} input
 * @returns {{ allowed: boolean, state: string, reason: string | null, restartAtMs?: number | null }}
 */
export function decideTaskStartGate(input) {
  if (input.taskStarts >= MAX_TASK_STARTS_PER_EPISODE) return { allowed: false, state: 'failed', reason: 'task_start_failed' }
  if (typeof input.lastTaskStartAtMs === 'number' && input.now - input.lastTaskStartAtMs < TASK_START_MIN_INTERVAL_MS) {
    return { allowed: false, state: 'waiting_idle', reason: 'task_start_rate_limited', restartAtMs: input.lastTaskStartAtMs + TASK_START_MIN_INTERVAL_MS }
  }
  if ((input.restartsThisSweep ?? 0) >= MAX_RESTARTS_PER_SWEEP) return { allowed: false, state: 'waiting_idle', reason: 'one_restart_per_sweep', restartAtMs: null }
  return { allowed: true, state: 'supervised', reason: null }
}

// -- Gates ---------------------------------------------------------------------------------------

/**
 * The agent's OWN restart limits: 3 attempts per target, then `failed`, and
 * one restart per 30 min. They are history, not a reading of the moment, so
 * the sweep judges them BEFORE the safe moment: a spent target is `failed`
 * whether or not the agent happens to be busy, instead of flipping between
 * waiting_idle (busy) and failed (idle) and resetting `since` at each flip,
 * which hid the failure and restarted the 24 h "or ask" clock.
 * @param {{ now: number, lastRestartAtMs: number | null, attempts: number, pendingKind: string }} input
 * @returns {{ allowed: boolean, state: string, reason: string | null }}
 */
export function decideRestartBudget(input) {
  if (input.attempts >= MAX_ATTEMPTS_PER_TARGET) return { allowed: false, state: 'failed', reason: 'attempts_exhausted' }
  if (typeof input.lastRestartAtMs === 'number' && input.now - input.lastRestartAtMs < RESTART_MIN_INTERVAL_MS) {
    return { allowed: false, state: input.pendingKind, reason: 'restart_rate_limited' }
  }
  return { allowed: true, state: input.pendingKind, reason: null }
}

/**
 * The full gate: the agent's own budget, then the fleet's one restart per
 * sweep. The sweep cap is a scheduling detail that changes every sweep, so the
 * sweep applies it only once the moment is safe: a busy agent keeps reporting
 * WHY it waits, rather than a passing one_restart_per_sweep.
 * @param {{ now: number, lastRestartAtMs: number | null, attempts: number,
 *   restartsThisSweep: number, pendingKind: string }} input
 * @returns {{ allowed: boolean, state: string, reason: string | null }}
 */
export function decideRestartGate(input) {
  const budget = decideRestartBudget(input)
  if (!budget.allowed) return budget
  if (input.restartsThisSweep >= MAX_RESTARTS_PER_SWEEP) return { allowed: false, state: input.pendingKind, reason: 'one_restart_per_sweep' }
  return budget
}

/**
 * @param {{ now: number, lastInstallAtMs: number | null, lastInstallError: string | null,
 *   installsThisSweep: number }} input
 * @returns {{ allowed: boolean, state: string, reason: string | null }}
 */
export function decideInstallGate(input) {
  if (typeof input.lastInstallAtMs === 'number' && input.now - input.lastInstallAtMs < INSTALL_RETRY_MS) {
    return input.lastInstallError
      ? { allowed: false, state: 'failed', reason: input.lastInstallError }
      : { allowed: false, state: 'installing', reason: 'install_retry_wait' }
  }
  if (input.installsThisSweep >= MAX_INSTALLS_PER_SWEEP) return { allowed: false, state: 'installing', reason: 'one_install_per_sweep' }
  return { allowed: true, state: 'installing', reason: null }
}

// -- Consent (design 3.4) -------------------------------------------------------------------------

/**
 * The computer's Keep agents running switch as the backend says it (board row
 * d133ddb2, a fixed list, never free text): on, off (the owner turned it off),
 * or never_set (no owner choice yet: Kc's choice 1, the first new agent there
 * turns it on). A backend that does not send `switchState` is read from
 * `enabled`, exactly as before: on, or off.
 */
export const KEEPALIVE_SWITCH_STATES = Object.freeze(['on', 'off', 'never_set'])

/**
 * The backend's answer, or null for anything that is not one. Ids become
 * digit strings (the watcher's inventory vocabulary), invalid entries dropped.
 * `enabled` is what the sweep acts on, so it decides the switch whenever it is
 * true; `never_set` is believed only with `enabled` false. `showAgentWindows`
 * is the owner's Show agent windows setting: true only when the backend sends
 * exactly true (absent, as from an older backend, is off).
 * @param {unknown} json
 * @returns {{ enabled: boolean, enabledAt: string | null, assistantIds: string[], switchState: 'on' | 'off' | 'never_set', showAgentWindows: boolean } | null}
 */
export function parseKeepAliveResponse(json) {
  if (!isRecord(json)) return null
  if (typeof json.enabled !== 'boolean') return null
  if (!Array.isArray(json.assistantIds)) return null
  const ids = [...new Set(json.assistantIds.map(digitsId).filter((id) => id !== null))].sort((a, b) => Number(a) - Number(b))
  return {
    enabled: json.enabled,
    enabledAt: typeof json.enabledAt === 'string' && json.enabledAt ? json.enabledAt : null,
    assistantIds: ids,
    switchState: json.enabled ? 'on' : json.switchState === 'never_set' ? 'never_set' : 'off',
    showAgentWindows: json.showAgentWindows === true,
  }
}

/** The cache file body (design 3.4 shape, plus the switch and the windows setting). */
export function buildKeepAliveCache(consent, now) {
  return `${JSON.stringify(
    {
      schemaVersion: KEEPALIVE_CACHE_SCHEMA_VERSION,
      enabled: Boolean(consent.enabled),
      enabledAt: consent.enabledAt ?? null,
      assistantIds: [...(consent.assistantIds ?? [])],
      switchState: KEEPALIVE_SWITCH_STATES.includes(consent.switchState) ? consent.switchState : consent.enabled ? 'on' : 'off',
      showAgentWindows: consent.showAgentWindows === true,
      fetchedAt: new Date(now).toISOString(),
    },
    null,
    2,
  )}\n`
}

/** @returns {{ enabled: boolean, enabledAt: string | null, assistantIds: string[], switchState: 'on' | 'off' | 'never_set', showAgentWindows: boolean, fetchedAtMs: number } | null} */
export function parseKeepAliveCache(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== KEEPALIVE_CACHE_SCHEMA_VERSION) return null
  const body = parseKeepAliveResponse(parsed)
  const fetchedAtMs = msOf(parsed.fetchedAt)
  if (!body || fetchedAtMs === null) return null
  return { ...body, fetchedAtMs }
}

/**
 * A refusal of the watcher's OWN credentials: the pairing was revoked (the
 * app's Disconnect, a re-enroll) or is no longer active. That is an answer,
 * not an outage: the cache bridges a network failure, a timeout, a 5xx or a
 * 404 (a backend that has not shipped the route), never a token the backend
 * has withdrawn, or a disconnected watcher kept acting for up to 24 h.
 * @param {number | null | undefined} status
 */
export function isConsentRefusal(status) {
  return status === 401 || status === 403
}

/** OFF, windows off: what a refusal and a missing answer both read as. */
const CONSENT_OFF = Object.freeze({ enabled: false, enabledAt: null, switchState: 'off', showAgentWindows: false })

/**
 * @param {{ live: ReturnType<typeof parseKeepAliveResponse>, cache: ReturnType<typeof parseKeepAliveCache>, now: number, refused?: boolean }} input
 * @returns {{ enabled: boolean, enabledAt: string | null, assistantIds: string[], switchState: 'on' | 'off' | 'never_set', showAgentWindows: boolean, source: 'live' | 'cache' | 'refused' | 'none' }}
 */
export function decideKeepAliveConsent({ live, cache, now, refused = false }) {
  const from = (answer, source) => ({
    enabled: answer.enabled,
    enabledAt: answer.enabledAt,
    assistantIds: [...answer.assistantIds],
    switchState: answer.switchState,
    showAgentWindows: answer.showAgentWindows,
    source,
  })
  if (live) return from(live, 'live')
  if (refused) return { ...CONSENT_OFF, assistantIds: [], source: 'refused' }
  if (cache && cache.fetchedAtMs <= now && now - cache.fetchedAtMs < KEEPALIVE_CACHE_MAX_AGE_MS) return from(cache, 'cache')
  return { ...CONSENT_OFF, assistantIds: [], source: 'none' }
}

/** Why create_agent launched a new agent the way it did (a fixed list; it rides the step message). */
export const CREATE_LAUNCH_REASONS = Object.freeze(['switch_on', 'never_set', 'switch_off', 'no_answer'])

/**
 * How create_agent starts a NEW agent (board row d133ddb2). Both ways are hidden; the difference is
 * whether it is kept running:
 *   supervised  the computer keeps its agents running, so create_agent installs and starts the
 *               product supervisor itself (the agent task on Windows, bin/bgos-agent install
 *               --always-on on Mac and Linux) instead of a one shot launch. Also for a computer
 *               never set (Kc's choice 1: the first new agent turns Keep agents running on there;
 *               the backend writes that default and adopts the agent when it checks in).
 *   once        a hidden one shot (lib/agent-restart.mjs recipe tier): the owner turned the
 *               switch off, or there is no answer to go on (no route, no cache, a refusal).
 * Decided on the switch alone, never on `assistantIds`: the backend lists an agent only once the
 * watcher's heartbeat has carried it, which a brand new agent's has not yet.
 * @param {ReturnType<typeof decideKeepAliveConsent> | null | undefined} consent
 * @returns {{ mode: 'supervised' | 'once', reason: 'switch_on' | 'never_set' | 'switch_off' | 'no_answer' }}
 */
export function decideCreateLaunch(consent) {
  if (!consent || consent.source === 'none' || consent.source === 'refused') return { mode: 'once', reason: 'no_answer' }
  if (consent.enabled === true) return { mode: 'supervised', reason: 'switch_on' }
  if (consent.switchState === 'never_set') return { mode: 'supervised', reason: 'never_set' }
  return { mode: 'once', reason: 'switch_off' }
}

// -- The installed version (design 5 step 2) --------------------------------------------------------

/**
 * The hoai plugin entry of <config>/plugins/installed_plugins.json: version,
 * path and when it landed (lastUpdated, else installedAt). The landing time is
 * the legacy rule's evidence. Prefers the `hoai@hoai` marketplace, then any
 * `hoai@<marketplace>`, and a scope:user record within an entry.
 * @param {string | null | undefined} raw
 * @returns {{ version: string | null, installPath: string | null, lastUpdatedMs: number | null } | null}
 */
export function parseInstalledPluginRecord(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(doc) || !isRecord(doc.plugins)) return null
  const keys = Object.keys(doc.plugins).filter((key) => key.startsWith('hoai@') && key.length > 'hoai@'.length)
  keys.sort((a, b) => (a === 'hoai@hoai' ? -1 : b === 'hoai@hoai' ? 1 : a < b ? -1 : a > b ? 1 : 0))
  for (const key of keys) {
    const value = doc.plugins[key]
    const records = Array.isArray(value) ? value.filter(isRecord) : isRecord(value) ? [value] : []
    const entry = records.find((r) => r.scope === 'user') ?? records[0]
    if (!entry) continue
    const version = typeof entry.version === 'string' && VERSION_RE.test(entry.version.trim()) ? entry.version.trim() : null
    const installPath = typeof entry.installPath === 'string' && entry.installPath.trim() ? entry.installPath.trim() : null
    const lastUpdatedMs = msOf(entry.lastUpdated) ?? msOf(entry.installedAt)
    return { version, installPath, lastUpdatedMs }
  }
  return null
}

// -- Bookkeeping and the heartbeat entry (design 8) -----------------------------------------------------

/**
 * Move an agent's record to its new state. `since` holds while the state holds
 * (the reason may change under it) and resets on a change; every other field
 * (attempts, lastRestartAt, lastInstallAt ...) rides along untouched, except
 * `restartAt`: when a waiting start can run belongs to THAT wait (board row
 * 69337efa), so it is set from `restartAtMs` and dropped by every other move.
 * @param {Record<string, any> | null} prev
 * @param {{ state: string, reason: string | null, restartAtMs?: number | null }} next
 * @param {number} now
 * @returns {Record<string, any>}
 */
export function advanceAgentRecord(prev, { state, reason, restartAtMs = null }, now) {
  const base = { ...(isRecord(prev) ? prev : {}) }
  delete base.restartAt
  const since = base.state === state && typeof base.since === 'string' ? base.since : new Date(now).toISOString()
  const record = { ...base, state, reason: reason ?? null, since }
  const restartAt = typeof restartAtMs === 'number' ? new Date(restartAtMs) : null
  if (restartAt && Number.isFinite(restartAt.getTime())) record.restartAt = restartAt.toISOString()
  return record
}

/**
 * The waits a plain restart cannot end, so their entry names no pending kind
 * and the app offers no Restart now (review 3 F3). Both can be written on the
 * record that carries the update's target (lib/watcher-keepalive.mjs), so the
 * target alone read `update` after 24 h like any busy agent:
 *   manual_session            D4: a person's own claude behind the canonical
 *                             supervisor; nothing of ours restarts it, and the
 *                             design never offers Restart now for it.
 *   session_without_launcher  its Windows twin: the task's launcher is dead
 *                             while the agent's claude still runs (a live
 *                             daemon, or, board row 69337efa, a claude of the
 *                             agent the process table lists), with or without
 *                             an update waiting. A task start beside it would
 *                             be a second session on the pin; the task tier
 *                             itself refuses (lib/agent-restart.mjs) only for
 *                             as long as a daemon lives.
 * Both end on their own when that session ends, and the update lands then.
 */
const RESTART_CANNOT_END_WAITS = new Set(['manual_session', 'session_without_launcher'])

/**
 * The other waits of a Windows agent task whose launcher is dead (board row
 * 69337efa): the agent is down, and the task start that ends the wait lands
 * any staged update with it, so they wait for no restart onto anything and
 * name no pending kind (no Restart now), whatever an earlier update left in
 * the record's target. The update path never writes them on waiting_idle.
 */
const TASK_START_WAITS = new Set(['quiet_window', 'task_start_rate_limited', 'one_restart_per_sweep'])

/**
 * What a waiting or pending agent waits to restart onto (design 6 and 13): an
 * `update` or the generation 2 `upgrade`, null for every other state. The app
 * offers Restart now only for `update` (frontend machineModel.ts
 * canRestartNow), because Restart now is a plain restart, and for the upgrade
 * a plain restart of a generation 1 job comes back in a FRESH session (finding
 * 7). A waiting_idle record says nothing else that tells the two apart, so its
 * target decides (every wait the sweep writes carries it); the pending states
 * name their own kind, since upgrade_pending supervisor_v2_unavailable and
 * no_known_folder are written on the record as it was, which can still carry
 * an earlier update's target. No target: null, the safe side (no button).
 * A wait a plain restart cannot end is null too (review 3 F3,
 * RESTART_CANNOT_END_WAITS), whatever its target says.
 * @param {{ state?: string, reason?: string | null, target?: unknown }} record
 * @returns {'update' | 'upgrade' | null}
 */
export function pendingKindOf(record) {
  if (record.state === 'upgrade_pending') return 'upgrade'
  if (record.state === 'update_pending') return 'update'
  if (record.state !== 'waiting_idle' || typeof record.target !== 'string' || !record.target) return null
  if (RESTART_CANNOT_END_WAITS.has(record.reason) || TASK_START_WAITS.has(record.reason)) return null
  return record.target === UPGRADE_TARGET ? 'upgrade' : 'update'
}

/**
 * The heartbeat's per agent entry: {id, state, reason?, since, waitingSince?,
 * pending?, restartAt?}, every string bounded to 120 characters (the backend
 * DTO bound). `restartAt` (board row 69337efa) is when a waiting Windows task
 * start can run: on waiting_idle only, re-serialised as an ISO time, so no
 * path or free text can ride it.
 * @param {string} id
 * @param {{ state: string, reason?: string | null, since?: string, target?: string, restartAt?: string }} record
 * @param {number} now
 * @returns {{ id: string, state: string, reason?: string, since?: string, waitingSince?: string, pending?: 'update' | 'upgrade', restartAt?: string }}
 */
export function reportEntry(id, record, now) {
  const entry = { id: clip(id), state: clip(record.state) }
  if (record.reason) entry.reason = clip(record.reason)
  if (record.since) entry.since = clip(record.since)
  const sinceMs = msOf(record.since)
  if (record.state === 'waiting_idle' && sinceMs !== null && now - sinceMs >= WAITING_ASK_AFTER_MS) {
    entry.waitingSince = clip(record.since)
  }
  const pending = pendingKindOf(record)
  if (pending) entry.pending = pending
  const restartAtMs = msOf(record.restartAt)
  if (record.state === 'waiting_idle' && restartAtMs !== null) entry.restartAt = new Date(restartAtMs).toISOString()
  return entry
}
