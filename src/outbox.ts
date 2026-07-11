/**
 * Durable outbound spool for the BGOS channel.
 *
 * When an outbound send fails 3 times against the safe network-error class
 * (see outbound.ts classifyOutboundError), the payload is appended here so a
 * later reconnect / 60s replay tick can retry it. This is safe ONLY for the
 * provably-undelivered network-error class: the backend message insert is not
 * idempotent, so ambiguous failures (timeouts, 5xx) are never spooled.
 *
 * File: `$CODEX_BGOS_HOME/bgos_outbox.jsonl` (default `~/.codex-bgos/bgos_outbox.jsonl`),
 * one JSON object per line. Cap 200 entries (drop-oldest). Entries older than
 * 24h are dropped on read. All writes are best-effort: a spool hiccup must
 * never crash the daemon.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { OutboundMessagePayload } from "./types.js";

export interface OutboxEntry {
  /** Epoch ms when the entry was spooled. */
  ts: number;
  payload: OutboundMessagePayload;
  replyVia?: "messages" | "send-message";
}

const MAX_ENTRIES = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function outboxPath(): string {
  const root = process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
  return join(root, "bgos_outbox.jsonl");
}

/** Read the spool, dropping entries older than 24h. Never throws. */
export function loadOutbox(): OutboxEntry[] {
  let raw: string;
  try {
    raw = readFileSync(outboxPath(), "utf8");
  } catch {
    return [];
  }
  const now = Date.now();
  const out: OutboxEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as OutboxEntry;
      if (
        entry &&
        typeof entry.ts === "number" &&
        now - entry.ts <= MAX_AGE_MS &&
        entry.payload
      ) {
        out.push(entry);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Append one entry, then compact to the newest MAX_ENTRIES. Never throws. */
export function appendOutbox(entry: OutboxEntry): void {
  try {
    const target = outboxPath();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, JSON.stringify(entry) + "\n", { mode: 0o600 });
    // Compact if we may have exceeded the cap.
    const entries = loadOutbox();
    if (entries.length > MAX_ENTRIES) {
      rewriteOutbox(entries.slice(entries.length - MAX_ENTRIES));
    }
  } catch {
    /* best-effort */
  }
}

/** Atomically replace the spool with `entries` (tmp + rename). Never throws. */
export function rewriteOutbox(entries: OutboxEntry[]): void {
  try {
    const target = outboxPath();
    mkdirSync(dirname(target), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, body ? body + "\n" : "", { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    /* best-effort */
  }
}

/** Empty the spool. Never throws. */
export function clearOutbox(): void {
  rewriteOutbox([]);
}
