import { io, type Socket } from "socket.io-client";
import { EventEmitter } from "node:events";

import type { BgosApi } from "./bgos-api.js";
import { loadLastId, saveLastId } from "./last-id-store.js";
import {
  MISSION_EVENT_TYPES,
  missionEventKey,
  normalizeMissionEvent,
  type MissionEventFrame,
} from "./mission-events.js";
import { normalizeSkillsRpc, type SkillsRpcFrame } from "./skills-handler.js";
import { normalizeVoiceRpc, type VoiceRpcFrame } from "./voice-rpc.js";
import {
  PairingRevokedError,
  type AssistantBoundPayload,
  type AssistantUnboundPayload,
  type CallbackResultPayload,
  type CommandsUpdatedPayload,
  type InboundClickPayload,
  type InboundMessagePayload,
  type PairReadyPayload,
  type PairingRevokedPayload,
  type PluginConfig,
} from "./types.js";

type EventMap = {
  meeting_event: [Record<string, unknown>];
  inbound_message: [InboundMessagePayload];
  inbound_click: [InboundClickPayload];
  commands_updated: [CommandsUpdatedPayload];
  pair_ready: [PairReadyPayload];
  assistant_bound: [AssistantBoundPayload];
  assistant_unbound: [AssistantUnboundPayload];
  pairing_revoked: [PairingRevokedPayload];
  callback_result: [CallbackResultPayload];
  voice_rpc: [VoiceRpcFrame];
  skills_rpc: [SkillsRpcFrame];
  /** One mission lifecycle frame, already normalized and deduped. */
  mission_event: [MissionEventFrame];
  error: [Error];
  /** Socket (re)connected / disconnected, drives heartbeat wsConnected. */
  connect: [];
  disconnect: [];
  /** Manager-level reconnect: adapter refreshes identity + backfills. */
  reconnect: [];
  /** Backfill outcome signals, drive heartbeat lastError (contract C3). */
  backfill_ok: [];
  backfill_error: [Error];
  backfill_storm: [number];
};

/** Resolve the storm-guard limit. 0 disables. Default 25. */
function resolveStormLimit(): number {
  const raw = process.env.CODEX_BGOS_BACKFILL_STORM_LIMIT;
  if (raw === undefined || raw === "") return 25;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 25;
  return Math.floor(n);
}

/**
 * Socket.IO client against BGOS. Handshake passes pairingToken as a query
 * param; backend validates via bcrypt and joins the client to
 * pairing:<id> + every assistant:<id> the pairing owns.
 *
 * Cursor authority is the DISK cursor (bgos_last_id): triggerBackfill reads
 * loadLastId() at call time and the live WS path advances no cursor of its
 * own. Dedupe + saveLastId happen in the inbound handler after the route
 * resolves. Reconnect is handled at the Manager level (socket.io.on) because
 * the Socket does not emit a `reconnect` reserved event in socket.io-client v4.
 */
export class BgosWs {
  private readonly emitter = new EventEmitter();
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private manualClose = false;
  private wsConnectedSince: string | null = null;
  private backfillInFlight: Promise<void> | null = null;
  private readonly typingThrottle = new Map<number, number>();
  /**
   * The last 200 mission event keys this socket accepted, oldest evicted
   * first, in the shape of CodexAdapter.rpcSeen. Cleared on disconnect: the
   * cost of a false accept after a reconnect is one duplicate bulletin, while
   * the cost of a false reject is the model working on a dead mission, which
   * is the exact bug this listener exists to fix.
   */
  private readonly missionSeen = new Set<string>();

  constructor(
    private cfg: PluginConfig,
    private readonly api: BgosApi,
  ) {}

  on<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  /** ISO timestamp of the current connection, or null when disconnected. */
  get connectedSince(): string | null {
    return this.wsConnectedSince;
  }

  /** Swap the pairing token (and optionally base URL) for re-pair recovery.
   *  Caller reconnects (disconnect + connect) to apply it. */
  updateToken(token: string, baseUrl?: string): void {
    this.cfg = {
      ...this.cfg,
      pairingToken: token,
      ...(baseUrl ? { baseUrl } : {}),
    };
  }

  async connect(): Promise<void> {
    this.manualClose = false;
    const socket = io(this.cfg.baseUrl, {
      path: "/socket.io",
      query: { pairingToken: this.cfg.pairingToken },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: this.cfg.reconnect.initialDelayMs,
      reconnectionDelayMax: this.cfg.reconnect.maxDelayMs,
      reconnectionAttempts: Infinity,
    });

    socket.on("connect", () => {
      this.reconnectAttempts = 0;
      this.wsConnectedSince = new Date().toISOString();
      this.emitter.emit("connect");
    });
    socket.on("disconnect", () => {
      this.wsConnectedSince = null;
      this.missionSeen.clear();
      this.emitter.emit("disconnect");
    });
    // Manager-level reconnect (the Socket does not emit `reconnect` in
    // socket.io-client v4, the previous socket.on("reconnect") was dead
    // code). The adapter refreshes identity + backfills on this.
    socket.io.on("reconnect", () => {
      this.emitter.emit("reconnect");
    });

    socket.on("inbound_message", (payload: unknown) => {
      const msg = this.normalizeInbound(payload);
      if (!msg) return;
      // No cursor advance here: the inbound handler dedupes + persists the
      // disk cursor after the route resolves.
      this.emitter.emit("inbound_message", msg);
    });

    for (const event of [
      "meeting_message",
      "meeting_turn_changed",
      "meeting_state_resync",
    ]) {
      socket.on(event, (payload: unknown) => {
        if (payload && typeof payload === "object")
          this.emitter.emit("meeting_event", payload);
      });
    }

    socket.on("inbound_click", (payload: unknown) => {
      const click = this.normalizeInboundClick(payload);
      if (click) this.emitter.emit("inbound_click", click);
    });

    socket.on("commands_updated", (p: unknown) =>
      this.emitter.emit("commands_updated", p as CommandsUpdatedPayload),
    );
    socket.on("pair_ready", (p: unknown) =>
      this.emitter.emit("pair_ready", p as PairReadyPayload),
    );
    socket.on("assistant_bound", (p: unknown) =>
      this.emitter.emit("assistant_bound", p as AssistantBoundPayload),
    );
    socket.on("assistant_unbound", (p: unknown) =>
      this.emitter.emit("assistant_unbound", p as AssistantUnboundPayload),
    );
    socket.on("pairing_revoked", (p: unknown) => {
      this.emitter.emit("pairing_revoked", p as PairingRevokedPayload);
      this.emitter.emit(
        "error",
        new PairingRevokedError("Pairing revoked by backend"),
      );
    });
    socket.on("callback_result", (p: unknown) =>
      this.emitter.emit("callback_result", p as CallbackResultPayload),
    );
    // Native voice control plane (mint / consult / dispatch). Frames are
    // normalized + op-whitelisted here (G2 lesson: a malformed frame is
    // dropped safely, the backend's own timeout surfaces it, but every
    // well-formed op MUST pass through to the handler, which answers
    // unserved ops with a descriptive error rather than silence).
    socket.on("voice_rpc", (p: unknown) => {
      const frame = normalizeVoiceRpc(p);
      if (frame) this.emitter.emit("voice_rpc", frame);
    });
    socket.on("skills_rpc", (p: unknown) => {
      const frame = normalizeSkillsRpc(p);
      if (frame) this.emitter.emit("skills_rpc", frame);
    });
    // Mission lifecycle (mission program stage 5). Eight frames, one handler
    // shape. This listener advances NO cursor (loadLastId / saveLastId is the
    // inbound MESSAGE cursor and a mission event is not a message) and never
    // triggers a backfill: there is no mission replay route, so a missed
    // event is recovered by the lane's next getActiveMission.
    for (const type of MISSION_EVENT_TYPES) {
      socket.on(type, (payload: unknown) => {
        const frame = normalizeMissionEvent(type, payload);
        if (!frame) return;
        if (!this.acceptMissionEvent(frame)) return;
        this.emitter.emit("mission_event", frame);
      });
    }

    socket.on("connect_error", (err: Error) => {
      this.reconnectAttempts++;
      this.emitter.emit("error", err);
    });

    this.socket = socket;
  }

  /**
   * True the first time this socket sees one logical mission event.
   *
   * The gateway stamps the envelope ONCE and emits it to an array of rooms, so
   * the copy that arrives through pairing:<id> and the copy that arrives
   * through assistant:<id> carry the identical key. Exact, not heuristic.
   */
  private acceptMissionEvent(frame: MissionEventFrame): boolean {
    const key = missionEventKey(frame);
    if (this.missionSeen.has(key)) return false;
    this.missionSeen.add(key);
    if (this.missionSeen.size > 200) {
      this.missionSeen.delete(this.missionSeen.values().next().value!);
    }
    return true;
  }

  /**
   * Backfill missed messages from the DISK cursor. Single-flight: concurrent
   * calls (poll tick racing a reconnect) coalesce onto the same promise.
   *
   * `opts.initial` marks the boot backfill: when the disk cursor is 0 and the
   * pairing already has history, page through it WITHOUT dispatching and seed
   * the cursor to the newest id (cold-start guard), so a fresh install does
   * not replay the entire history as new messages.
   */
  triggerBackfill(opts?: { initial?: boolean }): Promise<void> {
    if (this.backfillInFlight) return this.backfillInFlight;
    this.backfillInFlight = this.runBackfill(opts?.initial ?? false).finally(
      () => {
        this.backfillInFlight = null;
      },
    );
    return this.backfillInFlight;
  }

  private async runBackfill(initial: boolean): Promise<void> {
    try {
      const since = loadLastId();
      if (initial && since === 0) {
        await this.coldStartSeed();
        this.emitter.emit("backfill_ok");
        return;
      }
      const { messages } = await this.api.inboundSince(since);
      const normalized: InboundMessagePayload[] = [];
      for (const raw of messages) {
        const m = this.normalizeInbound(raw);
        if (m) normalized.push(m);
      }
      const stormLimit = resolveStormLimit();
      if (stormLimit > 0 && normalized.length > stormLimit) {
        // Storm guard: fast-forward the cursor, skip dispatch, surface it.
        let maxId = since;
        for (const m of normalized)
          if (m.messageId > maxId) maxId = m.messageId;
        saveLastId(maxId);
        this.emitter.emit("backfill_storm", normalized.length);
        return;
      }
      for (const m of normalized) {
        // The inbound handler dedupes (processed-ids) + persists the cursor.
        this.emitter.emit("inbound_message", m);
      }
      this.emitter.emit("backfill_ok");
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.emitter.emit("backfill_error", e);
      this.emitter.emit("error", e);
    }
  }

  /**
   * Cold-start seed: page the entire history WITHOUT dispatching, advancing
   * the disk cursor to the newest id. Bounded iterations to guarantee
   * termination even if the backend paginates oddly.
   */
  private async coldStartSeed(): Promise<void> {
    let cursor = 0;
    for (let i = 0; i < 100; i++) {
      const { messages } = await this.api.inboundSince(cursor);
      let maxId = cursor;
      let count = 0;
      for (const raw of messages) {
        const m = this.normalizeInbound(raw);
        if (!m) continue;
        count++;
        if (m.messageId > maxId) maxId = m.messageId;
      }
      if (count === 0 || maxId <= cursor) break;
      saveLastId(maxId);
      cursor = maxId;
      // Small terminal page: almost certainly the end of history.
      if (count < 2) break;
    }
  }

  /**
   * Emit a client-side `typing` WS event (contract C4). Best-effort +
   * throttled to 1 per 3s per chat. Safe on old backends: an unknown WS
   * event is ignored server-side.
   */
  emitTyping(params: { chatId: number; assistantId: number }): void {
    try {
      const now = Date.now();
      const last = this.typingThrottle.get(params.chatId) ?? 0;
      if (now - last < 3000) return;
      this.typingThrottle.set(params.chatId, now);
      this.socket?.emit("typing", {
        chatId: params.chatId,
        assistantId: params.assistantId,
      });
    } catch {
      /* best-effort, never break a reply path over a typing indicator */
    }
  }

  disconnect(): void {
    this.manualClose = true;
    this.socket?.disconnect();
    this.socket = null;
    this.wsConnectedSince = null;
  }

  /**
   * Translate the wire-level payload (snake_case) into our camelCase type.
   * Backend already emits camelCase via the helper service, but defensively
   * handle both so we don't drop messages if someone changes the emitter.
   */
  private normalizeInbound(raw: unknown): InboundMessagePayload | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const toInt = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
      return 0;
    };
    const assistantId = toInt(r.assistantId ?? r.assistant_id);
    const chatId = toInt(r.chatId ?? r.chat_id);
    const messageId = toInt(r.messageId ?? r.message_id);
    if (!assistantId || !chatId || !messageId) return null;
    // a2a side-thread markers, present only on peer-agent inbounds (the
    // backend stamps them on the WS event). `toInt` yields 0 when absent;
    // collapse that to undefined so ordinary user messages stay clean.
    const peerConversationId =
      toInt(r.peerConversationId ?? r.peer_conversation_id) || undefined;
    const turnStateRaw = r.turnState ?? r.turn_state;
    return {
      assistantId,
      chatId,
      messageId,
      userId: String(r.userId ?? r.user_id ?? ""),
      text: String(r.text ?? ""),
      senderType:
        peerConversationId || (r.senderType ?? r.sender_type) === "agent"
          ? "agent"
          : (r.senderType ?? r.sender_type) === "system"
            ? "system"
            : "user",
      chatKind: String(
        r.chat_kind ??
          (r.groupContext as Record<string, unknown> | undefined)?.chatKind ??
          "main",
      ),
      senderUserId: String(
        r.sender_user_id ??
          (r.sender as Record<string, unknown> | undefined)?.userId ??
          r.userId ??
          r.user_id ??
          "",
      ),
      senderRelationship: String(
        r.sender_relationship ??
          (r.sender as Record<string, unknown> | undefined)?.relationship ??
          "unknown",
      ),
      ...(typeof (r.senderGuardrail ?? r.sender_guardrail) === "string"
        ? { senderGuardrail: String(r.senderGuardrail ?? r.sender_guardrail) }
        : {}),
      ...(typeof (r.planPolicy ?? r.plan_policy) === "string"
        ? { planPolicy: String(r.planPolicy ?? r.plan_policy) }
        : {}),
      files: Array.isArray(r.files)
        ? (r.files as InboundMessagePayload["files"])
        : [],
      messageType: (r.messageType ??
        r.message_type ??
        "standard") as InboundMessagePayload["messageType"],
      commandName: (r.commandName ?? r.command_name ?? undefined) as
        | string
        | undefined,
      commandArgs: (r.commandArgs ?? r.command_args ?? undefined) as
        | string
        | undefined,
      ...(peerConversationId !== undefined ? { peerConversationId } : {}),
      ...(typeof turnStateRaw === "string" && turnStateRaw
        ? { turnState: turnStateRaw }
        : {}),
    };
  }

  /** Normalize an inbound_click WS payload (camelCase or snake_case). */
  private normalizeInboundClick(raw: unknown): InboundClickPayload | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const toInt = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
      return 0;
    };
    const assistantId = toInt(r.assistantId ?? r.assistant_id);
    const chatId = toInt(r.chatId ?? r.chat_id);
    const messageId = toInt(r.messageId ?? r.message_id);
    const callbackData = r.callbackData ?? r.callback_data;
    if (!assistantId || !chatId || typeof callbackData !== "string") {
      return null;
    }
    return {
      assistantId,
      chatId,
      messageId,
      userId: String(r.userId ?? r.user_id ?? ""),
      optionId: toInt(r.optionId ?? r.option_id),
      callbackData,
      ...(typeof (r.customText ?? r.custom_text) === "string"
        ? { customText: String(r.customText ?? r.custom_text) }
        : {}),
      ...(typeof (r.buttonText ?? r.button_text) === "string"
        ? { buttonText: String(r.buttonText ?? r.button_text) }
        : {}),
    };
  }
}
