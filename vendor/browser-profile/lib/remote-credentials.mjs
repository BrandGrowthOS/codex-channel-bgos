import { randomUUID } from 'node:crypto'
import credentialCrypto from './remote-credentials-crypto.cjs'

const ERROR_MAP = {
  stale_target: 'credential_changed', credential_origin: 'unsafe_form', credential_offer_expired: 'credential_expired',
  credential_target_changed: 'credential_changed', invalid_credential_operation: 'credential_payload',
  credential_vault_locked: 'credential_locked', owner_control_busy: 'credential_busy', credential_envelope_invalid: 'credential_envelope',
  invalid_credential_input: 'credential_payload', vault_locked: 'credential_locked', vault_unavailable: 'credential_storage',
  unsafe_profile: 'credential_storage', legacy_profile_present: 'legacy_confirmation_required',
  legacy_profile_busy: 'credential_busy', legacy_consent_required: 'legacy_confirmation_required',
  invalid_passphrase: 'credential_payload', vault_unlock_failed: 'wrong_passphrase', login_not_found: 'credential_changed',
  invalid_login: 'credential_payload', vault_already_unlocked: 'credential_changed', browser_unavailable: 'credential_unavailable',
  vault_full: 'credential_storage', vault_write_failed: 'credential_storage', legacy_browser_active: 'credential_busy',
  legacy_cleanup_required: 'credential_storage', vault_cancelled: 'credential_cancelled', invalid_browser_state: 'credential_storage',
}
const ERROR_CODES = new Set(['credential_locked', 'credential_unavailable', 'credential_offer', 'credential_envelope',
  'credential_payload', 'credential_busy', 'credential_expired', 'credential_changed', 'unsafe_form', 'wrong_passphrase',
  'legacy_confirmation_required', 'credential_storage', 'credential_cancelled'])
const fail = code => Object.assign(new Error('The remote credential operation was refused or failed.'), {
  code: ERROR_CODES.has(code) ? code : ERROR_MAP[code] || 'credential_unavailable',
})
const sanitized = error => fail(error?.code)
const OPERATIONS = new Set(['unlock', 'login', 'fill', 'forget', 'store', 'field'])
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const loginValues = value => value && typeof value.username === 'string' && value.username.length <= 512 &&
  typeof value.password === 'string' && value.password.length > 0 && value.password.length <= 4096 &&
  !/[\u0000\r\n]/.test(value.username) && !/\u0000/.test(value.password)

function safeOrigin(value) {
  try {
    const url = new URL(value)
    if (url.username || url.password || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw fail('credential_origin')
    return url.origin
  } catch { throw fail('credential_origin') }
}

/** Runs in the page. The returned handle retains exact document and field identities. */
export function credentialDocument(captured, options) {
  if (!options) { options = captured; captured = null }
  const refused = () => ({ ok: false })
  const { origin, formRequired, fieldRequired, action = 'capture', values } = options
  const locationOK = () => window.top === window && location.origin === origin && !location.username && !location.password &&
    (options.allowUnlock || location.protocol === 'https:' || (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)))
  if (!locationOK() || (captured && captured.document !== document)) return refused()
  if (!formRequired && !fieldRequired && !captured?.field) return action === 'capture' ? { ok: true, document, origin } : { ok: true }
  const visible = input => {
    if (!input?.isConnected || input.disabled || input.readOnly || input.type === 'hidden' || !input.getClientRects().length) return false
    if (typeof input.checkVisibility === 'function' && !input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    for (let node = input; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none' || Number(style.opacity || 1) === 0) return false
    }
    const rect = input.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
  }
  const tokens = input => (input.getAttribute('autocomplete') || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const words = input => ['id', 'name', 'aria-label', 'placeholder'].map(name => input.getAttribute(name) || '').concat(
    Array.from(input.labels || []).map(label => label.textContent || ''),
    (input.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '')).join(' ')
  const prohibited = input => input.type === 'file' || tokens(input).some(token => /^(?:new-password|one-time-code|cc-.*)$/.test(token)) ||
    /sign[ -]?up|register|create.?account|confirm.?password|new.?password|one.?time|verification.?code|security.?code|(?:^|\W)otp(?:\W|$)|cvv|cvc|credit.?card|card.?number|api.?key|secret|token/i.test(words(input))
  const safeForm = form => {
    if (!form) return true
    if (!form.isConnected || form.ownerDocument !== document) return false
    try {
      const destination = new URL(form.action || location.href, location.href)
      if (destination.origin !== origin || destination.username || destination.password ||
          (form.target && form.target.toLowerCase() !== '_self')) return false
      return [...document.querySelectorAll('button, input')].filter(control => control.form === form &&
        (['submit', 'image'].includes(control.type) || (control.tagName === 'BUTTON' && !control.getAttribute('type')))).every(control => {
          const action = new URL(control.getAttribute('formaction') || form.action || location.href, location.href)
          return action.origin === origin && !action.username && !action.password &&
            (control.getAttribute('formtarget') || form.target || '_self').toLowerCase() === '_self'
        })
    } catch { return false }
  }
  const submit = (form, guard) => {
    if (!guard()) return refused()
    const hit = document.elementFromPoint(options.point.x, options.point.y)
    const submitter = hit?.closest('button, input')
    if (!submitter || !visible(submitter)) return refused()
    if (form ? submitter.form !== form || !['submit', 'image'].includes(submitter.type)
      : submitter.form || (submitter.tagName !== 'BUTTON' && submitter.type !== 'submit')) return refused()
    if (options.phase === 'down') captured.submitter = submitter
    if (options.phase === 'up' && captured.submitter !== submitter) return refused()
    return { ok: true }
  }
  if (fieldRequired || captured?.field) {
    const point = options.point
    if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight)) return refused()
    let field = captured?.field || (point ? document.elementFromPoint(point.x, point.y) : document.activeElement)
    if (field?.tagName === 'LABEL') field = field.control
    if (!(field instanceof HTMLInputElement) || !visible(field) || !safeForm(field.form) ||
        tokens(field).some(token => /^cc-/.test(token)) || /cvv|cvc|credit.?card|card.?number|api.?key|secret|token/i.test(words(field))) return refused()
    const kind = field.type === 'password' ? 'password' : tokens(field).includes('one-time-code') ||
      /passcode|(?:^|\W)otp(?:\W|$)|one.?time|verification.?code|security.?code/i.test(words(field)) ? 'otp' :
      ['text', 'email'].includes(field.type) && (tokens(field).some(token => ['username', 'email'].includes(token)) || /username|email|login/i.test(words(field))) ? 'username' : null
    if (!kind) return refused()
    const guard = () => locationOK() && visible(field) && safeForm(field.form) && (!captured ||
      captured.document === document && captured.field === field && captured.form === field.form && captured.kind === kind)
    if (!guard()) return refused()
    if (action === 'capture') return { ok: true, document, origin, field, form: field.form, kind }
    if (action === 'submit') return submit(field.form, guard)
    if (action !== 'fill') return { ok: true, kind }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter || typeof values?.value !== 'string') return refused()
    setter.call(field, values.value)
    for (const type of ['input', 'change']) { if (!guard()) return refused(); field.dispatchEvent(new Event(type, { bubbles: true })) }
    return guard() ? { ok: true } : refused()
  }
  const all = [...document.querySelectorAll('input')]
  const passwords = all.filter(input => input.type === 'password')
  if (passwords.length !== 1 || !visible(passwords[0])) return refused()
  const password = passwords[0], form = password.form
  if (!safeForm(form) || form && /sign[ -]?up|register|create.{0,20}account/i.test([form.id, form.name, form.getAttribute('aria-label')].join(' '))) return refused()
  const fields = all.filter(input => input.form === form)
  if (prohibited(password) || fields.some(input => input.type === 'file') || tokens(password).some(token => token !== 'current-password' && token !== 'off')) return refused()
  const candidates = fields.filter(input => input !== password && ['text', 'email'].includes(input.type))
  // An extra text field makes a login form ambiguous even if one field has a username hint.
  if (candidates.length > 1 || candidates.some(input => !visible(input) || prohibited(input) || tokens(input).some(token => !['username', 'email', 'off'].includes(token)))) return refused()
  const username = candidates[0] || null
  const guard = () => locationOK() && (!captured || (captured.document === document && captured.form === form &&
    captured.username === username && captured.password === password)) && (!username || visible(username) && username.form === form) && visible(password) &&
    password.form === form && safeForm(form)
  if (!guard()) return refused()
  if (action === 'capture') return { ok: true, document, origin, form, username, password }
  if (action === 'submit') {
    return submit(form, guard)
  }
  if (action !== 'fill') return { ok: true }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter || typeof values?.username !== 'string' || typeof values?.password !== 'string') return refused()
  // Both captured elements receive values before any page event can replace a field.
  if (username) setter.call(username, values.username)
  setter.call(password, values.password)
  for (const input of [username, password].filter(Boolean)) {
    if (!guard()) return refused()
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (!guard()) return refused()
    input.dispatchEvent(new Event('change', { bubbles: true }))
    if (!guard()) return refused()
  }
  return { ok: true }
}

/** Dedicated owner consent flow. Ordinary remote keyboard input retains its credential refusal. */
export class RemoteCredentials {
  constructor({ current, storageFor, revoked = (_view) => {}, now = Date.now, offerMs = 120_000, drainMs = 5_000, crypto = credentialCrypto }) {
    this.current = current
    this.storageFor = storageFor
    this.now = now
    this.offerMs = offerMs
    this.drainMs = drainMs
    this.crypto = crypto
    this.revoked = revoked
  }

  _slot(view) {
    let slot
    try { slot = this.current(view) } catch { throw fail('stale_target') }
    if (!slot || slot.engine !== view.engine) throw fail('stale_target')
    return slot
  }

  _assert(lease) {
    let valid = false
    try {
      valid = lease && !lease.released && this.now() < lease.expiresAt &&
        lease.view.credentialLease === lease && this._slot(lease.view).ownerInputLease === lease &&
        (lease.operation === 'unlock' ? new URL(lease.view.page.url()).origin === lease.documentOrigin : safeOrigin(lease.view.page.url()) === lease.origin)
    } catch {}
    if (!valid) {
      if (lease) this._release(lease, true)
      throw fail('credential_offer_expired')
    }
  }

  _timer(lease) {
    clearTimeout(lease.timer)
    lease.expiresAt = this.now() + this.offerMs
    lease.timer = setTimeout(() => this._release(lease, true), this.offerMs)
    lease.timer.unref?.()
  }

  _release(lease, notify = false) {
    if (!lease) return
    const first = !lease.released
    lease.released = true
    clearTimeout(lease.timer)
    lease.privateKey = null
    lease.pending = null
    if (lease.view.credentialLease === lease) lease.view.credentialLease = null
    lease.view.credentialDrain = lease
    this._finish(lease)
    if (first && notify) this.revoked(lease.view)
  }

  _finish(lease) {
    if (!lease.released || lease.active !== 0) return
    if (!lease.cleanupFailed && lease.slot.ownerInputLease === lease) lease.slot.ownerInputLease = null
    const handle = lease.handle
    lease.handle = null
    if (handle) void handle.dispose().catch(() => {})
    lease.resolveDrain()
  }

  async _document(lease, action = 'check', values) {
    this._assert(lease)
    let result
    try {
      result = await lease.handle.evaluate(credentialDocument, {
        origin: lease.documentOrigin, allowUnlock: lease.operation === 'unlock', formRequired: ['login', 'fill'].includes(lease.operation), action, values,
        fieldRequired: lease.operation === 'field',
      })
    } catch { throw fail('credential_target_changed') }
    this._assert(lease)
    if (result?.ok !== true) throw fail('credential_target_changed')
  }

  async prepare(view, { operation, point } = {}) {
    try { return await this._prepare(view, operation, point) }
    catch (error) { this._release(view.credentialLease); throw sanitized(error) }
  }

  async _prepare(view, operation, point) {
    if (!OPERATIONS.has(operation)) throw fail('invalid_credential_operation')
    if (point !== undefined && (operation !== 'field' || !point || Object.keys(point).length !== 2 ||
        !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= 4096 || point.y >= 4096)) throw fail('invalid_credential_input')
    const slot = this._slot(view)
    let storage, status
    try { storage = this.storageFor(view); status = storage?.status() } catch (error) { throw sanitized(error) }
    if (storage?.lastError) throw fail('credential_storage')
    if (!status || (!['unlock', 'field'].includes(operation) && !status.unlocked)) throw fail('credential_vault_locked')
    if (slot.ownerInputLease) throw fail('owner_control_busy')
    this.clearSubmit(view)
    let origin
    if (operation === 'unlock') { try { origin = safeOrigin(view.page.url()) } catch { origin = '' } }
    else origin = safeOrigin(view.page.url())
    const documentOrigin = new URL(view.page.url()).origin
    const lease = { view, slot, storage, origin, documentOrigin, operation, configured: !!status.configured, requestId: `credential_${randomUUID()}`,
      released: false, active: 1, handle: null, pending: null }
    lease.drained = new Promise(resolve => { lease.resolveDrain = resolve })
    slot.ownerInputLease = lease
    view.credentialLease = lease
    this._timer(lease)
    let timer
    try {
      const settled = await Promise.race([
        Promise.allSettled([...(slot.runningTools || [])]).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), this.drainMs) }),
      ])
      if (!settled) throw fail('owner_control_busy')
      this._assert(lease)
      lease.handle = await view.page.evaluateHandle(credentialDocument, {
        origin: documentOrigin, allowUnlock: operation === 'unlock', formRequired: ['login', 'fill'].includes(operation), action: 'capture',
        fieldRequired: operation === 'field', point,
      })
      await this._document(lease)
      const context = { v: 1, viewId: view.viewId, sessionId: view.sessionId, tabId: view.tabId,
        assistantId: view.context.assistantId, principal: view.context.principal, requestId: lease.requestId,
        operation, origin, expiresAt: lease.expiresAt }
      const created = this.crypto.createOffer(context)
      lease.offer = created.offer
      lease.privateKey = created.privateKey
      const entries = status.unlocked ? storage.list(origin).filter(entry => entry.origin === origin).slice(0, 20).map(entry => ({
        id: entry.id, origin: entry.origin, username: entry.username,
      })) : []
      const field = operation === 'field' ? await lease.handle.evaluate(target => ({ kind: target.kind })) : null
      this._assert(lease)
      return { offer: lease.offer, storage: { configured: !!status.configured, unlocked: !!status.unlocked, legacy: !!status.legacy }, entries,
        ...(field ? { field } : {}) }
    } catch (error) { this._release(lease); throw sanitized(error) }
    finally { clearTimeout(timer); lease.active--; this._finish(lease) }
  }

  async commit(view, envelope = {}) {
    const lease = view.credentialLease
    this._assert(lease)
    if (envelope.requestId !== lease.requestId || !lease.privateKey) {
      this._release(lease)
      throw fail('credential_offer_expired')
    }
    lease.active++
    let body, unlockAttempted = false, restorationAttempted = false
    try {
      const key = lease.privateKey
      lease.privateKey = null // An offer is consumed even when authenticated decryption refuses the envelope.
      try { body = this.crypto.openOffer(lease.offer, key, envelope) }
      catch { throw fail('credential_envelope_invalid') }
      await this._document(lease)
      if (lease.operation === 'unlock') {
        if (typeof body?.passphrase !== 'string' || body.passphrase.length < 12 || body.passphrase.length > 1024 ||
            (body.clearLegacy !== undefined && typeof body.clearLegacy !== 'boolean')) throw fail('invalid_credential_input')
        unlockAttempted = true
        await lease.storage.unlock(body.passphrase, { clearLegacy: body.clearLegacy === true })
        await this._document(lease)
        restorationAttempted = true
        if (!lease.configured && typeof lease.storage.retainCurrent === 'function') await lease.storage.retainCurrent(view.page.context())
        else await lease.storage.restore(view.page.context())
        await this._document(lease)
        this._release(lease)
        return { unlocked: true }
      }
      if (lease.operation === 'field') {
        if (typeof body?.value !== 'string' || body.value.length > 4096 || /\u0000/.test(body.value) || Object.keys(body).length !== 1) throw fail('invalid_credential_input')
        if (body.value) view.engine.registerSecret(body.value)
        await this._document(lease, 'fill', { value: body.value })
        await this._document(lease)
        this._grantSubmit(lease)
        this._release(lease)
        return { applied: true, pending: null }
      }
      if (!lease.storage.status().unlocked) throw fail('credential_vault_locked')
      if (lease.operation === 'store') {
        if (!loginValues(body)) throw fail('invalid_credential_input')
        view.engine.registerSecret(body.password)
        await lease.storage.saveLogin({ origin: lease.origin, username: body.username, password: body.password })
        await this._document(lease)
        this._release(lease)
        return { saved: true }
      }
      if (lease.operation === 'forget') {
        if (!identifier(body?.id)) throw fail('invalid_credential_input')
        await lease.storage.removeLogin(body.id, lease.origin)
        await this._document(lease)
        this._release(lease)
        return { removed: true }
      }
      let values = body
      if (lease.operation === 'fill') {
        if (!identifier(body?.id)) throw fail('invalid_credential_input')
        values = await lease.storage.readLogin(body.id, lease.origin)
      }
      if (!loginValues(values)) throw fail('invalid_credential_input')
      if (typeof view.engine.registerSecret !== 'function') throw fail('credential_storage')
      view.engine.registerSecret(values.password)
      await this._document(lease, 'fill', { username: values.username, password: values.password })
      await this._document(lease)
      if (lease.operation === 'login') {
        this._timer(lease)
        lease.pending = { pendingId: `pending_${randomUUID()}`, origin: lease.origin,
          username: values.username, password: values.password, expiresAt: lease.expiresAt }
        const { password: _password, ...pending } = lease.pending
        return { applied: true, pending }
      }
      this._grantSubmit(lease)
      this._release(lease)
      return { applied: true, pending: null }
    } catch (error) {
      this._release(lease)
      if (restorationAttempted) {
        // Restored auth may already live in page JS. Close the engine before
        // allowing agent work; clearing cookies alone cannot revoke that state.
        try {
          if (typeof view.engine.stop === 'function') await view.engine.stop()
          else await view.page.context().close()
        } catch { lease.cleanupFailed = true }
      }
      if (unlockAttempted) { try { await lease.storage.lock() } catch {} }
      throw sanitized(error)
    }
    finally { body = null; lease.active--; this._finish(lease) }
  }

  async save(view, { pendingId, save } = {}) {
    const lease = view.credentialLease
    this._assert(lease)
    if (!lease.pending || lease.pending.pendingId !== pendingId || typeof save !== 'boolean') {
      this._release(lease)
      throw fail('invalid_credential_input')
    }
    lease.active++
    try {
      if (save) {
        await this._document(lease)
        const { origin, username, password } = lease.pending
        await lease.storage.saveLogin({ origin, username, password })
        this._assert(lease)
      }
      await this._document(lease)
      this._grantSubmit(lease)
      return { saved: save }
    } catch (error) { throw sanitized(error)
    } finally { this._release(lease); lease.active--; this._finish(lease) }
  }

  cancel(view, { requestId } = {}) {
    const lease = view.credentialLease
    if (lease && requestId !== undefined && requestId !== lease.requestId) {
      this._release(lease)
      throw fail('credential_offer_expired')
    }
    this._release(lease)
    return {}
  }

  async drain(view) {
    const lease = view.credentialDrain || view.credentialLease
    if (!lease) return
    let timer
    try {
      await Promise.race([lease.drained, new Promise(resolve => { timer = setTimeout(resolve, this.drainMs) })])
    } finally { clearTimeout(timer) }
    // A physical operation that exceeded the drain deadline keeps its slot lease.
  }

  close(view) {
    this.clearSubmit(view)
    this._release(view.credentialLease, true)
    return this.drain(view)
  }

  _grantSubmit(lease) {
    this.clearSubmit(lease.view)
    const grant = { handle: lease.handle, origin: lease.documentOrigin, expiresAt: this.now() + 30_000, pressed: false, timer: null }
    lease.handle = null
    lease.view.credentialSubmit = grant
    grant.timer = setTimeout(() => this.clearSubmit(lease.view), 30_000)
    grant.timer.unref?.()
  }

  clearSubmit(view) {
    const grant = view.credentialSubmit
    view.credentialSubmit = null
    if (grant) { clearTimeout(grant.timer); void grant.handle.dispose().catch(() => {}) }
  }

  async pointer(view, input) {
    const grant = view.credentialSubmit
    if (!grant || this.now() >= grant.expiresAt || !['down', 'up', 'move'].includes(input.type) ||
        (input.button && input.button !== 'left') || (input.type === 'up' && !grant.pressed) ||
        (input.type === 'down' && grant.pressed)) return false
    try {
      this._slot(view)
      const result = await grant.handle.evaluate(credentialDocument, { origin: grant.origin, formRequired: true,
        action: 'submit', phase: input.type, point: { x: input.x, y: input.y } })
      if (view.credentialSubmit !== grant || this.now() >= grant.expiresAt || result?.ok !== true) return false
      if (input.type === 'down') grant.pressed = true
      if (input.type === 'up') this.clearSubmit(view)
      return true
    } catch { this.clearSubmit(view); return false }
  }
}
