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
      ...(previous ? { supersedes: previous.messageId } : {}),
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
   * Read a click as a plan answer, or return null when it is not one.
   *
   * The card is forgotten here, whatever the answer, so a second tap on a
   * settled card cannot start a second turn. `plan:no` also retires the chips,
   * because nothing else will: the app collapses them on the answer it already
   * wrote, and a daemon restart would otherwise find a live looking card
   * nobody is waiting on.
   */
  async answer(click: {
    assistantId: number;
    chatId: number;
    messageId?: number;
    callbackData?: string;
    customText?: string;
  }): Promise<PlanDecision | null> {
    const answer = parsePlanChip(click.callbackData);
    if (!answer) return null;
    const known = this.open.get(click.chatId) ?? null;
    // A tap on an OLDER card of this chat is still a plan answer: the daemon
    // may have restarted, or the owner may have scrolled back. It just cannot
    // be matched to a payload, so the text the agent is given says less.
    const plan =
      known && (!click.messageId || known.messageId === click.messageId)
        ? known
        : null;
    if (plan) this.open.delete(click.chatId);
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
