import * as fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { validatePortableBundle, MAX_BYTES } = require('./browser-profile-core/portable-state.js')
const { exactAuthority, sameAuthority } = require('./browser-profile-core/coordinator-client.js')
const FIELDS = ['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint', 'grantVersion', 'keyEpoch', 'backgroundUse']
const AUTHORITY_FIELDS = ['profileId', 'actingUserId', 'assistantId', 'endpointId', 'bootId', 'runtimeId', 'sessionId', 'writerEpoch', 'revision', 'contentKeyEpoch', 'grantVersion', 'keyFingerprint']
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MAX_FILE = Math.ceil((MAX_BYTES + 28) * 4 / 3) + 4096
const PURPOSE = 'portable-extras-v1'
const fail = code => Object.assign(new Error(code), { code })
const refused = () => fail('profile_extras_refused')
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function sync(callback) {
  const value = callback()
  if (value?.then) { void Promise.resolve(value).catch(() => {}); throw refused() }
  if (value === false) throw refused()
  return value
}
function exact(value, fields) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== fields.length) throw refused()
  for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw refused() }
}
function bindingOf(value) {
  exact(value, FIELDS)
  if (typeof value.profileId !== 'string' || !UUID.test(value.profileId) || typeof value.endpointId !== 'string' || !UUID.test(value.endpointId) || typeof value.actingUserId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.actingUserId) ||
      typeof value.keyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.keyFingerprint) || ['assistantId', 'grantVersion', 'keyEpoch'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1) || value.backgroundUse !== true) throw refused()
  return freeze(Object.fromEntries(FIELDS.map(field => [field, value[field]])))
}
function checkPrivate(io, target, directory = false) {
  const info = io.lstatSync(target)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw refused()
  return info
}
function directoryOf(io, input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 4096 || input.includes('\0')) throw refused()
  const directory = path.resolve(input), parsed = path.parse(directory)
  let current = parsed.root
  for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    try { const info = io.lstatSync(current); if (info.isSymbolicLink() || !info.isDirectory()) throw refused() }
    catch (error) { if (error.code !== 'ENOENT') throw error; io.mkdirSync(current, { mode: 0o700 }) }
  }
  checkPrivate(io, directory, true); return directory
}
const openFlags = (io, flags) => flags | (io.constants.O_NOFOLLOW || 0)
function readRecord(io, file) {
  const before = checkPrivate(io, file)
  if (!before.size || before.size > MAX_FILE) throw refused()
  let fd, bytes
  try {
    fd = io.openSync(file, openFlags(io, io.constants.O_RDONLY)); const opened = io.fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || !opened.isFile()) throw refused()
    bytes = Buffer.alloc(before.size); let read = 0
    while (read < bytes.length) { const count = io.readSync(fd, bytes, read, bytes.length - read, read); if (!count) throw refused(); read += count }
    const after = io.fstatSync(fd), named = io.lstatSync(file)
    if (after.size !== before.size || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) throw refused()
    return parseRecord(bytes)
  } finally { try { if (fd !== undefined) io.closeSync(fd) } finally { bytes?.fill(0) } }
}
function parseRecord(bytes) {
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw refused() }
  exact(value, ['version', 'purpose', 'protector', 'ciphertext'])
  if (value.version !== 1 || value.purpose !== PURPOSE || typeof value.ciphertext !== 'string' || !value.ciphertext.length || value.ciphertext.length > Math.ceil((MAX_BYTES + 28) * 4 / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext)) throw refused()
  const ciphertext = Buffer.from(value.ciphertext, 'base64')
  try { if (ciphertext.length < 28 || ciphertext.length > MAX_BYTES + 28 || ciphertext.toString('base64') !== value.ciphertext) throw refused() } finally { ciphertext.fill(0) }
  return value
}
function decrypt(protector, record, binding) {
  const bytes = Buffer.from(record.ciphertext, 'base64'); let body
  try { body = JSON.parse(protector.decryptString(bytes)) } catch { throw refused() } finally { bytes.fill(0) }
  exact(body, ['version', 'purpose', 'binding', 'bundle'])
  if (body.version !== 1 || body.purpose !== PURPOSE || !same(bindingOf(body.binding), binding)) throw refused()
  return freeze(validatePortableBundle(body.bundle))
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const active = new Set()

// Host only. The OS wrapping key is unlocked asynchronously before runtime
// admission. Runtime callbacks below use synchronous local IO and encryption.
// JavaScript strings cannot be reliably zeroed; secrets are never logged,
// returned to a renderer, or written outside the authenticated ciphertext.
export class BrowserProfilePortableExtrasStore {
  static async preload({ directory: input, binding: raw, pinnedIdentity, keyStore, assertCurrent, createNew = false, io = fs }) {
    const binding = bindingOf(raw)
    if (typeof keyStore?.preloadPortableExtrasProtector !== 'function' || typeof assertCurrent !== 'function' || typeof createNew !== 'boolean' || process.platform === 'win32' && io === fs) throw refused()
    const check = () => sync(assertCurrent)
    check(); const directory = directoryOf(io, input), name = hash(binding), file = path.join(directory, `${name}.json`), lock = `${file}.lease`, pending = `${file}.pending`
    if (active.has(file) || io.existsSync(pending)) throw fail('profile_extras_recovery_required')
    let lockFd, protector, store
    try {
      lockFd = io.openSync(lock, openFlags(io, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL), 0o600); active.add(file)
      io.writeFileSync(lockFd, JSON.stringify({ version: 1, purpose: PURPOSE, instanceId: randomUUID() })); io.fsyncSync(lockFd)
      let record
      if (createNew) { if (io.existsSync(file)) throw refused() }
      else record = readRecord(io, file)
      check(); protector = await keyStore.preloadPortableExtrasProtector({ binding, pinnedIdentity, ...(createNew ? { createNew: true } : { record: record.protector }), assertCurrent: check }); check()
      if (!protector || typeof protector.encryptString !== 'function' || typeof protector.decryptString !== 'function' || typeof protector.dispose !== 'function') throw refused()
      const bundle = createNew ? freeze(validatePortableBundle({ passwordVault: { v: 1, entries: [], neverOrigins: [] }, preferences: { v: 1, searchEngine: 'google' } })) : decrypt(protector, record, binding)
      check(); store = new BrowserProfilePortableExtrasStore({ directory, file, lock, pending, lockFd, protector, binding, check, io, bundle })
      if (createNew) store._publish(bundle)
      check(); return store
    } catch (error) {
      let cleanupFailed = false
      try {
        if (store) store.dispose()
        else { try { protector?.dispose() } finally { try { if (lockFd !== undefined) io.closeSync(lockFd) } finally { if (lockFd !== undefined) { try { io.unlinkSync(lock) } finally { active.delete(file) } } } } }
      } catch { cleanupFailed = true }
      // A renamed record, even with uncertain fsync/readback, retains its key
      // and pending recovery marker. Only a definitely absent initial record
      // permits deletion of this attempt's newly-created OS secret.
      let unpublished = false
      try { io.lstatSync(file) } catch (readError) { if (readError.code === 'ENOENT') unpublished = true }
      if (createNew && protector && unpublished) { try { await protector.discardCreatedRecord() } catch { cleanupFailed = true } }
      if (cleanupFailed) throw fail('profile_extras_cleanup_required')
      throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_manual_unlock_required', 'profile_key_context_changed', 'profile_extras_write_uncertain', 'profile_extras_recovery_required'].includes(error.code) ? error.code : 'profile_extras_refused')
    }
  }
  constructor(options) { Object.assign(this, options); this.closed = false; this.lease = null; this.commitState = 'ready'; this.uncertain = false; this.authority = null }
  _check(raw) {
    if (this.closed || this.uncertain) throw refused()
    this.check(); exact(raw, AUTHORITY_FIELDS); const authority = exactAuthority(raw)
    if (authority.profileId !== this.binding.profileId || authority.actingUserId !== this.binding.actingUserId || authority.assistantId !== this.binding.assistantId || authority.endpointId !== this.binding.endpointId || authority.keyFingerprint !== this.binding.keyFingerprint || authority.grantVersion !== this.binding.grantVersion || authority.contentKeyEpoch !== this.binding.keyEpoch) throw refused()
    if (this.authority && !sameAuthority(authority, this.authority)) throw refused()
    if (!this.authority) this.authority = authority
    return authority
  }
  _syncDirectory() { const fd = this.io.openSync(this.directory, this.io.constants.O_RDONLY); try { this.io.fsyncSync(fd) } finally { this.io.closeSync(fd) } }
  _newFile(target, bytes) {
    let fd
    try { fd = this.io.openSync(target, openFlags(this.io, this.io.constants.O_WRONLY | this.io.constants.O_CREAT | this.io.constants.O_EXCL), 0o600); this.io.writeFileSync(fd, bytes); this.io.fsyncSync(fd) }
    finally { if (fd !== undefined) this.io.closeSync(fd) }
  }
  _publish(raw) {
    const bundle = freeze(validatePortableBundle(raw)); this.check()
    const text = JSON.stringify({ version: 1, purpose: PURPOSE, binding: this.binding, bundle })
    if (Buffer.byteLength(text) > MAX_BYTES) throw refused()
    const encrypted = this.protector.encryptString(text), temporary = `${this.file}.${randomUUID()}.tmp`
    let bytes, pending = false
    try {
      bytes = Buffer.from(JSON.stringify({ version: 1, purpose: PURPOSE, protector: this.protector.record, ciphertext: encrypted.toString('base64') }))
      if (bytes.length > MAX_FILE) throw refused()
      this.check(); this._newFile(this.pending, Buffer.from(JSON.stringify({ version: 1, purpose: PURPOSE, instanceId: randomUUID() }))); pending = true; this._syncDirectory()
      this._newFile(temporary, bytes); this.check(); this.io.renameSync(temporary, this.file); this._syncDirectory()
      const readback = readRecord(this.io, this.file)
      if (!same(readback.protector, this.protector.record) || hash(decrypt(this.protector, readback, this.binding)) !== hash(bundle)) throw refused()
      this.check(); this.io.unlinkSync(this.pending); this._syncDirectory(); this.bundle = bundle
      return Object.freeze({ fileSynced: true, directorySynced: true })
    } catch (error) {
      if (pending) { this.uncertain = true; try { if (!this.io.existsSync(this.pending)) this._newFile(this.pending, Buffer.from('{}')) } catch {}; throw fail('profile_extras_write_uncertain') }
      throw error
    } finally { encrypted.fill(0); bytes?.fill(0); try { this.io.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') this.uncertain = true } }
  }
  preflightExtras({ authority }) { this._check(authority); const bundle = validatePortableBundle(this.bundle); this._check(authority); return bundle }
  captureExtras({ authority }) {
    this._check(authority); if (this.lease) throw refused()
    const lease = {}, bundle = freeze(validatePortableBundle(this.bundle)); this.lease = lease; let released = false
    const assertCurrent = () => { this._check(authority); if (released || this.lease !== lease) throw refused() }
    return Object.freeze({ bundle, assertCurrent, release: () => { if (!released) { released = true; if (this.lease === lease) this.lease = null } } })
  }
  // Only an already-authorized host credential flow may call this local API.
  // The Runtime's capture lease prohibits concurrent mutation through sealing.
  replaceBundle({ authority, bundle }) { this._check(authority); if (this.lease) throw refused(); const durability = this._publish(bundle); this._check(authority); return Object.freeze({ committed: true, durability }) }
  commitExtras({ authority: raw, bundle, receipt, grant }) {
    const authority = this._check(raw)
    if (this.lease || this.commitState !== 'ready' || !sameAuthority(grant, authority) || receipt?.version !== 1 || receipt.kind !== 'destination-staged' || receipt.profileId !== authority.profileId || receipt.revision !== authority.revision || receipt.stagedInactive !== true || !UUID.test(receipt.transitionId) || typeof receipt.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.manifestHash)) throw refused()
    exact(receipt.destination, ['endpointId', 'bootId', 'runtimeId', 'sessionId', 'grantVersion', 'keyFingerprint'])
    if (Object.keys(receipt.destination).some(field => receipt.destination[field] !== authority[field])) throw refused()
    const validated = validatePortableBundle(bundle); this._check(authority); this.commitState = 'uncertain'
    this._publish(validated); this._check(authority); this.commitState = 'committed'; return Object.freeze({ committed: true })
  }
  dispose() {
    if (this.closed) return
    this.closed = true; this.bundle = null; this.authority = null; this.lease = null
    try { this.protector.dispose() } finally { try { this.io.closeSync(this.lockFd) } finally { try { this.io.unlinkSync(this.lock) } finally { active.delete(this.file) } } }
  }
}
