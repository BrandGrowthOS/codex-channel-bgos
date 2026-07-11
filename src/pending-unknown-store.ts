/**
 * Durable set of inbound message ids that arrived for an assistant NOT yet in
 * the route map and were therefore left UNCONSUMED by the inbound handler.
 *
 * Why this exists (silent-loss fix). The disk cursor (bgos_last_id) advances
 * monotonically as KNOWN messages are consumed. A sibling known message with a
 * HIGHER id than an unconsumed unknown-assistant message would push the cursor
 * PAST the hole, so inboundSince(cursor) would never return the unknown message
 * again, even after its route later heals. Worst on multi-assistant pairings
 * (one bound sibling advancing the cursor past a not-yet-bound sibling's
 * message) and null agent_route assistants.
 *
 * Persisting the pending ids lets saveLastId CLAMP the cursor so it never
 * advances past the LOWEST still-pending unknown id, keeping the inbound window
 * re-fetchable until identity heals. ProcessedIdsCache dedupes the already
 * consumed ids above the hole, so re-fetching the window is safe.
 *
 * File: `$CODEX_BGOS_HOME/bgos_pending_unknown.json` (default `~/.codex-bgos/...`).
 * Format: JSON array of `{ id: number, at: number }` (epoch ms), insertion
 * order. Atomic writes (tmp + rename, mode 0600), same pattern as
 * last-id-store. All errors swallowed: a persistence hiccup must never crash
 * the adapter.
 *
 * Bounded to MAX_PENDING (drop-oldest). A genuinely-never-bound assistant that
 * floods the lane can therefore hold the cursor back by at most the newest
 * MAX_PENDING ids, never forever: the oldest pending ids age out and the cursor
 * is free to advance past them. This is the "cap the clamp" guard; the adapter
 * surfaces a visible heartbeat lastError while the set is stuck so the bounded
 * loss is never silent.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PendingUnknownEntry {
  /** BGOS inbound message id left unconsumed. */
  id: number;
  /** Epoch ms when first recorded. */
  at: number;
}

/** Bound on the pending set (drop-oldest). Caps how far the clamp can hold the
 *  cursor back so a never-binding assistant cannot wedge it forever. */
const MAX_PENDING = 50;

function pendingPath(): string {
  const root = process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
  return join(root, "bgos_pending_unknown.json");
}

/** Read the persisted pending set. Never throws; returns [] on any error. */
export function loadPendingUnknown(): PendingUnknownEntry[] {
  let raw: string;
  try {
    raw = readFileSync(pendingPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PendingUnknownEntry[] = [];
    for (const e of parsed) {
      if (
        e &&
        typeof e === "object" &&
        Number.isInteger((e as PendingUnknownEntry).id) &&
        (e as PendingUnknownEntry).id > 0 &&
        typeof (e as PendingUnknownEntry).at === "number"
      ) {
        out.push({
          id: (e as PendingUnknownEntry).id,
          at: (e as PendingUnknownEntry).at,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Atomically persist the pending set (tmp + rename). Never throws. */
function writePending(entries: PendingUnknownEntry[]): void {
  try {
    const target = pendingPath();
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    /* swallow: persistence hiccup must never crash the adapter */
  }
}

/**
 * Record an id as pending-unknown. Idempotent (a repeated poll re-fetch of the
 * same unconsumed id does not duplicate the entry). Bounded to MAX_PENDING by
 * dropping the oldest entries.
 */
export function recordPendingUnknown(id: number): void {
  if (!Number.isInteger(id) || id <= 0) return;
  const entries = loadPendingUnknown();
  if (entries.some((e) => e.id === id)) return;
  entries.push({ id, at: Date.now() });
  const bounded =
    entries.length > MAX_PENDING
      ? entries.slice(entries.length - MAX_PENDING)
      : entries;
  writePending(bounded);
}

/** Remove an id from the pending set (it has now been consumed). No-op when
 *  the id is absent. Never throws. */
export function clearPendingUnknown(id: number): void {
  const entries = loadPendingUnknown();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return;
  writePending(next);
}

/** Lowest still-pending unknown id, or null when the set is empty. Used by
 *  saveLastId to clamp the disk cursor. */
export function lowestPendingUnknown(): number | null {
  const entries = loadPendingUnknown();
  if (entries.length === 0) return null;
  let lowest = entries[0].id;
  for (const e of entries) if (e.id < lowest) lowest = e.id;
  return lowest;
}

/** Count + oldest timestamp, for the adapter's visible stuck telemetry. */
export function pendingUnknownStats(): { count: number; oldestAt: number | null } {
  const entries = loadPendingUnknown();
  if (entries.length === 0) return { count: 0, oldestAt: null };
  let oldest = entries[0].at;
  for (const e of entries) if (e.at < oldest) oldest = e.at;
  return { count: entries.length, oldestAt: oldest };
}
