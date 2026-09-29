/**
 * The plan lane: one open plan per chat, and what happens to it.
 *
 * It posts the card, supersedes the one it replaces, writes the waiting status
 * line, remembers the card so a tap can be matched to it, and reads the three
 * chips back into a decision the adapter acts on. It does NOT start turns,
 * flip Codex's mode or touch the thread: those are the adapter's and the
 * host's, and a lane that reached into them would be a second place to get the
 * order wrong.
 *
 * Two rules it keeps:
 *
 * - THE WAIT HAS NO END. Nothing here arms a timer, nothing expires a card,
 *   and the turn that proposed a plan is over the moment the card is posted.
 *   The owner's tap arrives as an ordinary click and starts the next turn, so
 *   answering tomorrow works exactly as answering now does. The only clock in
 *   sight is the status line's TTL, which is a day, and a line that fades is
 *   not a card that closed.
 * - A FAILED WRITE NEVER COSTS A TURN. The status line, the supersede PATCH
 *   and the session mode report are all swallowed. The card itself is the one
 *   write whose failure is reported, because a plan nobody can see is not a
 *   plan.
 */
import type { OutboundMessagePayload } from "./types.js";
import {
  diskPendingPlans,
  type PendingPlanEntry,
  type PendingPlanStore,
} from "./pending-plans-store.js";
import {
  buildPlanCardMessage,
  isPlanCardPayload,
  planCardPayload,
  parsePlanChip,
  PLAN_CUSTOM_SENTINEL,
  supersedePlanCardPatch,
  type PlanAnswer,
  type PlanCardInput,
  type PlanCardPayload,
} from "./plan-card.js";

const LOG = "[codex-channel-bgos]";
/**
 * The status line outlives the turn that wrote it, by a day. The server's own
 * default is two hours, which is the wrong number for a card an owner may
 * answer tomorrow; 1440 is the ceiling the DTO accepts.
 */
export const PLAN_STATUS_TTL_MINUTES = 1440;
export const PLAN_STATUS_TEXT = "Waiting for your go ahead";

export interface PlanLaneApi {
  postMessage(payload: OutboundMessagePayload): Promise<{ id: number }>;
  agentRequest(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    assistantId: number,
    body?: unknown,
  ): Promise<unknown>;
  setStatus(
    assistantId: number,
    body: {
      statusText: string | null;
      statusEmoji?: string | null;
      ttlMinutes?: number;
    },
  ): Promise<void>;
  /** Only the boot sweep needs it; a lane built without it simply cannot
   *  sweep, which is the honest direction for the tools' no-op poster. */
  getMessages?(
    chatId: number,
    userId: string,
    cursor?: { beforeId?: number; limit?: number },
  ): Promise<unknown>;
}

/** The card this chat is waiting on. */
export interface OpenPlan {
  messageId: number;
  assistantId: number;
  payload: PlanCardPayload;
}

/** An OpenPlan plus the chat it belongs to, for `adopt`. */
export interface AdoptedPlan extends OpenPlan {
  chatId: number;
}

export interface PlanDecision {
  answer: PlanAnswer;
  plan: OpenPlan | null;
  /** What the owner typed into the armed composer, on `plan:change` only. */
  customText?: string;
}

export class PlanLane {
  private readonly open = new Map<number, OpenPlan>();
  /**
   * `enforced` is a QUESTION asked per chat, not a constant.
   *
   * It used to be `CODEX_PLAN_MODE_ENFORCED = false`, which was the right
   * answer while plan mode moved nothing but the model's instructions. Now
   * `/plan` also holds the chat's sandbox read only, so the answer is "yes,
   * while that sandbox is on" and it differs between two chats of the same
   * daemon: one planning under the lock, one proposing a plan it decided on
   * inside an ordinary coding chat. The resolver reads the host's store, and
   * a connection with no host (the tools' no-op poster) answers false, which
   * is the honest direction.
   */
  constructor(
    private readonly api: PlanLaneApi,
    private readonly enforced: (chatId: number) => boolean = () => false,
    /**
     * Is this chat in plan mode at all?
     *
     * A different question from `enforced`, and both are asked because the
     * card makes two different claims. `enforced` is about the read only
     * sandbox; this is about the MODE, which is what the card's `mode` door
     * turns into the line "Plan mode is on." for the owner. The model names
     * its own door, so without this the model could claim the host is
     * planning in a chat that is an ordinary coding chat. A daemon with no
     * host answers false, which is the honest direction: the card falls back
     * to the decided door, which claims nothing about the host.
     */
    private readonly planMode: (chatId: number) => boolean = () => false,
    /**
     * Where an open card is REMEMBERED ACROSS A RESTART.
     *
     * `open` above is in memory and a plan wait lasts a day, so the commonest
     * way a plan ends in silence is the daemon not being up at the moment of
     * the tap: the answer arrives on the WS click event alone, and the message
     * backfill replays new ROWS, never the `answered_at` update on an old one.
     * See pending-plans-store.ts for the whole of it, and
     * `sweepMissedPlanAnswers` below for what the next boot does with it.
     */
    private readonly store: PendingPlanStore = diskPendingPlans,
    /**
     * The id the card's ROW is read as at the next boot, i.e. the poll's
     * `readUserId ?? userId`. A lane with no answer here records nothing,
     * because a read aimed at a guessed user is worse than a card left alone.
     */
    private readonly readUserId: () => string = () => "",
  ) {}

  /**
   * Put a card back in the map without posting one.
   *
   * The boot sweep's other half, and the half that matters even when nothing
   * was answered while this daemon was down. Without it a restart leaves
   * `open` empty, and then: `isChangeClick` cannot recognise the armed
   * composer's `__custom__` against the card (so a revision arrives as an
   * ordinary typed reply), a revision loses the plan's identity and comes back
   * as a brand new plan at revision 1 with the old row still live, and an
   * answer resolves with `plan: null` so the agent is told less than it could
   * have been.
   *
   * Never displaces a card this process already holds: a live card is better
   * evidence than a row read off the server.
   */
  adopt(plan: AdoptedPlan): boolean {
    if (this.open.has(plan.chatId)) return false;
    this.open.set(plan.chatId, {
      messageId: plan.messageId,
      assistantId: plan.assistantId,
      payload: plan.payload,
    });
    return true;
  }

  /** The card this chat is waiting on, if this process posted it. */
  openPlan(chatId: number): OpenPlan | null {
    return this.open.get(chatId) ?? null;
  }

  /** Is this chat's plan wait actually held by a read only sandbox? */
  enforcedIn(chatId: number): boolean {
    try {
      return this.enforced(chatId) === true;
    } catch {
      // A resolver that throws is a daemon that cannot prove the lock, and an
      // unprovable lock is reported as no lock.
      return false;
    }
  }

  /** Is this chat in plan mode right now, whatever the model claims? */
  planModeIn(chatId: number): boolean {
    try {
      return this.planMode(chatId) === true;
    } catch {
      // Same direction as above: a daemon that cannot prove the mode does not
      // let the model announce it.
      return false;
    }
  }

  /**
   * Post a plan card and leave it waiting.
   *
   * A chat already waiting on a plan has that card SUPERSEDED first: its chips
   * go, its steps stay so the owner keeps what they already read, and the
   * payload comes back dimmed. The new card inherits the old one's `plan_id`
   * and takes the next revision, so the two rows are one plan with a history
   * rather than two plans competing for one answer.
   *
   * A supersede that fails is swallowed: the worst case is two cards with
   * chips, and the older one's answer still resolves to the older card.
   */
  async propose(input: {
    assistantId: number;
    chatId: number;
    plan: Omit<PlanCardInput, "planId" | "revision">;
  }): Promise<{ messageId: number }> {
    const { assistantId, chatId } = input;
    const previous = this.open.get(chatId);
    const payload = planCardPayload({
      ...input.plan,
      planId: previous?.payload.plan_id ?? newPlanId(),
      revision: (previous?.payload.revision ?? 0) + 1,
      ...(previous
        ? { supersedes: previous.messageId }
        : typeof input.plan.supersedes === "number"
          ? { supersedes: input.plan.supersedes }
          : {}),
    });
    if (previous) {
      this.open.delete(chatId);
      // The superseded row is not a card anybody is waiting on any more, so
      // the next boot must not chase it.
      this.store.clear(previous.messageId);
      await this.api
        .agentRequest(
          "PATCH",
          `messages/${previous.messageId}`,
          previous.assistantId,
          supersedePlanCardPatch(previous.payload),
        )
        .catch(() => {
          // A card that keeps its chips is a worse card, never a broken turn.
        });
    } else if (typeof payload.supersedes === "number") {
      // THE MODEL NAMED A CARD THIS PROCESS NO LONGER HOLDS (a restart, or a
      // plan proposed by an earlier daemon). Without this the older row keeps
      // its three live chips for ever: `supersedes` in the new payload tells
      // the NEW card about the old one, and tells the old row nothing.
      //
      // Only the chips come off. The full supersede PATCH also dims the row
      // and writes `state: "superseded"` into its `eventMeta`, and that needs
      // the old payload, which is exactly what was lost. Retiring the chips is
      // the honest half: the card cannot be answered any more, and it keeps
      // every step the owner already read.
      await this.api
        .agentRequest("PATCH", `messages/${payload.supersedes}`, assistantId, {
          options: [],
        })
        .catch(() => {
          // Same reason as above: never a broken turn.
        });
    }
    const posted = await this.api.postMessage(
      buildPlanCardMessage(payload, { assistantId, chatId }),
    );
    const messageId = Number(posted?.id);
    if (!Number.isSafeInteger(messageId) || messageId <= 0)
      throw new Error("BGOS accepted the plan card without a message id.");
    this.open.set(chatId, { messageId, assistantId, payload });
    // ON DISK BEFORE THE STATUS LINE, because the status line is the thing the
    // owner reads as "still waiting" and the record is the only thing that can
    // ever take it down again after a restart.
    try {
      // NOT RECORDED WITHOUT A USER TO READ THE ROW AS. The sweep's read is
      // `GET chats/:id/messages?userId=`, so an entry with no user is an entry
      // the next boot can only chase against a guess, and a request aimed at a
      // guessed user is worse than a card left alone. A lane with no identity
      // yet (the tools' no-op poster) is exactly that case.
      const userId = this.readUserId();
      if (userId)
        this.store.record({
          id: messageId,
          chatId,
          assistantId,
          userId,
          at: Date.now(),
        });
    } catch {
      /* A persistence hiccup never costs the owner a plan. */
    }
    await this.api
      .setStatus(assistantId, {
        statusText: PLAN_STATUS_TEXT,
        ttlMinutes: PLAN_STATUS_TTL_MINUTES,
      })
      .catch(() => {
        /* A missing status line never holds up a plan. */
      });
    return { messageId };
  }

  /**
   * Is this click the armed composer answering the card this chat has open?
   *
   * "Change the plan" and a step's "Comment" NEVER arrive as `plan:change`.
   * The app arms the composer instead of posting the option, and Send posts
   * `POST /messages/:id/callback { sentinel: "custom", customText }`, which the
   * backend stamps as `callbackData: "__custom__"` whatever the option said
   * (message.service.ts, the custom branch). So the only thing that tells a
   * plan revision apart from an ordinary custom reply is the MESSAGE ID: the
   * card this chat is waiting on. It is exported as a predicate because the
   * adapter has to make the same call SYNCHRONOUSLY, before it decides whether
   * a click belongs to the plan path or the generic one.
   */
  isChangeClick(click: {
    chatId: number;
    messageId?: number;
    callbackData?: string;
  }): boolean {
    if ((click.callbackData ?? "").trim() !== PLAN_CUSTOM_SENTINEL) return false;
    const known = this.open.get(click.chatId);
    return !!known && !!click.messageId && known.messageId === click.messageId;
  }

  /**
   * Read a click as a plan answer, or return null when it is not one.
   *
   * A SETTLED card is forgotten here, so a second tap cannot start a second
   * turn. `change` is the exception and has to be: the revision the owner just
   * asked for has to come back as a REVISION, and `propose` reads the plan's
   * identity (`plan_id`, the next `revision`, the row to supersede) from this
   * map and nowhere else. Dropping the entry here made the next card a brand
   * new plan at revision 1, with the old row left live and undimmed. A second
   * tap while it is still open is harmless: the backend forwards only the
   * first accepted answer of a message (the single announce contract).
   *
   * `plan:no` also retires the chips, because nothing else will: the app
   * collapses them on the answer it already wrote, and a daemon restart would
   * otherwise find a live looking card nobody is waiting on.
   */
  async answer(click: {
    assistantId: number;
    chatId: number;
    messageId?: number;
    callbackData?: string;
    customText?: string;
  }): Promise<PlanDecision | null> {
    const answer = this.isChangeClick(click)
      ? "change"
      : parsePlanChip(click.callbackData);
    if (!answer) return null;
    const known = this.open.get(click.chatId) ?? null;
    // A tap on an OLDER card of this chat is still a plan answer: the daemon
    // may have restarted, or the owner may have scrolled back. It just cannot
    // be matched to a payload, so the text the agent is given says less.
    const plan =
      known && (!click.messageId || known.messageId === click.messageId)
        ? known
        : null;
    if (plan && answer !== "change") this.open.delete(click.chatId);
    // THE WAIT IS OVER ON EVERY ANSWER, including a change: the ROW has been
    // answered, and the boot sweep keys on exactly that. Leaving the entry
    // would have the next boot deliver this same answer a second time. The
    // lane's own `open` entry is a different question and a change keeps it,
    // because the revision has to inherit the plan's identity.
    const settledId = plan?.messageId ?? click.messageId;
    if (typeof settledId === "number") {
      try {
        this.store.clear(settledId);
      } catch {
        /* see propose */
      }
    }
    await this.api
      .setStatus(click.assistantId, { statusText: null })
      .catch(() => {});
    if (answer === "no" && plan)
      await this.api
        .agentRequest(
          "PATCH",
          `messages/${plan.messageId}`,
          plan.assistantId,
          { options: [] },
        )
        .catch(() => {
          // eslint-disable-next-line no-console
          console.warn(`${LOG} could not retire a turned-down plan card`);
        });
    return {
      answer,
      plan,
      ...(click.customText ? { customText: click.customText } : {}),
    };
  }

  /** The chat left this process (re-pair, shutdown). Forget its card.
   *
   *  The DISK record is deliberately left alone: the card is still in the
   *  owner's chat and still answerable, so the next boot should still read it
   *  back. This only drops what this process is holding. */
  forget(chatId: number): void {
    this.open.delete(chatId);
  }
}

/**
 * How long a recorded card is worth chasing.
 *
 * The status line's own TTL is a day, and a card older than that has stopped
 * saying "waiting" to the owner whatever the row holds, so chasing it further
 * would only re-read a row nobody is looking at on every boot.
 */
export const FORGET_PLAN_AFTER_MS = 24 * 60 * 60 * 1000;

/** One thing the boot sweep decided to do about one recorded card. */
export interface MissedPlanAnswer {
  entry: PendingPlanEntry;
  /** The raw answer, in the shape `handleInboundClick` takes. */
  callbackData: string;
  customText?: string;
}

/**
 * THE BOOT SWEEP: read every recorded plan card back, adopt the ones still
 * open, and hand back the ones answered while this daemon was down.
 *
 * It exists because a plan answer reaches this plugin on ONE wire, the WS
 * `inbound_click` event, and nothing replays it: the message backfill asks for
 * rows newer than a cursor, and an answer is an `answered_at` UPDATE to a row
 * that already existed. The plan wait is also a day long by design, so "the
 * daemon was not up at the moment of the tap" is not an edge, it is the
 * commonest way a plan wait ends in silence. The sibling plugin built
 * `announceMissedPlanAnswers` for exactly this, and this lane's own approval
 * sibling already has both halves (pending-approvals-store.ts and
 * `retireOrphanedApprovals`), so the asymmetry was inside one tree.
 *
 * TWO ENDINGS PER CARD, and the unanswered one is not a no-op:
 *  - ANSWERED: the chips come off FIRST, then the entry is forgotten, then the
 *    answer is returned for delivery. That order is what makes it idempotent
 *    the way the sibling's is: a failed strip costs one delayed delivery, a
 *    failed strip AFTER a successful delivery would let the next boot deliver
 *    the same answer again, which is the louder failure.
 *  - STILL OPEN: the card is ADOPTED back into the lane. Without that a
 *    restart leaves `open` empty, and then the armed composer's `__custom__`
 *    is not recognised as this card's "Change the plan", a revision loses the
 *    plan's identity, and an answer resolves with no payload to describe.
 *
 * A row this cannot READ is left exactly as it is, entry and all: the next
 * boot tries again until it ages out. Never throws, and never blocks a boot.
 */
export async function sweepMissedPlanAnswers(
  api: Pick<PlanLaneApi, "agentRequest" | "getMessages">,
  lane: Pick<PlanLane, "adopt">,
  store: PendingPlanStore = diskPendingPlans,
  now: number = Date.now(),
): Promise<MissedPlanAnswer[]> {
  if (typeof api.getMessages !== "function") return [];
  const missed: MissedPlanAnswer[] = [];
  for (const entry of store.load()) {
    if (now - entry.at > FORGET_PLAN_AFTER_MS) {
      store.clear(entry.id);
      continue;
    }
    let message: Record<string, unknown> | undefined;
    try {
      const rows = (await api.getMessages(entry.chatId, entry.userId, {
        beforeId: entry.id + 1,
        limit: 1,
      })) as Array<Record<string, unknown>>;
      const row = (Array.isArray(rows) ? rows : []).find(
        (r) =>
          Number(((r.message ?? r) as Record<string, unknown>).id) === entry.id,
      );
      message = row
        ? ((row.message ?? row) as Record<string, unknown>)
        : undefined;
    } catch {
      continue;
    }
    if (!message) continue;
    const payload = (message.eventMeta as { payload?: unknown } | undefined)
      ?.payload;
    if (isPlanCardPayload(payload))
      lane.adopt({
        chatId: entry.chatId,
        messageId: entry.id,
        assistantId: entry.assistantId,
        payload,
      });
    if (!message.answeredAt) continue;
    const answer = (message.answerPayload ?? {}) as Record<string, unknown>;
    const callbackData = String(
      answer.callbackData ?? answer.callback_data ?? "",
    );
    const customText = answer.customText ?? answer.custom_text;
    try {
      await api.agentRequest(
        "PATCH",
        `messages/${entry.id}`,
        entry.assistantId,
        { options: [] },
      );
    } catch {
      // Keep the entry: a delivery whose strip failed would come round again.
      continue;
    }
    store.clear(entry.id);
    missed.push({
      entry,
      callbackData,
      ...(typeof customText === "string" && customText
        ? { customText }
        : {}),
    });
  }
  return missed;
}

/**
 * What the agent is told when the owner answers.
 *
 * It is prose because it starts a TURN: the model reads it as the owner's
 * instruction, so it has to say what was approved and what to do about it,
 * and on a revision it has to carry the owner's own words.
 */
export function planAnswerPrompt(decision: PlanDecision): string | null {
  const title = decision.plan?.payload.title;
  const named = title ? ` "${title}"` : "";
  if (decision.answer === "go")
    return (
      `The owner tapped Go ahead on your plan${named}. Implement it now, exactly as proposed. ` +
      `Keep your live steps up to date as you work, and tell them when it is done.`
    );
  if (decision.answer === "change") {
    const words = (decision.customText ?? "").trim();
    if (!words)
      return (
        `The owner tapped Change the plan on your plan${named} without saying what to change. ` +
        `Ask them what they want different, then propose a revised plan with propose_plan.`
      );
    return (
      `The owner wants your plan${named} changed. In their words: ${words}\n\n` +
      `Do not start the work. Propose a revised plan with propose_plan, passing the old card's ` +
      `message id as supersedes, and wait for Go ahead.`
    );
  }
  return null;
}

let counter = 0;
function newPlanId(): string {
  counter += 1;
  return `plan-${Date.now().toString(36)}-${counter.toString(36)}`;
}
