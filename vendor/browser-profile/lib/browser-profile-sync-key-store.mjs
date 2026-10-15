import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'

// Privileged host only. The caller persists only the returned encrypted record.
// A configured Secret Service protects its wrapping key. This cannot attest the
// keyring's disk encryption or protect against its administrator or same user.
// API references: freedesktop Secret Service ReadAlias/Collection.Locked;
// GNOME libsecret secret-tool store reads piped stdin, never a secret argv.
const LIMIT = 8192
const EXTRAS_LIMIT = 16 * 1024 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const HASH = /^[a-f0-9]{64}$/
const BINDING = ['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint', 'grantVersion', 'keyEpoch', 'backgroundUse']
const SERVICE = 'org.freedesktop.secrets'
const INTERFACE = 'org.freedesktop.Secret'
const ROOT = '/org/freedesktop/secrets'
const PREFIX = ['call', '--session', '--dest', SERVICE, '--object-path']
const fail = code => Object.assign(new Error(code), { code })
const helperPresent = path => { try { accessSync(path, constants.X_OK); return true } catch { return false } }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('profile_key_refused')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) throw fail('profile_key_refused')
}
function bindingOf(value) {
  exact(value, BINDING)
  if (typeof value.profileId !== 'string' || !UUID.test(value.profileId) || typeof value.endpointId !== 'string' || !UUID.test(value.endpointId) || typeof value.actingUserId !== 'string' || !ID.test(value.actingUserId) ||
      !['assistantId', 'grantVersion', 'keyEpoch'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0) || typeof value.keyFingerprint !== 'string' || !HASH.test(value.keyFingerprint)) throw fail('profile_key_refused')
  if (value.backgroundUse !== true) throw fail('profile_key_background_grant_required')
  return Object.freeze(Object.fromEntries(BINDING.map(key => [key, value[key]])))
}
const scopeOf = binding => createHash('sha256').update(JSON.stringify(binding)).digest('hex')
const attributes = (binding, recordId) => ['application', 'hoai-browser-profile-sync-v1', 'scope', scopeOf(binding), 'record', recordId]
const extrasAttributes = (binding, recordId) => ['application', 'hoai-browser-portable-extras-v1', 'scope', scopeOf(binding), 'record', recordId]

// Do not merge this result into the host or Chromium environment. This Unix
// bus is a private key-service capability. No PATH, loader, SSH, token, display
// or caller supplied command options are inherited by these fixed helpers.
export function keyHelperEnvironment(environment = {}) {
  const address = environment.DBUS_SESSION_BUS_ADDRESS
  if (typeof address !== 'string' || address.length > 2048 || !/^unix:(?:path|abstract)=[A-Za-z0-9_./%+-]+(?:,guid=[a-fA-F0-9]{32})?$/.test(address)) throw fail('profile_key_setup_required')
  return Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', DBUS_SESSION_BUS_ADDRESS: address })
}

// Bounded asynchronous subprocesses. Neither helper output nor native error
// text escapes this module. In particular secret-tool stdout is secret data.
/**
 * @param {string} executable
 * @param {string[]} args
 * @param {{environment?:Record<string,string>,input?:Buffer,timeoutMs?:number,maxBytes?:number,signal?:AbortSignal}} [options]
 * @returns {Promise<{code:number|null,output:Buffer}>}
 */
export function runKeyHelper(executable, args, { environment, input = Buffer.alloc(0), timeoutMs = 3000, maxBytes = LIMIT, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, outcome = null, size = 0
    const chunks = []
    const discard = () => { for (const chunk of chunks.splice(0)) chunk.fill(0) }
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel)
      if (error) { discard(); reject(error) } else resolve(result)
    }
    const stop = code => {
      if (settled || outcome) return
      outcome = fail(code); clearTimeout(timer); signal?.removeEventListener('abort', cancel); discard()
      // A stop request is not physical completion. Keep this same promise
      // pending until the original ChildProcess and its pipes close.
      try { if (Number.isSafeInteger(child?.pid) && child.pid > 0) child.kill('SIGKILL') } catch {}
    }
    const cancel = () => stop('profile_key_context_changed')
    if (signal?.aborted) return finish(fail('profile_key_context_changed'))
    try { child = spawn(executable, args, { shell: false, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) }
    catch { return finish(fail('profile_key_setup_required')) }
    child.once('error', () => stop('profile_key_setup_required'))
    child.once('close', code => {
      if (settled) { discard(); return }
      if (outcome) { finish(outcome); return }
      const output = Buffer.concat(chunks)
      discard(); finish(null, { code, output })
    })
    if (!child.stdout?.on || !child.stderr?.on || !child.stdin?.on || !child.stdin?.end) {
      stop('profile_key_setup_required'); return
    }
    child.stdout.on('data', chunk => {
      if (settled || outcome) { chunk.fill(0); return }
      size += chunk.length
      if (size > maxBytes) { chunk.fill(0); stop('profile_key_refused'); return }
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => chunk.fill(0))
    child.stdin.on('error', () => {})
    signal?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => stop('profile_key_unlock_required'), timeoutMs)
    if (signal?.aborted) cancel()
    try { child.stdin.end(outcome ? undefined : input) } catch { stop('profile_key_setup_required') }
  })
}

function cipherAdapter(key, binding, recordId, { extras = false } = {}) {
  const limit = extras ? EXTRAS_LIMIT : LIMIT
  const aad = Buffer.from(`${extras ? 'HOAI-PORTABLE-EXTRAS-v1' : 'HOAI-PROFILE-KEY-v1'}\0${JSON.stringify(binding)}\0${recordId}`)
  return {
    isEncryptionAvailable: () => true,
    // Adapter tag for the verified libsecret path, not Electron availability.
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(text) {
      if (extras && (typeof text !== 'string' || Buffer.byteLength(text) > limit)) throw fail('profile_key_refused')
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(aad)
      return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decryptString(bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 28 || bytes.length > limit + (extras ? 28 : 0)) throw fail('profile_key_refused')
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(-16))
      let update, final, plaintext
      try {
        update = cipher.update(bytes.subarray(12, -16)); final = cipher.final()
        plaintext = Buffer.concat([update, final])
        return plaintext.toString('utf8')
      } finally { update?.fill(0); final?.fill(0); plaintext?.fill(0) }
    },
  }
}

export class BrowserProfileSyncKeyStore {
  constructor({ endpointCrypto, environment = {}, platform = process.platform, run = runKeyHelper, hasHelper = helperPresent, timeoutMs = 3000 }) {
    if (!endpointCrypto || ['identityFingerprint', 'protectEndpointKeys', 'restoreEndpointKeys'].some(name => typeof endpointCrypto[name] !== 'function') || typeof run !== 'function' || typeof hasHelper !== 'function') throw new TypeError('profile_key_dependencies_required')
    Object.assign(this, { endpointCrypto, platform, run, hasHelper })
    this.environment = Object.freeze({ DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS })
    this.timeoutMs = Math.max(1, Math.min(10000, timeoutMs))
  }
  async _authority(assertCurrent) {
    if (typeof assertCurrent !== 'function') throw fail('profile_key_context_changed')
    try { if (await assertCurrent() === false) throw fail('profile_key_context_changed') } catch { throw fail('profile_key_context_changed') }
  }
  async _call(executable, args, assertCurrent, input = Buffer.alloc(0), signal) {
    await this._authority(assertCurrent)
    let result
    try { result = await this.run(executable, args, { environment: keyHelperEnvironment(this.environment), input, timeoutMs: this.timeoutMs, maxBytes: LIMIT, signal }) }
    catch (error) { throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_context_changed', 'profile_key_refused'].includes(error.code) ? error.code : 'profile_key_setup_required') }
    if (!result || !Buffer.isBuffer(result.output) || result.output.length > LIMIT || !(result.code === null || Number.isInteger(result.code))) { result?.output?.fill?.(0); throw fail('profile_key_refused') }
    try { await this._authority(assertCurrent); return result } catch (error) { result?.output?.fill(0); throw error }
  }
  async _ready(assertCurrent, signal) {
    if (this.platform !== 'linux') throw fail('profile_key_manual_unlock_required')
    if (!this.hasHelper('/usr/bin/gdbus') || !this.hasHelper('/usr/bin/secret-tool')) throw fail('profile_key_setup_required')
    const alias = await this._call('/usr/bin/gdbus', [...PREFIX, ROOT, '--method', `${INTERFACE}.Service.ReadAlias`, 'default'], assertCurrent, undefined, signal)
    let collection
    try {
      if (alias.code !== 0) throw fail('profile_key_setup_required')
      const match = /^\(objectpath '(\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+)',\)\s*$/.exec(alias.output.toString('utf8'))
      if (!match || match[1] === `${ROOT}/collection/session`) throw fail('profile_key_setup_required')
      collection = match[1]
    } finally { alias.output.fill(0) }
    const locked = await this._call('/usr/bin/gdbus', [...PREFIX, collection, '--method', 'org.freedesktop.DBus.Properties.Get', `${INTERFACE}.Collection`, 'Locked'], assertCurrent, undefined, signal)
    try {
      if (locked.code !== 0) throw fail('profile_key_setup_required')
      if (/^\(<true>,\)\s*$/.test(locked.output.toString('utf8'))) throw fail('profile_key_unlock_required')
      if (!/^\(<false>,\)\s*$/.test(locked.output.toString('utf8'))) throw fail('profile_key_setup_required')
    } finally { locked.output.fill(0) }
    return collection
  }
  /** @param {{binding:any,assertCurrent:()=>unknown,signal?:AbortSignal}} options */
  async status({ binding, assertCurrent, signal }) {
    try { bindingOf(binding); await this._ready(assertCurrent, signal); return { state: 'ready', provider: 'libsecret-v1' } }
    catch (error) {
      const states = { profile_key_setup_required: 'setup_required', profile_key_unlock_required: 'unlock_required', profile_key_manual_unlock_required: 'manual_unlock_required', profile_key_background_grant_required: 'background_grant_required' }
      return { state: states[error.code] || 'refused', reason: states[error.code] ? error.code : 'profile_key_refused' }
    }
  }
  /** @param {{binding:any,endpoint:any,assertCurrent:()=>unknown,signal?:AbortSignal}} options */
  async protect({ binding: raw, endpoint, assertCurrent, signal }) {
    const binding = bindingOf(raw), recordId = randomUUID(), key = randomBytes(32)
    let attempted = false
    try {
      if (endpoint?.identity?.endpointId !== binding.endpointId || this.endpointCrypto.identityFingerprint(endpoint.identity) !== binding.keyFingerprint) throw fail('profile_key_refused')
      const collection = await this._ready(assertCurrent, signal)
      const keys = this.endpointCrypto.protectEndpointKeys({ endpoint, safeStorage: cipherAdapter(key, binding, recordId), platform: 'linux' })
      const record = { version: 1, provider: 'libsecret-v1', recordId, binding, keys }
      this._record(record, binding)
      const input = Buffer.from(key.toString('base64url'))
      try {
        attempted = true
        const result = await this._call('/usr/bin/secret-tool', ['store', '--label=HOAI browser endpoint key', `--collection=${collection}`, ...attributes(binding, recordId)], assertCurrent, input, signal)
        try { if (result.code !== 0) throw fail('profile_key_unlock_required') } finally { result.output.fill(0) }
      } finally { input.fill(0) }
      return record
    } catch (error) {
      // Only this newly generated record id is eligible for failed-write cleanup.
      if (attempted) await this.run('/usr/bin/secret-tool', ['clear', ...attributes(binding, recordId)], { environment: keyHelperEnvironment(this.environment), timeoutMs: this.timeoutMs, maxBytes: LIMIT }).then(value => value.output.fill(0), () => {})
      throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_manual_unlock_required', 'profile_key_context_changed'].includes(error.code) ? error.code : 'profile_key_refused')
    } finally { key.fill(0) }
  }
  _record(record, binding) {
    exact(record, ['version', 'provider', 'recordId', 'binding', 'keys'])
    exact(record.keys, ['version', 'identityFingerprint', 'ciphertext'])
    if (record.version !== 1 || record.provider !== 'libsecret-v1' || typeof record.recordId !== 'string' || !UUID.test(record.recordId) || JSON.stringify(bindingOf(record.binding)) !== JSON.stringify(binding) ||
        record.keys.version !== 1 || record.keys.identityFingerprint !== binding.keyFingerprint || typeof record.keys.ciphertext !== 'string' || !record.keys.ciphertext.length || record.keys.ciphertext.length > Math.ceil(LIMIT * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(record.keys.ciphertext)) throw fail('profile_key_refused')
  }
  /** @param {{record:any,binding:any,pinnedIdentity:any,assertCurrent:()=>unknown,signal?:AbortSignal}} options */
  async restore({ record, binding: raw, pinnedIdentity, assertCurrent, signal }) {
    const binding = bindingOf(raw)
    this._record(record, binding)
    if (pinnedIdentity?.endpointId !== binding.endpointId || this.endpointCrypto.identityFingerprint(pinnedIdentity) !== binding.keyFingerprint) throw fail('profile_key_refused')
    await this._ready(assertCurrent, signal)
    const result = await this._call('/usr/bin/secret-tool', ['lookup', ...attributes(binding, record.recordId)], assertCurrent, undefined, signal)
    let key
    try {
      if (result.code !== 0) { await this._ready(assertCurrent, signal); throw fail('profile_key_setup_required') }
      const value = result.output.toString('utf8')
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw fail('profile_key_refused')
      key = Buffer.from(value, 'base64url')
      if (key.length !== 32 || key.toString('base64url') !== value) throw fail('profile_key_refused')
      const endpoint = this.endpointCrypto.restoreEndpointKeys({ record: record.keys, pinnedIdentity, safeStorage: cipherAdapter(key, binding, record.recordId), platform: 'linux' })
      await this._authority(assertCurrent)
      return endpoint
    } catch (error) { throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_context_changed'].includes(error.code) ? error.code : 'profile_key_refused') }
    finally { key?.fill(0); result.output.fill(0) }
  }
  /** @param {{record:any,binding:any,assertRevoked:()=>unknown,signal?:AbortSignal}} options */
  async remove({ record, binding: raw, assertRevoked, signal }) {
    const binding = bindingOf(raw)
    this._record(record, binding)
    await this._ready(assertRevoked, signal)
    const result = await this._call('/usr/bin/secret-tool', ['clear', ...attributes(binding, record.recordId)], assertRevoked, undefined, signal)
    try { if (result.code !== 0) throw fail('profile_key_unlock_required'); return { removed: true } }
    finally { result.output.fill(0) }
  }

  // Async OS unlock is completed before a browser runtime is admitted. The
  // returned cryptographic capability is private host memory and can never
  // grant runtime authority. Saved counters are accepted only if exactly equal
  // to a separately verified current binding. No prior-epoch fallback exists.
  /** @param {{binding:any,pinnedIdentity:any,record?:any,createNew?:boolean,assertCurrent:()=>unknown,signal?:AbortSignal}} options */
  async preloadPortableExtrasProtector({ binding: raw, pinnedIdentity, record, createNew = false, assertCurrent, signal }) {
    const binding = bindingOf(raw)
    if (pinnedIdentity?.endpointId !== binding.endpointId || this.endpointCrypto.identityFingerprint(pinnedIdentity) !== binding.keyFingerprint ||
        typeof createNew !== 'boolean' || (createNew ? record !== undefined : record === undefined)) throw fail('profile_key_refused')
    if (!createNew) {
      exact(record, ['version', 'provider', 'purpose', 'recordId', 'binding'])
      if (record.version !== 1 || record.provider !== 'libsecret-v1' || record.purpose !== 'portable-extras-v1' || typeof record.recordId !== 'string' || !UUID.test(record.recordId) || JSON.stringify(bindingOf(record.binding)) !== JSON.stringify(binding)) throw fail('profile_key_refused')
    }
    const recordId = createNew ? randomUUID() : record.recordId
    const metadata = Object.freeze({ version: 1, provider: 'libsecret-v1', purpose: 'portable-extras-v1', recordId, binding })
    let key, attempted = false, transferred = false
    const current = () => {
      if (signal?.aborted || typeof assertCurrent !== 'function') throw fail('profile_key_context_changed')
      const value = assertCurrent()
      if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_key_context_changed') }
      if (value === false) throw fail('profile_key_context_changed')
    }
    try {
      current(); const collection = await this._ready(assertCurrent, signal); current()
      if (createNew) {
        key = randomBytes(32); const input = Buffer.from(key.toString('base64url'))
        try {
          attempted = true
          const result = await this._call('/usr/bin/secret-tool', ['store', '--label=HOAI browser portable extras', `--collection=${collection}`, ...extrasAttributes(binding, recordId)], assertCurrent, input, signal)
          try { if (result.code !== 0) throw fail('profile_key_unlock_required') } finally { result.output.fill(0) }
        } finally { input.fill(0) }
      } else {
        const result = await this._call('/usr/bin/secret-tool', ['lookup', ...extrasAttributes(binding, recordId)], assertCurrent, undefined, signal)
        try {
          if (result.code !== 0) { await this._ready(assertCurrent, signal); throw fail('profile_key_setup_required') }
          const value = result.output.toString('utf8')
          if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw fail('profile_key_refused')
          key = Buffer.from(value, 'base64url')
          if (key.length !== 32 || key.toString('base64url') !== value) throw fail('profile_key_refused')
        } finally { result.output.fill(0) }
      }
      current(); const adapter = cipherAdapter(key, binding, recordId, { extras: true }); let disposed = false
      const check = () => { if (disposed) throw fail('profile_key_context_changed'); current() }
      const protector = Object.freeze({ record: metadata,
        encryptString: text => { check(); const bytes = adapter.encryptString(text); try { check(); return bytes } catch (error) { bytes.fill(0); throw error } },
        decryptString: bytes => { check(); const text = adapter.decryptString(bytes); check(); return text },
        dispose: () => { disposed = true; key.fill(0) },
        // Only the host's failed explicit create path uses this capability.
        // Disposal is mandatory first. Its immutable exact record attributes
        // cannot delete an older endpoint key or another profile's record.
        discardCreatedRecord: async () => {
          if (!createNew || !disposed) throw fail('profile_key_refused')
          let result
          try {
            result = await this.run('/usr/bin/secret-tool', ['clear', ...extrasAttributes(binding, recordId)], { environment: keyHelperEnvironment(this.environment), timeoutMs: this.timeoutMs, maxBytes: LIMIT })
            if (!result || !Buffer.isBuffer(result.output) || result.output.length > LIMIT || result.code !== 0) throw fail('profile_key_cleanup_required')
            return Object.freeze({ removed: true })
          } catch { throw fail('profile_key_cleanup_required') } finally { result?.output?.fill?.(0) }
        },
      })
      transferred = true; return protector
    } catch (error) {
      key?.fill(0)
      if (attempted) await this.run('/usr/bin/secret-tool', ['clear', ...extrasAttributes(binding, recordId)], { environment: keyHelperEnvironment(this.environment), timeoutMs: this.timeoutMs, maxBytes: LIMIT }).then(value => value.output.fill(0), () => {})
      throw fail(['profile_key_setup_required', 'profile_key_unlock_required', 'profile_key_manual_unlock_required', 'profile_key_context_changed'].includes(error.code) ? error.code : 'profile_key_refused')
    } finally { if (!transferred) key?.fill(0) }
  }
}
