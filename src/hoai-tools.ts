/** Typed HOAI tools, sharing Claude Code's schemas and pure request builders. */
import { randomUUID } from "node:crypto";
import { answerElicitation } from "./mcp-elicitation.js";
import type { BgosApi } from "./bgos-api.js";
import type { DynamicTool } from "./codex-host.js";
import type { RpcObject } from "./app-server.js";
import { publishMediaPath, publishMediaUrl } from "./attachment-bridge.js";
import { resolveAllowedMediaPath } from "./media-guard.js";
import {
  Interactions,
  escapeButton,
  type InteractionContext,
} from "./interactions.js";
import { HOAI_TOOL_DECLARATIONS } from "./hoai-shared/tool-declarations.js";
import {
  BOARDS_TOOL_DECLS,
  handleBoardsTool,
} from "./hoai-shared/boards-tools.js";
import {
  buildScheduleCreateBody,
  buildScheduleListPath,
  buildScheduleCancelPath,
} from "./hoai-shared/schedule.js";
import { buildCallOwnerBody } from "./hoai-shared/call-owner.js";
import {
  buildHealthLogEventBody,
  buildHealthLogListPath,
  buildHealthLogUndoPath,
  buildShowHealthTrackerPayload,
  summarizeHealthLogResult,
} from "./hoai-shared/health-log.js";
import {
  BUNDLED_RENDERABLES_FALLBACK,
  buildComponentEventMessage,
  findRenderable,
  listRenderableKinds,
  validateComponentPayload,
} from "./hoai-shared/renderables.js";
import type { PlanCardInput, PlanDoor } from "./plan-card.js";
import {
  buildMissionActivePath,
  buildMissionCreateBody,
  buildMissionTickBody,
  buildMissionCompleteBody,
} from "./hoai-shared/missions.js";

/**
 * Told when a mission tool writes a mission, so the mission control lane can
 * tell this daemon's own write apart from the owner's.
 *
 * It is load bearing against a backend older than mission stage 5, which
 * sends no `cleared_by`: the agent's own last tick closes the mission and the
 * completion that comes back would otherwise be read as the owner marking it
 * done, narrated to the model as a falsehood and steered into the very turn
 * that ticked it.
 */
/**
 * Where `propose_plan` sends a plan.
 *
 * The tool itself owns nothing: the card has to supersede the chat's previous
 * open plan, write the status line and be remembered for the click that
 * answers it, and all three of those live with the adapter, one process wide.
 * Injected the way `MissionSelfWrites` is, so a tools instance built without
 * an adapter (every unit test of another tool) still constructs.
 *
 * It RETURNS AT ONCE by contract. Nothing here waits on a person, which is why
 * `propose_plan` must stay OUT of OWNER_BLOCKING_TOOLS: a tool that parked the
 * turn's watchdog on an answer that may come tomorrow would hold a 30 minute
 * budget open forever (codex-host.ts, `execute`).
 */
export interface PlanCardPoster {
  /**
   * `plan_id` and `revision` are deliberately NOT the caller's: a revision has
   * to keep the identity of the plan it replaces, and only the adapter knows
   * which card is open in the chat.
   */
  propose(input: {
    assistantId: number;
    chatId: number;
    plan: Omit<PlanCardInput, "planId" | "revision">;
  }): Promise<{ messageId: number }>;
  /**
   * Is this chat's plan wait actually held by a read only sandbox?
   *
   * Asked per chat rather than read off a constant, because one daemon can be
   * planning under the lock in one chat and proposing a plan it decided on in
   * an ordinary coding chat at the same time. The card's `enforced` bit is the
   * sentence the app puts in front of the owner, so it is a fact and never an
   * assumption.
   */
  enforcedIn(chatId: number): boolean;
}
const NO_PLAN_CARDS: PlanCardPoster = {
  async propose() {
    throw new Error("Plan cards are not available on this connection.");
  },
  enforcedIn: () => false,
};

export interface MissionSelfWrites {
  /** About to write this mission: the frame it emits is ours. */
  starting(missionId: number): void;
  /** The write landed and closed nothing, so the stamp is spent. */
  leftOpen(missionId: number): void;
}

export interface ToolContext extends InteractionContext {
  messageId?: number;
  peerConversationId?: number;
  meetingId?: number;
  chatKind?: string;
  onReply?: () => void;
  voiceTaskId?: string;
  completeVoiceTask?: (args: RpcObject) => Promise<unknown>;
}
// Invisible Codex consults return text through the app-server host. They do
// not inject a cooperative notification that needs voice_consult_reply.
const declarations = [
  ...HOAI_TOOL_DECLARATIONS.filter((d) => d.name !== "voice_consult_reply"),
  ...BOARDS_TOOL_DECLS,
];
export const HOAI_TOOLS: DynamicTool[] = declarations.map((d) => ({
  type: "function",
  name: d.name,
  description: d.description,
  inputSchema: d.inputSchema as Record<string, unknown>,
}));

export function validateToolInput(
  value: unknown,
  schema: RpcObject,
  path = "arguments",
): void {
  if (Array.isArray(schema.type)) {
    if (
      !schema.type.some((type: string) => {
        try {
          validateToolInput(value, { ...schema, type }, path);
          return true;
        } catch {
          return false;
        }
      })
    )
      throw new Error(`${path} has an invalid type.`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(`${path} must be one of ${schema.enum.join(", ")}.`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${path} must be an object.`);
    for (const key of schema.required ?? [])
      if ((value as RpcObject)[key] === undefined)
        throw new Error(`${path}.${key} is required.`);
    for (const [key, item] of Object.entries(value))
      if (schema.properties?.[key])
        validateToolInput(item, schema.properties[key], `${path}.${key}`);
  } else if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? 100)
    )
      throw new Error(`${path} has an invalid number of items.`);
    if (schema.items)
      value.forEach((item, i) =>
        validateToolInput(item, schema.items, `${path}[${i}]`),
      );
  } else if (
    schema.type === "integer"
      ? !Number.isSafeInteger(value)
      : schema.type === "null"
        ? value !== null
        : schema.type && typeof value !== schema.type
  )
    throw new Error(`${path} must be ${schema.type}.`);
  if (typeof value === "string" && value.length > (schema.maxLength ?? 200_000))
    throw new Error(`${path} is too long.`);
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    throw new Error(`${path} is out of range.`);
}
function positive(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive id.`);
  return n;
}
function built<T extends { ok: boolean; error?: string }>(
  result: T,
): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result as Extract<T, { ok: true }>;
}
export function toolError(error: unknown): string {
  const err = error as {
    response?: { status?: number; data?: { message?: unknown } };
    message?: string;
  };
  const reason =
    err.response?.data?.message ??
    err.message ??
    "HOAI could not complete the action.";
  return `${err.response?.status ? `HTTP ${err.response.status}: ` : ""}${Array.isArray(reason) ? reason.join("; ") : String(reason)}`.slice(
    0,
    2000,
  );
}

const NO_MISSION_SELF_WRITES: MissionSelfWrites = {
  starting: () => {},
  leftOpen: () => {},
};

export class HoaiTools {
  readonly interactions: Interactions;
  constructor(
    private api: BgosApi,
    private capabilities: () => string,
    private missionWrites: MissionSelfWrites = NO_MISSION_SELF_WRITES,
    private plans: PlanCardPoster = NO_PLAN_CARDS,
  ) {
    this.interactions = new Interactions(api);
  }

  async handleRequest(
    method: string,
    params: RpcObject,
    context: ToolContext,
  ): Promise<unknown> {
    context.signal.throwIfAborted();
    if (method === "mcpServer/elicitation/request") {
      const answer = await answerElicitation(
        this.interactions,
        context,
        params,
      );
      if (answer.action === "cancel" && !context.signal.aborted) {
        await this.api.agentRequest("POST", "messages", context.assistantId, {
          assistantId: context.assistantId,
          chatId: context.chatId,
          sender: "assistant",
          text: "This MCP request could not be completed in chat. Reconnect its provider in Codex for authentication, or ask the agent to use a simpler form.",
        });
      }
      return answer;
    }
    if (method === "item/tool/requestUserInput")
      return this.interactions.nativeAsk(context, params);
    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(method)
    )
      return this.interactions.approve(context, method, params);
    if (method !== "item/tool/call")
      throw new Error(`Unsupported Codex request: ${method}`);
    try {
      const result = await this.call(params.tool, params.arguments, context);
      return {
        contentItems: [
          {
            type: "inputText",
            text: typeof result === "string" ? result : JSON.stringify(result),
          },
        ],
        success: true,
      };
    } catch (error) {
      return {
        contentItems: [{ type: "inputText", text: toolError(error) }],
        success: false,
      };
    }
  }

  async call(
    name: string,
    raw: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const definition = HOAI_TOOLS.find((d) => d.name === name);
    if (!definition) throw new Error(`Unknown HOAI tool: ${name}`);
    validateToolInput(raw, definition.inputSchema);
    const args = raw as RpcObject;
    context.signal.throwIfAborted();
    const chatId =
      args.chat_id === undefined
        ? context.chatId
        : positive(args.chat_id, "chat_id");
    if (chatId !== context.chatId)
      throw new Error(
        "This tool can only act in the chat that supplied the current event.",
      );
    const request = (
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
    ) => this.api.agentRequest(method, path, context.assistantId, body);
    const post = (path: string, body: unknown) => request("POST", path, body);
    if (name.startsWith("boards_")) {
      if (typeof args.file_path === "string")
        args.file_path = resolveAllowedMediaPath(args.file_path);
      const boardRequest = async (
        method: "GET" | "POST" | "PATCH" | "DELETE",
        path: string,
        body?: unknown,
      ) => {
        try {
          return await request(method, path, body);
        } catch (error) {
          // The shared Boards handler expects a body-bearing Error rather
          // than Axios's generic status message. Preserve the refusal body,
          // never the request/config (which carries pairing credentials).
          const data = (error as { response?: { data?: unknown } })?.response
            ?.data;
          if (data && typeof data === "object")
            throw new Error(JSON.stringify(data));
          throw error;
        }
      };
      const result = await handleBoardsTool(name, args, {
        assistantId: context.assistantId,
        bgosGet: (path) => boardRequest("GET", path),
        bgosPost: (path, body) => boardRequest("POST", path, body),
        bgosPatch: (path, body) => boardRequest("PATCH", path, body),
        bgosDelete: (path) => boardRequest("DELETE", path),
      });
      if (result?.isError) throw new Error(JSON.stringify(result.content));
      return result;
    }
    switch (name) {
      case "bgos_capabilities":
        return this.capabilities();
      case "channel_ack":
        return { acknowledged: true };
      case "reply": {
        if (context.meetingId) {
          if (args.files?.length || args.buttons?.length)
            throw new Error(
              "Meeting replies support text only. Use meeting_reply.",
            );
          return this.call(
            "meeting_reply",
            { meeting_id: context.meetingId, text: args.text },
            context,
          );
        }
        const files = [];
        for (const file of args.files ?? []) {
          if (!file.path && !file.url)
            throw new Error("Provide a workspace path or public media URL.");
          const opts = { fileName: file.file_name, mimeType: file.mime_type };
          files.push(
            file.path
              ? await publishMediaPath(this.api, file.path, opts)
              : await publishMediaUrl(this.api, file.url, opts),
          );
        }
        if (!args.text && !files.length && !args.buttons?.length)
          throw new Error("Provide text, files, or buttons.");
        const response = await post(
          context.peerConversationId ? "send-message" : "messages",
          {
            assistantId: context.assistantId,
            chatId,
            sender: "assistant",
            text: args.text ?? "",
            files,
            ...(args.buttons?.length
              ? {
                  options: args.buttons.map((b: RpcObject) => ({
                    text: b.label,
                    callbackData: escapeButton(b.value),
                    // Optional and additive. The app draws a tier when it
                    // knows one and neutral otherwise, so an older client
                    // loses nothing by us sending it.
                    ...(typeof b.style === "string" ? { style: b.style } : {}),
                  })),
                  renderMode: args.render_mode ?? "inline",
                }
              : {}),
            ...(args.reply_to_id || context.peerConversationId
              ? { replyToId: args.reply_to_id ?? context.messageId }
              : {}),
          },
        );
        context.onReply?.();
        return response;
      }
      case "propose_plan": {
        const door: PlanDoor =
          args.door === "typed" || args.door === "mode" ? args.door : "decided";
        const { messageId } = await this.plans.propose({
          assistantId: context.assistantId,
          chatId,
          plan: {
            title: String(args.title ?? ""),
            ...(args.summary ? { summary: String(args.summary) } : {}),
            steps: (args.steps ?? []).map((step: RpcObject) => ({
              text: String(step.text ?? ""),
              ...(step.file ? { file: String(step.file) } : {}),
              ...(step.check ? { check: String(step.check) } : {}),
              ...(step.tag ? { tag: step.tag } : {}),
            })),
            ...(args.files?.length
              ? { files: args.files.map((f: unknown) => String(f)) }
              : {}),
            ...(args.check ? { check: String(args.check) } : {}),
            door,
            // ASKED, NEVER ASSUMED. Plan mode by itself locks nothing (it
            // rewrites the model's instructions and leaves `sandboxPolicy`
            // alone), so what makes the wait real is the read only sandbox
            // `/plan` now turns on with it. A plan the MODEL decided to
            // propose inside an ordinary coding chat has neither, and this
            // answers false for exactly that chat while answering true for
            // the one next to it. See src/plan-mode.ts.
            enforced: this.plans.enforcedIn(chatId),
            ...(typeof args.supersedes === "number"
              ? { supersedes: positive(args.supersedes, "supersedes") }
              : {}),
            ...(args.note ? { note: String(args.note) } : {}),
          },
        });
        // Returns at once, on purpose. The owner's tap arrives as a click and
        // starts the NEXT turn; end this one.
        return {
          status: "pending",
          message_id: messageId,
          note: "The plan is with the owner. End your turn now; their answer starts a new one. Change nothing until then.",
        };
      }
      case "ask_user_input":
        return this.interactions.ask(
          context,
          args.questions,
          args.timeout_seconds,
        );
      case "edit_message": {
        const id = positive(args.message_id, "message_id");
        const rows = await this.api.getMessages(
          chatId,
          context.readUserId ?? context.userId,
        );
        const owned = rows.some((row: any) => {
          const m = row.message ?? row;
          const author =
            m.senderAssistantId ??
            (context.meetingId || context.chatKind === "room"
              ? null
              : (m.assistantId ?? context.assistantId));
          return (
            Number(m.id) === id &&
            m.sender === "assistant" &&
            author != null &&
            Number(author) === context.assistantId
          );
        });
        if (!owned)
          throw new Error(
            "Only this agent's recent messages in this chat can be edited.",
          );
        return request("PATCH", `messages/${id}`, { text: args.text });
      }
      case "rename_chat":
        return request("PATCH", `chats/${chatId}/title`, { title: args.title });
      case "set_status": {
        const body = Object.fromEntries(
          [
            ["statusText", args.status_text],
            ["statusEmoji", args.status_emoji],
            ["detail", args.detail],
          ].filter(([, v]) => v !== undefined),
        );
        if (!Object.keys(body).length)
          throw new Error("Provide status_text, status_emoji, or detail.");
        return request(
          "PATCH",
          `integrations/assistants/${context.assistantId}/status`,
          body,
        );
      }
      case "list_peers":
        return request("GET", "peers");
      case "list_chats":
        return request("GET", "peers/reachable");
      case "send_to_peer":
        return post(
          `peers/${positive(args.target_assistant_id, "target_assistant_id")}/send`,
          {
            text: args.text,
            parentMessageId: positive(
              args.parent_message_id,
              "parent_message_id",
            ),
            waitForReply: args.wait_for_reply === true,
            timeoutSeconds: Math.max(
              1,
              Math.min(args.timeout_seconds ?? 45, 50),
            ),
            ...(args.turn_state ? { turnState: args.turn_state } : {}),
          },
        );
      case "complete_peer_thread":
        return post("peers/conversations/close", {
          peerAssistantId: positive(
            args.peer_assistant_id,
            "peer_assistant_id",
          ),
          ...(args.summary ? { summary: args.summary } : {}),
        });
      case "peer_status":
        return request(
          "GET",
          `peers/${positive(args.peer_assistant_id, "peer_assistant_id")}/status`,
        );
      case "complete_side_thread":
        return post(
          `peers/threads/${positive(args.parent_message_id, "parent_message_id")}/complete`,
          { summary: args.summary },
        );
      case "meeting_reply": {
        if (context.meetingId !== positive(args.meeting_id, "meeting_id"))
          throw new Error("No active turn in this meeting.");
        if (!args.text && !args.yield_only)
          throw new Error("Provide text or yield_only.");
        const response = await post(`meetings/${context.meetingId}/messages`, {
          text: args.yield_only ? "PASS" : args.text,
          asAssistantId: context.assistantId,
          ...(args.next_speaker_id
            ? {
                nextSpeakerAssistantId: positive(
                  args.next_speaker_id,
                  "next_speaker_id",
                ),
              }
            : {}),
          ...(args.yield_only ? { yieldTurn: true } : {}),
        });
        context.onReply?.();
        return response;
      }
      case "add_to_meeting":
        return post(
          `meetings/${positive(args.meeting_id, "meeting_id")}/participants`,
          { assistantId: positive(args.assistant_id, "assistant_id") },
        );
      case "call_owner":
        return post(
          "voice/outbound-call",
          buildCallOwnerBody({
            assistantId: context.assistantId,
            chatId,
            reason: args.reason,
            context: args.context,
            openingMessage: args.opening_message,
          }),
        );
      case "schedule":
        return post(
          "scheduled-tasks/agent",
          built(buildScheduleCreateBody({ ...args, chatId })).body,
        );
      case "list_schedules":
        return request("GET", built(buildScheduleListPath(args.status)).path);
      case "cancel_schedule":
        return request(
          "DELETE",
          built(buildScheduleCancelPath(args.schedule_id)).path,
        );
      case "log_health_event": {
        const body = built(
          buildHealthLogEventBody(args, {
            assistantId: String(context.assistantId),
            uuid: randomUUID,
          }),
        ).body;
        try {
          return summarizeHealthLogResult(
            await post("health-log/events", body),
            body,
          );
        } catch (error) {
          throw new Error(
            `${toolError(error)} Retry only with idempotency_key=${body.idempotencyKey}.`,
          );
        }
      }
      case "list_health_events":
        return request("GET", built(buildHealthLogListPath(args)).path);
      case "undo_health_event":
        return request(
          "DELETE",
          built(buildHealthLogUndoPath(args.event_id)).path,
        );
      case "show_component":
      case "show_health_tracker": {
        const kind =
          name === "show_health_tracker" ? "health_tracker_card" : args.kind;
        const payload =
          name === "show_health_tracker"
            ? built(buildShowHealthTrackerPayload(args)).payload
            : (args.payload ?? {});
        let manifest;
        try {
          manifest = await request("GET", "renderables");
        } catch {
          manifest = BUNDLED_RENDERABLES_FALLBACK;
        }
        const entry = findRenderable(manifest, kind);
        if (!entry)
          throw new Error(
            `Unknown component. Available: ${listRenderableKinds(manifest).join(", ")}`,
          );
        built(validateComponentPayload(entry.payloadSchema, payload));
        const response = await post(
          "messages",
          built(
            buildComponentEventMessage({
              kind,
              payload,
              chatId,
              assistantId: context.assistantId,
              description: entry.description,
            }),
          ).body,
        );
        context.onReply?.();
        return response;
      }
      case "create_mission":
        return post(`assistants/${context.assistantId}/missions`, {
          ...built(buildMissionCreateBody(args)).body,
          // A mission belongs to ONE chat. The turn already names it, so the
          // agent is never asked. Omitted, never null: the backend's pipe runs
          // whitelist:true, so a null would be stripped with no error anywhere
          // and per chat scope would silently not happen.
          ...(Number.isSafeInteger(context.chatId) && context.chatId > 0
            ? { chatId: context.chatId }
            : {}),
        });
      case "tick_mini_goal":
      case "complete_mission": {
        // The chat is load bearing on the read. A mission belongs to one
        // chat, and without the chat of this turn the backend answers with
        // the agent's MAIN chat mission: a tick issued while working chat B
        // would tick chat A's card, or fail outright when chat A has none.
        const named = args.mission_id ?? undefined;
        const active =
          named === undefined
            ? await request(
                "GET",
                built(
                  buildMissionActivePath(context.assistantId, context.chatId),
                ).path,
              )
            : null;
        const missionId = positive(named ?? active?.mission?.id, "mission_id");
        const path = `assistants/${context.assistantId}/missions/${missionId}`;
        // Stamp BEFORE the write, the way the derived lane does: the gateway
        // emits the mission event from inside the request, so the frame can
        // beat the response back. Unstamped, the completion the agent's own
        // last tick triggers is narrated straight back to it as its owner
        // ending the mission, and steered into the live turn.
        this.missionWrites.starting(missionId);
        if (name === "complete_mission")
          return request(
            "PATCH",
            `${path}/complete`,
            built(buildMissionCompleteBody(args)).body,
          );
        const ticked = await request(
          "PATCH",
          `${path}/tick`,
          built(buildMissionTickBody(args)).body,
        );
        // A tick of any goal but the last closes nothing, so its stamp has
        // nothing to answer for. Spend it here rather than leave it waiting
        // for a frame that is never coming.
        if (ticked?.mission?.status && ticked.mission.status !== "completed")
          this.missionWrites.leftOpen(missionId);
        return ticked;
      }
      case "complete_voice_task": {
        if (!context.completeVoiceTask || args.task_id !== context.voiceTaskId)
          throw new Error("No matching voice task is active in this turn.");
        return context.completeVoiceTask(args);
      }
      default:
        throw new Error(`No handler for ${name}.`);
    }
  }
}
