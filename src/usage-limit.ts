/**
 * When the Codex account runs out of usage (board row 5f610907).
 *
 * Before this file the runtime's own refusal reached the owner's chat as it
 * came, inside a red "Agent error" card: "You've hit your usage limit.
 * Upgrade to Pro (https://chatgpt.com/explore/pro), visit
 * https://chatgpt.com/settings/usage to purchase more credits or try again at
 * 3:04 PM." Links to buy something, a plan name, and a clock time read in
 * THIS machine's zone, which need not be the owner's. A non technical owner
 * reads that as "pay or it stays broken". And a goal the limit stopped stayed
 * stopped.
 *
 * What happens now, in three parts:
 *
 *  1. The raw words never leave this daemon. A refused turn is recognised by
 *     the runtime's own `codexErrorInfo: "usageLimitExceeded"`, or by its
 *     words when an older runtime gives no code (`isUsageLimitError`), and
 *     its error becomes `usageLimitLine()`, one plain sentence with no link,
 *     plan or model name, on every path that shows an error.
 *  2. In a chat, the agent RESTS instead: the reset instant is read from the
 *     account (`account/rateLimits/read`, `usageLimitReset`) and reported on
 *     HOAI's own status path as `status: "resting"` with `resetAt`. HOAI then
 *     draws its one plain line ("<name> is resting ... will send
 *     automatically at <time>") in the OWNER's language and local time, holds
 *     what they send, and ends the rest by itself at the reset. That is the
 *     shared rule every channel uses (served canon, Honest limits), so this
 *     daemon writes no wording or clock of its own for it. Only when the
 *     reset is unknown, or the rest cannot be reported, does the chat get
 *     the plain line instead, said relative to now ("in about 2 hours"),
 *     never as a clock time, for the reason `imageFailureLine` gives.
 *  3. A goal this daemon runs is picked back up after the reset: ONE resume
 *     through the app server's own goal call, a margin after the reset and
 *     never before it, and only while the runtime still holds the goal as
 *     `usageLimited` (an owner pause, clear or Stop in the meantime wins).
 *     The planned resume is kept on disk, because an idle daemon may update
 *     and restart inside the window.
 *
 * One notice per window: a second refusal inside the same window (the same
 * reset instant) reports nothing new. A restart inside the window reports the
 * same rest again, which HOAI keys on the reset instant, so the owner sees
 * no second line.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RpcObject } from "./app-server.js";
import { resetsIn } from "./generated-images.js";

const LOG = "[codex-channel-bgos]";

/**
 * THE WORDING, in one place so KC can change it. `when` is a relative phrase
 * from `resetsIn` ("in about 2 hours") or null when nobody knows.
 */
export function usageLimitLine(
  resetsAt?: number | null,
  now: number = Date.now(),
): string {
  const when = resetsIn(resetsAt ?? null, now);
  return when
    ? `Codex has used up its usage for now and starts again by itself ${when}. You do not need to do anything.`
    : "Codex has used up its usage for now and starts again by itself when the limit resets. You do not need to do anything.";
}

/**
 * The runtime's refusal for a spent account. The code first; the words only
 * for a runtime that sent no code (or an error that arrived as plain text,
 * from a JSON-RPC failure or a thrown Error). A rate limit (too many requests
 * at once) is a different thing and is not this.
 */
export function isUsageLimitError(error: unknown): boolean {
  if (error && typeof error === "object" && !(error instanceof Error)) {
    const info = (error as RpcObject).codexErrorInfo;
    if (info === "usageLimitExceeded") return true;
    if (info && typeof info === "object" && "usageLimitExceeded" in info) return true;
    return isUsageLimitText((error as RpcObject).message);
  }
  return isUsageLimitText(error instanceof Error ? error.message : error);
}

function isUsageLimitText(text: unknown): boolean {
  return typeof text === "string" && /\bhit your usage limit\b|\busage limit (?:reached|exceeded)\b/i.test(text);
}

export type UsageLimitKind = "session" | "weekly" | "unknown";

export interface UsageReset {
  /** ISO 8601, what HOAI's status path takes. */
  resetAt: string;
  /** The same instant, epoch milliseconds. */
  resetsAtMs: number;
  limitKind: UsageLimitKind;
}

/** Up to a day reads as the session window; longer, the weekly one. */
const SESSION_WINDOW_MAX_MINS = 24 * 60;

/**
 * When the account can work again, from one `account/rateLimits/read`
 * answer. The windows that are spent (100 percent used) are the ones holding
 * the agent back, and it can work again only once ALL of them have reset, so
 * the LATEST of their resets is the answer. Null when no spent window names a
 * reset still ahead: the account read failed, a window carries no time, or a
 * reset is already past (a stale snapshot, or a clock that disagrees), and a
 * timer on any of those would resume a goal into the same refusal.
 */
export function usageLimitReset(
  read: RpcObject | null | undefined,
  now: number,
): UsageReset | null {
  if (!read || typeof read !== "object") return null;
  const byId =
    read.rateLimitsByLimitId && typeof read.rateLimitsByLimitId === "object"
      ? (Object.values(read.rateLimitsByLimitId) as RpcObject[])
      : [];
  const buckets = byId.length ? byId : read.rateLimits ? [read.rateLimits as RpcObject] : [];
  let latest: { ms: number; mins: number | null } | null = null;
  let unknownSpent = false;
  for (const bucket of buckets) {
    for (const key of ["primary", "secondary"]) {
      const window = bucket?.[key] as RpcObject | null | undefined;
      if (!window || typeof window.usedPercent !== "number" || window.usedPercent < 100)
        continue;
      const at = window.resetsAt;
      if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) {
        unknownSpent = true;
        continue;
      }
      // Seconds on this protocol; a value this large can only be milliseconds.
      const ms = at > 1e12 ? at : at * 1000;
      const mins = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
      if (!latest || ms > latest.ms) latest = { ms, mins };
    }
  }
  // A spent window with no time may outlast the one that has a time, so the
  // time that is known is not the answer.
  if (!latest || unknownSpent || latest.ms <= now) return null;
  const limitKind: UsageLimitKind =
    latest.mins === null ? "unknown" : latest.mins <= SESSION_WINDOW_MAX_MINS ? "session" : "weekly";
  return { resetAt: new Date(latest.ms).toISOString(), resetsAtMs: latest.ms, limitKind };
}

/**
 * How long after the reset the goal is resumed. The account's reset is the
 * server's, read off a snapshot, and a resume a moment early is refused again
 * at once, so it waits a minute past it.
 */
export const USAGE_RESUME_MARGIN_MS = 60_000;

/** What a goal resume needs after a restart, when the goal lane holds nothing. */
export interface UsageResumeContext {
  assistantId: number;
  missionId: number;
  objective: string;
  turnCap: number | null;
}

export interface UsageResumeRecord extends UsageResumeContext {
  chatId: number;
  /** The reset instant, epoch milliseconds. The resume waits for it. */
  resetsAtMs: number;
}

/** A small file of planned resumes, one per chat. Never throws. */
export class UsageResumeStore {
  private records: UsageResumeRecord[] | null = null;

  /** `path` null keeps them in memory only (what the tests default to). */
  constructor(private readonly path: string | null) {}

  all(): UsageResumeRecord[] {
    return [...this.load()];
  }

  put(record: UsageResumeRecord): void {
    const records = this.load().filter((r) => r.chatId !== record.chatId);
    records.push(record);
    this.save(records);
  }

  delete(chatId: number): void {
    const records = this.load();
    const kept = records.filter((r) => r.chatId !== chatId);
    if (kept.length !== records.length) this.save(kept);
  }

  private load(): UsageResumeRecord[] {
    if (this.records) return this.records;
    this.records = [];
    if (!this.path) return this.records;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as { resumes?: unknown };
      if (Array.isArray(data?.resumes))
        this.records = data.resumes.filter(isResumeRecord).slice(-200);
    } catch {
      // Missing or unreadable: no resume was planned that this can know of.
    }
    return this.records;
  }

  private save(records: UsageResumeRecord[]): void {
    this.records = records;
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ resumes: records }), { mode: 0o600 });
      renameSync(temp, this.path);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`${LOG} ${this.path} not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isResumeRecord(value: unknown): value is UsageResumeRecord {
  const r = value as UsageResumeRecord;
  return (
    !!r &&
    typeof r === "object" &&
    isPositiveInt(r.chatId) &&
    isPositiveInt(r.assistantId) &&
    isPositiveInt(r.missionId) &&
    typeof r.objective === "string" &&
    typeof r.resetsAtMs === "number" &&
    Number.isFinite(r.resetsAtMs) &&
    (r.turnCap === null || typeof r.turnCap === "number")
  );
}

export interface UsageLimitLaneDeps {
  /** `account/rateLimits/read`. */
  readLimits: () => Promise<RpcObject>;
  /** Report the rest on HOAI's status path. A throw means it did not land. */
  rest: (assistantId: number, reset: UsageReset) => Promise<void>;
  /** The goal this daemon runs in the chat, or null for none. */
  goalFor: (chatId: number) => UsageResumeContext | null;
  /** ONE resume of the goal. Decides itself whether the goal still waits. */
  resume: (record: UsageResumeRecord) => Promise<void>;
  store?: UsageResumeStore;
  now?: () => number;
  log?: (message: string) => void;
}

export class UsageLimitLane {
  private readonly store: UsageResumeStore;
  private readonly now: () => number;
  /** `<assistant>:<reset>` already reported, so a window rests once. */
  private readonly rested = new Set<string>();
  /** Assistants already told an unknown reset, until a turn works again. */
  private readonly toldUnknown = new Set<number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: UsageLimitLaneDeps) {
    this.store = deps.store ?? new UsageResumeStore(null);
    this.now = deps.now ?? Date.now;
  }

  /**
   * A turn in this chat was refused for usage. `say` posts one line in the
   * chat; it is used only when there is no rest to report.
   */
  async noteLimited(
    assistantId: number,
    chatId: number,
    say: (text: string) => Promise<unknown>,
  ): Promise<void> {
    let read: RpcObject | null = null;
    try {
      read = await this.deps.readLimits();
    } catch (err) {
      this.log(`usage limit read failed chat=${chatId} err=${errorText(err)}`);
    }
    const now = this.now();
    const reset = usageLimitReset(read, now);
    if (!reset) {
      if (this.toldUnknown.has(assistantId)) return;
      this.toldUnknown.add(assistantId);
      await say(usageLimitLine(null, now)).catch(() => {});
      return;
    }
    this.toldUnknown.delete(assistantId);
    this.planResume(chatId, reset.resetsAtMs);
    const key = `${assistantId}:${reset.resetAt}`;
    if (this.rested.has(key)) return;
    try {
      await this.deps.rest(assistantId, reset);
      this.rested.add(key);
    } catch (err) {
      // No rest landed, so nothing in the app says it: the chat gets the
      // line instead, once for this window.
      this.log(`usage rest failed assistant=${assistantId} err=${errorText(err)}`);
      this.rested.add(key);
      await say(usageLimitLine(reset.resetsAtMs, now)).catch(() => {});
    }
  }

  /** A turn of this assistant worked: an unknown reset may be told again. */
  noteWorked(assistantId: number): void {
    this.toldUnknown.delete(assistantId);
  }

  /** Arm the resumes a restart left on disk. */
  restore(): void {
    for (const record of this.store.all()) this.arm(record);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private planResume(chatId: number, resetsAtMs: number): void {
    const goal = this.deps.goalFor(chatId);
    if (!goal) return;
    const record: UsageResumeRecord = { ...goal, chatId, resetsAtMs };
    this.store.put(record);
    this.arm(record);
  }

  private arm(record: UsageResumeRecord): void {
    const prior = this.timers.get(record.chatId);
    if (prior) clearTimeout(prior);
    const wait = Math.max(0, record.resetsAtMs + USAGE_RESUME_MARGIN_MS - this.now());
    const timer = setTimeout(() => void this.fire(record), wait);
    timer.unref?.();
    this.timers.set(record.chatId, timer);
  }

  private async fire(record: UsageResumeRecord): Promise<void> {
    // A timer that fires early (a clock that moved) waits again: never a
    // resume before the reset.
    if (this.now() < record.resetsAtMs + USAGE_RESUME_MARGIN_MS) {
      this.arm(record);
      return;
    }
    this.timers.delete(record.chatId);
    this.store.delete(record.chatId);
    try {
      await this.deps.resume(record);
    } catch (err) {
      this.log(`goal resume after usage limit failed chat=${record.chatId} err=${errorText(err)}`);
    }
  }

  private log(message: string): void {
    if (this.deps.log) this.deps.log(message);
    // eslint-disable-next-line no-console
    else console.warn(`${LOG} ${message}`);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
