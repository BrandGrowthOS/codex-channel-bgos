/**
 * Persistent cursor for the BGOS WebSocket inbound stream.
 *
 * CRITICAL - DO NOT REGRESS. Without persistence the adapter will replay
 * every historical message on every restart (the REST backfill cursor
 * starts at the loaded value), producing duplicate agent replies forever.
 *
 * See `memory/hermes_integration_shipped.md` "Critical gotcha: last-id
 * persistence" for the full background - this is the same fix as Hermes
 * commit-to-disk pattern, ported to TypeScript.
 *
 * File location: `$CODEX_BGOS_HOME/bgos_last_id` (default `~/.codex-bgos/bgos_last_id`).
 *
 * Format: a single integer in plain text, no newline. Atomic writes via
 * write-to-tempfile + rename so a crash mid-write can't leave a half-
 * written file.
 *
 * All errors are swallowed - disk full, permission denied, missing
 * directory, etc. The worst case is a one-time replay on the next start;
 * we'd rather not crash the adapter for a persistence hiccup.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { lowestPendingUnknown } from "./pending-unknown-store.js";

/** Resolve the target file path; respects `CODEX_BGOS_HOME` env override. */
function lastIdPath(): string {
  const root = process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
  return join(root, "bgos_last_id");
}

/**
 * Read the persisted cursor.
 *
 * Returns 0 when:
 *   - The file does not exist (fresh install).
 *   - The file is unreadable (permissions, IO error).
 *   - The file's contents do not parse as a positive integer (corruption,
 *     truncation, manual edit).
 *
 * Never throws - the adapter calls this on hot paths and crashing here
 * would block boot.
 */
export function loadLastId(): number {
  try {
    const raw = readFileSync(lastIdPath(), "utf8").trim();
    if (!raw) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
    return n;
  } catch {
    return 0;
  }
}

/**
 * Atomically persist the cursor.
 *
 * Skips:
 *   - Non-positive ids (0 means "no progress"; negative is malformed).
 *   - Ids less than or equal to the currently persisted value (cursor must
 *     advance monotonically). This guards against a backfill replay
 *     accidentally rewinding the cursor.
 *
 * Clamp: the cursor never advances past the LOWEST still-pending unknown
 * assistant id (see pending-unknown-store). Without this a sibling KNOWN
 * message with a higher id would push the cursor past an unconsumed unknown
 * message, stranding it forever (silent loss). The clamp holds the cursor just
 * below the hole so the inbound window stays re-fetchable until the route heals
 * and the pending id is consumed + cleared.
 *
 * Errors are caught + ignored - see module docstring.
 */
export function saveLastId(id: number): void {
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return;
  try {
    const current = loadLastId();
    // Clamp against the lowest pending-unknown id so the cursor never strands
    // an unconsumed message above the hole.
    let advanceTo = id;
    const lowest = lowestPendingUnknown();
    if (lowest !== null && advanceTo >= lowest) {
      advanceTo = lowest - 1;
    }
    if (advanceTo <= current) return;
    const target = lastIdPath();
    mkdirSync(dirname(target), { recursive: true });
    // Write to a sibling tempfile then rename so a partial write never
    // leaves us with a corrupt cursor.
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, String(advanceTo), { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    /* swallow - see module docstring */
  }
}
