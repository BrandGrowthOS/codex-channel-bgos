/**
 * Durable record of the approval cards this daemon is still waiting on.
 *
 * WHY THIS EXISTS. The pending map in interactions.ts lives in memory, and the
 * Codex app server is a CHILD of this process, so a restart mid wait takes the
 * turn, its request and whatever would have run with it. What survives is the
 * card in the owner's chat, and it is still tappable: the backend refuses a
 * late tap only by the row's own `expired` flag, which its sweep sets once the
 * row is past its deadline. With the generic 60 s deadline that stale window
 * was about a minute. With a stored wait of up to half an hour it is up to half
 * an hour, and inside it the owner taps Allow, the tap is accepted and stamped,
 * the card draws as answered, and nothing runs.
 *
 * Persisting the ids lets the next boot retire those cards, buttons off (see
 * `retireOrphanedApprovals` in interactions.ts). Questions are deliberately not
 * persisted: an ask carousel dies at 600 s and is answered from a modal in
 * front of a person, so it has no half hour window to leave behind.
 *
 * File: `$CODEX_BGOS_HOME/bgos_pending_approvals.json` (default
 * `~/.codex-bgos/...`). Format: a JSON array of entries in insertion order.
 * Atomic writes (tmp + rename, mode 0600), the same pattern as last-id-store
 * and pending-unknown-store. Every error is swallowed: a persistence hiccup
 * must never cost the owner a turn.
 *
 * Bounded to MAX_PENDING (drop oldest). An entry is cleared as soon as its wait
 * ends, so in normal running this file is empty or holds a single row.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PendingApprovalEntry {
  /** The BGOS message id of the approval card. */
  id: number;
  chatId: number;
  /** The assistant the PATCH that retires the card is made as. */
  assistantId: number;
  /** The id the row is READ as, i.e. the poll's `readUserId ?? userId`. */
  userId: string;
  /** Epoch ms when the card was posted. */
  at: number;
}

/** The surface interactions.ts needs, so a test can hand it a fake. */
export interface PendingApprovalStore {
  load(): PendingApprovalEntry[];
  record(entry: PendingApprovalEntry): void;
  clear(id: number): void;
}

/** Bound on the set (drop oldest), so a pathological run cannot grow the file
 *  without limit. Far above anything a single daemon holds at once. */
const MAX_PENDING = 50;

function pendingPath(): string {
  const root = process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
  return join(root, "bgos_pending_approvals.json");
}

/** Read the persisted set. Never throws; returns [] on any error. A row that
 *  does not carry every field needed to retire it is dropped rather than
 *  half read: a PATCH aimed at a guessed chat or assistant is worse than a
 *  card left alone. */
export function loadPendingApprovals(): PendingApprovalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(pendingPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PendingApprovalEntry[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const entry = row as PendingApprovalEntry;
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
function writePending(entries: PendingApprovalEntry[]): void {
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
export function recordPendingApproval(entry: PendingApprovalEntry): void {
  if (!Number.isInteger(entry.id) || entry.id <= 0) return;
  const entries = loadPendingApprovals();
  if (entries.some((e) => e.id === entry.id)) return;
  entries.push(entry);
  writePending(
    entries.length > MAX_PENDING
      ? entries.slice(entries.length - MAX_PENDING)
      : entries,
  );
}

/** Forget a card: its wait ended, or a boot has retired it. */
export function clearPendingApproval(id: number): void {
  const entries = loadPendingApprovals();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return;
  writePending(next);
}

/** The disk-backed store, which is what the daemon runs on. */
export const diskPendingApprovals: PendingApprovalStore = {
  load: loadPendingApprovals,
  record: recordPendingApproval,
  clear: clearPendingApproval,
};
