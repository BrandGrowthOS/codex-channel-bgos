import { randomUUID } from 'node:crypto'
import { RemoteOwnerInput } from './remote-input.mjs'
import { RemoteCredentials } from './remote-credentials.mjs'

export const REMOTE_VIEW_FRAME_MAX_BYTES = 1024 * 1024
export const REMOTE_VIEW_COMMAND_MAX_BYTES = 16 * 1024
const READ_METHODS = new Set(['Page.startScreencast', 'Page.stopScreencast'])
const INPUT_METHODS = new Set(['hoai.input.acquire', 'hoai.input.release', 'hoai.input.focus', 'hoai.input.pointer', 'hoai.input.key'])
const CREDENTIAL_METHODS = new Set(['hoai.credentials.prepare', 'hoai.credentials.commit', 'hoai.credentials.save', 'hoai.credentials.cancel'])
const BROWSER_METHODS = new Set(['hoai.browser.navigate', 'hoai.browser.navigation', 'hoai.browser.tab', 'hoai.browser.close'])
export const REMOTE_BROWSER_TAB_MAX = 16
const captureParams = { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 }
const viewError = code => Object.assign(new Error('The browser action was refused.'), { code })
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const principal = value => typeof value === 'string' && /^user-[^\s\x00-\x1f\x7f]{1,251}$/.test(value)
const requestId = value => (Number.isSafeInteger(value) && value >= 0) || identifier(value)
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const displayUrl = (value, redact) => {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return 'about:blank'
    // The origin is public routing/offer authority. A short OTP can coincide
    // with hostname characters; replacing those makes metadata invalid.
    const shown = new URL(url.origin)
    shown.pathname = redact(url.pathname); shown.search = redact(url.search); shown.hash = redact(url.hash)
    return shown.href.slice(0, 4096)
  } catch { return 'about:blank' }
}

/** A viewer attaches only to an existing pool slot and never owns its browser. */
export class RemoteBrowserViews {
  constructor({ pool }) {
    this.pool = pool
    this.views = new Map()
    this.bySlot = new Map()
    this.identities = new WeakMap()
    this.input = new RemoteOwnerInput({
      current: view => this._current(view) ? this.pool.peek(view.context) : null,
      credentialPointer: (view, input) => this.credentials.pointer(view, input),
      revoked: (view, reason) => { this.credentials.clearSubmit(view); this._send(view, { method: 'hoai.input.revoked', params: view.remoteBrowser ? { reason } : {}, sessionId: view.sessionId, tabId: view.tabId }) },
    })
    this.credentials = new RemoteCredentials({
      current: view => this._current(view) ? this.pool.peek(view.context) : null,
      storageFor: view => view.engine.vault,
      revoked: view => this._send(view, { method: 'hoai.credentials.revoked', params: {}, sessionId: view.sessionId, tabId: view.tabId }),
    })
  }

  async open(input, { connectionId, sendFrame, sendClose }) {
    if (!identifier(input?.viewId) || !Number.isSafeInteger(input?.assistantId) || input.assistantId <= 0 ||
        !principal(input?.principal) || typeof connectionId !== 'string' || !connectionId) return false
    const context = { assistantId: input.assistantId, principal: input.principal }
    const slot = this.pool.peek(context)
    const remoteBrowser = input.remoteBrowser === true
    const page = (remoteBrowser ? slot?.engine?.selectedPage?.() : null) || slot?.engine?.pages().at(-1)
    if (!slot || slot.stopping || !page || page.isClosed()) {
      sendClose({ viewId: input.viewId, reason: 'no_session' })
      return false
    }
    // Duplicate opens cannot replace another connection's binding.
    if (this.views.has(input.viewId)) return false
    const slotKey = this.pool.slotKey(context)
    const previous = this.bySlot.get(slotKey)
    if (previous) void this.close(previous.viewId, previous.connectionId, 'viewer_replaced')
    let identity = this.identities.get(slot.engine)
    if (!identity) {
      identity = { sessionId: `remote_${randomUUID()}`, tabs: new WeakMap() }
      this.identities.set(slot.engine, identity)
    }
    let tabId = identity.tabs.get(page)
    if (!tabId) { tabId = `tab_${randomUUID()}`; identity.tabs.set(page, tabId) }
    const view = { viewId: input.viewId, connectionId, context, slotKey, engine: slot.engine, page,
      sessionId: identity.sessionId, tabId, sendFrame, sendClose, cdp: null,
      identity, remoteBrowser, remoteSessionClose: remoteBrowser && input.remoteSessionClose === true,
      closed: false, pendingFrame: null, latestFrame: null, queued: 0, tail: Promise.resolve(), capturing: false }
    // Reserve before attaching: a second open or disconnect can revoke startup.
    this.views.set(view.viewId, view)
    this.bySlot.set(slotKey, view)
    view.onGone = () => {
      if (view.switching || view.ending) return
      if (!view.remoteBrowser) { void this.close(view.viewId, connectionId, 'remote_target_gone'); return }
      const next = view.engine.pages().filter(candidate => candidate !== view.page && !candidate.isClosed()).at(-1)
      if (next) void this._switch(view, next).catch(() => this.close(view.viewId, connectionId, 'remote_target_gone'))
      else void this.close(view.viewId, connectionId, 'remote_target_gone')
    }
    view.onNavigation = frame => { if (!view.ending && frame === view.page.mainFrame()) { this.input.release(view, undefined, 'navigation'); void this.credentials.close(view); this._scheduleState(view) } }
    view.onLoaded = () => this._scheduleState(view)
    page.on('close', view.onGone)
    page.on('crash', view.onGone)
    page.on('framenavigated', view.onNavigation)
    page.on('domcontentloaded', view.onLoaded)
    page.on('load', view.onLoaded)
    view.browserContext = page.context()
    view.rosterClosers = new Map()
    view.watchRoster = candidate => {
      if (view.rosterClosers.has(candidate)) return
      const changed = () => { candidate.off('close', changed); view.rosterClosers.delete(candidate); this._scheduleState(view) }
      view.rosterClosers.set(candidate, changed)
      candidate.on('close', changed)
    }
    for (const candidate of view.engine.pages()) view.watchRoster(candidate)
    view.onPage = added => {
      if (!view.remoteBrowser || view.ending) return
      view.watchRoster(added)
      if (view.engine.pages().length > REMOTE_BROWSER_TAB_MAX) { void added.close().catch(() => {}); return }
      // A popup caused by this owner's click is part of the same browser.
      // An agent opening a tab while the owner only watches does not steal control.
      if (!view.switching && view.ownerLease) {
        const run = () => this._switch(view, added)
        view.tail = view.tail.then(run, run).catch(() => {})
      } else this._scheduleState(view)
    }
    view.browserContext.on?.('page', view.onPage)
    view.onSelectedPage = selected => {
      if (view.closed || view.ending) return
      this._scheduleState(view)
      if (!selected || selected === view.page || view.ownerLease || view.switching) return
      const run = () => this._switch(view, selected)
      view.tail = view.tail.then(run, run).catch(() => {})
    }
    if (view.remoteBrowser) view.engine.onSelectedPage = view.onSelectedPage
    try {
      view.cdp = await page.context().newCDPSession(page)
      if (!this._current(view)) { await this._detach(view); return false }
      const initialCdp = view.cdp
      view.onFrame = frame => { if (view.cdp === initialCdp) this._frame(view, frame) }
      view.cdp.on('Page.screencastFrame', view.onFrame)
      await this._loadingSignals(view)
      const metrics = await view.cdp.send('Page.getLayoutMetrics')
      const viewport = metrics.cssVisualViewport || metrics.visualViewport || page.viewportSize() || {}
      const width = viewport.clientWidth || viewport.width || 1280
      const height = viewport.clientHeight || viewport.height || 720
      view.width = width
      view.height = height
      const title = await page.title().catch(() => '')
      const redact = view.engine.resultRedactor?.() || (value => value)
      if (!this._current(view)) { await this.close(view.viewId, connectionId, 'remote_target_gone'); return false }
      const sent = this._send(view, { method: 'hoai.ready', params: { sessionId: view.sessionId, tabId,
        title: redact(title).slice(0, 300), url: displayUrl(page.url(), redact), width, height, remoteInput: true,
        ...(view.remoteBrowser ? { remoteBrowser: true } : {}),
        ...(view.remoteSessionClose ? { remoteSessionClose: true } : {}),
        ...(slot.engine.vault ? { remoteCredentials: true } : {}) } })
      await this._state(view)
      return sent
    } catch {
      await this.close(view.viewId, connectionId, 'view_start_failed')
      return false
    }
  }

  _current(view) {
    return !view.closed && this.views.get(view.viewId) === view &&
      this.pool.peek(view.context)?.engine === view.engine && !view.page.isClosed() &&
      view.engine.pages().includes(view.page)
  }

  _send(view, frame) {
    if (!this._current(view)) return false
    const message = { viewId: view.viewId, frame }
    if (bytes(message) > REMOTE_VIEW_FRAME_MAX_BYTES) return false
    return view.sendFrame(message) !== false
  }

  _tabId(view, page) {
    let id = view.identity.tabs.get(page)
    if (!id) { id = `tab_${randomUUID()}`; view.identity.tabs.set(page, id) }
    return id
  }

  async _loadingSignals(view) {
    const cdp = view.cdp, page = view.page, tabId = view.tabId
    const tree = await cdp.send('Page.getFrameTree')
    const frameId = tree.frameTree?.frame?.id
    let loaderId = tree.frameTree?.frame?.loaderId
    let waitingForCommit = false
    const current = event => this._current(view) && view.cdp === cdp && view.page === page && view.tabId === tabId && event.frameId === frameId
    view.onLoadingStart = event => { if (current(event)) { waitingForCommit = true; view.loadingRevision = (view.loadingRevision || 0) + 1; view.loading = true; this._scheduleState(view) } }
    view.onLoadingCommit = event => {
      if (current({ frameId: event.frame?.id }) && !event.frame.parentId) { loaderId = event.frame.loaderId; waitingForCommit = false }
    }
    view.onLoadingEnd = event => { if (current(event) && !waitingForCommit && event.loaderId === loaderId && event.name === 'load') { view.loading = false; this._scheduleState(view) } }
    view.onSameDocument = event => {
      if (!current(event)) return
      const loader = loaderId, revision = view.loadingRevision, generation = view.navigationGeneration
      void page.evaluate(() => document.readyState === 'complete').then(complete => {
        if (!complete || !current(event) || loader !== loaderId || revision !== view.loadingRevision || generation !== view.navigationGeneration) return
        waitingForCommit = false; view.loading = false; this._scheduleState(view)
      }).catch(() => {})
    }
    cdp.on('Page.frameStartedLoading', view.onLoadingStart)
    cdp.on('Page.frameNavigated', view.onLoadingCommit)
    cdp.on('Page.lifecycleEvent', view.onLoadingEnd)
    cdp.on('Page.navigatedWithinDocument', view.onSameDocument)
    await cdp.send('Page.enable')
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true })
  }

  _scheduleState(view) {
    if (!view.remoteBrowser || view.stateTimer || view.closed || view.switching || view.ending) return
    view.stateTimer = setTimeout(() => { view.stateTimer = null; void this._state(view).catch(() => {}) }, 50)
    view.stateTimer.unref?.()
  }

  async _state(view) {
    if (!view.remoteBrowser || !this._current(view) || view.switching || view.ending) return
    const page = view.page, cdp = view.cdp, tabId = view.tabId
    let history = {}
    try { history = await cdp.send('Page.getNavigationHistory') } catch {}
    const pages = view.engine.pages().filter(candidate => !candidate.isClosed()).slice(0, REMOTE_BROWSER_TAB_MAX)
    const tabs = await Promise.all(pages.map(async candidate => ({ tabId: this._tabId(view, candidate),
      title: (await candidate.title().catch(() => '')).slice(0, 300), url: candidate.url().slice(0, 4096),
      loading: candidate === page ? !!view.loading : false,
      ...(candidate === page ? { canGoBack: (history.currentIndex || 0) > 0,
        canGoForward: Number.isInteger(history.currentIndex) && history.currentIndex < (history.entries?.length || 0) - 1 } : {}) })))
    if (!this._current(view) || view.page !== page || view.cdp !== cdp || view.tabId !== tabId || view.switching || view.ending) return
    const redact = view.engine.resultRedactor?.() || (value => value)
    const params = { sessionId: view.sessionId, tabId, width: view.width, height: view.height,
      tabs: tabs.map(tab => ({ ...tab, title: redact(tab.title).slice(0, 300), url: displayUrl(tab.url, redact) })), activeIndex: pages.indexOf(page) }
    this._send(view, { method: 'hoai.browser.state', params, sessionId: view.sessionId, tabId })
  }

  async _switch(view, page) {
    if (view.closed || view.ending || page.isClosed() || !view.engine.pages().includes(page)) throw viewError('stale_target')
    try { await this._bind(view, page) }
    catch (error) {
      view.switching = false
      void this.close(view.viewId, view.connectionId, 'remote_target_gone')
      throw error
    }
  }

  async _bind(view, page) {
    view.switching = true
    this.input.release(view, undefined, 'target_changed')
    await this.credentials.close(view)
    const previous = view.page
    previous.off('close', view.onGone); previous.off('crash', view.onGone)
    previous.off('framenavigated', view.onNavigation); previous.off('load', view.onLoaded); previous.off('domcontentloaded', view.onLoaded)
    await view.ownerDrain?.cleanupPromise
    await this._detach(view, false)
    if (view.closed) { view.switching = false; throw viewError('stale_target') }
    await view.engine.selectPage?.(page)
    view.page = page; view.tabId = this._tabId(view, page)
    view.loading = false; view.navigationGeneration = (view.navigationGeneration || 0) + 1
    view.pendingFrame = null; view.latestFrame = null
    page.on('close', view.onGone); page.on('crash', view.onGone)
    page.on('framenavigated', view.onNavigation); page.on('load', view.onLoaded); page.on('domcontentloaded', view.onLoaded)
    view.cdp = await page.context().newCDPSession(page)
    if (!this._current(view)) { await this._detach(view, false); throw viewError('stale_target') }
    const cdp = view.cdp
    view.onFrame = frame => { if (view.cdp === cdp) this._frame(view, frame) }
    cdp.on('Page.screencastFrame', view.onFrame)
    await this._loadingSignals(view)
    const metrics = await cdp.send('Page.getLayoutMetrics')
    const viewport = metrics.cssVisualViewport || metrics.visualViewport || page.viewportSize() || {}
    view.width = viewport.clientWidth || viewport.width || 1280; view.height = viewport.clientHeight || viewport.height || 720
    view.switching = false
    await this._state(view)
    if (view.capturing) await cdp.send('Page.startScreencast', captureParams)
  }

  async _browser(view, method, params) {
    return this.input.controlled(view, params.leaseId, async () => {
      if (method === 'hoai.browser.tab') {
        const pages = view.engine.pages().filter(candidate => !candidate.isClosed())
        if (!['new', 'select', 'close'].includes(params.action) ||
            (params.action !== 'new' && (!Number.isInteger(params.index) || params.index < 0 || params.index >= pages.length))) throw viewError('invalid_browser_action')
        if (params.action !== 'new' && (!identifier(params.targetTabId) || this._tabId(view, pages[params.index]) !== params.targetTabId)) throw viewError('stale_target')
        if (params.action === 'new') {
          if (pages.length >= REMOTE_BROWSER_TAB_MAX) throw viewError('browser_tabs_full')
          view.switching = true
          let page
          try { page = await view.engine.newPage() } finally { view.switching = false }
          await this._switch(view, page)
        } else if (params.action === 'select') await this._switch(view, pages[params.index])
        else {
          const target = pages[params.index]
          if (target === view.page) {
            // Keep one usable page when the last tab is closed.
            let next = pages.find(candidate => candidate !== target)
            if (!next) { view.switching = true; try { next = await view.engine.newPage() } finally { view.switching = false } }
            await this._switch(view, next)
          }
          await target.close()
          await this._state(view)
        }
        return {}
      }
      if (method === 'hoai.browser.navigate') {
        let url
        try { url = new URL(params.url) } catch { throw viewError('invalid_browser_url') }
        if (typeof params.url !== 'string' || params.url.length > 4096 || url.username || url.password ||
            (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank')) throw viewError('invalid_browser_url')
        await this.credentials.close(view)
        await this._navigate(view, params.leaseId, page => page.goto(url.href, { waitUntil: 'commit', timeout: 30000 }))
      } else {
        if (!['back', 'forward', 'reload', 'stop'].includes(params.action)) throw viewError('invalid_browser_action')
        await this.credentials.close(view)
        if (params.action === 'stop') {
          view.navigationGeneration = (view.navigationGeneration || 0) + 1
          await view.cdp.send('Page.stopLoading')
          view.loading = false; this.input.release(view); await this._state(view)
        } else await this._navigate(view, params.leaseId, page => page[{ back: 'goBack', forward: 'goForward', reload: 'reload' }[params.action]]({ waitUntil: 'commit', timeout: 30000 }))
      }
      return {}
    })
  }

  async _endSession(view, frame) {
    if (!view.remoteSessionClose) throw viewError('session_close_unsupported')
    if (!frame.params || Object.keys(frame.params).some(key => key !== 'leaseId')) throw viewError('invalid_browser_action')
    let admitted, stopping
    const admission = new Promise(resolve => { admitted = resolve })
    try {
      await this.input.controlled(view, frame.params?.leaseId, () => {
        view.ending = true
        clearTimeout(view.stateTimer)
        stopping = this.pool.release(view.context, { expectedEngine: view.engine, beforeStop: async () => {
          // Do not drain our own controlled admission callback.
          await admission
          this.input.release(view)
          await this.credentials.close(view)
          await this.input.drain(view)
          if (view.ownerDrain?.active || view.ownerDrain?.cleanupFailed ||
              view.credentialDrain?.active || view.credentialDrain?.cleanupFailed) throw viewError('session_close_busy')
        } })
      })
    } finally { admitted() }
    try {
      if (await stopping !== true) throw viewError('stale_target')
      // engine.stop has completed its encrypted save and process shutdown.
      // This terminal receipt remains pinned to the admitted binding even
      // though _current is now false. It never rebinds a replacement view.
      const sent = this._terminalReply(view, frame, { result: { closed: true } })
      if (this.views.get(view.viewId) === view) await this.close(view.viewId, view.connectionId, 'session_ended')
      return sent
    } catch (error) {
      this._terminalReply(view, frame, { error: { code: error?.code || 'session_close_failed', message: 'The session close was not confirmed.' } })
      view.ending = false
      return false
    }
  }

  _terminalReply(view, frame, body) {
    if (view.closed || this.views.get(view.viewId) !== view || this.bySlot.get(view.slotKey) !== view) return false
    return view.sendFrame({ viewId: view.viewId, frame: { id: frame.id, sessionId: frame.sessionId, tabId: frame.tabId, ...body } }) !== false
  }

  async _navigate(view, leaseId, work) {
    const page = view.page, tabId = view.tabId
    const generation = view.navigationGeneration = (view.navigationGeneration || 0) + 1
    view.loading = true
    await this._state(view)
    const pending = this.input.physical(view, leaseId, () => work(page))
    view.navigationPending = pending
    // The command acknowledges dispatch. Loading remains observable without
    // blocking Stop behind network headers or a document lifecycle event.
    void pending.then(async () => {
      if (!this._current(view) || view.page !== page || view.tabId !== tabId || view.navigationGeneration !== generation) return
      const loadingRevision = view.loadingRevision
      const complete = await page.evaluate(() => document.readyState === 'complete')
      if (!this._current(view) || view.page !== page || view.tabId !== tabId || view.navigationGeneration !== generation || loadingRevision !== view.loadingRevision) return
      if (complete) view.loading = false
      this._scheduleState(view)
    }, () => {
      if (!this._current(view) || view.page !== page || view.tabId !== tabId || view.navigationGeneration !== generation) return
      view.loading = false; this.input.release(view); this._scheduleState(view)
    }).catch(() => {})
  }

  _frame(view, frame) {
    if (!this._current(view) || !Number.isSafeInteger(frame?.sessionId) || typeof frame?.data !== 'string') return
    if (bytes({ viewId: view.viewId, frame: { method: 'Page.screencastFrame', params: frame,
      sessionId: view.sessionId, tabId: view.tabId } }) > REMOTE_VIEW_FRAME_MAX_BYTES) {
      void view.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      return
    }
    // Keep one bounded latest frame while the owner paints. Dropping every
    // newer frame would leave a final static page change invisible forever.
    if (view.pendingFrame !== null) {
      if (view.latestFrame) void view.cdp.send('Page.screencastFrameAck', { sessionId: view.latestFrame.sessionId }).catch(() => {})
      view.latestFrame = frame
      return
    }
    view.pendingFrame = frame.sessionId
    const sent = this._send(view, { method: 'Page.screencastFrame', params: frame,
      sessionId: view.sessionId, tabId: view.tabId })
    if (!sent) {
      view.pendingFrame = null
      void view.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    }
  }

  async command(input, connectionId) {
    const view = this.views.get(input?.viewId)
    const frame = input?.frame
    if (!view || view.ending || view.connectionId !== connectionId || !this._current(view) || !frame ||
        bytes(input) > REMOTE_VIEW_COMMAND_MAX_BYTES || frame.sessionId !== view.sessionId || frame.tabId !== view.tabId) return false
    // Paint acknowledgement is an event and bypasses the command chain.
    if (frame.method === 'Page.screencastFrameAck') {
      if (frame.id !== undefined || !Number.isSafeInteger(frame.params?.sessionId) ||
          frame.params.sessionId !== view.pendingFrame) return false
      try {
        await view.cdp.send('Page.screencastFrameAck', { sessionId: frame.params.sessionId })
        const latest = view.latestFrame
        view.latestFrame = null
        view.pendingFrame = null
        if (latest && this._current(view)) this._frame(view, latest)
        return true
      }
      catch { await this.close(view.viewId, connectionId, 'remote_target_gone'); return false }
    }
    if (!requestId(frame.id)) return false
    const reply = body => this._send(view, { id: frame.id, ...body, sessionId: frame.sessionId, tabId: frame.tabId })
    if (!READ_METHODS.has(frame.method) && !INPUT_METHODS.has(frame.method) && !CREDENTIAL_METHODS.has(frame.method) && !(view.remoteBrowser && BROWSER_METHODS.has(frame.method))) {
      reply({ error: { code: 'view_read_only', message: 'This remote view accepts display commands only.' } })
      return false
    }
    if (view.queued >= 8) {
      reply({ error: { code: 'view_busy', message: 'The remote display command queue is full.' } })
      return false
    }
    view.queued++
    const run = async () => {
      let captureCdp = null, captureVersion
      try {
        if (!this._current(view) || view.ending) return false
        if (frame.tabId !== view.tabId) { reply({ error: { code: 'stale_target', message: 'The selected browser tab changed.' } }); return false }
        if (frame.method === 'hoai.browser.close') return await this._endSession(view, frame)
        if (BROWSER_METHODS.has(frame.method)) {
          reply({ result: await this._browser(view, frame.method, frame.params || {}) })
          return true
        }
        if (CREDENTIAL_METHODS.has(frame.method)) {
          const operation = frame.method.slice('hoai.credentials.'.length)
          reply({ result: await this.credentials[operation](view, frame.params || {}) })
          return true
        }
        if (INPUT_METHODS.has(frame.method)) {
          const operation = frame.method.slice('hoai.input.'.length)
          const result = operation === 'release'
            ? this.input.release(view, frame.params?.leaseId)
            : await this.input[operation](view, frame.params || {})
          reply({ result })
          return true
        }
        // The host owns capture bounds. Renderer supplied CDP parameters do
        // not get to allocate unbounded images or request another format.
        const params = frame.method === 'Page.startScreencast' ? captureParams : {}
        captureCdp = view.cdp
        captureVersion = view.captureVersion = (view.captureVersion || 0) + 1
        view.capturing = frame.method === 'Page.startScreencast'
        const result = await captureCdp.send(frame.method, params)
        if (view.cdp === captureCdp && view.captureVersion === captureVersion && !view.capturing) { view.pendingFrame = null; view.latestFrame = null }
        reply({ result: result || {} })
        return true
      } catch (error) {
        if (captureCdp && view.cdp !== captureCdp && view.captureVersion === captureVersion && this._current(view)) {
          reply({ result: {} })
          return true
        }
        reply({ error: { code: error?.code || 'view_command_failed', message: 'The remote browser command was refused or failed.' } })
        return false
      } finally { view.queued-- }
    }
    const work = view.tail.then(run, run)
    view.tail = work.then(() => {}, () => {})
    return work
  }

  async close(viewId, connectionId, reason = 'viewer_closed') {
    const view = this.views.get(viewId)
    if (!view || view.connectionId !== connectionId) return false
    this.input.release(view)
    void this.credentials.close(view)
    view.closed = true
    clearTimeout(view.stateTimer)
    this.views.delete(viewId)
    if (this.bySlot.get(view.slotKey) === view) this.bySlot.delete(view.slotKey)
    view.page.off('close', view.onGone)
    view.page.off('crash', view.onGone)
    view.page.off('framenavigated', view.onNavigation)
    view.page.off('load', view.onLoaded); view.page.off('domcontentloaded', view.onLoaded)
    view.browserContext.off?.('page', view.onPage)
    for (const [candidate, changed] of view.rosterClosers) candidate.off('close', changed)
    view.rosterClosers.clear()
    if (view.engine.onSelectedPage === view.onSelectedPage) view.engine.onSelectedPage = null
    view.sendClose({ viewId, reason })
    await this._detach(view)
    return true
  }

  async _detach(view, drainInput = true) {
    if (drainInput) await this.input.drain(view)
    await this.credentials.drain(view)
    const cdp = view.cdp
    view.cdp = null
    if (!cdp) return
    if (view.onFrame) cdp.off('Page.screencastFrame', view.onFrame)
    if (view.onLoadingStart) cdp.off('Page.frameStartedLoading', view.onLoadingStart)
    if (view.onLoadingCommit) cdp.off('Page.frameNavigated', view.onLoadingCommit)
    if (view.onLoadingEnd) cdp.off('Page.lifecycleEvent', view.onLoadingEnd)
    if (view.onSameDocument) cdp.off('Page.navigatedWithinDocument', view.onSameDocument)
    try { await cdp.send('Page.stopScreencast') } catch {}
    try { await cdp.detach() } catch {}
  }

  async closeConnection(connectionId) {
    await Promise.all([...this.views.values()].filter(view => view.connectionId === connectionId)
      .map(view => this.close(view.viewId, connectionId, 'host_disconnected')))
  }

  async stop() {
    await Promise.all([...this.views.values()].map(view => this.close(view.viewId, view.connectionId, 'host_stopped')))
  }
}
