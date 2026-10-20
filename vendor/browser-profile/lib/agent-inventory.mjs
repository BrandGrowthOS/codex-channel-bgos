/**
 * agent-inventory: which HOAI agents live on this machine, and how each one
 * can be restarted (the per-machine watcher plans against this; bin/hoai-core
 * writes the launch recipe it reads).
 *
 * Two state dirs, never mixed up (design 7.1):
 *   ~/.bgos-agent/                    credentials-<id>.json (SECRET, never read
 *                                     here beyond its NAME), machine-id, watcher/
 *   ~/.bgos-agent/<id>/               supervisor.json, restart-requested.json,
 *                                     session-id, launch.json (the recipe),
 *                                     probe-requested.json, service.json (the
 *                                     daemon's own resolved supervising job,
 *                                     re-verified live before the watcher
 *                                     uses it)
 *   ~/.bgos-plugin-state/<id>/        channel-live.json (the liveness proof),
 *                                     chat-cursors.json (override root via
 *                                     BGOS_PLUGIN_STATE_DIR; key = the id when
 *                                     it matches ^[A-Za-z0-9_-]{1,64}$, else a
 *                                     cwd hash; mirror of lib/cursor-store.ts)
 *
 * Restart authorities (mirror of lib/update-readiness.ts detectSupervision,
 * restated here in plain JS because the watcher runs under bare node from a
 * bundle copied out of the plugin and must not import TS). The two sides no
 * longer restate the SERVICE tier: they both call lib/service-supervision.mjs,
 * so the part that used to drift silently is now one implementation, and
 * test/service-supervision.test.ts pins the two entry points against each
 * other on a shared table.
 *   'service'        a launchd job / systemd --user unit that supervises this
 *                    agent: the canonical bin/bgos-agent name if it is
 *                    installed, otherwise whichever LOADED job the platform
 *                    reports whose launch recipe names this agent
 *   'launcher-live'  a supervisor.json whose pid is ALIVE, is still the
 *                    launcher that wrote it, and declares the relaunch capability
 *                    (bin/hoai-core.mjs supervise loop; isLiveHoaiLauncher)
 *   'none'           nothing; a recipe (launch.json) may still relaunch it
 *
 * Four facts ride beside the tier for the keep-alive sweep (design 4 and 5):
 *   keepalive             a VERIFIED ~/.bgos-agent/<id>/keepalive.json (a bespoke
 *                         keepalive script, this Mac's ai.bgos.session.<id>): the
 *                         restart is a SIGTERM to its claude, and the sweep never
 *                         adds a second supervisor beside it (G11)
 *   keepaliveDeclared     that marker parses and its script is alive, its claude
 *                         maybe dead between two relaunches: enough to install
 *                         NOTHING beside it (G11), never enough to aim a SIGTERM
 *   supervisorGeneration  <statedir>/supervisor-generation of a CANONICAL service
 *                         (absent = 1: run.expect, a fresh session, no tmux, so
 *                         findings 7 and 8; the sweep upgrades it), null otherwise
 *   launcherLive          the hoai launcher's supervisor.json is live, whatever
 *                         tier won: on Windows it decides marker vs schtasks /Run
 * On Windows the canonical service is the per-agent logon Scheduled Task
 * "HOAI Agent <id> home-<hid>" (lib/agent-task-win32.mjs), found by its
 * run-agent.vbs in the agent's state dir, exactly as the posix tier finds its
 * plist or unit (G7).
 *
 * Every per-agent service name carries the HOME it was installed from (board
 * row d6198bb6), as #237 made the watcher's: `home-<hid>`, the watcher's own
 * watcherHomeId (lib/watcher-service.mjs) of the HOME's real path on macOS
 * and Linux (agentHomeId), so a watcher and the agents it keeps share one id
 * per HOME, except for a HOME spelled through a symlink, whose watcher keeps
 * #237's id of the HOME as spelled. agentServiceNames builds them; the old names
 * (before 0.69.5: "HOAI Agent <id>", ai.bgos.agent.<id>, bgos-agent-<id>,
 * the tmux socket hoai-<id>) are what serviceLabel, serviceUnit and
 * agentTaskName still return, because an agent not renamed yet is still found
 * and supervised under them. Which HOME a registration belongs to is never
 * judged here (no OS query per agent per minute): every act reads it back
 * first (lib/agent-task-win32.mjs, lib/agent-service.mjs).
 *
 * An AgentRow carries the resolved `service` (kind + handle) so lib/agent-restart.mjs
 * addresses the restart to the job that was actually detected rather than to a
 * name it assumed. Restarting through the supervisor is what keeps the agent's
 * identity: the supervisor re-runs its own recipe, in its own working
 * directory, reading its own .mcp.json (docs/learnings, fleet-restart
 * shared-folder identity bleed).
 *
 * The launch recipe is what hoai-core knew at launch time: cwd, the channel
 * flags, install method, plugin root, node path. It NEVER carries a session
 * id (identity is resumed from the agent's own session-id pin by hoai-core
 * itself), never a token. On read every recipe is validated against the disk:
 * the cwd must exist and its folder pin must name this agent, otherwise the
 * recipe is dropped with a named note rather than trusted, because launching
 * hoai in a folder pinned to another agent would start the wrong identity.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe, every probe
 * injectable so the whole inventory is testable in a fake HOME.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  SERVICE_RECORD_FILE_NAME,
  defaultExecSync,
  listLoadedJobs,
  parseServiceRecord,
  readFolderIdentity,
  resolveSupervisingService,
  verifyServiceRecord,
} from './service-supervision.mjs'
import { AGENT_STATE_FILE_NAME, isAgentStateFresh, parseAgentState } from './keepalive-plan.mjs'
import { HOME_ID_PREFIX, canonicalHome, watcherHomeId } from './watcher-service.mjs'

/** Mirror of bin/hoai-core.mjs / lib/update-readiness.ts file names. */
export const SUPERVISOR_FILE_NAME = 'supervisor.json'
export const RESTART_MARKER_FILE_NAME = 'restart-requested.json'
export const SESSION_ID_FILE_NAME = 'session-id'
/** The launch recipe hoai-core writes at every supervised launch. */
export const LAUNCH_RECIPE_FILE_NAME = 'launch.json'
export const LAUNCH_RECIPE_SCHEMA_VERSION = 1
/** The watcher's liveness-probe request (existence only, design 7.2). */
export const PROBE_MARKER_FILE_NAME = 'probe-requested.json'
/** Mirror of lib/boot-hello.ts LIVE_MARKER_FILE. */
export const LIVE_MARKER_FILE_NAME = 'channel-live.json'
/** Mirror of lib/pairing-lock.ts BEACON_HEARTBEAT_FILE: the daemon touches it, beside
 *  channel-live.json, about every 5 s while its channel delivers (pinned by
 *  test/hoai-core.gate-attach.test.ts). */
export const BEACON_HEARTBEAT_FILE_NAME = 'channel-beacon.json'
/** Mirror of lib/cursor-store.ts default state root name. */
export const PLUGIN_STATE_DIR_NAME = '.bgos-plugin-state'
/** Mirror of bin/bgos-pair.mjs FOLDER_PIN_FILE_NAME. */
export const FOLDER_PIN_FILE_NAME = '.bgos-agent-id'
/** Mirror of lib/update-readiness.ts KEEPALIVE_MARKER_FILE / bin/hoai-core.mjs
 *  KEEPALIVE_MARKER_FILE_NAME (pinned by test/agent-inventory.test.ts). */
export const KEEPALIVE_MARKER_FILE_NAME = 'keepalive.json'
/** <statedir>/supervisor-generation, written by a v2 bin/bgos-agent install
 *  and by the Windows agent task (design 4, generation stamp). */
export const SUPERVISOR_GENERATION_FILE_NAME = 'supervisor-generation'
/** The Windows agent task's launcher in the agent's state dir; its presence is
 *  the canonical-file test on win32 (lib/agent-task-win32.mjs writes it). */
export const AGENT_TASK_LAUNCHER_FILE_NAME = 'run-agent.vbs'
/** The process name a keepalive's declared session must have (mirror of
 *  lib/update-readiness.ts KEEPALIVE_SESSION_COMM). */
export const KEEPALIVE_SESSION_COMM = 'claude'

/**
 * @typedef {{
 *   schemaVersion: number,
 *   assistantId: string,
 *   cwd: string,
 *   argv: string[],
 *   installMethod: string | null,
 *   pluginRoot: string | null,
 *   node: string | null,
 *   claudeConfigDir: string | null,
 *   startedAt: string | null,
 *   launcher: 'hoai',
 *   pid: number | null,
 * }} LaunchRecipe
 */

/**
 * @typedef {{
 *   assistantId: string,
 *   cwd: string | null,
 *   recipe: LaunchRecipe | null,
 *   supervisor: 'launcher-live' | 'service' | 'none',
 *   discoveredVia: 'credentials' | 'supervised-folder',
 *   running: boolean,
 *   home: string,
 *   service: import('./service-supervision.mjs').ResolvedService | { kind: 'schtasks', handle: string, legacyHandle: string, via: 'canonical-file', file: string } | null,
 *   serviceFile: string | null,
 *   keepalive: { pid: number, claudePid: number, tmuxSession: string | null } | null,
 *   keepaliveDeclared: boolean,
 *   supervisorGeneration: number | null,
 *   launcherLive: boolean,
 *   sessionId: string | null,
 *   stateDir: string,
 *   pluginStateDir: string,
 *   liveMarkerPath: string,
 *   credentialsPath: string,
 *   notes: string[],
 * }} AgentRow
 */

/**
 * @typedef {{
 *   exists: (path: string) => boolean,
 *   readFile: (path: string) => string | null,
 *   listDir: (path: string) => string[],
 * }} InventoryFs
 */

// -- Default probes (node fs) --------------------------------------------------

function defaultExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

function defaultReadText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function defaultListDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function defaultWriteText(path, content) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return true
  } catch {
    return false
  }
}

/** Is this pid alive on THIS host? Mirror of hoai-core defaultPidAlive. */
export function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** The node-backed read-only probe set. */
export function defaultInventoryFs() {
  return { exists: defaultExists, readFile: defaultReadText, listDir: defaultListDir }
}

// -- Path builders (separator preserving, mirror of hoai-core joinDir) --------

/** Join dir + name preserving the dir's separator style. */
export function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** Assistant ids are digits-only everywhere; anything else builds no path. */
export function validAssistantId(id) {
  const value = String(id ?? '').trim()
  return /^\d+$/.test(value) ? value : null
}

export function agentDir(home) {
  return joinDir(home, '.bgos-agent')
}

export function agentStateDir(home, assistantId) {
  const id = validAssistantId(assistantId)
  return id ? joinDir(agentDir(home), id) : null
}

export function credentialsPath(home, assistantId) {
  const id = validAssistantId(assistantId)
  return id ? joinDir(agentDir(home), `credentials-${id}.json`) : null
}

function stateFile(home, assistantId, name) {
  const dir = agentStateDir(home, assistantId)
  return dir ? joinDir(dir, name) : null
}

export function launchRecipePath(home, assistantId) {
  return stateFile(home, assistantId, LAUNCH_RECIPE_FILE_NAME)
}

export function supervisorPath(home, assistantId) {
  return stateFile(home, assistantId, SUPERVISOR_FILE_NAME)
}

export function restartMarkerPath(home, assistantId) {
  return stateFile(home, assistantId, RESTART_MARKER_FILE_NAME)
}

export function probeMarkerPath(home, assistantId) {
  return stateFile(home, assistantId, PROBE_MARKER_FILE_NAME)
}

export function sessionIdPath(home, assistantId) {
  return stateFile(home, assistantId, SESSION_ID_FILE_NAME)
}

/** The daemon-published supervising-service record (lib/service-supervision.mjs). */
export function serviceRecordPath(home, assistantId) {
  return stateFile(home, assistantId, SERVICE_RECORD_FILE_NAME)
}

/** The OLD launchd label (before 0.69.5), mirror of bin/bgos-agent legacy_label_for. */
export function serviceLabel(assistantId) {
  return `ai.bgos.agent.${assistantId}`
}

/** The OLD systemd --user unit name (before 0.69.5), mirror of bin/bgos-agent legacy_unit_for. */
export function serviceUnit(assistantId) {
  return `bgos-agent-${assistantId}`
}

/** The OLD Windows per-agent logon task name (design 4; before 0.69.5), or null for a junk id. */
export function agentTaskName(assistantId) {
  const id = validAssistantId(assistantId)
  return id ? `HOAI Agent ${id}` : null
}

/**
 * A posix HOME by its real path (round 2 H2): /Users/fitecho, a symlink to
 * /Users/bgos, is ONE HOME, with one LaunchAgents folder and one run.sh, so it
 * must carry one id and read its own records as its own. Spelled as given when
 * it cannot be resolved (it does not exist), and on Windows (as the target, or
 * as the host running a test of a posix HOME), where #237's lexical rule holds.
 * @param {string} home
 * @param {string} platform
 */
export function realHome(home, platform) {
  const raw = String(home ?? '').trim()
  if (!raw || platform === 'win32' || process.platform === 'win32') return raw
  try {
    return realpathSync(raw)
  } catch {
    return raw
  }
}

/** Is a HOME some registration records this HOME, by real path? (canonicalHome of each real path). */
export function sameAgentHome(a, b, platform) {
  return canonicalHome(realHome(a, platform), platform) === canonicalHome(realHome(b, platform), platform)
}

/**
 * The id of the HOME an agent service is installed from: #237's watcherHomeId
 * of its real path (realHome). The watcher's own id stays #237's, from the HOME
 * as spelled, so a watcher already installed under it is never renamed by this;
 * the two differ only for a HOME spelled through a symlink.
 * @param {string} home
 * @param {string} platform
 */
export function agentHomeId(home, platform) {
  return watcherHomeId(realHome(home, platform), platform)
}

/**
 * Every name an agent's service is known by, for one HOME id (board row
 * d6198bb6). With a HOME id each carries `home-<hid>` (mirror of bin/bgos-agent
 * label_for, unit_for and tmux_name_for); without one they are the OLD names
 * exactly, which an agent not renamed yet still has. No service namespace: the
 * agent names never carried one. Null for a junk assistant id; a junk HOME id
 * is no HOME id (never a guessed name).
 * @param {string | number} assistantId
 * @param {string} [homeId]
 * @returns {{ assistantId: string, homeId: string, taskName: string, launchdLabel: string, systemdUnit: string, tmuxSocket: string } | null}
 */
export function agentServiceNames(assistantId, homeId = '') {
  const id = validAssistantId(assistantId)
  if (!id) return null
  const hid = /^[0-9a-f]{8}$/.test(String(homeId ?? '')) ? String(homeId) : ''
  const scope = hid ? `${HOME_ID_PREFIX}${hid}` : ''
  return {
    assistantId: id,
    homeId: hid,
    taskName: scope ? `HOAI Agent ${id} ${scope}` : `HOAI Agent ${id}`,
    launchdLabel: scope ? `ai.bgos.agent.${id}.${scope}` : `ai.bgos.agent.${id}`,
    systemdUnit: scope ? `bgos-agent-${id}-${scope}` : `bgos-agent-${id}`,
    tmuxSocket: scope ? `hoai-${id}-${scope}` : `hoai-${id}`,
  }
}

/** This HOME's names and the old ones, for one agent: what every reader of a name accepts during the migration. */
export function agentServiceNamesFor(assistantId, home, platform) {
  const current = agentServiceNames(assistantId, agentHomeId(home, platform))
  const legacy = agentServiceNames(assistantId, '')
  return current && legacy ? { current, legacy } : null
}

export function keepaliveMarkerPath(home, assistantId) {
  return stateFile(home, assistantId, KEEPALIVE_MARKER_FILE_NAME)
}

export function supervisorGenerationPath(home, assistantId) {
  return stateFile(home, assistantId, SUPERVISOR_GENERATION_FILE_NAME)
}

/**
 * The per-agent always-on service file, or null (win32 has none). `homeId`
 * names the file of that HOME's service; without one, the OLD file name.
 */
export function serviceFilePath(platform, home, assistantId, homeId = '') {
  const names = agentServiceNames(assistantId, homeId)
  if (!names) return null
  if (platform === 'darwin') {
    return joinDir(joinDir(joinDir(home, 'Library'), 'LaunchAgents'), `${names.launchdLabel}.plist`)
  }
  if (platform === 'linux') {
    return joinDir(
      joinDir(joinDir(joinDir(home, '.config'), 'systemd'), 'user'),
      `${names.systemdUnit}.service`,
    )
  }
  return null
}

/** The plugin-state root: BGOS_PLUGIN_STATE_DIR (trimmed) else ~/.bgos-plugin-state. */
export function pluginStateRoot({ env = {}, home } = {}) {
  const override = String(env?.BGOS_PLUGIN_STATE_DIR ?? '').trim()
  return override || joinDir(home, PLUGIN_STATE_DIR_NAME)
}

/**
 * Mirror of bin/bgos-doctor.mjs liveMarkerPathFor / lib/cursor-store.ts key rule.
 * @param {{ env?: Record<string, string | undefined>, home?: string, assistantId?: string, cwd?: string }} [opts]
 */
export function pluginStateDirFor({ env = {}, home, assistantId = '', cwd = '' } = {}) {
  const raw = String(assistantId ?? '').trim()
  const key = /^[A-Za-z0-9_-]{1,64}$/.test(raw)
    ? raw
    : `cwd-${createHash('sha256').update(String(cwd ?? '')).digest('hex').slice(0, 16)}`
  return joinDir(pluginStateRoot({ env, home }), key)
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, assistantId?: string, cwd?: string }} [opts]
 */
export function liveMarkerPathFor({ env = {}, home, assistantId = '', cwd = '' } = {}) {
  return joinDir(pluginStateDirFor({ env, home, assistantId, cwd }), LIVE_MARKER_FILE_NAME)
}

// -- Small readers ----------------------------------------------------------------

/** Ids with a credentials-<id>.json under ~/.bgos-agent, ascending numerically. */
export function listPairedAssistantIds(home, listDir = defaultListDir) {
  return listDir(agentDir(home))
    .map((name) => /^credentials-(\d+)\.json$/.exec(name)?.[1])
    .filter((found) => Boolean(found))
    .sort((a, b) => Number(a) - Number(b))
}

/** The numeric id in <cwd>/.bgos-agent-id, or '' when absent or junk. */
export function readFolderPin(cwd, readFile = defaultReadText) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return ''
  const raw = readFile(joinDir(dir, FOLDER_PIN_FILE_NAME))
  if (raw == null) return ''
  const id = String(raw).trim()
  return /^\d+$/.test(id) ? id : ''
}

/** Fail-closed supervisor.json parse (mirror of lib/update-readiness.ts). */
export function parseSupervisorFile(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const pid = parsed.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  const capabilities = Array.isArray(parsed.capabilities)
    ? parsed.capabilities.filter((c) => typeof c === 'string')
    : []
  return { pid, capabilities }
}

/**
 * Is this the `supervisor` block the daemon writes for a declared marker
 * launcher (BGOS_SUPERVISOR_KIND=launcher)? Mirror of lib/update-readiness.ts
 * parseDeclaredSupervisor for kind 'launcher': an object of that kind whose
 * restartCommand is absent, or {file: non-empty string, args?: string[]}.
 */
function isDeclaredLauncherBlock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'launcher') return false
  const command = value.restartCommand
  if (command === undefined || command === null) return true
  if (typeof command !== 'object' || Array.isArray(command)) return false
  if (typeof command.file !== 'string' || !command.file.trim()) return false
  return command.args === undefined || (Array.isArray(command.args) && command.args.every((a) => typeof a === 'string'))
}

/**
 * parseSupervisorFile plus what the file says about the process that WROTE
 * it: its `startedAt` stamp as ms (null when absent or junk), and the boot
 * clock it was written on (`boot`, parseBootStamp; null from an older writer
 * or off Linux). The writer was already running when it stamped the file
 * (hoai stamps it at arm time and again before every keep-alive relaunch, the
 * daemon at its boot), which is what proves a live pid is still that writer
 * and not a later process that took the number over. `declaredLauncher` is
 * the record the agent's DAEMON writes for a declared marker launcher
 * (lib/update-readiness.ts buildDeclaredSupervisorBody): its pid is the
 * daemon's own, which never runs hoai-core.mjs, and it always carries the
 * stamp that proof needs.
 * @param {string | null | undefined} raw
 * @returns {{ pid: number, capabilities: string[], startedAtMs: number | null,
 *   boot: { id: string, uptimeMs: number } | null, declaredLauncher: boolean } | null}
 */
export function parseSupervisorRecord(raw) {
  const base = parseSupervisorFile(raw)
  if (!base) return null
  const parsed = JSON.parse(String(raw))
  const ms = typeof parsed.startedAt === 'string' ? Date.parse(parsed.startedAt) : Number.NaN
  const startedAtMs = Number.isFinite(ms) ? ms : null
  return { ...base, startedAtMs, boot: parseBootStamp(parsed.boot), declaredLauncher: startedAtMs !== null && isDeclaredLauncherBlock(parsed.supervisor) }
}

// -- The boot clock (review 3 F1) -------------------------------------------------------
//
// A writer's `startedAt` is the WALL clock, and the start time a pid is checked
// with is `now - etime`. On darwin and win32 that start is the stored wall
// clock start, so a step of the clock moves both sides alike. On Linux ps
// measures etime on the BOOT clock (/proc/uptime minus the start in
// /proc/<pid>/stat), which no step moves: a wall clock stepped forward after
// the stamp (a Raspberry Pi with no RTC that NTP corrects after run.sh armed
// hoai, a WSL2 or other paused VM resynced after host sleep) put a LIVE
// writer's computed start after its own stamp, and it read as a reused pid.
// So on Linux every stamp also records the boot clock it was written on, and
// every reading carries the boot id and the start on that clock: the two are
// compared on ONE clock (startedAfterStamp).

/** The kernel's id for this boot: a fresh random UUID at every boot. */
export const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'
/** Seconds since boot, the clock procps measures etime on. */
export const UPTIME_PATH = '/proc/uptime'

/**
 * A `boot` stamp, {id, uptimeMs}, or null: id a non-empty string of at most 64
 * characters, uptimeMs a finite number not below 0.
 * @param {unknown} value
 * @returns {{ id: string, uptimeMs: number } | null}
 */
export function parseBootStamp(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { id, uptimeMs } = /** @type {Record<string, unknown>} */ (value)
  if (typeof id !== 'string' || !id || id.length > 64) return null
  if (typeof uptimeMs !== 'number' || !Number.isFinite(uptimeMs) || uptimeMs < 0) return null
  return { id, uptimeMs }
}

/**
 * This host's boot clock right now, {id, uptimeMs}, on Linux only (null
 * elsewhere, without reading anything, and null when either file is missing
 * or junk). Never throws.
 * @param {{ platform?: string, readFile?: (path: string) => string | null }} [probe]
 * @returns {{ id: string, uptimeMs: number } | null}
 */
export function readBootClock({ platform = process.platform, readFile = defaultReadText } = {}) {
  if (platform !== 'linux') return null
  try {
    const id = String(readFile(BOOT_ID_PATH) ?? '').trim()
    const uptime = String(readFile(UPTIME_PATH) ?? '').trim()
    const seconds = Number(uptime.split(/\s+/)[0])
    if (!uptime || !Number.isFinite(seconds)) return null
    return parseBootStamp({ id, uptimeMs: Math.round(seconds * 1000) })
  } catch {
    return null
  }
}

/**
 * Did the process `proc` describes start AFTER the stamp, so it is provably
 * not the process that wrote it (a pid taken over since)? On the boot clock
 * when both the stamp and the reading carry it (Linux): another boot means the
 * writer died in a reboot, and the same boot compares the start against the
 * stamp's uptime. Otherwise on the wall clock, as before. Either way with
 * KEEPALIVE_START_SLACK_MS of slack, and unknown (no stamp, no start) proves
 * nothing.
 * @param {{ startedAtMs?: number | null, boot?: { id: string, uptimeMs: number } | null }} stamp
 * @param {{ startedAtMs: number | null, boot?: { id: string, startedUptimeMs: number } | null }} proc
 */
function startedAfterStamp(stamp, proc) {
  if (stamp.boot && proc.boot) {
    if (stamp.boot.id !== proc.boot.id) return true
    return proc.boot.startedUptimeMs > stamp.boot.uptimeMs + KEEPALIVE_START_SLACK_MS
  }
  const at = stamp.startedAtMs
  return typeof at === 'number' && typeof proc.startedAtMs === 'number' && proc.startedAtMs > at + KEEPALIVE_START_SLACK_MS
}

// -- supervisor.json: is its pid still the launcher that wrote it? ----------------

/** The file every hoai launcher runs, so its path is on the launcher's command
 *  line: run.sh and the Windows agent task start `node <root>/bin/hoai-core.mjs`,
 *  and the bash and PowerShell `hoai` dispatchers exec it. */
export const HOAI_LAUNCHER_SCRIPT = 'hoai-core.mjs'

/**
 * The ONE query that reads the command line AND the start time of `pids`, or
 * null when there is no pid to ask about. Only positive integers reach the
 * command. posix: ps at unlimited width (-ww), because a line cut at 80
 * columns loses the very file name it is checked for (a plugin cache path
 * alone is longer than that); etime is locale free, unlike lstart. win32: one
 * CIM query, as JSON, the creation time as epoch ms (null when Windows hides it).
 * @param {string} platform
 * @param {unknown[]} pids
 * @returns {{ file: string, args: string[] } | null}
 */
export function launcherProcessQuery(platform, pids) {
  const list = [...new Set((Array.isArray(pids) ? pids : []).filter((pid) => Number.isInteger(pid) && pid > 0))]
  if (list.length === 0) return null
  if (platform === 'win32') {
    const filter = list.map((pid) => `ProcessId=${pid}`).join(' OR ')
    const script =
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { ` +
      '[pscustomobject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine; ' +
      'StartedAtMs = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }) } } | ConvertTo-Json -Compress'
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  return { file: 'ps', args: ['-ww', '-o', 'pid=,etime=,command=', '-p', list.join(',')] }
}

/**
 * That query's output as pid -> {command, startedAtMs}, for the asked pids
 * only. Either half may be null (unreadable): Windows hides another session's
 * CommandLine but still dates the process. A pid with neither is ABSENT. On
 * Linux, given the boot clock read with the query (readBootClock), a dated
 * entry also carries `boot`: the boot id and its start on that clock (uptime
 * minus etime), the clock ps measured etime on (review 3 F1).
 * @param {string} platform
 * @param {string | null | undefined} stdout
 * @param {number[]} pids
 * @param {number} [now] the clock ps measured etime against
 * @param {{ id: string, uptimeMs: number } | null} [bootClock]
 * @returns {Map<number, { command: string | null, startedAtMs: number | null,
 *   boot?: { id: string, startedUptimeMs: number } }>}
 */
export function parseLauncherProcesses(platform, stdout, pids, now = Date.now(), bootClock = null) {
  const asked = new Set(Array.isArray(pids) ? pids : [])
  const out = new Map()
  const keep = (pid, command, startedAtMs, boot = null) => {
    const text = typeof command === 'string' ? command.trim() : ''
    const started = typeof startedAtMs === 'number' && Number.isFinite(startedAtMs) ? startedAtMs : null
    if (asked.has(pid) && (text || started !== null)) out.set(pid, { command: text || null, startedAtMs: started, ...(boot ? { boot } : {}) })
  }
  if (platform === 'win32') {
    let parsed
    try {
      parsed = JSON.parse(String(stdout ?? ''))
    } catch {
      return out
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item && typeof item === 'object') keep(item.ProcessId, item.CommandLine, item.StartedAtMs)
    }
    return out
  }
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line)
    const etime = m ? parseEtimeMs(m[2]) : null
    if (m) keep(Number(m[1]), m[3], etime === null ? null : now - etime, bootStartOf(platform, bootClock, etime))
  }
  return out
}

/** A Linux reading's start on the boot clock, {id, startedUptimeMs}, or null
 *  (no clock, no etime, or not Linux: darwin's etime is the wall clock). */
function bootStartOf(platform, bootClock, etime) {
  if (platform !== 'linux' || !bootClock || etime === null) return null
  return { id: bootClock.id, startedUptimeMs: bootClock.uptimeMs - etime }
}

/**
 * The command lines and start times of these pids, read in ONE process for
 * the whole fleet: the heartbeat lists the agents every minute, and on win32
 * each PowerShell costs most of a second. A pid absent from the map could not
 * be read (no exec, the query failed, a process this user may not see). Never
 * throws. `bootClock` reads the boot clock (readBootClock) right after the
 * query, so a Linux reading carries its start on the clock etime was
 * measured on; the default reads none.
 * @param {{ platform: string, pids: number[], now?: number,
 *   execSync?: (file: string, args: string[]) => { code: number, stdout: string },
 *   bootClock?: () => { id: string, uptimeMs: number } | null }} params
 * @returns {Map<number, { command: string | null, startedAtMs: number | null,
 *   boot?: { id: string, startedUptimeMs: number } }>}
 */
export function readLauncherProcesses({ platform, pids, execSync, now = Date.now(), bootClock = () => null }) {
  const query = launcherProcessQuery(platform, pids)
  if (!query || typeof execSync !== 'function') return new Map()
  try {
    // ps exits 1 when one of several pids is gone, with the others still
    // printed; only lines for the asked pids are ever taken.
    const stdout = execSync(query.file, query.args)?.stdout
    return parseLauncherProcesses(platform, stdout, pids, now, platform === 'linux' ? bootClock() : null)
  } catch {
    return new Map()
  }
}

/** Does `word` start a path: posix, UNC, or a drive? */
function startsPath(word) {
  return /^(\/|\\|[A-Za-z]:[\\/])/.test(word)
}

/** Is `word` a flag (`-f`, `--inspect`, `-lc`)? A lone `-` is not (a checkout
 *  path can hold ' - '), nor is a word holding a path separator. */
function isFlagWord(word) {
  return /^-[^\\/]+$/.test(word)
}

/**
 * The script a command line runs, its argv[1], when that script is the
 * launcher's, else null. A Windows CommandLine quotes a path with a space, so
 * a leading quoted string is argv[0] and a next quoted string is argv[1].
 * posix ps quotes nothing, so the words are read back: argv[1] is the run of
 * words that ends at the first word whose basename is the launcher script and
 * starts at the last word before it that starts a path (else right after
 * argv[0]), so a checkout path with a space stays whole. The words between
 * argv[0]'s first word and that start continue argv[0], which only a PATH can
 * do (run.sh bakes `command -v node`, and Laravel Herd's lives under
 * `~/Library/Application Support`, review 3 F2): each must hold a separator and
 * start none, because what follows a space inside a directory path is the
 * rest of that path. A flag anywhere in the script run refuses too. That is
 * what keeps a tmux server out (macOS cannot retitle one, so it keeps the
 * client argv `tmux -f /dev/null -L hoai-<id> new-session ... node
 * <root>/bin/hoai-core.mjs`), and `sh -c`, `env NAME=value node ...` and
 * another script whose argument names hoai-core.mjs with it.
 * @param {string} command
 * @returns {string | null}
 */
function scriptArgument(command) {
  const text = command.trim()
  let rest
  let pathArgv0 = false
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1)
    if (close < 0) return null
    rest = text.slice(close + 1).trimStart()
  } else {
    const first = /^\S*/.exec(text)[0]
    pathArgv0 = startsPath(first)
    rest = text.slice(first.length).trimStart()
  }
  if (rest.startsWith('"')) {
    const close = rest.indexOf('"', 1)
    const quoted = close < 0 ? null : rest.slice(1, close)
    return quoted !== null && basenameOf(quoted) === HOAI_LAUNCHER_SCRIPT ? quoted : null
  }
  const words = rest.split(/\s+/).filter(Boolean)
  const at = words.findIndex((word) => basenameOf(word) === HOAI_LAUNCHER_SCRIPT)
  if (at < 0) return null
  let start = 0
  for (let i = at; i > 0; i--) {
    if (startsPath(words[i])) {
      start = i
      break
    }
  }
  const continued = words.slice(0, start)
  if (continued.length > 0 && !(pathArgv0 && continued.every((word) => /[\\/]/.test(word) && !startsPath(word)))) return null
  const script = words.slice(start, at + 1)
  return script.some(isFlagWord) ? null : script.join(' ')
}

function basenameOf(path) {
  return String(path).split(/[\\/]/).at(-1)
}

/** Does this command line run hoai: is hoai-core.mjs its SCRIPT (argv[1]), not
 *  just a word somewhere in it? A null one (unreadable) answers yes: the
 *  liveness of the pid alone decides, exactly as it did before the identity check. */
export function runsHoaiLauncher(command) {
  if (typeof command !== 'string') return true
  const script = scriptArgument(command)
  return script !== null && basenameOf(script) === HOAI_LAUNCHER_SCRIPT
}

/**
 * Is `proc` (a readLauncherProcesses entry, null when unreadable) the process
 * that WROTE this supervisor.json record? Two proofs, either one refusing:
 *   - it started no later than the file's startedAt, with the same slack the
 *     keepalive.json check gives (KEEPALIVE_START_SLACK_MS): a process that
 *     started after the stamp took the number over from a dead writer. On
 *     Linux that is read on the boot clock when both sides carry it
 *     (startedAfterStamp, review 3 F1), so a wall clock step after the stamp
 *     never turns the live writer into a reused pid;
 *   - it runs hoai-core.mjs as its script (runsHoaiLauncher), unless the
 *     record is the daemon's declared-launcher one, whose writer is the
 *     agent's daemon (`bun server.ts`): the start time alone proves that one.
 * "Some hoai" is not enough: every agent's hoai runs that script, and a boot
 * starts the whole fleet inside a few hundred pids, so a stale file's pid can
 * be another agent's launcher (or, on macOS, its tmux server). A half that
 * cannot be read (no stamp, no start time, no command line) proves nothing
 * either way, and nothing readable keeps the liveness answer.
 * bin/hoai-core.mjs decideSupervisorArming asks this same question.
 * @param {{ startedAtMs?: number | null, boot?: { id: string, uptimeMs: number } | null,
 *   declaredLauncher?: boolean } | null} record
 * @param {{ command: string | null, startedAtMs: number | null,
 *   boot?: { id: string, startedUptimeMs: number } | null } | null} proc
 */
export function isSupervisorWriter(record, proc) {
  if (!proc) return true
  if (startedAfterStamp({ startedAtMs: record?.startedAtMs, boot: record?.boot }, proc)) return false
  return record?.declaredLauncher === true || runsHoaiLauncher(proc.command)
}

/**
 * Is this parsed supervisor.json a LIVE hoai launcher: it declares 'relaunch',
 * its pid is alive, AND that pid is still the launcher that wrote the file
 * (isSupervisorWriter). The last test is the pid identity. Any unclean stop (a
 * power cut, a panic, a SIGKILL, a Windows logoff) leaves the file behind, and
 * after a reboot its pid can be any process: "alive" alone then kept a dead
 * agent's launcher live for as long as that process ran, and on Windows the
 * sweep never started the agent's task.
 * bin/hoai-core.mjs decideSupervisorArming asks the same question with the
 * same query, so hoai and the watcher never disagree about one pid.
 * @param {{ supervisor: { pid: number, capabilities: string[], startedAtMs?: number | null,
 *     boot?: { id: string, uptimeMs: number } | null } | null,
 *   pidAlive?: (pid: number) => boolean,
 *   processes?: Map<number, { command: string | null, startedAtMs: number | null,
 *     boot?: { id: string, startedUptimeMs: number } | null }> | null }} input
 */
export function isLiveHoaiLauncher({ supervisor, pidAlive = defaultPidAlive, processes = null }) {
  if (!supervisor || !supervisor.capabilities.includes('relaunch')) return false
  if (!pidAlive(supervisor.pid)) return false
  return isSupervisorWriter(supervisor, processes?.get(supervisor.pid) ?? null)
}

function isSessionIdLike(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    String(value ?? '').trim(),
  )
}

// -- keepalive.json (design 5, the bespoke supervisor paragraph) -----------------------

function positivePid(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 1 ? value : null
}

/**
 * Parse a keepalive.json body. An EXACT mirror of lib/update-readiness.ts
 * parseKeepaliveMarker (the watcher runs from a plain-JS bundle and cannot
 * import TS; test/agent-inventory.test.ts runs both on one table): `kind` must
 * be 'keepalive', the 'relaunch' capability is the explicit promise, both pids
 * are integers above 1, tmuxSession is collapsed and capped (log text only).
 * @param {string | null | undefined} raw
 * @returns {{ pid: number, claudePid: number, tmuxSession: string | null } | null}
 */
export function parseKeepaliveMarker(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.kind !== 'keepalive') return null
  const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities : []
  if (!capabilities.includes('relaunch')) return null
  const pid = positivePid(parsed.pid)
  const claudePid = positivePid(parsed.claudePid)
  if (pid === null || claudePid === null) return null
  const declared = typeof parsed.tmuxSession === 'string' ? parsed.tmuxSession : ''
  const tmuxSession = declared.replace(/\s+/g, ' ').trim().slice(0, 64)
  return { pid, claudePid, tmuxSession: tmuxSession || null }
}

/** Mirror of lib/update-readiness.ts isKeepaliveSessionProcess: the basename of
 *  `ps -o comm=` must be exactly claude; unreadable is refused. */
export function isKeepaliveSessionProcess(comm) {
  if (typeof comm !== 'string') return false
  const name = comm.trim()
  if (!name) return false
  return name.slice(name.lastIndexOf('/') + 1) === KEEPALIVE_SESSION_COMM
}

/** `ps -o comm= -p <pid>` prints exactly one line; anything else is null. */
function parseCommOutput(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text || text.includes('\n')) return null
  return text
}

/** A process may have started this long after the marker's startedAt and still
 *  be the one it named: ps etime has 1 s granularity, and the stamp and the
 *  reading are two clock reads (the wall clock, or on Linux the boot clock,
 *  startedAfterStamp). A pid reused within a minute of the marker is not a case. */
export const KEEPALIVE_START_SLACK_MS = 60_000

/** `ps -o etime=` (`[[dd-]hh:]mm:ss`, locale free) as ms, or null. */
export function parseEtimeMs(text) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(String(text ?? ''))
  if (!m) return null
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((v) => (v === undefined ? 0 : Number(v)))
  if (minutes > 59 || seconds > 59) return null
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
}

/**
 * The process table a keepalive is checked against, from ONE
 * `ps -A -o pid=,ppid=,uid=,etime=`: pid -> {ppid, uid, startedAtMs}, plus
 * each row's start on the boot clock (`boot`) when `bootClock` answers, which
 * readBootClock does on Linux only (review 3 F1). Null when there is no exec
 * or ps cannot answer; read at most once per listing (lazy).
 * @param {{ execSync?: (file: string, args: string[]) => { code: number, stdout: string }, now: number,
 *   bootClock?: () => { id: string, uptimeMs: number } | null }} probe
 * @returns {() => Map<number, { ppid: number, uid: number, startedAtMs: number,
 *   boot?: { id: string, startedUptimeMs: number } }> | null}
 */
export function keepaliveProcessTable({ execSync, now, bootClock = () => null }) {
  let table
  return () => {
    if (table !== undefined) return table
    table = null
    if (typeof execSync !== 'function') return table
    const res = execSync('ps', ['-A', '-o', 'pid=,ppid=,uid=,etime='])
    if (res?.code !== 0) return table
    const clock = bootClock()
    const rows = new Map()
    for (const line of String(res.stdout ?? '').split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
      const etime = m ? parseEtimeMs(m[4]) : null
      if (!m || etime === null) continue
      const boot = clock ? { id: clock.id, startedUptimeMs: clock.uptimeMs - etime } : null
      rows.set(Number(m[1]), { ppid: Number(m[2]), uid: Number(m[3]), startedAtMs: now - etime, ...(boot ? { boot } : {}) })
    }
    table = rows.size > 0 ? rows : null
    return table
  }
}

/** The marker's own stamp (the parse the daemon mirrors drops it): its
 *  startedAt as ms and its boot clock, each null when absent or junk. */
function markerStamp(raw) {
  try {
    const parsed = JSON.parse(raw)
    const ms = Date.parse(parsed?.startedAt)
    return { startedAtMs: Number.isFinite(ms) ? ms : null, boot: parseBootStamp(parsed?.boot) }
  } catch {
    return { startedAtMs: null, boot: null }
  }
}

/**
 * Is the process at `pid` provably NOT the one a marker with this `stamp`
 * named? It belongs to another user (the keepalive and its claude run as us,
 * so a root daemon that took the pid after a reboot is not them), or it
 * started after the marker was written (the marker names a process that was
 * already running; startedAfterStamp, on the boot clock on Linux). Unknown
 * (no table, no row, no stamp) proves nothing.
 */
function reusedSince(row, stamp, uid) {
  if (!row) return false
  if (Number.isInteger(uid) && row.uid !== uid) return true
  return startedAfterStamp(stamp, row)
}

function defaultUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/**
 * The keepalive a script DECLARED for this agent, or null: the marker parses
 * (a relaunch promise was made) and the script that made it is still ALIVE.
 * For the install decision only (design 5 step 1, G11): the bespoke loop's
 * claude can be dead for a moment between two relaunches, and adding the
 * product supervisor in that moment would race the loop for the folder. A
 * restart is never aimed by this: the SIGTERM tier needs verifyKeepaliveMarker,
 * which also proves the declared pid is a live claude of this agent.
 * F6: a live pid alone is not the script. A retired script's marker stays on
 * disk (nothing removes it), and after a reboot its pid goes to whatever
 * starts in that order: a process owned by another user, or one that started
 * after the marker was written, is a REUSED pid, and the marker declares
 * nothing (else no product supervisor was ever installed for that agent).
 * win32 has no keepalive scripts, so a live pid there is a reused one: null.
 * @param {{ platform: string, home: string, assistantId: string | number,
 *   readFile: (path: string) => string | null, pidAlive?: (pid: number) => boolean,
 *   execSync?: (file: string, args: string[]) => { code: number, stdout: string },
 *   now?: number, uid?: number | null, table?: ReturnType<typeof keepaliveProcessTable> }} probe
 * @returns {{ pid: number, claudePid: number, tmuxSession: string | null } | null}
 */
export function readDeclaredKeepalive({ platform, home, assistantId, readFile, pidAlive = defaultPidAlive, execSync, now = Date.now(), uid = defaultUid(), table }) {
  if (platform === 'win32') return null
  const path = keepaliveMarkerPath(home, assistantId)
  if (!path) return null
  const raw = readFile(path)
  const marker = parseKeepaliveMarker(raw)
  if (!marker) return null
  if (!pidAlive(marker.pid)) return null
  const rows = (table ?? keepaliveProcessTable({ execSync, now, bootClock: () => readBootClock({ platform, readFile }) }))()
  return reusedSince(rows?.get(marker.pid), markerStamp(raw), uid) ? null : marker
}

/** The cwd of one pid (lsof on darwin, /proc on linux), or null. */
function processCwd(platform, pid, execSync) {
  if (platform === 'darwin') {
    const res = execSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'])
    const line = String(res?.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  }
  const res = execSync('readlink', [`/proc/${pid}/cwd`])
  const cwd = res?.code === 0 ? String(res.stdout ?? '').trim() : ''
  return cwd || null
}

function sameFolder(a, b, realpath) {
  const norm = (value) => String(value ?? '').trim().replace(/[\\/]+$/, '')
  const resolve = (value) => {
    try {
      return norm(realpath(value))
    } catch {
      return norm(value)
    }
  }
  if (!norm(a) || !norm(b)) return false
  return norm(a) === norm(b) || resolve(a) === resolve(b)
}

/** Does `pid` descend from `ancestor` in the table (cycle safe)? */
function descendsFrom(rows, pid, ancestor) {
  if (!rows) return false
  const seen = new Set()
  let current = rows.get(pid)
  while (current && !seen.has(current.ppid)) {
    if (current.ppid === ancestor) return true
    seen.add(current.ppid)
    current = rows.get(current.ppid)
  }
  return false
}

/**
 * The keepalive that relaunches this agent, VERIFIED, or null. The watcher's
 * version of the daemon's trust rule (lib/update-readiness.ts resolveKeepalive):
 * the daemon proves the declared claude is its own ANCESTOR; the watcher is no
 * descendant of anything, so it proves the same pid from outside instead:
 *   1. the marker parses (a relaunch promise was made at all),
 *   2. the keepalive script that made it is still ALIVE (and not a reused pid),
 *   3. the declared session pid is alive and IS a claude (`ps -o comm=`): one
 *      tmux server is an ancestor of every session on this Mac, so a marker
 *      naming a shared process would have the restart SIGTERM the fleet,
 *   4. F6: that claude is THIS agent's, not merely a claude at a recorded pid:
 *      it is not another user's and did not start after the marker was
 *      written, AND either it descends from the script, or it runs in the
 *      agent's own folder (a tmux keepalive: claude sits under the tmux server),
 *      or the agent's own live daemon names it (agent-state.json claudePid, the
 *      daemon's own ancestor proof). A stale marker whose claudePid was reused
 *      by another agent's claude, or by a person's, is never signalled.
 * win32 has no ps and no keepalive scripts: always null (fail closed).
 * @param {{ platform: string, home: string, assistantId: string | number,
 *   readFile: (path: string) => string | null, pidAlive?: (pid: number) => boolean,
 *   execSync?: (file: string, args: string[]) => { code: number, stdout: string },
 *   cwd?: string | null, agentStatePath?: string | null, now?: number, uid?: number | null,
 *   realpath?: (path: string) => string, table?: ReturnType<typeof keepaliveProcessTable> }} probe
 */
export function verifyKeepaliveMarker({
  platform,
  home,
  assistantId,
  readFile,
  pidAlive = defaultPidAlive,
  execSync = defaultExecSync,
  cwd = null,
  agentStatePath = null,
  now = Date.now(),
  uid = defaultUid(),
  realpath = (path) => realpathSync.native(path),
  table,
}) {
  // Steps 1 and 2 are the declaration; steps 3 and 4 make it a SIGTERM target.
  const rows = table ?? keepaliveProcessTable({ execSync, now, bootClock: () => readBootClock({ platform, readFile }) })
  const marker = readDeclaredKeepalive({ platform, home, assistantId, readFile, pidAlive, execSync, now, uid, table: rows })
  if (!marker) return null
  if (!pidAlive(marker.claudePid)) return null
  const res = execSync('ps', ['-o', 'comm=', '-p', String(marker.claudePid)])
  const comm = res?.code === 0 ? parseCommOutput(res.stdout) : null
  if (!isKeepaliveSessionProcess(comm)) return null
  const claudeRow = rows()?.get(marker.claudePid)
  if (reusedSince(claudeRow, markerStamp(readFile(keepaliveMarkerPath(home, assistantId))), uid)) return null
  if (agentStatePath) {
    const state = parseAgentState(readFile(agentStatePath), assistantId)
    if (state && state.claudePid === marker.claudePid && isAgentStateFresh(state, { now, pidAlive })) return marker
  }
  if (descendsFrom(rows(), marker.claudePid, marker.pid)) return marker
  if (cwd && sameFolder(processCwd(platform, marker.claudePid, execSync), cwd, realpath)) return marker
  return null
}

/** <statedir>/supervisor-generation: absent or junk is 1, a positive integer is itself. */
export function parseSupervisorGeneration(raw) {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) return 1
  const n = Number(text)
  return n >= 1 ? n : 1
}

// -- Launch recipe -----------------------------------------------------------------

/** Session-identity args never belong in a recipe: hoai-core resumes the
 *  agent's own pinned session itself. */
const SESSION_FLAGS_WITH_VALUE = new Set(['--resume', '--session-id'])
const SESSION_FLAGS_BARE = new Set(['--continue'])

/** Strip every session-identity arg (and its value) from an argv. */
export function stripSessionArgs(argv) {
  const out = []
  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i] ?? '')
    if (SESSION_FLAGS_BARE.has(arg)) continue
    if (SESSION_FLAGS_WITH_VALUE.has(arg)) {
      i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Build a recipe from what the launcher knows. Pure. The argv is stripped of
 * session args so a recipe can never carry (or leak) a session id.
 * @param {{ assistantId: string | number, cwd: string, argv?: readonly string[],
 *   installMethod?: string | null, pluginRoot?: string | null, node?: string | null,
 *   startedAt?: string | null, pid?: number | null }} input
 * @returns {LaunchRecipe}
 */
export function buildLaunchRecipe(input) {
  const pid = input?.pid
  return {
    schemaVersion: LAUNCH_RECIPE_SCHEMA_VERSION,
    assistantId: String(input?.assistantId ?? '').trim(),
    cwd: String(input?.cwd ?? ''),
    argv: stripSessionArgs(input?.argv),
    installMethod: optionalString(input?.installMethod),
    pluginRoot: optionalString(input?.pluginRoot),
    node: optionalString(input?.node),
    // The Claude config dir the agent runs under (CLAUDE_CONFIG_DIR at launch),
    // so a watcher reconciles the SAME install and relaunches into it.
    claudeConfigDir: optionalString(input?.claudeConfigDir),
    startedAt: optionalString(input?.startedAt),
    launcher: 'hoai',
    pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
  }
}

/**
 * Parse a recipe file body. Strict on the load-bearing fields (schema, a
 * digits-only id, a non-empty cwd, a string argv, launcher 'hoai'), tolerant
 * on the informational ones (absent -> null). Null for anything else.
 * @param {string | null | undefined} raw
 * @returns {LaunchRecipe | null}
 */
export function parseLaunchRecipe(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.schemaVersion !== LAUNCH_RECIPE_SCHEMA_VERSION) return null
  const assistantId = validAssistantId(parsed.assistantId)
  if (!assistantId) return null
  if (typeof parsed.cwd !== 'string' || parsed.cwd.length === 0) return null
  if (!Array.isArray(parsed.argv) || !parsed.argv.every((a) => typeof a === 'string')) return null
  if (parsed.launcher !== 'hoai') return null
  const pid = parsed.pid
  return {
    schemaVersion: LAUNCH_RECIPE_SCHEMA_VERSION,
    assistantId,
    cwd: parsed.cwd,
    argv: stripSessionArgs(parsed.argv),
    installMethod: optionalString(parsed.installMethod),
    pluginRoot: optionalString(parsed.pluginRoot),
    node: optionalString(parsed.node),
    claudeConfigDir: optionalString(parsed.claudeConfigDir),
    startedAt: optionalString(parsed.startedAt),
    launcher: 'hoai',
    pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
  }
}

/**
 * Persist a recipe at ~/.bgos-agent/<id>/launch.json (pretty JSON, LF).
 * Returns false (never throws) on a bad id or a failed write.
 * @param {{ home: string, assistantId: string | number, recipe: LaunchRecipe,
 *   writeFile?: (path: string, content: string) => boolean }} params
 */
export function writeLaunchRecipe({ home, assistantId, recipe, writeFile = defaultWriteText }) {
  const path = launchRecipePath(home, assistantId)
  if (!path || !recipe) return false
  try {
    return Boolean(writeFile(path, `${JSON.stringify(recipe, null, 2)}\n`))
  } catch {
    return false
  }
}

/**
 * Read + parse the recipe for an agent; null when absent, junk, or bad id.
 * @param {{ home: string, assistantId: string | number, readFile?: (path: string) => string | null }} params
 */
export function readLaunchRecipe({ home, assistantId, readFile = defaultReadText }) {
  const path = launchRecipePath(home, assistantId)
  if (!path) return null
  return parseLaunchRecipe(readFile(path))
}

// -- Supervisor detection --------------------------------------------------------

/**
 * The canonical bin/bgos-agent service for this id, when it is installed, with
 * the name it is registered under. Which name it is registered under is a file
 * fact on posix (this HOME's new service file, else its OLD one: an agent not
 * renamed yet); on Windows the launcher file says nothing about the name, so
 * the row names the NEW task and carries the old one (`legacyHandle`) for the
 * read-back every act makes first (lib/agent-task-win32.mjs runAgentTask).
 */
function canonicalService(platform, home, assistantId, exists) {
  const id = validAssistantId(assistantId)
  if (!id) return null
  const names = agentServiceNamesFor(id, home, platform)
  if (platform === 'win32') {
    // The Windows agent task (G7): the same pure exists test as the posix
    // tier, on the launcher the task runs. No schtasks query here, so the
    // heartbeat's inventory costs no process per agent per minute.
    const file = joinDir(agentStateDir(home, id), AGENT_TASK_LAUNCHER_FILE_NAME)
    return exists(file) ? { kind: 'schtasks', handle: names.current.taskName, legacyHandle: names.legacy.taskName, via: 'canonical-file', file } : null
  }
  for (const side of [names.current, names.legacy]) {
    const file = serviceFilePath(platform, home, id, side.homeId)
    if (!file || !exists(file)) continue
    return platform === 'darwin'
      ? { kind: 'launchd', handle: side.launchdLabel, via: 'canonical-file', file }
      : { kind: 'systemd', handle: side.systemdUnit, via: 'canonical-file', file }
  }
  return null
}

/**
 * What would restart this agent right now, strongest evidence first, WITH the
 * job a restart must be addressed to (mirror of lib/update-readiness.ts
 * resolveSupervision, in the watcher's vocabulary).
 *
 * Tier 1 is the canonical bin/bgos-agent name (a pure `exists` test, so it
 * answers with no probes at all). Tier 2 asks the platform which LOADED job
 * names this agent, which is how an agent some other launcher installed under
 * its own label is seen at all; it needs `listDir` and `execSync` and, without
 * them, simply does not run, leaving the pre-discovery answer. Tier 3 is the
 * live hoai launcher's supervisor.json (isLiveHoaiLauncher: its pid alive AND
 * still the launcher that wrote the file).
 *
 * @param {{ platform: string, home: string, assistantId: string | number,
 *   exists: (path: string) => boolean, readFile: (path: string) => string | null,
 *   pidAlive?: (pid: number) => boolean, cwd?: string | null,
 *   listDir?: (path: string) => string[],
 *   execSync?: (file: string, args: string[]) => { code: number, stdout: string },
 *   now?: number,
 *   launcherProcesses?: Map<number, { command: string | null, startedAtMs: number | null,
 *     boot?: { id: string, startedUptimeMs: number } }> | null }} probe
 * @returns {{ supervisor: 'service' | 'launcher-live' | 'none',
 *   service: import('./service-supervision.mjs').ResolvedService | null }}
 */
export function resolveAgentSupervisor({
  platform,
  home,
  assistantId,
  exists,
  readFile,
  pidAlive = defaultPidAlive,
  cwd = null,
  listDir,
  execSync,
  jobs = null,
  now = Date.now(),
  launcherProcesses = null,
}) {
  const canonical = canonicalService(platform, home, assistantId, exists)
  if (canonical) return { supervisor: 'service', service: canonical }
  const discovered = resolveSupervisingService({
    platform,
    home,
    assistantId,
    cwd,
    listDir,
    readFile,
    execSync,
    jobs,
  })
  if (discovered) return { supervisor: 'service', service: discovered }
  // Tier 2b: the agent's own daemon published which service it resolved for
  // itself. The watcher has no working directory for an agent hoai did not
  // launch (no launch.json), and the working directory is the anchor that
  // finds a bespoke supervisor, so without this the watcher is blind to
  // exactly the agents this whole change is about. The record is a HINT and
  // is re-verified against the live job list before it counts; a stale or
  // tampered one yields nothing rather than a restart of something else.
  const recordPath = serviceRecordPath(home, assistantId)
  if (recordPath) {
    const published = verifyServiceRecord({
      record: parseServiceRecord(readFile(recordPath)),
      platform,
      home,
      assistantId,
      listDir,
      readFile,
      execSync,
      jobs,
    })
    if (published) return { supervisor: 'service', service: published }
  }
  const path = supervisorPath(home, assistantId)
  if (path) {
    const supervisor = parseSupervisorRecord(readFile(path))
    // listAgents reads every launcher's command line and start time in one
    // query and hands the answers in; a caller on its own asks for this one
    // pid (and without an exec, liveness alone decides, as before).
    const processes =
      launcherProcesses ??
      (supervisor && pidAlive(supervisor.pid)
        ? readLauncherProcesses({ platform, pids: [supervisor.pid], execSync, now, bootClock: () => readBootClock({ platform, readFile }) })
        : null)
    if (isLiveHoaiLauncher({ supervisor, pidAlive, processes })) {
      return { supervisor: 'launcher-live', service: null }
    }
  }
  return { supervisor: 'none', service: null }
}

/**
 * The supervisor name alone.
 * @param {Parameters<typeof resolveAgentSupervisor>[0]} probe
 * @returns {'service' | 'launcher-live' | 'none'}
 */
export function detectSupervisor(probe) {
  return resolveAgentSupervisor(probe).supervisor
}

// -- The inventory -----------------------------------------------------------------

/**
 * Validate a parsed recipe against the disk. Returns the recipe to keep (or
 * null) and the notes explaining a drop. Rules:
 *   - assistantId must equal the state dir's id;
 *   - cwd must exist;
 *   - the cwd's folder pin must name this id; an unpinned cwd is accepted
 *     only on a single-agent host (hoai resolves the sole paired agent), a
 *     pin naming another agent is always a drop (wrong identity).
 * @param {{ recipe: LaunchRecipe | null, raw: string | null, assistantId: string,
 *   pairedCount: number, exists: (p: string) => boolean, readFile: (p: string) => string | null }} params
 */
export function validateRecipeOnDisk({ recipe, raw, assistantId, pairedCount, exists, readFile }) {
  const notes = []
  if (!recipe) {
    if (raw != null) notes.push('recipe_unreadable')
    return { recipe: null, notes }
  }
  if (recipe.assistantId !== assistantId) {
    notes.push(`recipe_assistant_mismatch:${recipe.assistantId}`)
    return { recipe: null, notes }
  }
  if (!exists(recipe.cwd)) {
    notes.push(`recipe_cwd_missing:${recipe.cwd}`)
    return { recipe: null, notes }
  }
  const pin = readFolderPin(recipe.cwd, readFile)
  if (pin && pin !== assistantId) {
    notes.push(`recipe_cwd_pinned_to_other_agent:${pin}`)
    return { recipe: null, notes }
  }
  if (!pin && pairedCount > 1) {
    notes.push('recipe_cwd_unpinned_on_multi_agent_host')
    return { recipe: null, notes }
  }
  return { recipe, notes }
}

/**
 * The agents this machine declares in a folder rather than in
 * ~/.bgos-agent/credentials-<id>.json.
 *
 * WHY THIS EXISTS. There is no single registry of agents on a machine, by
 * design: lib/agent-credentials.ts supports two auth topologies, and only one
 * of them leaves a credentials file. `bgos-pair` (pairing token) writes
 * ~/.bgos-agent/credentials-<id>.json; `bgos-agent install --key --user`
 * (write_mcp_json) and `bgos-claim` (the Agent Pack installer) write the API
 * key into the agent folder's .mcp.json and NO credentials file at all. An
 * inventory keyed only on credentials files therefore cannot see a whole
 * supported class of agent, and on the BGOS dev Mac it did not see the
 * orchestrator: eight agents run, seven have credentials files, and agent 900
 * was absent from the inventory entirely, so a reconcile gave it no step at
 * all rather than a failed one. A checklist that silently omits a row is worse
 * than one that reports a failure, because it looks complete.
 *
 * WHAT IS SEARCHED, and what is therefore still invisible. We cannot enumerate
 * every folder on a machine, so this does not try. It reads the WORKING
 * DIRECTORY of each LOADED service job, which is a bounded set the platform
 * already told us about, and asks whether that folder declares a HOAI
 * assistant (lib/service-supervision.mjs readFolderIdentity, the same reader
 * the working-directory anchor uses: .bgos-agent-id or .mcp.json's
 * BGOS_ASSISTANT_ID). That set is exactly the agents a restart could act on
 * anyway. An agent with no credentials file whose folder is named by no loaded
 * job stays undiscoverable AND unrestartable from here; listAgents reports the
 * basis of the inventory so a caller never reads completeness into it.
 *
 * Fail closed on ambiguity, but never by vanishing: when more than one distinct
 * folder declares the SAME assistant, the agent is still discovered (it gets a
 * row and an honest step) but with no cwd, so no restart is aimed at a folder
 * we cannot choose between.
 *
 * @param {{ home: string, jobs: ReturnType<typeof listLoadedJobs>,
 *   readFile: (path: string) => string | null }} params
 * @returns {Map<string, { cwd: string | null, notes: string[] }>}
 */
export function discoverFolderAgents({ home, jobs, readFile }) {
  /** @type {Map<string, Set<string>>} */
  const byId = new Map()
  for (const entry of Array.isArray(jobs) ? jobs : []) {
    const cwd = String(entry?.job?.workingDirectory ?? '').trim().replace(/[\\/]+$/, '')
    if (!cwd) continue
    // The home directory is shared by everything and identifies no agent.
    if (cwd === String(home ?? '').trim().replace(/[\\/]+$/, '')) continue
    const declared = readFolderIdentity(cwd, readFile)
    // readFolderIdentity already resolves a folder that declares two different
    // identities to a null id, so "declares no id" is the only check needed.
    // A second conflict test here would be unreachable, and an unreachable
    // guard cannot be proven by a mutant, which is how a guard rots.
    if (!declared.id) continue
    if (!byId.has(declared.id)) byId.set(declared.id, new Set())
    byId.get(declared.id).add(cwd)
  }
  /** @type {Map<string, { cwd: string | null, notes: string[] }>} */
  const out = new Map()
  for (const [assistantId, cwds] of byId) {
    if (cwds.size === 1) {
      out.set(assistantId, { cwd: [...cwds][0], notes: [] })
      continue
    }
    out.set(assistantId, {
      cwd: null,
      notes: [`ambiguous_supervised_folders:${cwds.size}`],
    })
  }
  return out
}

/**
 * Every paired agent on this machine (ids from credentials-<id>.json), with
 * its restart authority, its validated recipe, and every path the watcher
 * needs. Ascending id order (stable, the planner relies on it). Never reads
 * a credentials file's CONTENT; never throws.
 * @param {{ home: string, env?: Record<string, string | undefined>, platform?: string,
 *   fs?: InventoryFs, pidAlive?: (pid: number) => boolean,
 *   execSync?: (file: string, args: string[]) => { code: number, stdout: string }, now?: number,
 *   uid?: number | null, includeIds?: string[] }} params
 * `includeIds` adds agents the caller already knows by id (digits only, junk
 * dropped) although this host has no credentials-<id>.json for them: an agent
 * whose key lives in its folder's .mcp.json. The restart takeover helper
 * (lib/restart-handoff.mjs) passes its own agent; the default adds nothing.
 * @returns {AgentRow[]}
 */
export function listAgents({ home, env = {}, platform = process.platform, fs = defaultInventoryFs(), pidAlive = defaultPidAlive, execSync = defaultExecSync, now = Date.now(), uid = defaultUid(), includeIds = [] }) {
  const exists = fs.exists ?? defaultExists
  const readFile = fs.readFile ?? defaultReadText
  const listDir = fs.listDir ?? defaultListDir
  const paired = listPairedAssistantIds(home, listDir)
  // One sweep of the loaded jobs for the whole fleet: it answers both "which
  // job supervises agent N" and "which folders declare an agent we have no
  // credentials file for".
  const jobs = listLoadedJobs({ platform, home, listDir, readFile, execSync })
  const folderAgents = discoverFolderAgents({ home, jobs, readFile })
  const pairedSet = new Set(paired)
  const asked = (Array.isArray(includeIds) ? includeIds : []).map((id) => validAssistantId(id)).filter((id) => id !== null)
  const ids = [...new Set([...paired, ...folderAgents.keys(), ...asked])].sort((a, b) => Number(a) - Number(b))
  // Every agent's supervisor.json, and the command lines and start times of
  // the live pids they name, read in ONE query for the whole fleet
  // (readLauncherProcesses).
  const supervisorFiles = new Map(ids.map((id) => [id, parseSupervisorRecord(readFile(supervisorPath(home, id)))]))
  const launcherProcesses = readLauncherProcesses({
    platform,
    pids: [...supervisorFiles.values()].filter((s) => s && s.capabilities.includes('relaunch') && pidAlive(s.pid)).map((s) => s.pid),
    execSync,
    now,
    bootClock: () => readBootClock({ platform, readFile }),
  })
  // One process table for every keepalive.json on this listing, read only if one exists (F6).
  const keepaliveTable = keepaliveProcessTable({ execSync, now, bootClock: () => readBootClock({ platform, readFile }) })
  return ids.map((assistantId) => {
    const stateDir = agentStateDir(home, assistantId)
    const raw = readFile(launchRecipePath(home, assistantId))
    const validated = validateRecipeOnDisk({
      recipe: parseLaunchRecipe(raw),
      raw,
      assistantId,
      pairedCount: ids.length,
      exists,
      readFile,
    })
    const folder = folderAgents.get(assistantId) ?? null
    // The recipe cwd is the only working directory this machine can vouch
    // for: validateRecipeOnDisk already refused a cwd pinned to another
    // agent, so a job matched by it cannot belong to a different identity.
    // Failing that, the folder a loaded job runs this agent in, which the
    // folder's own config declared to be this agent.
    const cwd = validated.recipe ? validated.recipe.cwd : (folder?.cwd ?? null)
    const resolved = resolveAgentSupervisor({
      platform,
      home,
      assistantId,
      exists,
      readFile,
      pidAlive,
      cwd,
      listDir,
      execSync,
      jobs,
      now,
      launcherProcesses,
    })
    const supervisor = resolved.supervisor
    const sessionRaw = String(readFile(sessionIdPath(home, assistantId)) ?? '').trim()
    const supervisorFile = supervisorFiles.get(assistantId) ?? null
    const canonical = resolved.service?.via === 'canonical-file'
    return {
      assistantId,
      home,
      cwd,
      discoveredVia: pairedSet.has(assistantId) ? 'credentials' : 'supervised-folder',
      recipe: validated.recipe,
      supervisor,
      running: supervisor !== 'none',
      service: resolved.service,
      serviceFile: resolved.service?.file ?? null,
      keepalive: verifyKeepaliveMarker({ platform, home, assistantId, readFile, pidAlive, execSync, now, uid, cwd, table: keepaliveTable, agentStatePath: joinDir(pluginStateDirFor({ env, home, assistantId, cwd: cwd ?? '' }), AGENT_STATE_FILE_NAME) }),
      keepaliveDeclared: Boolean(readDeclaredKeepalive({ platform, home, assistantId, readFile, pidAlive, execSync, now, uid, table: keepaliveTable })),
      supervisorGeneration: canonical ? parseSupervisorGeneration(readFile(supervisorGenerationPath(home, assistantId))) : null,
      launcherLive: isLiveHoaiLauncher({ supervisor: supervisorFile, pidAlive, processes: launcherProcesses }),
      sessionId: isSessionIdLike(sessionRaw) ? sessionRaw : null,
      stateDir,
      pluginStateDir: pluginStateDirFor({ env, home, assistantId, cwd: cwd ?? '' }),
      liveMarkerPath: liveMarkerPathFor({ env, home, assistantId, cwd: cwd ?? '' }),
      credentialsPath: credentialsPath(home, assistantId),
      notes: [...validated.notes, ...(folder?.notes ?? [])],
    }
  })
}
