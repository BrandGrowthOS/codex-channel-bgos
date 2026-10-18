import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, lstatSync, fstatSync, writeSync, ftruncateSync, fsyncSync } from 'node:fs'
import { basename, dirname, join, isAbsolute, relative, sep } from 'node:path'
import { chromeEnv } from './browser-env.mjs'
import { trackBrowserInstaller, installRecoveryRequired } from './browser-install-lifetime.mjs'

const require = createRequire(import.meta.url)
const failure = () => Object.assign(new Error('The bundled Chromium could not be installed. Check the pinned package and writable user cache.'), { code: 'browser_install_failed' })
const lockName = '.hoai-chromium-install.lock'
const pin = JSON.parse(readFileSync(new URL('./browser-bootstrap.pin.json', import.meta.url), 'utf8'))
const regular = (path, max, { allowHardlinks = false } = {}) => { const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || (!allowHardlinks && st.nlink !== 1) || st.size > max) throw failure(); return st }

/** Exact bundled package paths only; not a different executable or downloader. */
export function bundledChromium() {
  const root = dirname(require.resolve('playwright-core/package.json'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (pkg.version !== pin.playwrightVersion) throw failure()
  for (const path of ['cli.js', 'lib/bootstrap.js', 'lib/coreBundle.js', 'lib/utilsBundle.js', 'lib/entry/oopBrowserDownload.js']) {
    // Bun's package cache uses hardlinks on Linux and Windows. These exact
    // dependency bytes are hash-pinned below. Runtime files and locks keep the single-link check.
    const file = join(root, path); regular(file, 16000000, { allowHardlinks: true })
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== pin.sha256[path]) throw failure()
  }
  const executable = require('playwright-core').chromium.executablePath()
  let revision = dirname(executable)
  while (dirname(revision) !== revision && !/^chromium-\d+$/.test(basename(revision))) revision = dirname(revision)
  if (basename(revision) !== `chromium-${pin.chromiumRevision}`) throw failure()
  return { executable, cache: dirname(revision), cli: join(root, 'cli.js'), marker: join(revision, 'INSTALLATION_COMPLETE') }
}

function resolvedPaths(value) {
  if (!value || !['executable', 'cache', 'cli', 'marker'].every(key => typeof value[key] === 'string' && isAbsolute(value[key]))) throw failure()
  for (const path of [value.executable, value.marker]) {
    const rel = relative(value.cache, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw failure()
  }
  return value
}
function installed(resolved) {
  try { regular(resolved.executable, 1000000000); regular(resolved.marker, 1024); return true } catch { return false }
}
function lockExists(cache) { return existsSync(join(cache, lockName)) }
function claim(cache) {
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  if (lstatSync(cache).isSymbolicLink()) throw failure()
  const path = join(cache, lockName), nonce = randomUUID()
  let fd
  try { fd = openSync(path, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') throw installRecoveryRequired(); throw failure() }
  const original = fstatSync(fd)
  let open = true
  const matches = () => {
    const st = regular(path, 2048)
    if (st.dev !== original.dev || st.ino !== original.ino) return false
    return JSON.parse(readFileSync(path, 'utf8')).nonce === nonce
  }
  const write = state => {
    if (!open) throw installRecoveryRequired()
    const bytes = Buffer.from(JSON.stringify({ version: 1, kind: 'hoai-browser-install', nonce, ownerPid: process.pid, state }))
    writeSync(fd, bytes, 0, bytes.length, 0); ftruncateSync(fd, bytes.length); fsyncSync(fd)
  }
  try { write('installing') } catch { closeSync(fd); throw installRecoveryRequired() }
  return {
    markUnknown() { if (open) { try { if (matches()) write('recovery-required') } catch {} } },
    abandon() { if (open) { open = false; try { closeSync(fd) } catch {} } },
    release() {
      if (!open || !matches()) return false
      unlinkSync(path); open = false; closeSync(fd)
      return !existsSync(path)
    },
  }
}
function safeRelease(lock) { try { return lock.release() === true } catch { return false } }

/** Main-process controller; production uses the singleton below. */
export function createBrowserBootstrap() {
  const records = new Map(), blocked = new Set()
  let closing = false
  const activity = () => ({ pendingPhysicalOperations: [...records.values()].reduce((n, record) => n + record.activity().pendingPhysicalOperations, 0), cleanupUnknown: blocked.size > 0 || [...records.values()].some(record => record.unknown || record.activity().cleanupUnknown) })
  async function ensure({ findInstalled = () => ({ path: null }), env = process.env, log = () => {}, timeoutMs = 180000, bundle = bundledChromium, spawnImpl = spawn, platform = process.platform } = {}) {
    if (closing) throw installRecoveryRequired()
    const found = findInstalled?.()
    if (env.HOAI_BROWSER_EXECUTABLE && !found?.path) throw failure()
    const resolved = resolvedPaths(bundle())
    const current = records.get(resolved.executable)
    // Also fences findInstalled discovering a binary during extraction.
    if (current) return current.result.then(() => found?.path || resolved.executable)
    if (lockExists(resolved.cache) || blocked.has(resolved.cache)) { blocked.add(resolved.cache); throw installRecoveryRequired() }
    if (found?.path && found.path !== resolved.executable) return found.path
    let lock
    try { lock = claim(resolved.cache) } catch (error) { if (error.code === 'browser_install_recovery_required') blocked.add(resolved.cache); throw error }
    // Even a complete cached binary is admitted only while this exact cache claim is held.
    if (installed(resolved)) {
      if (safeRelease(lock)) return resolved.executable
      lock.markUnknown(); lock.abandon(); blocked.add(resolved.cache)
      throw installRecoveryRequired()
    }
    let resolveResult, rejectResult, resolvePhysical, rejectPhysical, tracked
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const physical = new Promise((resolve, reject) => { resolvePhysical = resolve; rejectPhysical = reject })
    result.catch(() => {}); physical.catch(() => {})
    let cancelled = false
    const record = {
      result, physical, unknown: false,
      activity: () => tracked ? tracked.activity() : { pendingPhysicalOperations: 1, cleanupUnknown: cancelled },
      cancel() { cancelled = true; rejectResult(installRecoveryRequired()); tracked?.cancel() },
    }
    // Publish both deferred reservations before logger/spawn callbacks can re-enter ensure or stop.
    records.set(resolved.executable, record)
    physical.then(() => { if (records.get(resolved.executable) === record) records.delete(resolved.executable) }, () => { record.unknown = true; blocked.add(resolved.cache); lock.abandon() })
    try { log('Installing the Chromium revision bundled with this plugin into the user cache.') } catch {}
    if (cancelled || closing) {
      record.cancel()
      if (safeRelease(lock)) resolvePhysical()
      else { lock.markUnknown(); rejectPhysical(installRecoveryRequired()) }
      return result
    }
    let child
    try {
      child = spawnImpl(process.execPath, [resolved.cli, 'install', 'chromium', '--no-shell'], {
        env: { ...chromeEnv({ ...env, HOAI_BROWSER_CHROME_ENV: '' }), PLAYWRIGHT_BROWSERS_PATH: resolved.cache },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: platform === 'linux',
      })
    } catch {
      if (safeRelease(lock)) { rejectResult(failure()); resolvePhysical() }
      else { lock.markUnknown(); rejectResult(installRecoveryRequired()); rejectPhysical(installRecoveryRequired()) }
      return result
    }
    tracked = trackBrowserInstaller({ child, timeoutMs, verifyInstalled: () => {
      const current = resolvedPaths(bundle())
      return ['executable', 'cache', 'cli', 'marker'].every(key => current[key] === resolved[key]) && installed(resolved)
    }, release: () => lock.release(), markUnknown: () => lock.markUnknown(),
      ...(platform !== process.platform ? { captureGroup: () => null, groupEmpty: () => false } : {}) })
    tracked.result.then(resolveResult, rejectResult)
    tracked.physical.then(resolvePhysical, rejectPhysical)
    if (cancelled) tracked.cancel()
    await result
    try { log('The bundled Chromium is installed; the browser keeps its normal sandbox.') } catch {}
    return resolved.executable
  }
  return {
    ensureBrowser: ensure,
    readiness({ bundle = bundledChromium } = {}) {
      const resolved = resolvedPaths(bundle()), current = records.get(resolved.executable)
      if (closing || blocked.has(resolved.cache) || current?.unknown || current?.activity().cleanupUnknown) return { state: 'recovery-required', executable: resolved.executable }
      if (current) return { state: 'installing', executable: resolved.executable }
      if (lockExists(resolved.cache)) return { state: 'recovery-required', executable: resolved.executable }
      const ready = installed(resolved)
      // Diagnostic observation only, never an activation reservation. Recheck a concurrent lock before reporting readiness.
      if (lockExists(resolved.cache)) return { state: 'recovery-required', executable: resolved.executable }
      return { state: ready ? 'installed' : 'needs-install', executable: resolved.executable }
    },
    activity,
    cancel() { closing = true; for (const record of records.values()) record.cancel() },
    async whenDrained() { await Promise.all([...records.values()].map(record => record.physical)); if (activity().cleanupUnknown) throw installRecoveryRequired() },
  }
}

const shared = createBrowserBootstrap()
export const ensureBrowser = options => shared.ensureBrowser(options)
export const browserBootstrapReadiness = options => shared.readiness(options)
export const browserInstallActivity = () => shared.activity()
export const cancelBrowserInstallations = () => shared.cancel()
export const whenBrowserInstallationsDrained = () => shared.whenDrained()
