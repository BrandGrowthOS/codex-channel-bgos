/**
 * Persistent map from a BGOS chat id to its Codex thread id.
 *
 * One BGOS chat maps to one long-lived Codex thread: the first user message
 * calls `codex.startThread()`, captures `thread.id` from the `thread.started`
 * event, and stores it here; later messages call `codex.resumeThread(id)` so the
 * conversation keeps its context across daemon restarts (Codex persists the
 * thread body itself under ~/.codex/sessions). The bridge-local `/new` command
 * calls `resetChat` so the next message starts a fresh thread.
 *
 * File: `$CODEX_BGOS_HOME/threads.json` (default `~/.codex-bgos/threads.json`),
 * a flat `{ "<chatId>": "<threadId>" }` object, atomic tmp+rename, mode 0600.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export type ThreadMap = Record<string, string>;

/** Resolve the CODEX_BGOS_HOME root (respects the env override). */
function codexBgosHome(): string {
  return process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
}

/** Path to threads.json; `dir` overrides the home (used in tests). */
export function threadsPath(dir?: string): string {
  return join(dir ?? codexBgosHome(), "threads.json");
}

function keyOf(chatId: string | number): string {
  return String(chatId);
}

/** Load the map from disk. Returns {} on any read/parse error (never throws). */
export function loadThreadMap(path: string = threadsPath()): ThreadMap {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ThreadMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Read the thread id for a chat, or undefined if unmapped. */
export function getThreadId(
  map: ThreadMap,
  chatId: string | number,
): string | undefined {
  return map[keyOf(chatId)];
}

function persist(path: string, map: ThreadMap): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // A persistence hiccup must never crash the daemon; the in-memory map still
    // works for the current process, and the next successful write recovers it.
  }
}

/** Set (or overwrite) the thread id for a chat and persist. Mutates `map`. */
export function setThreadId(
  path: string,
  map: ThreadMap,
  chatId: string | number,
  threadId: string,
): void {
  map[keyOf(chatId)] = threadId;
  persist(path, map);
}

/** Drop a chat's thread binding and persist (bridge-local `/new`). Mutates `map`. */
export function resetChat(
  path: string,
  map: ThreadMap,
  chatId: string | number,
): void {
  delete map[keyOf(chatId)];
  persist(path, map);
}
