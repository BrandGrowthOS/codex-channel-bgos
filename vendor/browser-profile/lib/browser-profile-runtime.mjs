import { createRequire } from 'node:module'
import { randomUUID, sign, KeyObject, createPublicKey } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { chromeEnv } from './browser-env.mjs'
import { profileLaunchArguments } from './browser-profile-launch.mjs'
import { RTC_BROWSER_VERSIONS } from './browser-profile-rtc-activity.mjs'
import { DOCUMENT_SAFETY_EXPRESSION } from './browser-profile-document-safety.mjs'

const require = createRequire(import.meta.url)
export const profileCrypto = require('./browser-profile-core/crypto.js')
const { createStorageAdapter } = require('./browser-profile-core/storage.js')
const { cookies, cookieParams } = require('./browser-profile-core/native-runtime.js')
const portableState = require('./browser-profile-core/portable-state.js')
const { consumeStoppedHeadStageAuthorization } = require('./browser-profile-core/stopped-head-stage.js')
const fail = reason => Object.assign(new Error(reason), { reason, code: reason })
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
const syncCall = (callback, receiver, value) => {
  const result = callback.call(receiver, value)
  if (result?.then) { Promise.resolve(result).catch(() => {}); throw fail('profile_runtime_extras_must_be_synchronous') }
  if (result === false) throw fail('profile_runtime_extras_refused')
  return result
}
const limits = Object.freeze({ targets: 2048, history: 8192, requests: 16384, commands: 4096, messageBytes: 1024 * 1024, frames: 10000, pages: 256 })
const ownedProcesses = new WeakMap()
const canonical = value => JSON.stringify((function sorted(value) { return Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value })(value))
const fields = ['profileId', 'actingUserId', 'assistantId', 'endpointId', 'bootId', 'runtimeId', 'sessionId', 'writerEpoch', 'revision', 'contentKeyEpoch', 'grantVersion', 'keyFingerprint']
const identityFields = ['profileId', 'actingUserId', 'endpointId', 'bootId', 'runtimeId', 'sessionId']
const originOf = value => { try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) ? url.origin : null } catch { return null } }
const sourceOf = value => Object.fromEntries(['endpointId', 'bootId', 'runtimeId', 'sessionId', 'writerEpoch'].map(key => [key, value[key]]))
const destinationOf = value => Object.fromEntries(['endpointId', 'bootId', 'runtimeId', 'sessionId', 'grantVersion', 'keyFingerprint'].map(key => [key, value[key]]))
const authorityOf = value => {
  if (!value || Object.keys(value).length !== fields.length || identityFields.some(key => typeof value[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value[key])) ||
      ['assistantId', 'writerEpoch', 'contentKeyEpoch', 'grantVersion'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 1) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !/^[a-f0-9]{64}$/.test(value.keyFingerprint)) throw fail('profile_runtime_authority_invalid')
  return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])))
}
const until = async (check, ms, reason) => {
  const deadline = Date.now() + ms
  do { const result = await check(); if (result) return result; if (Date.now() >= deadline) throw fail(reason); await new Promise(resolve => setTimeout(resolve, 5)) } while (true)
}

/** Private browser CDP session. Every target is observed before its first run. */
export class ProfileTargetLedger {
  constructor(session, { timeoutMs = 5000 } = {}) {
    this.session = session; this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(10000, timeoutMs)) : 5000; this.sequence = 0; this.commands = new Map(); this.targets = new Map(); this.parentRoutes = new Map(); this.history = new Map(); this.active = new Map(); this.generation = 0; this.frozen = false; this.failure = null; this.disposed = false
    this.listeners = [['Target.attachedToTarget', value => this._attached(value)], ['Target.receivedMessageFromTarget', value => this._message(value)],
      ['Target.targetCreated', ({ targetInfo }) => { if (this.history.size >= limits.history && !this.history.has(targetInfo.targetId)) this.failure = 'profile_inventory_limit'; else this.history.set(targetInfo.targetId, { ...targetInfo }); this.generation++ }],
      ['Target.detachedFromTarget', ({ sessionId }) => { const target = this.targets.get(sessionId); if (target && [...this.active.values()].some(value => value.sessionId === sessionId)) target.interrupted = true; if (target) target.detached = true }]]
    for (const [name, listener] of this.listeners) session.on(name, listener)
  }
  async start() {
    await this.session.send('Target.setDiscoverTargets', { discover: true })
    await this.session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  }
  send(sessionId, method, params = {}) {
    if (this.disposed) return Promise.reject(fail('profile_runtime_disposed'))
    if (this.commands.size >= limits.commands) { this.failure = 'profile_inventory_limit'; return Promise.reject(fail(this.failure)) }
    const id = ++this.sequence
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.commands.delete(id); reject(fail('profile_target_command_timeout')) }, this.timeoutMs)
      this.commands.set(id, { resolve, reject, timer })
    })
    void answer.catch(() => {})
    const packet = { sessionId, message: JSON.stringify({ id, method, params }) }, parent = this.parentRoutes.get(sessionId)
    const delivery = parent ? this.send(parent, 'Target.sendMessageToTarget', packet) : this.session.send('Target.sendMessageToTarget', packet)
    return delivery.then(() => answer, error => { const command = this.commands.get(id); if (command) { clearTimeout(command.timer); this.commands.delete(id); command.reject(error) } return answer })
  }
  _attached({ sessionId, targetInfo, waitingForDebugger }, parent = null) {
    if (this.disposed) return
    const existing = [...this.targets.values()].find(value => value.targetId === targetInfo.targetId)
    if (existing) {
      if (waitingForDebugger && existing.sessionId !== sessionId) void existing.initialization?.then(() => parent ? this.send(parent, 'Target.detachFromTarget', { sessionId }) : this.session.send('Target.detachFromTarget', { sessionId })).catch(() => {})
      return
    }
    if (this.targets.size >= limits.targets || this.history.size >= limits.history) {
      this.failure = 'profile_inventory_limit'
      void (parent ? this.send(parent, 'Target.detachFromTarget', { sessionId }) : this.session.send('Target.detachFromTarget', { sessionId })).catch(() => {})
      return
    }
    const target = { ...targetInfo, browserContextId: targetInfo.browserContextId || this.targets.get(parent)?.browserContextId, sessionId, ready: false, paused: !!waitingForDebugger, detached: false, interrupted: false }
    this.targets.set(sessionId, target); this.history.set(target.targetId, { ...targetInfo, browserContextId: target.browserContextId }); this.generation++
    target.initialization = (async () => {
      // Browser auto-attach requires flatten, while Playwright's public CDP
      // API has no sessionId routing parameter. A second supported legacy
      // attachment routes this target's commands without private PW fields.
      if (!parent) {
        const attached = await this.session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
        target.sessionId = attached.sessionId; this.targets.set(attached.sessionId, target); this.parentRoutes.set(attached.sessionId, null)
      } else this.parentRoutes.set(sessionId, parent)
      await this.send(target.sessionId, 'Network.enable')
      await this.send(target.sessionId, 'Debugger.enable')
      await this.send(target.sessionId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false })
      if (!parent) { this.targets.delete(sessionId); await this.session.send('Target.detachFromTarget', { sessionId }) }
      target.ready = true
      if (!this.frozen) { await this.send(target.sessionId, 'Runtime.runIfWaitingForDebugger'); target.paused = false }
    })().catch(async () => {
      target.unqualified = true; this.failure = 'profile_target_tracking_unavailable'
      if (!this.frozen && !this.disposed) {
        await this.send(target.sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => {})
        if (!parent) { this.targets.delete(sessionId); await this.session.send('Target.detachFromTarget', { sessionId }).catch(() => {}) }
      }
    })
  }
  _message({ sessionId, message: encoded }) {
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > limits.messageBytes) { this.failure = 'profile_target_message_invalid'; return }
    let message; try { message = JSON.parse(encoded) } catch { this.failure = 'profile_target_message_invalid'; return }
    const command = this.commands.get(message.id)
    if (command) { clearTimeout(command.timer); this.commands.delete(message.id); message.error ? command.reject(Object.assign(fail('profile_target_protocol_refused'), { protocolMessage: message.error.message })) : command.resolve(message.result); return }
    const target = this.targets.get(sessionId); if (!target) { this.failure = 'profile_target_untracked'; return }
    const { method, params = {} } = message
    if (method === 'Target.attachedToTarget') { this._attached(params, sessionId); return }
    if (method === 'Target.receivedMessageFromTarget') { this._message(params); return }
    if (method === 'Target.detachedFromTarget') { const child = this.targets.get(params.sessionId); if (child) { if ([...this.active.values()].some(value => value.sessionId === params.sessionId)) child.interrupted = true; child.detached = true } return }
    if (method === 'Debugger.paused') target.paused = true
    if (method === 'Debugger.resumed') target.paused = false
    if (method === 'Network.requestWillBeSent') {
      this.generation++
      if (this.active.size >= limits.requests && !this.active.has(`${sessionId}:${params.requestId}`)) { this.failure = 'profile_inventory_limit'; return }
      this.active.set(`${sessionId}:${params.requestId}`, { sessionId, targetId: target.targetId })
      if (this.frozen) target.activityAfterFreeze = true
    }
    if (['Network.loadingFinished', 'Network.loadingFailed'].includes(method)) {
      if (!this.active.delete(`${sessionId}:${params.requestId}`)) target.missedRequest = true
    }
    if (method === 'Network.responseReceived' && !this.active.has(`${sessionId}:${params.requestId}`)) target.missedRequest = true
    if (['Network.webSocketCreated', 'Network.webTransportCreated', 'Network.directTCPSocketCreated', 'Network.directUDPSocketCreated'].includes(method) || method === 'Network.responseReceived' && params.type === 'EventSource') target.persistentTransport = true
  }
  async inventory(contextId) {
    if (!contextId) throw fail('profile_context_unqualified')
    await Promise.all([...this.targets.values()].filter(value => value.browserContextId === contextId).map(value => value.initialization))
    const current = (await this.session.send('Target.getTargets')).targetInfos.filter(value => value.browserContextId === contextId)
    const history = [...this.history.values()].filter(value => value.browserContextId === contextId)
    for (const info of [...history, ...current]) {
      const record = [...this.targets.values()].find(value => value.targetId === info.targetId)
      if (!record?.ready || record.unqualified || !['page', 'iframe', 'worker', 'shared_worker'].includes(info.type)) throw Object.assign(fail('profile_target_unqualified'), { targetQualification: { type: info.type, tracked: !!record, ready: !!record?.ready, unqualified: !!record?.unqualified } })
      if (record.interrupted) throw fail('profile_network_outcome_unknown')
      if (record.missedRequest) throw fail('profile_network_untracked')
      if (record.persistentTransport) throw fail('profile_persistent_transport_unsupported')
    }
    if (this.failure) throw fail(this.failure)
    return current
  }
  async readyTarget(targetId) {
    const record = await until(() => [...this.targets.values()].find(value => value.targetId === targetId), this.timeoutMs, 'profile_target_untracked')
    await record.initialization; if (!record.ready || record.unqualified) throw fail('profile_target_tracking_unavailable')
  }
  assertIdle(contextId) {
    if ([...this.active.values()].some(value => this.targets.get(value.sessionId)?.browserContextId === contextId)) throw fail('profile_requests_in_flight')
  }
  async freeze(contextId) {
    this.assertIdle(contextId); const current = await this.inventory(contextId); this.assertIdle(contextId)
    this.frozen = true; const generation = this.generation
    for (const info of current) {
      const target = [...this.targets.values()].find(value => value.targetId === info.targetId)
      await this.send(target.sessionId, 'Debugger.pause')
      void this.send(target.sessionId, 'Runtime.evaluate', { expression: 'void 0', returnByValue: true }).catch(error => { target.pauseError = error.protocolMessage || error.reason })
    }
    try { await until(() => current.every(info => [...this.targets.values()].find(value => value.targetId === info.targetId)?.paused), this.timeoutMs, 'profile_target_pause_unproved') }
    catch (error) { error.pauseQualification = current.map(info => { const target = [...this.targets.values()].find(value => value.targetId === info.targetId); return { type: info.type, paused: target?.paused, error: target?.pauseError || null } }); throw error }
    if (this.generation !== generation) throw fail('profile_activity_during_freeze')
    this.assertIdle(contextId); return generation
  }
  async resume() {
    this.frozen = false
    for (const target of this.targets.values()) if (!target.detached) {
      await this.send(target.sessionId, 'Debugger.resume').catch(() => {})
      await this.send(target.sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => {})
    }
  }
  dispose() { this.disposed = true; for (const [name, listener] of this.listeners) this.session.removeListener(name, listener); for (const command of this.commands.values()) { clearTimeout(command.timer); command.reject(fail('profile_runtime_disposed')) } this.commands.clear() }
}

export async function restoreProfileEndpoint({ keyStore, record, authority, pinnedIdentity, assertCurrent, signal, backgroundUse }) {
  if (backgroundUse !== true) throw fail('profile_key_background_grant_required')
  const binding = authorityOf(authority)
  return keyStore.restore({ record, pinnedIdentity, assertCurrent, signal, binding: { profileId: binding.profileId, actingUserId: binding.actingUserId, assistantId: binding.assistantId, endpointId: binding.endpointId,
    keyFingerprint: binding.keyFingerprint, grantVersion: binding.grantVersion, keyEpoch: binding.contentKeyEpoch, backgroundUse: true } })
}

// Enrollment identity recovery is deliberately separate from runtime unlock.
// Saved grant/epoch values bind only this encrypted record's original AEAD.
export async function restoreProfileEnrollment({ keyStore, record, pinnedIdentity, pairing, authorizeEnrollment, signal }) {
  const publicFields = ['purpose', 'profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint', 'pairingId', 'ownerUserId', 'pinnedIdentity']
  const recordFields = ['profileId', 'actingUserId', 'assistantId', 'endpointId', 'keyFingerprint', 'grantVersion', 'keyEpoch', 'backgroundUse']
  const exact = (value, fields) => {
    if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('profile_enrollment_identity_refused')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).length !== fields.length || fields.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) throw fail('profile_enrollment_identity_refused')
  }
  const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
  exact(record, ['version', 'provider', 'recordId', 'binding', 'keys']); exact(record.binding, recordFields); exact(record.keys, ['version', 'identityFingerprint', 'ciphertext']); exact(pairing, ['pairingId', 'ownerUserId'])
  if (typeof keyStore?.restore !== 'function' || typeof authorizeEnrollment !== 'function' || typeof record.keys.ciphertext !== 'string' || record.keys.ciphertext.length > 11000) throw fail('profile_enrollment_identity_refused')
  record = freeze(structuredClone(record)); pinnedIdentity = freeze(structuredClone(pinnedIdentity)); pairing = freeze(structuredClone(pairing))
  const saved = record.binding, fingerprint = profileCrypto.identityFingerprint(pinnedIdentity), uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
  if (!uuid.test(saved.profileId) || !uuid.test(saved.endpointId) || typeof saved.actingUserId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(saved.actingUserId) || ['assistantId', 'grantVersion', 'keyEpoch'].some(key => !Number.isSafeInteger(saved[key]) || saved[key] < 1) || saved.backgroundUse !== true || saved.keyFingerprint !== fingerprint || pinnedIdentity.endpointId !== saved.endpointId || !Number.isSafeInteger(pairing.pairingId) || pairing.pairingId < 1 || typeof pairing.ownerUserId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(pairing.ownerUserId)) throw fail('profile_enrollment_identity_refused')
  const request = freeze({ purpose: 'enrollment-identity', profileId: saved.profileId, actingUserId: saved.actingUserId, assistantId: saved.assistantId, endpointId: saved.endpointId, keyFingerprint: fingerprint, ...pairing, pinnedIdentity })
  let proof; try { proof = await authorizeEnrollment(request) } catch { throw fail('profile_enrollment_identity_refused') }
  exact(proof, [...publicFields, 'assertCurrent'])
  if (typeof proof.assertCurrent !== 'function') throw fail('profile_enrollment_identity_refused')
  const assertCurrent = proof.assertCurrent
  const check = () => {
    exact(proof, [...publicFields, 'assertCurrent'])
    if (signal?.aborted || proof.assertCurrent !== assertCurrent || publicFields.some(key => key === 'pinnedIdentity' ? canonical(proof[key]) !== canonical(request[key]) : proof[key] !== request[key])) throw fail('profile_enrollment_identity_refused')
    let value; try { value = assertCurrent.call(proof) } catch { throw fail('profile_enrollment_identity_refused') }
    if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_enrollment_identity_refused') }
    if (value === false) throw fail('profile_enrollment_identity_refused')
  }
  check()
  const endpoint = await keyStore.restore({ record, binding: saved, pinnedIdentity, assertCurrent: check, signal }); check()
  const identity = freeze(structuredClone(endpoint?.identity))
  if (canonical(identity) !== canonical(pinnedIdentity)) throw fail('profile_enrollment_identity_refused')
  for (const [field, type, publicField] of [['signingPrivateKey', 'ed25519', 'signingPublicKey'], ['encryptionPrivateKey', 'x25519', 'encryptionPublicKey']]) {
    const key = endpoint[field]
    if (!(key instanceof KeyObject) || key.type !== 'private' || key.asymmetricKeyType !== type || createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url') !== pinnedIdentity[publicField]) throw fail('profile_enrollment_identity_refused')
  }
  return Object.freeze({ identity, signingPrivateKey: endpoint.signingPrivateKey, encryptionPrivateKey: endpoint.encryptionPrivateKey })
}

function processIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) throw fail('profile_process_exit_proof_unavailable')
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), end = stat.lastIndexOf(')'); return { pid, started: stat.slice(end + 2).split(' ')[19] } } catch { throw fail('profile_process_exit_proof_unavailable') }
}
function processExited(identity) {
  try { return processIdentity(identity.pid).started !== identity.started } catch (error) { try { readFileSync(`/proc/${identity.pid}/stat`); return false } catch (cause) { return cause.code === 'ENOENT' } }
}
function nativeGroupMembers(group) {
  const names=readdirSync('/proc').filter(name=>/^\d+$/.test(name))
  if(names.length>65536)throw fail('profile_owned_process_inventory_unavailable')
  const members=[]
  for(const name of names){try{const stat=readFileSync(`/proc/${name}/stat`,'utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(Number(parts[2])===group)members.push({pid:Number(name),started:parts[19]})}catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw fail('profile_owned_process_inventory_unavailable')}}
  return members
}
function ownProcessStop(identity,timeoutMs) {
  identity=Object.freeze({...identity});let task
  return Object.freeze({stop:()=>task||(task=(async()=>{
    if(process.platform!=='linux')throw fail('profile_owned_process_proof_required')
    if(processExited(identity)){if(nativeGroupMembers(identity.pid).length)throw fail('profile_owned_process_group_unconfirmed');return{stopped:true,recoveryRequired:true}}
    const stat=readFileSync(`/proc/${identity.pid}/stat`,'utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' ')
    if(parts[19]!==identity.started||Number(parts[2])!==identity.pid)throw fail('profile_owned_process_group_unconfirmed')
    process.kill(-identity.pid,'SIGSTOP');let killed=false
    try{
      const members=nativeGroupMembers(identity.pid)
      if(!members.some(member=>member.pid===identity.pid&&member.started===identity.started))throw fail('profile_owned_process_changed')
      // The group has stopped. Recheck its original leader immediately before
      // killing only that Playwright-owned group, never an arbitrary supplied PID.
      if(processIdentity(identity.pid).started!==identity.started)throw fail('profile_owned_process_changed')
      process.kill(-identity.pid,'SIGKILL');killed=true
      await until(()=>members.every(processExited)&&nativeGroupMembers(identity.pid).length===0,timeoutMs,'profile_runtime_process_alive')
      return{stopped:true,recoveryRequired:true}
    }finally{
      // A failed inventory cannot leave the already identified group suspended.
      // Cleanup remains unconfirmed; this best effort never creates a receipt.
      if(!killed)try{if(processIdentity(identity.pid).started===identity.started)process.kill(-identity.pid,'SIGKILL')}catch{}
    }
  })())})
}

/** Main/agent-only adapter. Not yet connected to host RPC or MCP commands. */
export class BrowserProfileRuntime {
  static async create({ chromium, executable, environment = process.env, authority, closeAndDrain, checkpoint, authorizeActivation, assertTransferAllowed, transferQualification, transferQualificationFactory, preflightExtras, captureExtras, commitExtras, onOwnedProcess, timeoutMs = 5000, captureProcessIdentity = processIdentity, assertProcessExited = processExited }) {
    const binding = authorityOf(authority)
    if (!chromium?.launch || typeof closeAndDrain !== 'function' || typeof checkpoint !== 'function' || typeof authorizeActivation !== 'function') throw fail('profile_runtime_dependencies_required')
    if ([preflightExtras, captureExtras, commitExtras].some(callback => typeof callback !== 'function')) throw fail('profile_runtime_extras_dependencies_required')
    if(transferQualificationFactory!==undefined&&(typeof transferQualificationFactory!=='function'||transferQualification!==undefined))throw fail('profile_transport_qualification_required')
    const browserEnvironment = chromeEnv(environment, { platform: process.platform, headed: false })
    for (const name of Object.keys(browserEnvironment)) if (['DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'].includes(name.toUpperCase())) delete browserEnvironment[name]
    let browser
    const launchArguments = profileLaunchArguments()
    try { browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...launchArguments, ...(executable ? { executablePath: executable } : {}), env: browserEnvironment }) }
    catch (error) { if (/sandbox|user namespace/i.test(error?.message || '')) throw fail('profile_browser_sandbox_setup_required'); throw fail('profile_browser_start_failed') }
    let runtime, ledger, transportObserver
    try {
      const root = await browser.newBrowserCDPSession(); ledger = new ProfileTargetLedger(root, { timeoutMs }); await ledger.start()
      const browserVersion=await browser.version(),processes=await root.send('SystemInfo.getProcessInfo'),pid=processes.processInfo.find(value=>value.type==='browser')?.id,nativeProcess=captureProcessIdentity(pid)
      const ownedStop=captureProcessIdentity===processIdentity&&assertProcessExited===processExited?ownProcessStop(nativeProcess,timeoutMs):null
      if(onOwnedProcess!==undefined){if(typeof onOwnedProcess!=='function'||!ownedStop)throw fail('profile_owned_process_proof_required');syncCall(onOwnedProcess,undefined,ownedStop)}
      let contextId,before
      const contexts=async()=>{const values=(await root.send('Target.getBrowserContexts')).browserContextIds;if(!Array.isArray(values)||values.length>2||new Set(values).size!==values.length||values.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value)))throw fail('profile_context_unqualified');return values}
      if(transferQualificationFactory){
        transportObserver=await transferQualificationFactory({browser,root,authority:binding,browserVersion,processIdentity:nativeProcess,timeoutMs})
        if(!transportObserver||transportObserver.kind!=='qualified-chromium-native-observer-v1'||transportObserver.browserVersion!==browserVersion||['assertQualified','confirmStopped','bindContext','dispose'].some(name=>typeof transportObserver[name]!=='function'))throw fail('profile_transport_qualification_required')
        before=await contexts();if(before.length!==1||before[0]!==transportObserver.privateContextId)throw fail('profile_context_unqualified')
      }
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
      if(transportObserver){const after=await contexts(),added=after.filter(value=>!before.includes(value));if(after.length!==before.length+1||before.some(value=>!after.includes(value))||added.length!==1||context.pages().length)throw fail('profile_context_unqualified');contextId=added[0];await transportObserver.bindContext({context,contextId});if(context.pages().length)throw fail('profile_context_unqualified');transferQualification=transportObserver}
      runtime = new BrowserProfileRuntime({ browser, browserVersion, root, ledger, context, authority: binding, closeAndDrain, checkpoint, authorizeActivation, assertTransferAllowed, transferQualification, transportObserver,preflightExtras, captureExtras, commitExtras, timeoutMs, assertProcessExited })
      runtime.processIdentity = nativeProcess
      if (ownedStop) ownedProcesses.set(runtime, ownedStop)
      await context.route('**/*', runtime.route)
      const probe = await runtime._newPage(true), cdp = await context.newCDPSession(probe)
      runtime.contextId = (await cdp.send('Target.getTargetInfo')).targetInfo.browserContextId
      if (!runtime.contextId||contextId&&runtime.contextId!==contextId) throw fail('profile_context_unqualified')
      await ledger.inventory(runtime.contextId)
      await until(() => { try { ledger.assertIdle(runtime.contextId); return true } catch { return false } }, timeoutMs, 'profile_bootstrap_requests_in_flight')
      runtime.bootstrapPage = probe
      return runtime
    } catch (error) { ledger?.dispose();try{await transportObserver?.dispose()}finally{await browser.close().catch(() => {})}throw error }
  }
  constructor(options) {
    if ([options.preflightExtras, options.captureExtras, options.commitExtras].some(callback => typeof callback !== 'function')) throw fail('profile_runtime_extras_dependencies_required')
    Object.assign(this, options); this.authority = authorityOf(options.authority); this.state = 'new'; this.network = 'blocked'; this.privatePages = new Set(); this.privateURLs = new Map(); this.pages = new Set(); this.markers = []; this.frameJobs = new Set(); this.knownOrigins = new Set(); this.operation = null; this.contentKeyEpoch = null
    const qualification=options.transferQualification
    if(qualification!==undefined){
      if(!qualification||!['qualified-chromium-native-observer-v1','restricted-disposable-fixture'].includes(qualification.kind)||typeof qualification.assertQualified!=='function')throw fail('profile_transport_qualification_required')
      let origins
      if(qualification.kind==='restricted-disposable-fixture'){
        if(!Array.isArray(qualification.origins)||qualification.origins.length<1||qualification.origins.length>32)throw fail('profile_transport_qualification_required')
        origins=qualification.origins.map(value=>{let url;try{url=new URL(value)}catch{throw fail('profile_transport_qualification_required')};if(value!==url.origin||!['http:','https:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname))throw fail('profile_transport_qualification_required');return value})
      }else if(!RTC_BROWSER_VERSIONS.includes(qualification.browserVersion)||typeof qualification.confirmStopped!=='function')throw fail('profile_transport_qualification_required')
      this.transferQualification=Object.freeze({kind:qualification.kind,assertQualified:qualification.assertQualified.bind(qualification),...(origins?{origins:Object.freeze([...new Set(origins)])}:{browserVersion:qualification.browserVersion,confirmStopped:qualification.confirmStopped.bind(qualification)})})
    }
    this.route = async route => {
      if (this.network === 'active') return route.continue()
      const request = route.request(), page = request.frame()?.page()
      if (this.network === 'private' && this.privateURLs.get(page) === request.url() && request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': "default-src 'none'; script-src 'none'; worker-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'", 'cache-control': 'no-store' }, body: '<!doctype html><meta charset=utf-8><title>Private profile storage</title>' })
      if (this.network === 'quiescing') this.inventoryFailure = 'profile_activity_during_freeze'
      return route.abort()
    }
    this.pageCreated = page => { if (this.pages.size >= limits.pages) { this.inventoryFailure = 'profile_inventory_limit'; return } this.pages.add(page); if (this.creatingPrivate) { this.privatePages.add(page); return } this._observePage(page) }
    this.context.on('page', this.pageCreated)
  }
  _observePage(page) { page.on('framenavigated', frame => this._frame(page, frame)); page.on('frameattached', frame => this._frame(page, frame)) }
  async _newPage(privatePage = false) {
    this.creatingPrivate = privatePage
    try {
      if (this.bootstrapPage) { const page = this.bootstrapPage; this.bootstrapPage = null; if (!privatePage) { this.privatePages.delete(page); this._observePage(page) } return page }
      const page = await this.context.newPage(), cdp = await this.context.newCDPSession(page)
      const info = (await cdp.send('Target.getTargetInfo')).targetInfo; await this.ledger.readyTarget(info.targetId); await cdp.detach(); return page
    } finally { this.creatingPrivate = false }
  }
  async newPage(url = 'about:blank') { this.assertCurrent(); const page = await this._newPage(); if (url !== 'about:blank') await page.goto(url); return page }
  _frame(page, frame) {
    const url = frame.url(); if (frame === page.mainFrame() && url === 'about:blank') return
    if (this.markers.length >= limits.frames || this.frameJobs.size >= limits.frames || typeof url !== 'string' || url.length > 16384) { this.inventoryFailure = 'profile_inventory_limit'; return }
    const marker = { frame, page, url, origin: originOf(url), qualified: false }; this.markers.push(marker)
    const job = (async () => {
      const cdp = await this.context.newCDPSession(page)
      try {
      const tree = (await cdp.send('Page.getFrameTree')).frameTree
      const frames = node => [node.frame, ...(node.childFrames || []).flatMap(frames)], candidates = frames(tree).filter(value => value.url === url)
      if (candidates.length !== 1) throw fail('profile_frame_ambiguous')
      const { storageKey } = await cdp.send('Storage.getStorageKeyForFrame', { frameId: candidates[0].id }), top = originOf(tree.frame.url)
      if (frame.isDetached() || frame.url() !== url || !top || storageKey !== top + '/' || marker.origin && marker.origin !== top || !marker.origin && url !== 'about:blank') throw fail('profile_partitioned_origin_unsupported')
      marker.origin = top; marker.qualified = true
      } finally { await cdp.detach().catch(() => {}) }
    })().catch(error => { marker.reason = error.reason || 'profile_frame_unqualified' })
    this.frameJobs.add(job); void job.finally(() => this.frameJobs.delete(job))
  }
  async assertMovable() {
    await Promise.all([...this.frameJobs]); if (this.inventoryFailure) throw fail(this.inventoryFailure)
    await this.ledger.inventory(this.contextId); this.ledger.assertIdle(this.contextId)
    for (const page of this.context.pages()) if (!this.pages.has(page)) throw fail('profile_page_untracked')
    const origins = new Set(this.knownOrigins)
    for (const marker of this.markers) { if (!marker.qualified) throw fail(marker.reason || 'profile_frame_unqualified'); origins.add(marker.origin) }
    if (origins.size > 100 || this.markers.length > 10000) throw fail('profile_inventory_limit')
    return { origins: [...origins].sort() }
  }
  async _assertDocumentSafety() {
    await this.assertTransferAllowed?.({ authority: this.authority, context: this.context })
    const expression = DOCUMENT_SAFETY_EXPRESSION
    for (const page of this.context.pages()) if (!this.privatePages.has(page)) {
      const cdp = await this.context.newCDPSession(page)
      try {
        const tree = (await cdp.send('Page.getFrameTree')).frameTree, frames = node => [node.frame, ...(node.childFrames || []).flatMap(frames)]
        for (const frame of frames(tree)) {
          const world = await cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'hoai-private-profile-transfer', grantUniveralAccess: false })
          const result = await cdp.send('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true, timeout:2000 })
          if (result.exceptionDetails) throw fail('profile_document_inspection_unavailable')
          if (result.result?.value?.ready !== true) throw fail('profile_document_loading')
          if (result.result.value.credentials !== false) throw fail('profile_authentication_in_progress')
          if (result.result.value.unsaved !== false) throw fail('profile_unsaved_form_state')
        }
      } finally { await cdp.detach().catch(() => {}) }
    }
  }
  _assertTransportQualified(origins){
    const proof=this.transferQualification
    if(!proof||proof.kind==='qualified-chromium-native-observer-v1'&&proof.browserVersion!==this.browserVersion||proof.kind==='restricted-disposable-fixture'&&origins.some(origin=>!proof.origins.includes(origin)))throw fail('profile_transport_qualification_required')
    try{if(syncCall(proof.assertQualified,undefined,{authority:this.authority,context:this.context,browserVersion:this.browserVersion,origins:Object.freeze([...origins])})!==true)throw fail('profile_transport_qualification_required')}catch{throw fail('profile_transport_qualification_required')}
  }
  async _confirmTransportStopped(token){
    const proof=this.transferQualification
    if(proof?.kind==='restricted-disposable-fixture')return
    if(proof?.kind!=='qualified-chromium-native-observer-v1'||typeof proof.confirmStopped!=='function')throw fail('profile_transport_qualification_required')
    const assertPhysicalZero=async()=>{
      this._current(token);this.activeProof()
      if(this.context.pages().length)throw fail('profile_runtime_stop_failed')
      const targets=(await this.root.send('Target.getTargets')).targetInfos;this._current(token);this.activeProof()
      if(targets.some(value=>value.browserContextId===this.contextId))throw fail('profile_runtime_workers_running')
      this.ledger.assertIdle(this.contextId);return true
    }
    await assertPhysicalZero();this._current(token);this.activeProof()
    try{if(await proof.confirmStopped({authority:this.authority,context:this.context,browserVersion:this.browserVersion,assertPhysicalZero})!==true)throw fail('profile_transport_qualification_required')}
    catch{throw fail('profile_transport_qualification_required')}
    this._current(token);this.activeProof();await assertPhysicalZero();this._current(token);this.activeProof()
  }
  assertCurrent() { if (this.state !== 'active' || this.network !== 'active' || !this.activeProof) throw fail('profile_runtime_authority_inactive'); this.activeProof(); return this.authority }
  _admit(states) { if (this.operation || !states.includes(this.state)) throw fail('profile_runtime_state_refused'); const token = Symbol(); this.operation = token; return token }
  _current(token) { if (this.operation !== token || this.state === 'disposed') throw fail('profile_runtime_operation_revoked') }
  _context(value, direction) {
    if (!value || value.profileId !== this.authority.profileId || value.actingUserId !== this.authority.actingUserId || value.assistantId !== this.authority.assistantId || value.keyEpoch !== this.authority.contentKeyEpoch || value.revision !== this.authority.revision + (direction === 'source' ? 1 : 0)) throw fail('profile_runtime_context_mismatch')
    const expected = direction === 'source' ? sourceOf(this.authority) : destinationOf(this.authority)
    if (Object.keys(expected).some(key => value[direction]?.[key] !== expected[key])) throw fail('profile_runtime_context_mismatch')
  }
  async activate(grant) {
    if (this.state === 'new' && this.authority.revision) throw fail('profile_runtime_checkpoint_required')
    const token = this._admit(['new', 'staged'])
    try {
      if (this.extrasCommitFailure) throw fail('profile_runtime_extras_commit_uncertain')
      const proof = await this.authorizeActivation({ authority: this.authority, receipt: this.stagedReceipt || null, grant }); this._current(token)
      if (!proof || canonical(authorityOf(proof.authority)) !== canonical(this.authority) || typeof proof.assertCurrent !== 'function') throw fail('profile_runtime_activation_refused')
      const current = proof.assertCurrent.bind(proof), assertCurrent = () => syncCall(current, undefined); assertCurrent(); this._current(token)
      if (this.state === 'staged' && !this.extrasCommitted) {
        try {
          const result = syncCall(this.commitExtras, this, { authority: this.authority, receipt: this.stagedReceipt, bundle: this.stagedExtras, grant })
          if (result?.committed !== true) throw fail('profile_runtime_extras_commit_unproved')
          this.extrasCommitted = true; this.stagedExtras = null
        } catch (error) { this.extrasCommitFailure = true; this.network = 'blocked'; throw error }
      }
      assertCurrent(); this._current(token); this.activeProof = assertCurrent; await this.context.setOffline(false); this._current(token); assertCurrent(); this.network = 'active'; this.state = 'active'
      return { state: this.state, authority: this.authority }
    } finally { if (this.operation === token) this.operation = null }
  }
  async _exporter(origin, token) {
    this._current(token); const page = await this._newPage(true), url = `${origin}/.well-known/hoai-private-profile/${randomUUID()}`
    this.privateURLs.set(page, url); await page.goto(url); this._current(token)
    await page.evaluate(`globalThis.__hoaiProfileStorage = (${createStorageAdapter.toString()})(); true`); return page
  }
  async _destroyPages() { await Promise.all(this.context.pages().map(page => page.close({ runBeforeUnload: false }))); if (this.context.pages().length) throw fail('profile_runtime_stop_failed'); this.privateURLs.clear() }
  async _terminalStop(token) {
    await this.browser.close(); this._current(token)
    if (this.browser.isConnected() || await this.assertProcessExited(this.processIdentity) !== true) throw fail('profile_runtime_process_alive')
  }
  async finalize({ context, source, destinationIdentity, contentKeyEpoch }) {
    context = structuredClone(context); this._context(context, 'source')
    source = { identity: structuredClone(source?.identity), signingPrivateKey: source?.signingPrivateKey, encryptionPrivateKey: source?.encryptionPrivateKey }; destinationIdentity = structuredClone(destinationIdentity)
    if (profileCrypto.identityFingerprint(source.identity) !== this.authority.keyFingerprint || contentKeyEpoch?.epoch !== this.authority.contentKeyEpoch || !Buffer.isBuffer(contentKeyEpoch.key) || contentKeyEpoch.key.length !== 32) throw fail('profile_runtime_identity_mismatch')
    this.assertCurrent(); portableState.validatePortableBundle(syncCall(this.preflightExtras, this, { authority: this.authority }))
    this._assertTransportQualified([...new Set([...this.knownOrigins,...this.markers.map(marker=>marker.origin).filter(Boolean)])])
    const token = this._admit(['active']); contentKeyEpoch = { epoch: contentKeyEpoch.epoch, key: Buffer.from(contentKeyEpoch.key) }; let destructive = false, plaintext, releaseExtras
    try {
      this.activeProof(); const barrier = await this.closeAndDrain(this.authority); this._current(token)
      if (barrier?.admissionClosed !== true || barrier?.drained !== true) throw fail('profile_runtime_drain_unproved')
      const { origins } = await this.assertMovable(); this._assertTransportQualified(origins); await this._assertDocumentSafety(); this.activeProof()
      const generation = await this.ledger.freeze(this.contextId); this._current(token)
      // Reinspect after all owned scripts pause, so an edit between the first
      // check and native pause cannot be discarded by the following destroy.
      await this._assertDocumentSafety(); this._current(token); this.activeProof()
      if (this.ledger.generation !== generation) throw fail('profile_activity_during_freeze')
      this._assertTransportQualified(origins)
      this.activeProof(); await this.assertTransferAllowed?.({ authority: this.authority, context: this.context }); this._current(token)
      this.network = 'quiescing'; await this.context.setOffline(true); await this.assertMovable(); this._current(token)
      if (this.ledger.generation !== generation) throw fail('profile_activity_during_freeze')
      destructive = true; this.state = 'quiescing'; await this._destroyPages()
      const targets = await this.ledger.inventory(this.contextId)
      for (const target of targets) await this.root.send('Target.closeTarget', { targetId: target.targetId })
      await until(async () => !(await this.root.send('Target.getTargets')).targetInfos.some(value => value.browserContextId === this.contextId), this.timeoutMs, 'profile_runtime_workers_running')
      this.ledger.assertIdle(this.contextId); if (this.inventoryFailure) throw fail(this.inventoryFailure)
      if (this.ledger.generation !== generation) throw fail('profile_activity_during_freeze')
      await this._confirmTransportStopped(token);this._current(token);this.activeProof()
      const extrasBarrier = syncCall(this.captureExtras, this, { authority: this.authority })
      if (typeof extrasBarrier?.release === 'function') releaseExtras = extrasBarrier.release.bind(extrasBarrier)
      if (!extrasBarrier || Object.keys(extrasBarrier).length !== 3 || typeof extrasBarrier.assertCurrent !== 'function' || !releaseExtras) throw fail('profile_runtime_extras_barrier_invalid')
      const assertExtras = extrasBarrier.assertCurrent.bind(extrasBarrier), extras = portableState.validatePortableBundle(extrasBarrier.bundle); syncCall(assertExtras, undefined)
      this.ledger.frozen = false; this.network = 'private'; const control = await this._exporter(origins[0] || 'https://hoai-profile.invalid', token), cdp = await this.context.newCDPSession(control)
      const capturedCookies = cookies((await cdp.send('Network.getAllCookies')).cookies), storage = []; let measured = Buffer.byteLength(JSON.stringify(capturedCookies))
      for (const origin of origins) { const page = origin === origins[0] ? control : await this._exporter(origin, token), state = await page.evaluate('globalThis.__hoaiProfileStorage.read()'); if (state.origin !== origin) throw fail('profile_storage_origin_mismatch'); measured += Buffer.byteLength(JSON.stringify(state)); if (measured > profileCrypto.MAX_PLAINTEXT_BYTES) throw fail('profile_runtime_state_too_large'); storage.push(state) }
      plaintext = portableState.encodePortableState({ schema: portableState.SCHEMA, cookies: capturedCookies, origins: storage, ...extras })
      if (canonical(cookies((await cdp.send('Network.getAllCookies')).cookies)) !== canonical(capturedCookies)) throw fail('profile_storage_changed_during_export')
      await this._terminalStop(token); this.network = 'blocked'; this.state = 'stopped'
      this.activeProof(); syncCall(assertExtras, undefined)
      const sealed = profileCrypto.sealCheckpoint({ plaintext, context, source, destinationIdentity, contentKeyEpoch }), hash = profileCrypto.manifestHash(sealed.manifest)
      const receipt = { version: 1, kind: 'source-stopped', profileId: context.profileId, transitionId: context.transitionId, manifestHash: hash, revision: context.revision, source: sourceOf(this.authority), stopped: true }
      const result = { checkpoint: sealed, receipt, signature: sign(null, Buffer.from(canonical(receipt)), source.signingPrivateKey).toString('base64url') }, saved = await this.checkpoint(result)
      this._current(token); this.activeProof(); syncCall(assertExtras, undefined); if (saved?.durable !== true || saved.manifestHash !== hash) throw fail('profile_checkpoint_not_durable'); return result
    } catch (error) {
      if (!destructive && this.state !== 'disposed') {
        try { this.activeProof(); await this.ledger.resume(); this.activeProof(); await this.context.setOffline(false); this._current(token); this.activeProof(); this.network = 'active' }
        catch { await this.dispose().catch(() => {}) }
      }
      else { this.network = 'blocked'; await this.browser.close().catch(() => {}) }
      throw error
    } finally { plaintext?.fill(0); contentKeyEpoch.key.fill(0); try { if (releaseExtras) syncCall(releaseExtras, undefined) } finally { if (this.operation === token) this.operation = null } }
  }
  async stage({ checkpoint, expectedContext, sourceIdentity, destination }) {
    this._context(expectedContext, 'destination')
    return this._stageImported({ checkpoint, expectedContext, sourceIdentity, destination, receiptTransitionId: expectedContext.transitionId })
  }
  async stageStoppedHead({ checkpoint, originalContext, sourceIdentity, destination, authorization }) {
    const proof = consumeStoppedHeadStageAuthorization(authorization, { authority: this.authority, checkpoint, originalContext, sourceIdentity, destination })
    return this._stageImported({ checkpoint, expectedContext: originalContext, sourceIdentity, destination, receiptTransitionId: proof.transitionId, stageCheck: proof.assertCurrent, readdress: proof.binding })
  }
  async _stageImported({ checkpoint, expectedContext, sourceIdentity, destination, receiptTransitionId, stageCheck = () => {}, readdress }) {
    expectedContext = structuredClone(expectedContext); checkpoint = structuredClone(checkpoint); sourceIdentity = structuredClone(sourceIdentity); destination = { identity: structuredClone(destination?.identity), signingPrivateKey: destination?.signingPrivateKey, encryptionPrivateKey: destination?.encryptionPrivateKey }
    syncCall(stageCheck, undefined); const token = this._admit(['new']), current = () => { this._current(token); syncCall(stageCheck, undefined) }; let opened
    try {
      opened = profileCrypto.openCheckpoint({ checkpoint, expectedContext, sourceIdentity, destination }); const payload = portableState.decodePortableState(opened.plaintext), restoredCookies = cookies(payload.cookies)
      if (this.context.pages().some(page => page !== this.bootstrapPage)) throw fail('profile_runtime_payload_invalid')
      const origins = new Set(); for (const state of payload.origins) { if (!originOf(state.origin) || state.origin !== originOf(state.origin) || origins.has(state.origin)) throw fail('profile_runtime_payload_invalid'); origins.add(state.origin) }
      await this.context.setOffline(true); current(); this.network = 'private'; const control = await this._exporter([...origins][0] || 'https://hoai-profile.invalid', token); current(); const cdp = await this.context.newCDPSession(control); current()
      const existingCookies = await cdp.send('Network.getAllCookies'); current(); if (existingCookies.cookies.length) throw fail('profile_runtime_destination_not_empty')
      for (const state of payload.origins) { const page = state.origin === [...origins][0] ? control : await this._exporter(state.origin, token); current(); const restored = await page.evaluate(`globalThis.__hoaiProfileStorage.restore(JSON.parse(${JSON.stringify(JSON.stringify(state))}))`); current(); if (restored !== true) throw fail('profile_runtime_storage_import_failed') }
      await cdp.send('Network.setCookies', { cookies: restoredCookies.map(cookieParams) }); current(); const imported = await cdp.send('Network.getAllCookies'); current(); if (canonical(cookies(imported.cookies)) !== canonical(restoredCookies)) throw fail('profile_runtime_cookie_import_mismatch')
      await this.ledger.freeze(this.contextId); current(); await this._destroyPages(); current()
      const targets = await this.root.send('Target.getTargets'); current(); if (targets.targetInfos.some(value => value.browserContextId === this.contextId)) throw fail('profile_runtime_workers_running')
      this.ledger.frozen = false; current(); this.network = 'blocked'; this.knownOrigins = origins; this.contentKeyEpoch = opened.contentKeyEpoch; opened.plaintext.fill(0); opened = null; this.state = 'staged'
      const receipt = { version: 1, kind: 'destination-staged', profileId: expectedContext.profileId, transitionId: receiptTransitionId, manifestHash: profileCrypto.manifestHash(checkpoint.manifest), revision: expectedContext.revision, destination: destinationOf(this.authority), stagedInactive: true }
      this.stagedReceipt = freeze(receipt); this.stagedExtras = freeze(portableState.validatePortableBundle({ passwordVault: payload.passwordVault, preferences: payload.preferences })); this.extrasCommitted = false
      this.stagedReaddress = readdress || null
      return { receipt, signature: sign(null, Buffer.from(canonical(receipt)), destination.signingPrivateKey).toString('base64url'), ...(readdress ? { readdress } : {}) }
    } catch (error) { await this.dispose(); throw error } finally { opened?.plaintext.fill(0); opened?.contentKeyEpoch.key.fill(0); if (this.operation === token) this.operation = null }
  }
  async dispose() {
    this.state = 'disposed'; this.operation = null; this.network = 'blocked'; this.activeProof = null; this.stagedExtras = null; this.stagedReaddress = null
    try { this.ledger.dispose(); await this.browser.close(); const exited = await this.assertProcessExited(this.processIdentity); if (this.browser.isConnected() || exited !== true) throw fail('profile_runtime_process_alive') }
    finally { try{await this.transportObserver?.dispose()}finally{this.contentKeyEpoch?.key.fill(0); this.contentKeyEpoch = null; this.context.removeListener('page', this.pageCreated)} }
  }
  // Explicit daemon termination only. This never creates a stopped receipt or
  // resumes authority. The immutable native PID/start token cannot be supplied
  // through constructor options, renderer messages or a mutable runtime field.
  async emergencyStopOwnedProcess() {
    const ownedStop = ownedProcesses.get(this)
    if (!ownedStop) throw fail('profile_owned_process_proof_required')
    this.state = 'disposed'; this.operation = null; this.network = 'blocked'; this.activeProof = null; this.stagedExtras = null; this.stagedReaddress = null
    try {
      await ownedStop.stop()
      this.ledger.dispose()
      // Playwright observes the actual owned browser exit. Observer cleanup is
      // best effort here; process exit, rather than a successful browser.close,
      // is the physical condition used by explicit termination.
      void Promise.resolve(this.transportObserver?.dispose()).catch(() => {})
      return { stopped: true, recoveryRequired: true }
    } finally { this.contentKeyEpoch?.key.fill(0); this.contentKeyEpoch = null; this.context.removeListener('page', this.pageCreated) }
  }
}
