/**
 * Thread goals on the Codex app server wire (mission program stage 6).
 *
 * Pure and import safe: no I/O, no clock, no env read. The host's
 * notification table stays a branch table and everything that can be
 * reasoned about lives here, the same split mission-events.ts and
 * activity-markers.ts already use.
 *
 * The installed SDK types carry none of this, so every shape below is hand
 * written against the bindings the binary generates for itself
 * (`codex app-server generate-ts --experimental`) and against a live capture
 * of the traffic. Three rules matter more than the rest:
 *
 *  1. An UNKNOWN `status` is accepted and cast, never rejected. The runtime
 *     can add a goal state before this daemon knows the word, and a hard
 *     reject would silence the whole lane rather than one field. It is the
 *     same rule normalizeMission states at mission-events.ts:130.
 *  2. The wire is camelCase only. The snake_case row in the binary is its
 *     own SQLite table and never reaches a client, so nothing here reads it.
 *  3. `createdAt` and `updatedAt` are unix SECONDS the runtime stamped. They
 *     are carried whole for completeness and must never be subtracted to
 *     make a working time: `timeUsedSeconds` is the only elapsed number this
 *     runtime counted, and there is no turn counter anywhere in the
 *     protocol.
 */

/**
 * The six states a goal can hold, from the binary's own CHECK constraint on
 * its `thread_goals` table. `blocked` is the runtime's own three consecutive
 * turns with the same obstacle rule; the TUI prints it as "stalled".
 */
export type ThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

/** The whole goal object, exactly the eight fields the wire carries. */
export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  /** Null unless someone set one. This daemon never sets one. */
  tokenBudget: number | null;
  tokensUsed: number;
  /** Elapsed goal time the runtime counted, in seconds. */
  timeUsedSeconds: number;
  /** Unix seconds. Never subtract these two. */
  createdAt: number;
  updatedAt: number;
}

/**
 * One goal notification, resolved. `goal` is null for a cleared goal, which
 * is the only difference between the two notifications the runtime sends.
 * `turnId` names the turn that caused the change, and is null when the
 * change came from an RPC rather than from turn activity.
 */
export interface GoalSignal {
  threadId: string;
  turnId: string | null;
  goal: ThreadGoal | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number, or the fallback. Nothing here is ever NaN downstream. */
function finiteNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * One raw goal payload as the goal object, or null when it is not one.
 * Never throws: a malformed goal is dropped, never dispatched.
 */
export function normalizeThreadGoal(raw: unknown): ThreadGoal | null {
  if (!isPlainObject(raw)) return null;
  const threadId = typeof raw.threadId === "string" ? raw.threadId : "";
  if (!threadId) return null;
  return {
    threadId,
    objective: typeof raw.objective === "string" ? raw.objective : "",
    // Cast, not validate: rule 1 above.
    status: String(raw.status ?? "") as ThreadGoalStatus,
    tokenBudget:
      typeof raw.tokenBudget === "number" && Number.isFinite(raw.tokenBudget)
        ? raw.tokenBudget
        : null,
    tokensUsed: finiteNumber(raw.tokensUsed, 0),
    timeUsedSeconds: finiteNumber(raw.timeUsedSeconds, 0),
    createdAt: finiteNumber(raw.createdAt, 0),
    updatedAt: finiteNumber(raw.updatedAt, 0),
  };
}

/**
 * A goal notification, or null when the method is not one of the two. The
 * shape of markerFromNotification (activity-markers.ts:553), for the same
 * reason: both are events that arrive when this process has no turn of its
 * own open, so the host routes them above its turn guard and the reading
 * lives in a pure module.
 */
export function goalFromNotification(
  method: string,
  params: unknown,
): GoalSignal | null {
  if (method !== "thread/goal/updated" && method !== "thread/goal/cleared")
    return null;
  if (!isPlainObject(params)) return null;
  const threadId = typeof params.threadId === "string" ? params.threadId : "";
  if (!threadId) return null;
  if (method === "thread/goal/cleared")
    return { threadId, turnId: null, goal: null };
  const goal = normalizeThreadGoal(params.goal);
  if (!goal) return null;
  return {
    threadId,
    turnId: typeof params.turnId === "string" ? params.turnId : null,
    goal,
  };
}
