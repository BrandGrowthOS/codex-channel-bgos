/**
 * The chat to agent pairs this daemon has seen, kept on disk (P5 stage 7,
 * C-26, Phase B, decision 3).
 *
 * A daemon serving SEVERAL agents learns which agent a chat belongs to only
 * from an event that names both (a message, a click, a mission frame), and
 * the adapter's in memory map is empty at every boot. The model and effort
 * connect sweep has to name the agent of every chat whose settings the store
 * holds, or those chats are never re-reported after a restart. So every pair
 * the adapter notes is written through to this file, and the next process
 * reads it back.
 *
 * A CACHE, NEVER THE SOURCE OF TRUTH: the adapter uses a pair only for an
 * agent this daemon still owns (its scope, loaded from whoami), and the route
 * refuses a wrong one anyway. Bounded: the oldest pair goes first.
 *
 * File: `$CODEX_BGOS_HOME/chat-assistants.json`, a flat
 * `{ "<chatId>": <assistantId> }` object, atomic tmp and rename, mode 0600,
 * exactly like threads.json. A write never throws: a persistence hiccup costs
 * one sweep's worth of reports, never the daemon.
 *
 * No em or en dashes anywhere in this file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How many pairs are kept. More than the chats one daemon really serves. */
export const CHAT_ASSISTANTS_LIMIT = 2000;

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export class ChatAssistantStore {
  private readonly pairs = new Map<number, number>();

  constructor(
    private readonly file: string,
    private readonly limit: number = CHAT_ASSISTANTS_LIMIT,
  ) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (!/^[1-9]\d*$/.test(key)) continue;
          const chatId = Number(key);
          if (isId(chatId) && isId(value)) this.pairs.set(chatId, value);
        }
      }
    } catch {
      /* No file on the first run, or an unreadable one: start empty. */
    }
  }

  /** The agent this chat was last seen with, or null. */
  get(chatId: number): number | null {
    return this.pairs.get(chatId) ?? null;
  }

  /** Note a pair; written through only when it changed. Never throws. */
  set(chatId: number, assistantId: number): void {
    if (!isId(chatId) || !isId(assistantId)) return;
    if (this.pairs.get(chatId) === assistantId) return;
    this.pairs.delete(chatId);
    this.pairs.set(chatId, assistantId);
    while (this.pairs.size > this.limit) {
      const oldest = this.pairs.keys().next().value;
      if (oldest === undefined) break;
      this.pairs.delete(oldest);
    }
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify(Object.fromEntries(this.pairs), null, 2),
        { mode: 0o600 },
      );
      renameSync(tmp, this.file);
    } catch {
      // See the header: the in memory pairs still serve this process.
    }
  }
}
