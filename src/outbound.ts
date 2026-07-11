import type { BgosApi } from "./bgos-api.js";
import { publishMediaPath } from "./attachment-bridge.js";
import { sanitizeFromAgent } from "./agent-identity.js";
import {
  classifyOutboundError,
  OUTBOUND_BACKOFFS_MS,
} from "./outbound-retry.js";
import {
  appendOutbox,
  loadOutbox,
  rewriteOutbox,
  type OutboxEntry,
} from "./outbox.js";
import type {
  ApprovalMeta,
  FromAgentInput,
  MessageOption,
  OutboundMessagePayload,
} from "./types.js";

/**
 * High-level outbound adapter for the Codex channel.
 *
 * Wraps `BgosApi.postMessage` with the modality-specific helpers
 * `BGOSAdapter` + the fork's reply-handle expose:
 *   - `sendText`              plain assistant reply
 *   - `sendButtons`           text + ≤6 inline option chips
 *   - `sendApprovalRequest`   approval bubble (`ea:<decision>:<reqId>`)
 *   - `sendAskUserInput`      blocking pop-under (modal or inline)
 *   - `sendFile/Image/Video`  attach a local file via attachment-bridge
 *   - `sendAgentError`        styled error bubble used on dispatch failure
 *   - `sendTyping`            best-effort indicator (no-op on backend today)
 *
 * Validation is light - the backend does the authoritative checks. We
 * enforce limits client-side only when the failure mode is silent (e.g.
 * options>6 truncates, not 400; message-type mismatches sometimes
 * succeed but render wrong). Limits we enforce:
 *   - inline buttons: max 6 options (matches PR #62 backend limit + the
 *     `inline_buttons_shipped` memory).
 *
 * `BgosOutbound` is the canonical export used everywhere; `BGOSOutbound`
 * is kept as an alias for the brief moment in PR #82 where the scaffold
 * named it that way (so existing imports don't break).
 */

/** Backend rejects inline messages with >6 options. */
const INLINE_OPTION_LIMIT = 6;

export class BgosOutbound {
  /** Public read-only handle on the underlying REST client; consumers
   *  occasionally need it (e.g. inbound-handler routes uploadFile through
   *  publishMediaPath). */
  readonly api: BgosApi;

  private typingEmitter:
    | ((p: { chatId: number; assistantId: number }) => void)
    | null = null;
  private onLastError: ((code: string, message: string) => void) | null = null;
  private onOutbound: (() => void) | null = null;
  /** Single-flight guard for replaySpool: concurrent callers (the 60s spool
   *  timer, onReconnect, recover) await the same in-flight run instead of each
   *  loading + re-sending the same spooled entries (double-send). */
  private spoolInFlight: Promise<void> | null = null;
  private sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms));

  constructor(api: BgosApi) {
    this.api = api;
  }

  /** Wire the WS typing emitter (contract C4). Without it, sendTyping no-ops. */
  setTypingEmitter(
    fn: (p: { chatId: number; assistantId: number }) => void,
  ): void {
    this.typingEmitter = fn;
  }

  /** Report an outbound failure to the heartbeat lastError channel. */
  setLastErrorReporter(fn: (code: string, message: string) => void): void {
    this.onLastError = fn;
  }

  /** Called on every successful send (drives heartbeat lastOutboundAt). */
  setOutboundReporter(fn: () => void): void {
    this.onOutbound = fn;
  }

  /** Test seam: override the retry sleep so specs don't wait real seconds. */
  setSleepFn(fn: (ms: number) => Promise<void>): void {
    this.sleepFn = fn;
  }

  private rawSend(
    payload: OutboundMessagePayload,
    replyVia?: "messages" | "send-message",
  ): Promise<{ id: number }> {
    return replyVia === "send-message"
      ? this.api.sendMessage(payload)
      : this.api.postMessage(payload);
  }

  /**
   * Pick the reply endpoint + apply the outbound retry policy (contract C3).
   *
   * Default `messages` (POST /api/v1/messages) is the historical path used for
   * every normal reply, proactive send, and `/board` fan-out. `send-message`
   * (POST /api/v1/send-message) is used ONLY for a2a peer replies.
   *
   * Retry (backoff 1s/5s/25s) applies ONLY to the provably-undelivered
   * network-error class + 429 (see classifyOutboundError), because the backend
   * insert is not idempotent. Ambiguous failures (timeouts, 5xx) are NOT
   * retried and reject to the caller. After 3 failed retries of the safe class
   * the payload is spooled to the outbox for later replay.
   */
  private async deliver(
    payload: OutboundMessagePayload,
    replyVia?: "messages" | "send-message",
  ): Promise<{ id: number }> {
    let attempt = 0;
    for (;;) {
      try {
        const r = await this.rawSend(payload, replyVia);
        this.onOutbound?.();
        return r;
      } catch (err) {
        const cls = classifyOutboundError(err);
        if (cls.retriable && attempt < OUTBOUND_BACKOFFS_MS.length) {
          const wait = cls.retryAfterMs ?? OUTBOUND_BACKOFFS_MS[attempt];
          attempt += 1;
          await this.sleepFn(wait);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (cls.retriable) {
          // Exhausted the safe class: spool for later replay.
          appendOutbox({
            ts: Date.now(),
            payload,
            ...(replyVia ? { replyVia } : {}),
          });
        }
        this.onLastError?.("outbound_failed", message);
        throw err;
      }
    }
  }

  /**
   * Replay any spooled outbound payloads (contract C3). Called by the adapter
   * on WS reconnect and every 60s while non-empty. Entries older than 24h are
   * dropped on load; safe-class failures are re-kept, ambiguous failures on
   * replay are dropped to avoid a non-idempotent duplicate.
   *
   * Single-flight: concurrent callers (the 60s spool timer racing an
   * onReconnect racing a recover, or WS flapping spawning overlapping
   * onReconnects) coalesce onto one in-flight run. Two overlapping runs would
   * otherwise both load the SAME entries and each re-send them, and the backend
   * insert is NOT idempotent, so that produces duplicate agent messages.
   */
  replaySpool(): Promise<void> {
    if (this.spoolInFlight) return this.spoolInFlight;
    this.spoolInFlight = this.runReplaySpool().finally(() => {
      this.spoolInFlight = null;
    });
    return this.spoolInFlight;
  }

  private async runReplaySpool(): Promise<void> {
    const entries = loadOutbox();
    if (entries.length === 0) return;
    // Claim the entries by clearing the spool up-front (atomic tmp + rename).
    // At-most-once for the non-idempotent insert: a crash mid-replay cannot
    // double-send on restart, and a concurrent send failure re-spools below.
    // Failed safe-class entries are re-APPENDED (not rewritten) so a
    // concurrent deliver() spool during replay is preserved.
    rewriteOutbox([]);
    for (const entry of entries) {
      try {
        await this.rawSend(entry.payload, entry.replyVia);
        this.onOutbound?.();
      } catch (err) {
        const cls = classifyOutboundError(err);
        if (cls.retriable) appendOutbox(entry);
        // Ambiguous replay failures are dropped: the write may have applied.
      }
    }
  }

  // -------------------------------------------------------------------
  // Text + buttons
  // -------------------------------------------------------------------

  sendText(params: {
    assistantId: number;
    chatId: number;
    text: string;
    fromAgent?: FromAgentInput;
    /** Anchor this reply to an earlier message - BGOS renders a slim
     *  Telegram-style quoted header inside the bubble (tap → jump to
     *  source) and persists a frozen text/sender snapshot. Use when
     *  answering a stale question, following up on a past commitment,
     *  or surfacing a cron-triggered nudge tied to an older message.
     *  Same-chat constraint enforced server-side (400 otherwise). See
     *  bgos-agent-capabilities.md §9. */
    replyToId?: number;
    /** Route via `/send-message` instead of `/messages`. Set only for a2a
     *  peer replies so the backend's peer-reply bridge resolves the
     *  initiator's `wait_for_reply`. Defaults to `/messages` (unchanged). */
    replyVia?: "messages" | "send-message";
  }): Promise<{ id: number }> {
    const fromAgent = sanitizeFromAgent(params.fromAgent);
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.text,
      messageType: "standard",
      ...(fromAgent ? { fromAgent } : {}),
      ...(params.replyToId !== undefined && { replyToId: params.replyToId }),
    };
    return this.deliver(payload, params.replyVia);
  }

  /**
   * Send a text message stamped with an inline-agent identity.
   *
   * Each call produces a distinct bubble in the BGOS UI labeled with the
   * supplied name / color / avatar - used by Codex's `/board` so the
   * Research, Finance, Strategy, etc. agents each render as their own
   * sender even though they share one bound assistant.
   *
   * The backend's hybrid resolver tries `peerId` (registry id) →
   * `assistantId` (cross-assistant peer) → `externalId` (string lookup),
   * falling back to inline `{name,color,avatarUrl}` when no peer is found.
   * For Codex, pass `name` + `color` (and optionally `avatarUrl`) - the
   * inline path is what we need.
   */
  sendAsAgent(params: {
    assistantId: number;
    chatId: number;
    text: string;
    agent: FromAgentInput;
    options?: MessageOption[];
  }): Promise<{ id: number }> {
    if (
      params.options !== undefined &&
      params.options.length > INLINE_OPTION_LIMIT
    ) {
      throw new Error(
        `sendAsAgent: ${params.options.length} options exceeds inline limit (${INLINE_OPTION_LIMIT})`,
      );
    }
    const fromAgent = sanitizeFromAgent(params.agent);
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.text,
      messageType: "standard",
      ...(fromAgent ? { fromAgent } : {}),
      ...(params.options ? { options: params.options } : {}),
    };
    return this.api.postMessage(payload);
  }

  sendButtons(params: {
    assistantId: number;
    chatId: number;
    text: string;
    options: MessageOption[];
    /** See sendText.replyToId. */
    replyToId?: number;
    /** See sendText.replyVia. */
    replyVia?: "messages" | "send-message";
  }): Promise<{ id: number }> {
    if (params.options.length > INLINE_OPTION_LIMIT) {
      // Throw rather than truncate - the agent should be told it sent
      // too many options so it can re-emit. (Hermes truncates with a
      // warning because the agent gets the buttons via a regex in its
      // text; we have a typed call here so the contract is firmer.)
      throw new Error(
        `sendButtons: ${params.options.length} options exceeds inline limit (${INLINE_OPTION_LIMIT})`,
      );
    }
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.text,
      options: params.options,
      messageType: "standard",
      ...(params.replyToId !== undefined && { replyToId: params.replyToId }),
    };
    return this.deliver(payload, params.replyVia);
  }

  // -------------------------------------------------------------------
  // Approval bubbles
  // -------------------------------------------------------------------

  /**
   * Render an approval request bubble.
   *
   * Callback layout: `ea:<decision>:<reqId>` matching Telegram parity
   * (Hermes uses the same prefix). Decisions: `once|session|always|deny`.
   *
   * Default options cover the standard 4-button bubble. Pass `options`
   * explicitly to override (e.g. for a smaller agreement flow).
   */
  sendApprovalRequest(params: {
    assistantId: number;
    chatId: number;
    text: string;
    meta: ApprovalMeta;
    options?: MessageOption[];
    /** See sendText.replyToId - anchor an approval bubble to the user's
     *  earlier request the agent is now asking permission to act on. */
    replyToId?: number;
    /** See sendText.replyVia. */
    replyVia?: "messages" | "send-message";
  }): Promise<{ id: number }> {
    const reqId = params.meta.request_id;
    const defaults: MessageOption[] = [
      {
        text: "Allow once",
        callbackData: `ea:once:${reqId}`,
        style: "success",
      },
      {
        text: "Allow for session",
        callbackData: `ea:session:${reqId}`,
        style: "success",
      },
      {
        text: "Always allow",
        callbackData: `ea:always:${reqId}`,
        style: "default",
      },
      { text: "Deny", callbackData: `ea:deny:${reqId}`, style: "danger" },
    ];
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.text,
      options: params.options ?? defaults,
      messageType: "approval_request",
      approvalMeta: params.meta,
      ...(params.replyToId !== undefined && { replyToId: params.replyToId }),
    };
    return this.deliver(payload, params.replyVia);
  }

  // -------------------------------------------------------------------
  // ask_user_input pop-under (modal or inline)
  // -------------------------------------------------------------------

  /**
   * Send an `ask_user_input` prompt.
   *
   * `modal=true` (BGOS default for `ask_user_input`) renders as a
   * pop-over sheet. `modal=false` renders as inline buttons that don't
   * intrude. Use modal only when the user just messaged (~2 min) - see
   * agent hints + the canonical capability doc.
   *
   * Today the backend's `messageType: 'ask_user_input'` carries `options`
   * directly. If the canonical capability doc later splits askId/askOrder
   * out, this method gains those args - for now we keep the surface
   * minimal.
   */
  sendAskUserInput(params: {
    assistantId: number;
    chatId: number;
    prompt: string;
    options?: MessageOption[];
    modal?: boolean;
  }): Promise<{ id: number }> {
    if (
      params.options &&
      params.options.length > INLINE_OPTION_LIMIT &&
      params.modal === false
    ) {
      throw new Error(
        `sendAskUserInput (inline): ${params.options.length} options exceeds inline limit (${INLINE_OPTION_LIMIT})`,
      );
    }
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.prompt,
      // The backend's messageType union doesn't include "ask_user_input"
      // in the OutboundMessagePayload type today - but the wire format
      // accepts it (the canonical capability doc documents it). Cast to
      // sidestep the union, mirroring how Hermes handles this.
      messageType: "ask_user_input" as OutboundMessagePayload["messageType"],
      options: params.options,
    };
    return this.api.postMessage(payload);
  }

  // -------------------------------------------------------------------
  // Files / media
  // -------------------------------------------------------------------

  /** Send a file (image, video, document, audio) via the attachment-bridge. */
  async sendFile(params: {
    assistantId: number;
    chatId: number;
    filePath: string;
    caption?: string;
    fileName?: string;
    mimeType?: string;
    /** See sendText.replyToId. */
    replyToId?: number;
    /** See sendText.replyVia. */
    replyVia?: "messages" | "send-message";
  }): Promise<{ id: number }> {
    const fileRef = await publishMediaPath(this.api, params.filePath, {
      fileName: params.fileName,
      mimeType: params.mimeType,
    });
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.caption ?? "",
      messageType: "standard",
      files: [fileRef],
      ...(params.replyToId !== undefined && { replyToId: params.replyToId }),
    };
    return this.deliver(payload, params.replyVia);
  }

  /** Image - enforces image/* MIME if provided; otherwise lets MIME
   *  inference handle it. */
  sendImage(params: {
    assistantId: number;
    chatId: number;
    filePath: string;
    caption?: string;
    fileName?: string;
    mimeType?: string;
    /** See sendText.replyToId. */
    replyToId?: number;
    /** See sendText.replyVia. */
    replyVia?: "messages" | "send-message";
  }): Promise<{ id: number }> {
    if (params.mimeType && !params.mimeType.startsWith("image/")) {
      throw new Error(
        `sendImage: mimeType ${params.mimeType} is not image/*`,
      );
    }
    return this.sendFile(params);
  }

  /** Video - enforces video/* MIME if provided. */
  sendVideo(params: {
    assistantId: number;
    chatId: number;
    filePath: string;
    caption?: string;
    fileName?: string;
    mimeType?: string;
    /** See sendText.replyToId. */
    replyToId?: number;
    /** See sendText.replyVia. */
    replyVia?: "messages" | "send-message";
  }): Promise<{ id: number }> {
    if (params.mimeType && !params.mimeType.startsWith("video/")) {
      throw new Error(
        `sendVideo: mimeType ${params.mimeType} is not video/*`,
      );
    }
    return this.sendFile(params);
  }

  // -------------------------------------------------------------------
  // Errors + typing
  // -------------------------------------------------------------------

  sendAgentError(params: {
    assistantId: number;
    chatId: number;
    reason: string;
  }): Promise<{ id: number }> {
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: `⚠ Agent error: ${params.reason}`,
      messageType: "agent_error",
    };
    return this.api.postMessage(payload);
  }

  /**
   * Send a "typing..." indicator (contract C4). Emits the client-side WS
   * `typing` event via the wired emitter (throttled 1/3s per chat inside
   * BgosWs). Best-effort: no emitter wired (or an emit failure) resolves
   * silently so a reply path is never broken over a typing indicator.
   */
  async sendTyping(params: {
    assistantId: number;
    chatId: number;
  }): Promise<void> {
    try {
      this.typingEmitter?.(params);
    } catch {
      /* best-effort */
    }
    return;
  }
}

/** Backwards-compatible alias retained for the public API surface. */
export { BgosOutbound as BGOSOutbound };
