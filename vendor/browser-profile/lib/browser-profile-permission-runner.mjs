import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const policy = require('./browser-host-core/policy.js'), settings = require('./browser-host-core/settings.js')
const METHODS = new Set(['browser_navigate', 'browser_click', 'browser_handle_dialog', 'browser_select_option', 'browser_file_upload', 'browser_pdf_save'])
const fail = code => Object.assign(new Error(code), { code })
const refused = code => ({ isError: true, content: [{ type: 'text', text: `${code}: The action did not run. Review its original page in HOAI before making another request.` }] })
const synchronous = callback => { const value = callback(); if (value?.then) { void Promise.resolve(value).catch(() => {}); throw fail('profile_permission_context_changed') }; if (value === false) throw fail('profile_permission_context_changed') }
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(fail('profile_permission_context_changed')) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
})

// One original signed RPC, never a reusable site grant. Page arguments stay
// local; the client sends only the fixed action kind, origin and request hash.
export class AgentRuntimePermissionRunner {
  #cleanupUnknown = false
  constructor({ client, now = Date.now, delay = pause }) {
    if (['request', 'read', 'consume', 'whenDrained'].some(name => typeof client?.[name] !== 'function') || typeof now !== 'function' || typeof delay !== 'function') throw fail('profile_permission_configuration_invalid')
    Object.defineProperties(this, { client: { value: client }, now: { value: now }, delay: { value: delay } })
  }
  assertCleanupConfirmed() { if (this.#cleanupUnknown) throw fail('profile_permission_cleanup_unconfirmed') }
  async run({ frame, binding, endpoint, engine, assertCurrent, signal, execute }) {
    this.assertCleanupConfirmed()
    if (typeof assertCurrent !== 'function' || typeof execute !== 'function' || typeof signal?.throwIfAborted !== 'function') throw fail('profile_permission_context_changed')
    synchronous(assertCurrent); signal.throwIfAborted()
    const snapshot = JSON.parse(JSON.stringify(frame)), message = snapshot.message, messageBytes = JSON.stringify(message), name = message?.params?.name, args = message?.params?.arguments ?? {}
    if (!METHODS.has(name)) return refused('recipient_handover_required')
    const page = engine.selectedPage(), url = page?.url?.(), started = this.now(), deadline = Math.min(started + 60000, Date.parse(snapshot.deadlineAt))
    if (!page || typeof url !== 'string' || typeof page.isClosed !== 'function' || typeof page.on !== 'function' || typeof page.removeListener !== 'function' ||
        !Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(deadline) || deadline <= started) throw fail('profile_permission_context_changed')
    let changed = false
    const attempted = []
    const onChanged = () => { changed = true }
    const classify = () => policy.classifyToolCall(name, args, { currentOrigin: policy.originOf(url) })
    const original = classify(), decision = policy.decide({ profile: 'signed-in', classification: original, grants: {}, settings: settings.defaultSettings(), preapproved: [] })
    const check = () => {
      synchronous(assertCurrent); signal.throwIfAborted(); const clock = this.now()
      if (changed || JSON.stringify(snapshot.message) !== messageBytes || page.isClosed() || engine.selectedPage() !== page || page.url() !== url || !Number.isSafeInteger(clock) || clock < started || clock >= deadline) throw fail('profile_permission_context_changed')
      const current = classify(), currentDecision = policy.decide({ profile: 'signed-in', classification: current, grants: {}, settings: settings.defaultSettings(), preapproved: [] })
      if (current.kind !== original.kind || current.origin !== original.origin || current.kind === 'credential' || currentDecision.verdict !== 'ask') throw fail('profile_permission_context_changed')
    }
    try {
      for (const event of ['framenavigated', 'close', 'crash']) { attempted.push(event); synchronous(() => page.on(event, onChanged)) }
      if (original.kind === 'credential' || decision.verdict !== 'ask') return refused('recipient_handover_required')
      check()
      const requested = await this.client.request({ frame: snapshot, binding, endpoint, origin: original.origin, assertCurrent: check, signal }); check()
      let status = requested.status, reads = 0
      while (status?.state === 'pending' || status?.state === 'outcome-unknown') {
        if (reads++ >= 60) return refused('recipient_permission_expired')
        await this.delay(Math.min(1000, deadline - this.now()), signal); check()
        // A lost creation acknowledgement may still own its HTTP body. The
        // original request is never resent and no new read overlaps that body.
        await this.client.whenDrained(); check()
        status = await this.client.read(requested.handle); check()
      }
      if (status?.state !== 'answered' || status.choice !== 'allow_once') return refused(status?.choice === 'deny' ? 'recipient_permission_denied' : 'recipient_permission_unconfirmed')
      check()
      let consumed
      try { consumed = await this.client.consume(requested.handle) }
      catch { return refused('recipient_permission_unconfirmed') }
      check()
      if (consumed?.state !== 'consumed' || consumed.choice !== 'allow_once') return refused('recipient_permission_unconfirmed')
      return await execute(name, args, signal)
    } finally {
      try { await this.client.whenDrained() } catch { this.#cleanupUnknown = true }
      for (const event of attempted) { try { synchronous(() => page.removeListener(event, onChanged)) } catch { this.#cleanupUnknown = true } }
      this.assertCleanupConfirmed()
    }
  }
}
