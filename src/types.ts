/**
 * Payload shapes mirrored from the BGOS backend. Independent types so the
 * plugin doesn't depend on backend code.
 *
 * Keep these in sync with:
 *   docs/superpowers/specs/2026-04-25-codex-bgos-integration-design.md §7
 *   backend/src/dto/integrations/*.ts
 */

export type IntegrationDirection = "bgos_initiated" | "codex_initiated";

export interface PairExchangeResponse {
  pairing_token: string;
  pairing_id: number;
  user_id: string;
}

export interface AgentCatalogEntry {
  agent_route: string;
  name: string;
  description?: string;
  avatar_url?: string;
}

export interface IntegrationPairing {
  id: number;
  device_label: string;
  integration: string;
  token_prefix: string;
  last_seen_at: string | null;
  created_at: string;
  agent_catalog: AgentCatalogEntry[];
}

export interface InboundFile {
  id: number;
  filename: string;
  mime: string;
  url?: string;
  dataUri?: string;
  fileData?: string;
  fileName?: string;
  mimeType?: string;
  s3Key?: string;
}

export interface InboundMessagePayload {
  assistantId: number;
  userId: string;
  chatId: number;
  messageId: number;
  text: string;
  files: InboundFile[];
  messageType:
    | "standard"
    | "slash_command"
    | "approval_request"
    | "agent_error"
    | "ask_user_input";
  commandName?: string;
  commandArgs?: string;
  /**
   * Agent-to-agent (a2a) side-thread marker. Present ONLY when this inbound
   * originated from a peer agent's side-thread conversation - the backend
   * stamps it on the WS `inbound_message` event (it is NOT carried by the
   * REST `integrations/inbound` poll backfill, nor by ordinary user
   * messages). When set, the reply must go back via `POST /send-message`
   * with `reply_to_id` so the initiating peer's `wait_for_reply` resolves
   * (see inbound-handler.ts). See bgos-agent-capabilities.md §11.
   */
  peerConversationId?: number;
  /** Turn state on a peer side-thread: `expecting_reply` | `more_coming` |
   *  `final`. Present alongside `peerConversationId`. */
  turnState?: string;
  senderType?: "user" | "agent" | "system";
  senderGuardrail?: string;
  chatKind?: string;
  senderUserId?: string;
  senderRelationship?: string;
}

export interface CommandsUpdatedPayload {
  userId: string;
  assistantId: number;
  commands: CommandManifestEntry[];
}

export interface PairReadyPayload {
  userId: string;
  pairingId: number;
  agentCatalog: AgentCatalogEntry[];
}

export interface AssistantBoundPayload {
  pairingId: number;
  assistantId: number;
  agentRoute: string;
}

export interface AssistantUnboundPayload {
  pairingId: number;
  assistantId: number;
}

export interface PairingRevokedPayload {
  pairingId: number;
  /** Why the pairing became unusable. `'revoked'` (user deleted the pairing)
   *  or `'rotated'` (token rotated: re-pair with the new token). Absent on
   *  older backends; the adapter treats an absent reason as `'revoked'`. */
  reason?: "revoked" | "rotated" | string;
}

export interface CallbackResultPayload {
  messageId: number;
  optionId: number;
  success: boolean;
  error?: string;
  assistantId?: number;
}

/**
 * Inbound button-click event (`inbound_click`). Emitted to `assistant:<id>`
 * when the user taps an inline button. Unlike `callback_result` (the n8n
 * success/error lane, which has NO callbackData), this carries the raw
 * `callbackData` so the adapter can route approval clicks (`ea:*`) through the
 * ApprovalHandler and forward everything else to the fork's onButtonClick hook.
 */
export interface InboundClickPayload {
  assistantId: number;
  userId: string;
  chatId: number;
  messageId: number;
  optionId: number;
  callbackData: string;
  buttonText?: string;
  customText?: string;
}

/** Option = button on a message (Telegram inline-keyboard equivalent). */
export interface MessageOption {
  text: string;
  callbackData: string;
  style?: "default" | "success" | "danger" | "primary";
}

export interface ApprovalMeta {
  tool: string;
  agent_route: string;
  risk: "low" | "medium" | "high";
  request_id: string;
  expired?: boolean;
}

/**
 * Inline agent identity. When present, the backend resolves it to
 * `messages.from_agent_inline` (or `from_agent_peer_id` if `peerId`/
 * `assistantId` matches a peer in the registry) and the BGOS frontend
 * renders the bubble with this name + color + avatar instead of the
 * bound assistant's identity.
 *
 * Used by `/board` to render each agent's contribution as a visually
 * distinct bubble even though they all originate from the single bound
 * Codex assistant. Mirrors `FromAgentInputDto` in the backend.
 */
export interface FromAgentInput {
  /** AgentPeer.id from the BGOS registry (preferred when available). */
  peerId?: number;
  /** Source assistant id - for BGOS-native cross-assistant peers. */
  assistantId?: number;
  /** Stable string id (max 128 chars) used to look up the peer. */
  externalId?: string;
  /** Display name (inline fallback). Max 80 chars. */
  name?: string;
  /** Bubble accent color, hex e.g. "#0EA5E9". */
  color?: string;
  /** Avatar URL (https only). Max 2048 chars. */
  avatarUrl?: string;
  /** Agent type. `[a-z0-9_-]+`, max 32 chars. */
  type?: "n8n" | "bgos" | "external" | "codex" | string;
}

/** Outbound message payload we POST to /api/v1/messages. */
export interface OutboundMessagePayload {
  assistantId: number;
  chatId: number;
  text: string;
  sender: "assistant";
  options?: MessageOption[];
  messageType?:
    | "standard"
    | "slash_command"
    | "approval_request"
    | "agent_error"
    | "tool_progress";
  approvalMeta?: ApprovalMeta;
  /**
   * tool_progress card payload - required when messageType="tool_progress".
   * Codex agents stream tool_use events from Claude's API in real time
   * (src/lib/claude.ts:391 in the fork), so unlike OpenClaw we emit LIVE
   * cards: POST first card with state="running" on the first tool, PATCH
   * to add tools, then PATCH state="done" at end-of-turn. Channel-agnostic
   * wire format documented at
   *   docs/superpowers/specs/2026-05-15-tool-progress-message-type-design.md
   */
  toolProgress?: {
    state: "running" | "done";
    tools: Array<{
      icon: string;
      name: string;
      args?: string;
      status: "running" | "done" | "error";
    }>;
  };
  files?: Array<{
    fileName: string;
    fileMimeType: string;
    size?: number;
    fileData?: string; // inline data URI / base64 (<500 KB path)
    s3Key?: string; // presigned-put path
    // Classification flags - the backend stores these verbatim and the
    // frontend renders an image/video as such ONLY when the flag is true
    // (else a document card). Required for outbound media to render.
    isImage?: boolean;
    isVideo?: boolean;
    isAudio?: boolean;
    isDocument?: boolean;
    width?: number;
    height?: number;
  }>;
  /**
   * When set, the backend stores `messages.reply_to_id = replyToId` and the
   * UI renders this as a quoted reply. REQUIRED in agent-to-agent (a2a)
   * side-thread chats: the originator's pollForReply correlates the target's
   * reply with the inbound peer message via this field. Without it the
   * backend falls back to positional matching, which works for 1:1 side
   * threads but is less precise.
   */
  replyToId?: number;
  /**
   * Inline-agent identity override. When set, the backend's
   * agent-peer resolver maps it to `messages.from_agent_peer_id` (registry
   * hit) or `messages.from_agent_inline` (free-form), and the BGOS UI
   * renders the bubble with the supplied name/avatar/color. Required for
   * Codex's `/board` flow so each agent's contribution shows as its own
   * sender even though they share one bound assistant.
   */
  fromAgent?: FromAgentInput;
}

export interface CommandManifestEntry {
  command: string;
  description: string;
  scope?: string;
  order_index?: number;
}

export interface PluginConfig {
  baseUrl: string;
  pairingToken: string;
  reconnect: {
    initialDelayMs: number;
    maxDelayMs: number;
  };
}

/** Error thrown when BGOS returns 401 - plugin should clear token + re-pair. */
export class PairingRevokedError extends Error {
  constructor(message = "Pairing token revoked or invalid") {
    super(message);
    this.name = "PairingRevokedError";
  }
}

/** OpenAI-compat chat message. One of these per prior turn when we dispatch
 *  to the gateway, so the agent sees full conversation context. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** One entry from `GET /api/v1/chats/:id/messages?userId=`. The backend
 *  returns `MessagesDto { messages: MessageWithFilesAndOptionsDto[] }`,
 *  where each entry nests a `message` object. */
export interface BgosMessageEnvelope {
  message: {
    id: number;
    sender: "user" | "assistant" | null;
    text: string | null;
    messageType: string;
    createdAt: string;
  };
}
