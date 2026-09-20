/**
 * The live Steps lane: the agent's own to do list for ONE reply.
 *
 * Codex raises `turn/plan/updated` while it works. The mission lane reads the
 * same notification and, when the plan is big enough, keeps a mission in step
 * with it. This lane is the other reader, and it is deliberately dumber: it
 * replaces the whole snapshot for the chat on every update, clips it, and
 * clears it when the turn ends. Steps are scratch paper, never history.
 *
 * Rules this file must keep:
 * - It never touches a mission. No create, no tick, no progress, no finish.
 * - It never breaks a turn. Every write is swallowed; a chat the backend will
 *   never accept (any permanent 4xx) is logged once and then left alone.
 * - It sends the FULL list every time, so a later write supersedes an earlier
 *   one and a 600 ms coalescer (the shape `tool-progress.ts` uses) is enough.
 * - One write per chat is in flight at a time, and the turn end clear waits
 *   for it, so a finished turn's list can never be written back over the
 *   clear and left on screen.
 * - The turn end clear NEVER holds up the reply. `adapter.ts` awaits
 *   `finalizeTurn` before it sends the owner's answer, so the clear runs as a
 *   bounded background task and the turn is done the moment the chat's state
 *   is detached. The next turn on that chat waits for the task before its
 *   first write, so a late clear can never blank the new list.
 */
import type { BgosApi, ReplaceStepsBody, StepInput } from "./bgos-api.js";
import type { PlanItem } from "./codex-host.js";

const LOG = "[codex-channel-bgos]";
/** Backend caps the list at 30 rows and each row at 200 characters. */
const MAX_STEPS = 30;
const MAX_TEXT = 200;
/** Shutdown must not hang on a slow backend. Mirrors the mission lane. */
const DISPOSE_TIMEOUT_MS = 3_000;
/**
 * The backend stamps a record only when it is written and sweeps one it has
 * not seen written for three minutes. A single step that runs longer than
 * that would make every Steps surface vanish mid turn, so a chat with a plan
 * in flight re sends its current snapshot on this interval even when nothing
 * about it changed. Well inside the three minute window on purpose.
 */
export const STEPS_KEEPALIVE_MS = 90_000;
/**
 * A turn end clear that fails leaves the finished list on screen until the
 * backend's own sweep, three minutes later. Try again a couple of times with
 * a short backoff before accepting that.
 */
const CLEAR_ATTEMPTS = 3;
const CLEAR_RETRY_MS = 200;
/**
 * Whole budget for the turn end clear, shared by the wait for the in flight
 * snapshot and by every attempt. Without it each request inherits axios's 30 s
 * default and three attempts of that is two minutes of a chat still showing a
 * finished plan. The backend's own sweep takes it off screen after three
 * minutes anyway, so there is nothing to gain by waiting longer than this.
 */
export const CLEAR_DEADLINE_MS = 5_000;

export interface StepsLaneOptions {
  /** Minimum delay between PUTs for the same chat. Default 600 ms, the same
   *  window `tool-progress.ts` uses, so a chatty plan cannot slam the API. */
  debounceMs?: number;
  /** Interval between keepalive re sends for a chat with a live plan.
   *  Defaults to `STEPS_KEEPALIVE_MS`; tests shorten it. */
  keepaliveMs?: number;
  /** Whole budget for `dispose()`. Defaults to `DISPOSE_TIMEOUT_MS`. */
  disposeTimeoutMs?: number;
  /** Whole budget for one turn end clear. Defaults to `CLEAR_DEADLINE_MS`. */
  clearDeadlineMs?: number;
}

export interface HandlePlanParams {
  assistantId: number;
  chatId: number;
  turnId: string | null;
  plan: PlanItem[];
}

interface ChatSteps {
  assistantId: number;
  turnId: string | null;
  /** Latest snapshot, replaced whole. Never merged with the previous one. */
  steps: StepInput[];
  /** Serialized body that actually reached the backend, or null. */
  lastSent: string | null;
  /** Last PUT timestamp (ms). 0 means the first snapshot goes out at once. */
  lastPutAt: number;
  pendingFlush: ReturnType<typeof setTimeout> | null;
  /** The write currently going out for this chat, or null. */
  flushInFlight: Promise<void> | null;
  keepalive: ReturnType<typeof setInterval> | null;
  /**
   * The previous turn's clear, if it was still going out when this turn
   * opened. The first write of this turn waits for it, so the clear can never
   * land after the new snapshot and leave the chat looking empty.
   */
  awaitingClear: Promise<void> | null;
}

/**
 * Chat kinds a Steps record is allowed to exist in. The backend's write gate
 * admits `main` only (a room, a meeting or an a2a side thread answers 403),
 * and reads an ABSENT kind as main, because the REST inbound backfill carries
 * no kind at all. An unrecognised kind fails closed, exactly as the backend's
 * `stepsChatKindAdmits` does.
 */
export function stepsChatKindAdmits(kind: string | null | undefined): boolean {
  return kind === undefined || kind === null || kind === "" || kind === "main";
}

export class StepsLane {
  private readonly api: BgosApi;
  private readonly debounceMs: number;
  private readonly keepaliveMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly clearDeadlineMs: number;
  private readonly byChat = new Map<number, ChatSteps>();
  /** Turn end clears still going out, by chat. `dispose()` waits for these. */
  private readonly pendingClears = new Map<number, Promise<void>>();
  /**
   * Bumped every time a new turn opens on a chat. A clear left over from the
   * turn before checks it after every await and stands down when it no longer
   * owns the chat, so its retries cannot blank the new turn's list.
   */
  private readonly generations = new Map<number, number>();
  /** Chats the backend permanently refused: asking again changes nothing. */
  private readonly silenced = new Set<number>();

  constructor(api: BgosApi, options: StepsLaneOptions = {}) {
    this.api = api;
    this.debounceMs = options.debounceMs ?? 600;
    this.keepaliveMs = options.keepaliveMs ?? STEPS_KEEPALIVE_MS;
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS;
    this.clearDeadlineMs = options.clearDeadlineMs ?? CLEAR_DEADLINE_MS;
  }

  /** One `turn/plan/updated` notification for a live chat turn. */
  async handlePlan(params: HandlePlanParams): Promise<void> {
    const { chatId } = params;
    if (this.silenced.has(chatId)) return;
    const steps = planToSteps(params.plan);
    const existing = this.byChat.get(chatId);
    if (existing) {
      existing.assistantId = params.assistantId;
      existing.turnId = params.turnId;
      existing.steps = steps;
    } else {
      // A new turn owns the chat from here. Anything the previous turn is
      // still doing to it is stale the moment this generation starts.
      this.generations.set(chatId, this.generationOf(chatId) + 1);
      const state: ChatSteps = {
        assistantId: params.assistantId,
        turnId: params.turnId,
        steps,
        lastSent: null,
        lastPutAt: 0,
        pendingFlush: null,
        flushInFlight: null,
        keepalive: null,
        awaitingClear: this.pendingClears.get(chatId) ?? null,
      };
      this.byChat.set(chatId, state);
      this.startKeepalive(chatId, state);
    }
    await this.maybePutSoon(chatId);
  }

  /**
   * End of turn. Drops any pending write, detaches the chat's state and
   * RESOLVES: the caller is `adapter.ts`, which awaits this before it sends
   * the owner's reply, so nothing here may wait on the backend. The clear
   * itself (wait for the in flight snapshot, then the empty snapshot) runs as
   * a background task on one `clearDeadlineMs` budget. Idempotent: a chat
   * that raised no plan sends nothing.
   */
  async finalizeTurn(chatId: number): Promise<void> {
    const state = this.byChat.get(chatId);
    if (!state) return;
    cancelTimers(state);
    this.byChat.delete(chatId);
    // Deliberately not awaited. The task is tracked in `pendingClears`, so
    // `dispose()` and the chat's next turn can both still wait for it.
    void this.startClear(chatId, state);
  }

  /**
   * Shutdown. Cancels every timer and clears every list this lane is still
   * holding, so a stopped daemon never leaves a frozen step on screen.
   */
  async dispose(): Promise<void> {
    const open = Array.from(this.byChat.entries());
    for (const [, state] of open) cancelTimers(state);
    this.byChat.clear();
    // One budget for the whole shutdown, shared by the waits and the retries.
    const deadline = Date.now() + this.disposeTimeoutMs;
    // A turn that ended a moment ago may still be clearing in the background.
    const pending = Array.from(this.pendingClears.values());
    await Promise.all([
      ...open.map(async ([chatId, state]) => {
        // Ordering matters, but the clear matters more: a write that is stuck
        // gets half the budget and no more, so a frozen step still comes off
        // the screen and a stopping daemon still stops.
        await waitAtMost(settleInFlight(state), this.disposeTimeoutMs / 2);
        await this.clear(state.assistantId, chatId, deadline);
      }),
      ...pending.map((task) =>
        waitAtMost(task, Math.max(0, deadline - Date.now())),
      ),
    ]);
  }

  /** Test-only - surface internal state so vitest can assert. */
  get _internal(): {
    activeChats: number[];
    silencedChats: number[];
    pendingClears: number[];
    /** Resolves when every background clear running right now has finished. */
    clearsSettled: Promise<void>;
  } {
    return {
      activeChats: Array.from(this.byChat.keys()),
      silencedChats: Array.from(this.silenced),
      pendingClears: Array.from(this.pendingClears.keys()),
      clearsSettled: Promise.all(Array.from(this.pendingClears.values())).then(
        () => undefined,
      ),
    };
  }

  /**
   * Start the turn end clear for a chat whose state has just been detached.
   * Tracked per chat so `dispose()` can wait for it and so the next turn on
   * the same chat writes strictly after it.
   */
  private startClear(chatId: number, state: ChatSteps): Promise<void> {
    const generation = this.generationOf(chatId);
    const deadline = Date.now() + this.clearDeadlineMs;
    const task: Promise<void> = (async () => {
      // The in flight snapshot still has to land first, or the clear is
      // written back over by it and the finished plan stays on screen. It
      // never gets more than the shared budget to do that.
      await waitAtMost(settleInFlight(state), deadline - Date.now());
      if (this.superseded(chatId, generation)) return;
      const gaveUp = await this.clear(
        state.assistantId,
        chatId,
        deadline,
        generation,
      );
      // A refused clear already warned per attempt in `put`. This one is the
      // silent case: a backend that accepted the request and never answered.
      if (gaveUp) {
        // eslint-disable-next-line no-console
        console.warn(
          `${LOG} steps clear gave up after ` +
            this.clearDeadlineMs +
            "ms chat=" +
            chatId,
        );
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingClears.get(chatId) === task) {
          this.pendingClears.delete(chatId);
        }
      });
    this.pendingClears.set(chatId, task);
    return task;
  }

  private generationOf(chatId: number): number {
    return this.generations.get(chatId) ?? 0;
  }

  /** True once a newer turn has taken the chat over. */
  private superseded(chatId: number, generation: number | undefined): boolean {
    return generation !== undefined && this.generationOf(chatId) !== generation;
  }

  private startKeepalive(chatId: number, state: ChatSteps): void {
    if (state.keepalive || this.keepaliveMs <= 0) return;
    const timer = setInterval(() => {
      void this.keepaliveTick(chatId);
    }, this.keepaliveMs);
    // A scratch list must never be the reason the process stays alive.
    timer.unref?.();
    state.keepalive = timer;
  }

  private async keepaliveTick(chatId: number): Promise<void> {
    const state = this.byChat.get(chatId);
    if (!state) return;
    if (this.silenced.has(chatId)) {
      cancelTimers(state);
      return;
    }
    // A write already going out restamps the record by itself.
    if (state.flushInFlight) return;
    await this.flush(chatId, true);
  }

  private async maybePutSoon(chatId: number): Promise<void> {
    const state = this.byChat.get(chatId);
    if (!state) return;
    const elapsed = Date.now() - state.lastPutAt;
    if (elapsed >= this.debounceMs) {
      await this.flush(chatId);
      return;
    }
    // Inside the window: schedule one deferred flush. Repeat calls coalesce,
    // because the snapshot we eventually send is the newest whole list.
    if (state.pendingFlush) return;
    state.pendingFlush = setTimeout(() => {
      void this.flush(chatId);
    }, this.debounceMs - elapsed);
  }

  /**
   * Send the chat's newest snapshot. `force` belongs to the keepalive alone:
   * it re sends a body identical to the last one, which the plan driven path
   * deliberately skips.
   */
  private async flush(chatId: number, force = false): Promise<void> {
    const state = this.byChat.get(chatId);
    if (!state) return;
    cancelFlush(state);
    if (this.silenced.has(chatId)) return;
    if (state.flushInFlight) {
      // One write per chat at a time. Two in flight can land out of order and
      // leave a stale list on screen; the running one drains what we have.
      await settleInFlight(state);
      return;
    }
    const operation = this.drain(chatId, state, force).finally(() => {
      if (state.flushInFlight === operation) state.flushInFlight = null;
    });
    state.flushInFlight = operation;
    await operation;
  }

  private async drain(
    chatId: number,
    state: ChatSteps,
    force: boolean,
  ): Promise<void> {
    if (state.awaitingClear) {
      // The turn before this one is still clearing. Writing underneath it
      // would let its empty snapshot land last and blank our first list.
      const previous = state.awaitingClear;
      state.awaitingClear = null;
      await previous;
    }
    let forceThis = force;
    while (this.byChat.get(chatId) === state && !this.silenced.has(chatId)) {
      const body = bodyFor(state);
      const wire = JSON.stringify(body);
      // Codex repeats a plan verbatim; the owner learns nothing from a
      // resend. Only the keepalive may send the same body twice.
      if (!forceThis && wire === state.lastSent) return;
      forceThis = false;
      state.lastPutAt = Date.now();
      const sent = await this.put(state.assistantId, chatId, body);
      // A failed write must be retryable, so only a landed snapshot counts as
      // the last one sent. The state may have gone (turn end) while we waited.
      if (!sent || this.byChat.get(chatId) !== state) return;
      state.lastSent = wire;
    }
  }

  /**
   * The turn end clear. Retried a couple of times, because a clear that is
   * dropped leaves the finished list on screen until the backend's three
   * minute sweep. `deadline` bounds the whole thing on both paths; passing a
   * `generation` makes it stand down as soon as a newer turn owns the chat.
   *
   * Returns true when the budget ran out with the list still on screen, which
   * is the one failure no `put` has already warned about.
   */
  private async clear(
    assistantId: number,
    chatId: number,
    deadline: number,
    generation?: number,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= CLEAR_ATTEMPTS; attempt += 1) {
      if (this.silenced.has(chatId)) return false;
      if (this.superseded(chatId, generation)) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return true;
      // The timeout is what a well behaved socket honours; the race is what
      // saves us from one that is open and simply never answers.
      const sent = await raceDeadline(
        this.put(assistantId, chatId, { steps: [] }, { timeout: remaining }),
        remaining,
      );
      if (sent === null) return true;
      if (sent || attempt === CLEAR_ATTEMPTS) return false;
      if (this.silenced.has(chatId)) return false;
      if (this.superseded(chatId, generation)) return false;
      const backoff = CLEAR_RETRY_MS * attempt;
      if (Date.now() + backoff >= deadline) return true;
      await sleep(backoff);
    }
    return false;
  }

  private async put(
    assistantId: number,
    chatId: number,
    body: ReplaceStepsBody,
    options?: { timeout?: number },
  ): Promise<boolean> {
    try {
      await this.api.replaceSteps(assistantId, chatId, body, options);
      return true;
    } catch (err) {
      const status = statusOf(err);
      if (status !== null && isPermanentRefusal(status)) {
        this.silence(chatId, status);
        return false;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} steps PUT failed chat=` + chatId + " err=" + errorText(err),
      );
      return false;
    }
  }

  /** Stop writing to a chat the backend will never accept. Warn once. */
  private silence(chatId: number, status: number): void {
    if (this.silenced.has(chatId)) return;
    this.silenced.add(chatId);
    const state = this.byChat.get(chatId);
    if (state) cancelTimers(state);
    // eslint-disable-next-line no-console
    console.warn(
      `${LOG} steps refused (${status}), no live steps for chat=` + chatId,
    );
  }
}

function bodyFor(state: ChatSteps): ReplaceStepsBody {
  return state.turnId !== null && state.turnId.length > 0
    ? { turnId: state.turnId, steps: state.steps }
    : { steps: state.steps };
}

function settleInFlight(state: ChatSteps): Promise<void> {
  if (!state.flushInFlight) return Promise.resolve();
  return state.flushInFlight.catch(() => undefined);
}

/** Wait for `promise`, but never longer than `ms`. Never rejects. */
function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * Resolve with what `promise` resolves to, or `null` once `ms` has passed.
 * The promise is left running; the caller has already given up on it.
 */
function raceDeadline(
  promise: Promise<boolean>,
  ms: number,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function cancelFlush(state: ChatSteps): void {
  if (state.pendingFlush) {
    clearTimeout(state.pendingFlush);
    state.pendingFlush = null;
  }
}

function cancelTimers(state: ChatSteps): void {
  cancelFlush(state);
  if (state.keepalive) {
    clearInterval(state.keepalive);
    state.keepalive = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Codex's wire statuses into the record's own three. `waiting` exists on the
 * record for channels that report a blocked step; Codex never sends one.
 */
function stepStatus(raw: string): StepInput["status"] {
  if (raw === "completed") return "done";
  if (raw === "in_progress") return "running";
  return "pending";
}

function planToSteps(plan: PlanItem[]): StepInput[] {
  const steps: StepInput[] = [];
  for (const item of plan ?? []) {
    if (steps.length >= MAX_STEPS) break;
    const text = clipText(String(item?.step ?? ""), MAX_TEXT);
    // An empty row would 400 the whole snapshot, so drop it rather than lose
    // every other step of the plan.
    if (text.length === 0) continue;
    steps.push({ text, status: stepStatus(String(item?.status ?? "")) });
  }
  return steps;
}

function clipText(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("response" in err)) {
    return null;
  }
  const status = (err as { response?: { status?: number } }).response?.status;
  return typeof status === "number" ? status : null;
}

/**
 * A 4xx says this chat will never accept a step list: no steps route on an
 * older backend (404), a room or group chat, another assistant's chat, an
 * assistant this pairing is not scoped to (403). Retrying one of those warns
 * on every flush for the life of the daemon and never starts working. The two
 * exceptions clear by themselves: 408 is a timeout and 429 is a rate limit.
 * Everything else (5xx, a network error with no status at all) keeps trying.
 */
function isPermanentRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
