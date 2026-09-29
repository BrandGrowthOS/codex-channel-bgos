/**
 * The changes lane (P7 stage 3, C-31; BGOS spec 9.2, 10.1 and 10.2).
 *
 * When the owner's Changes panel reads, the backend sends ONE `changes_rpc`
 * frame to this daemon's pairing room:
 *
 *   { rpcId, op: "diff", assistantId, payload: { scope: "uncommitted", caps } }
 *
 * and re emits it once after 1.5 s without an ack. The first result wins, and
 * the backend gives up after 20 s (the owner then sees "asleep"). This file
 * answers it, under the same rules as the memory rail of stage 2:
 *
 *  1. A frame without a string rpcId is dropped (normalizeChangesRpc). Anything
 *     with one is answered.
 *  2. A frame for an agent this daemon does not run gets NOTHING, not even an
 *     ack: several daemons can share one pairing room, and an answer from the
 *     wrong one would win the race with the wrong folder.
 *  3. The last 256 ids are remembered: an id still running is ignored, an
 *     answered id gets the same answer again while that answer is held.
 *     Never forgotten in a `finally`, so the backend's re emit can never run
 *     Git twice. The answer ITSELF is held for the backend's own hold only
 *     (CHANGES_READ_TIMEOUT_MS, 20 s, changes-panel.service.ts) and for the
 *     newest 8 ids only: one answer can carry a 1 MB patch and 20 new files,
 *     and the backend re emits once, 1.5 s after the frame, takes the first
 *     result and drops anything after its hold as late, so a copy kept longer
 *     buys nothing and would stay in a daemon that runs for days (parity
 *     round, D-R1). An id whose answer was let go is still remembered, and
 *     gets nothing.
 *  4. The ack is best effort; a failed ack never stops the work.
 *  5. The work runs under the frame's budget (git-changes.ts): past it the
 *     answer is `too_slow`.
 *  6. A result is ALWAYS posted; a throw answers `read_failed` with the spec's
 *     sentence, plus `git <subcommand> exited <code>` when a Git command
 *     failed, or plus "Git 2.36 or later is needed to read changes safely"
 *     when the Git found is older or its version cannot be read (fix round
 *     w5, W4-N3), and nothing else: Git's own words, and any other error's
 *     text, can name the owner's folder, so they go to this computer's log
 *     only.
 *     Every message is at most 300 characters with no em or en dash.
 *
 * The owner's per agent switch is NOT read here, or anywhere in this plugin:
 * the backend is the only gate, and it sends no frame while the switch is off.
 */
import {
  collectChanges,
  createNodeRunGit,
  GitCommandError,
  nodeChangesFs,
  readCaps,
  type ChangesCaps,
  type ChangesResultBody,
  type RunGit,
} from "./git-changes.js";

export interface ChangesRpcFrame {
  rpcId: string;
  op: string;
  assistantId: string;
  payload: Record<string, unknown>;
}

/** What the handler posts with (BgosApi has both). */
export interface ChangesRpcApi {
  changesRpcAck(rpcId: string): Promise<unknown>;
  changesRpcResult(rpcId: string, body: ChangesResultBody): Promise<unknown>;
}

export type ChangesCollect = (input: {
  workdir: string;
  caps: ChangesCaps;
}) => Promise<ChangesResultBody>;

export interface ChangesHandlerDeps {
  api: ChangesRpcApi;
  /** The folder this daemon's agents work in (CodexHost.workdir). */
  workdir: string;
  /** Whether this daemon runs that agent (the adapter's scope rule). */
  owns: (assistantId: string) => boolean;
  collect?: ChangesCollect;
  /**
   * Makes the Git runner for ONE read (the default collector calls it per
   * read), so Git is looked up on PATH's absolute entries per read: a Git
   * installed, moved or removed while the daemon runs is what the next read
   * finds (parity round, D-R2). The default is createNodeRunGit().
   */
  newRunGit?: () => RunGit;
  log?: (message: string) => void;
  nowImpl?: () => number;
  /**
   * Runs `run` once, `ms` from now, without keeping the process alive. The
   * default is an unref'd setTimeout; the tests inject their own clock.
   */
  schedule?: (run: () => void, ms: number) => void;
}

/** How long one result post may take (BgosApi.changesRpcResult). */
export const CHANGES_RESULT_TIMEOUT_MS = 8_000;
/** How long one ack post may take (BgosApi.changesRpcAck). */
export const CHANGES_ACK_TIMEOUT_MS = 3_000;
/** A retry is tried only if it can still land this long after the frame
 * arrived: inside the backend's 20 s hold, with room to spare. */
export const CHANGES_RESULT_DEADLINE_MS = 18_000;
/**
 * How long a whole answer is held for a re sent id: the backend's own hold,
 * CHANGES_READ_TIMEOUT_MS in changes-panel.service.ts. Past it the backend has
 * given up on the frame and logs any answer as late.
 */
export const CHANGES_ANSWER_HOLD_MS = 20_000;

const SEEN_LIMIT = 256;
/** How many answers are kept whole for a re sent id (see rule 3). */
const ANSWER_KEEP = 8;
const MESSAGE_MAX = 300;
const DASHES = new RegExp(
  `[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`,
  "g",
);

export const READ_FAILED_MESSAGE =
  "changes could not be read on the agent host";

/**
 * Normalize a `changes_rpc` frame. A frame without a non empty string rpcId
 * is dropped; everything else is kept so the handler can answer it (an op
 * that is not a string becomes "", which is answered `unsupported`).
 */
export function normalizeChangesRpc(raw: unknown): ChangesRpcFrame | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.rpcId !== "string" || value.rpcId.length === 0) return null;
  const payload =
    value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? (value.payload as Record<string, unknown>)
      : {};
  return {
    rpcId: value.rpcId,
    op: typeof value.op === "string" ? value.op : "",
    assistantId: String(value.assistantId ?? ""),
    payload,
  };
}

/** At most 300 characters, one line, and every em or en dash a hyphen. */
function safeMessage(text: string): string {
  const flat = text.replace(DASHES, "-").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, MESSAGE_MAX).join("");
}

function failure(code: string, message: string): ChangesResultBody {
  return { ok: false, error: { code, message: safeMessage(message) } };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `result` is null once the answer was let go (its hold ran out, or it
 * fell out of the newest ANSWER_KEEP). */
type Answered = { state: "done"; result: ChangesResultBody | null };
type Seen = { state: "running" } | Answered;

function scheduleUnref(run: () => void, ms: number): void {
  const timer = setTimeout(run, ms) as { unref?: () => unknown };
  timer.unref?.();
}

/** Build the non throwing handler for pairing room `changes_rpc` frames. */
export function createChangesHandler(deps: ChangesHandlerDeps) {
  const nowImpl = deps.nowImpl ?? Date.now;
  const schedule = deps.schedule ?? scheduleUnref;
  const newRunGit = deps.newRunGit ?? (() => createNodeRunGit());
  const collect: ChangesCollect =
    deps.collect ??
    ((input) =>
      collectChanges({ ...input, runGit: newRunGit(), fs: nodeChangesFs }));
  const seen = new Map<string, Seen>();
  /** The entries still holding their answer, oldest first. */
  let kept: Answered[] = [];

  const report = (message: string): void => {
    try {
      deps.log?.(safeMessage(message));
    } catch {
      // Logging must not affect the answer.
    }
  };

  const remember = (rpcId: string, entry: Seen): void => {
    seen.set(rpcId, entry);
    while (seen.size > SEEN_LIMIT) {
      const oldest = seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  };

  const letGo = (entry: Answered): void => {
    entry.result = null;
    kept = kept.filter((held) => held !== entry);
  };

  /** Remember an answer: the id for good (bounded), the body only for the
   * backend's hold and only while it is among the newest ANSWER_KEEP. */
  const rememberAnswer = (rpcId: string, result: ChangesResultBody): void => {
    const entry: Answered = { state: "done", result };
    remember(rpcId, entry);
    kept.push(entry);
    while (kept.length > ANSWER_KEEP) {
      const oldest = kept.shift();
      if (oldest) oldest.result = null;
    }
    schedule(() => letGo(entry), CHANGES_ANSWER_HOLD_MS);
  };

  const answer = async (frame: ChangesRpcFrame): Promise<ChangesResultBody> => {
    if (frame.op !== "diff") {
      return failure("unsupported", "only the diff operation is supported");
    }
    if (frame.payload.scope !== "uncommitted") {
      return failure("bad_request", "only the uncommitted scope is supported");
    }
    let result: ChangesResultBody;
    try {
      result = await collect({
        workdir: deps.workdir,
        caps: readCaps(frame.payload),
      });
    } catch (error) {
      // The error's own text stays here: it can name the owner's folder.
      report(`changes_rpc read failed: ${errorText(error)}`);
      return failure(
        "read_failed",
        error instanceof GitCommandError
          ? `${READ_FAILED_MESSAGE}: ${error.summary}`
          : READ_FAILED_MESSAGE,
      );
    }
    if (!result.ok) return failure(result.error.code, result.error.message);
    return result;
  };

  const postResult = async (
    rpcId: string,
    result: ChangesResultBody,
    receivedAt: number,
  ): Promise<void> => {
    try {
      await deps.api.changesRpcResult(rpcId, result);
      return;
    } catch (error) {
      if (
        nowImpl() + CHANGES_RESULT_TIMEOUT_MS >
        receivedAt + CHANGES_RESULT_DEADLINE_MS
      ) {
        report(`changes_rpc result failed: ${errorText(error)}`);
        return;
      }
    }
    try {
      await deps.api.changesRpcResult(rpcId, result);
    } catch (error) {
      report(`changes_rpc result failed: ${errorText(error)}`);
    }
  };

  return async (frame: ChangesRpcFrame): Promise<void> => {
    const receivedAt = nowImpl();
    try {
      if (!deps.owns(frame.assistantId)) return;
      const known = seen.get(frame.rpcId);
      if (known) {
        if (known.state === "done" && known.result !== null) {
          await postResult(frame.rpcId, known.result, receivedAt);
        }
        return;
      }
      remember(frame.rpcId, { state: "running" });

      // Best effort and never waited on before the work: a slow ack must not
      // eat into the backend's 20 s hold.
      try {
        void deps.api.changesRpcAck(frame.rpcId).catch((error: unknown) => {
          report(`changes_rpc ack failed: ${errorText(error)}`);
        });
      } catch (error) {
        report(`changes_rpc ack failed: ${errorText(error)}`);
      }

      const result = await answer(frame);
      rememberAnswer(frame.rpcId, result);
      await postResult(frame.rpcId, result, receivedAt);
    } catch (error) {
      report(`changes_rpc handler failed: ${errorText(error)}`);
    }
  };
}
