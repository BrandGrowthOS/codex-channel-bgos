/**
 * watcher-service: the always-on OS service that keeps the per-machine
 * watcher (bin/hoai-watcher.mjs run) alive across reboots and crashes, plus
 * the watcher's own credentials file.
 *
 * Per platform (design 1.5 / 7.5), mirroring the per-agent service shapes in
 * bin/bgos-agent so an operator sees one familiar pattern:
 *   darwin  ~/Library/LaunchAgents/ai.bgos.watcher.plist, KeepAlive +
 *           RunAtLoad, ProgramArguments [node, <bundle>/bin/hoai-watcher.mjs,
 *           run]; install = launchctl bootout (rc ignored) then bootstrap,
 *           start = kickstart -k
 *   linux   ~/.config/systemd/user/bgos-watcher.service, Restart=always,
 *           RestartSec=5; install = daemon-reload, enable --now, plus a
 *           best-effort loginctl enable-linger so it survives logout
 *   win32   a logon Scheduled Task "HOAI Watcher" running wscript.exe //B
 *           <bundle>\run-hidden.vbs, which starts node hidden (no console);
 *           registered through the Task Scheduler API from a generated
 *           <bundle>\install-task.ps1 (Register-ScheduledTask works
 *           unelevated; schtasks /SC ONLOGON is admin-only), falling back to
 *           the per-user Run key. PATH independent: the absolute node path recorded
 *           at install time is baked into every service file.
 *
 * Scoped to the HOME it was installed from (board row dfafdfb6). Every name the
 * service is known by carries `home-<id>`, the first 8 hex chars of the SHA-256
 * of the normalized HOME (watcherHomeId): "HOAI Watcher home-<id>",
 * ai.bgos.watcher.home-<id>, bgos-watcher-home-<id>, HOAIWatcher-home-<id>. The
 * names used to be fixed per user account, so an install from a scratch HOME (a
 * test rig's daemon, BGOS #2432) or any second install replaced or stopped the
 * owner's real watcher: Register-ScheduledTask -Force, launchctl bootout,
 * systemctl restart. The registration records its HOME (the task description,
 * the launcher's pinned USERPROFILE, the plist and unit HOME), and before acting
 * the runners read that record back through the injected exec (probe): a
 * registration under this HOME's own name that records another HOME is refused,
 * never replaced or removed. A registration under the OLD unscoped name (0.69.x
 * and earlier) is renamed in place when it records this HOME, with no moment
 * without a registration on Windows and Linux and a rollback on macOS (see
 * installWatcherService), and left alone and reported when it records another.
 *
 * Side by side installs (design section 4): HOAI_SERVICE_NAMESPACE, read from
 * the env (validated ^[a-z0-9]{1,16}$, anything else means unset), moves every
 * name the service is known by into the namespace: ai.bgos.watcher.<ns>,
 * bgos-watcher-<ns>, "HOAI Watcher (<ns>)" and the Run key value. launchd
 * labels share ONE gui/<uid> domain and systemd --user units ONE user manager,
 * so before the HOME id a staging install (or the end to end proof of design
 * section 11) under a sandboxed HOME booted out the LIVE watcher with its very
 * first `launchctl bootout` unless it set a namespace; the HOME id now keeps
 * them apart by itself, and the namespace still does. The service env carries
 * the variable, so a reinstall from inside the namespaced watcher stays
 * namespaced. Unset, the namespace adds nothing (test/watcher-service.test.ts).
 * The namespace and the HOME id compose: "HOAI Watcher (<ns>) home-<id>".
 *
 * The spec builder is PURE (exact file contents + argv, table-tested); the
 * runners take an injected exec + fs so install/uninstall are testable with
 * a recording exec. Commands flagged ignoreFailure are best effort (a bootout
 * of a not-loaded label, enable-linger without polkit rights); any other
 * non-zero exit stops the ladder and is reported by name, never thrown.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { posix as posixPath, win32 as win32Path } from 'node:path'

import { joinDir, nodeExec, nodeFs, watcherHome } from './watcher-bundle.mjs'
import { psString, vbsString } from './win32-script-text.mjs'

export const WATCHER_LAUNCHD_LABEL = 'ai.bgos.watcher'
export const WATCHER_SYSTEMD_UNIT = 'bgos-watcher'
export const WATCHER_TASK_NAME = 'HOAI Watcher'
export const WATCHER_HIDDEN_LAUNCHER_FILE = 'run-hidden.vbs'
/** The generated PowerShell task script (install / start / stop / uninstall / status). */
export const WATCHER_TASK_SCRIPT_FILE = 'install-task.ps1'
/** The per-user Run key value of the win32 fallback (Register-ScheduledTask refused). */
export const WATCHER_RUN_VALUE = 'HOAIWatcher'
/** Side by side installs: the env variable that namespaces every service name. */
export const SERVICE_NAMESPACE_ENV = 'HOAI_SERVICE_NAMESPACE'
/** Every name carries `home-<id>`; a namespace never holds a '-', so no scoped name can equal an old one. */
export const HOME_ID_PREFIX = 'home-'
/** The win32 task description; the HOME follows it (read back by recordedHomes). */
export const TASK_DESCRIPTION_PREFIX = 'HOAI per-machine watcher, installed from home='
export const CREDENTIALS_FILE_NAME = 'credentials.json'
export const CREDENTIALS_FILE_MODE = 0o600

/**
 * @typedef {{ file: string, args: string[], ignoreFailure: boolean, retry?: { attempts: number, delayMs: number } }} ServiceCommand
 * @typedef {{
 *   label: string,
 *   runValue?: string,
 *   probeCommand: ServiceCommand,
 *   retire: Record<string, ServiceCommand>,
 *   disableCommands?: ServiceCommand[],
 *   restoreCommands: ServiceCommand[],
 *   files: string[],
 * }} LegacyServiceSpec
 * @typedef {{
 *   kind: 'launchd' | 'systemd' | 'schtasks',
 *   platform: string,
 *   label: string,
 *   runValue?: string,
 *   home: string,
 *   homeId: string,
 *   bundleDir: string,
 *   dirs: string[],
 *   files: Array<{ path: string, content: string, mode: number | null, role: 'service' | 'launcher' | 'script' }>,
 *   probeCommand: ServiceCommand,
 *   registerCommands: ServiceCommand[],
 *   unregisterCommands: ServiceCommand[],
 *   swapCommands?: ServiceCommand[],
 *   renameDropIn?: { path: string, content: string },
 *   installCommands: ServiceCommand[],
 *   startCommands: ServiceCommand[],
 *   stopCommands: ServiceCommand[],
 *   uninstallCommands: ServiceCommand[],
 *   statusCommands: ServiceCommand[],
 *   legacy: LegacyServiceSpec,
 * }} WatcherServiceSpec
 * @typedef {{ label: string, state: 'absent' | 'own' | 'migrated' | 'removed' | 'foreign' | 'unknown', home: string | null }} LegacyOutcome
 */

/** @typedef {{ pairingId: number | string, token: string, backendUrl: string, machineId: string }} WatcherCredentials */

// -- Small helpers ----------------------------------------------------------------

/**
 * The service namespace from the env, or '' when unset. Validated strictly
 * (^[a-z0-9]{1,16}$, no trimming): the value is spliced into a launchd label, a
 * systemd unit name, a task name and a registry value, and an invalid one is
 * treated as UNSET rather than repaired, because a guessed name is how a
 * staging install would end up addressing the live service.
 * @param {Record<string, string | undefined> | undefined} [env]
 * @returns {string}
 */
export function serviceNamespace(env = process.env) {
  const raw = env?.[SERVICE_NAMESPACE_ENV]
  return typeof raw === 'string' && /^[a-z0-9]{1,16}$/.test(raw) ? raw : ''
}

/**
 * A HOME as one string per directory, for hashing and comparing: whitespace
 * trimmed, '.' and '..' and doubled separators resolved, no trailing separator,
 * and on win32 (case-insensitive, either separator) backslashes and lower case.
 * Lexical on purpose: it is pure (the spec builder is), and a symlinked HOME is
 * then another spelling with its own name, which never replaces anything.
 * @param {string} home
 * @param {string} platform
 * @returns {string}
 */
export function canonicalHome(home, platform) {
  const raw = String(home ?? '').trim()
  if (!raw) return ''
  if (platform === 'win32') {
    let path = win32Path.normalize(raw.replace(/\//g, '\\')).replace(/\\+$/, '')
    if (/^[A-Za-z]:$/.test(path)) path += '\\'
    return path.toLowerCase()
  }
  const path = posixPath.normalize(raw)
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * The stable id of the HOME a watcher service was installed from: the first 8
 * hex chars of the SHA-256 of canonicalHome. It is what every service name
 * carries, so two HOMEs on one user account never address the same service.
 * @param {string} home
 * @param {string} platform
 * @returns {string}
 */
export function watcherHomeId(home, platform) {
  return createHash('sha256').update(canonicalHome(home, platform), 'utf8').digest('hex').slice(0, 8)
}

/**
 * Every name the watcher service is known by, for a namespace and a HOME id.
 * Without a HOME id these are the OLD names, exactly as 0.69.x and earlier
 * registered them: what a same-HOME upgrade renames, and what this HOME must
 * otherwise never touch. With one, each name carries `home-<id>`.
 * @param {string} [namespace]
 * @param {string} [homeId]
 * @returns {{ namespace: string, homeId: string, launchdLabel: string, systemdUnit: string, taskName: string, runValue: string }}
 */
export function watcherServiceNames(namespace = '', homeId = '') {
  const ns = serviceNamespace({ [SERVICE_NAMESPACE_ENV]: namespace })
  const id = /^[0-9a-f]{8}$/.test(String(homeId ?? '')) ? String(homeId) : ''
  const base = ns
    ? {
        launchdLabel: `${WATCHER_LAUNCHD_LABEL}.${ns}`,
        systemdUnit: `${WATCHER_SYSTEMD_UNIT}-${ns}`,
        taskName: `${WATCHER_TASK_NAME} (${ns})`,
        runValue: `${WATCHER_RUN_VALUE}-${ns}`,
      }
    : { launchdLabel: WATCHER_LAUNCHD_LABEL, systemdUnit: WATCHER_SYSTEMD_UNIT, taskName: WATCHER_TASK_NAME, runValue: WATCHER_RUN_VALUE }
  if (!id) return { namespace: ns, homeId: '', ...base }
  const scope = `${HOME_ID_PREFIX}${id}`
  return {
    namespace: ns,
    homeId: id,
    launchdLabel: `${base.launchdLabel}.${scope}`,
    systemdUnit: `${base.systemdUnit}-${scope}`,
    taskName: `${base.taskName} ${scope}`,
    runValue: `${base.runValue}-${scope}`,
  }
}

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function command(file, args, ignoreFailure = false, retry = null) {
  return { file, args: [...args], ignoreFailure, ...(retry ? { retry: { ...retry } } : {}) }
}

/**
 * launchctl bootout returns before the old job has unloaded, so a bootstrap right behind it can
 * fail with `Bootstrap failed: 5: Input/output error` while the label is still registered.
 * Measured in the M6 end to end run (2026-10-07): "Set up the watcher" on a computer whose
 * watcher was running failed at the service step, every time. bin/bgos-agent's launchd_reload
 * has retried for exactly this since it was written; this is the same rule for the watcher:
 * up to 6 attempts, 500 ms apart (about the 3 s an unload takes in practice).
 */
export const LAUNCHD_BOOTSTRAP_RETRY = Object.freeze({ attempts: 6, delayMs: 500 })

/**
 * The PATH a headless service needs to find node, bun, hoai and the claude CLI.
 *
 * `found` are the directories where the installing process actually found its tools
 * (toolDirsFromPath). They go FIRST, ahead of the fixed defaults. Measured in the M6 end to
 * end run (2026-10-07): the keep-alive sweep runs `bgos-agent install` under THIS PATH, and with
 * bun outside the fixed list it died with "bun not found", so the agent never got its
 * supervisor. bin/bgos-agent has always baked the dirs of the tools it found into its own
 * service; the watcher's service now does the same. A dir already in the defaults is listed
 * once, in its default place, so a host with nothing off the defaults is byte for byte as before.
 *
 * `platform` ('darwin', 'linux', 'win32') drops what only exists on another OS: Homebrew's
 * /opt/homebrew/bin is left off a Linux unit. Omitted keeps the full list.
 * @param {string} home
 * @param {readonly string[]} [found]
 * @param {string | null} [platform]
 * @returns {string}
 */
export function servicePath(home, found = [], platform = null) {
  // The user's own directories come BEFORE the system ones. ~/.local/bin is where Claude
  // Code's native installer puts `claude` and keeps it updated; a stale /usr/local/bin/claude
  // (2.1.22 on kc-server) used to sit ahead of it, the keep-alive reinstall baked THAT one
  // and five agents crash-looped about 420 times (board row 84296679, 2026-10-12).
  const defaults = [
    joinDir(joinDir(home, '.local'), 'bin'),
    joinDir(joinDir(home, '.bun'), 'bin'),
    '/usr/local/bin',
    // Homebrew's prefix is a macOS directory: on a Linux unit it is noise that
    // names a path that cannot exist (board row 84296679, Nicole, kc-server).
    ...(platform === 'linux' || platform === 'win32' ? [] : ['/opt/homebrew/bin']),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  const extra = []
  for (const dir of Array.isArray(found) ? found : []) {
    const value = String(dir ?? '').trim().replace(/\/+$/, '')
    if (!value || value.includes(':') || defaults.includes(value) || extra.includes(value)) continue
    extra.push(value)
  }
  return [...extra, ...defaults].join(':')
}

/** The tools a supervisor install needs, looked up the way a shell would. */
export const SERVICE_TOOLS = Object.freeze(['bun', 'claude', 'tmux', 'expect', 'git'])

/**
 * The directories (first PATH hit per tool) where the installing process finds the tools a
 * supervisor install needs, the node dir first. Pure apart from the injected exists.
 * @param {{ nodePath?: string, pathVar?: string, exists?: (p: string) => boolean }} input
 * @returns {string[]}
 */
export function toolDirsFromPath({ nodePath = '', pathVar = '', exists = defaultExists } = {}) {
  const dirs = []
  const nodeDir = String(nodePath ?? '').replace(/\/[^/]*$/, '')
  if (nodeDir && nodeDir.startsWith('/')) dirs.push(nodeDir)
  const entries = String(pathVar ?? '').split(':').map((d) => d.trim()).filter((d) => d.startsWith('/'))
  for (const tool of SERVICE_TOOLS) {
    const hit = entries.find((dir) => {
      try {
        return exists(`${dir.replace(/\/+$/, '')}/${tool}`) === true
      } catch {
        return false
      }
    })
    if (hit && !dirs.includes(hit)) dirs.push(hit)
  }
  return dirs
}

function defaultExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

export function watcherScriptPath(bundleDir) {
  return joinDir(joinDir(bundleDir, 'bin'), 'hoai-watcher.mjs')
}

// -- Spec builders --------------------------------------------------------------------

function launchdSpec({ home, nodePath, bundleDir, uid, username, names, legacyNames, toolDirs = [] }) {
  if (uid === null || uid === undefined || !Number.isInteger(uid) || uid < 0) {
    throw new Error('watcherServiceSpec: darwin needs the numeric uid (launchctl gui/<uid> domain)')
  }
  const label = names.launchdLabel
  const agentsDir = joinDir(joinDir(home, 'Library'), 'LaunchAgents')
  const plistPath = joinDir(agentsDir, `${label}.plist`)
  const logsDir = joinDir(bundleDir, 'logs')
  const user = String(username ?? '').trim()
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(nodePath)}</string>`,
    `    <string>${xmlEscape(watcherScriptPath(bundleDir))}</string>`,
    '    <string>run</string>',
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xmlEscape(bundleDir)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key><string>${xmlEscape(joinDir(logsDir, 'service.out.log'))}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(joinDir(logsDir, 'service.err.log'))}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>PATH</key><string>${xmlEscape(servicePath(home, toolDirs, 'darwin'))}</string>`,
    `    <key>HOME</key><string>${xmlEscape(home)}</string>`,
    ...(user ? [`    <key>USER</key><string>${xmlEscape(user)}</string>`, `    <key>LOGNAME</key><string>${xmlEscape(user)}</string>`] : []),
    ...(names.namespace ? [`    <key>${SERVICE_NAMESPACE_ENV}</key><string>${names.namespace}</string>`] : []),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
  const target = `gui/${uid}/${label}`
  const legacyTarget = `gui/${uid}/${legacyNames.launchdLabel}`
  const legacyPlist = joinDir(agentsDir, `${legacyNames.launchdLabel}.plist`)
  return {
    kind: 'launchd',
    label,
    bundleDir,
    dirs: [logsDir],
    files: [{ path: plistPath, content, mode: 0o644, role: 'service' }],
    // `launchctl print` names the plist the job was loaded from, its HOME and its program.
    probeCommand: command('launchctl', ['print', target], true),
    // launchd has no "registered, not started": a bootstrap loads AND (RunAtLoad) starts the job.
    registerCommands: [],
    unregisterCommands: [command('launchctl', ['bootout', target], true)],
    installCommands: [
      command('launchctl', ['bootout', target], true),
      command('launchctl', ['bootstrap', `gui/${uid}`, plistPath], false, LAUNCHD_BOOTSTRAP_RETRY),
    ],
    startCommands: [command('launchctl', ['kickstart', '-k', target])],
    stopCommands: [command('launchctl', ['bootout', target], true)],
    uninstallCommands: [command('launchctl', ['bootout', target], true)],
    statusCommands: [command('launchctl', ['print', target], true)],
    legacy: {
      label: legacyNames.launchdLabel,
      probeCommand: command('launchctl', ['print', legacyTarget], true),
      retire: { job: command('launchctl', ['bootout', legacyTarget]) },
      restoreCommands: [command('launchctl', ['bootstrap', `gui/${uid}`, legacyPlist], false, LAUNCHD_BOOTSTRAP_RETRY)],
      // In ~/Library/LaunchAgents it would load again at the next login, beside the renamed job.
      files: [legacyPlist],
    },
  }
}

/**
 * One `Environment=` line. systemd splits an unquoted assignment at whitespace, so a HOME with a
 * space ("/home/k c") loaded as HOME=/home/k: the whole assignment is quoted when it holds any.
 * Anything else is the line it always was.
 */
function unitEnvironment(key, value) {
  const assignment = `${key}=${value}`
  return /\s/.test(assignment) ? `Environment="${assignment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : `Environment=${assignment}`
}

function systemdSpec({ home, nodePath, bundleDir, username, names, legacyNames, toolDirs = [] }) {
  const unit = names.systemdUnit
  const unitDir = joinDir(joinDir(joinDir(home, '.config'), 'systemd'), 'user')
  const unitPath = joinDir(unitDir, `${unit}.service`)
  const legacyUnit = legacyNames.systemdUnit
  const logsDir = joinDir(bundleDir, 'logs')
  const user = String(username ?? '').trim()
  const content = [
    '[Unit]',
    `Description=HOAI per-machine watcher (${unit})`,
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${bundleDir}`,
    `ExecStart="${nodePath}" "${watcherScriptPath(bundleDir)}" run`,
    'Restart=always',
    'RestartSec=5',
    unitEnvironment('PATH', servicePath(home, toolDirs, 'linux')),
    unitEnvironment('HOME', home),
    ...(user ? [unitEnvironment('USER', user), unitEnvironment('LOGNAME', user)] : []),
    ...(names.namespace ? [unitEnvironment(SERVICE_NAMESPACE_ENV, names.namespace)] : []),
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
  const show = (name) => command('systemctl', ['--user', 'show', '--property=LoadState,ActiveState,FragmentPath,WorkingDirectory,Environment', name], true)
  return {
    kind: 'systemd',
    label: unit,
    bundleDir,
    dirs: [logsDir],
    files: [{ path: unitPath, content, mode: 0o644, role: 'service' }],
    // The LOADED unit's record (FragmentPath, WorkingDirectory, Environment HOME), never the file this install is about to write.
    probeCommand: show(unit),
    // Enabled (starts at the next login) but not started: a rename registers the new unit before the old one goes.
    registerCommands: [command('systemctl', ['--user', 'daemon-reload']), command('systemctl', ['--user', 'enable', unit])],
    unregisterCommands: [command('systemctl', ['--user', 'disable', '--now', unit], true)],
    // The rename's swap is ONE job of the user manager: with renameDropIn in place, starting the new
    // unit stops the old one first (Conflicts= + After=). The manager finishes it even when the
    // caller dies on the way, as one that runs inside the old unit's cgroup does (an agent the
    // watcher started on the recipe tier, lib/watcher-core.mjs cgroupCotenants).
    swapCommands: [command('systemctl', ['--user', 'start', unit])],
    renameDropIn: {
      path: joinDir(joinDir(unitDir, `${unit}.service.d`), 'hoai-rename.conf'),
      content: ['# Written by lib/watcher-service.mjs for the rename from the old unit; removed once it is done.', '[Unit]', `Conflicts=${legacyUnit}.service`, `After=${legacyUnit}.service`, ''].join('\n'),
    },
    installCommands: [
      command('systemctl', ['--user', 'daemon-reload']),
      command('systemctl', ['--user', 'enable', '--now', unit]),
      ...(user ? [command('loginctl', ['enable-linger', user], true)] : []),
    ],
    startCommands: [command('systemctl', ['--user', 'restart', unit])],
    stopCommands: [command('systemctl', ['--user', 'stop', unit], true)],
    uninstallCommands: [
      command('systemctl', ['--user', 'disable', '--now', unit], true),
      command('systemctl', ['--user', 'daemon-reload'], true),
    ],
    statusCommands: [command('systemctl', ['--user', 'is-active', unit], true)],
    legacy: {
      label: legacyUnit,
      probeCommand: show(legacyUnit),
      retire: { unit: command('systemctl', ['--user', 'disable', '--now', legacyUnit]) },
      // The rename only takes the old unit out of the next login; the swap job stops it.
      disableCommands: [command('systemctl', ['--user', 'disable', legacyUnit])],
      restoreCommands: [command('systemctl', ['--user', 'enable', '--now', legacyUnit])],
      files: [joinDir(unitDir, `${legacyUnit}.service`)],
    },
  }
}

function schtasksSpec({ home, nodePath, bundleDir, names, legacyNames }) {
  const taskName = names.taskName
  for (const [name, value] of [['nodePath', nodePath], ['bundleDir', bundleDir]]) {
    if (String(value).includes('"') || String(value).includes("'")) {
      throw new Error(`watcherServiceSpec: ${name} contains a quote, which cannot be embedded in the vbs launcher or the task script`)
    }
  }
  const vbsPath = joinDir(bundleDir, WATCHER_HIDDEN_LAUNCHER_FILE)
  const taskScriptPath = joinDir(bundleDir, WATCHER_TASK_SCRIPT_FILE)
  const logsDir = joinDir(bundleDir, 'logs')
  // VBScript doubles embedded quotes inside a string literal; the whole
  // command line is one string so paths with spaces stay intact. Every path
  // goes through vbsString/psString (lib/win32-script-text.mjs, the agent
  // task's fix): wscript reads this .vbs as ANSI and PowerShell 5.1 the
  // BOM-less .ps1 too, so a non-ASCII profile wrote mojibake and the watcher
  // never started (and with it no agent task was ever installed). Pure ASCII
  // whatever the paths hold; an ASCII path is the literal it always was.
  const content = [
    "' HOAI Watcher: start the per-machine watcher with no console window.",
    `' Generated by lib/watcher-service.mjs; the Scheduled Task '${taskName}' runs this at logon.`,
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbsString(bundleDir)}`,
    // The PROCESS environment of this shell is what the node it runs inherits.
    // node's os.homedir() reads USERPROFILE on Windows: pinned to the HOME this
    // task was installed from, so the watcher runs against that HOME's
    // credentials and agents, never the logon profile's (the plist and the
    // unit set HOME the same way).
    `shell.Environment("Process")("USERPROFILE") = ${vbsString(home)}`,
    ...(names.namespace ? [`shell.Environment("Process")("${SERVICE_NAMESPACE_ENV}") = "${names.namespace}"`] : []),
    `shell.Run ${vbsString(`"${nodePath}" "${watcherScriptPath(bundleDir)}" run`)}, 0, False`,
    '',
  ].join('\r\n')
  // The task is registered through the Task Scheduler API (Register-
  // ScheduledTask), which an unelevated user may do; `schtasks /Create /SC
  // ONLOGON` is admin-only and fails with "Access is denied" (measured
  // 2026-08-25). When even the API refuses, the per-user Run key keeps the
  // watcher starting at logon. Every action is idempotent.
  //
  // probe / probe-legacy print what a registration records, for the runner to
  // decide on (lib, not here, is where ownership is judged): one line for the
  // task, one for the Run key value, every recorded text base64 UTF-8 so a
  // non-ASCII HOME survives the console code page. retire-legacy-* remove the
  // OLD unscoped registration, and only ever run once the probe proved it was
  // installed from this HOME.
  const taskScript = [
    `# ${taskName}: logon task for the per-machine watcher (generated by lib/watcher-service.mjs).`,
    'param([Parameter(Mandatory = $true)][ValidateSet("install", "start", "stop", "uninstall", "status", "probe", "probe-legacy", "retire-legacy-task", "retire-legacy-run")][string]$Action)',
    `$name = '${taskName}'`,
    `$legacyName = '${legacyNames.taskName}'`,
    `$description = ${psString(`${TASK_DESCRIPTION_PREFIX}${home}`)}`,
    `$vbs = ${psString(vbsPath)}`,
    `$watcherScript = ${psString(watcherScriptPath(bundleDir))}`,
    `$runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'`,
    `$runValue = '${names.runValue}'`,
    `$legacyRunValue = '${legacyNames.runValue}'`,
    '$launcher = "wscript.exe //B `"$vbs`""',
    'function Register-Task {',
    '  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$vbs`""',
    '  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)',
    '  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    '  Register-ScheduledTask -TaskName $name -Description $description -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null',
    '}',
    'function Encode-Text([string]$text) {',
    "  if ([string]::IsNullOrEmpty($text)) { return '-' }",
    '  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))',
    '}',
    'function Write-Probe([string]$taskName, [string]$valueName) {',
    "  $task = Get-ScheduledTask -TaskPath '\\' -TaskName $taskName -ErrorAction SilentlyContinue",
    '  if ($task) {',
    '    $actions = ($task.Actions | ForEach-Object { [string]$_.Execute + " " + [string]$_.Arguments }) -join "`n"',
    '    Write-Output ("task present " + [string]$task.State + " " + (Encode-Text ([string]$task.Description)) + " " + (Encode-Text $actions))',
    '  } else { Write-Output "task absent" }',
    '  $run = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).$valueName',
    '  if ($run) { Write-Output ("run present " + (Encode-Text ([string]$run))) } else { Write-Output "run absent" }',
    '}',
    'switch ($Action) {',
    '  "install" {',
    '    try { Register-Task; Write-Output "task registered"; exit 0 }',
    '    catch {',
    '      Write-Output ("task registration refused: " + $_.Exception.Message + "; falling back to the Run key")',
    '      try { New-ItemProperty -Path $runKey -Name $runValue -Value $launcher -PropertyType String -Force -ErrorAction Stop | Out-Null; Write-Output "run key registered"; exit 0 }',
    '      catch { Write-Output ("run key refused: " + $_.Exception.Message); exit 1 }',
    '    }',
    '  }',
    '  "start" {',
    '    try { Start-ScheduledTask -TaskName $name -ErrorAction Stop; Write-Output "task started"; exit 0 }',
    '    catch { Start-Process -FilePath "wscript.exe" -ArgumentList @("//B", "`"$vbs`"") -WindowStyle Hidden; Write-Output "started via wscript"; exit 0 }',
    '  }',
    '  "stop" {',
    '    try { Stop-ScheduledTask -TaskName $name -ErrorAction Stop } catch {}',
    // Only THIS bundle's node process: matching the bare file name killed any
    // process whose command line merely mentioned it (a shell, an editor).
    '    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.ProcessId -ne $PID -and $_.CommandLine -like ("*" + $watcherScript + "*") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '    Write-Output "stopped"; exit 0',
    '  }',
    '  "uninstall" {',
    '    try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch {}',
    '    try { Remove-ItemProperty -Path $runKey -Name $runValue -ErrorAction Stop } catch {}',
    '    Write-Output "unregistered"; exit 0',
    '  }',
    '  "status" {',
    '    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    '    if ($task) { Write-Output ("task " + $task.State); exit 0 }',
    '    $run = (Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue).$runValue',
    '    if ($run) { Write-Output "run key registered"; exit 0 }',
    '    Write-Output "not registered"; exit 1',
    '  }',
    '  "probe" { Write-Probe $name $runValue; exit 0 }',
    '  "probe-legacy" { Write-Probe $legacyName $legacyRunValue; exit 0 }',
    '  "retire-legacy-task" {',
    "    try { Unregister-ScheduledTask -TaskPath '\\' -TaskName $legacyName -Confirm:$false -ErrorAction Stop; Write-Output \"legacy task unregistered\"; exit 0 }",
    '    catch { Write-Output ("legacy task not unregistered: " + $_.Exception.Message); exit 1 }',
    '  }',
    '  "retire-legacy-run" {',
    '    try { Remove-ItemProperty -Path $runKey -Name $legacyRunValue -ErrorAction Stop; Write-Output "legacy run key removed"; exit 0 }',
    '    catch { Write-Output ("legacy run key not removed: " + $_.Exception.Message); exit 1 }',
    '  }',
    '}',
    '',
  ].join('\r\n')
  const ps = (action, ignoreFailure = action !== 'install' && action !== 'start') =>
    command('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', taskScriptPath, '-Action', action], ignoreFailure)
  return {
    kind: 'schtasks',
    label: taskName,
    runValue: names.runValue,
    bundleDir,
    dirs: [logsDir],
    files: [
      { path: vbsPath, content, mode: null, role: 'launcher' },
      { path: taskScriptPath, content: taskScript, mode: null, role: 'script' },
    ],
    probeCommand: ps('probe'),
    // Register-ScheduledTask only registers (a logon trigger): the install action IS the registration.
    registerCommands: [],
    unregisterCommands: [ps('uninstall')],
    installCommands: [ps('install')],
    // A re-install runs Register-ScheduledTask -Force, which does not stop a
    // watcher already running under the old token; Start alone would add a
    // second one. Stop first (allowed to fail: nothing may be running).
    startCommands: [ps('stop'), ps('start')],
    stopCommands: [ps('stop')],
    uninstallCommands: [ps('uninstall')],
    statusCommands: [ps('status')],
    legacy: {
      label: legacyNames.taskName,
      runValue: legacyNames.runValue,
      probeCommand: ps('probe-legacy'),
      retire: { task: ps('retire-legacy-task', false), run: ps('retire-legacy-run', false) },
      restoreCommands: [],
      files: [],
    },
  }
}

/**
 * The pure service spec for a platform. `home` names the service (its
 * watcherHomeId) and is recorded in it; `legacy` is the same service under the
 * OLD unscoped name, which the runners rename in place when it records this
 * HOME and otherwise never touch. `env` is read for the service
 * namespace (HOAI_SERVICE_NAMESPACE) and for its PATH (the dirs where this
 * install finds bun, claude, tmux, expect and git go on the service PATH,
 * servicePath); it defaults to process.env so the call sites
 * (bin/hoai-watcher.mjs, server.ts) need no change to honour it. `exists` is
 * injected for the PATH lookup only.
 * @param {{ platform: string, home: string, nodePath: string, bundleDir?: string,
 *   uid?: number | null, localAppData?: string, username?: string,
 *   env?: Record<string, string | undefined>, exists?: (path: string) => boolean }} params
 * @returns {WatcherServiceSpec}
 */
export function watcherServiceSpec({ platform, home, nodePath, bundleDir, uid = null, localAppData, username = '', env = process.env, exists = defaultExists }) {
  void localAppData // reserved (the win32 layout keeps everything under the bundle dir today)
  const node = String(nodePath ?? '').trim()
  if (!node) throw new Error('watcherServiceSpec: nodePath is required (the absolute node binary recorded at install)')
  if (!String(home ?? '').trim()) throw new Error('watcherServiceSpec: home is required (the service is named after the HOME it is installed from)')
  const dir = String(bundleDir ?? '').trim() || watcherHome(home)
  const namespace = serviceNamespace(env)
  const homeId = watcherHomeId(home, platform)
  const names = watcherServiceNames(namespace, homeId)
  const legacyNames = watcherServiceNames(namespace, '')
  const toolDirs = platform === 'win32' ? [] : toolDirsFromPath({ nodePath: node, pathVar: env?.PATH ?? '', exists })
  const scoped = (spec) => ({ ...spec, platform, home, homeId })
  if (platform === 'darwin') return scoped(launchdSpec({ home, nodePath: node, bundleDir: dir, uid, username, names, legacyNames, toolDirs }))
  if (platform === 'linux') return scoped(systemdSpec({ home, nodePath: node, bundleDir: dir, username, names, legacyNames, toolDirs }))
  if (platform === 'win32') return scoped(schtasksSpec({ home, nodePath: node, bundleDir: dir, names, legacyNames }))
  throw new Error(`watcherServiceSpec: unsupported platform ${platform}`)
}

// -- Runners --------------------------------------------------------------------------

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? ''
}

function describeFailure(cmd, result) {
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? '') || 'no output'
  return `${cmd.file} ${cmd.args.join(' ')} failed (rc ${result.code}${result.timedOut ? ', timed out' : ''}): ${detail}`
}

async function runLadder(commands, exec, ran, sleep = defaultSleep) {
  for (const cmd of commands) {
    // A command with a retry (the launchd bootstrap, see LAUNCHD_BOOTSTRAP_RETRY) is attempted
    // again after its delay while it fails; every attempt is recorded, and only the last
    // failure stops the ladder.
    const attempts = Math.max(1, Number(cmd.retry?.attempts) || 1)
    let result = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(Number(cmd.retry?.delayMs) || 0)
      result = await exec(cmd.file, cmd.args)
      ran.push({ file: cmd.file, args: [...cmd.args], code: result.code, ignored: Boolean(cmd.ignoreFailure) })
      if (result.code === 0) break
    }
    if (result.code !== 0 && !cmd.ignoreFailure) return describeFailure(cmd, result)
  }
  return null
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const lenient = (cmds) => cmds.map((c) => ({ ...c, ignoreFailure: true }))

// -- Which HOME a registration records ----------------------------------------------------

/** What a probe artifact is called in a message. */
const ARTIFACT_NOUN = Object.freeze({ task: 'Scheduled Task', run: 'Run key value', job: 'launchd job', unit: 'systemd unit' })
const KIND_ARTIFACT = Object.freeze({ schtasks: 'task', launchd: 'job', systemd: 'unit' })

function decodeField(value) {
  if (!value || value === '-') return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function xmlUnescape(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The launcher a command line (`wscript.exe //B "<home>\.bgos-agent\watcher\run-hidden.vbs"`) runs, and the HOME it sits in. */
function launcherOf(text) {
  const m = /([^"]*?)[\\/]\.bgos-agent[\\/]watcher[\\/]run-hidden\.vbs/i.exec(String(text ?? ''))
  const home = m ? m[1].trim() : ''
  return home ? { home, path: m[0].trim() } : null
}

/** The HOME= a systemd unit file sets (`Environment=HOME=...` or the quoted `Environment="HOME=..."`). */
export function unitFileHome(content) {
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const quoted = /^Environment="HOME=((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    if (quoted) return quoted[1].replace(/\\(.)/g, '$1')
    const plain = /^Environment=HOME=(.*)$/.exec(line)
    if (plain) return plain[1]
  }
  return null
}

/** Does a Windows launcher pin the HOME it was installed from (USERPROFILE, set before node starts)? */
export function launcherPinsHome(content) {
  return /^shell\.Environment\("Process"\)\("USERPROFILE"\) = /m.test(String(content ?? ''))
}

/**
 * @typedef {{
 *   noun: string,
 *   requireRun: boolean,
 *   taskHomes: (description: string, actions: string, taskState: string) => { homes: string[], path: string | null },
 *   runHomes: (value: string) => { homes: string[], path: string | null },
 *   launchdHomes: (printText: string) => string[],
 *   systemdHomes: (props: Record<string, string>, file: string | null) => string[],
 *   pinsHome: (launcherContent: string) => boolean,
 *   caveat?: boolean,
 * }} RegistrationRecord
 * What a registration of one service records beyond what every one does (a plist's path and its
 * HOME, a unit's fragment path and its HOME): readProbe asks it for the service's own records, so
 * the per-agent services (lib/agent-service.mjs) are read back with this same reader and judged by
 * the same classifyRegistration.
 */

/** The watcher's records: its task description and launcher, its program and working directory. */
export const WATCHER_RECORD = Object.freeze({
  noun: 'watcher',
  requireRun: true,
  taskHomes(description, actions) {
    const homes = []
    if (description.startsWith(TASK_DESCRIPTION_PREFIX)) homes.push(description.slice(TASK_DESCRIPTION_PREFIX.length).trim())
    const launcher = launcherOf(actions)
    if (launcher) homes.push(launcher.home)
    return { homes, path: launcher?.path ?? null }
  },
  runHomes(value) {
    const launcher = launcherOf(value)
    return { homes: launcher ? [launcher.home] : [], path: launcher?.path ?? null }
  },
  launchdHomes(text) {
    const homes = []
    const fromArgs = /^\s*(.+?)\/\.bgos-agent\/watcher\/bin\/hoai-watcher\.mjs\s*$/m.exec(text)?.[1]
    if (fromArgs) homes.push(fromArgs)
    const fromCwd = /^\s*working directory = (.+?)\/\.bgos-agent\/watcher\/?\s*$/m.exec(text)?.[1]
    if (fromCwd) homes.push(fromCwd)
    return homes
  },
  systemdHomes(props) {
    const fromCwd = /^(.+)\/\.bgos-agent\/watcher\/?$/.exec(props.WorkingDirectory ?? '')?.[1]
    return fromCwd ? [fromCwd] : []
  },
  pinsHome: launcherPinsHome,
})

/**
 * Read a probe's output: the artifacts it found, each with EVERY HOME it
 * records (a name, a description, a path, an environment), or null when the
 * output cannot be read. launchd: `launchctl print`, whose 113 ("Could not
 * find service") means the label is not loaded; any other failure is
 * unreadable. systemd: `systemctl --user show`, LoadState not-found means
 * absent; the HOME is read from the unit FILE the manager loaded (`readFile`,
 * injected) when it can be, since the manager splits an unquoted
 * `Environment=HOME=/home/k c` at the space. win32: the task script's probe
 * lines; `path` is the launcher the task or Run value starts. `record` says
 * what this service records beyond that (default: the watcher's own).
 * @param {string} kind
 * @param {{ code: number | null, stdout?: string, stderr?: string }} result
 * @param {((path: string) => string | null) | null} [readFile]
 * @param {RegistrationRecord} [record]
 * @returns {Array<{ what: string, homes: string[], active: boolean, path: string | null }> | null}
 */
export function readProbe(kind, result, readFile = null, record = WATCHER_RECORD) {
  const code = result?.code
  const text = String(result?.stdout ?? '')
  if (kind === 'launchd') {
    if (code === 113 || (code !== 0 && /could not find service/i.test(`${text}\n${result?.stderr ?? ''}`))) return []
    if (code !== 0) return null
    const homes = []
    const path = /^\s*path = (.+?)\s*$/m.exec(text)?.[1] ?? null
    const fromPlist = path ? /^(.+)\/Library\/LaunchAgents\/[^/]+\.plist$/.exec(path)?.[1] : null
    if (fromPlist) homes.push(fromPlist)
    // Only the job's own `environment` block (not `inherited` or `default environment`).
    const env = /^\s*environment = \{[ \t]*$([\s\S]*?)^\s*\}/m.exec(text)?.[1]
    const fromEnv = env ? /^\s*HOME => (.+?)\s*$/m.exec(env)?.[1] : null
    if (fromEnv) homes.push(fromEnv)
    homes.push(...record.launchdHomes(text))
    return [{ what: 'job', homes, active: true, path }]
  }
  if (kind === 'systemd') {
    if (code !== 0) return null
    /** @type {Record<string, string>} */
    const props = {}
    for (const line of text.split(/\r?\n/)) {
      const at = line.indexOf('=')
      if (at > 0) props[line.slice(0, at)] = line.slice(at + 1)
    }
    if (!props.LoadState) return null
    if (props.LoadState === 'not-found') return []
    const homes = []
    const fromFragment = /^(.+)\/\.config\/systemd\/user\/[^/]+\.service$/.exec(props.FragmentPath ?? '')?.[1]
    if (fromFragment) homes.push(fromFragment)
    let file = null
    try {
      file = props.FragmentPath && readFile ? readFile(props.FragmentPath) : null
    } catch {
      file = null
    }
    const env = /(?:^|\s)"HOME=([^"]*)"|(?:^|\s)HOME=(\S*)/.exec(props.Environment ?? '')
    const fromEnv = file != null ? unitFileHome(file) : env ? env[1] ?? env[2] : null
    if (fromEnv) homes.push(fromEnv)
    homes.push(...record.systemdHomes(props, file))
    return [{ what: 'unit', homes, active: props.ActiveState === 'active', path: props.FragmentPath || null }]
  }
  if (code !== 0) return null
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const task = lines.find((l) => /^task (present|absent)(\s|$)/.test(l))
  const run = lines.find((l) => /^run (present|absent)(\s|$)/.test(l))
  if (!task || (record.requireRun && !run)) return null
  const found = []
  if (task.startsWith('task present')) {
    const [, , taskState = '', description = '', actions = ''] = task.split(/\s+/)
    // The record may add facts of its own (an agent task's Ready / Running / Disabled state).
    found.push({ what: 'task', active: true, ...record.taskHomes(decodeField(description), decodeField(actions), taskState) })
  }
  if (run?.startsWith('run present')) {
    const { homes, path } = record.runHomes(decodeField(run.split(/\s+/)[2] ?? ''))
    found.push({ what: 'run', homes, active: true, path })
  }
  return found
}

/**
 * Judge a probe against this spec's HOME: 'own' only when every artifact
 * records a HOME and every HOME it records is this one; 'foreign' when one
 * records another; 'unknown' when one records none or the probe could not be
 * read (never acted on, like foreign); 'absent' when nothing is registered.
 * @param {{ home: string, platform: string, homeKey?: (home: string) => string }} spec
 * @param {ReturnType<typeof readProbe>} artifacts
 */
export function classifyRegistration(spec, artifacts) {
  if (artifacts === null) return { state: 'unknown', home: null, artifacts: [] }
  if (!artifacts.length) return { state: 'absent', home: null, artifacts: [] }
  // A spec may say how two spellings of a HOME compare (an agent's, by real path); the watcher's: lexically.
  const key = typeof spec.homeKey === 'function' ? spec.homeKey : (h) => canonicalHome(h, spec.platform)
  const mine = key(spec.home)
  const judged = artifacts.map((a) => {
    const homes = a.homes.filter(Boolean)
    const other = homes.find((h) => key(h) !== mine)
    const state = !homes.length ? 'unknown' : other === undefined ? 'own' : 'foreign'
    return { ...a, state, home: other ?? homes[0] ?? null }
  })
  const state = judged.every((a) => a.state === 'own') ? 'own' : judged.some((a) => a.state === 'foreign') ? 'foreign' : 'unknown'
  return { state, home: judged.find((a) => a.state !== 'own')?.home ?? judged[0].home, artifacts: judged }
}

/**
 * Run one probe command and judge what it read against the spec's HOME (the
 * spec's `record` says what its registration records; the watcher's by
 * default). Shared with the per-agent services (lib/agent-task-win32.mjs,
 * lib/agent-service.mjs).
 */
export async function probeRegistration(spec, cmd, exec, ran, fs = null) {
  const result = await exec(cmd.file, cmd.args)
  ran.push({ file: cmd.file, args: [...cmd.args], code: result.code, ignored: true })
  const artifacts = readProbe(spec.kind, result, fs ? (path) => fs.readFile(path) : null, spec.record ?? WATCHER_RECORD)
  const judged = classifyRegistration(spec, artifacts)
  // An unreadable probe says why (a spawn failure, a user manager that does not answer).
  return artifacts === null ? { ...judged, detail: result.code === 0 ? 'unreadable output' : describeFailure(cmd, result) } : judged
}

/** `Scheduled Task "HOAI Watcher home-<id>"`: an artifact of this spec's own name (slot 'own') or its old one ('legacy'). */
export function artifactName(spec, slot, what) {
  const side = slot === 'legacy' ? spec.legacy : spec
  const name = what === 'run' ? side.runValue : side.label
  return `${ARTIFACT_NOUN[what] ?? 'service'} "${name}"`
}

/** The kind of artifact a spec's own registration is ('task', 'job', 'unit'). */
export function kindArtifact(kind) {
  return KIND_ARTIFACT[kind]
}

/** Why a registration under this HOME's own name is not acted on (it records another HOME, or none readable). */
export function refusal(spec, own) {
  const artifact = own.artifacts.find((a) => a.state !== 'own')
  const name = artifactName(spec, 'own', artifact?.what ?? KIND_ARTIFACT[spec.kind])
  if (own.state === 'foreign') return `refused: the ${name} records another HOME (${own.home}), not this one (${spec.home}); it is left as it is`
  if (own.detail) return `refused: which HOME the ${name} belongs to could not be read (${own.detail}); nothing was changed`
  return `refused: the ${name} exists but which HOME installed it could not be read; it is left as it is`
}

/**
 * What a Windows launcher another HOME installed really runs against. A launcher 0.69.x and earlier
 * wrote pins no HOME, so its watcher's os.homedir() is the logon profile, whichever HOME the
 * launcher sits in: a task an older install from another HOME re-pointed there still serves the
 * logon user's credentials and agents, beside this watcher. Said plainly, never acted on.
 */
function launcherCaveat(spec, artifact, fs) {
  if (spec.kind !== 'schtasks' || !artifact.path || !fs) return ''
  let content = null
  try {
    content = fs.readFile(artifact.path)
  } catch {
    content = null
  }
  const remove =
    artifact.what === 'run'
      ? `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${spec.legacy.runValue}'`
      : `Unregister-ScheduledTask -TaskName '${spec.legacy.label}' -Confirm:$false`
  const record = spec.record ?? WATCHER_RECORD
  if (record.caveat === false) return ''
  if (content == null) return `; its launcher ${artifact.path} could not be read`
  if (record.pinsHome(content)) return ''
  return `; its launcher pins no HOME, so at logon it serves the logon user's profile (perhaps the one this ${record.noun} serves), not necessarily ${artifact.home}; if it is not wanted: ${remove}`
}

/** One line per OLD artifact this HOME does not own: it is left alone, and said so. */
export function leftAlone(spec, old, fs = null) {
  if (old.state === 'unknown' && !old.artifacts.length) {
    return [`left the ${artifactName(spec, 'legacy', KIND_ARTIFACT[spec.kind])} alone: its record could not be read (${old.detail ?? 'unreadable'})`]
  }
  return old.artifacts
    .filter((a) => a.state !== 'own')
    .map((a) =>
      a.state === 'foreign'
        ? `left the ${artifactName(spec, 'legacy', a.what)} alone: it was installed from another HOME (${a.home})${launcherCaveat(spec, a, fs)}`
        : `left the ${artifactName(spec, 'legacy', a.what)} alone: which HOME installed it could not be read`,
    )
}

/** Does a service file's content (plist or unit) record this spec's HOME? */
function fileRecordsHome(spec, content) {
  if (content == null) return false
  const recorded =
    spec.kind === 'launchd'
      ? xmlUnescape(/<key>HOME<\/key><string>([^<]*)<\/string>/.exec(content)?.[1] ?? '')
      : spec.kind === 'systemd'
        ? unitFileHome(content) ?? ''
        : ''
  return recorded !== '' && canonicalHome(recorded, spec.platform) === canonicalHome(spec.home, spec.platform)
}

/** Remove the OLD service files in this HOME that record this HOME (a plist would load again at the next login). */
function removeLegacyFiles(spec, fs) {
  const removed = []
  for (const path of spec.legacy?.files ?? []) {
    try {
      if (fs.exists(path) && fileRecordsHome(spec, fs.readFile(path))) {
        fs.rm(path)
        removed.push(path)
      }
    } catch {
      // Left for the operator; nothing loads it until the next login.
    }
  }
  return removed
}

function writeFiles(spec, fs, roles) {
  for (const file of spec.files) {
    if (!roles.includes(file.role ?? 'service')) continue
    try {
      fs.writeFile(file.path, file.content, file.mode != null ? { mode: file.mode } : undefined)
    } catch (err) {
      return `write ${file.path} failed: ${String(err?.message ?? err)}`
    }
  }
  return null
}

function removeFiles(spec, fs, roles) {
  const removed = []
  for (const file of spec.files) {
    if (!roles.includes(file.role ?? 'service')) continue
    try {
      if (fs.exists(file.path)) {
        fs.rm(file.path)
        removed.push(file.path)
      }
    } catch {
      // A file we cannot remove is left for the operator; the ran list shows the unload happened.
    }
  }
  return removed
}

/** How long a rename waits for the old launchd job to be gone (bootout returns before it has unloaded). */
export const LAUNCHD_UNLOAD_WAIT = Object.freeze({ attempts: 10, delayMs: 500 })

/**
 * macOS rollback: the OLD job is loaded again, and only once it is listed is
 * the new plist removed, so the next login loads exactly one of them. A
 * bootout that succeeded may still be unloading, so the restore bootstrap
 * retries (LAUNCHD_BOOTSTRAP_RETRY) instead of trusting a listing. When the
 * old job cannot be loaded again, its plist goes and the new one stays: the
 * next login starts the watcher from it, once.
 */
async function restoreLegacyJob(spec, { exec, fs, sleep, ran }, retired) {
  let old = await probeRegistration(spec, spec.legacy.probeCommand, exec, ran, fs)
  if (retired || old.state === 'absent') {
    await runLadder(lenient(spec.legacy.restoreCommands), exec, ran, sleep)
    old = await probeRegistration(spec, spec.legacy.probeCommand, exec, ran, fs)
  }
  if (old.state === 'absent') {
    removeLegacyFiles(spec, fs)
    return false
  }
  removeFiles(spec, fs, ['service'])
  return true
}

/** macOS: poll until the old job is no longer listed; true once it is gone. */
async function waitUntilUnloaded(spec, { exec, fs, sleep, ran }) {
  for (let attempt = 1; attempt <= LAUNCHD_UNLOAD_WAIT.attempts; attempt++) {
    const old = await probeRegistration(spec, spec.legacy.probeCommand, exec, ran, fs)
    if (old.state === 'absent') return true
    if (attempt < LAUNCHD_UNLOAD_WAIT.attempts) await sleep(LAUNCHD_UNLOAD_WAIT.delayMs)
  }
  return false
}

/**
 * Rename this HOME's OLD registration (`retire`: its artifacts the probe proved
 * this HOME's) to the scoped one. Returns null, or the failure. Never two
 * watchers of this HOME at once, and the old registration goes only once the
 * new one is in place (or, on macOS, is put back when the new one does not
 * come up).
 *
 * win32: register the new task (a logon trigger, it starts nothing), retire the
 * old Run value then the old task, then stop this bundle's watcher and start
 * it under the new name. A failed retire unregisters the new task again.
 *
 * linux: the new unit is enabled (not started) with a drop-in that makes it
 * conflict with the old one, the old one is disabled (not stopped), then ONE
 * `start` of the new unit: the user manager stops the old unit and starts the
 * new one as one job. An installer running inside the old unit's cgroup (the
 * daemon of an agent the watcher started on the recipe tier) dies when the old
 * unit stops; the manager still finishes the job, so the watcher comes back
 * under the new name, as it always came back from a `restart`.
 *
 * macOS cannot register without starting (bootstrap + RunAtLoad): the old job
 * is booted out, the rename waits until it is no longer listed (bootout returns
 * before it has unloaded), then the new job is bootstrapped; when it does not
 * come up the old one is bootstrapped again.
 */
async function migrate(spec, retire, ctx) {
  const { exec, fs, sleep, ran } = ctx
  const ladder = (cmds) => runLadder(cmds, exec, ran, sleep)
  if (spec.kind === 'launchd') {
    await ladder(lenient(spec.unregisterCommands))
    const bootout = await ladder([spec.legacy.retire.job])
    const gone = bootout ? false : await waitUntilUnloaded(spec, ctx)
    const failure = bootout ?? (gone ? await ladder(spec.installCommands) : `the old job "${spec.legacy.label}" was still loaded after ${LAUNCHD_UNLOAD_WAIT.attempts} checks`)
    if (failure) {
      const back = await restoreLegacyJob(spec, ctx, !bootout)
      return back
        ? `migration rolled back (the old job "${spec.legacy.label}" is loaded again): ${failure}`
        : `migration failed and the old job "${spec.legacy.label}" could not be loaded again; its plist is removed and the new one stays, so the next login starts the watcher once: ${failure}`
    }
    removeLegacyFiles(spec, fs)
    return ladder(spec.startCommands)
  }
  if (spec.kind === 'systemd') {
    const dropIn = spec.renameDropIn
    try {
      fs.writeFile(dropIn.path, dropIn.content)
    } catch (err) {
      return `write ${dropIn.path} failed: ${String(err?.message ?? err)}`
    }
    const removeDropIn = () => {
      try {
        if (fs.exists(dropIn.path)) fs.rm(dropIn.path)
      } catch {
        // A drop-in left behind only orders the new unit after the old one; harmless.
      }
    }
    const registered = await ladder(spec.registerCommands)
    if (registered) {
      removeDropIn()
      return registered
    }
    const disabled = await ladder(spec.legacy.disableCommands)
    if (disabled) {
      await ladder(lenient(spec.unregisterCommands))
      removeDropIn()
      await ladder(lenient(spec.registerCommands.slice(0, 1)))
      return `migration rolled back (the new unit was disabled again, the old "${spec.legacy.label}" stays): ${disabled}`
    }
    const swapped = await ladder(spec.swapCommands)
    if (swapped) {
      await ladder(lenient([...spec.unregisterCommands, ...spec.legacy.restoreCommands]))
      removeDropIn()
      await ladder(lenient(spec.registerCommands.slice(0, 1)))
      return `migration rolled back (the old unit "${spec.legacy.label}" is enabled and started again): ${swapped}`
    }
    removeDropIn()
    removeLegacyFiles(spec, fs)
    return ladder(spec.installCommands)
  }
  const registered = await ladder(spec.installCommands)
  if (registered) return registered
  // A Run key value before the task: whichever fails, an old registration is still there for the rollback.
  for (const artifact of [...retire].sort((a, b) => (a.what === 'run' ? -1 : b.what === 'run' ? 1 : 0))) {
    const failure = await ladder([spec.legacy.retire[artifact.what]])
    if (failure) {
      await ladder(lenient(spec.unregisterCommands))
      return `migration rolled back (the new task was unregistered again, the old "${spec.legacy.label}" stays): ${failure}`
    }
  }
  return ladder(spec.startCommands)
}

/**
 * Install this HOME's watcher service. In order: the task script (win32 probes
 * through it); the probe of this HOME's own name, refused when it records
 * another HOME or cannot be read; the probe of the OLD unscoped name; the
 * service files; then either the rename of a same-HOME old registration
 * (migrate) or the install and start ladders. An old registration from another
 * HOME is left alone and named in `notes`. Never throws.
 * @param {WatcherServiceSpec} spec
 * @param {{ exec?: import('./watcher-bundle.mjs').Exec, fs?: import('./watcher-bundle.mjs').WatcherFs, sleep?: (ms: number) => Promise<unknown> }} deps
 * @returns {Promise<{ ok: boolean, message: string, ran: Array<{ file: string, args: string[], code: number | null, ignored: boolean }>, legacy: LegacyOutcome | null, notes: string[] }>}
 */
export async function installWatcherService(spec, { exec = nodeExec(), fs = nodeFs(), sleep = defaultSleep } = {}) {
  const ran = []
  /** @type {string[]} */
  const notes = []
  /** @type {LegacyOutcome | null} */
  let legacy = null
  const done = (ok, message) => ({ ok, message, ran, legacy, notes })
  for (const dir of spec.dirs ?? []) {
    try {
      fs.mkdir(dir)
    } catch (err) {
      return done(false, `mkdir ${dir} failed: ${String(err?.message ?? err)}`)
    }
  }
  const scriptFailure = writeFiles(spec, fs, ['script'])
  if (scriptFailure) return done(false, scriptFailure)
  const own = await probeRegistration(spec, spec.probeCommand, exec, ran, fs)
  if (own.state === 'foreign' || own.state === 'unknown') return done(false, refusal(spec, own))
  const old = await probeRegistration(spec, spec.legacy.probeCommand, exec, ran, fs)
  legacy = { label: spec.legacy.label, state: old.state, home: old.home }
  notes.push(...leftAlone(spec, old, fs))
  const fileFailure = writeFiles(spec, fs, ['service', 'launcher'])
  if (fileFailure) return done(false, fileFailure)
  const retire = old.artifacts.filter((a) => a.state === 'own')
  if (retire.length) {
    const failure = await migrate(spec, retire, { exec, fs, sleep, ran })
    if (failure) return done(false, failure)
    // Renamed; an old artifact another HOME owns (a mixed win32 record) keeps the state it was judged.
    if (old.state === 'own') legacy = { ...legacy, state: 'migrated' }
    for (const artifact of retire) {
      notes.push(`renamed the ${artifactName(spec, 'legacy', artifact.what)} (installed from this HOME by an older version) to ${artifactName(spec, 'own', artifact.what)}`)
    }
    return done(true, 'installed')
  }
  const installFailure = await runLadder(spec.installCommands, exec, ran, sleep)
  if (installFailure) return done(false, installFailure)
  const startFailure = await runLadder(spec.startCommands, exec, ran, sleep)
  if (startFailure) return done(false, startFailure)
  for (const path of removeLegacyFiles(spec, fs)) notes.push(`removed ${path}, an old service file of this HOME that would start a second watcher at the next login`)
  return done(true, 'installed')
}

/**
 * Stop + unregister this HOME's service (every command best effort, all
 * recorded), and this HOME's OLD unscoped registration when the probe proves it
 * is this HOME's; then remove the service files. A registration under this
 * HOME's own name that records ANOTHER HOME is refused (ok false) and nothing
 * of it, files included, is touched. One whose record cannot be read is not
 * unregistered by name (that is not proof it is this HOME's), but this HOME's
 * own files still go and the uninstall goes on (ok true, said in `notes`). An
 * old registration from another HOME is left alone and named in `notes`. The
 * task script is rewritten first, so a stale one an older version left (with
 * the old name in it) never runs. Never throws.
 * @param {WatcherServiceSpec} spec
 * @param {{ exec?: import('./watcher-bundle.mjs').Exec, fs?: import('./watcher-bundle.mjs').WatcherFs }} deps
 */
export async function uninstallWatcherService(spec, { exec = nodeExec(), fs = nodeFs() } = {}) {
  const ran = []
  /** @type {string[]} */
  const notes = []
  const scriptFailure = writeFiles(spec, fs, ['script'])
  if (scriptFailure) {
    return { ok: false, message: `${scriptFailure}; nothing was stopped or unregistered`, ran, removed: [], legacy: null, notes }
  }
  const own = await probeRegistration(spec, spec.probeCommand, exec, ran, fs)
  const refused = own.state === 'foreign'
  if (own.state === 'unknown') {
    notes.push(`did not unregister the ${artifactName(spec, 'own', KIND_ARTIFACT[spec.kind])} by name: ${refusal(spec, own).replace(/^refused: /, '')}; this HOME's own files are removed`)
  } else if (!refused) {
    await runLadder(lenient(spec.stopCommands), exec, ran)
    await runLadder(lenient(spec.uninstallCommands), exec, ran)
  }
  const old = await probeRegistration(spec, spec.legacy.probeCommand, exec, ran, fs)
  notes.push(...leftAlone(spec, old, fs))
  let retired = 0
  const retire = old.artifacts.filter((a) => a.state === 'own')
  for (const artifact of retire) {
    const failure = await runLadder([spec.legacy.retire[artifact.what]], exec, ran)
    if (failure) {
      notes.push(`could not remove the ${artifactName(spec, 'legacy', artifact.what)} (installed from this HOME by an older version): ${failure}`)
    } else {
      retired += 1
      notes.push(`removed the ${artifactName(spec, 'legacy', artifact.what)} (installed from this HOME by an older version)`)
    }
  }
  /** @type {LegacyOutcome} */
  const legacy = { label: spec.legacy.label, state: old.state === 'own' && retired === retire.length ? 'removed' : old.state, home: old.home }
  const removed = refused ? [] : removeFiles(spec, fs, ['service', 'launcher', 'script'])
  removed.push(...removeLegacyFiles(spec, fs))
  if (refused) return { ok: false, message: refusal(spec, own), ran, removed, legacy, notes }
  return { ok: true, message: 'uninstalled', ran, removed, legacy, notes }
}

/**
 * This HOME's service state (best effort): its own registration's status
 * commands, or, while a same-HOME OLD registration is not renamed yet, that
 * one's. Another HOME's registration is never reported as this HOME's. On
 * win32 the task script is refreshed first when it differs (a stale one has no
 * probe), and only into a bundle folder that exists: status never creates one.
 * @param {WatcherServiceSpec} spec
 * @param {{ exec?: import('./watcher-bundle.mjs').Exec, fs?: import('./watcher-bundle.mjs').WatcherFs }} [deps]
 */
export async function watcherServiceStatus(spec, { exec = nodeExec(), fs = nodeFs() } = {}) {
  const ran = []
  const lines = []
  const stale = fs.exists(spec.bundleDir) ? spec.files.filter((f) => f.role === 'script' && fs.readFile(f.path) !== f.content) : []
  const scriptFailure = stale.length ? writeFiles({ ...spec, files: stale }, fs, ['script']) : null
  if (scriptFailure) lines.push(scriptFailure)
  const own = await probeRegistration(spec, spec.probeCommand, exec, ran, fs)
  const old = await probeRegistration(spec, spec.legacy.probeCommand, exec, ran, fs)
  let active = false
  let label = spec.label
  if (own.state === 'own') {
    const statusRan = []
    for (const cmd of spec.statusCommands) {
      const result = await exec(cmd.file, cmd.args)
      statusRan.push({ file: cmd.file, args: [...cmd.args], code: result.code, ignored: true })
      lines.push(String(result.stdout ?? '').trim() || String(result.stderr ?? '').trim() || String(result.error ?? ''))
    }
    ran.push(...statusRan)
    active = statusRan.length > 0 && statusRan.every((r) => r.code === 0)
  } else if (own.state === 'absent' && old.state === 'own') {
    label = spec.legacy.label
    active = old.artifacts.some((a) => a.active)
    lines.push(`${artifactName(spec, 'legacy', old.artifacts[0]?.what ?? KIND_ARTIFACT[spec.kind])} (installed from this HOME by an older version; the next install renames it to "${spec.label}")`)
  } else if (own.state === 'absent') {
    lines.push(`${artifactName(spec, 'own', KIND_ARTIFACT[spec.kind])} is not registered`)
  } else {
    lines.push(refusal(spec, own).replace(/^refused: /, ''))
  }
  lines.push(...leftAlone(spec, old, fs))
  /** @type {LegacyOutcome} */
  const legacy = { label: spec.legacy.label, state: old.state, home: old.home }
  return { active, output: lines.join('\n').trim(), ran, label, legacy }
}

// -- Credentials ----------------------------------------------------------------------

export function watcherCredentialsPath(home) {
  return joinDir(watcherHome(home), CREDENTIALS_FILE_NAME)
}

function validateCredentials(creds) {
  const pairingId = creds?.pairingId
  const pairingOk =
    (typeof pairingId === 'number' && Number.isInteger(pairingId) && pairingId > 0) ||
    (typeof pairingId === 'string' && /^\d+$/.test(pairingId))
  if (!pairingOk) return 'pairingId must be a positive integer'
  if (typeof creds.token !== 'string' || !creds.token.trim()) return 'token must be a non-empty string'
  if (typeof creds.backendUrl !== 'string' || !creds.backendUrl.trim()) return 'backendUrl must be a non-empty string'
  if (typeof creds.machineId !== 'string' || !creds.machineId.trim()) return 'machineId must be a non-empty string'
  return null
}

/**
 * Write <watcherHome>/credentials.json at mode 0600. On win32 the mode is a
 * no-op; call applyWin32CredentialsAcl afterwards (icacls, like bgos-pair).
 * Throws on incomplete credentials BEFORE writing anything.
 * @param {string} home
 * @param {WatcherCredentials} creds
 * @param {import('./watcher-bundle.mjs').WatcherFs} [fs]
 * @returns {string} the path written
 */
export function writeWatcherCredentials(home, creds, fs = nodeFs()) {
  const problem = validateCredentials(creds)
  if (problem) throw new Error(`writeWatcherCredentials: ${problem}`)
  const path = watcherCredentialsPath(home)
  const body = {
    pairingId: creds.pairingId,
    token: creds.token,
    backendUrl: creds.backendUrl,
    machineId: creds.machineId,
  }
  fs.writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE })
  fs.chmod(path, CREDENTIALS_FILE_MODE)
  return path
}

/**
 * Read + validate the watcher credentials; null when absent, junk, or
 * incomplete (the watcher then waits, it never runs half-authenticated).
 * @returns {WatcherCredentials | null}
 */
export function readWatcherCredentials(home, fs = nodeFs()) {
  const raw = fs.readFile(watcherCredentialsPath(home))
  if (raw == null) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (validateCredentials(parsed)) return null
  return {
    pairingId: parsed.pairingId,
    token: parsed.token,
    backendUrl: parsed.backendUrl,
    machineId: parsed.machineId,
  }
}

/**
 * Lock a credentials file to the current Windows user with icacls (the exact
 * argv bgos-pair uses: strip inheritance, then grant the user full control).
 * Reports honestly: a failed lock says UNPROTECTED so the operator knows.
 * @param {string} path
 * @param {{ username: string, exec?: import('./watcher-bundle.mjs').Exec, executable?: string }} deps
 */
export async function applyWin32CredentialsAcl(path, { username, exec = nodeExec(), executable = 'icacls' }) {
  const user = String(username ?? '').trim()
  if (!user) {
    return { ok: false, message: 'UNPROTECTED, no Windows username to grant to; restrict the credentials file by hand' }
  }
  const result = await exec(executable, [String(path), '/inheritance:r', '/grant:r', `${user}:F`])
  if (result.code === 0) return { ok: true, message: 'locked to your Windows user' }
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || String(result.error ?? `rc ${result.code}`)
  return { ok: false, message: `UNPROTECTED, the Windows ACL could not be applied, restrict it by hand: ${detail}` }
}
