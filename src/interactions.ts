/** Human answers stay attached to the requesting turn; chat text can never grant an approval. */
import { randomUUID } from "node:crypto";
import type { BgosApi } from "./bgos-api.js";
import type { InboundClickPayload } from "./types.js";
import type { RpcObject } from "./app-server.js";

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
};
interface Pending {
  context: InteractionContext;
  deadline: number;
  options: Map<string, string>;
  accept: (answer: Answer) => void;
}
export const AGENT_BUTTON_PREFIX = "u:";
export const escapeButton = (value: string): string =>
  AGENT_BUTTON_PREFIX + value;
export const unescapeButton = (value: string): string =>
  value.startsWith(AGENT_BUTTON_PREFIX) ? value.slice(2) : value;

export class Interactions {
  private pending = new Map<number, Pending>();
  private pollRunning = false;
  constructor(private api: Pick<BgosApi, "agentRequest" | "getMessages">) {}

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
        deadline: Date.now() + duration,
        options,
        accept: finish,
      });
      context.signal.addEventListener("abort", cancel, { once: true });
      if (context.signal.aborted) cancel();
      void this.poll();
    });
  }

  /** Ask responses are delivered to the user's socket; durable answers also heal dropped click events. */
  private async poll(): Promise<void> {
    if (this.pollRunning) return;
    this.pollRunning = true;
    try {
      while (this.pending.size) {
        const chats = new Map(
          [...this.pending.values()].map((p) => [p.context.chatId, p.context]),
        );
        await Promise.all(
          [...chats.values()].map(async (ctx) => {
            try {
              const rows = (await this.api.getMessages(
                ctx.chatId,
                ctx.readUserId ?? ctx.userId,
              )) as unknown as RpcObject[];
              for (const row of rows) {
                const message = row.message ?? row;
                const p = this.pending.get(Number(message.id));
                if (
                  !p ||
                  p.context.chatId !== ctx.chatId ||
                  Date.now() >= p.deadline ||
                  message.approvalMeta?.expired
                )
                  continue;
                if (!message.answeredAt || !message.answerPayload) continue;
                const payload = message.answerPayload;
                const option = (
                  row.messageOptions ??
                  message.options ??
                  []
                ).find(
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
            }
          }),
        );
        if (this.pending.size) await new Promise((r) => setTimeout(r, 1200));
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
            // HOAI hides question sheets without options; otherwise Stop
            // leaves an actionable-looking picker for a turn that no longer exists.
            await this.api
              .agentRequest(
                "PATCH",
                `messages/${Number(result.id)}`,
                context.assistantId,
                { options: [] },
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
        approvalMeta: {
          tool: command,
          agent_route: `codex-${context.assistantId}`,
          risk: "high",
          request_id: id,
        },
      },
    );
    if (!Number.isSafeInteger(Number(result.id)) || Number(result.id) < 1)
      return denied;
    // Local deadline stays below the server's 60-second expiry. A late click never authorizes execution.
    const answer = await this.wait(
      Number(result.id),
      context,
      new Map(options.map((o) => [o.callbackData, o.text])),
      55_000,
    );
    const choice = options.findIndex(
      (o) => o.callbackData === answer.picked_option_value,
    );
    return choice < 0 ? denied : choices[choice][2];
  }
}
