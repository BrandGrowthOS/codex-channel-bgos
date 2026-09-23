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
  buildPlanCardMessage,
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
}

/** The card this chat is waiting on. */
export interface OpenPlan {
  messageId: number;
  assistantId: number;
  payload: PlanCardPayload;
}

export interface PlanDecision {
  answer: PlanAnswer;
  plan: OpenPlan | null;
  /** What the owner typed into the armed composer, on `plan:change` only. */
  customText?: string;
}

export class PlanLane {
  private readonly open = new Map<number, OpenPlan>();
  constructor(private readonly api: PlanLaneApi) {}

  /** The card this chat is waiting on, if this process posted it. */
  openPlan(chatId: number): OpenPlan | null {
    return this.open.get(chatId) ?? null;
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

  /** The chat left this process (re-pair, shutdown). Forget its card. */
  forget(chatId: number): void {
    this.open.delete(chatId);
  }
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
