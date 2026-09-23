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
  /**
   * The owner's per agent plan level, as the server's own LABELLED SENTENCE.
   *
   * NOT the bare enum, and this comment said it was until 2026-09-23. The wire
   * never carries `only_when_asked` / `risky_jobs` / `always`: the backend
   * ships the prefix "Your owner's setting for when you show a plan before you
   * change anything ..." followed by the level's own words
   * (backend/src/services/plan-policy.ts, buildPlanPolicyField), and it OMITS
   * the key entirely at the default level, so an absent value means the
   * default level, an older backend, or a channel with no such setting. That
   * belief is the one that made `planPolicySentence` switch on three values no
   * envelope ever holds, so every real level reached no turn at all; see the
   * header of `planPolicySentence` in plan-card.ts for the correction. This
   * declaration is the one a reader reaches first from `bgos-ws.ts`'s
   * normalizer, so it is the copy that has to say it; the DispatchArgs twin in
   * inbound-handler.ts carries the same paragraph.
   *
   * It rides the ENVELOPE rather than being read off the assistant row on
   * purpose, and that is the same rule the share guardrail follows: the daemon
   * offers, the server decides, the daemon never reads the owner's settings.
   * UNLIKE the guardrail it rides BOTH provenance arms, because it describes
   * the agent RECEIVING the turn and not whoever is speaking.
   */
  planPolicy?: string;
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

/**
 * The five words a file change kind reaches the wire as. `rename` is the one
 * the change word alone does not tell you: the app server sends it as an
 * `update` carrying a `move_path`.
 */
export type ChangeKind = "add" | "update" | "delete" | "rename" | "binary";

/** Whether `diff.files` carries an entry for this file, and why not. */
export type PreviewState = "ok" | "binary" | "too_large";

export interface ChangeSummaryFile {
  /**
   * `shortenPath` form, at most 200 characters, and UNIQUE across the rows of
   * one card: the app pairs a row to its patch by this string, so the daemon
   * widens a collision back out (or numbers it) before it reaches the wire.
   */
  path: string;
  kind: ChangeKind;
  /** Lines this file's own patch added and removed, from `countDiffLines`. */
  added: number;
  removed: number;
  preview: PreviewState;
}

/**
 * The plain line every file change card carries, whatever the owner's "Show
 * technical details" switch says. The app draws it from these numbers, so
 * they are the one part of this stage that is never gated and never cut: at
 * most 20 rows, with a 21st file counted in `file_count` and in the totals.
 */
export interface ChangeSummary {
  file_count: number;
  total_added: number;
  total_removed: number;
  files: ChangeSummaryFile[];
}

export interface DiffWireFile {
  path: string;
  /** Unified patch text, masked whole and then cut at its HEAD. */
  patch: string;
  truncated: boolean;
  /**
   * Lines the CAP did not deliver from the end of this file, counting a line
   * the cut landed INSIDE: a line that arrived in pieces did not arrive, and
   * the card's cut note is drawn from this number alone.
   */
  omitted_lines: number;
  /** Lines the REDACTOR rewrote or removed in this file. */
  hidden_lines: number;
}

export interface DiffWire {
  /**
   * Any file cut short, dropped for budget, unreadable (binary or no body),
   * or past the 20 row limit: in other words, the panels here are not the
   * whole change.
   */
  truncated: boolean;
  files: DiffWireFile[];
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
  /**
   * WHAT THE OWNER IS BEING ASKED TO AUTHORIZE, on a file change card only.
   *
   * Both fields are DECLARED HERE for the same reason every other field is:
   * `agentRequest` takes an `unknown` body and the backend's whitelist strips
   * anything its DTO does not declare, silently, with a 201. An inline object
   * literal would let `changeSummary` or a misspelled key through this side
   * and be dropped on that side, and the owner would keep reading "Apply file
   * changes" with nothing anywhere saying why.
   *
   * `change_summary` rides every file change card whose item this daemon saw;
   * `diff` rides beside it only when a patch body survived the mask and the
   * cap, and the app shows it only with the agent's own "Show technical
   * details" switch on. Both ride the CREATE and never a PATCH: the backend's
   * update path replaces the whole column and four of its fields are
   * required, so a diff only PATCH is a 400 and a full one resends the wait.
   */
  change_summary?: ChangeSummary;
  diff?: DiffWire;
  /**
   * WHY THE AGENT IS ASKING, and WHAT AN ALWAYS ANSWER WOULD SAVE.
   *
   * Declared here for the same reason as every field above: `agentRequest`
   * takes an `unknown` body and the backend's whitelist strips a key its DTO
   * does not declare, silently, with a 201. `ruleText` inlined in the POST
   * body would compile, ship and never reach an owner.
   *
   * `reason` is the MODEL's sentence, not this host's: on a command request
   * `params.reason` is `exec_command`'s `justification` passed through
   * unaltered. It rides only when it is not already the card's title, so no
   * card ever reads one sentence twice. At most 280 units
   * (REQUEST_REASON_MAX_UNITS); the backend refuses a longer one rather than
   * clipping it.
   *
   * `rule_text` is this host's sentence about the owner's own machine, and it
   * rides only beside an offered Always button. It says the one thing the
   * button never did: a live probe on app server 0.154.0 proved that answering
   * with `acceptWithExecpolicyAmendment` APPENDS a permanent line to
   * `~/.codex/rules/default.rules`, which outlives the session and the
   * project, and that the amendment is the WHOLE argv rather than a prefix,
   * so the sentence must never imply a family of commands. At most 500 units
   * (REQUEST_RULE_TEXT_MAX_UNITS).
   *
   * Both ride the CREATE, like every other field here: the backend's update
   * path replaces the whole column and four of its fields are required.
   */
  reason?: string;
  rule_text?: string;
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
   * How a row carrying `options` is drawn: chips in the thread ("inline",
   * what every card here wants) or a modal that demands an answer. Declared
   * on the payload because the plan card posts through `postMessage` rather
   * than inlining its own body the way the `reply` tool does.
   */
  renderMode?: "inline" | "modal";
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
       * moved; a diff BODY never leaves the machine on a ROW. The one case it
       * does is the file change approval card: see rule 2 in
       * `activity-markers.ts` and `ApprovalMeta.diff` above.
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
      /**
       * Stage 8 row fields. `id` is the sender's own stable identity for the
       * row (a child agent's thread id), `startedAt` is ISO 8601 and is THIS
       * ROW's own start rather than half of the card's clock above, and
       * `result` is what a child agent finally said, masked and cut to 240
       * characters by the sender and masked and cut again by the platform.
       */
      id?: string;
      startedAt?: string;
      result?: string;
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
