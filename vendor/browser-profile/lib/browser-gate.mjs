/**
 * THE DAEMON BROWSER HOST'S PERMISSION GATE.
 *
 * WHY THIS IS NOT A COPY OF THE DESKTOP'S GATE. The rules are (see
 * `browser-host-core/policy.js`, vendored byte-identical so the two hosts
 * cannot drift on what counts as a credential). The MACHINERY cannot be,
 * because the two hosts have different surfaces:
 *
 *   The desktop has a pane. Its gate opens as a STRIP with a 60 second
 *   countdown the owner is probably looking at, and only an unanswered strip
 *   PARKS to a card in the owner's chat.
 *
 *   This host has NO pane. Nobody is looking at this machine, which is the
 *   whole point of the feature. So there is no strip phase at all: a gate
 *   posts its card the moment it is raised, and the card is the only surface
 *   it will ever have.
 *
 * HOW THE ANSWER GETS BACK, and this is the part that did not exist until
 * now. `browser_gate_answer` is emitted to the owner's PERSON room and
 * deliberately never to an agent socket. This host joins only
 * `browser-host:<assistantId>`, so it cannot hear that event: it could post a
 * card and then wait out the entire park for a frame that can never arrive.
 * So it ASKS instead, polling `GET /api/v1/browser/gate/:gateId`, which
 * answers open, answered, expired or unknown for ONE gate the caller names,
 * scoped to the caller's account AND to the assistant its host serves.
 *
 * THE ACTION RUNS AT MOST ONCE. A gate that outlives its call is PARKED: the
 * call returns `gate_parked` with the gate id and the card stays live, and
 * `hoai_browser_wait_gate` re-attaches to the same gate. Both the original
 * call and every re-attach await ONE held continuation, so an owner who
 * allows a click gets one click, no matter how many waiters were queued on
 * it. That mirrors the desktop's `entry.done` for the same reason.
 *
 * FAIL CLOSED EVERYWHERE. An unreachable backend, an expired card, a gate the
 * server has never heard of, a kind the card route cannot carry, a poll that
 * runs out of park: every one of them ends the gate DENIED and the action does
 * not run. The only path that runs the action is the server saying, in
 * writing, that the owner answered with an allowing choice.
 */

/**
 * The gate kinds a CARD can carry (backend browser-gate-card.ts
 * BROWSER_GATE_KINDS). `policy.js` has one more, `vision`, which the card
 * route would reject with a 400, so a vision gate fails closed here with a
 * sentence rather than being posted and bouncing. Vision is off by default on
 * this host (settings.allowVision), so reaching this is already unusual.
 */
export const CARD_GATE_KINDS = new Set(['navigate', 'write', 'sensitive', 'credential', 'download', 'upload', 'evaluate'])

/** The default and the ceiling the tool schema advertises. */
export const GATE_DEFAULT_WAIT_S = 60
export const GATE_WAIT_MAX_S = 1800

/**
 * How long ONE call may hold before it parks.
 *
 * IT MUST SIT INSIDE A DOCUMENTED ORDERING, which is the reason for the
 * number rather than a feel for it (agent-browser-relay.service.ts):
 *
 *   backend host deadline  130 s   RELAY_HOST_TIMEOUT_MS
 *   > relay call cap       120 s   RELAY_CALL_CAP_MS
 *   > THIS                 110 s
 *   > default gate wait     60 s   GATE_DEFAULT_WAIT_S
 *
 * BELOW the cap, so the agent gets this host's `gate_parked` with a usable
 * gate id rather than the relay's `host_timeout`, which names nothing it can
 * wait on. ABOVE the default wait, so an ordinary 60 second gate RESOLVES
 * INSIDE ITS CALL, the way the desktop's 60 second strip does, instead of
 * parking a few seconds before its own deadline and sending the agent back
 * for a gate that is about to expire.
 *
 * This shipped at 55 s, under the default wait, so every ordinary gate parked
 * and no agent ever got an answer in the call that asked. The tests did not
 * catch it because they all pass `attachMs` explicitly; the ordering guard
 * below is what catches it now.
 */
export const GATE_ATTACH_MS = 110_000

/** The relay's own cap, which this must stay under (bin/hoai-browser-host.mjs). */
export const RELAY_CALL_CAP_MS = 120_000

/** How long a finished gate's result is kept for a late re-attach. */
export const GATE_RESULT_HOLD_MS = 15 * 60_000

/** How often the host asks the server what the owner said. */
export const GATE_POLL_MS = 2_000

/** A re-attach waits at most this long before parking again. */
export const GATE_REATTACH_MS = 90_000

/** The choices that mean the owner said yes. */
export const ALLOWING_CHOICES = new Set(['allow_once', 'allow_session', 'always_allow', 'trust_site'])

/**
 * A gate id in the shape the backend's BROWSER_GATE_ID_PATTERN accepts
 * (`g_` plus 4 to 64 of base64url). The desktop's `newId("g")` mints the same
 * shape; a mismatch is a 400 on the card post, so the pattern is pinned by a
 * test rather than trusted to a comment.
 */
export function newGateId(randomBytes) {
  return `g_${randomBytes(18).toString('base64url')}`
}

/**
 * The remaining park in WHOLE seconds, at least 1, at most the ceiling: what
 * the card's `waitSeconds` must be (`@Min(1) @Max(1800)`), so a card posted
 * late in a park carries the deadline the HOST is actually keeping rather
 * than the one the call started with.
 */
export function remainingWaitSeconds(msLeft) {
  return Math.max(1, Math.min(GATE_WAIT_MAX_S, Math.ceil(msLeft / 1000)))
}

/** The wait a tool call asked for, clamped, with the default for an absent one. */
export function waitSecondsFrom(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return GATE_DEFAULT_WAIT_S
  return Math.max(1, Math.min(GATE_WAIT_MAX_S, Math.floor(n)))
}

/**
 * What the agent is told when its action did not run. The wording follows the
 * desktop's `_deniedMessage` so an agent that has browsed on one host is not
 * relearning the vocabulary on the other.
 */
export function deniedMessage(reason, waitSeconds) {
  if (reason === 'gate_timeout') {
    return `The owner did not answer within ${waitSeconds} seconds; the request expired and the action did not run. Explain what you need and ask them; do not retry the same action.`
  }
  if (reason === 'session_closed') return 'The browser session closed before the owner answered; the action did not run.'
  if (reason === 'card_unreachable') {
    return 'The owner could not be asked: this machine could not reach their HOAI account to post the permission request, so the action did not run. Tell them the machine is offline and try again later.'
  }
  if (reason === 'gate_lost') {
    return 'The permission request is no longer on record with HOAI, so the action did not run and nobody was asked. Explain what you need and ask them.'
  }
  if (reason === 'kind_unsupported') {
    return 'This kind of permission cannot be asked for on this machine, so the action did not run. Ask the owner to do it in their own browser.'
  }
  return 'The owner denied this action. Explain and ask; do not retry the same action.'
}

/**
 * One gate's life, from raise to answer.
 *
 * Deliberately holds no browser and no policy: it is handed `postCard` and
 * `readGate` (the two backend calls), a clock and a sleep, so every branch
 * above can be driven in a unit test without a network, a browser or a wait.
 */
/**
 * @typedef {object} GateKeeperOptions
 * @property {(card: Record<string, unknown>) => Promise<boolean>} postCard
 * @property {(gateId: string, assistantId: number) => Promise<{state: string, choice: string|null}|null>} readGate
 * @property {(n: number) => Buffer} randomBytes
 * @property {() => number} [now]
 * @property {(ms: number) => Promise<unknown>} sleep
 * @property {(ms: number) => Promise<unknown>} [backgroundSleep]
 * @property {(line: string) => void} [log]
 * @property {number} [pollMs]
 */

/**
 * @typedef {object} RaiseOptions
 * @property {string} key the browser this gate belongs to (the profile dir)
 * @property {number} assistantId
 * @property {string} kind
 * @property {string|null} [origin]
 * @property {string} summary
 * @property {string|null} [agentName]
 * @property {string|null} [purpose]
 * @property {number} [waitSeconds]
 * @property {string[]} choices the buttons the owner gets, from policy.gateChoices
 * @property {(() => unknown)|null} [action] run once, and only on an allow
 * @property {number} [attachMs] how long THIS call may hold before parking
 * @property {number} [pollMs] how often to read this card (a long notice can read slower)
 * @property {(gate: Record<string, unknown>) => void} [onRaised] told the gate (and its id) the moment the browser is reserved for it
 * @property {(gate: Record<string, unknown>) => void} [onPosted] told once the card is really in the owner's chat
 */

export class GateKeeper {
  /** @param {GateKeeperOptions} options */
  constructor({ postCard, readGate, randomBytes, now = Date.now, sleep, backgroundSleep, log = () => {}, pollMs = GATE_POLL_MS }) {
    this._postCard = postCard
    this._readGate = readGate
    this._randomBytes = randomBytes
    this._now = now
    this._sleep = sleep
    /**
     * The wait BETWEEN polls, which nobody is awaiting.
     *
     * It is separate from `_sleep` because it must not hold the process
     * open. A park can be thirty minutes; its poll loop is background work,
     * and a timer for it kept the whole event loop alive, so a host told to
     * stop would sit there until every open gate expired, and a test file
     * could not exit at all (it hung for sixty seconds, which is how this
     * was found). An unref'd timer still fires while anything else is
     * running and stops being a reason to keep running on its own, which is
     * exactly the semantics a background poll wants.
     *
     * `_sleep` stays ref'd because a CALLER is awaiting it: parking a call
     * is the thing that call is there to do.
     */
    this._backgroundSleep = backgroundSleep ?? ((ms) => new Promise((r) => {
      const t = setTimeout(r, ms)
      t.unref?.()
    }))
    this._log = log
    this._pollMs = pollMs
    /** gateId -> entry, while the gate is unanswered. */
    this._open = new Map()
    /** gateId -> entry, kept GATE_RESULT_HOLD_MS past the answer for re-attach. */
    this._history = new Map()
    /** slot key -> the gateId currently open on that browser, if any. */
    this._openByKey = new Map()
    /** Set by closeAll: a stopping host asks nobody anything new. */
    this._closed = false
  }

  /** The gate open on this agent-and-principal's browser, or null. */
  pending(key) {
    const gateId = this._openByKey.get(key)
    if (!gateId) return null
    const entry = this._open.get(gateId)
    return entry ? entry.gate : null
  }

  /**
   * Raise a gate and hold this call on it.
   *
   * Resolves `{ allowed: true, choice }` once the owner has allowed it, or
   * `{ allowed: false, reason }` when it is refused or runs out of park, or
   * `{ parked: true, gateId, expiresAt }` when the call's own budget ran out
   * while the owner is still deciding.
   *
   * ONE GATE AT A TIME per browser, exactly as the desktop does it: a second
   * ask while one is open is refused with the OPEN gate's id rather than
   * queued, because queueing a long wait behind a long wait holds a relayed
   * call far past its cap and the agent learns nothing it can act on.
   */
  /** @param {RaiseOptions} options */
  async raise({ key, assistantId, kind, origin, summary, agentName, purpose, waitSeconds, choices, action = null, attachMs = GATE_ATTACH_MS, pollMs, onRaised, onPosted }) {
    if (this._closed) return { allowed: false, reason: 'session_closed' }
    const already = this.pending(key)
    if (already) {
      return { parked: true, gateId: already.gateId, expiresAt: already.expiresAt, busy: true, summary: already.summary }
    }
    if (!Array.isArray(choices) || choices.length === 0) {
      this._log(`gate ${kind} was raised with no choices, so the owner would have no buttons; failing closed`)
      return { allowed: false, reason: 'kind_unsupported' }
    }
    if (!CARD_GATE_KINDS.has(kind)) {
      this._log(`gate ${kind} cannot be posted as a card; failing closed`)
      return { allowed: false, reason: 'kind_unsupported' }
    }

    const wait = waitSecondsFrom(waitSeconds)
    const gateId = newGateId(this._randomBytes)
    const startedAt = this._now()
    const expiresAt = new Date(startedAt + wait * 1000).toISOString()
    const gate = { gateId, kind, origin: origin ?? null, summary, assistantId, waitSeconds: wait, expiresAt, startedAt, choices }

    let settle
    const answered = new Promise((r) => (settle = r))
    const entry = { key, gate, answered, settle, outcome: null, held: null, action, endedAt: 0, postedAt: 0, pollMs: pollMs ?? this._pollMs }
    // THE BROWSER IS RESERVED BEFORE THE POST, not after it. The POST can
    // take seconds, and this used to set the key only once it returned, so a
    // second raise inside that window (a download the page started while the
    // agent's own click was being asked about) saw the browser idle and
    // posted a second card for the same browser.
    this._open.set(gateId, entry)
    this._openByKey.set(key, gateId)
    this._history.set(gateId, entry)
    try {
      onRaised?.(gate)
    } catch {}

    const posted = await this._post({ gate, agentName, purpose })
    if (!posted) {
      this._finish(key, entry, { allowed: false, reason: 'card_unreachable' })
      return entry.outcome
    }
    // Ended while the card was being posted (end() or closeAll): nothing to poll.
    if (entry.outcome) return entry.outcome
    // The backend times a card from when it wrote it, so the park is counted
    // from here, not from before the POST: a slow POST must not leave a window
    // where the owner's tap is valid on the card and already a timeout here.
    entry.postedAt = this._now()
    try {
      onPosted?.(gate)
    } catch {}
    void this._poll(key, entry)

    // A call whose budget COVERS the whole park never parks: there would be
    // nothing to come back for, and racing a timer against the park's own
    // deadline is a coin flip that reports "still deciding" for a gate that
    // has in fact expired. Only a call that must give up EARLY gets a timer.
    const parkMs = wait * 1000
    return attachMs < parkMs ? this._await(entry, attachMs) : this._await(entry, Infinity)
  }

  /**
   * Resolves once no gate is open on this browser. It awaits the open gate's
   * OUTCOME only and never its held action: a download waiting behind the
   * agent's parked click must not fire that click; only the agent's own
   * hoai_browser_wait_gate does. Loops, because another gate can open between
   * one ending and the waiter running.
   */
  async whenIdle(key) {
    for (;;) {
      const gateId = this._openByKey.get(key)
      const entry = gateId ? this._open.get(gateId) : null
      if (!entry) return
      await entry.answered
    }
  }

  /**
   * Read a card posted before this host restarted, by its id, until it is
   * answered or its own expiry: the gate's memory is gone, the card is not,
   * and an owner who taps it later must still be heard. Posts nothing.
   */
  watch({ key, gateId, assistantId, kind = 'download', origin = null, summary = '', expiresAt, pollMs, choices = [] }) {
    if (this._closed) return Promise.resolve({ allowed: false, reason: 'session_closed' })
    const id = String(gateId || '')
    const open = this._open.get(id)
    if (open) return open.answered
    const left = Date.parse(String(expiresAt || '')) - this._now()
    if (!id || !(left > 0)) return Promise.resolve({ allowed: false, reason: 'gate_timeout' })
    const startedAt = this._now()
    const gate = { gateId: id, kind, origin, summary, assistantId, waitSeconds: Math.max(1, Math.ceil(left / 1000)), expiresAt: String(expiresAt), startedAt, choices }
    let settle
    const answered = new Promise((r) => (settle = r))
    const entry = { key, gate, answered, settle, outcome: null, held: null, action: null, endedAt: 0, postedAt: startedAt, pollMs: pollMs ?? this._pollMs }
    this._open.set(id, entry)
    this._openByKey.set(key, id)
    this._history.set(id, entry)
    void this._poll(key, entry)
    return answered
  }

  /**
   * End one open gate here, with this outcome, without the owner: the download
   * it asked about ended, or its session closed. A later answer on the card is
   * ignored, because the host stops reading it. True when it was open.
   */
  end(gateId, outcome) {
    const entry = this._open.get(String(gateId || ''))
    if (!entry) return false
    this._finish(entry.key, entry, outcome)
    return true
  }

  /**
   * Re-attach to a gate raised earlier, by id. The same held answer, so the
   * action behind it still runs at most once.
   */
  async attach(gateId, { waitMs = GATE_REATTACH_MS } = {}) {
    this._prune()
    const entry = this._history.get(String(gateId || ''))
    if (!entry) return { unknown: true }
    if (entry.outcome) {
      // Settled already. An allowed one still owes its caller the action's
      // result, and `held` guarantees it is the same single run.
      if (!entry.outcome.allowed || !entry.action) return entry.outcome
      if (!entry.held) entry.held = Promise.resolve().then(() => entry.action())
      return { ...entry.outcome, ran: entry.held }
    }
    return this._await(entry, waitMs)
  }

  /**
   * Wait on one gate for at most `ms`, then park rather than hold longer.
   *
   * An allowed answer runs the HELD action here, and `entry.held` memoizes
   * that one promise, so the original call and every later re-attach await
   * the same run. That is what makes "the action runs at most once, whichever
   * call returns it" true rather than merely advertised: without it, a call
   * that parked and a wait_gate that re-attached would each fire the click.
   */
  async _await(entry, ms) {
    const parked = Symbol('parked')
    // No timer when the caller can wait it out: `setTimeout` clamps a
    // non-finite delay to 1 ms, so passing Infinity to sleep would park
    // IMMEDIATELY, which is the exact opposite of what was asked.
    const raced = Number.isFinite(ms)
      ? await Promise.race([entry.answered, this._sleep(Math.max(0, ms)).then(() => parked)])
      : await entry.answered
    if (raced === parked) {
      return { parked: true, gateId: entry.gate.gateId, expiresAt: entry.gate.expiresAt, summary: entry.gate.summary }
    }
    if (!raced.allowed || !entry.action) return raced
    if (!entry.held) entry.held = Promise.resolve().then(() => entry.action())
    return { ...raced, ran: entry.held }
  }

  /**
   * POST the card. A refusal or an unreachable backend is NOT retried into
   * the park: the owner has to be asked before the clock means anything, so a
   * card that never posted ends the gate immediately and says so, rather than
   * spending 60 seconds pretending somebody was asked.
   */
  async _post({ gate, agentName, purpose }) {
    try {
      const ok = await this._postCard({
        gateId: gate.gateId,
        assistantId: gate.assistantId,
        kind: gate.kind,
        origin: gate.origin,
        summary: gate.summary,
        // REQUIRED by the backend DTO (@ArrayMinSize(1)), and it was missing
        // for a round: the card posted fine against a fake that did not
        // validate, and the real route would have 400'd every gate. The list
        // is the policy's own (gateChoices), never a hand-written one, so a
        // credential gate can never grow a "trust this site" button here.
        choices: gate.choices,
        agentName,
        purpose,
        waitSeconds: remainingWaitSeconds(gate.startedAt + gate.waitSeconds * 1000 - this._now()),
        expiresAt: gate.expiresAt,
      })
      if (!ok) this._log(`the permission card for ${gate.gateId} was refused`)
      return !!ok
    } catch (err) {
      this._log(`could not post the permission card for ${gate.gateId}: ${err?.message ?? err}`)
      return false
    }
  }

  /**
   * Ask the server what the owner said, until it says something or the park
   * runs out. A poll that THROWS is a transient network fault and is retried
   * inside the park; only the park's end is final, so a momentary outage
   * cannot deny an action the owner is about to allow.
   *
   * `unknown` is treated as fatal on purpose, and only after a grace: the
   * card was accepted a moment ago, so the row exists; a server that then
   * cannot find it means the record is gone, and waiting out a 30 minute park
   * for a gate nobody can answer helps no one.
   */
  async _poll(key, entry) {
    const { gate } = entry
    const deadline = (entry.postedAt || gate.startedAt) + gate.waitSeconds * 1000
    let missing = 0
    try {
      while (this._now() < deadline) {
        await this._backgroundSleep(entry.pollMs ?? this._pollMs)
        if (!this._open.has(gate.gateId)) return
        let state = null
        try {
          state = await this._readGate(gate.gateId, gate.assistantId)
        } catch (err) {
          this._log(`could not read permission ${gate.gateId}: ${err?.message ?? err}`)
          continue
        }
        if (!state) continue
        if (state.state === 'answered') {
          const choice = state.choice
          if (choice && ALLOWING_CHOICES.has(choice)) return this._finish(key, entry, { allowed: true, choice })
          // An answered card with no choice the host can read is a DENIAL,
          // not a retry: the owner has decided and the action must not run on
          // a callback this host could not parse.
          return this._finish(key, entry, { allowed: false, reason: 'denied_by_owner', choice: choice ?? null })
        }
        if (state.state === 'expired') return this._finish(key, entry, { allowed: false, reason: 'gate_timeout' })
        if (state.state === 'unknown') {
          if (++missing >= 2) return this._finish(key, entry, { allowed: false, reason: 'gate_lost' })
          continue
        }
        missing = 0
      }
      this._finish(key, entry, { allowed: false, reason: 'gate_timeout' })
    } catch (err) {
      this._log(`the permission watch for ${gate.gateId} stopped: ${err?.message ?? err}`)
      this._finish(key, entry, { allowed: false, reason: 'gate_timeout' })
    }
  }

  /**
   * End a gate once. Every later waiter gets the same recorded outcome.
   *
   * The result is kept for a late re-attach, and it is aged out LAZILY rather
   * than on a timer. A timer here was a real bug, not a style point: the hold
   * is fifteen minutes, the only clock this class has is the injected
   * `sleep`, and a promise cannot be unref'd, so every answered gate pinned
   * the event loop open for a quarter of an hour. It hung the test runner
   * outright, and in the daemon it would have kept a host that was asked to
   * stop from exiting. Nothing needs a timer: the only reader is `attach`,
   * so the sweep belongs there.
   */
  _finish(key, entry, outcome) {
    const { gateId } = entry.gate
    if (!this._open.has(gateId)) return
    this._open.delete(gateId)
    if (this._openByKey.get(key) === gateId) this._openByKey.delete(key)
    entry.outcome = outcome
    entry.endedAt = this._now()
    entry.settle(outcome)
    this._prune()
  }

  /** Drop results nobody can still re-attach to. Called on every lookup. */
  _prune() {
    const cutoff = this._now() - GATE_RESULT_HOLD_MS
    for (const [gateId, entry] of this._history) {
      if (entry.endedAt && entry.endedAt < cutoff) this._history.delete(gateId)
    }
  }

  /** Close every open gate, denied, when the host is going away. */
  closeAll(reason = 'session_closed') {
    this._closed = true
    for (const [gateId, entry] of [...this._open]) {
      this._open.delete(gateId)
      entry.outcome = { allowed: false, reason }
      entry.settle(entry.outcome)
    }
    this._openByKey.clear()
  }
}

