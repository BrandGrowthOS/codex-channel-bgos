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
 *  3. The last 256 ids are remembered with their answers: an id still running
 *     is ignored, an answered id gets the same answer again. Never forgotten in
 *     a `finally`, so the backend's re emit can never run Git twice.
 *  4. The ack is best effort; a failed ack never stops the work.
 *  5. The work runs under the frame's budget (git-changes.ts): past it the
 *     answer is `too_slow`.
 *  6. A result is ALWAYS posted; a throw answers `read_failed`. Every message
 *     is at most 300 characters with no em or en dash.
 *
 * The owner's per agent switch is NOT read here, or anywhere in this plugin:
 * the backend is the only gate, and it sends no frame while the switch is off.
 */
import {
  collectChanges,
  createNodeRunGit,
  nodeChangesFs,
  readCaps,
  type ChangesCaps,
  type ChangesResultBody,
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
  log?: (message: string) => void;
  nowImpl?: () => number;
}

/** How long one result post may take (BgosApi.changesRpcResult). */
export const CHANGES_RESULT_TIMEOUT_MS = 8_000;
/** How long one ack post may take (BgosApi.changesRpcAck). */
export const CHANGES_ACK_TIMEOUT_MS = 3_000;
/** A retry is tried only if it can still land this long after the frame
 * arrived: inside the backend's 20 s hold, with room to spare. */
export const CHANGES_RESULT_DEADLINE_MS = 18_000;

const SEEN_LIMIT = 256;
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

type Seen =
  | { state: "running" }
  | { state: "done"; result: ChangesResultBody };

/** Build the non throwing handler for pairing room `changes_rpc` frames. */
export function createChangesHandler(deps: ChangesHandlerDeps) {
  const nowImpl = deps.nowImpl ?? Date.now;
  const runGit = createNodeRunGit();
  const collect: ChangesCollect =
    deps.collect ??
    ((input) => collectChanges({ ...input, runGit, fs: nodeChangesFs }));
  const seen = new Map<string, Seen>();

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
      return failure("read_failed", `${READ_FAILED_MESSAGE}: ${errorText(error)}`);
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
        if (known.state === "done") {
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
      remember(frame.rpcId, { state: "done", result });
      await postResult(frame.rpcId, result, receivedAt);
    } catch (error) {
      report(`changes_rpc handler failed: ${errorText(error)}`);
    }
  };
}
