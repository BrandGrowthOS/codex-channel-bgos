/**
 * service-supervision: WHICH service-manager job actually supervises a given
 * HOAI agent on this machine.
 *
 * Why this exists. Both restart-authority readers (lib/update-readiness.ts for
 * the daemon's own heartbeat, lib/agent-inventory.mjs for the per-machine
 * watcher) used to answer "is this agent supervised?" by testing whether ONE
 * hardcoded path exists: ~/Library/LaunchAgents/ai.bgos.agent.<id>.plist, or
 * ~/.config/systemd/user/bgos-agent-<id>.service. That is the label
 * bin/bgos-agent installs, so it is right whenever bgos-agent did the install
 * and wrong for every other launcher. On the BGOS dev Mac, 7 of 8 agents are
 * supervised by launchd under bespoke labels (ai.bgos.session.<id>) written by
 * hand, so all 7 reported 'none' and the app withheld the one-click update
 * button from daemons launchd would happily have restarted. Adding the second
 * label to the hardcoded list would fix exactly that machine and go dark again
 * on the next bespoke name, so this module ASKS THE PLATFORM instead.
 *
 * The question it answers is deliberately narrow: "is there a job that is
 * LOADED in this user's service manager right now whose own launch recipe
 * names THIS agent?" Two anchors count as naming the agent, both of which are
 * the agent's own identity-bearing paths rather than a name we hope for:
 *
 *   state-dir          the job's program arguments / stdout / stderr / working
 *                      directory point inside ~/.bgos-agent/<id>, the per-agent
 *                      state dir. Only this agent's launcher writes there.
 *   working-directory  the job's WorkingDirectory IS the agent's working
 *                      directory. That is the identity-bearing match: an agent
 *                      takes its identity from the .mcp.json of the folder it
 *                      runs in (docs/learnings fleet-restart identity bleed),
 *                      so a job that re-runs its recipe in that same folder
 *                      brings back THAT agent and no other.
 *
 * Safety posture, in order of how much it matters:
 *
 *   1. FAIL CLOSED. No loaded-job list, no readable job detail, no match, or
 *      MORE than one equally-strong match all resolve to null, which every
 *      caller reads as "no service authority". A wrong 'none' costs a button;
 *      a wrong 'yes' restarts something that is not this agent.
 *   2. THE RESTART GOES THROUGH THE SUPERVISOR. Whatever is resolved carries
 *      the handle (launchd label / systemd unit) it was resolved BY, and the
 *      restart command is built from that handle: `launchctl kickstart -k` /
 *      `systemctl --user restart`. The supervisor then re-runs the original
 *      launch recipe, in its own WorkingDirectory, reading its own .mcp.json.
 *      Nothing here ever hand-rolls a relaunch, changes a working directory,
 *      or passes --continue / --resume / a session id. That combination is the
 *      identity bleed that cost this project a fleet and a day of credits.
 *   3. NO INJECTION SURFACE. A discovered handle is user-writable data (it
 *      comes off disk), so it is validated against SERVICE_HANDLE_RE before it
 *      is allowed anywhere near a command line, and a handle that fails builds
 *      no command at all.
 *
 * Everything is pure or has its probes injected (listDir / readFile / execSync),
 * so the whole ladder is unit-testable without a service manager. Plain
 * JavaScript, node >= 18 builtins only, import-safe: lib/update-readiness.ts
 * imports it from Bun and the watcher bundle imports it from bare node.
 */

import { execFileSync } from 'node:child_process'

/** Join dir + name preserving the dir's separator style (mirror of agent-inventory joinDir). */
export function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** Assistant ids are digits-only everywhere (mirror of bin/bgos-agent valid_id). */
export function validAssistantId(id) {
  const value = String(id ?? '').trim()
  return /^\d+$/.test(value) ? value : null
}

/**
 * What a launchd label / systemd unit name may look like before it is allowed
 * onto a command line. No whitespace, no quote, no shell metacharacter, so
 * `launchctl kickstart -k gui/<uid>/<handle>` inside `sh -c` is inert.
 */
export const SERVICE_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/

export function isSafeServiceHandle(handle) {
  return SERVICE_HANDLE_RE.test(String(handle ?? ''))
}

/** The user-level job directories we can inspect, per platform. */
export function launchAgentsDir(home) {
  return joinDir(joinDir(home, 'Library'), 'LaunchAgents')
}

export function systemdUserDir(home) {
  return joinDir(joinDir(joinDir(home, '.config'), 'systemd'), 'user')
}

/** The per-agent state dir (mirror of bin/bgos-agent statedir_for). */
export function agentStateDirFor(home, assistantId) {
  const id = validAssistantId(assistantId)
  return id ? joinDir(joinDir(home, '.bgos-agent'), id) : null
}

/**
 * @typedef {{ handle: string, workingDirectory: string, paths: string[] }} ServiceJob
 * @typedef {'canonical-file' | 'state-dir' | 'working-directory' | 'declared'} ServiceMatchVia
 * @typedef {{ kind: 'launchd' | 'systemd', handle: string, via: ServiceMatchVia,
 *   file: string | null, restartCommand?: { file: string, args: string[] } }} ResolvedService
 * @typedef {{ code: number, stdout: string }} SyncExecResult
 *
 * `via: 'declared'` and the optional `restartCommand` exist for the ONE tier
 * the platform is never asked about: a supervisor the launcher DECLARED to the
 * daemon in its own environment (lib/update-readiness.ts, BGOS_SUPERVISOR_*).
 * A declared service is trusted on its own because the env that carried it can
 * only have been set by whatever started the process, so it needs no live
 * discovery to agree. It is a DAEMON-SELF authority only: it is never written
 * to service.json and never reaches buildServiceRecord/verifyServiceRecord,
 * which stay guess-verified for the cross-agent watcher (parseServiceRecord
 * still whitelists only the three discovered provenances).
 */

// -- Default probes -----------------------------------------------------------------

const EXEC_TIMEOUT_MS = 5000

/** A synchronous exec that never throws; a failure reads as a non-zero code. */
export function defaultExecSync(file, args) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { code: 0, stdout: String(stdout ?? '') }
  } catch (err) {
    return { code: typeof err?.status === 'number' ? err.status : 1, stdout: String(err?.stdout ?? '') }
  }
}

// -- Parsers (pure) -----------------------------------------------------------------

/**
 * The LOADED launchd labels from `launchctl list` output (tab separated
 * PID / Status / Label, one header line). A job with no pid is still loaded
 * and still kickstartable, so the pid column is ignored on purpose.
 * @param {string | null | undefined} text
 * @returns {Set<string>}
 */
export function parseLaunchctlList(text) {
  const labels = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.split('\t')
    if (cols.length < 3) continue
    const label = cols[cols.length - 1].trim()
    if (!label || label === 'Label') continue
    if (!isSafeServiceHandle(label)) continue
    labels.add(label)
  }
  return labels
}

/**
 * The LOADED systemd --user unit names from `systemctl --user list-units
 * --type=service --all --no-legend --plain` output. Tolerates the bullet
 * column systemd prints for failed units.
 * @param {string | null | undefined} text
 * @returns {Set<string>}
 */
export function parseSystemctlUnitList(text) {
  const units = new Set()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s●•*x]+/, '').trim()
    if (!line) continue
    const name = line.split(/\s+/)[0]
    if (!name || !name.endsWith('.service')) continue
    if (!isSafeServiceHandle(name)) continue
    units.add(name)
  }
  return units
}

function pushPath(list, value) {
  if (typeof value === 'string' && value.length > 0) list.push(value)
}

/**
 * A launchd job's identity-bearing fields, from `plutil -convert json` output.
 * The Label is the job's own name, which is what launchctl addresses, so it is
 * read from the file rather than assumed from the file name.
 * @param {string | null | undefined} text
 * @returns {ServiceJob | null}
 */
export function parseLaunchdJobJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const handle = typeof parsed.Label === 'string' ? parsed.Label.trim() : ''
  if (!handle) return null
  const workingDirectory =
    typeof parsed.WorkingDirectory === 'string' ? parsed.WorkingDirectory.trim() : ''
  const paths = []
  if (Array.isArray(parsed.ProgramArguments)) {
    for (const arg of parsed.ProgramArguments) pushPath(paths, arg)
  }
  pushPath(paths, parsed.Program)
  pushPath(paths, parsed.StandardOutPath)
  pushPath(paths, parsed.StandardErrorPath)
  pushPath(paths, workingDirectory)
  return { handle, workingDirectory, paths }
}

/** Unit-file directives whose values name a path we can match an agent by. */
const SYSTEMD_PATH_KEYS = new Set([
  'workingdirectory',
  'execstart',
  'execstartpre',
  'execstartpost',
  'standardoutput',
  'standarderror',
  'environmentfile',
])

/**
 * A systemd unit file's identity-bearing fields. The unit NAME is the file
 * name (systemd has no in-file name key), so the caller supplies it.
 * @param {string} handle
 * @param {string | null | undefined} text
 * @returns {ServiceJob | null}
 */
export function parseSystemdUnitFile(handle, text) {
  const name = String(handle ?? '').trim()
  if (!name || typeof text !== 'string' || text.length === 0) return null
  let workingDirectory = ''
  const paths = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    if (!SYSTEMD_PATH_KEYS.has(key) || !value) continue
    if (key === 'workingdirectory' && !workingDirectory) workingDirectory = value
    if (key.startsWith('exec')) {
      // An Exec* value is a command LINE, so the paths in it are its tokens.
      // systemd's per-command prefix characters (-, @, +, !, :) are not part
      // of the executable path and would defeat an inside-the-state-dir test.
      for (const token of value.split(/\s+/)) pushPath(paths, token.replace(/^[-@+!:]+/, ''))
      continue
    }
    pushPath(paths, value)
  }
  return { handle: name, workingDirectory, paths }
}

// -- Matching (pure) ----------------------------------------------------------------

/** Is `path` the directory `dir` itself, or something inside it? */
export function pathIsInside(path, dir) {
  const target = String(dir ?? '')
  const value = String(path ?? '')
  if (!target || !value) return false
  if (value === target) return true
  return value.startsWith(`${target}/`) || value.startsWith(`${target}\\`)
}

/**
 * Does this loaded job name THIS agent, and by which anchor? The state dir is
 * the stronger anchor (it carries the assistant id), so it is tested first.
 * A cwd anchor is only honoured for an EXACT WorkingDirectory match: a
 * substring or prefix test would let a parent folder claim every agent under it.
 * @param {{ job: ServiceJob | null, stateDir: string | null, cwd: string | null }} params
 * @returns {'state-dir' | 'working-directory' | null}
 */
export function matchJobToAgent({ job, stateDir, cwd }) {
  if (!job) return null
  const dir = String(stateDir ?? '')
  if (dir && job.paths.some((path) => pathIsInside(path, dir))) return 'state-dir'
  const workdir = String(cwd ?? '')
  if (workdir && job.workingDirectory && job.workingDirectory === workdir) {
    return 'working-directory'
  }
  return null
}

/** Anchor strength, strongest first. Used to break a tie before failing closed. */
const VIA_STRENGTH = ['state-dir', 'working-directory']

/**
 * The single match to trust, or null. A tie between two jobs at the SAME
 * anchor strength is unresolvable, and guessing which of two agents a restart
 * belongs to is exactly the failure this module exists to prevent, so it fails
 * closed. A stronger anchor beats a weaker one outright.
 * @param {ResolvedService[]} matches
 * @returns {ResolvedService | null}
 */
export function pickSoleMatch(matches) {
  const list = Array.isArray(matches) ? matches : []
  if (list.length === 0) return null
  if (list.length === 1) return list[0]
  for (const via of VIA_STRENGTH) {
    const tier = list.filter((m) => m.via === via)
    if (tier.length === 1) return tier[0]
    if (tier.length > 1) return null
  }
  return null
}

// -- The resolver -------------------------------------------------------------------

/** Mirror of bin/bgos-pair.mjs FOLDER_PIN_FILE_NAME / agent-inventory readFolderPin. */
export const FOLDER_PIN_FILE_NAME = '.bgos-agent-id'
/** The launch config an agent's identity actually comes from. */
export const MCP_CONFIG_FILE_NAME = '.mcp.json'

/**
 * The assistant id a folder's .mcp.json declares, from
 * `mcpServers.<any>.env.BGOS_ASSISTANT_ID` (the key bin/bgos-pair.mjs
 * bakeMcpPin writes and bin/bgos-daemon-wrapper.mjs reads back). Every server
 * entry is scanned rather than just `bgos`, because the marketplace topology
 * names the server differently.
 *
 * Returns the id, `null` when the file declares none, or `'conflict'` when two
 * entries declare DIFFERENT ids, which is a folder whose identity cannot be
 * established and must never be used to claim a job.
 *
 * NOTHING but the id leaves this function. The same file holds BGOS_API_KEY,
 * so the parsed object is never returned, logged, or attached to a row.
 *
 * @param {string | null | undefined} raw
 * @returns {string | null | 'conflict'}
 */
function mcpServerEntries(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return []
  // A UTF-8 BOM survives readFileSync(path, 'utf8') and JSON.parse rejects it, which
  // read a valid .mcp.json as "no server of ours" (Minerva 972, 2026-09-02). The
  // agent still booted, Claude Code hands BGOS_ASSISTANT_ID through process.env,
  // but every reader in this file lost her: supervision, inventory, self-update.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const servers = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.mcpServers : null
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
  const entries = []
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) continue
    const env = server.env && typeof server.env === 'object' && !Array.isArray(server.env) ? server.env : null
    entries.push({ name, env })
  }
  return entries
}

export function parseMcpAssistantId(raw) {
  const found = new Set()
  for (const entry of mcpServerEntries(raw)) {
    if (!entry.env) continue
    const id = validAssistantId(entry.env.BGOS_ASSISTANT_ID)
    if (id) found.add(id)
  }
  if (found.size === 0) return null
  if (found.size > 1) return 'conflict'
  return [...found][0]
}

/**
 * Every distinct value the server entries' env blocks give `key` (trimmed, in
 * file order, unexpanded), an empty string included: a block that sets the key
 * to nothing still overrides the shell's value for the daemon, so "set to
 * nothing" and "not set" must stay apart. The doctor reads BGOS_CREDENTIALS_PATH
 * and BGOS_ASSISTANT_ID through this; both are what Claude Code hands the daemon.
 *
 * Same secrecy rule as parseMcpAssistantId: only the values of the one key
 * leave, never the parsed object, because the file holds BGOS_API_KEY.
 *
 * @param {string | null | undefined} raw
 * @param {string} key
 * @returns {string[]}
 */
export function mcpEnvValues(raw, key) {
  const found = []
  for (const entry of mcpServerEntries(raw)) {
    const written = entry.env ? entry.env[key] : null
    if (written == null) continue
    const value = String(written).trim()
    if (!found.includes(value)) found.push(value)
  }
  return found
}

/** A channel server name safe to hand to claude as `server:<name>`. Claude Code
 *  MCP server keys are identifier-ish; anything else is treated as not ours. */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The NAME of the `.mcp.json` server entry that is OURS, which is the second
 * half of the channel spec: Claude Code loads that entry's channel as
 * `server:<name>`.
 *
 * "Ours" is decided by the entry's env carrying a `BGOS_` key, not by the name
 * being `bgos`. Every writer in this repo sets at least BGOS_BACKEND_URL
 * (bin/bgos-agent write_mcp_json, bin/bgos-claim.mjs buildMcpJson, both
 * bootstraps, .mcp.json.example), and the name is exactly the thing a user may
 * legitimately have changed, so keying on the name would defeat the purpose.
 *
 * Returns the name, `null` when the file declares no server of ours, or
 * `'conflict'` when MORE than one entry looks like ours: two of our channels in
 * one workspace has no single right answer, and guessing is how an agent ends
 * up loading a channel nobody is delivering to.
 *
 * Same secrecy rule as parseMcpAssistantId, and it matters as much here: this
 * file holds BGOS_API_KEY, so only the validated NAME ever leaves.
 *
 * @param {string | null | undefined} raw
 * @returns {string | null | 'conflict'}
 */
export function parseMcpChannelServerName(raw) {
  const found = new Set()
  for (const entry of mcpServerEntries(raw)) {
    if (!entry.env) continue
    const ours = Object.keys(entry.env).some((key) => key.startsWith('BGOS_'))
    if (!ours) continue
    if (!MCP_SERVER_NAME_RE.test(entry.name)) continue
    found.add(entry.name)
  }
  if (found.size === 0) return null
  if (found.size > 1) return 'conflict'
  return [...found][0]
}

/**
 * The assistant id a folder DECLARES itself to belong to, from either source
 * of truth: the `.bgos-agent-id` folder pin, or `.mcp.json`'s
 * BGOS_ASSISTANT_ID. Either one is authoritative; disagreement is a conflict.
 *
 * Both sources are read because only checking the pin file was inert on the
 * whole BGOS dev fleet: `bakeLaunchPin` writes the pin, but the eight agents
 * on that Mac predate it, so every folder has NO `.bgos-agent-id` while every
 * `.mcp.json` carries the real BGOS_ASSISTANT_ID. A veto that reads only the
 * file nobody wrote is a safety property in the comments and nowhere else.
 *
 * `source` names WHICH file answered, so a caller can tell the user where the
 * identity came from. Telling someone their folder "has no .bgos-agent-id pin"
 * when .mcp.json declares the id two lines away sends them looking for a file
 * that was never supposed to exist.
 *
 * @param {string} cwd
 * @param {(path: string) => string | null} readFile
 * @returns {{ id: string | null, conflict: boolean, source: 'pin' | 'mcp' | null }}
 */
export function readFolderIdentity(cwd, readFile) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return { id: null, conflict: false, source: null }
  const fromPin = validAssistantId(readFile(joinDir(dir, FOLDER_PIN_FILE_NAME)))
  const fromMcp = parseMcpAssistantId(readFile(joinDir(dir, MCP_CONFIG_FILE_NAME)))
  if (fromMcp === 'conflict') return { id: null, conflict: true, source: null }
  if (fromPin && fromMcp && fromPin !== fromMcp) return { id: null, conflict: true, source: null }
  if (fromPin) return { id: fromPin, conflict: false, source: 'pin' }
  if (fromMcp) return { id: fromMcp, conflict: false, source: 'mcp' }
  return { id: null, conflict: false, source: null }
}

/**
 * Is the agent's working directory specific enough, and safe enough, to
 * identify a job by?
 *
 * Refused when it is empty, the filesystem root, or the home directory: those
 * are shared by everything on the box, so they identify nothing and would
 * match jobs belonging to other agents.
 *
 * Refused when the folder DECLARES a different assistant, or declares two at
 * once. The whole reason a working directory identifies an agent is that the
 * agent's identity comes from that folder; a folder saying it belongs to
 * someone else is that assumption failing out loud, and a restart aimed there
 * would start the wrong agent. A folder that declares nothing stays usable, so
 * a single-agent host with no config at all is unaffected.
 */
function usableCwd(cwd, home, assistantId, readFile) {
  const value = String(cwd ?? '').trim().replace(/[\\/]+$/, '')
  if (!value) return ''
  const homeValue = String(home ?? '').trim().replace(/[\\/]+$/, '')
  if (homeValue && value === homeValue) return ''
  if (value === '/' || value === '\\') return ''
  const declared = readFolderIdentity(value, readFile)
  if (declared.conflict) return ''
  if (declared.id && declared.id !== String(assistantId ?? '')) return ''
  return value
}

/** Job files whose raw bytes mention one of the anchors; a cheap prefilter so
 *  the expensive per-job read only runs for plausible candidates. Works on a
 *  binary plist too, whose path values are still stored as plain bytes. */
function candidateFiles({ dir, suffix, anchors, listDir, readFile }) {
  const out = []
  let names = []
  try {
    names = listDir(dir) ?? []
  } catch {
    return out
  }
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith(suffix)) continue
    const path = joinDir(dir, name)
    const raw = readFile(path)
    if (typeof raw !== 'string' || raw.length === 0) continue
    if (!anchors.some((anchor) => raw.includes(anchor))) continue
    out.push({ name, path, raw })
  }
  return out
}

/**
 * Every LOADED job this machine can be asked about, with its identity-bearing
 * fields. One enumeration, shared by the per-agent resolver and by the folder
 * discovery in lib/agent-inventory.mjs, so a watcher pass costs ONE sweep
 * rather than one per agent.
 *
 * A job that is not loaded is never returned: it restarts nothing.
 *
 * @param {{ platform: string, home: string, listDir?: (path: string) => string[],
 *   readFile?: (path: string) => string | null,
 *   execSync?: (file: string, args: string[]) => SyncExecResult }} params
 * @returns {{ kind: 'launchd' | 'systemd', handle: string, file: string, job: ServiceJob }[]}
 */
export function listLoadedJobs({ platform, home, listDir, readFile, execSync = defaultExecSync }) {
  if (typeof listDir !== 'function' || typeof readFile !== 'function') return []
  try {
    if (platform === 'darwin') return listLoadedLaunchdJobs({ home, listDir, readFile, execSync })
    if (platform === 'linux') return listLoadedSystemdUnits({ home, listDir, readFile, execSync })
  } catch {
    return []
  }
  return []
}

function listLoadedLaunchdJobs({ home, listDir, readFile, execSync }) {
  // Only a LOADED job is a restart authority: a plist sitting unloaded on disk
  // cannot bring anything back, and `launchctl kickstart` on it fails.
  const loaded = parseLaunchctlList(execSync('launchctl', ['list']).stdout)
  if (loaded.size === 0) return []
  const dir = launchAgentsDir(home)
  const labels = [...loaded]
  const out = []
  let names = []
  try {
    names = listDir(dir) ?? []
  } catch {
    return out
  }
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith('.plist')) continue
    const path = joinDir(dir, name)
    const raw = readFile(path)
    if (typeof raw !== 'string' || raw.length === 0) continue
    // Every plist states its own Label, so a loaded job's file always contains
    // one of the loaded labels. Skipping the rest keeps an unloaded plist from
    // costing a plutil call, without assuming the file NAME is the label.
    if (!labels.some((label) => raw.includes(label))) continue
    // plutil reads BOTH the xml and the binary plist formats and ships with
    // every macOS, so the job detail never depends on a plist parser here.
    const converted = execSync('plutil', ['-convert', 'json', '-o', '-', path])
    if (converted.code !== 0) continue
    const job = parseLaunchdJobJson(converted.stdout)
    if (!job || !isSafeServiceHandle(job.handle) || !loaded.has(job.handle)) continue
    out.push({ kind: 'launchd', handle: job.handle, file: path, job })
  }
  return out
}

function listLoadedSystemdUnits({ home, listDir, readFile, execSync }) {
  const loaded = parseSystemctlUnitList(
    execSync('systemctl', ['--user', 'list-units', '--type=service', '--all', '--no-legend', '--plain'])
      .stdout,
  )
  if (loaded.size === 0) return []
  const dir = systemdUserDir(home)
  const out = []
  let names = []
  try {
    names = listDir(dir) ?? []
  } catch {
    return out
  }
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith('.service')) continue
    if (!loaded.has(name) || !isSafeServiceHandle(name)) continue
    const path = joinDir(dir, name)
    const raw = readFile(path)
    if (typeof raw !== 'string' || raw.length === 0) continue
    const job = parseSystemdUnitFile(name, raw)
    if (!job) continue
    out.push({ kind: 'systemd', handle: name, file: path, job })
  }
  return out
}

/** Match an already-enumerated job list, so the caller enumerates once. */
function resolveFromJobs({ jobs, stateDir, cwd }) {
  const matches = []
  for (const entry of jobs) {
    const via = matchJobToAgent({ job: entry.job, stateDir, cwd })
    if (!via) continue
    matches.push({ kind: entry.kind, handle: entry.handle, via, file: entry.file })
  }
  return pickSoleMatch(matches)
}

function resolveLaunchd({ home, stateDir, cwd, listDir, readFile, execSync }) {
  const anchors = [stateDir, cwd].filter(Boolean)
  if (anchors.length === 0) return null
  const candidates = candidateFiles({
    dir: launchAgentsDir(home),
    suffix: '.plist',
    anchors,
    listDir,
    readFile,
  })
  if (candidates.length === 0) return null
  const loaded = parseLaunchctlList(execSync('launchctl', ['list']).stdout)
  if (loaded.size === 0) return null
  const matches = []
  for (const candidate of candidates) {
    const converted = execSync('plutil', ['-convert', 'json', '-o', '-', candidate.path])
    if (converted.code !== 0) continue
    const job = parseLaunchdJobJson(converted.stdout)
    if (!job || !isSafeServiceHandle(job.handle) || !loaded.has(job.handle)) continue
    const via = matchJobToAgent({ job, stateDir, cwd })
    if (!via) continue
    matches.push({ kind: 'launchd', handle: job.handle, via, file: candidate.path })
  }
  return pickSoleMatch(matches)
}

function resolveSystemd({ home, stateDir, cwd, listDir, readFile, execSync }) {
  const anchors = [stateDir, cwd].filter(Boolean)
  if (anchors.length === 0) return null
  const candidates = candidateFiles({
    dir: systemdUserDir(home),
    suffix: '.service',
    anchors,
    listDir,
    readFile,
  })
  if (candidates.length === 0) return null
  const loaded = parseSystemctlUnitList(
    execSync('systemctl', ['--user', 'list-units', '--type=service', '--all', '--no-legend', '--plain'])
      .stdout,
  )
  if (loaded.size === 0) return null
  const matches = []
  for (const candidate of candidates) {
    const job = parseSystemdUnitFile(candidate.name, candidate.raw)
    if (!job || !isSafeServiceHandle(job.handle) || !loaded.has(job.handle)) continue
    const via = matchJobToAgent({ job, stateDir, cwd })
    if (!via) continue
    matches.push({ kind: 'systemd', handle: job.handle, via, file: candidate.path })
  }
  return pickSoleMatch(matches)
}

/**
 * The loaded service-manager job that supervises this agent, or null.
 *
 * win32 returns null: this plugin installs no Windows service (bin/bgos-agent
 * has no win32 branch at all), so there is no per-user job namespace to
 * enumerate and nothing a restart could go through. That is a missing
 * capability, not an over-narrow name, and it is deliberately left as a
 * capability gap rather than papered over with a guess.
 *
 * @param {{ platform: string, home: string, assistantId: string | number | null | undefined,
 *   cwd?: string | null,
 *   listDir?: (path: string) => string[],
 *   readFile?: (path: string) => string | null,
 *   execSync?: (file: string, args: string[]) => SyncExecResult,
 *   jobs?: ReturnType<typeof listLoadedJobs> | null }} params
 * @returns {ResolvedService | null}
 */
export function resolveSupervisingService({
  platform,
  home,
  assistantId,
  cwd = null,
  listDir,
  readFile,
  execSync = defaultExecSync,
  jobs = null,
}) {
  if (typeof readFile !== 'function') return null
  if (!Array.isArray(jobs) && typeof listDir !== 'function') return null
  const stateDir = agentStateDirFor(home, assistantId)
  if (!stateDir) return null
  const workdir = usableCwd(cwd, home, validAssistantId(assistantId), readFile)
  try {
    // A caller sweeping many agents enumerates the loaded jobs ONCE and passes
    // them in; a caller asking about a single agent keeps the cheap anchored
    // path, which only inspects job files that mention this agent at all.
    if (Array.isArray(jobs)) {
      if (platform !== 'darwin' && platform !== 'linux') return null
      return resolveFromJobs({ jobs, stateDir, cwd: workdir })
    }
    const probe = { home, stateDir, cwd: workdir, listDir, readFile, execSync }
    if (platform === 'darwin') return resolveLaunchd(probe)
    if (platform === 'linux') return resolveSystemd(probe)
  } catch {
    return null
  }
  return null
}

// -- The published record (daemon writes, watcher re-verifies) ------------------------

/**
 * The record a daemon leaves in its OWN state dir naming the service it
 * resolved for itself, at ~/.bgos-agent/<id>/service.json.
 *
 * Why it exists: only the daemon knows its own working directory
 * (process.cwd()), and the working directory is the anchor that finds a
 * bespoke supervisor. The per-machine watcher, looking at OTHER agents, has a
 * working directory only for agents that hoai launched (launch.json). On the
 * BGOS dev Mac six agents were started by hand, so the watcher could resolve
 * 2 of 8 while the daemons could resolve 8 of 8, and a one-click "update this
 * machine" that restarts a quarter of the fleet is the experience that got
 * this feature called useless in the first place.
 *
 * It carries no token and no secret: an id, a kind, a handle, the working
 * directory it was resolved from, and a timestamp.
 */
export const SERVICE_RECORD_FILE_NAME = 'service.json'
export const SERVICE_RECORD_SCHEMA_VERSION = 1

/**
 * @typedef {{ schemaVersion: number, assistantId: string, kind: 'launchd' | 'systemd',
 *   handle: string, via: ServiceMatchVia, cwd: string, resolvedAt: string | null }} ServiceRecord
 */

/**
 * @param {{ assistantId: string | number, service: ResolvedService, cwd: string, resolvedAt?: string | null }} input
 * @returns {ServiceRecord | null}
 */
export function buildServiceRecord({ assistantId, service, cwd, resolvedAt = null }) {
  const id = validAssistantId(assistantId)
  const dir = String(cwd ?? '').trim()
  if (!id || !service || !dir) return null
  if (service.kind !== 'launchd' && service.kind !== 'systemd') return null
  if (!isSafeServiceHandle(service.handle)) return null
  return {
    schemaVersion: SERVICE_RECORD_SCHEMA_VERSION,
    assistantId: id,
    kind: service.kind,
    handle: service.handle,
    via: service.via,
    cwd: dir,
    resolvedAt: typeof resolvedAt === 'string' && resolvedAt ? resolvedAt : null,
  }
}

/**
 * Parse a record file body. Fail closed: a wrong schema, a non-digits id, an
 * unknown kind, an unsafe handle or a missing cwd all read as no record.
 * @param {string | null | undefined} raw
 * @returns {ServiceRecord | null}
 */
export function parseServiceRecord(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.schemaVersion !== SERVICE_RECORD_SCHEMA_VERSION) return null
  const assistantId = validAssistantId(parsed.assistantId)
  if (!assistantId) return null
  if (parsed.kind !== 'launchd' && parsed.kind !== 'systemd') return null
  if (!isSafeServiceHandle(parsed.handle)) return null
  if (typeof parsed.cwd !== 'string' || parsed.cwd.trim().length === 0) return null
  const via = parsed.via === 'canonical-file' || parsed.via === 'state-dir' || parsed.via === 'working-directory'
    ? parsed.via
    : 'working-directory'
  return {
    schemaVersion: SERVICE_RECORD_SCHEMA_VERSION,
    assistantId,
    kind: parsed.kind,
    handle: parsed.handle,
    via,
    cwd: parsed.cwd.trim(),
    resolvedAt: typeof parsed.resolvedAt === 'string' && parsed.resolvedAt ? parsed.resolvedAt : null,
  }
}

/**
 * Re-verify a published record against the LIVE service manager, and return
 * the authority only when the platform independently agrees.
 *
 * The record is treated as a HINT, never as an authority. All it contributes
 * is the working directory the daemon resolved from; the verdict is then
 * produced by the same `resolveSupervisingService` the daemon used, which
 * re-reads the loaded job list, re-reads the job's own launch recipe, and
 * re-applies the folder-identity veto. On top of that the live result must
 * name the SAME kind and the SAME handle the record claims.
 *
 * So a record that is stale (the job was unloaded, renamed, or repointed) or
 * tampered with (a handle or a cwd belonging to another agent) yields null,
 * which reads as no service authority. It can never cause a restart the live
 * discovery would not have chosen on its own.
 *
 * @param {{ record: ServiceRecord | null, platform: string, home: string,
 *   assistantId: string | number, listDir?: (path: string) => string[],
 *   readFile?: (path: string) => string | null,
 *   execSync?: (file: string, args: string[]) => SyncExecResult,
 *   jobs?: ReturnType<typeof listLoadedJobs> | null }} params
 * @returns {ResolvedService | null}
 */
export function verifyServiceRecord({ record, platform, home, assistantId, listDir, readFile, execSync, jobs = null }) {
  const id = validAssistantId(assistantId)
  if (!record || !id) return null
  // A record filed under another agent is never this agent's authority.
  if (record.assistantId !== id) return null
  const live = resolveSupervisingService({
    platform,
    home,
    assistantId: id,
    cwd: record.cwd,
    listDir,
    readFile,
    execSync,
    jobs,
  })
  if (!live) return null
  if (live.kind !== record.kind || live.handle !== record.handle) return null
  return live
}

// -- The restart command ------------------------------------------------------------

/**
 * The command that restarts a service job THROUGH its supervisor, so the
 * supervisor re-runs the original launch recipe in the original working
 * directory. `delaySeconds` exists for the self-restart case, where the
 * daemon being restarted must first get its own progress report out.
 *
 * Null (never a guess) when the handle is unsafe, the platform has no service
 * manager, or launchd has no uid to address the domain with.
 *
 * @param {{ kind: string, handle: string, uid?: number | null, delaySeconds?: number }} opts
 * @returns {{ file: string, args: string[] } | null}
 */
export function serviceRestartCommandForHandle({ kind, handle, uid = null, delaySeconds = 0 }) {
  const name = String(handle ?? '')
  if (!isSafeServiceHandle(name)) return null
  const delay = Number.isInteger(delaySeconds) && delaySeconds > 0 ? delaySeconds : 0
  if (kind === 'systemd') {
    return delay > 0
      ? {
          file: 'systemd-run',
          args: ['--user', `--on-active=${delay}`, 'systemctl', '--user', 'restart', name],
        }
      : { file: 'systemctl', args: ['--user', 'restart', name] }
  }
  if (kind === 'launchd') {
    if (uid === null || uid === undefined || !Number.isInteger(uid) || uid < 0) return null
    const target = `gui/${uid}/${name}`
    return delay > 0
      ? { file: '/bin/sh', args: ['-c', `sleep ${delay} && launchctl kickstart -k ${target}`] }
      : { file: 'launchctl', args: ['kickstart', '-k', target] }
  }
  return null
}
