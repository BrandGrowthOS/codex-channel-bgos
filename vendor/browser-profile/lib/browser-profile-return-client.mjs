import { createRequire } from 'node:module'
import { createPublicKey, KeyObject, randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const codec = require('./browser-profile-core/crypto.js')
const shared = require('./browser-profile-core/coordinator-client.js')
const wire = require('./browser-profile-core/return-intent.js')
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SCOPE = ['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint', 'pairingId', 'ownerUserId']
const fail = code => Object.assign(new Error(code), { code })
function exact(value, fields) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('profile_return_response_invalid')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw fail('profile_return_response_invalid')
}
function synchronous(callback) {
  let value; try { value = callback() } catch { throw fail('profile_return_context_changed') }
  if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_return_context_changed') }
  if (value === false) throw fail('profile_return_context_changed')
}
function scopeOf(raw) {
  exact(raw, SCOPE)
  if (typeof raw.profileId !== 'string' || !UUID.test(raw.profileId) || typeof raw.endpointId !== 'string' || !UUID.test(raw.endpointId) ||
      typeof raw.actingUserId !== 'string' || !ID.test(raw.actingUserId) || typeof raw.ownerUserId !== 'string' || !ID.test(raw.ownerUserId) || typeof raw.keyFingerprint !== 'string' || !HASH.test(raw.keyFingerprint) ||
      !Number.isSafeInteger(raw.assistantId) || raw.assistantId < 1 || !Number.isSafeInteger(raw.pairingId) || raw.pairingId < 1) throw fail('profile_return_scope_invalid')
  return Object.freeze({ ...raw })
}
function endpointOf(endpoint, scope) {
  const identity = Object.freeze({ ...endpoint?.identity }), key = endpoint?.signingPrivateKey
  if (identity.endpointId !== scope.endpointId || codec.identityFingerprint(identity) !== scope.keyFingerprint || !(key instanceof KeyObject) || key.type !== 'private' || key.asymmetricKeyType !== 'ed25519' ||
      createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url') !== identity.signingPublicKey) throw fail('profile_return_endpoint_changed')
  return Object.freeze({ identity, signingPrivateKey: key })
}
function statusOf(raw, scope) {
  let status; try { status = wire.validateReturnIntentStatus(raw) } catch { throw fail('profile_return_response_invalid') }
  if (['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint'].some(key => status.request.sourceAuthority[key] !== scope[key])) throw fail('profile_return_response_invalid')
  return status
}

/** Paired source only. A timed out checkpoint is never resent, even after its
 * physical HTTP work settles. Signed reads are the only reconciliation path. */
export class AgentReturnIntentClient {
  #pending = null
  #cleanupUnknown = false
  #attempted = new Set()
  /** @param {any} options */
  constructor({ origin, authorizePairing, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000 }) {
    let url; try { url = new URL(origin) } catch { throw fail('profile_return_configuration_invalid') }
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) ||
        [authorizePairing, fetchImpl, now].some(value => typeof value !== 'function') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('profile_return_configuration_invalid')
    Object.defineProperties(this, { origin: { value: url.origin }, authorizePairing: { value: authorizePairing }, fetchImpl: { value: fetchImpl }, now: { value: now }, timeoutMs: { value: timeoutMs } })
  }
  async #http(route, body, scope, assertCurrent, write = false) {
    if (this.#pending || this.#cleanupUnknown) throw fail('profile_return_busy')
    if (!/^(?:return-intents\/(?:pending|[a-f0-9-]{36}\/read)|profiles\/[a-f0-9-]{36}\/return-intents\/[a-f0-9-]{36}\/checkpoint)$/.test(route)) throw fail('profile_return_route_invalid')
    synchronous(assertCurrent)
    const bytes = JSON.stringify(body), maximum = write ? codec.MAX_WIRE_BYTES + 16384 : 65536
    if (Buffer.byteLength(bytes) > maximum) throw fail('profile_return_request_too_large')
    const controller = new AbortController(), chunks = [], started = this.now(); let timer, reader, responseBody, dispatched = false, expired = false
    const check = () => { synchronous(assertCurrent); const now = this.now(); if (!Number.isSafeInteger(now) || now < started) throw fail('profile_return_context_changed'); if (expired || controller.signal.aborted) throw fail(dispatched && write ? 'profile_return_outcome_unknown' : 'profile_return_unavailable') }
    const task = Promise.resolve().then(async () => {
      try {
        check(); const proof = await this.authorizePairing(Object.freeze({ purpose: 'endpoint', ...scope })); check()
        if (!proof || proof.pairingId !== scope.pairingId || proof.ownerUserId !== scope.ownerUserId || proof.assistantId !== scope.assistantId || typeof proof.token !== 'string' || !proof.token || proof.token.length > 16384 || /\s/.test(proof.token) || typeof proof.assertCurrent !== 'function') throw fail('profile_return_pairing_required')
        const token = proof.token, verifier = proof.assertCurrent
        const admitted = () => { check(); if (proof.token !== token || proof.assertCurrent !== verifier || proof.pairingId !== scope.pairingId || proof.ownerUserId !== scope.ownerUserId || proof.assistantId !== scope.assistantId) throw fail('profile_return_context_changed'); synchronous(() => verifier.call(proof)) }
        admitted(); dispatched = true
        const response = await this.fetchImpl(new URL('/api/v1/browser/profile-sync/' + route, this.origin).href, { method: 'POST', headers: { 'X-BGOS-Pairing': token, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity' }, body: bytes, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal })
        responseBody = response?.body; if (typeof responseBody?.getReader === 'function') reader = responseBody.getReader()
        admitted(); if (!response || !Number.isInteger(response.status) || response.redirected || !reader) throw fail('profile_return_response_invalid')
        let length = 0
        for (;;) { const { value, done } = await reader.read(); admitted(); if (done) break; if (!(value instanceof Uint8Array) || (length += value.byteLength) > 65536) throw fail('profile_return_response_invalid'); chunks.push(Buffer.from(value)) }
        admitted(); let result; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw fail('profile_return_response_invalid') }
        if (response.status < 200 || response.status >= 300) throw fail(write ? 'profile_return_outcome_unknown' : 'profile_return_refused')
        return result
      } catch (error) {
        if (dispatched && write) throw fail('profile_return_outcome_unknown')
        if (typeof error?.code === 'string' && /^profile_return_[a-z_]+$/.test(error.code)) throw error
        throw fail('profile_return_unavailable')
      } finally {
        try {
          try { if (reader) await reader.cancel(); else if (responseBody) { if (typeof responseBody.cancel !== 'function') throw Error(); await responseBody.cancel() } }
          catch { this.#cleanupUnknown = true; throw fail('profile_return_cleanup_unconfirmed') }
        } finally {
          try { reader?.releaseLock() } catch { this.#cleanupUnknown = true; throw fail('profile_return_cleanup_unconfirmed') }
          finally { for (const chunk of chunks) chunk.fill(0) }
        }
      }
    })
    this.#pending = task
    void task.finally(() => { if (this.#pending === task && !this.#cleanupUnknown) this.#pending = null }).catch(() => {})
    try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; controller.abort(); reject(fail(dispatched && write ? 'profile_return_outcome_unknown' : 'profile_return_unavailable')) }, this.timeoutMs) })]) }
    finally { clearTimeout(timer); controller.abort() }
  }
  async #query(raw, endpoint, requestId, assertCurrent) {
    const scope = scopeOf(raw), signing = endpointOf(endpoint, scope), started = this.now()
    if (!Number.isSafeInteger(started) || started < 0 || requestId != null && !UUID.test(requestId)) throw fail('profile_return_scope_invalid')
    const query = { endpointId: scope.endpointId, keyFingerprint: scope.keyFingerprint, queryNonce: randomBytes(32).toString('base64url'), expiresAt: started + 9000, ...(requestId == null ? {} : { requestId }) }
    const body = { ...query, signature: shared.documentSignature(signing, wire.returnQueryDocument(query, requestId != null)) }
    const result = await this.#http(requestId == null ? 'return-intents/pending' : 'return-intents/' + requestId + '/read', body, scope, assertCurrent)
    exact(result, ['queryNonce', 'endpointId', 'keyFingerprint', 'expiresAt', requestId == null ? 'requests' : 'status'])
    if (['queryNonce', 'endpointId', 'keyFingerprint', 'expiresAt'].some(key => result[key] !== query[key]) || this.now() >= query.expiresAt || this.now() < started) throw fail('profile_return_response_invalid')
    if (requestId != null) { const status = statusOf(result.status, scope); if (status.request.requestId !== requestId) throw fail('profile_return_response_invalid'); return status }
    if (!Array.isArray(result.requests) || result.requests.length > 16) throw fail('profile_return_response_invalid')
    const statuses = result.requests.map(value => statusOf(value, scope)); if (new Set(statuses.map(value => value.request.requestId)).size !== statuses.length) throw fail('profile_return_response_invalid')
    return Object.freeze(statuses)
  }
  pending(scope, endpoint, assertCurrent) { return this.#query(scope, endpoint, null, assertCurrent) }
  read(scope, endpoint, requestId, assertCurrent) { return this.#query(scope, endpoint, requestId, assertCurrent) }
  async checkpoint({ scope: raw, endpoint, status: rawStatus, stopped, assertCurrent }) {
    const scope = scopeOf(raw), signing = endpointOf(endpoint, scope), status = statusOf(rawStatus, scope), requestId = status.request.requestId
    if (this.#attempted.has(requestId)) throw fail('profile_return_checkpoint_attempted')
    if (this.#attempted.size >= 64) throw fail('profile_return_capacity')
    const authority = shared.exactAuthority(status.request.sourceAuthority), manifestHash = codec.manifestHash(stopped.checkpoint.manifest)
    const body = { intentHash: status.intentHash, authority, manifest: stopped.checkpoint.manifest, manifestSignature: stopped.checkpoint.manifestSignature, encryptedPayload: stopped.checkpoint.ciphertext, stoppedReceipt: stopped.receipt, stoppedSignature: stopped.signature,
      signature: shared.documentSignature(signing, wire.returnCheckpointDocument({ requestId, intentHash: status.intentHash, authority, manifestHash })) }
    synchronous(assertCurrent); this.#attempted.add(requestId)
    const rawResult = await this.#http(`profiles/${scope.profileId}/return-intents/${requestId}/checkpoint`, body, scope, assertCurrent, true)
    let result; try { result = statusOf(rawResult, scope) } catch { throw fail('profile_return_outcome_unknown') }
    if (result.intentHash !== status.intentHash || !shared.canonical(result.request).equals(shared.canonical(status.request)) || result.signature !== status.signature || result.manifestHash !== manifestHash) throw fail('profile_return_outcome_unknown')
    return result
  }
  activity() { return Object.freeze({ pendingPhysicalOperations: this.#pending ? 1 : 0, cleanupUnknown: this.#cleanupUnknown }) }
  async whenDrained() { if (this.#pending) await Promise.allSettled([this.#pending]); if (this.#cleanupUnknown) throw fail('profile_return_cleanup_unconfirmed') }
}
