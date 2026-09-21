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
  /**
   * The longest this daemon can hold its own side of the request open, in
   * seconds (APPROVAL_HOLD_SECONDS). It is an offer, not the real wait: the
   * server stores the smaller of this and the owner's per-agent choice, its
   * expiry sweep reads the row's stored value, and that stored number rides
   * back on the created message. Absent means a backend older than the field,
   * which gives the row the generic 60 s.
   */
  wait_seconds?: number;
  /**
   * Set by the SERVER's sweep once the row is past its deadline, and it is the
   * only thing that makes a tap on the card refuse. The daemon reads it back
   * off the row rather than running a clock of its own; see the two clocks
   * note in interactions.ts approve().
   */
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
    | "tool_progress"
    | "event";
  approvalMeta?: ApprovalMeta;
  /**
   * Renderable payload - required when messageType="event". The app draws the
   * card registered for `payload.kind` and falls back to the title plus the
   * message text when it does not know the kind, so an older build shows a
   * plain titled row rather than nothing. Stage 4 posts the two quiet activity
   * markers this way (context_compacted, turn_continues) rather than adding a
   * MessageType, which older clients parse strictly.
   */
  eventMeta?: {
    source: "agent";
    title: string;
    peek?: string;
    payload: Record<string, unknown> & { kind: string };
  };
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
    /**
     * The turn's own clock as the RUNTIME reported it, ISO 8601, on the final
     * PATCH only. Never computed from a message timestamp, and both ends or
     * neither.
     */
    startedAt?: string;
    finishedAt?: string;
    tools: Array<{
      icon: string;
      name: string;
      args?: string;
      status: "running" | "done" | "error";
      /**
       * Stage 4 and stage 7 row fields, all optional and all additive: an
       * older backend drops what it does not know and an older app draws the
       * row as before. `kind` absent reads as "tool". The last four are what
       * a command printed, the code it exited with and the lines an edit
       * moved; a diff BODY still never leaves the machine.
       *
       * This is the SECOND of three hand written copies of this row shape
       * (`ToolProgressEntry` in tool-progress.ts and the inline type in
       * `BgosApi.patchMessage` are the others). They do not share a type, so
       * a field added to two of the three is a field the third denies exists:
       * the row is refused at that boundary and every reader of this type is
       * told the field is not there.
       */
      kind?: "tool" | "subagent";
      path?: string;
      pathCount?: number;
      detail?: string;
      durationMs?: number;
      output?: string;
      exitCode?: number;
      linesAdded?: number;
      linesRemoved?: number;
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
    /**
     * Present on an `approval_request` row. `expired` is the server's verdict
     * that the request is dead, and the durable poll in interactions.ts reads
     * it here: it is why a daemon stops listening at the same moment the card
     * stops accepting a tap, instead of a few minutes earlier.
     */
    approvalMeta?: ApprovalMeta;
  };
}
