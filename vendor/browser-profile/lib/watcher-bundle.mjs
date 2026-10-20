/**
 * watcher-bundle: the per-machine watcher's installed bundle, copied OUT of
 * the plugin folder so a plugin reinstall / uninstall / cache-dir move never
 * kills the watcher that performs them.
 *
 * Layout (design 1.5 / 7.1), all under <home>/.bgos-agent/watcher/:
 *   bin/hoai-watcher.mjs, bin/bgos-install-method.mjs, lib/*.mjs   the bundle
 *   manifest.json       {version, fingerprint, installedAt, pluginRoot, files}
 *                       (files: what was COPIED, the closure included)
 *   credentials.json    (0600, written by lib/watcher-service.mjs)
 *   state.json          runtime state (last heartbeat, last job, the last
 *                       bundle repair attempt: bundleRepair {at, outcome})
 *   logs/watcher.log    scrubbed log
 *   next/               a staged bundle awaiting swapStagedBundle
 *
 * The fingerprint is a sha256 over the bundle files' contents in a fixed
 * order, so a post-update reconcile can tell "the plugin changed but the
 * watcher code did not" from "the watcher must refresh itself" without
 * trusting version strings.
 *
 * WHAT IS COPIED COMES FROM THE ROOT, NOT FROM THE CALLER (e2e E4). The code
 * that installs a bundle is usually OLDER than the plugin root it copies: the
 * daemon that runs "Set up the watcher" still runs the previous version while
 * the plugin on disk is already updated, and a watcher's self refresh runs the
 * old watcher's code. Copying only the installer's own list shipped bundles
 * without the files a release added (measured 2026-10-07: "Cannot find module
 * .../lib/win32-script-text.mjs"). So installWatcherBundle copies the list
 * UNION the import closure walked from the root's own bin/hoai-watcher.mjs
 * (watcherImportClosure), then checks every relative import inside the copied
 * bundle resolves and throws WatcherBundleIncompleteError otherwise. For the
 * bundles older code already installed, repairWatcherBundle is the entry's
 * self repair: it walks the same closure from the manifest's plugin root and
 * copies what is missing. THIS MODULE MUST STAY BUILTINS ONLY: the entry
 * reaches the repair with a dynamic import of this file, which every bundle
 * list since 0.38 carries, at the moment the rest of the bundle does not load.
 *
 * This module also hosts the node adapters (nodeFs / nodeExec /
 * nodeSpawnDetached) every watcher module defaults to, so the daemon-side
 * installer (lib/watcher-install.mjs) and the tests share one injectable
 * surface. Plain JavaScript, node >= 18 builtins only, import-safe.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, posix } from 'node:path'

/** The files copied into the bundle, relative to the plugin root (design 7.5). */
export const WATCHER_BUNDLE_FILES = Object.freeze([
  'bin/hoai-watcher.mjs',
  'bin/bgos-install-method.mjs',
  'lib/plugin-cli.mjs',
  'lib/update-planner.mjs',
  'lib/update-executor.mjs',
  // IMPORTED BY update-executor.mjs AND MISSED WHEN THAT IMPORT WAS ADDED.
  // Without it the staged bundle is incomplete and `hoai-watcher run` dies on
  // start with "Cannot find module ... known-good-store.mjs", which on a real
  // machine looked like "watcher starting" logged twice and then nothing: the
  // Scheduled Task still read Ready with LastTaskResult 0 and the app sat on
  // "Setting up the watcher" for ever, so nobody was told. Found on 0.61.1 by
  // Ares on 2026-10-05. The import-closure test below is the part that stops
  // the next new import repeating it.
  'lib/known-good-store.mjs',
  'lib/update-diagnostics.mjs',
  'lib/machine-id.mjs',
  'lib/watcher-core.mjs',
  'lib/watcher-service.mjs',
  'lib/watcher-bundle.mjs',
  'lib/agent-inventory.mjs',
  'lib/agent-restart.mjs',
  'lib/service-supervision.mjs',
  'lib/agent-verify.mjs',
  'lib/claude-preseed.mjs',
  // The crash-safe entry's only non-builtin import (design 8, fact 5): it has to
  // load when nothing else does, so it imports nothing but node builtins.
  'lib/watcher-health.mjs',
  // The keep-alive sweep (design 5) and everything it imports: the pure
  // decisions, the process table, the Windows agent task.
  'lib/watcher-keepalive.mjs',
  'lib/keepalive-plan.mjs',
  'lib/process-tree.mjs',
  'lib/agent-task-win32.mjs',
  // The read-back of an agent's own service before the sweep or a restart acts on
  // it (board row d6198bb6): imported by agent-task-win32.mjs and agent-restart.mjs.
  'lib/agent-service.mjs',
  // The ASCII-only vbs/ps1 string helpers: imported by agent-task-win32.mjs
  // and watcher-service.mjs, a leaf so the service never pulls agent-inventory in.
  'lib/win32-script-text.mjs',
  // Show agent windows (board row d133ddb2): the windows pass after every sweep,
  // its pure rules, and the Windows watch only viewer it starts. The viewer files
  // are not modules (no import names them), so this list is the only thing that
  // carries them: the pass runs <bundle>/bin/hoai-agent-viewer.vbs, which runs the
  // .ps1 beside it.
  'lib/agent-windows.mjs',
  'lib/agent-windows-plan.mjs',
  'bin/hoai-agent-viewer.vbs',
  'bin/hoai-agent-viewer.ps1',
])

export const MANIFEST_FILE_NAME = 'manifest.json'
export const STAGING_DIR_NAME = 'next'
export const PREVIOUS_DIR_NAME = 'prev'
/** The top-level entries a swap replaces (everything else is runtime state). */
export const SWAPPABLE_ENTRIES = Object.freeze(['bin', 'lib', MANIFEST_FILE_NAME])

/** daemonVersion on the wire must look like a semver (design 7.5). */
export const VERSION_RE = /^\d+\.\d+\.\d+[-\w.]*$/

/** The entry the service runs, and where every closure walk starts. */
export const WATCHER_ENTRY = 'bin/hoai-watcher.mjs'
/** error.code of WatcherBundleIncompleteError (lib/watcher-install.mjs matches on it). */
export const BUNDLE_INCOMPLETE_CODE = 'WATCHER_BUNDLE_INCOMPLETE'
/** At most one self repair attempt per bundle in this window (state.json bundleRepair.at). */
export const BUNDLE_REPAIR_INTERVAL_MS = 10 * 60_000

/**
 * @typedef {{
 *   exists: (path: string) => boolean,
 *   readFile: (path: string) => string | null,
 *   writeFile: (path: string, text: string, opts?: { mode?: number }) => void,
 *   appendFile?: (path: string, text: string) => void,
 *   size?: (path: string) => number | null,
 *   mkdir: (path: string) => void,
 *   listDir: (path: string) => string[],
 *   stat: (path: string) => { mtimeMs: number, isDirectory: boolean } | null,
 *   rm: (path: string) => void,
 *   rename: (from: string, to: string) => void,
 *   copyFile: (from: string, to: string) => void,
 *   chmod: (path: string, mode: number) => void,
 * }} WatcherFs
 */

/**
 * @typedef {{
 *   version: string,
 *   fingerprint: string,
 *   installedAt: string | null,
 *   pluginRoot: string | null,
 *   files: string[],
 * }} BundleManifest
 */

// -- Paths ---------------------------------------------------------------------

/** Join preserving the directory's separator style. */
export function joinDir(dir, name) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return String(name ?? '')
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${name}`
}

/** Join a relative bundle path ('lib/x.mjs') under a dir in that dir's style. */
export function joinRel(dir, rel) {
  return String(rel)
    .split('/')
    .reduce((acc, part) => joinDir(acc, part), String(dir))
}

export function watcherHome(home) {
  return joinDir(joinDir(home, '.bgos-agent'), 'watcher')
}

export function watcherLogPath(home) {
  return joinDir(joinDir(watcherHome(home), 'logs'), 'watcher.log')
}

export function watcherStatePath(home) {
  return joinDir(watcherHome(home), 'state.json')
}

export function manifestPath(bundleDir) {
  return joinDir(bundleDir, MANIFEST_FILE_NAME)
}

// -- Node adapters ------------------------------------------------------------------

/** The real filesystem behind the WatcherFs surface. Reads never throw
 *  (null / [] / false), writes do (the caller decides how to report). */
export function nodeFs() {
  return {
    exists: (path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (path, text, opts = {}) => {
      mkdirSync(dirname(path), { recursive: true })
      if (opts.mode != null) {
        writeFileSync(path, text, { mode: opts.mode })
        try {
          chmodSync(path, opts.mode)
        } catch {
          // win32 has no POSIX modes; the caller applies an ACL instead.
        }
      } else {
        writeFileSync(path, text)
      }
    },
    // Optional on the typedef, so an injected test filesystem without them stays valid and the
    // logger falls back to its read-then-write. Present here because the production logger runs for
    // the life of the machine and the fallback is O(n) per line.
    appendFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, text)
    },
    size: (path) => {
      try {
        return statSync(path).size
      } catch {
        return null
      }
    },
    mkdir: (path) => {
      mkdirSync(path, { recursive: true })
    },
    listDir: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
    stat: (path) => {
      try {
        const s = statSync(path)
        return { mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() }
      } catch {
        return null
      }
    },
    rm: (path) => {
      rmSync(path, { recursive: true, force: true })
    },
    rename: (from, to) => {
      renameSync(from, to)
    },
    copyFile: (from, to) => {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    },
    chmod: (path, mode) => {
      try {
        chmodSync(path, mode)
      } catch {
        // best effort (win32)
      }
    },
  }
}

/**
 * @typedef {(file: string, args: readonly string[], opts?: { cwd?: string,
 *   env?: Record<string, string | undefined>, timeoutMs?: number, input?: string })
 *   => Promise<{ code: number | null, stdout: string, stderr: string, error: string | null, timedOut: boolean }>} Exec
 */

/** execFile that never throws: a spawn failure is {code:null, error}. */
export function nodeExec() {
  return (file, args, opts = {}) =>
    new Promise((resolve) => {
      let child
      try {
        child = execFile(
          file,
          [...args],
          {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            timeout: opts.timeoutMs ?? 0,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const timedOut = Boolean(error && error.killed && opts.timeoutMs)
            resolve({
              code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              error: error && typeof error.code !== 'number' ? String(error.message ?? error) : null,
              timedOut,
            })
          },
        )
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: '', error: String(err?.message ?? err), timedOut: false })
        return
      }
      if (opts.input != null && child.stdin) {
        // A child that exits before reading its stdin EPIPEs the write; an
        // unhandled 'error' there would take the whole watcher down.
        child.stdin.on('error', () => {})
        child.stdin.end(opts.input)
      }
    })
}

/**
 * @typedef {(file: string, args: readonly string[], opts?: { cwd?: string,
 *   env?: Record<string, string | undefined>, windowsVerbatimArguments?: boolean,
 *   windowsHide?: boolean }) => { pid: number | null }} SpawnDetached
 */

/** A fire-and-forget child: detached, stdio ignored, unref'd. Throws only on
 *  a synchronous spawn failure (the caller reports it). */
export function nodeSpawnDetached() {
  return (file, args, opts = {}) => {
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: opts.windowsVerbatimArguments ?? false,
      windowsHide: opts.windowsHide ?? false,
    })
    child.on('error', () => {})
    child.unref()
    return { pid: child.pid ?? null }
  }
}

// -- Import closure --------------------------------------------------------------------

/** Only module sources are scanned for further imports; any other file is carried as is. */
const SCANNED_SOURCE_RE = /\.(?:mjs|js)$/
/** import x from <rel>, import { x } from <rel>, export { x } from <rel>, export * from <rel> */
const FROM_RE = /\bfrom\s*(['"])(\.{1,2}\/[^'"\r\n]+)\1/g
/** import <rel> (a side effect import) */
const BARE_IMPORT_RE = /\bimport\s*(['"])(\.{1,2}\/[^'"\r\n]+)\1/g
/** import(<rel>), a dynamic import of a string literal (no template holes) */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])(\.{1,2}\/[^'"`$\r\n]+)\1\s*[,)]/g

/**
 * Comments are dropped before scanning, conservatively: only a block comment
 * or a line comment that STARTS a line (JSDoc import(<rel>) type
 * references, commented out code). A comment after code on the same line is
 * left alone, so a string holding a slash star is never taken for one.
 */
function stripLeadingComments(source) {
  return String(source ?? '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * The relative specifiers a module source imports: static import and export
 * from, side effect imports, and dynamic import() of a string literal. Bare
 * names and node: builtins are not files a bundle carries.
 * @param {string} source
 * @returns {string[]}
 */
export function relativeImportSpecifiers(source) {
  const text = stripLeadingComments(source)
  const found = new Set()
  for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    for (const match of text.matchAll(re)) found.add(match[2])
  }
  return [...found]
}

/** A specifier resolved against the file that imports it, as a root relative
 *  posix path; null when it leaves the root. */
function resolveImport(fromRel, specifier) {
  const path = String(specifier).split(/[?#]/)[0]
  const resolved = posix.normalize(posix.join(posix.dirname(fromRel), path))
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) return null
  return resolved
}

/**
 * The import closure of `entries` under `root`, read from the files
 * themselves: every relative static import, export from and dynamic import()
 * of a string literal, resolved against the file that holds it and confined
 * to the root. ONE implementation for the installer (what to copy, and is the
 * copy complete) and for the entry's self repair (what to restore).
 * @param {string} root
 * @param {{ entries?: readonly string[], fs?: WatcherFs }} [opts]
 * @returns {{ ok: boolean, files: string[], missing: Array<{ file: string, importedBy: string | null }>,
 *   escaped: Array<{ specifier: string, importedBy: string }> }}
 */
export function watcherImportClosure(root, { entries = [WATCHER_ENTRY], fs = nodeFs() } = {}) {
  /** @type {string[]} */
  const files = []
  /** @type {Array<{ file: string, importedBy: string | null }>} */
  const missing = []
  /** @type {Array<{ specifier: string, importedBy: string }>} */
  const escaped = []
  const seen = new Set()
  /** @type {Array<{ rel: string, importedBy: string | null }>} */
  const queue = entries.map((rel) => ({ rel: posix.normalize(String(rel)), importedBy: null }))
  while (queue.length > 0) {
    const next = queue.shift()
    if (!next || seen.has(next.rel)) continue
    seen.add(next.rel)
    const source = fs.readFile(joinRel(root, next.rel))
    if (source == null) {
      missing.push({ file: next.rel, importedBy: next.importedBy })
      continue
    }
    files.push(next.rel)
    if (!SCANNED_SOURCE_RE.test(next.rel)) continue
    for (const specifier of relativeImportSpecifiers(source)) {
      const target = resolveImport(next.rel, specifier)
      if (target === null) escaped.push({ specifier, importedBy: next.rel })
      else if (!seen.has(target)) queue.push({ rel: target, importedBy: next.rel })
    }
  }
  return { ok: missing.length === 0 && escaped.length === 0, files, missing, escaped }
}

/** The named failure of a bundle (or a root) whose relative imports do not all resolve. */
export class WatcherBundleIncompleteError extends Error {
  /**
   * @param {{ missing?: Array<{ file: string, importedBy: string | null }>,
   *   escaped?: Array<{ specifier: string, importedBy: string }>, where: string }} input
   */
  constructor({ missing = [], escaped = [], where }) {
    const parts = [
      ...missing.map((m) => `${m.file} (imported by ${m.importedBy ?? 'the bundle list'})`),
      ...escaped.map((e) => `${e.specifier} (imported by ${e.importedBy}, outside the bundle)`),
    ]
    const summary = parts.join(', ')
    super(`watcher bundle incomplete: ${summary} not found under ${where}`)
    this.name = 'WatcherBundleIncompleteError'
    this.code = BUNDLE_INCOMPLETE_CODE
    /** Bundle relative names only, no machine path: safe for a progress message. */
    this.summary = summary
    /** @type {string[]} */
    this.missing = [...missing.map((m) => m.file), ...escaped.map((e) => e.specifier)]
  }
}

/**
 * The completeness check: every relative import of every file in `files`
 * resolves to a file inside `bundleDir`.
 * @param {string} bundleDir
 * @param {readonly string[]} [files]
 * @param {WatcherFs} [fs]
 * @returns {string[]} the closure that was checked
 * @throws {WatcherBundleIncompleteError}
 */
export function assertWatcherBundleComplete(bundleDir, files = [WATCHER_ENTRY], fs = nodeFs()) {
  const walk = watcherImportClosure(bundleDir, { entries: files, fs })
  if (!walk.ok) throw new WatcherBundleIncompleteError({ missing: walk.missing, escaped: walk.escaped, where: bundleDir })
  return walk.files
}

/** `first` in its own order, then whatever `more` adds, sorted. */
function orderedUnion(first, more) {
  const head = [...new Set(first)]
  const tail = [...new Set(more)].filter((rel) => !head.includes(rel)).sort()
  return [...head, ...tail]
}

/**
 * What a bundle copied from `root` holds: the given list UNION the import
 * closure walked from the root's own entry (and from every listed file), so
 * the set comes from the root's real code and never only from the caller's
 * list, which may be a release older (e2e E4).
 * @param {string} root
 * @param {{ files?: readonly string[], fs?: WatcherFs }} [opts]
 * @returns {string[]}
 * @throws {WatcherBundleIncompleteError} when the root's own imports do not resolve inside it
 */
export function watcherBundleFileSet(root, { files = WATCHER_BUNDLE_FILES, fs = nodeFs() } = {}) {
  const walk = watcherImportClosure(root, { entries: [WATCHER_ENTRY, ...files], fs })
  if (!walk.ok) throw new WatcherBundleIncompleteError({ missing: walk.missing, escaped: walk.escaped, where: root })
  return orderedUnion(files, walk.files)
}

// -- Fingerprint --------------------------------------------------------------------

/**
 * sha256 over the bundle files: for each relative path in sorted order,
 * `<rel>\0<content or <missing>>\0`. The files are the list UNION the root's
 * import closure (what installWatcherBundle copies), so a file only the
 * closure names still moves the fingerprint. Missing files are part of the
 * hash so a partial bundle never fingerprints like a complete one.
 * @param {string} pluginRoot
 * @param {WatcherFs} fs
 * @param {readonly string[]} [files]
 */
export function bundleFingerprint(pluginRoot, fs = nodeFs(), files = WATCHER_BUNDLE_FILES) {
  const walk = watcherImportClosure(pluginRoot, { entries: [WATCHER_ENTRY, ...files], fs })
  const hash = createHash('sha256')
  for (const rel of [...new Set([...files, ...walk.files, ...walk.missing.map((m) => m.file)])].sort()) {
    const content = fs.readFile(joinRel(pluginRoot, rel))
    hash.update(rel)
    hash.update('\0')
    hash.update(content == null ? '<missing>' : content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

// -- Manifest --------------------------------------------------------------------------

/** Parse a manifest body; null for junk or a non-semver version. */
export function parseBundleManifest(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const version = String(parsed.version ?? '').trim()
  if (!VERSION_RE.test(version)) return null
  const fingerprint = String(parsed.fingerprint ?? '').trim()
  if (!fingerprint) return null
  return {
    version,
    fingerprint,
    claudeConfigDir: typeof parsed.claudeConfigDir === 'string' && parsed.claudeConfigDir.trim() ? parsed.claudeConfigDir.trim() : null,
    installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : null,
    pluginRoot: typeof parsed.pluginRoot === 'string' && parsed.pluginRoot ? parsed.pluginRoot : null,
    files: Array.isArray(parsed.files) ? parsed.files.filter((f) => typeof f === 'string') : [],
  }
}

/** The installed bundle's manifest, or null. */
export function readBundleManifest(home, fs = nodeFs()) {
  return parseBundleManifest(fs.readFile(manifestPath(watcherHome(home))))
}

/** The plugin's own version from <pluginRoot>/package.json, or null. */
export function readPluginVersion(pluginRoot, fs = nodeFs()) {
  const raw = fs.readFile(joinDir(pluginRoot, 'package.json'))
  if (raw == null) return null
  try {
    const version = String(JSON.parse(raw)?.version ?? '').trim()
    return VERSION_RE.test(version) ? version : null
  } catch {
    return null
  }
}

// -- Install ---------------------------------------------------------------------------

/**
 * Copy the bundle from a plugin root into the watcher home (or a staging dir),
 * preserving the bin/ + lib/ layout, and write the manifest. The copied set is
 * `files` (the caller's list) UNION the import closure walked from the ROOT's
 * own entry, so an installer a release older than the root still copies what
 * the root's code imports (e2e E4). Every listed file and every import of the
 * root is checked BEFORE anything is written, so a missing one fails by name
 * with nothing half copied; then the COPY is checked complete (every relative
 * import inside the bundle resolves) before the manifest is written, so no
 * service step ever starts a bundle that cannot load.
 * @param {{ pluginRoot: string, home: string, pluginVersion?: string | null, claudeConfigDir?: string | null,
 *   fs?: WatcherFs, now?: () => number, targetDir?: string, files?: readonly string[] }} params
 * @returns {Promise<{ bundleDir: string, files: string[], fingerprint: string, version: string }>}
 * @throws {WatcherBundleIncompleteError} when the root's imports or the copied bundle do not resolve
 */
export async function installWatcherBundle({
  pluginRoot,
  home,
  pluginVersion = null,
  claudeConfigDir = null,
  fs = nodeFs(),
  now = Date.now,
  targetDir,
  files: listed = WATCHER_BUNDLE_FILES,
}) {
  const root = String(pluginRoot ?? '').trim()
  if (!root) throw new Error('installWatcherBundle: pluginRoot is required')
  const bundleDir = targetDir || watcherHome(home)
  for (const rel of listed) {
    if (!fs.exists(joinRel(root, rel))) throw new Error(`bundle file missing: ${rel} (under ${root})`)
  }
  // The ROOT's own package.json names the files being copied, so it wins; the caller's value only fills
  // in when the root has none. The caller is often OLDER code than the root (a daemon still running the
  // previous version, staged on this one), and its running version labelled a 0.62.0 bundle 0.61.5 in
  // the M6 end to end run (e2e E6): the watcher then reported the wrong version in every heartbeat.
  const version = readPluginVersion(root, fs) || String(pluginVersion ?? '').trim()
  if (!version || !VERSION_RE.test(version)) {
    throw new Error(`installWatcherBundle: no usable plugin version (pass pluginVersion or fix ${joinDir(root, 'package.json')})`)
  }
  const copied = watcherBundleFileSet(root, { files: listed, fs })
  const fingerprint = bundleFingerprint(root, fs, listed)
  fs.mkdir(bundleDir)
  for (const rel of copied) {
    fs.copyFile(joinRel(root, rel), joinRel(bundleDir, rel))
  }
  assertWatcherBundleComplete(bundleDir, copied, fs)
  /** @type {BundleManifest} */
  const manifest = {
    version,
    fingerprint,
    installedAt: new Date(now()).toISOString(),
    pluginRoot: root,
    // The agents' Claude config dir (CLAUDE_CONFIG_DIR at install), so the
    // watcher reconciles the same install; null = the default ~/.claude.
    claudeConfigDir: String(claudeConfigDir ?? '').trim() || null,
    files: [...copied],
  }
  fs.writeFile(manifestPath(bundleDir), `${JSON.stringify(manifest, null, 2)}\n`)
  return { bundleDir, files: [...copied], fingerprint, version }
}

// -- Self repair ----------------------------------------------------------------------------

function readJsonObject(fs, path) {
  try {
    const parsed = JSON.parse(fs.readFile(path) ?? 'null')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function samePath(a, b) {
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return norm(a) === norm(b)
}

function errorLine(err) {
  return (
    String(err?.message ?? err ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? 'unknown error'
  )
}

/**
 * The installed bundle repairs itself from the plugin root its manifest names
 * (e2e E4): bin/hoai-watcher.mjs calls this when a module inside the bundle
 * is not found before the loop starts. It walks the import closure of
 * <pluginRoot>/bin/hoai-watcher.mjs, copies every file of it that is missing
 * from the bundle or differs from the root, and rewrites the manifest (files,
 * fingerprint, version, repairedAt) so it says what the bundle now holds.
 *
 * Bounded: one attempt per BUNDLE_REPAIR_INTERVAL_MS, recorded in the bundle's
 * state.json (bundleRepair {at, outcome}) BEFORE anything is copied, so a
 * repair that does not help is a plain crash loop the guard reports, never a
 * repair loop. Never attempted without a manifest, when the plugin root is
 * gone, or when the root's own closure does not resolve; the reason comes back
 * by name and nothing is copied. Never throws.
 * @param {{ bundleDir: string, fs?: WatcherFs, now?: () => number, log?: (line: string) => void }} params
 * @returns {{ repaired: boolean, reason: string, pluginRoot: string | null, copied: string[], lastAttemptAt?: string }}
 */
export function repairWatcherBundle({ bundleDir, fs = nodeFs(), now = Date.now, log = () => {} }) {
  const dir = String(bundleDir ?? '').trim()
  /** @param {boolean} repaired @param {string} reason @param {string | null} [pluginRoot] @param {string[]} [copied] */
  const done = (repaired, reason, pluginRoot = null, copied = []) => ({ repaired, reason, pluginRoot, copied })
  const manifestFile = manifestPath(dir)
  const manifest = dir ? parseBundleManifest(fs.readFile(manifestFile)) : null
  if (!manifest) return done(false, 'no_manifest')
  const root = manifest.pluginRoot
  if (!root) return done(false, 'no_plugin_root')
  // A checkout running its own entry is not a bundle; nothing is ever written into a plugin root.
  if (samePath(root, dir)) return done(false, 'plugin_root_is_the_bundle', root)
  if (!fs.exists(joinRel(root, WATCHER_ENTRY))) return done(false, 'plugin_root_missing', root)
  const statePath = joinDir(dir, 'state.json')
  const previous = readJsonObject(fs, statePath)?.bundleRepair
  const lastMs = Date.parse(String(previous?.at ?? ''))
  const nowMs = now()
  if (Number.isFinite(lastMs) && nowMs - lastMs >= 0 && nowMs - lastMs < BUNDLE_REPAIR_INTERVAL_MS) {
    return { ...done(false, 'rate_limited', root), lastAttemptAt: String(previous.at) }
  }
  const at = new Date(nowMs).toISOString()
  const record = (outcome, extra = {}) => {
    try {
      const state = readJsonObject(fs, statePath) ?? {}
      fs.writeFile(statePath, `${JSON.stringify({ ...state, bundleRepair: { at, outcome, ...extra } }, null, 2)}\n`)
    } catch {
      // advisory: a bundle dir that cannot take state.json cannot take the copies either
    }
  }
  // The attempt counts from here, whatever happens next.
  record('started')
  const walk = watcherImportClosure(root, { fs })
  if (!walk.ok) {
    record('closure_walk_failed')
    return done(false, `closure_walk_failed: ${new WatcherBundleIncompleteError({ ...walk, where: root }).summary}`, root)
  }
  /** @type {string[]} */
  const copied = []
  try {
    for (const rel of walk.files) {
      const source = joinRel(root, rel)
      const target = joinRel(dir, rel)
      if (fs.exists(target) && fs.readFile(target) === fs.readFile(source)) continue
      fs.copyFile(source, target)
      copied.push(rel)
    }
  } catch (err) {
    record('copy_failed', { files: copied })
    return done(false, `copy_failed: ${errorLine(err)}`, root, copied)
  }
  if (copied.length === 0) {
    record('nothing_to_repair')
    return done(false, 'nothing_to_repair', root)
  }
  try {
    assertWatcherBundleComplete(dir, [WATCHER_ENTRY], fs)
    const raw = readJsonObject(fs, manifestFile) ?? {}
    fs.writeFile(
      manifestFile,
      `${JSON.stringify(
        {
          ...raw,
          version: readPluginVersion(root, fs) ?? manifest.version,
          fingerprint: bundleFingerprint(root, fs),
          files: orderedUnion(manifest.files, walk.files),
          repairedAt: at,
        },
        null,
        2,
      )}\n`,
    )
  } catch (err) {
    record('manifest_failed', { files: copied })
    return done(false, `manifest_failed: ${errorLine(err)}`, root, copied)
  }
  record('repaired', { files: copied })
  log(`bundle repair: copied ${copied.length} file(s) from ${root}: ${copied.join(', ')}`)
  return done(true, 'repaired', root, copied)
}

// -- Staged swap ------------------------------------------------------------------------

/**
 * Promote <watcherHome>/next/ over the live bundle: for bin, lib and the
 * manifest, move the live entry to prev/ and the staged entry into place.
 * Each move is an atomic rename; a failure part-way restores every entry
 * already moved from prev/, so the watcher is never left without a bundle.
 * Runtime state (credentials, state.json, logs) is never touched.
 * @param {{ home: string, fs?: WatcherFs }} params
 * @returns {{ ok: boolean, swapped: string[], message: string }}
 */
export function swapStagedBundle({ home, fs = nodeFs() }) {
  const live = watcherHome(home)
  const next = joinDir(live, STAGING_DIR_NAME)
  const prev = joinDir(live, PREVIOUS_DIR_NAME)
  if (!fs.exists(manifestPath(next))) return { ok: false, swapped: [], message: 'nothing_staged' }
  try {
    fs.rm(prev)
  } catch {
    // A leftover prev/ that cannot be removed is reported by the rename below.
  }
  fs.mkdir(prev)
  const swapped = []
  const movedOut = []
  try {
    for (const entry of SWAPPABLE_ENTRIES) {
      const livePath = joinDir(live, entry)
      const nextPath = joinDir(next, entry)
      const prevPath = joinDir(prev, entry)
      if (!fs.exists(nextPath)) continue
      if (fs.exists(livePath)) {
        fs.rename(livePath, prevPath)
        movedOut.push(entry)
      }
      fs.rename(nextPath, livePath)
      swapped.push(entry)
    }
  } catch (err) {
    // Restore: put back every entry we moved out (the staged copy, if it
    // landed, is moved aside first so the rename target is free).
    for (const entry of movedOut) {
      const livePath = joinDir(live, entry)
      const prevPath = joinDir(prev, entry)
      try {
        if (fs.exists(livePath) && swapped.includes(entry)) fs.rename(livePath, joinDir(next, entry))
        fs.rename(prevPath, livePath)
      } catch {
        // Leave prev/ in place for a human; the log names it.
      }
    }
    return { ok: false, swapped: [], message: `swap_failed: ${String(err?.message ?? err)}` }
  }
  try {
    fs.rm(next)
    fs.rm(prev)
  } catch {
    // Leftover staging dirs are harmless; the next swap clears them.
  }
  return { ok: true, swapped, message: 'swapped' }
}
