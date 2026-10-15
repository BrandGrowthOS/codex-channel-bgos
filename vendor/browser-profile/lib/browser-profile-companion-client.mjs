import { createRequire } from 'node:module'
import { createHash, randomUUID, sign, verify } from 'node:crypto'
const require = createRequire(import.meta.url)
const codec = require('./browser-profile-core/crypto.js')
const shared = require('./browser-profile-core/coordinator-client.js')
const fail = code => Object.assign(new Error(code), { code })
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/, HASH = /^[a-f0-9]{64}$/
const META = 64 * 1024, LARGE = 32 * 1024 * 1024 + 16 * 1024
const identifier = value => { if (typeof value !== 'string' || !ID.test(value)) throw fail('profile_companion_scope_invalid'); return value }
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) throw fail('profile_companion_scope_invalid'); return value }
const exact = (value, fields) => {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('profile_companion_response_invalid')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(field => !Object.hasOwn(descriptors, field) || !Object.hasOwn(descriptors[field], 'value') || !descriptors[field].enumerable)) throw fail('profile_companion_response_invalid')
  return value
}
const equal = (a, b) => shared.canonical(a).equals(shared.canonical(b))
const current = callback => { let value; try { value = callback() } catch { throw fail('profile_companion_context_changed') }; if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_companion_context_changed') }; if (value === false) throw fail('profile_companion_context_changed') }
const scopeOf = value => {
  exact(value, ['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint', 'pairingId', 'ownerUserId'])
  uuid(value.profileId); uuid(value.endpointId); identifier(value.actingUserId); identifier(value.ownerUserId)
  if (!Number.isSafeInteger(value.assistantId) || value.assistantId < 1 || !Number.isSafeInteger(value.pairingId) || value.pairingId < 1 || !HASH.test(value.keyFingerprint)) throw fail('profile_companion_scope_invalid')
  return Object.freeze({ ...value })
}
const endpointOf = (endpoint, scope) => { if (endpoint?.identity?.endpointId !== scope.endpointId || codec.identityFingerprint(endpoint.identity) !== scope.keyFingerprint) throw fail('profile_companion_pin_changed'); return endpoint }
const signature = (endpoint, document) => sign(null, shared.canonical(document), endpoint.signingPrivateKey).toString('base64url')
const signed = (endpoint, document, value) => typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value && verify(null, shared.canonical(document), { key: Buffer.from(endpoint.identity.signingPublicKey, 'base64url'), type: 'spki', format: 'der' }, Buffer.from(value, 'base64url'))
const requestFields = ['version','kind','requestId','endpointId','purpose','expectedWriterEpoch','expectedRevision','expectedHeadManifestHash','profileId','actingUserId','assistantId','endpointOwnerUserId','pairingId','nonce','expiresAt','grantVersion','keyFingerprint','contentKeyEpoch']
const destinationFields = ['endpointId','bootId','runtimeId','sessionId','grantVersion','keyFingerprint']
function runtimeRequest(raw, scope) {
  exact(raw, requestFields); uuid(raw.requestId)
  if (raw.version !== 1 || raw.kind !== 'agent-runtime-request' || !['start','receive-transfer'].includes(raw.purpose) ||
      raw.profileId !== scope.profileId || raw.actingUserId !== scope.actingUserId || raw.assistantId !== scope.assistantId || raw.endpointId !== scope.endpointId || raw.keyFingerprint !== scope.keyFingerprint || raw.endpointOwnerUserId !== scope.ownerUserId || raw.pairingId !== scope.pairingId ||
      !HASH.test(raw.nonce) || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt < 1 || ['grantVersion','contentKeyEpoch'].some(key => !Number.isSafeInteger(raw[key]) || raw[key] < 1) ||
      ['expectedWriterEpoch','expectedRevision'].some(key => !Number.isSafeInteger(raw[key]) || raw[key] < 0) || !(raw.expectedRevision === 0 ? raw.expectedHeadManifestHash === null : HASH.test(raw.expectedHeadManifestHash))) throw fail('profile_companion_readiness_invalid')
  return structuredClone(raw)
}
function startDocument(request, process) {
  return { version:1,kind:'session-start',profileId:request.profileId,actingUserId:request.actingUserId,assistantId:request.assistantId,endpointId:request.endpointId,...process,expectedWriterEpoch:request.expectedWriterEpoch,expectedRevision:request.expectedRevision,grantVersion:request.grantVersion,keyFingerprint:request.keyFingerprint }
}
function runtimeStatus(raw, scope, endpoint) {
  exact(raw,['request','state','ready','confirmation']); const request = runtimeRequest(raw.request,scope)
  if (!['pending','ready','confirmed','expired'].includes(raw.state)) throw fail('profile_companion_readiness_invalid')
  if (raw.ready !== null) {
    exact(raw.ready,['document','signature','startSignature','readyHash']); const ready = raw.ready, document = ready.document
    exact(document,[...requestFields,'bootId','runtimeId','sessionId']); const process = Object.fromEntries(['bootId','runtimeId','sessionId'].map(key => [key,identifier(document[key])]))
    if (!equal(document,{...request,kind:'agent-runtime-ready',...process}) || !signed(endpoint,document,ready.signature) ||
        (request.purpose === 'start' ? !signed(endpoint,startDocument(request,process),ready.startSignature) : ready.startSignature !== null) ||
        ready.readyHash !== createHash('sha256').update(shared.canonical({document,signature:ready.signature,startSignature:ready.startSignature})).digest('hex')) throw fail('profile_companion_readiness_invalid')
  }
  if (raw.state === 'pending' && raw.ready !== null || ['ready','confirmed'].includes(raw.state) && raw.ready === null || raw.state !== 'confirmed' && raw.confirmation !== null) throw fail('profile_companion_readiness_invalid')
  if (raw.state === 'confirmed') {
    const target = Object.fromEntries(destinationFields.map(key => [key,raw.ready.document[key]]))
    if (request.purpose === 'start') {
      exact(raw.confirmation,['authority']); const authority = shared.exactAuthority(raw.confirmation.authority)
      if (!equal(authority,{profileId:scope.profileId,actingUserId:scope.actingUserId,assistantId:scope.assistantId,...target,writerEpoch:request.expectedWriterEpoch+1,revision:request.expectedRevision,contentKeyEpoch:request.contentKeyEpoch})) throw fail('profile_companion_readiness_invalid')
    } else { exact(raw.confirmation,['destination']); if (!equal(raw.confirmation.destination,target)) throw fail('profile_companion_readiness_invalid') }
  }
  return structuredClone(raw)
}

/** Agent host only. Setup metadata never becomes runtime authorization. */
export class AgentProfileCoordinatorClient {
  #pending = null
  /** @param {{endpoint:string,authorizePairing:(context:Record<string,unknown>)=>unknown,fetchImpl?:(url:string,options:RequestInit)=>Promise<Response>,timeoutMs?:number}} options */
  constructor({ endpoint, authorizePairing, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    let url; try { url = new URL(endpoint) } catch { throw fail('profile_companion_configuration_invalid') }
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) || typeof authorizePairing !== 'function' || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('profile_companion_configuration_invalid')
    Object.defineProperties(this, { origin: { value: url.origin }, authorizePairing: { value: authorizePairing }, fetchImpl: { value: fetchImpl }, timeoutMs: { value: timeoutMs } })
  }
  async #request(route, body, context, write = false, maximum = META) {
    if (this.#pending) throw fail('profile_companion_request_busy')
    if (!/^(?:endpoint-offers\/pending|endpoint-offers\/[a-f0-9-]{36}\/candidate|endpoints\/[a-f0-9-]{36}\/(?:enrollment|discovery)|runtime-requests\/(?:pending|[a-f0-9-]{36}\/(?:ready|read))|profiles\/[a-f0-9-]{36}\/(?:retire|agent-stopped-head\/readdress)|transfers\/[a-f0-9-]{36}\/(?:resume|status|capsule|staged))$/.test(route)) throw fail('profile_companion_route_refused')
    const bytes = JSON.stringify(body)
    if (Buffer.byteLength(bytes) > (route.endsWith('/retire') ? LARGE : META)) throw fail('profile_companion_request_too_large')
    const controller = new AbortController(), state = { dispatched: false }, chunks = []; let reader, timer
    const task = (async () => {
      let proof; try { proof = await this.authorizePairing(Object.freeze({ ...context })) } catch { throw fail('profile_companion_pairing_required') }
      if (!proof || typeof proof.token !== 'string' || !proof.token || proof.token.length > 16384 || /\s/.test(proof.token) || typeof proof.assertCurrent !== 'function') throw fail('profile_companion_pairing_required')
      const token = proof.token, check = proof.assertCurrent
      const assertCurrent = () => { if (proof.token !== token || proof.assertCurrent !== check) throw fail('profile_companion_context_changed'); current(() => check.call(proof)); if (controller.signal.aborted) throw fail(state.dispatched && write ? 'profile_companion_outcome_unknown' : 'profile_companion_connection_unavailable') }
      try {
        assertCurrent(); state.dispatched = true
        const response = await this.fetchImpl(new URL('/api/v1/browser/profile-sync/' + route, this.origin).href, { method: 'POST', headers: { 'X-BGOS-Pairing': token, Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json' }, body: bytes, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal })
        assertCurrent()
        if (!response || !Number.isInteger(response.status) || response.redirected || !response.body?.getReader) throw fail('profile_companion_response_invalid')
        reader = response.body.getReader(); let length = 0
        for (;;) { const { value, done } = await reader.read(); assertCurrent(); if (done) break; if (!(value instanceof Uint8Array) || (length += value.byteLength) > maximum) throw fail('profile_companion_response_too_large'); chunks.push(Buffer.from(value)) }
        assertCurrent(); let result
        try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw fail('profile_companion_response_invalid') }
        if (response.status < 200 || response.status >= 300) throw Object.assign(fail('profile_companion_request_refused'), { statusCode: response.status })
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('profile_companion_response_invalid')
        return result
      } catch (error) {
        if (error?.code?.startsWith('profile_companion_')) throw error
        throw fail(state.dispatched && write ? 'profile_companion_outcome_unknown' : 'profile_companion_connection_unavailable')
      } finally { if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock() } catch {} }; for (const chunk of chunks) chunk.fill(0) }
    })()
    this.#pending = task
    void task.finally(() => { if (this.#pending === task) this.#pending = null }).catch(() => {})
    try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(fail(state.dispatched && write ? 'profile_companion_outcome_unknown' : 'profile_companion_connection_unavailable')) }, this.timeoutMs) })]) }
    finally { clearTimeout(timer); controller.abort() }
  }
  async pending(assistantId, bootId) {
    if (!Number.isSafeInteger(assistantId) || assistantId < 1) throw fail('profile_companion_scope_invalid')
    const result = await this.#request('endpoint-offers/pending', { assistantId, bootId: identifier(bootId) }, { purpose: 'setup-intents', assistantId })
    exact(result, ['intents', 'truncated'])
    if (!Array.isArray(result.intents) || result.intents.length > 16 || typeof result.truncated !== 'boolean') throw fail('profile_companion_response_invalid')
    for (const intent of result.intents) {
      exact(intent, ['intentId', 'profileId', 'actingUserId', 'assistantId', 'ownerUserId', 'pairingId', 'requestNonce', 'expiresAt', 'state', 'offer', 'acceptedEndpoint'])
      uuid(intent.intentId); uuid(intent.profileId); identifier(intent.actingUserId); identifier(intent.ownerUserId)
      if (intent.assistantId !== assistantId || !Number.isSafeInteger(intent.pairingId) || intent.pairingId < 1 || !/^[A-Za-z0-9_-]{43}$/.test(intent.requestNonce) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= Date.now() || intent.expiresAt > Date.now() + 301000 || intent.state !== 'pending' || intent.acceptedEndpoint !== null) throw fail('profile_companion_response_invalid')
    }
    if (new Set(result.intents.map(intent => intent.intentId)).size !== result.intents.length) throw fail('profile_companion_response_invalid')
    return structuredClone(result)
  }
  async publish(intent, endpoint, bootId, label) {
    if (intent?.state !== 'pending' || typeof label !== 'string' || !/^[\x20-\x7e]{1,60}$/.test(label) || !label.trim()) throw fail('profile_companion_offer_invalid')
    const identity = endpoint.identity, keyFingerprint = codec.identityFingerprint(identity)
    const document = { version: 1, kind: 'agent-endpoint-offer', ...Object.fromEntries(['intentId', 'profileId', 'actingUserId', 'assistantId', 'ownerUserId', 'pairingId', 'requestNonce', 'expiresAt'].map(key => [key, intent[key]])), bootId: identifier(bootId), endpointId: uuid(identity.endpointId), label, signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey, keyFingerprint }
    const sig = signature(endpoint, document), offerHash = createHash('sha256').update(shared.canonical(document)).digest('hex')
    const result = await this.#request(`endpoint-offers/${uuid(intent.intentId)}/candidate`, { bootId, endpointId: identity.endpointId, label, signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey, signature: sig }, { purpose: 'setup-candidate', actingUserId: intent.actingUserId, assistantId: intent.assistantId }, true)
    if (!equal(result.offer, { ...document, signature: sig, offerHash }) || result.intentId !== intent.intentId || result.profileId !== intent.profileId || result.actingUserId !== intent.actingUserId || result.assistantId !== intent.assistantId || result.state !== 'pending') throw fail('profile_companion_offer_invalid')
    return { intent: result, scope: scopeOf({ profileId: intent.profileId, actingUserId: intent.actingUserId, assistantId: intent.assistantId, endpointId: identity.endpointId, keyFingerprint, pairingId: intent.pairingId, ownerUserId: intent.ownerUserId }) }
  }
  async enrollment(raw, pinnedIdentity) {
    const scope = scopeOf(raw)
    if (codec.identityFingerprint(pinnedIdentity) !== scope.keyFingerprint || pinnedIdentity.endpointId !== scope.endpointId) throw fail('profile_companion_pin_changed')
    const body = Object.fromEntries(['profileId', 'actingUserId', 'assistantId', 'keyFingerprint'].map(key => [key, scope[key]]))
    const result = await this.#request(`endpoints/${scope.endpointId}/enrollment`, body, { purpose: 'enrollment-identity', ...scope })
    if (!equal(result, { purpose: 'enrollment-identity', ...scope, pinnedIdentity })) throw fail('profile_companion_pin_changed')
    return result
  }
  async discover(raw, endpoint, after = null) {
    const scope = scopeOf(raw); endpointOf(endpoint, scope); if (after !== null) uuid(after)
    const body = { requestId: randomUUID(), after, expiresAt: Date.now() + 9000 }, document = { version: 1, kind: 'agent-endpoint-discovery', endpointId: scope.endpointId, ...body, pairingId: scope.pairingId, ownerUserId: scope.ownerUserId }
    const result = await this.#request(`endpoints/${scope.endpointId}/discovery`, { ...body, signature: signature(endpoint, document) }, { purpose: 'endpoint-discovery', ...scope })
    exact(result, ['requestId', 'endpointId', 'expiresAt', 'profiles', 'nextCursor'])
    if (result.requestId !== body.requestId || result.endpointId !== scope.endpointId || result.expiresAt !== body.expiresAt || body.expiresAt <= Date.now() || !Array.isArray(result.profiles) || result.profiles.length > 1 || result.nextCursor !== null) throw fail('profile_companion_response_invalid')
    for (const entry of result.profiles) {
      exact(entry, ['profile', 'grant', 'pendingDestinations'])
      const profile = entry.profile
      exact(profile, ['id', 'actingUserId', 'assistantId', 'revision', 'headManifestHash', 'contentKeyEpoch', 'writerEpoch', 'writerState', 'endpointId', 'bootId', 'runtimeId', 'sessionId'])
      if (profile?.id !== scope.profileId || profile.actingUserId !== scope.actingUserId || profile.assistantId !== scope.assistantId || !['idle', 'active', 'quiescing', 'stopped', 'staged', 'fenced'].includes(profile.writerState) || !Number.isSafeInteger(profile.writerEpoch) || profile.writerEpoch < 0 || !Number.isSafeInteger(profile.revision) || profile.revision < 0 || !Number.isSafeInteger(profile.contentKeyEpoch) || profile.contentKeyEpoch < 1 || !(profile.revision === 0 ? profile.headManifestHash === null : HASH.test(profile.headManifestHash))) throw fail('profile_companion_scope_invalid')
      exact(entry.grant, ['generation', 'backgroundUse'])
      if (!Number.isSafeInteger(entry.grant.generation) || entry.grant.generation < 1 || entry.grant.backgroundUse !== true || !Array.isArray(entry.pendingDestinations) || entry.pendingDestinations.length > 1) throw fail('profile_companion_scope_invalid')
      const runtimeFields = ['endpointId', 'bootId', 'runtimeId', 'sessionId'], empty = runtimeFields.every(key => profile[key] === null), present = runtimeFields.every(key => typeof profile[key] === 'string' && ID.test(profile[key]))
      if (!(empty || present) || profile.writerState === 'idle' && !empty || ['active', 'quiescing', 'stopped', 'staged'].includes(profile.writerState) && !present) throw fail('profile_companion_scope_invalid')
      for (const transition of entry.pendingDestinations) { exact(transition, ['transitionId', 'phase', 'destination']); uuid(transition.transitionId); exact(transition.destination, ['endpointId', 'bootId', 'runtimeId', 'sessionId', 'grantVersion', 'keyFingerprint']); for (const key of ['bootId', 'runtimeId', 'sessionId']) identifier(transition.destination[key]); if (!['awaiting_source', 'checkpoint_committed', 'staged'].includes(transition.phase) || transition.destination.endpointId !== scope.endpointId || transition.destination.keyFingerprint !== scope.keyFingerprint || transition.destination.grantVersion !== entry.grant.generation) throw fail('profile_companion_scope_invalid') }
    }
    return structuredClone(result)
  }
  async pendingRuntimeRequests(raw, endpoint) {
    const scope=scopeOf(raw);endpointOf(endpoint,scope)
    const query={queryNonce:randomUUID(),endpointId:scope.endpointId,keyFingerprint:scope.keyFingerprint,expiresAt:Date.now()+9000},document={version:1,kind:'agent-runtime-request-discovery',...query}
    const result=await this.#request('runtime-requests/pending',{...query,signature:signature(endpoint,document)},{purpose:'runtime-requests',...scope})
    exact(result,[...Object.keys(query),'requests'])
    if(!equal(Object.fromEntries(Object.keys(query).map(key=>[key,result[key]])),query)||query.expiresAt<=Date.now()||!Array.isArray(result.requests)||result.requests.length>16)throw fail('profile_companion_readiness_invalid')
    const requests=result.requests.map(row=>runtimeStatus(row,scope,endpoint));if(new Set(requests.map(row=>row.request.requestId)).size!==requests.length)throw fail('profile_companion_readiness_invalid')
    return requests
  }
  async ready(raw, endpoint, request, process) {
    const scope=scopeOf(raw);endpointOf(endpoint,scope);request=runtimeRequest(request,scope);exact(process,['bootId','runtimeId','sessionId']);for(const value of Object.values(process))identifier(value)
    if(request.expiresAt<=Date.now())throw fail('profile_companion_readiness_invalid')
    const document={...request,kind:'agent-runtime-ready',...process},body={...process,signature:signature(endpoint,document),...(request.purpose==='start'?{startSignature:signature(endpoint,startDocument(request,process))}:{})}
    const result=runtimeStatus(await this.#request(`runtime-requests/${request.requestId}/ready`,body,{purpose:'runtime-ready',...scope},true),scope,endpoint)
    if(!equal(result.request,request)||!equal(result.ready?.document,document)||!['ready','confirmed'].includes(result.state))throw fail('profile_companion_readiness_invalid')
    return result
  }
  async runtimeRequest(raw, endpoint, requestId) {
    const scope=scopeOf(raw);endpointOf(endpoint,scope);uuid(requestId)
    const query={queryNonce:randomUUID(),endpointId:scope.endpointId,keyFingerprint:scope.keyFingerprint,expiresAt:Date.now()+9000,requestId},document={version:1,kind:'agent-runtime-request-read',...query}
    const result=await this.#request(`runtime-requests/${requestId}/read`,{...query,signature:signature(endpoint,document)},{purpose:'runtime-request-status',...scope})
    const echo=Object.fromEntries(['queryNonce','endpointId','keyFingerprint','expiresAt'].map(key=>[key,query[key]]));exact(result,[...Object.keys(echo),'status'])
    if(!equal(Object.fromEntries(Object.keys(echo).map(key=>[key,result[key]])),echo)||query.expiresAt<=Date.now())throw fail('profile_companion_readiness_invalid')
    const status=runtimeStatus(result.status,scope,endpoint);if(status.request.requestId!==requestId)throw fail('profile_companion_readiness_invalid');return status
  }
  transition(raw,endpoint,transitionId,side='destination') {
    const scope=scopeOf(raw);endpointOf(endpoint,scope);uuid(transitionId);if(!['source','destination'].includes(side))throw fail('profile_companion_scope_invalid')
    const body={requestId:randomUUID(),profileId:scope.profileId,actingUserId:scope.actingUserId,assistantId:scope.assistantId,side,endpointId:scope.endpointId,keyFingerprint:scope.keyFingerprint},document={version:1,kind:'transition-read',transitionId,...body}
    return this.#request(`transfers/${transitionId}/status`,{...body,signature:signature(endpoint,document)},{purpose:'transition-status',...scope})
  }
  capsule(raw,endpoint,transition) {
    const scope=scopeOf(raw);endpointOf(endpoint,scope);uuid(transition.id)
    const document={version:1,kind:'checkpoint-read',profileId:scope.profileId,transitionId:transition.id,manifestHash:transition.manifestHash,destination:transition.destination}
    return this.#request(`transfers/${transition.id}/capsule`,{signature:signature(endpoint,document)},{purpose:'checkpoint-read',...scope},false,LARGE)
  }
  staged(raw,endpoint,transitionId,staged) {
    const scope=scopeOf(raw);endpointOf(endpoint,scope);uuid(transitionId)
    if(staged.receipt?.transitionId!==transitionId||staged.receipt.profileId!==scope.profileId||!signed(endpoint,staged.receipt,staged.signature))throw fail('profile_companion_scope_invalid')
    return this.#request(`transfers/${transitionId}/staged`,{receipt:staged.receipt,signature:staged.signature},{purpose:'checkpoint-staged',...scope},true)
  }
  retire(authority, endpoint, stopped) {
    authority = shared.exactAuthority(authority); if (codec.identityFingerprint(endpoint.identity) !== authority.keyFingerprint) throw fail('profile_companion_pin_changed')
    const manifest = stopped.checkpoint.manifest, manifestHash = codec.manifestHash(manifest), document = { version: 1, kind: 'agent-runtime-retire', profileId: authority.profileId, authority, transitionId: manifest.transitionId, manifestHash, revision: manifest.revision, destination: manifest.destination }
    return this.#request(`profiles/${uuid(authority.profileId)}/retire`, { authority, manifest, manifestSignature: stopped.checkpoint.manifestSignature, encryptedPayload: stopped.checkpoint.ciphertext, stoppedReceipt: stopped.receipt, stoppedSignature: stopped.signature, signature: signature(endpoint, document) }, { purpose: 'retirement', actingUserId: authority.actingUserId, assistantId: authority.assistantId }, true)
  }
  readdress(raw, endpoint, body) {
    const scope = scopeOf(raw); endpointOf(endpoint, scope)
    exact(body, ['transitionId', 'expectedTransitionId', 'manifestHash', 'expectedRevision', 'expectedWriterEpoch', 'expectedKeyEpoch', 'destination'])
    const document = { version: 1, kind: 'agent-stopped-head-readdress', profileId: scope.profileId, actingUserId: scope.actingUserId, assistantId: scope.assistantId, ...structuredClone(body) }
    return this.#request(`profiles/${scope.profileId}/agent-stopped-head/readdress`, { ...body, signature: signature(endpoint, document) }, { purpose: 'stopped-head-readdress', ...scope }, true)
  }
  resume(raw, endpoint, transition) {
    const scope = scopeOf(raw); endpointOf(endpoint, scope)
    const body = { expectedWriterEpoch: transition.source.writerEpoch, manifestHash: transition.manifestHash }, document = { version: 1, kind: 'agent-stopped-head-resume', transitionId: uuid(transition.id), profileId: scope.profileId, actingUserId: scope.actingUserId, assistantId: scope.assistantId, ...body, destination: transition.destination }
    return this.#request(`transfers/${transition.id}/resume`, { ...body, signature: signature(endpoint, document) }, { purpose: 'stopped-head-resume', ...scope }, true)
  }
}
