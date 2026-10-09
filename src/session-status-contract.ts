/**
 * The session status contract: what a channel connection reports on its
 * heartbeat about the session behind it, and the marker on the texts the
 * connection posts as itself (HOAI board row 9c3d6b2c, session liveness).
 *
 * THIS FILE IS COPIED BYTE FOR BYTE between
 *   github.com/BrandGrowthOS/BGOS
 *     backend/src/integrations/session-status-contract.ts
 *   github.com/BrandGrowthOS/bgos-claude-plugin
 *     lib/session-status-contract.ts
 *   github.com/BrandGrowthOS/codex-channel-bgos
 *     src/session-status-contract.ts
 * and each repo pins the sha256 of its own copy, as a literal, in a test
 * (BGOS: backend/src/integrations/session-status-contract.pin.spec.ts;
 * bgos-claude-plugin: test/session-status-contract.pin.test.ts;
 * codex-channel-bgos: test/session-status-contract.pin.spec.ts). The three
 * literals are the same digest. Changing this file means changing ALL THREE
 * copies and ALL THREE pinned digests in one set of PRs; a change that lands
 * in one repo only turns that repo's pin red, and that is the point.
 *
 * Rules, so every toolchain reads the same bytes unchanged:
 *  - no imports, LF line endings, and the BGOS backend's prettier style;
 *  - ERASABLE TypeScript only: exported const, function, interface and type,
 *    never an enum, a namespace, a decorator or a class, because the Claude
 *    plugin runs its copy through node's type stripping.
 *
 * WHAT A REPORT IS. Facts the connection already has about its session, never
 * content: no message text, no file name, no command, no path. Counts, one
 * flag per fact, and instants. The SERVER turns them into a word (Working,
 * Needs you, online, Not responding, Offline); a connection never sends one.
 */

/** The heartbeat body key the report rides under. */
export const SESSION_STATUS_KEY = 'sessionStatus';

/** The one schema version this file describes. Any other is dropped whole. */
export const SESSION_STATUS_VERSION = 1;

/** Counts are whole numbers from 0; a larger one is clipped to this. */
export const SESSION_STATUS_MAX_COUNT = 999;

/** An instant on the wire is ISO 8601 and at most this many characters. */
export const SESSION_STATUS_MAX_INSTANT = 40;

/**
 * THE CADENCE, shared because the server's staleness rule depends on it. A
 * connection sends a changed report within SESSION_STATUS_CHANGE_MS of the
 * change, and re-sends it every SESSION_STATUS_BUSY_MS while `busy` is true.
 * The server reads a busy report that has not been renewed for
 * SESSION_STATUS_STALE_MS as the connection having stopped reporting while
 * work was owed: three missed busy beats, so one lost POST never reads as
 * stopped.
 */
export const SESSION_STATUS_CHANGE_MS = 60_000;
export const SESSION_STATUS_BUSY_MS = 120_000;
export const SESSION_STATUS_STALE_MS = 3 * SESSION_STATUS_BUSY_MS;

/** Every field a version 1 report may carry, in wire order. */
export const SESSION_STATUS_FIELDS: readonly string[] = Object.freeze([
  'v',
  'at',
  'busy',
  'lastActivityAt',
  'taskOpen',
  'questionsWaiting',
  'messagesWaiting',
  'oldestMessageAt',
  'running',
]);

/**
 * One report. The first four fields are REQUIRED of every sender; the rest
 * are optional, and an absent one means "this connection does not report
 * it", never zero. The Codex connection sends the four required fields only.
 */
export interface SessionStatusReport {
  /** Always SESSION_STATUS_VERSION. */
  v: number;
  /**
   * The connection's own clock when it built the report. The server measures
   * every age in this report against `at`, never against its own clock, so a
   * machine whose clock is off cannot make a session look older or younger.
   */
  at: string;
  /**
   * Work is owed: a task open, a message waiting, a question open or
   * something running. For Codex: a turn running or queued in any chat.
   */
  busy: boolean;
  /**
   * The last time the SESSION did something: a hook event, a tool call, a
   * transcript write, a turn starting or ending. Never the connection's own
   * doings (a poll, a delivery, a heartbeat). Null when never seen.
   */
  lastActivityAt: string | null;
  /**
   * A turn is in flight. Null when the connection cannot tell (a Claude Code
   * session whose folder registers no HOAI hooks): the server then claims no
   * Working from this report.
   */
  taskOpen?: boolean | null;
  /** Permission, approval and question cards waiting on the owner. */
  questionsWaiting?: number;
  /** Messages delivered to the session that it has not answered yet. */
  messagesWaiting?: number;
  /** When the oldest of those reached the connection; null with none. */
  oldestMessageAt?: string | null;
  /** Commands and helper agents the session started, still running. */
  running?: number;
}

/** Why a report was dropped: a code for one log line, never content. */
export type SessionStatusDropReason =
  | 'not_object'
  | 'bad_version'
  | 'bad_at'
  | 'bad_busy'
  | 'bad_last_activity'
  | 'bad_task_open'
  | 'bad_count'
  | 'bad_oldest_message';

export type SessionStatusParse =
  | { ok: true; report: SessionStatusReport }
  | { ok: false; reason: SessionStatusDropReason };

/**
 * Read a report off the wire. Pure and total: never throws. A report it
 * cannot read is dropped WHOLE, never field by field, because a dropped
 * `running` would read as "nothing running" and could make a long build look
 * frozen. Unknown keys are ignored, so a newer sender is still read; the
 * result holds the known fields only, so no free text can ride along.
 */
export function parseSessionStatus(raw: unknown): SessionStatusParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not_object' };
  }
  const r = raw as Record<string, unknown>;
  if (r.v !== SESSION_STATUS_VERSION) {
    return { ok: false, reason: 'bad_version' };
  }
  if (!isInstant(r.at)) return { ok: false, reason: 'bad_at' };
  if (typeof r.busy !== 'boolean') return { ok: false, reason: 'bad_busy' };
  if (r.lastActivityAt !== null && !isInstant(r.lastActivityAt)) {
    return { ok: false, reason: 'bad_last_activity' };
  }
  const report: SessionStatusReport = {
    v: SESSION_STATUS_VERSION,
    at: r.at,
    busy: r.busy,
    lastActivityAt: r.lastActivityAt,
  };
  if (r.taskOpen !== undefined) {
    if (r.taskOpen !== null && typeof r.taskOpen !== 'boolean') {
      return { ok: false, reason: 'bad_task_open' };
    }
    report.taskOpen = r.taskOpen;
  }
  for (const key of [
    'questionsWaiting',
    'messagesWaiting',
    'running',
  ] as const) {
    if (r[key] === undefined) continue;
    const count = readCount(r[key]);
    if (count === null) return { ok: false, reason: 'bad_count' };
    report[key] = count;
  }
  if (r.oldestMessageAt !== undefined) {
    if (r.oldestMessageAt !== null && !isInstant(r.oldestMessageAt)) {
      return { ok: false, reason: 'bad_oldest_message' };
    }
    report.oldestMessageAt = r.oldestMessageAt;
  }
  return { ok: true, report };
}

/** ISO 8601 with a time and a zone, as Date.prototype.toISOString writes. */
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isInstant(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length <= SESSION_STATUS_MAX_INSTANT &&
    INSTANT.test(raw) &&
    Number.isFinite(Date.parse(raw))
  );
}

/** A whole number from 0, clipped to the bound; null when it is not one. */
function readCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return null;
  }
  return Math.min(raw, SESSION_STATUS_MAX_COUNT);
}

/** The send-message body field that marks a text as the connection's own. */
export const POSTED_BY_FIELD = 'postedBy';

/**
 * Its one value. A text the connection posts AS the agent (its not answering
 * warning, its /status answer, its compact and goal notices) carries it, so
 * nothing that asks "did the agent write anything?" reads it as the session
 * answering. The session's own replies never carry it.
 */
export const POSTED_BY_CONNECTION = 'connection';

/** The marker as the server stores it: the exact word, or null. */
export function readPostedBy(raw: unknown): 'connection' | null {
  return raw === POSTED_BY_CONNECTION ? POSTED_BY_CONNECTION : null;
}
