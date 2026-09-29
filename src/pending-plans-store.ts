/**
 * Durable record of the plan cards this daemon has left waiting.
 *
 * WHY THIS EXISTS. `PlanLane.open` is an in memory Map, and a plan answer
 * reaches this plugin on exactly ONE wire: the WS `inbound_click` event.
 * `BgosWs.triggerBackfill` replays MESSAGES (`GET integrations/inbound?
 * since_message_id=`), and an answer is an UPDATE to an existing row
 * (`answered_at`), never a new row, so nothing replays it. The plan wait also
 * has no end by design: the card stands for its full day and the owner may
 * answer tomorrow. Put those together and the commonest way a plan wait ends
 * in silence is the daemon not being up at the moment of the tap.
 *
 * WHAT THAT COSTS, and it is more than one missed turn. `/plan` now holds the
 * chat's sandbox read only as well as its mode (src/plan-mode.ts), and both
 * halves are on disk, so the chat comes back read only. Nothing but the
 * answer, or a hand typed `/code`, gives the access back. The owner taps Go
 * ahead, the agent never hears, the status line says "Waiting for your go
 * ahead" for the rest of the day, and the chat cannot do the work it was just
 * approved for.
 *
 * So the ids are persisted and the next boot reads each card back (see
 * `sweepMissedPlanAnswers` in plan-lane.ts): an answer found there is
 * delivered once, and an UNANSWERED card is adopted back into the lane, which
 * is what lets a later tap resolve against it at all. This is the same shape
 * as pending-approvals-store.ts and `retireOrphanedApprovals`, which exist for
 * the same restart, and the asymmetry between the two lanes was the finding.
 *
 * File: `$CODEX_BGOS_HOME/bgos_pending_plans.json` (default
 * `~/.codex-bgos/...`). Format: a JSON array of entries in insertion order.
 * Atomic writes (tmp + rename, mode 0600), the same pattern as
 * pending-approvals-store.ts. Every error is swallowed: a persistence hiccup
 * must never cost the owner a turn.
 *
 * Bounded to MAX_PENDING (drop oldest). One entry per open plan, and there is
 * at most one open plan per chat, so in normal running this file is empty or
 * holds a handful of rows.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PendingPlanEntry {
  /** The BGOS message id of the plan card. */
  id: number;
  chatId: number;
  /** The assistant the reads and the PATCH are made as. */
  assistantId: number;
  /** The id the row is READ as, i.e. the poll's `readUserId ?? userId`. */
  userId: string;
  /** Epoch ms when the card was posted. */
  at: number;
}

/** The surface the lane needs, so a test can hand it a fake. */
export interface PendingPlanStore {
  load(): PendingPlanEntry[];
  record(entry: PendingPlanEntry): void;
  clear(id: number): void;
}

/** Bound on the set (drop oldest), far above anything one daemon holds. */
const MAX_PENDING = 50;

function pendingPath(): string {
  const root = process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
  return join(root, "bgos_pending_plans.json");
}

/** Read the persisted set. Never throws; returns [] on any error. A row that
 *  does not carry every field needed to read the card back is dropped rather
 *  than half read: a request aimed at a guessed chat or assistant is worse
 *  than a card left alone. */
export function loadPendingPlans(): PendingPlanEntry[] {
  let raw: string;
  try {
    raw = readFileSync(pendingPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PendingPlanEntry[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const entry = row as PendingPlanEntry;
      if (
        Number.isInteger(entry.id) &&
        entry.id > 0 &&
        Number.isInteger(entry.chatId) &&
        entry.chatId > 0 &&
        Number.isInteger(entry.assistantId) &&
        entry.assistantId > 0 &&
        typeof entry.userId === "string" &&
        entry.userId.length > 0 &&
        typeof entry.at === "number" &&
        Number.isFinite(entry.at)
      )
        out.push({
          id: entry.id,
          chatId: entry.chatId,
          assistantId: entry.assistantId,
          userId: entry.userId,
          at: entry.at,
        });
    }
    return out;
  } catch {
    return [];
  }
}

/** Atomically persist the set (tmp + rename). Never throws. */
function writePending(entries: PendingPlanEntry[]): void {
  try {
    const target = pendingPath();
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    /* swallow: see the module docstring */
  }
}

/** Record a card this daemon is now waiting on. Idempotent on the id. */
export function recordPendingPlan(entry: PendingPlanEntry): void {
  if (!Number.isInteger(entry.id) || entry.id <= 0) return;
  if (!entry.userId) return;
  const entries = loadPendingPlans();
  if (entries.some((e) => e.id === entry.id)) return;
  entries.push(entry);
  writePending(
    entries.length > MAX_PENDING
      ? entries.slice(entries.length - MAX_PENDING)
      : entries,
  );
}

/** Forget a card: it was answered, superseded, or a boot has settled it. */
export function clearPendingPlan(id: number): void {
  const entries = loadPendingPlans();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return;
  writePending(next);
}

/** The disk-backed store, which is what the daemon runs on. */
export const diskPendingPlans: PendingPlanStore = {
  load: loadPendingPlans,
  record: recordPendingPlan,
  clear: clearPendingPlan,
};
