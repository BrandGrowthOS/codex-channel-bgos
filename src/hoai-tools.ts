/** Typed HOAI tools, sharing Claude Code's schemas and pure request builders. */
import { randomUUID } from "node:crypto";
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
import {
  buildMissionCreateBody,
  buildMissionTickBody,
  buildMissionCompleteBody,
} from "./hoai-shared/missions.js";

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

export class HoaiTools {
  readonly interactions: Interactions;
  constructor(
    private api: BgosApi,
    private capabilities: () => string,
  ) {
    this.interactions = new Interactions(api);
  }

  async handleRequest(
    method: string,
    params: RpcObject,
    context: ToolContext,
  ): Promise<unknown> {
    context.signal.throwIfAborted();
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
        return post(
          `assistants/${context.assistantId}/missions`,
          built(buildMissionCreateBody(args)).body,
        );
      case "tick_mini_goal":
      case "complete_mission": {
        const mission =
          args.mission_id ??
          (
            await request(
              "GET",
              `assistants/${context.assistantId}/missions/active`,
            )
          )?.mission?.id;
        const path = `assistants/${context.assistantId}/missions/${positive(mission, "mission_id")}`;
        return name === "tick_mini_goal"
          ? request(
              "PATCH",
              `${path}/tick`,
              built(buildMissionTickBody(args)).body,
            )
          : request(
              "PATCH",
              `${path}/complete`,
              built(buildMissionCompleteBody(args)).body,
            );
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
