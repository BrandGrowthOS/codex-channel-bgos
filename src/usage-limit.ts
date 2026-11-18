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
 *     its error becomes `usageLimitLine(cause)`, one plain sentence with no link,
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
 * Every refusal reports the rest again (review F1): the backend keeps it in
 * memory only, so a deploy or a new turn can end it inside the window. HOAI
 * keys its one line on the reset instant, so the same window, from this
 * process or after a restart, shows the owner nothing new. A refusal that
 * never resets by itself (an account out of quota or credits, a spend cap)
 * says so in its own line and rests nothing (review F2). A chat line is said
 * once per chat and again after three hours (review F7).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RpcObject } from "./app-server.js";
import { resetsIn } from "./generated-images.js";

const LOG = "[codex-channel-bgos]";

/**
 * Why the runtime refused (review F2). Codex sends the one code,
 * `usageLimitExceeded`, for five different things, and only the first of
 * them ends by itself:
 *  - `window`: a usage window is spent ("You've hit your usage limit ...").
 *    It resets at a known time.
 *  - `account`: an API key out of quota, a plan with no Codex in it, a
 *    workspace out of credits, a spend cap its owner set. Nothing starts
 *    again until somebody adds usage, so the owner is told so.
 *  - `unclear`: the code with words this daemon has not met. Neither promise
 *    is made.
 */
export type UsageLimitCause = "window" | "account" | "unclear";

const WINDOW_TEXT = /\bhit your usage limit\b/i;
const ACCOUNT_TEXT =
  /\bquota exceeded\b|\bout of credits\b|\badd credits\b|\bspend cap\b|\bto use codex with your\b|\bnot included in your plan\b/i;
const UNCLEAR_TEXT = /\busage limit (?:reached|exceeded)\b/i;

/**
 * THE WORDING, in one place so KC can change it. `resetsAt` (epoch seconds
 * or milliseconds) adds a relative phrase from `resetsIn` ("in about 2
 * hours") to the window line, never a clock time.
 */
export function usageLimitLine(
  cause: UsageLimitCause = "window",
  resetsAt?: number | null,
  now: number = Date.now(),
): string {
  if (cause === "account")
    return "Codex has no usage left on its account and will not start again by itself. Add usage or raise the limit in the Codex account, then send your message again.";
  if (cause === "unclear")
    return "Codex has no usage left right now. It may start again by itself when the limit resets, or its account may need more usage.";
  const when = resetsIn(resetsAt ?? null, now);
  return when
    ? `Codex has used up its usage for now and starts again by itself ${when}. You do not need to do anything.`
    : "Codex has used up its usage for now and starts again by itself when the limit resets. You do not need to do anything.";
}

/**
 * The runtime's refusal for spent usage, and which kind, or null when the
 * error is something else. The words first, because they say which kind;
 * the code alone is `unclear`. A rate limit (too many requests at once) is
 * a different thing and is not this.
 */
export function usageLimitCause(error: unknown): UsageLimitCause | null {
  let text: unknown = error;
  let coded = false;
  if (error && typeof error === "object" && !(error instanceof Error)) {
    const info = (error as RpcObject).codexErrorInfo;
    coded =
      info === "usageLimitExceeded" ||
      (!!info && typeof info === "object" && "usageLimitExceeded" in info);
    text = (error as RpcObject).message;
  } else if (error instanceof Error) {
    text = error.message;
  }
  const words = typeof text === "string" ? text : "";
  if (WINDOW_TEXT.test(words)) return "window";
  if (ACCOUNT_TEXT.test(words)) return "account";
  if (coded || UNCLEAR_TEXT.test(words)) return "unclear";
  return null;
}

export function isUsageLimitError(error: unknown): boolean {
  return usageLimitCause(error) !== null;
}

export type UsageLimitKind = "session" | "weekly" | "unknown";

export interface UsageReset {
  /** ISO 8601, what HOAI's status path takes. */
  resetAt: string;
  /** The same instant, epoch milliseconds. */
  resetsAtMs: number;
  limitKind: UsageLimitKind;
}

/**
 * The bucket a turn runs on (review F4): the read's default `rateLimits`,
 * which is the Codex bucket, or `rateLimitsByLimitId.codex` when only the
 * multi bucket view came. Another model's bucket says nothing about this
 * turn, and its later reset would hold the agent days too long.
 */
function turnBucket(read: RpcObject | null | undefined): RpcObject | null {
  if (!read || typeof read !== "object") return null;
  if (read.rateLimits && typeof read.rateLimits === "object") return read.rateLimits as RpcObject;
  const codex = read.rateLimitsByLimitId?.codex;
  return codex && typeof codex === "object" ? (codex as RpcObject) : null;
}

/**
 * Whether the account says the refusal is its own and not a window's: a
 * workspace out of credits or at its owner's cap (review F2). A window with
 * a reset may still be spent beside it, and it is not what holds the agent.
 */
export function accountHoldsIt(read: RpcObject | null | undefined): boolean {
  const type = turnBucket(read)?.rateLimitReachedType;
  return typeof type === "string" && type !== "rate_limit_reached";
}

/** A window the account reports at 99.5 percent or more is spent (F8). */
const SPENT_PERCENT = 99.5;

/** Up to a day reads as the session window; longer, the weekly one. */
const SESSION_WINDOW_MAX_MINS = 24 * 60;

/**
 * When the account can work again, from one `account/rateLimits/read`
 * answer, read on the turn's own bucket. The windows that are spent are the ones holding
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
  const bucket = turnBucket(read);
  const buckets = bucket ? [bucket] : [];
  let latest: { ms: number; mins: number | null } | null = null;
  let unknownSpent = false;
  for (const bucket of buckets) {
    for (const key of ["primary", "secondary"]) {
      const window = bucket?.[key] as RpcObject | null | undefined;
      if (!window || typeof window.usedPercent !== "number" || window.usedPercent < SPENT_PERCENT)
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

/**
 * The longest one timer waits (review F5). Node cannot hold a timeout past
 * 2^31 ms (24.8 days) and fires it at once, so a monthly window spun; a timer
 * that wakes early waits again, so a day at a time reaches any reset.
 */
const TIMER_MAX_MS = 24 * 60 * 60 * 1000;

/** How long before the same chat is told a line again (review F7). */
export const USAGE_TELL_AGAIN_MS = 3 * 60 * 60 * 1000;

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
  /** `<assistant>:<chat>` and when its chat was last told a line (F7). */
  private readonly told = new Map<string, number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: UsageLimitLaneDeps) {
    this.store = deps.store ?? new UsageResumeStore(null);
    this.now = deps.now ?? Date.now;
  }

  /**
   * A turn in this chat was refused for usage. `say` posts one line in the
   * chat; it is used only when there is no rest to report.
   *
   * The rest is reported on EVERY refusal (review F1): it lives in the
   * backend's memory, and a deploy or any new turn ends it while the window
   * is still spent. HOAI keys its one line on the reset instant, so a repeat
   * of the same window shows the owner nothing new, and a lost rest comes
   * back with the next refusal instead of leaving it unanswered.
   */
  async noteLimited(
    assistantId: number,
    chatId: number,
    say: (text: string) => Promise<unknown>,
    cause: UsageLimitCause = "window",
  ): Promise<void> {
    let read: RpcObject | null = null;
    try {
      read = await this.deps.readLimits();
    } catch (err) {
      this.log(`usage limit read failed chat=${chatId} err=${errorText(err)}`);
    }
    const now = this.now();
    // Nothing resets by itself: say so, rest nothing, resume nothing.
    if (cause === "account" || accountHoldsIt(read)) {
      await this.tell(assistantId, chatId, say, usageLimitLine("account", null, now));
      return;
    }
    const reset = usageLimitReset(read, now);
    if (!reset) {
      await this.tell(assistantId, chatId, say, usageLimitLine(cause, null, now));
      return;
    }
    this.planResume(chatId, reset.resetsAtMs);
    try {
      await this.deps.rest(assistantId, reset);
    } catch (err) {
      // No rest landed, so nothing in the app says it: the chat gets the
      // line instead.
      this.log(`usage rest failed assistant=${assistantId} err=${errorText(err)}`);
      await this.tell(assistantId, chatId, say, usageLimitLine("window", reset.resetsAtMs, now));
    }
  }

  /** A turn of this assistant worked: its chats may be told again. */
  noteWorked(assistantId: number): void {
    for (const key of this.told.keys())
      if (key.startsWith(`${assistantId}:`)) this.told.delete(key);
  }

  /** One line per chat, and again after USAGE_TELL_AGAIN_MS (review F7). */
  private async tell(
    assistantId: number,
    chatId: number,
    say: (text: string) => Promise<unknown>,
    text: string,
  ): Promise<void> {
    const key = `${assistantId}:${chatId}`;
    const last = this.told.get(key);
    const now = this.now();
    if (last !== undefined && now - last < USAGE_TELL_AGAIN_MS) return;
    this.told.set(key, now);
    await say(text).catch(() => {});
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
    const wait = Math.min(
      TIMER_MAX_MS,
      Math.max(0, record.resetsAtMs + USAGE_RESUME_MARGIN_MS - this.now()),
    );
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
