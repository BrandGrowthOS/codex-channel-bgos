import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { createAgentProfileFileArea } from './browser-profile-file-area.mjs'
import { artifactInventoryScope, reserveArtifactInventory, retainArtifactInventory, releaseArtifactInventory } from './browser-profile-artifact-inventory.mjs'
const require = createRequire(import.meta.url), { exactAuthority } = require('./browser-profile-core/coordinator-client.js'), { validateFileName, MAX_FILE_BYTES, FILE_TTL_MS } = require('./browser-profile-core/profile-file-crypto.js')
const created = Symbol('owned download manager'), receipts = new WeakMap(), receiving = new Set(), GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const fail = code => Object.assign(new Error(code), { code }), same = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino
const current = check => { const value = check(); if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_download_context_changed') }; if (value === false) throw fail('profile_download_context_changed') }
const ownedFile = (stat, uid) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === uid && Number.isSafeInteger(stat.size) && stat.size >= 0
const regular = (stat, uid) => ownedFile(stat, uid) && stat.size <= MAX_FILE_BYTES
function sourceOf(receipt) { const row = receipts.get(receipt); if (!row || row.state !== 'ready' || row.expiresAt <= row.manager.now()) throw fail('profile_download_receipt_required'); AgentProfileDownloads.prototype.assertCurrent.call(row.manager); return row }
/** Opaque receipt metadata is never a path or an authorization to upload. */
export function completedDownloadMetadata(receipt) { const row = sourceOf(receipt); return Object.freeze({ fileName: row.fileName, contentType: 'application/octet-stream', expiresAt: row.expiresAt }) }
export function retainCompletedDownloadInventory(receipt, scope) { const row = sourceOf(receipt); return retainArtifactInventory(row.inventory, scope) }
export function writeCompletedDownload(receipt, { destination, assertCurrent }) {
  const row = sourceOf(receipt)
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.normalize(destination) !== destination || destination.includes('\0') || typeof assertCurrent !== 'function') return Promise.reject(fail('profile_download_destination_invalid'))
  AgentProfileDownloads.prototype.assertCurrent.call(row.manager); current(assertCurrent); row.state = 'copying'; receipts.delete(receipt); clearTimeout(row.expiry)
  return row.copy(destination, assertCurrent)
}

/** Quarantine belongs to one actual browser context and exact runtime. It has
 * no public path-adoption or website-permission API. Retained files are at most
 * 25MiB; Chromium can transiently overshoot before observed cancellation. */
export class AgentProfileDownloads {
  #records = new Set(); #known = new WeakMap(); #work = new Set(); #pending = new Set(); #unknown = false; #closed = false; #context; #listener; #stop; #stopWork; #launchTaken = false; #current; #active; #fatalWork; #disposeWork; #disposePending = false
  static async create({ directory, authority, assertCurrent, isActive, createArea = createAgentProfileFileArea, filesystem = fs, uid = process.getuid?.(), now = Date.now, deadlineMs = 120000, observationMs = 100, cancellationGraceMs = 2000 }) {
    authority = exactAuthority(authority)
    if (typeof assertCurrent !== 'function' || typeof isActive !== 'function' || typeof createArea !== 'function' || !Number.isSafeInteger(uid) || uid < 0 || typeof now !== 'function' || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120000 || !Number.isSafeInteger(observationMs) || observationMs < 1 || observationMs > 1000 || !Number.isSafeInteger(cancellationGraceMs) || cancellationGraceMs < 1 || cancellationGraceMs > 2000) throw fail('profile_download_configuration_invalid')
    current(assertCurrent); const area = await createArea({ directory, assertCurrent }); current(assertCurrent)
    const owned = path.join(area.directory, randomUUID()); await area.assertPrivateDirectory(area.directory, assertCurrent); current(assertCurrent); await filesystem.mkdir(owned, { mode: 0o700 }); const directoryStat = await filesystem.lstat(owned); current(assertCurrent); await area.assertPrivateDirectory(owned, assertCurrent); current(assertCurrent)
    return new AgentProfileDownloads({ authority, area, directory: owned, directoryStat, assertCurrent, isActive, fs: filesystem, uid, now, deadlineMs, observationMs, cancellationGraceMs }, created)
  }
  constructor(options, capability) { if (capability !== created) throw fail('profile_download_configuration_invalid'); const { assertCurrent, isActive, ...rest } = options; Object.assign(this, rest); this.#current = assertCurrent; this.#active = isActive; this.inventoryScope = artifactInventoryScope(this.authority) }
  #assertHealthy() { if (this.#closed || this.#unknown) throw fail('profile_download_unavailable'); current(this.#current) }
  assertHealthy() { this.#assertHealthy() }
  #assertCurrent() { this.#assertHealthy(); current(this.#active) }
  assertCurrent() { this.#assertCurrent() }
  async launchOptions() {
    if (this.#closed || this.#unknown || this.#launchTaken) throw fail('profile_download_launch_required')
    this.#launchTaken = true; current(this.#current); await this.verifyDirectory(); current(this.#current); return Object.freeze({ downloadsPath: this.directory })
  }
  async bind({ context, stopBrowser }) {
    if (!this.#launchTaken || this.#context || !context || typeof context.on !== 'function' || typeof context.removeListener !== 'function' || typeof context.pages !== 'function' || context.pages().length || typeof stopBrowser !== 'function') throw fail('profile_download_binding_required')
    this.#context = context; this.#stop = stopBrowser
    await this.verifyDirectory(); current(this.#current); if (context.pages().length) throw fail('profile_download_binding_required')
    this.#listener = download => this.onDownload(download); context.on('download', this.#listener)
  }
  async verifyDirectory() { await this.area.assertPrivateDirectory(this.directory); const stat = await this.fs.lstat(this.directory); if (!same(stat, this.directoryStat) || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) throw fail('profile_download_directory_changed') }
  #track(work) { const task = Promise.resolve().then(work); this.#work.add(task); this.#pending.add(task); void task.finally(() => { this.#pending.delete(task); if (!this.#unknown) this.#work.delete(task) }).catch(() => {}); void task.catch(() => {}); return task }
  #stopOwned() {
    if (!this.#stopWork) { const stop = this.#stop; this.#stopWork = Promise.resolve().then(async () => { if (typeof stop !== 'function' || await stop() !== true) throw fail('profile_download_stop_unconfirmed') }); void this.#stopWork.catch(() => { this.#unknown = true }) }
    return this.#stopWork
  }
  #fatal() { this.#unknown = true; for (const row of this.#records) for (const timer of [row.observer, row.deadlineTimer, row.grace, row.expiry]) clearTimeout(timer); return this.#fatalWork ||= this.#track(async () => { await this.#stopOwned() }) }
  onDownload(download) {
    if (download && this.#known.has(download)) return
    let inventory
    try {
      this.#assertCurrent(); if (!this.#context || download.page()?.context() !== this.#context || !this.#context.pages().includes(download.page()) || [...this.#records].some(row => row.state === 'receiving') || this.#records.size >= 4 || receiving.size >= 4) throw fail('profile_download_refused')
      const file = download?._artifact?._initializer?.absolutePath
      if (typeof file !== 'string' || path.dirname(file) !== this.directory || !GUID.test(path.basename(file)) || ['failure', 'cancel', 'delete'].some(name => typeof download[name] !== 'function')) throw fail('profile_download_path_unproved')
      const fileName = validateFileName(download.suggestedFilename()); inventory = reserveArtifactInventory(this.inventoryScope)
      const row = { manager: this, download, inventory, file, fileName, state: 'receiving', deadline: this.now() + this.deadlineMs, deadlineTimer: null, observations: 0, finished: false, cancelled: false, cancelSettled: false, terminal: null, terminalWork: null, cleanupDeadline: null, cleanupConfirmed: false, observedPaths: new Map(), observer: null, observerWork: null, grace: null, expiry: null, stat: null, cancel: null, cleanup: null, receipt: null, copyWork: null }
      row.copy = (destination, check) => this.#copy(row, destination, check)
      row.deadlineTimer = setTimeout(() => { this.#cancel(row) }, this.deadlineMs); row.deadlineTimer.unref?.()
      this.#known.set(download, row); this.#records.add(row); receiving.add(row)
      row.terminalWork = this.#track(async () => { const value = await download.failure(); if (value !== null && (typeof value !== 'string' || !value.length)) throw fail('profile_download_terminal_unconfirmed'); row.terminal = value === null ? 'success' : 'failed'; if (row.terminal === 'failed') this.#cleanupGrace(row); row.finished = true; clearTimeout(row.deadlineTimer); return row.terminal })
      this.#track(() => this.#receive(row))
    } catch { if (inventory) releaseArtifactInventory(inventory); this.#fatal() }
  }
  #cleanupGrace(row) {
    if (row.cleanupDeadline !== null) return
    row.cleanupDeadline = performance.now() + this.cancellationGraceMs
    row.grace = setTimeout(() => { if (!row.cleanupConfirmed) void this.#fatal() }, this.cancellationGraceMs); row.grace.unref?.()
  }
  #cancel(row) {
    row.cancelled = true; clearTimeout(row.observer); clearTimeout(row.deadlineTimer); this.#cleanupGrace(row)
    if (!row.cancel) { row.cancel = this.#track(() => row.download.cancel()); void row.cancel.finally(() => { row.cancelSettled = true }).catch(() => { void this.#fatal() }) }
    return row.cancel
  }
  async #observe(row) {
    if (row.finished || row.cancelled) return
    try {
      this.#assertCurrent(); if (this.now() >= row.deadline || ++row.observations > Math.ceil(this.deadlineMs / this.observationMs) + 1) return void this.#cancel(row)
      await this.verifyDirectory()
      for (const file of [row.file, row.file + '.crdownload']) {
        let stat; try { stat = await this.fs.lstat(file) } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
        if (!regular(stat, this.uid)) throw fail('profile_download_limit_or_path')
        const previous = row.observedPaths.get(file); if (previous && !same(previous, stat)) throw fail('profile_download_path_changed'); row.observedPaths.set(file, stat)
      }
    } catch { this.#cancel(row); return }
    if (!row.finished && !row.cancelled) { row.observer = setTimeout(() => { row.observerWork = this.#track(() => this.#observe(row)) }, this.observationMs); row.observer.unref?.() }
  }
  async #receive(row) {
    try {
      row.observerWork = this.#track(() => this.#observe(row)); const terminal = await row.terminalWork; clearTimeout(row.observer); clearTimeout(row.deadlineTimer); await row.observerWork
      this.#assertCurrent(); if (terminal !== 'success' || row.cancelled) throw fail('profile_download_failed')
      await this.verifyDirectory(); this.#assertCurrent(); let stat = await this.fs.lstat(row.file); if (!regular(stat, this.uid)) throw fail('profile_download_limit_or_path')
      await this.fs.chmod(row.file, 0o600); this.#assertCurrent(); const secured = await this.fs.lstat(row.file); if (!same(stat, secured) || !regular(secured, this.uid) || (secured.mode & 0o077) !== 0) throw fail('profile_download_limit_or_path')
      row.stat = secured; row.state = 'ready'; row.expiresAt = this.now() + FILE_TTL_MS; row.receipt = Object.freeze({}); receipts.set(row.receipt, row)
      row.expiry = setTimeout(() => { if (row.state === 'ready') this.#track(() => this.#remove(row)) }, FILE_TTL_MS); row.expiry.unref?.()
    } catch { await this.#remove(row) }
    finally { row.finished = true; clearTimeout(row.observer); clearTimeout(row.deadlineTimer); if (!this.#unknown) receiving.delete(row) }
  }
  async #absence(row, terminal) {
    for (;;) {
      await this.verifyDirectory(); let absent = true
      for (const file of [row.file, row.file + '.crdownload']) {
        let stat; try { stat = await this.fs.lstat(file) } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
        const previous = row.observedPaths.get(file)
        if (!ownedFile(stat, this.uid) || previous && !same(previous, stat)) throw fail('profile_download_path_changed')
        row.observedPaths.set(file, stat); absent = false
      }
      await this.verifyDirectory()
      if (this.#unknown || row.cleanupDeadline !== null && performance.now() >= row.cleanupDeadline) throw fail('profile_download_cleanup_unconfirmed')
      if (absent) return
      if (terminal !== 'failed') throw fail('profile_download_cleanup_unconfirmed')
      await new Promise(resolve => setTimeout(resolve, Math.min(this.observationMs, Math.max(1, row.cleanupDeadline - performance.now()))))
    }
  }
  #remove(row) {
    if (row.cleanup) return row.cleanup
    row.cleanup = (async () => {
      clearTimeout(row.observer); clearTimeout(row.deadlineTimer); clearTimeout(row.expiry); receipts.delete(row.receipt); let failed = false, terminal
      try { if (!row.finished) this.#cancel(row); if (row.cancel) await row.cancel; terminal = await row.terminalWork } catch { failed = true }
      try {
        if (terminal !== 'success' && terminal !== 'failed') throw fail('profile_download_terminal_unconfirmed')
        await this.verifyDirectory(); let stat; try { stat = await this.fs.lstat(row.file) } catch (error) { if (error?.code !== 'ENOENT') throw error }
        if (stat && (!ownedFile(stat, this.uid) || row.stat && !same(stat, row.stat))) throw fail('profile_download_path_changed')
        if (terminal === 'success') await row.download.delete()
        await this.#absence(row, terminal)
        row.cleanupConfirmed = true; clearTimeout(row.grace)
      } catch { failed = true }
      if (failed) { void this.#fatal(); throw fail('profile_download_cleanup_unconfirmed') }
      row.state = this.#unknown ? 'cleanup-unknown' : 'removed'; if (!this.#unknown) { this.#records.delete(row); receiving.delete(row); releaseArtifactInventory(row.inventory) }
    })(); void row.cleanup.catch(() => {}); return row.cleanup
  }
  completed() { this.#assertCurrent(); return [...this.#records].filter(row => row.state === 'ready' && row.expiresAt > this.now()).map(row => Object.freeze({ receipt: row.receipt, ...completedDownloadMetadata(row.receipt) })) }
  #copy(row, destination, assertCurrent) {
    return row.copyWork = this.#track(async () => {
      let input, output, buffer = Buffer.alloc(64 * 1024), failed = false
      const check = () => { this.#assertCurrent(); current(assertCurrent) }
      try {
        check(); await this.verifyDirectory(); check(); input = await this.fs.open(row.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); const before = await input.stat(); check()
        if (!same(before, row.stat) || !regular(before, this.uid) || before.size !== row.stat.size || before.mtimeMs !== row.stat.mtimeMs || before.ctimeMs !== row.stat.ctimeMs) throw fail('profile_download_path_changed')
        output = await this.fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); check()
        let offset = 0
        for (;;) { const { bytesRead } = await input.read(buffer, 0, buffer.length, offset); check(); if (!bytesRead) break; if (offset + bytesRead > MAX_FILE_BYTES || offset + bytesRead > before.size) throw fail('profile_download_limit_or_path'); let written = 0; while (written < bytesRead) { const value = await output.write(buffer, written, bytesRead - written); if (!Number.isSafeInteger(value.bytesWritten) || value.bytesWritten < 1) throw fail('profile_download_write_unconfirmed'); written += value.bytesWritten; check() }; buffer.fill(0); offset += bytesRead }
        const after = await input.stat(); check(); if (offset !== before.size || !same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('profile_download_path_changed')
        return { content: [] }
      } finally {
        buffer.fill(0)
        for (const handle of [input, output]) if (handle) try { await handle.close() } catch { failed = true }
        if (failed) this.#unknown = true
        try { await this.#remove(row) } catch { failed = true }
        if (failed) { void this.#fatal(); throw fail('profile_download_cleanup_unconfirmed') }
      }
    })
  }
  assertIdle() { if (this.#closed || this.#unknown || this.#work.size || [...this.#records].some(row => row.state === 'receiving' || row.state === 'copying')) throw fail('profile_download_in_flight'); return true }
  activity() { return Object.freeze({ pendingPhysicalOperations: this.#work.size + (this.#disposePending ? 1 : 0), cleanupUnknown: this.#unknown, retainedDownloads: this.#records.size }) }
  async #drainPending() { while (this.#pending.size) await Promise.allSettled([...this.#pending]) }
  async whenDrained() { await this.#drainPending(); if (this.#disposeWork) await this.#disposeWork.catch(() => {}); await this.#drainPending(); if (this.#unknown) throw fail('profile_download_cleanup_unconfirmed') }
  dispose() {
    if (this.#disposeWork) return this.#disposeWork
    this.#closed = true; this.#disposePending = true
    const task = Promise.resolve().then(() => this.#dispose()); this.#disposeWork = task; void task.finally(() => { this.#disposePending = false }).catch(() => {}); return task
  }
  async #dispose() {
    this.#closed = true; let failed = false
    try { if (this.#listener) this.#context?.removeListener('download', this.#listener) } catch { failed = true }
    const active = [...this.#records].some(row => !row.finished), stop = active ? this.#stopOwned() : Promise.resolve()
    const tasks = [...this.#records].map(row => { clearTimeout(row.observer); clearTimeout(row.deadlineTimer); clearTimeout(row.expiry); return Promise.resolve().then(async () => { if (row.copyWork) await row.copyWork.catch(() => {}); return this.#remove(row) }) })
    const results = await Promise.allSettled([stop, ...tasks, ...this.#work]); if (results[0].status === 'rejected') failed = true
    await this.#drainPending()
    try { await this.verifyDirectory(); await this.fs.rmdir(this.directory) } catch { failed = true }
    if (failed || this.#unknown) { await this.#fatal().catch(() => {}); throw fail('profile_download_cleanup_unconfirmed') }
  }
}
