// Shared HOAI contract implementation from bgos-claude-plugin, Apache-2.0, commit 3ecbb58679febcc243f671e05788b521b065546e.
/**
 * Bounded network calls + bounded startup phases.
 *
 * WHY THIS EXISTS (2026-08-25, external tester, pairing 1041).
 * The daemon started, logged `MCP server connected over stdio`, and then
 * logged NOTHING for hours across two separate starts. Server side its
 * pairing `last_seen_at` never moved and five messages sat queued: the
 * process was alive and had never called out. The startup path awaits three
 * things between that log line and the first poll, and at the time NOT ONE
 * fetch in the whole daemon carried an AbortSignal (`grep -c AbortSignal
 * server.ts` returned 0). A socket that connects and then stalls therefore
 * hangs a `fetch` forever, and because the hang happened before the poll
 * loop was armed, the daemon could never deliver a message again. The
 * daemon's own doctor already bounded its probe at 10s
 * (bin/bgos-doctor.mjs probeBackend); the daemon that has to survive did not.
 *
 * The contract this module provides:
 *   - every outbound HTTP call gets a deadline that covers BOTH the headers
 *     and the body read (a `fetch` promise resolves as soon as headers land,
 *     so bounding only the fetch leaves `response.json()` free to hang),
 *   - a deadline that fires is DISTINGUISHABLE from a network error
 *     (FetchTimeoutError / isFetchTimeoutError), because "the backend never
 *     answered" and "the backend refused the connection" call for different
 *     responses and read very differently in a log,
 *   - a deadline that fires is never silent: it is logged where it happens
 *     and then thrown, so the caller's existing handling still runs,
 *   - the caller is released even if the underlying fetch implementation
 *     ignores the abort signal, because the deadline is a race and not only
 *     an abort.
 *
 * Pure and dependency-injected on purpose: fetch, the clock and the log sink
 * are all injectable so the guards can be unit-tested without a socket.
 */

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

/**
 * The injection seam. Collaborators in this repo model a response with
 * different (structurally narrower) types than the DOM `Response`, so the
 * helper is generic in the response and deliberately loose in the init: it
 * only ever ADDS `signal` to whatever the caller already passes, and the
 * caller keeps full typing on both `call.init` and `consume`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BoundedFetchFn<R> = (url: string, init: any) => Promise<R>

/**
 * Raised when a bounded call outlived its deadline. A distinct class (plus a
 * name check, so it survives being thrown across a bun/node module boundary)
 * because callers and log readers must be able to tell "no answer in time"
 * apart from DNS failure, connection refused, or TLS rejection.
 */
export class FetchTimeoutError extends Error {
  readonly label: string
  readonly timeoutMs: number

  constructor(label: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms: ${label}`)
    this.name = 'FetchTimeoutError'
    this.label = label
    this.timeoutMs = timeoutMs
  }
}

export function isFetchTimeoutError(err: unknown): err is FetchTimeoutError {
  if (err instanceof FetchTimeoutError) return true
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'FetchTimeoutError'
  )
}

export interface BoundedFetchDeps<R = Response> {
  /** Defaults to the global fetch. Injected in tests. */
  fetchImpl?: BoundedFetchFn<R>
  /** Where a fired deadline is reported. Injected in tests. */
  log?: (msg: string) => void
}

export interface BoundedFetchCall {
  url: string
  init?: RequestInit
  /** Deadline for the WHOLE call, headers plus body. */
  timeoutMs: number
  /** Human label for the log line, e.g. `GET peers/inbox`. Never a secret. */
  label: string
}

/**
 * Run one HTTP call under a deadline that covers the body read too.
 *
 * `consume` receives the Response while the abort signal is still armed, so
 * a caller that inspects headers before reading the body (the capability and
 * boards size caps do exactly that) keeps working, and a body that stalls
 * mid-stream still trips the deadline.
 */
export async function boundedFetch<T, R = Response>(
  call: BoundedFetchCall,
  consume: (response: R) => Promise<T>,
  deps: BoundedFetchDeps<R> = {},
): Promise<T> {
  const fetchImpl =
    deps.fetchImpl ?? (globalThis.fetch as unknown as BoundedFetchFn<R>)
  const timeoutMs = Math.max(1, Math.floor(call.timeoutMs))
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      // Abort frees the socket. The reject below is what actually releases
      // the caller, so a fetch implementation that ignores the signal cannot
      // reproduce the original bug.
      try {
        controller.abort()
      } catch {
        // An abort that throws must not mask the timeout.
      }
      reject(new FetchTimeoutError(call.label, timeoutMs))
    }, timeoutMs)
    // Never let a pending deadline hold the process open at shutdown.
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })

  const operation = (async () => {
    const response = await fetchImpl(call.url, {
      ...(call.init ?? {}),
      signal: controller.signal,
    })
    return await consume(response)
  })()
  // The race loser still settles. Without this handler an aborted operation
  // surfaces as an unhandled rejection, which on node is fatal by default.
  operation.catch(() => {})

  try {
    return await Promise.race([operation, deadline])
  } catch (err) {
    if (isFetchTimeoutError(err) || timedOut) {
      const timeoutErr = isFetchTimeoutError(err)
        ? err
        : new FetchTimeoutError(call.label, timeoutMs)
      deps.log?.(
        `network deadline exceeded after ${timeoutMs}ms: ${call.label} ` +
          `(bounded; not a connection failure)`,
      )
      throw timeoutErr
    }
    throw err
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/**
 * A plain `typeof fetch` adapter for collaborators that take a fetch
 * implementation rather than a consume callback (lib/stream-client.ts).
 *
 * Two timers on the same deadline, on purpose:
 *
 *  - the ABORT timer is deliberately never cleared. Leaving the controller
 *    armed past the headers is what bounds a body read that stalls
 *    mid-stream; firing it after the body was already consumed aborts
 *    nothing. That is also why the timeout is reported at the catch site and
 *    not from inside the timer callback, which would announce a timeout on
 *    every successful fast call.
 *  - the RACE timer releases the caller even if the transport ignores the
 *    signal. Without it the guarantee would depend on the very thing being
 *    guarded against; the first version of this function did depend on it and
 *    its own unit test hung, which is the point of the test.
 *
 * Both are unref'd and live at most `timeoutMs`.
 */
export function createBoundedFetchImpl(
  timeoutMs: number,
  label: string,
  deps: BoundedFetchDeps = {},
): FetchLike {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const bound = Math.max(1, Math.floor(timeoutMs))
  return async (input, init) => {
    const controller = new AbortController()
    let timedOut = false
    const abortTimer = setTimeout(() => {
      timedOut = true
      try {
        controller.abort()
      } catch {
        // An abort that throws must not mask the timeout.
      }
    }, bound)
    ;(abortTimer as unknown as { unref?: () => void })?.unref?.()

    let raceTimer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<never>((_resolve, reject) => {
      raceTimer = setTimeout(
        () => reject(new FetchTimeoutError(label, bound)),
        bound,
      )
      ;(raceTimer as unknown as { unref?: () => void })?.unref?.()
    })

    const operation = fetchImpl(input, {
      ...(init ?? {}),
      signal: controller.signal,
    })
    operation.catch(() => {})

    try {
      return await Promise.race([operation, deadline])
    } catch (err) {
      if (isFetchTimeoutError(err) || timedOut) {
        deps.log?.(
          `network deadline exceeded after ${bound}ms: ${label} ` +
            `(bounded; not a connection failure)`,
        )
        throw isFetchTimeoutError(err) ? err : new FetchTimeoutError(label, bound)
      }
      throw err
    } finally {
      // Only the race timer: the abort timer stays armed to bound the body.
      if (raceTimer != null) clearTimeout(raceTimer)
    }
  }
}

/**
 * The one upload deadline, shared by BOTH presigned PUT paths in this daemon:
 * `uploadViaS3` in server.ts (outbound message files, up to 100 MB for video)
 * and `defaultPutBytes` in lib/boards-tools.ts (board attachments, up to 25 MB).
 *
 * It lives here rather than once per file because the two paths drifted apart
 * exactly once already: the message upload was bounded and documented at 600s
 * while the boards attachment PUT stayed an unbounded `await fetch`, and the
 * PR body then claimed a bound that covered only one of them. One exported
 * constant means the documented number and the enforced number cannot differ.
 *
 * 10 minutes is deliberately generous: a large upload legitimately takes
 * minutes (600s still completes a 100 MB PUT on an uplink as slow as about
 * 1.4 Mbps, and a 25 MB attachment on one as slow as about 0.35 Mbps). What it
 * refuses to do is wait forever on a socket that has stopped moving.
 */
export const UPLOAD_DEADLINE_MS = 600_000

/** Returned by withDeadline when the work did not finish in time. */
export const DEADLINE_EXCEEDED = Symbol('bgos.deadline-exceeded')

export function isDeadlineExceeded(
  value: unknown,
): value is typeof DEADLINE_EXCEEDED {
  return value === DEADLINE_EXCEEDED
}

/**
 * Bound any promise, not only a fetch. Used for the startup steps that are
 * not network calls but still sit between the daemon booting and the daemon
 * polling (the slash-command registry walks the filesystem, and a filesystem
 * can be a stalled network mount).
 *
 * The work is NOT cancelled, only stopped being waited on: whatever it does
 * on completion (the registry assigns itself into place) still happens, just
 * without holding message delivery hostage.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  opts: { timeoutMs: number; label: string; log?: (msg: string) => void },
): Promise<T | typeof DEADLINE_EXCEEDED> {
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs))
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), timeoutMs)
    ;(timer as unknown as { unref?: () => void })?.unref?.()
  })
  work.catch(() => {})
  try {
    const outcome = await Promise.race([work, deadline])
    if (isDeadlineExceeded(outcome)) {
      opts.log?.(
        `deadline exceeded after ${timeoutMs}ms: ${opts.label} ` +
          `(continuing without it; it lands later if it ever finishes)`,
      )
    }
    return outcome
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/**
 * Narrate one startup phase.
 *
 * The reason the tester lost most of a day is that a hang and a crash look
 * identical when the last log line is `MCP server connected over stdio`.
 * With a line before and a line after every phase, the log names the phase
 * that failed on its own: a phase with a `start` and no `ok`/`FAILED` is a
 * hang in exactly that phase, and a `FAILED` line is a throw with its
 * message. This is the deliverable that survives even if a bounded deadline
 * turns out not to be the cure.
 */
export async function startupPhase<T>(
  name: string,
  run: () => Promise<T>,
  deps: { log: (msg: string) => void; now?: () => number },
): Promise<T> {
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()
  deps.log(`startup phase start: ${name}`)
  try {
    const result = await run()
    deps.log(`startup phase ok: ${name} (${now() - startedAt}ms)`)
    return result
  } catch (err) {
    deps.log(
      `startup phase FAILED: ${name} (${now() - startedAt}ms): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    throw err
  }
}
