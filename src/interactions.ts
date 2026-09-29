/** Human answers stay attached to the requesting turn; chat text can never grant an approval. */
import { randomUUID } from "node:crypto";
import type { BgosApi } from "./bgos-api.js";
import type {
  ApprovalMeta,
  BgosMessageEnvelope,
  InboundClickPayload,
} from "./types.js";
import type { RpcObject } from "./app-server.js";
import {
  diskPendingApprovals,
  type PendingApprovalStore,
} from "./pending-approvals-store.js";

export interface InteractionContext {
  assistantId: number;
  chatId: number;
  userId: string;
  readUserId?: string;
  signal: AbortSignal;
}
export interface Question {
  text: string;
  options: Array<{ label: string; value: string }>;
  allow_free_text?: boolean;
  allow_skip?: boolean;
}
type Answer = {
  picked_option_value?: string;
  picked_option_label?: string;
  free_text?: string;
  skipped?: boolean;
  timed_out?: boolean;
  /** The SERVER called the row dead; we did not run out of patience. Only
   *  approve() looks at this, to tell the two endings apart. */
  server_expired?: boolean;
};
interface Pending {
  context: InteractionContext;
  startedAt: number;
  deadline: number;
  options: Map<string, string>;
  /** True for an approval: the server's `expired` flag on the row ends this
   *  wait. A question carries no such flag and is retired by its own clock. */
  endOnServerExpiry: boolean;
  /** When the durable poll should next read THIS row. Each pending request
   *  keeps its own clock, so a young one never speeds an old one back up. */
  nextReadAt: number;
  accept: (answer: Answer) => void;
}

/**
 * The longest this daemon can keep its own side of ONE request open, in
 * seconds. It is an offer, not a setting: the plugin always sends and the app
 * decides, so we never read the owner's per-agent choice. The SERVER stores the
 * smaller of this and that choice, and the stored number comes back on the
 * created message (see storedWaitSeconds).
 *
 * 1800 because a live probe held a Codex app server request open for 600 s
 * twice with no complaint. Nothing ABOVE 600 s has been probed, so read this
 * as "no bound found yet", not as "the app server has no timeout": if a parked
 * request ever fails the RPC instead of answering decline, the app server is a
 * suspect and not a ruled-out one. 1800 is the ceiling the backend already
 * enforces on the column, so it is the highest number that can ever be stored
 * anyway.
 *
 * It is also the only number here the TURN's own clock could veto, so it does
 * not: `execute()` in codex-host.ts runs a 30 minute watchdog per turn, and it
 * now PAUSES for as long as a request of that turn is parked in front of the
 * owner. Without that pause this offer was fiction at the ceiling, because the
 * watchdog was armed at turn start and the card is always raised after it. The
 * rule, and it belongs in both files: the watchdog is a budget for the model's
 * silence, never for the owner's thinking.
 *
 * RELEASE ORDER, and it is not a footnote: this number is only safe once the
 * server clamps it to the owner's per-agent choice. Against a backend that has
 * no per-agent wait column yet, and no clamp on either write path, every Codex
 * approval becomes a thirty minute card for every owner with no setting
 * anywhere to shorten it. This plugin version must not be tagged or advertised
 * as latest ahead of that backend and its migration. (The column's own name is
 * deliberately not written here: a standing guard forbids that spelling under
 * src/, because the daemon must never be tempted to read it.)
 *
 * 0.11.0 INHERITS the same hold, and it has a second reason of its own. The
 * plan card it adds is a `plan_card` renderable the app has to know, its three
 * chips are codes the app has to relabel, and its plan mode chip reads a chat
 * column that does not exist yet. Published as latest ahead of the stage 3
 * backend it would ship the approval hold sideways AND draw a card nobody can
 * read. Retire BOTH lines together, in this order: stage 1 backend live, then
 * 0.10.1; stage 3 backend live, then 0.11.0.
 *
 * The lines below are the machine readable half of that hold, and the publish
 * workflow's HELD_FROM_LATEST list must agree with them exactly
 * (test/publish-workflow.spec.ts). Retiring the hold is an edit of those lines
 * and of that list, never a reword of the paragraph above them.
 *
 * HELD-FROM-LATEST: 0.10.1
 * HELD-FROM-LATEST: 0.11.0
 */
export const APPROVAL_HOLD_SECONDS = 1800;

/**
 * How far past the server's own deadline this daemon keeps listening before it
 * gives up on its own. The sweep runs every 30 s and only looks at rows already
 * past their deadline, so a row can be flagged up to 30 s late; anything less
 * than that slack puts our deadline back in FRONT of the server's, which is the
 * 55 s versus 60 s hole this whole path exists to close.
 */
const BACKSTOP_SLACK_SECONDS = 90;

/**
 * The wait the SERVER stored, read off the message it just created, or null
 * when the response does not carry one.
 *
 * Null is not a shorter guess. An older backend strips or ignores
 * `wait_seconds` and the row then lives 60 s there, but we cannot tell that
 * apart from a response shape we simply do not understand, and guessing 60 s
 * would move our deadline in front of the server's on every deployment that
 * DOES honour the field. So a null means hold the full ceiling and let the
 * server's `expired` flag end the wait, which it will, well before we do.
 *
 * The range is the backend's own: a whole number from 1 to the ceiling. A
 * fraction, a string, a zero or something past the ceiling is a number this
 * server could not have stored, so it is treated as no answer rather than
 * clamped here. Two opinions about a ceiling is how a card and a daemon end up
 * disagreeing about when a request is dead.
 */
export function storedWaitSeconds(created: unknown): number | null {
  const seconds = (
    created as { approvalMeta?: { wait_seconds?: unknown } } | null | undefined
  )?.approvalMeta?.wait_seconds;
  return typeof seconds === "number" &&
    Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= APPROVAL_HOLD_SECONDS
    ? seconds
    : null;
}

/** The durable poll's two cadences, and the window the fast one owns. */
export const POLL_FAST_MS = 1200;
export const POLL_SLOW_MS = 5000;
export const POLL_FAST_WINDOW_MS = 60_000;

/**
 * How many rows one durable read asks for when it is waiting on a LONE row.
 * One, because the read is pinned to that row (see readDue), so the page never
 * needs a second.
 */
export const POLL_PAGE_LIMIT = 1;

/**
 * The widest id span one read may cover when several rows of the same chat fall
 * due together.
 *
 * An ask carousel raises up to four rows in one chat, back to back, so their
 * ids are consecutive and one page of four covers all of them; a request per
 * row would quadruple the traffic on the exact path the backoff below exists to
 * quieten. The span and not the count, because a message that lands between two
 * questions would push the oldest one off a page sized to the count, and the
 * row this poll cannot see is the row whose dropped click it can never heal.
 *
 * Twelve is three rows of slack per question, and rows further apart than that
 * are unrelated requests that happen to share a chat: for those the pinned one
 * row read is both cheaper and smaller, so they fall back to it.
 */
export const POLL_MAX_SPAN = 12;

/**
 * The due rows of ONE chat, split into the reads that will cover them.
 *
 * Ascending, and greedy from the oldest id of each group, so a group is only
 * ever as wide as POLL_MAX_SPAN allows. A single id is its own group and keeps
 * the pinned one row read.
 */
export function coalesceReads(ids: number[]): number[][] {
  const groups: number[][] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const last = groups.at(-1);
    if (last && id - last[0] + 1 <= POLL_MAX_SPAN) last.push(id);
    else groups.push([id]);
  }
  return groups;
}

export interface PollCadenceEntry {
  /** How long this request has been pending, in milliseconds. */
  ageMs: number;
  /**
   * True for an approval, which may now sit for half an hour. A question is
   * answered from a modal in front of a person and dies at 600 s, so it keeps
   * the cadence it has always had for its whole life.
   */
  backsOff: boolean;
}

/**
 * How long to wait before reading ONE pending row again.
 *
 * At a flat 1.2 s a single request left open for half an hour is about 1,500
 * reads against one small host, for one person who has not picked up their
 * phone yet. The socket click is the fast path and this poll is the healing
 * path and the expiry detector, so it only has to be quick in the window where
 * a person is most likely tapping.
 *
 * Asked PER PENDING REQUEST, deliberately. One answer for the whole map meant a
 * question raised anywhere pulled every parked request back to 1.2 s for its
 * own 600 s life, including a half hour approval in a different chat, which is
 * exactly the traffic this backoff exists to remove. Each request now keeps its
 * own clock, so a young one is read quickly without dragging an old one along.
 */
export function pollIntervalMs(entry: PollCadenceEntry): number {
  return !entry.backsOff || entry.ageMs < POLL_FAST_WINDOW_MS
    ? POLL_FAST_MS
    : POLL_SLOW_MS;
}
export const AGENT_BUTTON_PREFIX = "u:";
export const escapeButton = (value: string): string =>
  AGENT_BUTTON_PREFIX + value;
export const unescapeButton = (value: string): string =>
  value.startsWith(AGENT_BUTTON_PREFIX) ? value.slice(2) : value;

export class Interactions {
  private pending = new Map<number, Pending>();
  private pollRunning = false;
  /** Settles the loop's current sleep early; see sleep() and wait(). */
  private wake?: () => void;
  constructor(
    private api: Pick<BgosApi, "agentRequest" | "getMessages">,
    /** Durable bookkeeping for cards a restart would otherwise strand; see
     *  pending-approvals-store.ts and retireOrphanedApprovals below. */
    private store: PendingApprovalStore = diskPendingApprovals,
  ) {}

  handleClick(click: InboundClickPayload): boolean {
    const pending = this.pending.get(click.messageId);
    if (!pending)
      return (
        click.callbackData.startsWith("ea:") ||
        click.callbackData.startsWith("ask:")
      );
    const { context, deadline, options } = pending;
    if (
      context.chatId !== click.chatId ||
      context.assistantId !== click.assistantId ||
      context.userId !== click.userId
    )
      return true;
    if (Date.now() >= deadline || context.signal.aborted) return true;
    if (click.callbackData === "__skip__") pending.accept({ skipped: true });
    else if (
      click.callbackData === "__custom__" &&
      click.customText !== undefined
    )
      pending.accept({ free_text: click.customText });
    else if (options.has(click.callbackData))
      pending.accept({
        picked_option_value: click.callbackData,
        picked_option_label: options.get(click.callbackData),
      });
    return true;
  }

  private wait(
    id: number,
    context: InteractionContext,
    options: Map<string, string>,
    duration: number,
    endOnServerExpiry = false,
  ): Promise<Answer> {
    return new Promise((resolve) => {
      const finish = (answer: Answer) => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", cancel);
        this.pending.delete(id);
        resolve(answer);
      };
      const cancel = () => finish({ skipped: true });
      const timer = setTimeout(
        () => finish({ skipped: true, timed_out: true }),
        duration,
      );
      this.pending.set(id, {
        context,
        startedAt: Date.now(),
        deadline: Date.now() + duration,
        options,
        endOnServerExpiry,
        nextReadAt: Date.now(),
        accept: finish,
      });
      context.signal.addEventListener("abort", cancel, { once: true });
      if (context.signal.aborted) cancel();
      // Two ways in, because the loop may or may not be running. `poll()`
      // returns at once when it is, so a request raised while the loop sat on
      // a 5 s sleep used to wait that sleep out before its first durable read:
      // the newest request is the one somebody is most likely answering, and it
      // was the slowest to heal a dropped click.
      this.wake?.();
      void this.poll();
    });
  }

  /** The loop's sleep, interruptible by wait() when a request is raised. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /**
   * One durable read of the pending rows of ONE chat that are due together.
   *
   * PINNED TO THE ROWS, not to the chat's tail. `GET /chats/:id/messages` with
   * no cursor answers with the newest 50 rows, which is right for a transcript
   * and wrong for a poll waiting on a known row: a request may now sit for
   * half an hour, and in a busy meeting chat fifty newer messages push the row
   * off every page this loop would ever see. It would then notice neither the
   * owner's answer nor the server's `expired` flag, and a dropped socket click
   * (the exact failure this poll exists to heal) would end in a decline at
   * minute thirty one for a request the owner allowed at minute three.
   * `beforeId` filters id < beforeId and the page is taken newest first, so
   * beforeId = newest + 1 makes our rows the newest matches whatever else
   * arrived, and a page of `span` reaches back to the oldest of them.
   *
   * ONE READ FOR ROWS THAT FALL DUE TOGETHER, which is the whole point of
   * calling this per group rather than per row: an ask carousel is up to four
   * rows in one chat on one clock, and four pinned reads a tick would be four
   * times the traffic the backoff below just removed. A lone row still costs
   * one row (POLL_PAGE_LIMIT) instead of fifty. The trade is bytes against
   * requests: a coalesced page carries up to POLL_MAX_SPAN rows including ones
   * nobody here is waiting on, so the grouping stops there and anything wider
   * goes back to the pinned single read.
   */
  private async readDue(entries: Array<[number, Pending]>): Promise<void> {
    const ctx = entries[0][1].context;
    const ids = entries.map(([id]) => id);
    const newest = Math.max(...ids);
    const span = newest - Math.min(...ids) + 1;
    try {
      const rows = (await this.api.getMessages(
        ctx.chatId,
        ctx.readUserId ?? ctx.userId,
        {
          beforeId: newest + 1,
          limit: entries.length === 1 ? POLL_PAGE_LIMIT : span,
        },
      )) as unknown as RpcObject[];
      for (const row of rows) {
        const message = row.message ?? row;
        const p = this.pending.get(Number(message.id));
        if (!p || p.context.chatId !== ctx.chatId || Date.now() >= p.deadline)
          continue;
        // Read the flag through the declared row shape, not through the
        // RpcObject index signature this loop otherwise runs on. The
        // envelope says `approvalMeta.expired` exists; saying it in a
        // type and then reading it as `any` means a rename or a typo
        // here compiles clean and the daemon quietly falls through to
        // its backstop on every single request.
        const approvalMeta = (message as BgosMessageEnvelope["message"])
          .approvalMeta;
        if (approvalMeta?.expired) {
          // The server has declared this request dead, which is also
          // the moment the card stops accepting a tap. Ending here is
          // what keeps the two sides in step; an answer stamped after
          // the flag cannot exist, so there is nothing left to wait for.
          if (p.endOnServerExpiry)
            p.accept({ skipped: true, timed_out: true, server_expired: true });
          continue;
        }
        if (!message.answeredAt || !message.answerPayload) continue;
        const payload = message.answerPayload;
        const option = (row.messageOptions ?? message.options ?? []).find(
          (o: RpcObject) => Number(o.id) === Number(payload.optionId),
        );
        if (payload.skipped) p.accept({ skipped: true });
        else if (typeof payload.freeText === "string")
          p.accept({ free_text: payload.freeText });
        else if (option && p.options.has(option.callbackData))
          p.accept({
            picked_option_value: option.callbackData,
            picked_option_label: option.text,
          });
      }
    } catch {
      /* Leave pending; never turn a read failure into an approval. */
    } finally {
      // Measured from the END of the read, as the one shared sleep used to be:
      // a slow host stretches the gap rather than stacking reads on top of it.
      // Per entry even when the read was shared, because the cadence is a
      // property of one request's own age and kind.
      for (const [, entry] of entries)
        entry.nextReadAt =
          Date.now() +
          pollIntervalMs({
            ageMs: Date.now() - entry.startedAt,
            backsOff: entry.endOnServerExpiry,
          });
    }
  }

  /** Ask responses are delivered to the user's socket; durable answers also heal dropped click events. */
  private async poll(): Promise<void> {
    if (this.pollRunning) return;
    this.pollRunning = true;
    try {
      while (this.pending.size) {
        const due = Date.now();
        // Grouped by the chat AND the id the rows are read as, because that
        // pair is one GET; the ids inside a group then decide how many reads
        // it takes (see coalesceReads).
        const groups = new Map<string, Array<[number, Pending]>>();
        for (const [id, entry] of this.pending) {
          if (due < entry.nextReadAt) continue;
          const key = `${entry.context.chatId}:${entry.context.readUserId ?? entry.context.userId}`;
          const group = groups.get(key);
          if (group) group.push([id, entry]);
          else groups.set(key, [[id, entry]]);
        }
        await Promise.all(
          [...groups.values()].flatMap((group) => {
            const byId = new Map(group);
            return coalesceReads([...byId.keys()]).map((ids) =>
              this.readDue(ids.map((id) => [id, byId.get(id)!])),
            );
          }),
        );
        if (!this.pending.size) break;
        // Sleep until the FIRST row falls due, not for one shared interval:
        // every pending request is on its own clock now.
        const now = Date.now();
        let delay = POLL_SLOW_MS;
        for (const entry of this.pending.values())
          delay = Math.min(delay, Math.max(0, entry.nextReadAt - now));
        await this.sleep(delay);
      }
    } finally {
      this.pollRunning = false;
    }
  }

  async ask(
    context: InteractionContext,
    questions: Question[],
    seconds = 600,
  ): Promise<Array<Answer & { question: string }>> {
    if (
      !Array.isArray(questions) ||
      questions.length < 1 ||
      questions.length > 4
    )
      throw new Error("Ask 1 to 4 questions.");
    for (const q of questions)
      if (
        typeof q.text !== "string" ||
        !q.text.trim() ||
        !Array.isArray(q.options) ||
        q.options.length > 6 ||
        (q.options.length === 0 && q.allow_free_text === false) ||
        q.options.some(
          (o) => typeof o.label !== "string" || typeof o.value !== "string",
        )
      )
        throw new Error("Invalid question or options.");
    const askId = randomUUID();
    const waits: Array<Promise<Answer & { question: string }>> = [];
    for (const [index, question] of questions.entries()) {
      context.signal.throwIfAborted();
      const options = question.options.map((o, i) => ({
        text: o.label,
        callbackData: `ask:${askId}:${index}:${i}`,
      }));
      const result = await this.api.agentRequest(
        "POST",
        "messages",
        context.assistantId,
        {
          assistantId: context.assistantId,
          chatId: context.chatId,
          sender: "assistant",
          text: question.text,
          messageType: "ask_user_input",
          askId,
          askOrder: index + 1,
          options,
          allowFreeText: question.allow_free_text ?? true,
          allowSkip: question.allow_skip ?? true,
        },
      );
      if (!Number.isSafeInteger(Number(result.id)) || Number(result.id) < 1)
        throw new Error("HOAI did not save the question.");
      waits.push(
        this.wait(
          Number(result.id),
          context,
          new Map(options.map((o) => [o.callbackData, o.text])),
          Math.max(1, Math.min(seconds, 600)) * 1000,
        ).then(async (answer) => {
          if (context.signal.aborted || answer.timed_out) {
            // Retire the controls, not the user's answer or message history.
            // Inline mode also retires free-text-only questions: removing
            // options alone would leave their answer input active after Stop.
            await this.api
              .agentRequest(
                "PATCH",
                `messages/${Number(result.id)}`,
                context.assistantId,
                { options: [], renderMode: "inline" },
              )
              .catch(() => {
                /* A failed UI cleanup never revives the cancelled turn. */
              });
          }
          const at = options.findIndex(
            (o) => o.callbackData === answer.picked_option_value,
          );
          return {
            ...answer,
            ...(at >= 0
              ? { picked_option_value: question.options[at].value }
              : {}),
            question: question.text,
          };
        }),
      );
    }
    return Promise.all(waits);
  }

  async nativeAsk(
    context: InteractionContext,
    params: RpcObject,
  ): Promise<unknown> {
    const questions: RpcObject[] = params.questions ?? [];
    if (questions.some((q) => q.isSecret))
      throw new Error(
        "Enter secrets through the provider's sign-in screen, not HOAI chat.",
      );
    const answers = await this.ask(
      context,
      questions.map((q) => ({
        text: q.question,
        options: (q.options ?? []).map((o: RpcObject) => ({
          label: o.label,
          value: o.label,
        })),
        allow_free_text: q.isOther !== false,
      })),
    );
    return {
      answers: Object.fromEntries(
        questions.map((q, index) => [
          q.id,
          {
            answers: answers[index].skipped
              ? []
              : [
                  answers[index].free_text ??
                    answers[index].picked_option_value ??
                    "",
                ],
          },
        ]),
      ),
    };
  }

  async approve(
    context: InteractionContext,
    method: string,
    params: RpcObject,
  ): Promise<unknown> {
    const permissions = method.includes("permissions");
    const denied = permissions
      ? { permissions: {}, scope: "turn" }
      : { decision: "decline" };
    if (context.signal.aborted) return denied;
    const id = randomUUID();
    const choices: Array<[string, string, unknown]> = [
      [
        "Allow once",
        "once",
        permissions
          ? { permissions: params.permissions, scope: "turn" }
          : { decision: "accept" },
      ],
    ];
    const available = params.availableDecisions;
    if (permissions || !available || available.includes("acceptForSession"))
      choices.push([
        "Allow for session",
        "session",
        permissions
          ? { permissions: params.permissions, scope: "session" }
          : { decision: "acceptForSession" },
      ]);
    if (
      !permissions &&
      params.proposedExecpolicyAmendment &&
      (!available ||
        available.some(
          (d: unknown) =>
            typeof d === "object" &&
            d !== null &&
            "acceptWithExecpolicyAmendment" in d,
        ))
    )
      choices.push([
        "Always allow this rule",
        "always",
        {
          decision: {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: params.proposedExecpolicyAmendment,
            },
          },
        },
      ]);
    choices.push(["Deny", "deny", denied]);
    const options = choices.map(([text, value]) => ({
      text,
      callbackData: `ea:${value}:${id}`,
      style: value === "deny" ? "danger" : "success",
    }));
    const command = String(
      params.command ??
        params.reason ??
        (permissions
          ? JSON.stringify(params.permissions)
          : "Apply file changes"),
    );
    // Typed, so the compiler actually checks the wire names. `agentRequest`
    // takes an `unknown` body, so an object literal inlined below would let a
    // camelCase `waitSeconds` through and the backend would silently strip it:
    // the row would keep the generic 60 s while this daemon waited half an
    // hour, which is the same two clocks problem the rest of this method
    // exists to end.
    //
    // `wait_seconds` is ALWAYS our ceiling and never the owner's choice: we do
    // not read their settings. They set the real wait in the app, the server
    // stores the smaller of the two, and it comes back below.
    const approvalMeta: ApprovalMeta = {
      tool: command,
      agent_route: `codex-${context.assistantId}`,
      risk: "high",
      request_id: id,
      wait_seconds: APPROVAL_HOLD_SECONDS,
    };
    const result = await this.api.agentRequest(
      "POST",
      "messages",
      context.assistantId,
      {
        assistantId: context.assistantId,
        chatId: context.chatId,
        sender: "assistant",
        text: params.reason ?? "Codex needs your approval to continue.",
        messageType: "approval_request",
        options,
        approvalMeta,
      },
    );
    if (!Number.isSafeInteger(Number(result.id)) || Number(result.id) < 1)
      return denied;
    const messageId = Number(result.id);
    // Written to disk, because the map this wait lives in is not. See the
    // restart note below and pending-approvals-store.ts.
    this.store.record({
      id: messageId,
      chatId: context.chatId,
      assistantId: context.assistantId,
      userId: context.readUserId ?? context.userId,
      at: Date.now(),
    });
    // TWO CLOCKS, AND ONLY ONE OF THEM DECIDES. The backend refuses a late tap
    // by the row's `expired` FLAG, which its sweep sets every 30 s once the row
    // is past its own deadline. This daemon used to give up at 55 s "below the
    // server's 60-second expiry", so a tap in the gap between the two was
    // accepted and stamped by the server while Codex had already been told
    // decline: the owner pressed Allow and nothing happened. With a ten minute
    // wait that gap would be the rule rather than a corner. So the server is
    // the only judge now. We end on the owner's answer (the click path or the
    // durable poll), or on the server's own flag, and keep a backstop only for
    // a server that never flags the row at all, e.g. a sweep that is down.
    //
    // The backstop is the wait the SERVER stored on this row, which is the
    // owner's own choice once it has been capped, plus enough slack that the
    // sweep always gets there first.
    //
    // THE TURN'S OWN WATCHDOG IS NOT A THIRD JUDGE, and it used to be the
    // deciding one. codex-host.ts arms a 30 minute timer at TURN start, which
    // is always before this card exists, so at our ceiling it always fired
    // first: it interrupted the turn, the abort below answered decline, and the
    // owner's yes reached a turn that had already spoken for them. That timer
    // now pauses for as long as this request is parked, because it is a budget
    // for the model's silence and not for the owner's thinking. The only two
    // clocks that can end this wait are the server's flag and our backstop.
    //
    // AND A RESTART IS NOT A CLOCK AT ALL. The app server is a child of this
    // process, so a restart mid wait takes the turn, this map and the request
    // together; nothing answers the RPC, because the process that was parked
    // on it no longer exists. (The fail closed branch in
    // codex-host.ts onRequest is a different case, a request arriving with no
    // active turn.) What survives is the card, still tappable until the
    // server's sweep flags the row, which is now up to the whole stored wait
    // rather than the ~90 s it used to be: half an hour in which the owner can
    // press Allow, be told "You said yes, this once", and have nothing run.
    // Hence the durable record above and the boot sweep below
    // (retireOrphanedApprovals), which takes the buttons off every card whose
    // turn died with the daemon.
    const backstopSeconds =
      (storedWaitSeconds(result) ?? APPROVAL_HOLD_SECONDS) +
      BACKSTOP_SLACK_SECONDS;
    const answer = await this.wait(
      messageId,
      context,
      new Map(options.map((o) => [o.callbackData, o.text])),
      backstopSeconds * 1000,
      true,
    );
    if ((answer.timed_out && !answer.server_expired) || context.signal.aborted) {
      // The two endings the SERVER has not judged: our own backstop, and Stop.
      // In both the card is still tappable for a turn that has stopped
      // listening, so take its buttons away, exactly as ask() does on the same
      // two endings. Stop matters more now than it used to: the sweep will not
      // flag this row until its own deadline, so an abort at ten seconds into a
      // ten minute wait used to leave a live card for the rest of those ten
      // minutes. The owner taps Allow, the backend stamps it, the card reads
      // "You said yes, this once", and nothing ever runs.
      // The server-expired ending is deliberately NOT here: the flag is already
      // what makes the card refuse a tap, so a PATCH would add nothing.
      // `expired` is server controlled and stripped from a PATCH, so options
      // are the only honest way to say this from here. Best effort: a failed
      // cleanup never changes the decline we already made.
      // What this leaves behind, and it is not fixable from here: a row with no
      // buttons and no `expired` flag still draws as a PENDING request, footer
      // and all, until the server catches up. The app is the one that has to
      // read a pending request with zero options as the settled "This request
      // is no longer open" row; flagged for the app lane rather than papered
      // over by faking a server verdict from a daemon.
      await this.api
        .agentRequest("PATCH", `messages/${messageId}`, context.assistantId, {
          options: [],
        })
        .catch(() => {
          /* A failed UI cleanup never revives a request we stopped waiting on. */
        });
    }
    // Last, not first: while this process is the one answering, the card is
    // nobody else's to retire, and a crash between the wait ending and here
    // leaves an entry the next boot reads as answered and simply forgets.
    this.store.clear(messageId);
    const choice = options.findIndex(
      (o) => o.callbackData === answer.picked_option_value,
    );
    return choice < 0 ? denied : choices[choice][2];
  }
}

/**
 * How long a recorded card is worth chasing. Its stored wait can be half an
 * hour at most, so a day later the server's sweep has certainly flagged the row
 * and the card refuses a tap on its own; keeping the entry past that would only
 * retry a PATCH nobody needs on every boot.
 */
const FORGET_ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Retire every approval card this daemon was waiting on when it died.
 *
 * Called once at boot. For each recorded id: read the row it is pinned to, and
 * if the owner has already answered it or the server has already flagged it
 * expired, there is nothing to take away, so just forget it. Otherwise the card
 * is still live in front of an owner whose turn no longer exists, so the
 * buttons come off exactly as they do when a turn is stopped, and the entry is
 * forgotten.
 *
 * Deliberately NOT faking the server's verdict: `expired` is server controlled
 * and stripped from a PATCH, so options are the only honest thing to say from
 * here. The row then draws as a pending request with no buttons until the
 * server's own sweep catches up, which is the same seam approve() already
 * leaves and the same one flagged for the app lane.
 *
 * Never throws, and never blocks a boot: a read that fails leaves the entry for
 * the next start rather than guessing, and a PATCH that fails does the same.
 */
export async function retireOrphanedApprovals(
  api: Pick<BgosApi, "agentRequest" | "getMessages">,
  store: PendingApprovalStore = diskPendingApprovals,
): Promise<number> {
  let retired = 0;
  for (const entry of store.load()) {
    if (Date.now() - entry.at > FORGET_ORPHAN_AFTER_MS) {
      store.clear(entry.id);
      continue;
    }
    let settled = false;
    try {
      const rows = (await api.getMessages(entry.chatId, entry.userId, {
        beforeId: entry.id + 1,
        limit: POLL_PAGE_LIMIT,
      })) as unknown as RpcObject[];
      const row = rows.find((r) => Number((r.message ?? r).id) === entry.id);
      const message = (row?.message ?? row) as
        | (BgosMessageEnvelope["message"] & RpcObject)
        | undefined;
      // A row we could not read at all is treated as still open: retiring a
      // card that was already answered costs the owner nothing, leaving a live
      // card for a dead turn is the defect this sweep exists for.
      settled = Boolean(
        message && (message.approvalMeta?.expired || message.answeredAt),
      );
    } catch {
      settled = false;
    }
    if (settled) {
      store.clear(entry.id);
      continue;
    }
    try {
      await api.agentRequest(
        "PATCH",
        `messages/${entry.id}`,
        entry.assistantId,
        { options: [] },
      );
      store.clear(entry.id);
      retired++;
    } catch {
      /* Keep the entry: the next boot tries again, until it ages out. */
    }
  }
  return retired;
}
