import { createRequire } from 'node:module'
import { createHash, createPublicKey, verify } from 'node:crypto'

const require = createRequire(import.meta.url)
const shared = require('./browser-profile-core/coordinator-client.js')
const crypto = require('./browser-profile-core/crypto.js')
const { ProfileRuntimeEndpoint } = require('./browser-profile-core/runtime-endpoint.js')
const { exactAuthority, canonical, documentSignature, META_BYTES, CAPSULE_BYTES } = shared
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const HASH = /^[a-f0-9]{64}$/
const METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'])
const CALL_BYTES = 256 * 1024 + 16 * 1024, RESULT_BYTES = 11 * 1024 * 1024 + 16 * 1024
const fail = (code, statusCode) => Object.assign(new Error(code), { code, ...(statusCode ? { statusCode } : {}) })
const identifier = value => { if (typeof value !== 'string' || !UUID.test(value)) throw fail('profile_sync_identifier_invalid'); return value }
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const sourceOf = value => Object.fromEntries(['endpointId', 'bootId', 'runtimeId', 'sessionId', 'writerEpoch'].map(key => [key, value[key]]))
const destinationOf = value => Object.fromEntries(['endpointId', 'bootId', 'runtimeId', 'sessionId', 'grantVersion', 'keyFingerprint'].map(key => [key, value[key]]))
function exact(value, required, optional = []) {
  if (!plain(value)) throw fail('profile_sync_request_invalid')
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (required.some(key => !Object.hasOwn(descriptors, key)) || keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) throw fail('profile_sync_request_invalid')
  return value
}
function endpointFor(endpoint, authority) {
  const identity = structuredClone(endpoint?.identity)
  if (identity?.endpointId !== authority.endpointId || crypto.identityFingerprint(identity) !== authority.keyFingerprint) throw fail('profile_runtime_endpoint_invalid')
  return Object.freeze({ identity: Object.freeze(identity), signingPrivateKey: endpoint.signingPrivateKey, encryptionPrivateKey: endpoint.encryptionPrivateKey })
}
function signed(endpoint, document, signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw fail('profile_sync_signature_invalid')
  const key = createPublicKey({ key: Buffer.from(endpoint.identity.signingPublicKey, 'base64url'), format: 'der', type: 'spki' })
  if (!verify(null, canonical(document), key, Buffer.from(signature, 'base64url'))) throw fail('profile_sync_signature_invalid')
}
function callerBody(authority, raw, call = false) {
  authority = exactAuthority(authority); exact(raw, call ? ['clientId', 'message'] : ['rpcId', 'clientId'], ['waitMs'])
  if (typeof raw.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.clientId) || raw.waitMs !== undefined && (!Number.isSafeInteger(raw.waitMs) || raw.waitMs < 0 || raw.waitMs > 45000)) throw fail('profile_sync_request_invalid')
  const body = { assistantId: authority.assistantId, clientId: raw.clientId, authority, waitMs: raw.waitMs ?? 0 }
  if (!call) { identifier(raw.rpcId); return body }
  const message = structuredClone(exact(raw.message, ['jsonrpc', 'method'], ['id', 'params']))
  if (message.jsonrpc !== '2.0' || !METHODS.has(message.method) || message.id !== undefined && message.id !== null && !(typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128 || typeof message.id === 'number' && Number.isFinite(message.id)) || message.method === 'tools/call' && (message.id === undefined || message.id === null) || message.params !== undefined && !plain(message.params) || canonical(message).length > 256 * 1024) throw fail('profile_sync_request_invalid')
  return { ...body, message }
}

// Pairing principal only. No human management methods or desktop inheritance.
// The only actor header belongs to original caller call/poll/cancel requests.
export class PairedProfileCoordinatorClient {
  /** @param {any} options */
  constructor({ endpoint, authorizePairing, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    let url; try { url = new URL(endpoint) } catch { throw fail('profile_sync_configuration_invalid') }
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) || typeof authorizePairing !== 'function' || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail('profile_sync_configuration_invalid')
    Object.defineProperties(this, { origin: { value: url.origin }, authorizePairing: { value: authorizePairing }, fetchImpl: { value: fetchImpl }, timeoutMs: { value: timeoutMs } })
  }
  async #request(purpose, route, body, authority, maxResponse = META_BYTES) {
    if(route==='rpc/resolve') {
      exact(authority,['actingUserId','assistantId'])
      if(typeof authority.actingUserId!=='string'||!ID.test(authority.actingUserId)||!Number.isSafeInteger(authority.assistantId)||authority.assistantId<1)throw fail('profile_sync_scope_invalid')
      authority=Object.freeze({...authority})
    } else authority = exactAuthority(authority)
    const caller = purpose === 'caller' && /^(?:rpc\/(?:resolve|call)|rpc\/[a-f0-9-]{36}\/(?:poll|cancel))$/.test(route)
    const endpoint = purpose === 'endpoint' && /^(?:rpc\/[a-f0-9-]{36}\/(?:dispatch|cancellation|result)|transfers\/[a-f0-9-]{36}\/(?:checkpoint|capsule|staged))$/.test(route)
    if (!caller && !endpoint) throw fail('profile_sync_route_refused')
    const scope = Object.freeze({ purpose, actingUserId: authority.actingUserId, assistantId: authority.assistantId }), proof = await this.authorizePairing(scope)
    if (!proof || !Number.isSafeInteger(proof.pairingId) || proof.pairingId < 1 || typeof proof.ownerUserId !== 'string' || !ID.test(proof.ownerUserId) || proof.assistantId !== authority.assistantId || typeof proof.token !== 'string' || !proof.token || proof.token.length > 16384 || /\s/.test(proof.token) || typeof proof.assertCurrent !== 'function') throw fail('profile_sync_pairing_required')
    const binding = Object.freeze({ pairingId: proof.pairingId, ownerUserId: proof.ownerUserId, assistantId: proof.assistantId, token: proof.token }), current = proof.assertCurrent
    const check = () => {
      if (Object.keys(binding).some(key => proof[key] !== binding[key]) || proof.assertCurrent !== current) throw fail('profile_sync_context_changed')
      let value; try { value = current.call(proof) } catch { throw fail('profile_sync_context_changed') }
      if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_sync_context_changed') }
      if (value === false) throw fail('profile_sync_context_changed')
    }
    check()
    const controller = new AbortController(), chunks = [], mutating=route!=='rpc/resolve'; let reader, dispatched = false, timer
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail(dispatched&&mutating ? 'profile_sync_outcome_unknown' : 'profile_sync_connection_unavailable')) }, this.timeoutMs) })
    const wait = value => Promise.race([value, deadline])
    try {
      const bytes = JSON.stringify(body), limit = route.endsWith('/checkpoint') ? CAPSULE_BYTES : route.endsWith('/result') ? RESULT_BYTES : CALL_BYTES
      if (Buffer.byteLength(bytes) > limit) throw fail('profile_sync_request_too_large')
      const url = new URL(`/api/v1/browser/profile-sync/${route}`, this.origin)
      check(); dispatched = true
      const response = await wait(this.fetchImpl(url.href, { method: 'POST', headers: { 'X-BGOS-Pairing': binding.token, ...(caller ? { 'X-BGOS-Acting-User': authority.actingUserId } : {}), Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json' }, body: bytes, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal }))
      check()
      if (!response || !Number.isInteger(response.status) || !response.body?.getReader || response.redirected === true) throw fail('profile_sync_response_invalid')
      reader = response.body.getReader(); let length = 0
      for (;;) {
        const { value, done } = await wait(reader.read()); check(); if (done) break
        if (!(value instanceof Uint8Array) || (length += value.byteLength) > maxResponse) { void reader.cancel().catch(() => {}); throw fail('profile_sync_response_too_large') }
        chunks.push(Buffer.from(value))
      }
      check(); let result
      try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw fail('profile_sync_response_invalid') }
      if (response.status < 200 || response.status >= 300) throw fail(typeof result?.code === 'string' && /^[a-z][a-z0-9_]{1,79}$/.test(result.code) ? result.code : 'profile_sync_request_refused', response.status)
      if (!plain(result)) throw fail('profile_sync_response_invalid')
      return result
    } catch (error) {
      check()
      if (error?.code?.startsWith('profile_') || error?.statusCode) throw error
      throw fail(dispatched&&mutating ? 'profile_sync_outcome_unknown' : 'profile_sync_connection_unavailable')
    } finally {
      clearTimeout(timer); controller.abort(); if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock() } catch {} }
      for (const chunk of chunks) chunk.fill(0)
    }
  }
  async resolve(scope) {
    scope=Object.freeze({...exact(scope,['actingUserId','assistantId'])})
    const result=await this.#request('caller','rpc/resolve',{assistantId:scope?.assistantId},scope)
    if(result.managed===false) {
      exact(result,['managed','actingUserId','assistantId'])
      if(result.actingUserId!==scope.actingUserId||result.assistantId!==scope.assistantId)throw fail('profile_sync_scope_invalid')
      return Object.freeze({...result})
    }
    exact(result,['managed','actingUserId','assistantId','profileId','state'],['authority'])
    if(result.managed!==true||result.actingUserId!==scope.actingUserId||result.assistantId!==scope.assistantId||!UUID.test(result.profileId)||!['idle','active','quiescing','stopped','staged','fenced'].includes(result.state))throw fail('profile_sync_scope_invalid')
    if(result.state==='active') {
      const authority=exactAuthority(result.authority)
      if(authority.actingUserId!==scope.actingUserId||authority.assistantId!==scope.assistantId||authority.profileId!==result.profileId)throw fail('profile_sync_scope_invalid')
      return Object.freeze({...result,authority})
    }
    if(Object.hasOwn(result,'authority'))throw fail('profile_sync_scope_invalid')
    return Object.freeze({...result})
  }
  call(authority, options) { const body = callerBody(authority, options, true); return this.#request('caller', 'rpc/call', body, body.authority, 8 * 1024 * 1024 + META_BYTES) }
  poll(authority, options) { const body = callerBody(authority, options); return this.#request('caller', `rpc/${identifier(options.rpcId)}/poll`, body, body.authority, 8 * 1024 * 1024 + META_BYTES) }
  cancel(authority, options) { const body = callerBody(authority, options); return this.#request('caller', `rpc/${identifier(options.rpcId)}/cancel`, body, body.authority) }
  #shared(method, authority, endpoint, options) {
    const binding = exactAuthority(authority), snapshot = endpointFor(endpoint, binding)
    return shared.ProfileCoordinatorClient.prototype[method].call({ _request: (verb, route, body, current, maxResponse) => {
      if (verb !== 'POST') throw fail('profile_sync_route_refused')
      return this.#request('endpoint', route, body, current, maxResponse)
    } }, binding, snapshot, options)
  }
  dispatch(authority, endpoint, options) { return this.#shared('dispatch', authority, endpoint, options) }
  cancellation(authority, endpoint, options) { return this.#shared('cancellation', authority, endpoint, options) }
  result(authority, endpoint, options) { return this.#shared('result', authority, endpoint, options) }
  commitStopped(authority, endpoint, stopped) {
    authority = exactAuthority(authority); endpoint = endpointFor(endpoint, authority); stopped = structuredClone(exact(stopped, ['checkpoint', 'receipt', 'signature']))
    const { checkpoint, receipt, signature } = stopped, manifest = checkpoint.manifest, hash = crypto.manifestHash(manifest)
    exact(receipt, ['version', 'kind', 'profileId', 'transitionId', 'manifestHash', 'revision', 'source', 'stopped']); identifier(manifest.transitionId)
    if (manifest.profileId !== authority.profileId || manifest.actingUserId !== authority.actingUserId || manifest.assistantId !== authority.assistantId || manifest.revision !== authority.revision + 1 || manifest.keyEpoch !== authority.contentKeyEpoch || canonical(manifest.source).compare(canonical(sourceOf(authority))) !== 0 || receipt.version !== 1 || receipt.kind !== 'source-stopped' || receipt.profileId !== authority.profileId || receipt.transitionId !== manifest.transitionId || receipt.manifestHash !== hash || receipt.revision !== manifest.revision || receipt.stopped !== true || canonical(receipt.source).compare(canonical(sourceOf(authority))) !== 0 || typeof checkpoint.ciphertext !== 'string' || checkpoint.ciphertext.length > crypto.MAX_WIRE_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(checkpoint.ciphertext)) throw fail('profile_sync_checkpoint_invalid')
    const bytes = Buffer.from(checkpoint.ciphertext, 'base64')
    try { if (bytes.toString('base64') !== checkpoint.ciphertext || bytes.length !== manifest.ciphertextBytes || createHash('sha256').update(bytes).digest('hex') !== manifest.ciphertextHash) throw fail('profile_sync_checkpoint_invalid') } finally { bytes.fill(0) }
    signed(endpoint, manifest, checkpoint.manifestSignature); signed(endpoint, receipt, signature)
    return this.#request('endpoint', `transfers/${manifest.transitionId}/checkpoint`, { manifest, manifestSignature: checkpoint.manifestSignature, encryptedPayload: checkpoint.ciphertext, stoppedReceipt: receipt, stoppedSignature: signature }, authority)
  }
  readCapsule(authority, endpoint, { transitionId, manifestHash }) {
    authority = exactAuthority(authority); endpoint = endpointFor(endpoint, authority); identifier(transitionId)
    if (typeof manifestHash !== 'string' || !HASH.test(manifestHash)) throw fail('profile_sync_checkpoint_invalid')
    const document = { version: 1, kind: 'checkpoint-read', profileId: authority.profileId, transitionId, manifestHash, destination: destinationOf(authority) }
    return this.#request('endpoint', `transfers/${transitionId}/capsule`, { signature: documentSignature(endpoint, document) }, authority, CAPSULE_BYTES)
  }
  staged(authority, endpoint, stage) {
    authority = exactAuthority(authority); endpoint = endpointFor(endpoint, authority); stage = structuredClone(exact(stage, ['receipt', 'signature']))
    const { receipt, signature } = stage; exact(receipt, ['version', 'kind', 'profileId', 'transitionId', 'manifestHash', 'revision', 'destination', 'stagedInactive']); identifier(receipt.transitionId)
    if (receipt.version !== 1 || receipt.kind !== 'destination-staged' || receipt.profileId !== authority.profileId || receipt.revision !== authority.revision || receipt.stagedInactive !== true || typeof receipt.manifestHash !== 'string' || !HASH.test(receipt.manifestHash) || canonical(receipt.destination).compare(canonical(destinationOf(authority))) !== 0) throw fail('profile_sync_stage_invalid')
    signed(endpoint, receipt, signature); return this.#request('endpoint', `transfers/${receipt.transitionId}/staged`, { receipt, signature }, authority)
  }
}

/** @param {any} options */
export function createPairedProfileRuntimeEndpoint(options) {
  const authority = exactAuthority(options?.authority)
  if (!(options.client instanceof PairedProfileCoordinatorClient)) throw fail('profile_runtime_endpoint_invalid')
  return new ProfileRuntimeEndpoint({ ...options, authority, endpoint: endpointFor(options.endpoint, authority) })
}
