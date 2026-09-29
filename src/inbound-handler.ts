/**
 * Translate a BGOS WS `inbound_message` into a `dispatch()` call against
 * Codex's existing per-agent handler.
 *
 * The fork wires this up: at boot the fork calls `adapter.setDispatch(fn)`
 * with a closure that runs Codex's `processMessageForAgent` (or
 * equivalent) and uses the supplied `replyHandle` for any outbound
 * action. `dispatch` is dependency-injected because the fork has access
 * to Codex's internal types we deliberately do not import here - keeping
 * this vendor package free of any dependency on the upstream Codex
 * source so it stays npm-installable on its own.
 *
 * What this module owns:
 *   - Looking up `agent_route` from `assistant_id` via the adapter's map
 *   - Translating BGOS attachments into local file paths via
 *     `attachment-bridge`
 *   - Building a `ReplyHandle` scoped to BGOS (calls back through the
 *     `BgosOutbound` instance, never Telegram)
 *   - Persisting `last_id` BEFORE dispatch so a crash inside the agent
 *     handler doesn't infinite-loop the cursor
 *   - Injecting `BGOS_AGENT_HINTS` into the system prompt before
 *     dispatching
 */
import { randomUUID } from "node:crypto";

import {
  ingestBgosAttachment,
  publishMediaPath,
  type BgosInboundAttachment,
} from "./attachment-bridge.js";
import { buildSystemPromptWithHints } from "./agent-hints.js";
import { saveLastId } from "./last-id-store.js";
import {
  clearPendingUnknown,
  recordPendingUnknown,
} from "./pending-unknown-store.js";
import { ProcessedIdsCache } from "./processed-ids.js";
import type { BgosOutbound } from "./outbound.js";
import type { ToolProgressOrchestrator } from "./tool-progress.js";
import type {
  ApprovalMeta,
  InboundMessagePayload,
  MessageOption,
} from "./types.js";

/**
 * Reply handle the fork's `processMessageForAgent` calls into.
 *
 * Mirrors the Telegram side (which the fork builds in
 * `src/adapters/bgos/reply-handle.ts`) so a single agent handler can
 * speak to either origin without branching internally. Methods are
 * Promise-returning so the fork can await delivery confirmation when it
 * cares.
 */
export interface ReplyHandle {
  origin: "bgos";
  sendText: (text: string) => Promise<{ id: number }>;
  sendButtons: (
    text: string,
    options: MessageOption[],
  ) => Promise<{ id: number }>;
  sendApprovalRequest: (
    text: string,
    meta: ApprovalMeta,
  ) => Promise<{ id: number }>;
  sendAskUserInput: (
    prompt: string,
    options?: MessageOption[],
    modal?: boolean,
  ) => Promise<{ id: number }>;
  sendFile: (filePath: string, caption?: string) => Promise<{ id: number }>;
  sendImage: (filePath: string, caption?: string) => Promise<{ id: number }>;
  sendVideo: (filePath: string, caption?: string) => Promise<{ id: number }>;
  sendTyping: () => Promise<void>;
  /** Publish a local file path to BGOS as a `files[]` entry; useful when
   *  the agent emits structured tool output rather than a `MEDIA:` line.
   *  The `filePath` is validated against the `CODEX_BGOS_MEDIA_ROOT` allowlist
   *  (see media-guard.ts) before any bytes are read - paths outside the
   *  root, traversal, escaping symlinks, and sensitive locations throw. */
  uploadFile: (
    filePath: string,
    opts?: { fileName?: string; mimeType?: string },
  ) => Promise<{ fileName: string; fileMimeType: string; size: number }>;
  /**
   * Record that a tool just started executing in the current agent turn.
   * The plugin emits a live `tool_progress` card in BGOS - POSTing on the
   * first call per turn, PATCHing on subsequent calls (debounced).
   *
   * Codex fork wiring: call this from `callClaudeStreaming`'s `onToolStart`
   * hook on the BGOS dispatch path:
   *
   *   onToolStart: (toolName) => replyHandle.sendToolStart(toolName)
   *
   * No-op when the adapter wasn't constructed with a tool-progress
   * orchestrator (old host code) - safe to call unconditionally.
   * `args` is optional, ≤120 chars (truncated by the plugin).
   */
  sendToolStart: (toolName: string, args?: string) => Promise<void>;
  /**
   * End-of-turn signal - transitions the active tool_progress card from
   * state="running" to "done" so the frontend auto-collapses it. The
   * fork should call this AFTER the agent's text reply has been sent
   * via `sendText` (or even if the turn ends without a reply). Idempotent
   * - safe to call multiple times. No-op when no card exists for this
   * chat (turn used no tools).
   */
  finalizeTurn: () => Promise<void>;
}

/**
 * Args the fork's dispatch function receives. Kept deliberately flat
 * and dependency-free so the fork can adapt them onto whatever shape
 * Codex's internal pipeline expects.
 */
export interface DispatchArgs {
  origin: "bgos";
  agentRoute: string;
  assistantId: number;
  chatId: number;
  /** The BGOS message id of this inbound. Surfaced so the fork can correlate
   *  / log; the reply anchoring (reply_to_id) is handled automatically by
   *  the ReplyHandle for a2a side-threads. */
  messageId: number;
  userId: string;
  text: string;
  /** Local file paths the user attached (already downloaded). Empty
   *  when the user only sent text. */
  attachments: Array<{
    localPath: string;
    fileName: string;
    mimeType: string;
    kind: "photo" | "video" | "document" | "voice";
  }>;
  /** Append to the agent's existing system prompt (hints injection
   *  happens here so every dispatch carries them). */
  systemPrompt: string;
  /** Reply handle scoped to BGOS - the agent only talks back via this. */
  replyHandle: ReplyHandle;
  /** Slash-command metadata if `messageType==='slash_command'`. */
  command?: { name: string; args: string };
  messageType: InboundMessagePayload["messageType"];
  /** Present when this inbound is a peer agent's a2a side-thread message.
   *  The reply is auto-routed back to the peer (via `/send-message` with
   *  `reply_to_id`) so the peer's `wait_for_reply` resolves - the agent
   *  does NOT need to do anything special. Surfaced for awareness / future
   *  use (e.g. tailoring the reply to `turnState`). */
  peerConversationId?: number;
  /** Turn state on the peer side-thread (`expecting_reply` | `more_coming`
   *  | `final`) when `peerConversationId` is set. */
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
   * header of `planPolicySentence` in plan-card.ts for the correction.
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

export type DispatchFn = (args: DispatchArgs) => Promise<void>;

export interface InboundHandlerDeps {
  outbound: BgosOutbound;
  /** Map an assistant id to the bound agent route. Adapter-provided. */
  getRouteForAssistant(assistantId: number): string | null;
  /** The fork-supplied dispatch function. May be `null` until the fork
   *  calls `setDispatch(fn)` - early WS messages then no-op safely. */
  getDispatch(): DispatchFn | null;
  /** Optional system-prompt prefix (e.g. agent persona). The handler
   *  appends `BGOS_AGENT_HINTS` to whatever this returns. */
  getSystemPrompt?(agentRoute: string): string;
  /** Tool-progress card orchestrator - adapter-provided. The factory
   *  wires `replyHandle.sendToolStart` + `replyHandle.finalizeTurn`
   *  through this. Optional for back-compat; older host code that
   *  doesn't call these methods continues to work, just without cards. */
  toolProgress?: ToolProgressOrchestrator;
  /** Called (best-effort) when a message is about to dispatch, driving the
   *  heartbeat `lastInboundAt` timestamp. Optional. */
  onInbound?(): void;
  /** Rate-limited, single-flight scope refresh invoked when an inbound
   *  arrives for an assistant_id NOT in the route map. The adapter refreshes
   *  identity (whoami) so a newly-exposed agent heals without a restart. The
   *  handler retries the route lookup ONCE after this resolves. Optional. */
  onUnknownAssistant?(assistantId: number): Promise<void>;
}

/**
 * Build a BGOS-scoped ReplyHandle. Extracted so both the inbound dispatch
 * path AND the adapter's `makeReplyHandle` factory (contract C6, for the
 * fork's HITL button-click resume) produce an identical surface.
 *
 * `replyVia` / `replyToId` are set by the inbound path for a2a peer replies;
 * `makeReplyHandle` leaves them undefined (a plain reply into a chat).
 */
export function buildReplyHandle(
  deps: { outbound: BgosOutbound; toolProgress?: ToolProgressOrchestrator },
  target: {
    assistantId: number;
    chatId: number;
    replyVia?: "send-message";
    replyToId?: number;
  },
): ReplyHandle {
  const { assistantId, chatId, replyVia, replyToId } = target;
  return {
    origin: "bgos",
    sendText: (text) =>
      deps.outbound.sendText({
        assistantId,
        chatId,
        text,
        replyVia,
        replyToId,
      }),
    sendButtons: (text, options) =>
      deps.outbound.sendButtons({
        assistantId,
        chatId,
        text,
        options,
        replyVia,
        replyToId,
      }),
    sendApprovalRequest: (text, meta) =>
      deps.outbound.sendApprovalRequest({
        assistantId,
        chatId,
        text,
        // SECURITY: ignore any agent-supplied request_id and mint a
        // fork-generated UUID. The request_id keys the approval-callback
        // correlation map (ea:<decision>:<reqId>); an agent that picks its
        // own value could collide with another in-flight approval and steal
        // or clobber its decision. A v4 UUID is collision-free.
        meta: { ...meta, request_id: randomUUID() },
        replyVia,
        replyToId,
      }),
    sendAskUserInput: (prompt, options, modal) =>
      deps.outbound.sendAskUserInput({
        assistantId,
        chatId,
        prompt,
        options,
        modal,
      }),
    sendFile: (filePath, caption) =>
      deps.outbound.sendFile({
        assistantId,
        chatId,
        filePath,
        caption,
        replyVia,
        replyToId,
      }),
    sendImage: (filePath, caption) =>
      deps.outbound.sendImage({
        assistantId,
        chatId,
        filePath,
        caption,
        replyVia,
        replyToId,
      }),
    sendVideo: (filePath, caption) =>
      deps.outbound.sendVideo({
        assistantId,
        chatId,
        filePath,
        caption,
        replyVia,
        replyToId,
      }),
    sendTyping: () => deps.outbound.sendTyping({ assistantId, chatId }),
    uploadFile: (filePath, opts) =>
      publishMediaPath(deps.outbound.api, filePath, opts),
    sendToolStart: async (toolName, args) => {
      if (!deps.toolProgress) return;
      await deps.toolProgress.sendToolStart({
        assistantId,
        chatId,
        toolName,
        args,
      });
    },
    finalizeTurn: async () => {
      if (!deps.toolProgress) return;
      await deps.toolProgress.finalizeTurn(chatId);
    },
  };
}

/**
 * Build the inbound-event handler. Returns an async function the
 * adapter wires onto `BgosWs`'s `inbound_message` event.
 */
export function createInboundHandler(
  deps: InboundHandlerDeps,
): (event: InboundMessagePayload) => Promise<void> {
  // Chats known to be a2a (peer) side-threads. A chat is learned the first
  // time an inbound arrives carrying `peerConversationId` (the WS event
  // stamps it). We remember it so a later message in the same thread that
  // arrives WITHOUT markers - e.g. a REST `integrations/inbound` poll
  // backfill, which strips them - still gets its reply routed correctly.
  const a2aChats = new Set<number>();
  // Dedupe cache shared by the live WS path AND the backfill/poll path (both
  // flow through this handler). Gated AFTER the route resolves so an unknown-
  // assistant message stays UNCONSUMED and the poll re-fetches it until
  // identity heals (contract C3). 500-entry FIFO, ported from openclaw.
  const processedIds = new ProcessedIdsCache(500);
  // Rate-limit the unknown-assistant warning to 1/min per assistant id.
  const unknownWarnedAt = new Map<number, number>();

  return async function handleInbound(event): Promise<void> {
    let route = deps.getRouteForAssistant(event.assistantId);
    if (!route) {
      // Unknown assistant: the user likely just exposed a new agent. Ask the
      // adapter to refresh identity (rate-limited + single-flight), then retry
      // the lookup ONCE.
      if (deps.onUnknownAssistant) {
        try {
          await deps.onUnknownAssistant(event.assistantId);
        } catch {
          /* swallow: the retry below decides the outcome */
        }
        route = deps.getRouteForAssistant(event.assistantId);
      }
      if (!route) {
        // Leave the message UNCONSUMED: do NOT mark dedupe, do NOT saveLastId.
        // Record it as pending-unknown so a sibling KNOWN message's saveLastId
        // cannot advance the disk cursor past this hole (durable clamp). The 5s
        // poll re-fetches it until refreshIdentity fills the map. Warn at most
        // 1/min per assistant so we don't spam the logs.
        recordPendingUnknown(event.messageId);
        const now = Date.now();
        const last = unknownWarnedAt.get(event.assistantId) ?? 0;
        if (now - last >= 60_000) {
          unknownWarnedAt.set(event.assistantId, now);
          // eslint-disable-next-line no-console
          console.warn(
            "[codex-channel-bgos] inbound for unknown assistant_id=" +
              event.assistantId +
              " (leaving unconsumed; poll will retry after identity heals)",
          );
        }
        return;
      }
    }

    // Route resolved. Dedupe SYNCHRONOUSLY before the first await: a message
    // that already dispatched (via the other delivery path) is skipped here,
    // and only a first-seen message advances the disk cursor.
    if (!processedIds.markIfFirstTime(event.messageId)) return;
    // This id is now consumed: clear any pending-unknown record for it BEFORE
    // saving the cursor so the clamp releases and the cursor can advance to it.
    // (A message that heals after being stranded flows through here once its
    // route resolves.) No-op when the id was never pending.
    clearPendingUnknown(event.messageId);
    // Persist the cursor BEFORE dispatch. A crash inside the agent handler
    // should not cause an infinite replay on restart (matches Hermes).
    saveLastId(event.messageId);
    deps.onInbound?.();

    // Translate BGOS attachments to local file paths. Failures are
    // disclosed to both the user and the model; the user's text is retained.
    const attachments: DispatchArgs["attachments"] = [];
    const missingAttachments: string[] = [];
    for (const f of event.files ?? []) {
      try {
        const ingested = await ingestBgosAttachment(
          f as unknown as BgosInboundAttachment,
        );
        attachments.push({
          localPath: ingested.localPath,
          fileName: ((f as BgosInboundAttachment).fileName ||
            f.filename ||
            "attachment") as string,
          mimeType: ingested.mimeType,
          kind: ingested.kind,
        });
      } catch (err) {
        missingAttachments.push(
          (f as BgosInboundAttachment).fileName || f.filename || "attachment",
        );
        // eslint-disable-next-line no-console
        console.warn(
          "[codex-channel-bgos] attachment ingest failed for " +
            (f.filename || "<unnamed>") +
            ": " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    if (missingAttachments.length) {
      await deps.outbound
        .sendAgentError({
          assistantId: event.assistantId,
          chatId: event.chatId,
          reason:
            "Some attachments could not be downloaded. Please attach them again.",
        })
        .catch(() => {});
    }

    // a2a peer detection. If this inbound carries a peerConversationId it
    // is a peer agent's side-thread message; remember the chat so later
    // (marker-less) messages in it are still treated as a2a. For any reply
    // into a known a2a chat we (a) route via `/send-message` so the backend
    // peer-reply bridge fires and the initiator's `wait_for_reply`
    // resolves, and (b) anchor the reply to the inbound's messageId via
    // `reply_to_id` for precise correlation (same-chat, so no 400). Normal
    // user replies are untouched: `replyVia`/`replyToId` stay undefined and
    // the outbound falls through to `/messages` exactly as before.
    if (event.peerConversationId !== undefined) a2aChats.add(event.chatId);
    const isPeerReply = a2aChats.has(event.chatId);
    const replyVia: "send-message" | undefined = isPeerReply
      ? "send-message"
      : undefined;
    const replyToId: number | undefined = isPeerReply
      ? event.messageId
      : undefined;

    // Build the BGOS-scoped ReplyHandle via the shared factory (identical to
    // the surface the adapter's makeReplyHandle exposes for HITL resume).
    const replyHandle: ReplyHandle = buildReplyHandle(
      { outbound: deps.outbound, toolProgress: deps.toolProgress },
      {
        assistantId: event.assistantId,
        chatId: event.chatId,
        replyVia,
        replyToId,
      },
    );

    const dispatch = deps.getDispatch();
    if (!dispatch) {
      // Fork hasn't installed the dispatch function yet - log and keep
      // going. The cursor was saved above so this message won't replay
      // on restart; users should ensure dispatch is set before pairing.
      // eslint-disable-next-line no-console
      console.warn(
        "[codex-channel-bgos] no dispatch fn registered - message_id=" +
          event.messageId +
          " dropped. Ensure the fork called adapter.setDispatch().",
      );
      return;
    }

    const baseSystemPrompt = deps.getSystemPrompt?.(route) ?? "";
    const systemPrompt = buildSystemPromptWithHints(baseSystemPrompt);

    const command =
      event.messageType === "slash_command"
        ? {
            name: (event.commandName ?? "").toLowerCase(),
            args: event.commandArgs ?? "",
          }
        : undefined;

    try {
      await dispatch({
        origin: "bgos",
        agentRoute: route,
        assistantId: event.assistantId,
        chatId: event.chatId,
        messageId: event.messageId,
        userId: event.userId,
        senderType: event.senderType,
        chatKind: event.chatKind,
        senderUserId: event.senderUserId,
        senderRelationship: event.senderRelationship,
        senderGuardrail:
          event.senderType === "agent" ? undefined : event.senderGuardrail,
        // A PASS THROUGH, and deliberately NOT branched on senderType the way
        // the guardrail above is. The guardrail is a term about a human share
        // recipient, so an agent turn has none; the plan level is a fact about
        // the agent RECEIVING the turn, so it is equally true on a peer
        // delivery. The backend says so in one place and means it: its emitter
        // deletes sender, isSharedRecipient, shareOwnerUserId and
        // senderGuardrail inside its senderType === 'agent' branch and carries
        // a paragraph saying planPolicy is deliberately not deleted there
        // (backend websocket-outcome-event.service.ts), and peers.service.ts
        // stamps the RECEIVING agent's level onto the same a2a envelope that
        // carries senderType 'agent'. Dropping it here made one owner setting
        // reach a Claude agent's peer turn and not a Codex agent's.
        planPolicy: event.planPolicy,
        text: missingAttachments.length
          ? `${event.text}\n\n[Attachment delivery notice: the following files are unavailable. Do not infer their contents. File names: ${JSON.stringify(missingAttachments)}]`
          : event.text,
        attachments,
        systemPrompt,
        replyHandle,
        command,
        messageType: event.messageType,
        ...(event.peerConversationId !== undefined
          ? { peerConversationId: event.peerConversationId }
          : {}),
        ...(event.turnState !== undefined
          ? { turnState: event.turnState }
          : {}),
      });
    } catch (err) {
      // Fork's dispatch should never throw - but if it does, surface
      // the failure as an `agent_error` so the user sees something
      // rather than a silent dead chat.
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(
        "[codex-channel-bgos] dispatch threw for assistant_id=" +
          event.assistantId +
          ": " +
          reason,
      );
      try {
        await deps.outbound.sendAgentError({
          assistantId: event.assistantId,
          chatId: event.chatId,
          reason,
        });
      } catch {
        /* swallow - best-effort */
      }
    }
  };
}
