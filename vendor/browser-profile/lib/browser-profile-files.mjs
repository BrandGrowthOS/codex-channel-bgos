import path from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createAgentProfileFileArea } from './browser-profile-file-area.mjs'
import { AgentProfileArtifacts } from './browser-profile-artifacts.mjs'
const require = createRequire(import.meta.url), wire = require('./browser-profile-core/profile-file-wire.js'), files = require('./browser-profile-core/profile-file-crypto.js')
const { ProfileFileStaging } = require('./browser-profile-core/profile-file-staging.js')
const fail = code => Object.assign(new Error(code), { code }), jobs = new Set()
const current = callback => wire.checkCurrent(callback)
const token = prefix => prefix + ':' + randomUUID()
const scopeOf = authority => Object.fromEntries(['profileId', 'actingUserId', 'assistantId'].map(key => [key, authority[key]]))
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
export const AGENT_PROFILE_FILE_TOOLS = Object.freeze([
  { name: 'hoai_browser_files', description: 'List only files explicitly offered through HOAI and already reviewed recipient devices. File tokens are valid only in this browser runtime.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hoai_browser_send_file', description: 'Offer one opaque browser artifact token to an explicitly reviewed recipient device. The recipient must approve this file in HOAI before any bytes are sent. Repeat explicitly to check consent; unknown writes are read-only.', inputSchema: { type: 'object', properties: { artifactToken: { type: 'string' }, recipientToken: { type: 'string' } }, required: ['artifactToken'], additionalProperties: false } }
])
/** One exact runtime. Separate file consent never authorizes a website upload.
 * No public method accepts a source path or uses returned text as a path. */
export class AgentProfileFiles {
  #incoming = new Map(); #recipients = new Map(); #outgoing = new Map(); #work = new Set(); #controllers = new Set(); #closed = false; #unknown = false; #area = null
  constructor({ client, authority, endpoint, directory, peerIdentities, assertCurrent, now = Date.now, createArea = createAgentProfileFileArea, createStaging = options => new ProfileFileStaging(options), createArtifacts = options => new AgentProfileArtifacts(options) }) {
    this.authority = wire.authorityOf(authority); this.scope = scopeOf(this.authority); this.endpoint = wire.endpointOf(endpoint, this.authority)
    if (!client || ['pendingReviewed', 'prepareOffer', 'offer', 'read', 'upload', 'claim', 'whenDrained', 'dispose', 'activity'].some(name => typeof client[name] !== 'function') || !path.isAbsolute(directory) || typeof peerIdentities !== 'function' || typeof assertCurrent !== 'function') throw fail('profile_file_configuration_invalid')
    Object.assign(this, { client, directory, peerIdentities, assertCurrent, now, createArea, createStaging, createArtifacts })
  }
  #check(check, signal) { if (this.#closed || this.#unknown || signal?.aborted) throw fail('profile_file_context_changed'); current(this.assertCurrent); current(check) }
  #run(check, signal, action) {
    this.#check(check, signal); if (this.#work.size || jobs.size >= 4) return Promise.reject(fail('profile_file_busy'))
    const controller = new AbortController(), abort = () => controller.abort(), lease = {}; let bound = false
    jobs.add(lease); this.#controllers.add(controller)
    const task = Promise.resolve().then(async () => {
      try {
        if (signal) { bound = true; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() }
        const exact = () => this.#check(check, controller.signal); exact(); return await action(exact, controller.signal)
      } finally {
        const drained = await Promise.allSettled([() => this.client.whenDrained(), () => this.staging?.whenDrained(), () => this.artifacts?.whenDrained()].map(cleanup => Promise.resolve().then(cleanup))); if (drained.some(value => value.status === 'rejected')) this.#unknown = true
        if (bound) try { signal.removeEventListener('abort', abort) } catch { this.#unknown = true }
        this.#controllers.delete(controller); if (this.#unknown) throw fail('profile_file_cleanup_unconfirmed')
      }
    }).finally(() => { if (!this.#unknown) { this.#work.delete(task); jobs.delete(lease) } })
    this.#work.add(task); void task.catch(() => {}); return task
  }
  async #prepare(check) {
    if (!this.#area) {
      const area = await this.createArea({ directory: this.directory, assertCurrent: check }); check()
      this.staging = this.createStaging({ directory: area.directory, scope: createHash('sha256').update(wire.canonical(this.authority)).digest('hex'), assertPrivateDirectory: area.assertPrivateDirectory, now: this.now })
      this.artifacts = this.createArtifacts({ area, staging: this.staging, now: this.now }); this.#area = area
    }
    await this.#area.assertPrivateDirectory(this.directory); check()
  }
  #options(pins, check, signal) { return { scope: this.scope, authority: this.authority, endpoint: this.endpoint, pins, assertCurrent: check, signal } }
  async #discover(check, signal) {
    const identities = await this.peerIdentities(check); check()
    const value = await this.client.pendingReviewed({ scope: this.scope, authority: this.authority, endpoint: this.endpoint, peerIdentities: identities, assertCurrent: check, signal }); check()
    if (!wire.same(value.authority, this.authority)) throw fail('profile_file_context_changed')
    for (const row of this.#outgoing.values()) if (row.offer.expiresAt + 60000 <= this.now()) { row.payload?.fill(0); this.#outgoing.delete(row.artifactToken) }
    for (const [key, row] of this.#incoming) if (row.offer.expiresAt + 60000 <= this.now()) this.#incoming.delete(key)
    const recipients = value.peers.map(peer => {
      let row = [...this.#recipients.values()].find(row => wire.same(row.pin, peer))
      if (!row) { if (this.#recipients.size >= 16) throw fail('profile_file_inventory_capacity'); row = { token: token('hoai-recipient'), pin: peer }; this.#recipients.set(row.token, row) }
      return row
    })
    for (const row of value.files) {
      const offer = row.status.offer
      if (offer.direction !== 'to-agent' || offer.destination.endpointId !== this.endpoint.identity.endpointId) continue
      const previous = this.#incoming.get(offer.fileId)
      if (previous && (!wire.same(previous.offer, offer) || !wire.same(previous.pins, row.pins) || previous.handle !== row.handle)) throw fail('profile_file_context_changed')
      if (!previous && this.#incoming.size >= 16) throw fail('profile_file_inventory_capacity')
      const entry = previous || { token: token('hoai-file'), handle: row.handle, pins: row.pins, offer, signature: row.status.signature, spent: false }; entry.status = row.status; this.#incoming.set(offer.fileId, entry)
    }
    return { recipients, value }
  }
  list({ assertCurrent, signal }) { return this.#run(assertCurrent, signal, async (check, abort) => {
    const { recipients, value } = await this.#discover(check, abort), output = []
    for (const candidate of value.files) {
      const row = this.#incoming.get(candidate.status.offer.fileId); if (!row || row.spent) continue
      const source = row.pins.find(pin => pin.identity.endpointId === row.offer.source.endpointId)
      const metadata = files.openFileMetadata({ offer: row.offer, signature: row.signature, expectedContext: files.offerContext(row.offer), sourceIdentity: source.identity, destination: this.endpoint })
      output.push({ fileToken: row.token, fileName: metadata.fileName, bytes: row.offer.plaintextBytes, state: row.status.state, expiresAt: row.offer.expiresAt })
    }
    return result({ files: output, recipients: recipients.map(row => ({ recipientToken: row.token, fingerprint: require('./browser-profile-core/crypto.js').identityFingerprint(row.pin.identity) })) })
  }) }
  capture({ name, args, assertCurrent, signal, execute }) { return this.#run(assertCurrent, signal, async check => { await this.#prepare(check); return this.artifacts.capture({ name, args, assertCurrent: check, execute }) }) }
  send({ args, assertCurrent, signal }) {
    const input = wire.exact(args, Object.hasOwn(args || {}, 'recipientToken') ? ['artifactToken', 'recipientToken'] : ['artifactToken'])
    if (typeof input.artifactToken !== 'string' || !/^hoai-artifact:[a-f0-9-]{36}$/.test(input.artifactToken) || input.recipientToken !== undefined && typeof input.recipientToken !== 'string') throw fail('profile_file_artifact_required')
    return this.#run(assertCurrent, signal, async (check, abort) => {
      const { recipients } = await this.#discover(check, abort); let row = this.#outgoing.get(input.artifactToken)
      if (row) {
        if (input.recipientToken !== undefined && input.recipientToken !== row.recipientToken) throw fail('profile_file_context_changed')
        if (!recipients.some(value => wire.same(value.pin, row.peer))) throw fail('profile_file_context_changed')
        const status = await this.client.read(row.handle, this.#options(row.pins, check, abort)); check()
        if (row.unknown || row.uploadAttempted) return result({ state: 'read-only', observedState: status.state })
        if (status.state !== 'allowed') return result({ state: status.state })
        row.uploadAttempted = true
        try { const uploaded = await this.client.upload(row.handle, { ...this.#options(row.pins, check, abort), payload: row.payload }); check(); return result({ state: uploaded.state }) }
        catch (error) { row.unknown = true; throw error } finally { row.payload?.fill(0); row.payload = null }
      }
      const recipient = input.recipientToken === undefined ? recipients.length === 1 ? recipients[0] : null : recipients.find(value => value.token === input.recipientToken)
      if (!recipient) throw fail('profile_file_recipient_selection_required')
      if (this.#outgoing.size >= 16 || [...this.#outgoing.values()].filter(value => value.payload).length >= 4) throw fail('profile_file_inventory_capacity')
      await this.#prepare(check)
      return this.artifacts.consume(input.artifactToken, { assertCurrent: check, use: async (plaintext, fileName, contentType) => {
        check(); const pins = [{ identity: this.endpoint.identity, grantVersion: this.authority.grantVersion }, recipient.pin].sort((a, b) => a.identity.endpointId.localeCompare(b.identity.endpointId))
        const context = { version: 1, kind: 'agent-browser-file-offer', fileId: randomUUID(), nonce: randomBytes(32).toString('base64url'), direction: 'to-desktop', authority: this.authority, source: { endpointId: this.endpoint.identity.endpointId, keyFingerprint: this.authority.keyFingerprint, grantVersion: this.authority.grantVersion }, destination: { endpointId: recipient.pin.identity.endpointId, keyFingerprint: require('./browser-profile-core/crypto.js').identityFingerprint(recipient.pin.identity), grantVersion: recipient.pin.grantVersion }, expiresAt: this.now() + files.FILE_TTL_MS, plaintextBytes: plaintext.length }
        const sealed = files.sealFile({ plaintext, fileName, contentType, context, source: this.endpoint, destinationIdentity: recipient.pin.identity }); plaintext.fill(0); check()
        const options = { ...this.#options(pins, check, abort), sealed }, handle = this.client.prepareOffer(options)
        row = { handle, offer: sealed.offer, pins, peer: recipient.pin, recipientToken: recipient.token, artifactToken: input.artifactToken, payload: sealed.payload, unknown: false, uploadAttempted: false }; this.#outgoing.set(input.artifactToken, row)
        try { const offered = await this.client.offer(options); check(); if (offered.handle !== handle || offered.status.state === 'outcome-unknown') { row.unknown = true; row.payload.fill(0); row.payload = null }; return result({ state: offered.status.state }) }
        catch (error) { row.unknown = true; row.payload?.fill(0); row.payload = null; throw error }
      } })
    })
  }
  upload({ args, engine, assertCurrent, signal, authorize }) {
    const input = wire.exact(args, ['paths']), paths = wire.array(input.paths, 1)
    if (paths.length !== 1 || typeof paths[0] !== 'string' || !/^hoai-file:[a-f0-9-]{36}$/.test(paths[0]) || typeof authorize !== 'function') throw fail('profile_file_token_required')
    return this.#run(assertCurrent, signal, async (baseCheck, abort) => {
      const row = [...this.#incoming.values()].find(value => value.token === paths[0]), page = engine.selectedPage(), url = page?.url?.(), origin = typeof url === 'string' ? new URL(url).origin : null
      if (!row || row.spent || row.status.state !== 'available' || !page || typeof page.on !== 'function' || typeof page.removeListener !== 'function' || typeof page.isClosed !== 'function' || !origin || !['https:', 'http:'].includes(new URL(url).protocol)) throw fail('profile_file_available_token_required')
      let changed = false; const attempted = [], altered = () => { changed = true }, check = () => { baseCheck(); if (changed || page.isClosed() || engine.selectedPage() !== page || page.url() !== url || new URL(page.url()).origin !== origin) throw fail('profile_file_original_page_changed') }
      try {
        for (const event of ['framenavigated', 'close', 'crash']) { attempted.push(event); page.on(event, altered) }
        check(); await this.#prepare(check)
        return await authorize(async (tool, originalArgs, originalSignal) => {
          check(); if (tool !== 'browser_file_upload' || !wire.same(originalArgs, args) || originalSignal !== signal) throw fail('profile_file_original_page_changed')
          if (row.spent) throw fail('profile_file_attempt_spent'); row.spent = true
          const status = await this.client.read(row.handle, this.#options(row.pins, check, abort)); check(); if (status.current !== true || status.state !== 'available') throw fail('profile_file_available_token_required')
          let payload, opened, staged
          try {
            payload = await this.client.claim(row.handle, this.#options(row.pins, check, abort)); check()
            const source = row.pins.find(value => value.identity.endpointId === row.offer.source.endpointId)
            opened = files.openFile({ offer: row.offer, signature: row.signature, payload, expectedContext: files.offerContext(row.offer), sourceIdentity: source.identity, destination: this.endpoint }); check()
            staged = this.staging.stage({ bytes: opened.plaintext, fileName: opened.fileName, expiresAt: row.offer.expiresAt, assertCurrent: check }); opened.plaintext.fill(0)
            return await this.staging.withFile(staged, { assertCurrent: check, use: async file => { check(); return engine.callTool(tool, { paths: [file] }, originalSignal) } })
          } finally { payload?.fill(0); opened?.plaintext.fill(0); if (staged) { try { this.staging.discard(staged) } catch (error) { if (error?.code !== 'profile_file_handle_spent') throw error } } }
        })
      } finally { for (const event of attempted) { try { page.removeListener(event, altered) } catch { this.#unknown = true } }; if (this.#unknown) throw fail('profile_file_cleanup_unconfirmed') }
    })
  }
  activity() { const client = this.client.activity(), artifact = this.artifacts?.activity(); return Object.freeze({ pendingPhysicalOperations: this.#work.size + client.pendingPhysicalOperations + (artifact?.pendingPhysicalOperations || 0), cleanupUnknown: this.#unknown || client.cleanupUnknown || Boolean(artifact?.cleanupUnknown) }) }
  async whenDrained() { await Promise.allSettled([...this.#work]); const states = await Promise.allSettled([() => this.client.whenDrained(), () => this.staging?.whenDrained(), () => this.artifacts?.whenDrained()].map(cleanup => Promise.resolve().then(cleanup))); if (this.#unknown || states.some(value => value.status === 'rejected')) { this.#unknown = true; throw fail('profile_file_cleanup_unconfirmed') } }
  dispose() {
    this.#closed = true; for (const controller of this.#controllers) controller.abort(); for (const row of this.#outgoing.values()) { row.payload?.fill(0); row.payload = null }
    const work = Promise.allSettled([...this.#work]); return Promise.allSettled([() => this.client.dispose(), () => this.staging?.dispose(), () => this.artifacts?.dispose()].map(cleanup => Promise.resolve().then(cleanup))).then(async results => { await work; if (this.#unknown || results.some(value => value.status === 'rejected')) { this.#unknown = true; throw fail('profile_file_cleanup_unconfirmed') } })
  }
}
