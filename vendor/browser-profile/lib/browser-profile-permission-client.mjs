import { createRequire } from 'node:module'
import { createHash, createPublicKey, KeyObject, randomBytes, randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const shared = require('./browser-profile-core/coordinator-client.js')
const codec = require('./browser-profile-core/crypto.js')
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, NONCE = /^[A-Za-z0-9_-]{43}$/
const LABELS = Object.freeze({ navigate: 'Open a website', write: 'Change a page selection', sensitive: 'Perform a page action', upload: 'Upload a file', download: 'Save a page as PDF' })
const METHODS = Object.freeze({ browser_navigate: 'navigate', browser_click: 'sensitive', browser_handle_dialog: 'sensitive', browser_select_option: 'write', browser_file_upload: 'upload', browser_pdf_save: 'download' })
const SCOPE = ['gateId', 'requestNonce', 'authority', 'bindingId', 'socketId', 'rpcId', 'rpcNonce', 'actionHash']
const REQUEST = [...SCOPE, 'kind', 'origin', 'expiresAt']
const PUBLIC = [...REQUEST, 'originSource', 'label', 'state', 'choice']
const fail = code => Object.assign(new Error(code), { code })
function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length || fields.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key); return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
  })) throw fail('profile_permission_invalid')
  return value
}
function synchronous(callback) { let result; try { result = callback() } catch { throw fail('profile_permission_context_changed') }; if (result?.then) { void Promise.resolve(result).catch(() => {}); throw fail('profile_permission_context_changed') }; if (result === false) throw fail('profile_permission_context_changed') }
function originOf(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail('profile_permission_invalid')
  let url; try { url = new URL(value) } catch { throw fail('profile_permission_invalid') }
  if (url.origin !== value || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw fail('profile_permission_invalid')
  return value
}
function endpointOf(endpoint, authority) {
  const identity = Object.freeze({ ...endpoint?.identity }), key = endpoint?.signingPrivateKey
  if (identity.endpointId !== authority.endpointId || codec.identityFingerprint(identity) !== authority.keyFingerprint || !(key instanceof KeyObject) || key.type !== 'private' || key.asymmetricKeyType !== 'ed25519' ||
      createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url') !== identity.signingPublicKey) throw fail('profile_permission_endpoint_changed')
  return Object.freeze({ identity, signingPrivateKey: key })
}
function readStatus(raw, record, query, consumed) {
  let authority
  try {
    exact(raw, [...PUBLIC, ...(query ? ['readNonce', 'readExpiresAt'] : []), ...(consumed ? ['consumed'] : [])])
    exact(raw.authority, Object.keys(record.request.authority)); authority = shared.exactAuthority(raw.authority)
  } catch { throw fail('profile_permission_response_invalid') }
  if (!shared.sameAuthority(authority, record.request.authority) || !REQUEST.every(key => key === 'authority' || raw[key] === record.request[key]) || raw.label !== LABELS[record.request.kind] || raw.originSource !== (record.request.kind === 'navigate' ? 'request-url' : 'agent-reported') ||
      !['pending', 'answered', 'consumed', 'expired'].includes(raw.state) || ![null, 'allow_once', 'deny'].includes(raw.choice) ||
      raw.state === 'pending' && raw.choice !== null || ['answered', 'consumed'].includes(raw.state) && raw.choice === null || raw.state === 'consumed' && raw.choice !== 'allow_once' ||
      query && (raw.readNonce !== query.readNonce || raw.readExpiresAt !== query.readExpiresAt) || consumed && (raw.consumed !== true || raw.state !== 'consumed' || raw.choice !== 'allow_once') ||
      record.status?.choice != null && raw.choice !== record.status.choice) throw fail('profile_permission_response_invalid')
  record.status = Object.freeze({ state: raw.state, choice: raw.choice }); return record.status
}

// Paired endpoint only. A native human answer is trusted through HOAI, then
// consumed once for the exact still-physical original RPC. No site grant is kept.
export class AgentRuntimePermissionClient {
  #pending = null
  #cleanupUnconfirmed = false
  #records = new Map()
  #handles = new WeakMap()
  /** @param {any} options */
  constructor({ origin, authorizePairing, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000 }) {
    let url; try { url = new URL(origin) } catch { throw fail('profile_permission_configuration_invalid') }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) ||
        [authorizePairing, fetchImpl, now].some(value => typeof value !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('profile_permission_configuration_invalid')
    Object.defineProperties(this, { origin: { value: url.origin }, authorizePairing: { value: authorizePairing }, fetchImpl: { value: fetchImpl }, now: { value: now }, timeoutMs: { value: timeoutMs } })
  }
  #check(record) {
    const now = this.now(); synchronous(record.current)
    if (!Number.isSafeInteger(now) || now < record.started || now >= record.request.expiresAt || record.signal.aborted || this.#records.get(record.request.gateId) !== record) throw fail('profile_permission_context_changed')
  }
  async #http(record, route, body, mutating) {
    if (this.#pending) throw fail('profile_permission_busy')
    this.#check(record)
    const controller = new AbortController(), abort = () => controller.abort(), chunks = []; let timer, reader, responseBody, dispatched = false, expired = false
    record.signal.addEventListener('abort', abort, { once: true })
    const check = () => { this.#check(record); if (expired || controller.signal.aborted) throw fail(dispatched && mutating ? 'profile_permission_outcome_unknown' : 'profile_permission_unavailable') }
    const work = Promise.resolve().then(async () => {
      try {
        check(); const proof = await this.authorizePairing(Object.freeze({ purpose: 'endpoint', actingUserId: record.request.authority.actingUserId, assistantId: record.request.authority.assistantId })); check()
        if (!proof || !Number.isSafeInteger(proof.pairingId) || proof.pairingId < 1 || typeof proof.ownerUserId !== 'string' || !ID.test(proof.ownerUserId) || proof.assistantId !== record.request.authority.assistantId || typeof proof.token !== 'string' || !proof.token || proof.token.length > 16384 || /\s/.test(proof.token) || typeof proof.assertCurrent !== 'function') throw fail('profile_permission_pairing_required')
        const snapshot = Object.freeze({ pairingId: proof.pairingId, ownerUserId: proof.ownerUserId, assistantId: proof.assistantId, token: proof.token }), current = proof.assertCurrent
        const admitted = () => { check(); if (Object.keys(snapshot).some(key => snapshot[key] !== proof[key]) || proof.assertCurrent !== current) throw fail('profile_permission_context_changed'); synchronous(() => current.call(proof)) }
        const bytes = JSON.stringify(body); if (Buffer.byteLength(bytes) > 65536) throw fail('profile_permission_invalid')
        admitted(); dispatched = true
        const response = await this.fetchImpl(new URL('/api/v1/browser/profile-sync/runtime/permissions/' + route, this.origin).href, {
          method: 'POST', headers: { 'X-BGOS-Pairing': snapshot.token, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' },
          body: bytes, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal })
        // Own the late response before rechecking cancellation or authority.
        // Even a refused response must retain its slot until its body drains.
        responseBody = response?.body; if (typeof responseBody?.getReader === 'function') reader = responseBody.getReader()
        admitted(); if (!response || !Number.isInteger(response.status) || response.redirected || !reader) throw fail('profile_permission_response_invalid')
        let length = 0
        for (;;) { const { value, done } = await reader.read(); admitted(); if (done) break; if (!(value instanceof Uint8Array) || (length += value.byteLength) > 65536) throw fail('profile_permission_response_invalid'); chunks.push(Buffer.from(value)) }
        admitted(); let result; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw fail('profile_permission_response_invalid') }
        if (response.status < 200 || response.status >= 300) throw fail(response.status >= 500 && mutating ? 'profile_permission_outcome_unknown' : 'profile_permission_refused')
        return result
      } finally {
        try {
          try { if (reader) await reader.cancel(); else if (responseBody) { if (typeof responseBody.cancel !== 'function') throw fail('profile_permission_cleanup_unconfirmed'); await responseBody.cancel() } }
          catch { this.#cleanupUnconfirmed = true; throw fail('profile_permission_cleanup_unconfirmed') }
        } finally {
          try { reader?.releaseLock() } catch { this.#cleanupUnconfirmed = true; throw fail('profile_permission_cleanup_unconfirmed') }
          finally { for (const chunk of chunks) chunk.fill(0); record.signal.removeEventListener('abort', abort) }
        }
      }
    }).catch(error => { if (typeof error?.code === 'string' && /^profile_permission_[a-z_]+$/.test(error.code)) throw error; throw fail(dispatched && mutating ? 'profile_permission_outcome_unknown' : 'profile_permission_unavailable') })
    this.#pending = work
    void work.finally(() => { if (this.#pending === work && !this.#cleanupUnconfirmed) this.#pending = null }).catch(() => {})
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(fail(dispatched && mutating ? 'profile_permission_outcome_unknown' : 'profile_permission_unavailable')) }, this.timeoutMs) })]) }
    finally { clearTimeout(timer); controller.abort() }
  }
  async request({ frame, binding, endpoint, origin, assertCurrent, signal }) {
    if (this.#pending) throw fail('profile_permission_busy')
    if (typeof assertCurrent !== 'function' || typeof signal?.addEventListener !== 'function' || signal.aborted) throw fail('profile_permission_context_changed')
    const current = assertCurrent.bind(undefined); synchronous(current)
    exact(frame, ['event_type', 'version', 'rpcId', 'rpcNonce', 'bindingId', 'authority', 'clientId', 'assistantId', 'message', 'deadlineAt'])
    const authority = shared.exactAuthority(frame.authority), identity = endpointOf(endpoint, authority)
    if (frame.event_type !== 'browser_profile_rpc' || frame.version !== 1 || !UUID.test(frame.rpcId) || !NONCE.test(frame.rpcNonce) || !UUID.test(binding?.bindingId) || frame.bindingId !== binding.bindingId || typeof binding.socketId !== 'string' || !ID.test(binding.socketId) || !shared.sameAuthority(binding.authority, authority) || frame.assistantId !== authority.assistantId || frame.message?.method !== 'tools/call') throw fail('profile_permission_invalid')
    const name = frame.message.params?.name
    if (typeof name !== 'string' || !Object.hasOwn(METHODS, name)) throw fail('profile_permission_handover_required')
    const kind = METHODS[name], canonicalOrigin = originOf(origin), started = this.now(), deadline = Date.parse(frame.deadlineAt)
    if (!Number.isSafeInteger(started) || started < 0 || typeof frame.deadlineAt !== 'string' || !Number.isSafeInteger(deadline) || deadline <= started || shared.canonical(frame.message).length > 256 * 1024) throw fail('profile_permission_invalid')
    if (kind === 'navigate') { let url; try { url = new URL(frame.message.params.arguments?.url) } catch { throw fail('profile_permission_invalid') }; if (url.username || url.password || url.origin !== canonicalOrigin) throw fail('profile_permission_invalid') }
    for (const [id, record] of this.#records) if (record.request.expiresAt + 60000 <= started) this.#records.delete(id)
    if ([...this.#records.values()].some(record => record.request.rpcId === frame.rpcId && shared.sameAuthority(record.request.authority, authority))) throw fail('profile_permission_duplicate')
    if (this.#records.size >= 64) throw fail('profile_permission_capacity')
    const request = Object.freeze({ gateId: randomUUID(), requestNonce: randomBytes(32).toString('base64url'), authority, bindingId: binding.bindingId, socketId: binding.socketId,
      rpcId: frame.rpcId, rpcNonce: frame.rpcNonce, actionHash: createHash('sha256').update(JSON.stringify(frame.message)).digest('hex'), kind, origin: canonicalOrigin, expiresAt: Math.min(started + 60000, deadline) })
    const record = { request, endpoint: identity, current, signal, started, consumeAttempted: false, status: null }, handle = Object.freeze(Object.create(null))
    this.#records.set(request.gateId, record); this.#handles.set(handle, record)
    const body = { ...request, signature: shared.documentSignature(identity, { version: 1, kind: 'runtime-permission-request', request }) }
    try {
      const raw = await this.#http(record, 'request', body, true); this.#check(record)
      return Object.freeze({ handle, status: readStatus(raw, record) })
    } catch (error) {
      this.#check(record)
      if (!['profile_permission_outcome_unknown', 'profile_permission_response_invalid', 'profile_permission_cleanup_unconfirmed'].includes(error?.code)) throw error
      record.status = Object.freeze({ state: 'outcome-unknown', choice: null })
      return Object.freeze({ handle, status: record.status })
    }
  }
  async #query(handle, consume) {
    if (this.#pending) throw fail('profile_permission_busy')
    const record = this.#handles.get(handle); if (!record) throw fail('profile_permission_invalid'); this.#check(record)
    if (consume && record.consumeAttempted) throw fail('profile_permission_consumed')
    if (consume && (record.status?.state !== 'answered' || record.status.choice !== 'allow_once')) throw fail('profile_permission_answer_required')
    if (consume) record.consumeAttempted = true
    const query = { ...Object.fromEntries(SCOPE.map(key => [key, record.request[key]])), readNonce: randomBytes(32).toString('base64url'), readExpiresAt: Math.min(this.now() + 10000, record.request.expiresAt) }
    const body = { ...query, signature: shared.documentSignature(record.endpoint, { version: 1, kind: consume ? 'runtime-permission-consume' : 'runtime-permission-read', ...query }) }
    const raw = await this.#http(record, record.request.gateId + (consume ? '/consume' : '/read'), body, consume); this.#check(record)
    if (query.readExpiresAt <= this.now()) throw fail('profile_permission_response_invalid')
    return readStatus(raw, record, query, consume)
  }
  read(handle) { return this.#query(handle, false) }
  consume(handle) { return this.#query(handle, true) }
  async whenDrained() { if (this.#pending) await Promise.allSettled([this.#pending]); if (this.#cleanupUnconfirmed) throw fail('profile_permission_cleanup_unconfirmed') }
}
