import { randomUUID } from 'node:crypto'

export const OWNER_INPUT_LEASE_MS = 10_000
export const OWNER_INPUT_FOCUS_MS = 2_000
export const OWNER_CONTROL_MESSAGE = 'The owner currently controls this browser. This request did not start and is safe to retry after control returns. The owner can hand control back, or ordinary pane input returns control after ten seconds without a click. Wait for any protected login window or active owner input to finish.'
const DRAIN_TIMEOUT_MS = 5_000
const inputError = (code, message) => Object.assign(new Error(message), { code })
const NAMED_KEYS = new Map([
  ['Backspace', 8], ['Tab', 9], ['Enter', 13], ['Escape', 27], ['Home', 36], ['End', 35],
  ['ArrowLeft', 37], ['ArrowUp', 38], ['ArrowRight', 39], ['ArrowDown', 40], ['Delete', 46],
])

/** Reserve before running work, and retain it until the physical promise settles. */
export function runAgentBrowserWork(slot, work) {
  if (slot.stopping) throw inputError('browser_stopping', 'The browser session is ending. This request did not start.')
  if (slot.ownerInputLease) throw inputError('owner_control', OWNER_CONTROL_MESSAGE)
  slot.runningTools ||= new Set()
  const pending = Promise.resolve().then(() => {
    if (slot.stopping) throw inputError('browser_stopping', 'The browser session is ending. This request did not start.')
    if (slot.ownerInputLease) throw inputError('owner_control', OWNER_CONTROL_MESSAGE)
    return work()
  })
  slot.runningTools.add(pending)
  void pending.finally(() => slot.runningTools.delete(pending)).catch(() => {})
  return pending
}

/** Runs in the remote document. Unknown and credential elements are never safe for typing. */
export function inspectInputElement(element, point = null) {
  if (element && !element.nodeType && element.point) { point = element.point; element = null }
  let target = point ? document.elementFromPoint(point.x, point.y) : element
  while (target?.shadowRoot?.activeElement && !point) target = target.shadowRoot.activeElement
  if (!target || !target.isConnected) return { allowed: false, credential: false, editable: false }
  if (point) {
    for (let depth = 0; depth < 8 && target?.shadowRoot; depth++) {
      const inner = target.shadowRoot.elementFromPoint(point.x, point.y)
      if (!inner || inner === target) break
      target = inner
    }
    // Descendants and labels inherit the associated control's credential policy.
    target = target.closest?.('button, input, textarea, select, label') || target
    if (target.tagName === 'LABEL') target = target.control || target
  }
  const tag = target.tagName?.toLowerCase()
  if (tag === 'iframe' || tag === 'frame') return { allowed: false, credential: true, editable: false }
  const autocomplete = (target.getAttribute?.('autocomplete') || '').toLowerCase()
  const labelled = (target.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)?.textContent || '').join(' ')
  const words = [...['id', 'name', 'aria-label', 'placeholder'].map(name => target.getAttribute?.(name) || ''),
    ...Array.from(target.labels || []).map(label => label.textContent || ''), labelled].join(' ')
  const type = (target.getAttribute?.('type') || 'text').toLowerCase()
  const credential = type === 'password' || type === 'file' ||
    /(?:^|\s)(?:current-password|new-password|one-time-code|username|webauthn|cc-[a-z-]+)(?:\s|$)/.test(autocomplete) ||
    /password|passcode|(?:^|[^a-z])otp(?:[^a-z]|$)|one.?time|verification.?code|security.?code|cvv|cvc|credit.?card|card.?number|api.?key|secret|token/i.test(words) ||
    !!target.form?.querySelector('input[type="password"]')
  const editable = !target.disabled && !target.readOnly &&
    ((tag === 'input' && ['text', 'search', 'url', 'email', 'tel', 'number'].includes(type)) || tag === 'textarea' || target.isContentEditable)
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return { allowed: !credential && editable && (point || active === target), credential, editable }
}

/** Only accepted clicks extend the owner lease; other input cannot delay handback. */
export class RemoteOwnerInput {
  constructor({ current, revoked = (_view) => {}, credentialPointer = async (_view, _input) => false, now = Date.now, leaseMs = OWNER_INPUT_LEASE_MS, focusMs = OWNER_INPUT_FOCUS_MS }) {
    this.current = current
    this.revoked = revoked
    this.credentialPointer = credentialPointer
    this.now = now
    this.leaseMs = leaseMs
    this.focusMs = focusMs
  }

  async acquire(view) {
    const slot = this._slot(view)
    if (view.ownerLease) this.release(view)
    if (slot.ownerInputLease) throw inputError('owner_control_busy', 'Another owner input lease is active.')
    const lease = { id: `lease_${randomUUID()}`, view, slot, expiresAt: this.now() + this.leaseMs,
      pending: true, timer: null, focus: null, released: false, active: 0, heldButtons: new Map(), cleanupFailed: false }
    slot.ownerInputLease = lease
    view.ownerLease = lease
    this._touch(lease)
    let timer
    try {
      const settled = await Promise.race([
        Promise.allSettled([...(slot.runningTools || [])]).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), DRAIN_TIMEOUT_MS) }),
      ])
      if (!settled) throw inputError('owner_control_busy', 'An agent action is still running. Try again after it finishes.')
      this._lease(view, lease.id)
      lease.pending = false
      return { leaseId: lease.id, expiresAt: lease.expiresAt }
    } catch (error) {
      this.release(view)
      throw error
    } finally { clearTimeout(timer) }
  }

  _slot(view) {
    const slot = this.current(view)
    if (!slot || slot.engine !== view.engine) throw inputError('stale_target', 'This remote browser is no longer available.')
    return slot
  }

  _lease(view, id) {
    const lease = view.ownerLease
    if (!lease || lease.id !== id || lease.released || this.now() >= lease.expiresAt ||
        this._slot(view).ownerInputLease !== lease) {
      if (lease) this.release(view, undefined, 'expired')
      throw inputError('owner_lease_expired', 'Take control again before sending input.')
    }
    return lease
  }

  _touch(lease) {
    clearTimeout(lease.timer)
    lease.expiresAt = this.now() + this.leaseMs
    lease.timer = setTimeout(() => this.release(lease.view, undefined, 'expired'), this.leaseMs)
    lease.timer.unref?.()
  }

  _clearFocus(lease) {
    const focus = lease.focus
    lease.focus = null
    if (focus?.handle) void focus.handle.dispose().catch(() => {})
  }

  async controlled(view, leaseId, work) {
    const lease = this._lease(view, leaseId)
    lease.active++
    this._clearFocus(lease)
    try { return await work() }
    finally { this._settle(lease) }
  }

  physical(view, leaseId, work) {
    const lease = this._lease(view, leaseId)
    lease.active++
    const pending = Promise.resolve().then(work)
    void pending.finally(() => this._settle(lease)).catch(() => {})
    return pending
  }

  release(view, id, reason = 'released') {
    const lease = view.ownerLease
    if (!lease || (id !== undefined && id !== lease.id)) return {}
    lease.released = true
    clearTimeout(lease.timer)
    this._clearFocus(lease)
    if (!lease.drained) lease.drained = new Promise(resolve => { lease.drainResolve = resolve })
    view.ownerDrain = lease
    // A drag interrupted by hide, blur, disconnect, or expiry must not leave
    // the remote browser with a pressed mouse button when the agent resumes.
    const held = [...lease.heldButtons.entries()]
    lease.heldButtons.clear()
    if (held.length) {
      lease.active++
      const cleanup = held.map(([button, position]) => view.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', button, clickCount: 1, x: position.x, y: position.y,
      }))
      lease.cleanupPromise = Promise.all(cleanup).catch(() => { lease.cleanupFailed = true }).finally(() => this._settle(lease))
    }
    if (lease.active === 0 && !lease.cleanupFailed && lease.slot.ownerInputLease === lease) lease.slot.ownerInputLease = null
    if (lease.active === 0) lease.drainResolve?.()
    if (view.ownerLease === lease) view.ownerLease = null
    this.revoked(view, reason)
    return {}
  }

  async focus(view, { leaseId }) {
    const lease = this._lease(view, leaseId)
    this._clearFocus(lease)
    const handle = await view.page.evaluateHandle(() => {
      let element = document.activeElement
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
      return element
    })
    try {
      const result = await handle.evaluate(inspectInputElement)
      this._lease(view, leaseId)
      if (result.allowed !== true || result.credential || result.editable !== true) {
        await handle.dispose()
        return { allowed: false, focusToken: null, credential: !!result.credential, editable: !!result.editable }
      }
      const token = `focus_${randomUUID()}`
      lease.focus = { token, handle, expiresAt: this.now() + this.focusMs }
      return { allowed: true, focusToken: token, credential: false, editable: true }
    } catch (error) { await handle.dispose().catch(() => {}); throw error }
  }

  async pointer(view, input) {
    const lease = this._lease(view, input.leaseId)
    lease.active++
    try {
    this._clearFocus(lease)
    if (!['down', 'up', 'move', 'wheel'].includes(input.type) || !Number.isFinite(input.x) || !Number.isFinite(input.y) ||
        input.x < 0 || input.y < 0 || input.x >= (view.width || 100000) || input.y >= (view.height || 100000) ||
        (input.button !== undefined && !['left', 'middle', 'right'].includes(input.button)) ||
        ['deltaX', 'deltaY'].some(key => input[key] !== undefined && (!Number.isFinite(input[key]) || Math.abs(input[key]) > 4096))) {
      throw inputError('invalid_input', 'Invalid pointer input.')
    }
    const hit = await view.page.evaluate(inspectInputElement, { point: { x: input.x, y: input.y } })
    this._lease(view, input.leaseId)
    const heldSubmit = [...lease.heldButtons.values()].some(position => position.submit)
    const credentialSubmit = (hit.credential || heldSubmit) && await this.credentialPointer(view, input)
    this._lease(view, input.leaseId)
    if ((hit.credential || heldSubmit) && !credentialSubmit) {
      if (heldSubmit) this.release(view)
      throw inputError('credential_field', 'Remote input to credential fields is disabled.')
    }
    const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' }[input.type]
    const params = { type, x: input.x, y: input.y, button: input.button || (input.type === 'move' || input.type === 'wheel' ? 'none' : 'left'),
      ...(input.type === 'down' || input.type === 'up' ? { clickCount: 1 } : {}),
      ...(input.type === 'wheel' ? { deltaX: input.deltaX || 0, deltaY: input.deltaY || 0 } : {}) }
    if (input.type === 'down') lease.heldButtons.set(params.button, credentialSubmit ? { x: -1, y: -1, submit: true } : { x: input.x, y: input.y })
    if (input.type === 'move') for (const [button, position] of lease.heldButtons) if (!position.submit) lease.heldButtons.set(button, { x: input.x, y: input.y })
    const buttonMask = { left: 1, right: 2, middle: 4 }
    params.buttons = [...lease.heldButtons.keys()].reduce((mask, button) =>
      mask | (input.type === 'up' && button === params.button ? 0 : buttonMask[button]), 0)
    await view.cdp.send('Input.dispatchMouseEvent', params)
    if (input.type === 'up') lease.heldButtons.delete(params.button)
    this._lease(view, input.leaseId)
    if (input.type === 'down') this._touch(lease)
    return {}
    } finally { this._settle(lease) }
  }

  async key(view, { leaseId, focusToken, key }) {
    const lease = this._lease(view, leaseId)
    const cdp = view.cdp
    lease.active++
    try {
    const focus = lease.focus
    lease.focus = null
    if (!focus || focus.token !== focusToken || this.now() >= focus.expiresAt) {
      if (focus?.handle) await focus.handle.dispose().catch(() => {})
      throw inputError('stale_focus', 'Check the focused field again before typing.')
    }
    try {
      if (typeof key !== 'string' || (!NAMED_KEYS.has(key) && ([...key].length !== 1 || /[\u0000-\u001f\u007f]/.test(key)))) {
        throw inputError('invalid_input', 'Unsupported remote key.')
      }
      const policy = await focus.handle.evaluate(inspectInputElement)
      this._lease(view, leaseId)
      if (!policy.allowed || policy.credential || !policy.editable) throw inputError('credential_field', 'The focused field cannot receive remote text.')
      if (NAMED_KEYS.has(key)) {
        const params = { key, windowsVirtualKeyCode: NAMED_KEYS.get(key) }
        try { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params }) }
        finally {
          try { await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }) }
          catch (error) { lease.cleanupFailed = true; throw error }
        }
      } else await cdp.send('Input.insertText', { text: key })
      this._lease(view, leaseId)
      return {}
    } finally { await focus.handle.dispose().catch(() => {}) }
    } finally { this._settle(lease) }
  }

  _settle(lease) {
    lease.active--
    if (lease.released && lease.active === 0 && !lease.cleanupFailed && lease.slot.ownerInputLease === lease) lease.slot.ownerInputLease = null
    if (lease.released && lease.active === 0) lease.drainResolve?.()
  }

  async drain(view) {
    const lease = view.ownerDrain
    if (!lease?.drained) return
    let timer
    try {
      await Promise.race([lease.drained, new Promise(resolve => {
        timer = setTimeout(() => { lease.cleanupFailed = true; resolve() }, DRAIN_TIMEOUT_MS)
      })])
    } finally { clearTimeout(timer) }
  }
}
