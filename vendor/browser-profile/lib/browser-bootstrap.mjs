import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { chromeEnv } from './browser-env.mjs'

const require = createRequire(import.meta.url)
const pending = new Map()
const failure = code => Object.assign(new Error(code === 'browser_dependencies_missing'
  ? 'Chromium needs operating-system libraries or sandbox support. Install the prerequisites reported by the browser on this machine; HOAI will not run apt or disable its sandbox.'
  : 'The bundled Chromium could not be installed. Check network access and writable user cache, then retry the browser.'), { code })

export function bundledChromium() {
  const { chromium } = require('playwright-core')
  const executable = chromium.executablePath()
  let revision = dirname(executable)
  while (dirname(revision) !== revision && !/^chromium-\d+$/.test(basename(revision))) revision = dirname(revision)
  if (!/^chromium-\d+$/.test(basename(revision))) throw failure('browser_install_failed')
  return { executable, cache: dirname(revision), cli: join(dirname(require.resolve('playwright-core/package.json')), 'cli.js') }
}

function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The pinned Playwright package supplies its own pinned Chromium download. */
export async function ensureBrowser({ findInstalled = () => ({ path: /** @type {string | null} */ (null) }), env = process.env, log = () => {}, timeoutMs = 180000,
  bundle = bundledChromium, spawnImpl = spawn } = {}) {
  const installed = findInstalled?.()
  if (installed?.path) return installed.path
  // An explicit invalid executable is a configuration error, not permission
  // to replace it with a different browser.
  if (env.HOAI_BROWSER_EXECUTABLE) throw failure('browser_install_failed')
  const resolved = bundle()
  if (existsSync(resolved.executable)) return resolved.executable
  if (pending.has(resolved.executable)) return pending.get(resolved.executable)
  const task = install(resolved, { env, log, timeoutMs, spawnImpl })
  pending.set(resolved.executable, task)
  try { return await task } finally { pending.delete(resolved.executable) }
}

async function install({ executable, cache, cli }, { env, log, timeoutMs, spawnImpl }) {
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  if (lstatSync(cache).isSymbolicLink()) throw failure('browser_install_failed')
  const lock = join(cache, '.hoai-chromium-install.lock'), deadline = Date.now() + timeoutMs
  let held = false
  while (!held) {
    if (existsSync(executable)) return executable
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid })) } finally { closeSync(fd) }
      held = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw failure('browser_install_failed')
      try {
        const st = lstatSync(lock)
        if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) throw failure('browser_install_failed')
        const owner = JSON.parse(readFileSync(lock, 'utf8'))
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid)) { unlinkSync(lock); continue }
      } catch (error) { if (error.code === 'browser_install_failed') throw error }
      if (Date.now() >= deadline) throw failure('browser_install_failed')
      await wait(200)
    }
  }
  try {
    if (existsSync(executable)) return executable
    log('Installing the Chromium revision bundled with this plugin into the user cache.')
    await new Promise((resolve, reject) => {
      const child = spawnImpl(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
        env: { ...chromeEnv({ ...env, HOAI_BROWSER_CHROME_ENV: '' }), PLAYWRIGHT_BROWSERS_PATH: cache }, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
      })
      const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch {}; reject(failure('browser_install_failed')) }, Math.max(1, deadline - Date.now()))
      child.once('error', () => { clearTimeout(timer); reject(failure('browser_install_failed')) })
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(failure('browser_install_failed')) })
    })
    if (!existsSync(executable)) throw failure('browser_install_failed')
    log('The bundled Chromium is installed; the browser keeps its normal sandbox.')
    return executable
  } finally { try { if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock) } catch {} }
}
