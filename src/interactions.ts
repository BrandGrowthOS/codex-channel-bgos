/** Human answers stay attached to the requesting turn; chat text can never grant an approval. */
import { randomUUID } from "node:crypto";
import type { BgosApi } from "./bgos-api.js";
import type {
  ApprovalMeta,
  BgosMessageEnvelope,
  InboundClickPayload,
} from "./types.js";
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
  /** The SERVER called the row dead; we did not run out of patience. Only
   *  approve() looks at this, to tell the two endings apart. */
  server_expired?: boolean;
};
interface Pending {
  context: InteractionContext;
  deadline: number;
  options: Map<string, string>;
  /** True for an approval: the server's `expired` flag on the row ends this
   *  wait. A question carries no such flag and is retired by its own clock. */
  endOnServerExpiry: boolean;
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
  constructor(
    private api: Pick<
      BgosApi,
      "agentRequest" | "getMessages" | "getApprovalWaitSeconds"
    >,
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
        deadline: Date.now() + duration,
        options,
        endOnServerExpiry,
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
                  Date.now() >= p.deadline
                )
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
                    p.accept({
                      skipped: true,
                      timed_out: true,
                      server_expired: true,
                    });
                  continue;
                }
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
    // What the owner said they are willing to be waited for. Read now, per
    // request, so a change made a minute ago applies to this one. Never throws:
    // an unreadable setting just means the row carries no wait and the backend
    // uses its generic 60 s, which is what every Codex approval used to get.
    let waitSeconds: number | null = null;
    try {
      waitSeconds = await this.api.getApprovalWaitSeconds(context.assistantId);
    } catch {
      /* A setting we could not read must never be able to break an approval. */
    }
    // Look again. The check at the top of this method ran BEFORE the read, and
    // the read is allowed up to 3 s: a Stop inside those 3 s would otherwise
    // put a fresh, fully tappable request card in the owner's chat for a turn
    // that is already dead. Cheaper to not ask than to ask and then retire it.
    if (context.signal.aborted) return denied;
    const command = String(
      params.command ??
        params.reason ??
        (permissions
          ? JSON.stringify(params.permissions)
          : "Apply file changes"),
    );
    // Typed, and assigned rather than spread, so the compiler actually checks
    // the wire names. `agentRequest` takes an `unknown` body, so an object
    // literal inlined below would let `waitSeconds` or `waitSecs` through and
    // the backend would silently strip it: the row would keep the generic 60 s
    // while this daemon waited ten minutes, which is the same two clocks
    // problem the rest of this method exists to end.
    const approvalMeta: ApprovalMeta = {
      tool: command,
      agent_route: `codex-${context.assistantId}`,
      risk: "high",
      request_id: id,
    };
    if (waitSeconds !== null) approvalMeta.wait_seconds = waitSeconds;
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
    // A daemon restart mid wait still loses this pending map and answers the
    // app server fail closed (codex-host.ts onRequest); that is unchanged and
    // deliberately not solved here.
    const answer = await this.wait(
      Number(result.id),
      context,
      new Map(options.map((o) => [o.callbackData, o.text])),
      ((waitSeconds ?? 60) + 90) * 1000,
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
        .agentRequest(
          "PATCH",
          `messages/${Number(result.id)}`,
          context.assistantId,
          {
            options: [],
          },
        )
        .catch(() => {
          /* A failed UI cleanup never revives a request we stopped waiting on. */
        });
    }
    const choice = options.findIndex(
      (o) => o.callbackData === answer.picked_option_value,
    );
    return choice < 0 ? denied : choices[choice][2];
  }
}
