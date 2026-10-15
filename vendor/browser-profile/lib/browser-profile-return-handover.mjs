import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const codec = require('./browser-profile-core/crypto.js')
const shared = require('./browser-profile-core/coordinator-client.js')
const wire = require('./browser-profile-core/return-intent.js')
const fail = code => Object.assign(new Error(code), { code })
const same = (a, b) => shared.canonical(a).equals(shared.canonical(b))
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]))
const SOURCE = ['endpointId', 'bootId', 'runtimeId', 'sessionId', 'writerEpoch']
function contextOf(request) {
  const authority = request.sourceAuthority
  return { version: 1, schemaVersion: request.schemaVersion ?? 1, profileId: authority.profileId, actingUserId: authority.actingUserId, assistantId: authority.assistantId, transitionId: request.requestId,
    revision: authority.revision + 1, previousManifestHash: request.expectedHeadManifestHash, keyEpoch: authority.contentKeyEpoch, source: pick(authority, SOURCE), destination: request.destination }
}
function verifyJournal(saved, request, manifestHash, sourceIdentity) {
  if (!saved?.checkpoint || saved.manifestHash !== manifestHash || !codec.verifyManifest({ ...saved.checkpoint, expectedContext: contextOf(request), sourceIdentity })) throw fail('profile_return_journal_unproved')
  wire.verifyReturnSourceStopped({ request, manifestHash, sourceStopped: { receipt: saved.receipt, signature: saved.receiptSignature }, sourceIdentity })
}
function synchronous(callback) {
  let result; try { result = callback() } catch { throw fail('profile_return_context_changed') }
  if (result?.then) { void Promise.resolve(result).catch(() => {}); throw fail('profile_return_context_changed') }
  if (result === false) throw fail('profile_return_context_changed')
  return result
}

/** A locally reviewed desktop is chosen before source admission changes. All
 * physical stop and encrypted journal work precedes the one possible POST.
 * A late response or failed write can only be reconciled with signed reads. */
export class AgentReturnHandover {
  #records = new Map()
  #sources = new WeakMap()
  /** @param {any} options */
  constructor({ client, now = Date.now }) {
    if (typeof client?.checkpoint !== 'function' || typeof client?.read !== 'function' || typeof now !== 'function') throw fail('profile_return_configuration_invalid')
    Object.defineProperties(this, { client: { value: client }, now: { value: now } })
  }
  state(requestId) {
    const record = this.#records.get(requestId)
    return record ? Object.freeze({ requestId, state: record.state, manifestHash: record.manifestHash }) : null
  }
  async start(input) {
    const { scope, endpoint, runtime, status: rawStatus, expectedHeadManifestHash, peerPins, contentKeyEpoch, assertCurrent, closeAdmission, drain, verifyCurrentAuthority, readJournal, resumeAdmission } = input
    const authority = shared.exactAuthority(input.authority)
    synchronous(assertCurrent)
    const status = wire.validateReturnIntentStatus(rawStatus), request = status.request
    if (!Array.isArray(peerPins) || peerPins.length > 4) throw fail('profile_return_reviewed_desktop_required')
    const selected = peerPins.find(identity => identity.endpointId === request.destination.endpointId)
    if (!selected) throw fail('profile_return_reviewed_desktop_required')
    const destinationIdentity = Object.freeze(structuredClone(selected)), ownIdentity = Object.freeze(structuredClone(endpoint.identity))
    wire.verifyReturnIntentStatus({ status, sourceAuthority: authority, sourceIdentity: ownIdentity, destinationIdentity, now: this.now(), requirePending: true })
    if (['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint'].some(key => scope[key] !== authority[key]) || codec.identityFingerprint(ownIdentity) !== authority.keyFingerprint ||
        request.expectedHeadManifestHash !== expectedHeadManifestHash || !same(runtime.authority, authority) || runtime.state !== 'active' || runtime.network !== 'active' || typeof runtime.finalize !== 'function' ||
        [closeAdmission, drain, verifyCurrentAuthority, readJournal, resumeAdmission].some(callback => typeof callback !== 'function')) throw fail('profile_return_source_changed')
    if (this.#records.has(request.requestId)) throw fail('profile_return_already_attempted')
    if (this.#sources.has(runtime)) throw fail('profile_return_source_busy')
    if (this.#records.size >= 64) throw fail('profile_return_capacity')
    const endpointKey = endpoint.signingPrivateKey, started = this.now()
    const record = { state: 'validating', manifestHash: null, status, scope: Object.freeze({ ...scope }), endpoint, authority, destinationIdentity, ownIdentity, assertCurrent, runtime, endpointKey, started, physicalStopped: false, dispatched: false }
    this.#records.set(request.requestId, record)
    this.#sources.set(runtime, record)
    const check = () => {
      synchronous(assertCurrent)
      if (this.#records.get(request.requestId) !== record || endpoint.signingPrivateKey !== endpointKey || !same(endpoint.identity, ownIdentity) || !same(runtime.authority, authority) || this.now() < started) throw fail('profile_return_context_changed')
    }
    let stopped
    try {
      check(); if (await verifyCurrentAuthority() !== true) throw fail('profile_return_source_changed'); check()
      wire.verifyReturnIntentStatus({ status, sourceAuthority: authority, sourceIdentity: ownIdentity, destinationIdentity, now: this.now(), requirePending: true })
      if (request.schemaVersion === 2) {
        if (typeof runtime.preflightResumeTabs !== 'function') throw fail('profile_return_resume_unproved')
        await runtime.preflightResumeTabs(); check()
        wire.verifyReturnIntentStatus({ status, sourceAuthority: authority, sourceIdentity: ownIdentity, destinationIdentity, now: this.now(), requirePending: true })
      }
      if (synchronous(closeAdmission)?.admissionClosed !== true) throw fail('profile_return_admission_unproved')
      record.state = 'draining'; if ((await drain())?.drained !== true) throw fail('profile_return_drain_unproved'); check()
      if (await verifyCurrentAuthority() !== true) throw fail('profile_return_source_changed'); check()
      wire.verifyReturnIntentStatus({ status, sourceAuthority: authority, sourceIdentity: ownIdentity, destinationIdentity, now: this.now(), requirePending: true })
      if (runtime.state !== 'active' || runtime.network !== 'active') throw fail('profile_return_source_changed')
      const context = contextOf(request)
      record.state = 'stopping'
      stopped = await runtime.finalize({ context, source: endpoint, destinationIdentity, contentKeyEpoch }); check()
      if (runtime.state !== 'stopped' || runtime.network !== 'blocked' || !stopped?.checkpoint || !codec.verifyManifest({ ...stopped.checkpoint, expectedContext: context, sourceIdentity: ownIdentity })) throw fail('profile_return_stop_unproved')
      const manifestHash = codec.manifestHash(stopped.checkpoint.manifest)
      wire.verifyReturnSourceStopped({ request, manifestHash, sourceStopped: { receipt: stopped.receipt, signature: stopped.signature }, sourceIdentity: ownIdentity })
      record.physicalStopped = true; record.manifestHash = manifestHash; record.state = 'journaling'
      const saved = await readJournal({ manifestHash, revision: context.revision, keyEpoch: context.keyEpoch }); check()
      verifyJournal(saved, request, manifestHash, ownIdentity)
      if (!saved || !same(saved.checkpoint, stopped.checkpoint) || !same(saved.receipt, stopped.receipt) || saved.receiptSignature !== stopped.signature || saved.manifestHash !== manifestHash) throw fail('profile_return_journal_unproved')
      if (this.now() >= request.expiresAt) throw fail('profile_return_expired_after_stop')
      record.state = 'uploading'; record.dispatched = true
      const result = await this.client.checkpoint({ scope: record.scope, endpoint, status, stopped, assertCurrent: check }); check()
      return this.#reconcile(record, result)
    } catch (error) {
      if (record.physicalStopped || stopped || runtime.state !== 'active' || runtime.network !== 'active' || record.dispatched) {
        record.state = 'outcome-unknown'
      } else {
        record.state = 'blocked'
        // Before destructive native work, retain the live page only when fresh
        // original authority still verifies. A failed recheck stays blocked.
        try { check(); if (await verifyCurrentAuthority() !== true) throw fail('profile_return_source_changed'); check(); if (synchronous(resumeAdmission) !== true) throw fail('profile_return_admission_unproved'); this.#sources.delete(runtime) } catch { record.state = 'recovery-required' }
      }
      if (record.state === 'outcome-unknown') throw fail('profile_return_outcome_unknown')
      throw error
    }
  }
  #reconcile(record, rawStatus) {
    const status = wire.verifyReturnIntentStatus({ status: rawStatus, sourceAuthority: record.authority, sourceIdentity: record.ownIdentity, destinationIdentity: record.destinationIdentity, now: this.now(), requireStopped: true })
    if (status.intentHash !== record.status.intentHash || !same(status.request, record.status.request) || status.signature !== record.status.signature || status.manifestHash !== record.manifestHash || !['checkpoint-committed', 'staged', 'activated'].includes(status.state)) throw fail('profile_return_outcome_unknown')
    record.state = status.state
    return this.state(status.request.requestId)
  }
  async read(requestId) {
    const record = this.#records.get(requestId)
    if (!record || !record.physicalStopped || !record.manifestHash) throw fail('profile_return_read_unavailable')
    synchronous(record.assertCurrent)
    const status = await this.client.read(record.scope, record.endpoint, requestId, record.assertCurrent)
    synchronous(record.assertCurrent)
    return this.#reconcile(record, status)
  }
  async recover({ scope, endpoint, status: rawStatus, peerPins, candidate, readJournal, assertCurrent }) {
    synchronous(assertCurrent)
    const status = wire.validateReturnIntentStatus(rawStatus), request = status.request, authority = shared.exactAuthority(request.sourceAuthority)
    if (this.#records.has(request.requestId)) throw fail('profile_return_already_attempted')
    if (this.#records.size >= 64 || !Array.isArray(peerPins) || peerPins.length > 4) throw fail('profile_return_capacity')
    const selected = peerPins.find(identity => identity.endpointId === request.destination.endpointId)
    if (!selected) throw fail('profile_return_reviewed_desktop_required')
    const destinationIdentity = Object.freeze(structuredClone(selected)), ownIdentity = Object.freeze(structuredClone(endpoint.identity))
    wire.verifyReturnIntentStatus({ status, sourceAuthority: authority, sourceIdentity: ownIdentity, destinationIdentity, now: this.now() })
    if (['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint'].some(key => scope[key] !== authority[key]) || codec.identityFingerprint(ownIdentity) !== authority.keyFingerprint ||
        candidate?.kind !== 'verified-local-candidate' || candidate.receiptKind !== 'source-stopped' || candidate.cryptoTransitionId !== request.requestId || candidate.coordinatorTransitionId !== request.requestId ||
        candidate.revision !== authority.revision + 1 || candidate.keyEpoch !== authority.contentKeyEpoch || !same(candidate.source, pick(authority, SOURCE)) || !same(candidate.destination, request.destination)) throw fail('profile_return_journal_unproved')
    const saved = await readJournal({ manifestHash: candidate.manifestHash, revision: candidate.revision, keyEpoch: candidate.keyEpoch }); synchronous(assertCurrent)
    verifyJournal(saved, request, candidate.manifestHash, ownIdentity)
    const record = { state: 'outcome-unknown', manifestHash: candidate.manifestHash, status, scope: Object.freeze({ ...scope }), endpoint, authority, destinationIdentity, ownIdentity, assertCurrent, physicalStopped: true, dispatched: true }
    this.#records.set(request.requestId, record)
    if (['checkpoint-committed', 'staged', 'activated'].includes(status.state)) return this.#reconcile(record, status)
    if (status.state === 'recovery-required' || status.manifestHash != null && status.manifestHash !== candidate.manifestHash) record.state = 'recovery-required'
    return this.state(request.requestId)
  }
}
