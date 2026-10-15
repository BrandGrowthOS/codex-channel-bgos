import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url), files = require('./browser-profile-core/profile-file-crypto.js')
const fail = code => Object.assign(new Error(code), { code }), globalRecords = new Set(), physical = new Set()
const same = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino
const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= files.MAX_FILE_BYTES
const current = callback => { const value = callback(); if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_file_context_changed') }; if (value === false) throw fail('profile_file_context_changed') }
/** Only successful original engine writes into owned generated directories can
 * mint an artifact token. Tool text and caller paths are never inventory. */
export class AgentProfileArtifacts {
  #records = new Map(); #work = new Set(); #closed = false; #unknown = false
  constructor({ area, staging, now = Date.now, filesystem = fs }) {
    if (!area || typeof area.assertPrivateDirectory !== 'function' || typeof staging?.readSelected !== 'function' || typeof now !== 'function') throw fail('profile_file_configuration_invalid')
    Object.assign(this, { area, staging, now, fs: filesystem })
  }
  #check(check) { if (this.#closed || this.#unknown) throw fail('profile_file_artifact_unavailable'); current(check) }
  #run(check, work) {
    this.#check(check); if (physical.size >= 2) return Promise.reject(fail('profile_file_io_capacity'))
    const lease = {}; physical.add(lease); const task = Promise.resolve().then(work).finally(() => { if (!this.#unknown) { physical.delete(lease); this.#work.delete(task) } }); this.#work.add(task); void task.catch(() => {}); return task
  }
  async #remove(record) {
    let failed = false
    try {
      await this.area.assertPrivateDirectory(record.directory); const parent = await this.fs.lstat(record.directory)
      if (!same(parent, record.directoryStat) || !parent.isDirectory() || parent.isSymbolicLink()) throw fail('profile_file_path_changed')
      let named; try { named = await this.fs.lstat(record.file) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      if (named) { if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || record.stat && !same(named, record.stat)) throw fail('profile_file_path_changed'); await this.fs.unlink(record.file) }
    } catch { failed = true }
    try { const parent = await this.fs.lstat(record.directory); if (!same(parent, record.directoryStat) || !parent.isDirectory() || parent.isSymbolicLink()) throw fail('profile_file_path_changed'); await this.fs.rmdir(record.directory) } catch { failed = true }
    if (failed) { this.#unknown = true; throw fail('profile_file_cleanup_unconfirmed') }
    this.#records.delete(record.token); globalRecords.delete(record)
  }
  async capture({ name, args, assertCurrent, execute }) {
    if (!['browser_take_screenshot', 'browser_pdf_save'].includes(name) || typeof execute !== 'function') throw fail('profile_file_artifact_required')
    const input = structuredClone(args), extension = name === 'browser_pdf_save' ? 'pdf' : input.type === 'jpeg' || input.type === undefined && /\.jpe?g$/i.test(input.filename || '') ? 'jpeg' : 'png', fileName = input.filename === undefined ? 'browser.' + extension : files.validateFileName(input.filename)
    return this.#run(assertCurrent, async () => {
      this.#check(assertCurrent)
      for (const row of [...this.#records.values()]) if (row.state === 'ready' && row.expiresAt <= this.now()) await this.#remove(row)
      this.#check(assertCurrent); if (this.#records.size >= 4 || globalRecords.size >= 16) throw fail('profile_file_artifact_capacity')
      await this.area.assertPrivateDirectory(this.area.directory); this.#check(assertCurrent)
      const directory = path.join(this.area.directory, randomUUID()); await this.fs.mkdir(directory, { mode: 0o700 })
      let directoryStat
      try { directoryStat = await this.fs.lstat(directory) } catch (error) { this.#unknown = true; throw error }
      const record = { token: 'hoai-artifact:' + randomUUID(), directory, directoryStat, file: path.join(directory, fileName), fileName, contentType: extension === 'pdf' ? 'application/pdf' : 'image/' + extension, stat: null, state: 'creating', expiresAt: this.now() + files.FILE_TTL_MS }
      this.#records.set(record.token, record); globalRecords.add(record)
      try {
        this.#check(assertCurrent); await this.area.assertPrivateDirectory(directory); this.#check(assertCurrent)
        const result = await execute(name, { ...input, filename: record.file }); this.#check(assertCurrent)
        if (!result || result.isError || !Array.isArray(result.content)) throw fail('profile_file_artifact_unconfirmed')
        const stat = await this.fs.lstat(record.file); this.#check(assertCurrent); await this.area.assertPrivateDirectory(directory); this.#check(assertCurrent)
        record.stat = stat; if (!regular(stat) || globalRecords.size > 16 || [...globalRecords].reduce((sum, row) => sum + (row.stat?.size || 0), 0) > 400 * 1024 * 1024) throw fail('profile_file_artifact_refused')
        record.stat = stat; record.state = 'ready'
        return { ...result, content: [...result.content.filter(item => item.type === 'image'), { type: 'text', text: JSON.stringify({ artifactToken: record.token, fileName, bytes: stat.size, expiresAt: record.expiresAt }) }] }
      } catch (error) { await this.#remove(record); throw error }
    })
  }
  consume(token, { assertCurrent, use }) {
    this.#check(assertCurrent); const record = this.#records.get(token)
    if (!record || record.state !== 'ready' || record.expiresAt <= this.now() || typeof use !== 'function') return Promise.reject(fail('profile_file_artifact_required'))
    return this.#run(assertCurrent, async () => {
      this.#check(assertCurrent); if (record.state !== 'ready' || record.expiresAt <= this.now()) throw fail('profile_file_artifact_required'); record.state = 'spent'
      let selected
      try {
        this.#check(assertCurrent); await this.area.assertPrivateDirectory(record.directory); this.#check(assertCurrent)
        const stat = await this.fs.lstat(record.file); this.#check(assertCurrent); if (!same(stat, record.stat) || !regular(stat) || stat.size !== record.stat.size || stat.mtimeMs !== record.stat.mtimeMs || stat.ctimeMs !== record.stat.ctimeMs) throw fail('profile_file_path_changed')
        selected = await this.staging.readSelected({ selectedPath: record.file, assertCurrent: () => this.#check(assertCurrent) }); this.#check(assertCurrent)
        return await use(selected.bytes, record.fileName, record.contentType)
      } finally { selected?.bytes.fill(0); await this.#remove(record) }
    })
  }
  activity() { return Object.freeze({ pendingPhysicalOperations: this.#work.size, cleanupUnknown: this.#unknown }) }
  async whenDrained() { await Promise.allSettled([...this.#work]); if (this.#unknown) throw fail('profile_file_cleanup_unconfirmed') }
  async dispose() { this.#closed = true; await Promise.allSettled([...this.#work]); for (const record of [...this.#records.values()]) { try { await this.#remove(record) } catch { this.#unknown = true } }; if (this.#unknown) throw fail('profile_file_cleanup_unconfirmed') }
}
