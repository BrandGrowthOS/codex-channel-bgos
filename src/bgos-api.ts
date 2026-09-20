import axios, { type AxiosInstance } from "axios";

import {
  PairingRevokedError,
  type AgentCatalogEntry,
  type BgosMessageEnvelope,
  type CommandManifestEntry,
  type InboundMessagePayload,
  type IntegrationPairing,
  type OutboundMessagePayload,
  type PairExchangeResponse,
  type PluginConfig,
} from "./types.js";
import type { VoiceRpcResultBody } from "./voice-rpc.js";
import type { HeartbeatDto } from "./heartbeat.js";

const SKILLS_RPC_POST_TIMEOUT_MS = 3_000;

export type MissionStatus =
  | "active"
  | "paused"
  | "completed"
  | "abandoned"
  | "failed";

export type MissionOrigin = "derived" | "self_report";

export interface MissionProgress {
  current: number;
  total: number;
  label?: string;
}

export interface MissionEffort {
  used: number;
  budget: number;
  unit: "turns";
}

export type MissionFeedKind =
  | "started"
  | "worked"
  | "checked"
  | "paused"
  | "resumed"
  | "done"
  | "failed";

export interface MissionSnapshot {
  id: number;
  assistantId: number;
  title: string;
  status: MissionStatus;
  origin: MissionOrigin;
  progress: MissionProgress | null;
}

export interface CreateMissionInput {
  title: string;
  progress?: MissionProgress;
  effort?: MissionEffort;
  origin: MissionOrigin;
  firstFeedText?: string;
}

/** One row of a live Steps snapshot, as the backend's ReplaceStepsDto reads it. */
export interface StepInput {
  text: string;
  status: "pending" | "running" | "done" | "waiting";
  /** 1 based index of the step this one waits for. Codex never sends it. */
  waitsFor?: number;
}

export interface ReplaceStepsBody {
  /** The turn these steps belong to, omitted when the host did not name one. */
  turnId?: string;
  steps: StepInput[];
}

export interface PatchMissionProgressInput {
  progress?: MissionProgress;
  feedEntry?: { kind: MissionFeedKind; text: string };
}

/**
 * Thin typed wrapper around the BGOS integration endpoints. All methods
 * attach the X-BGOS-Pairing header from cfg.pairingToken.
 *
 * A 401 from any request is mapped to PairingRevokedError so callers
 * (WS client, outbound adapter) can short-circuit and let the setup
 * wizard prompt for re-pair.
 */
export class BgosApi {
  private readonly http: AxiosInstance;

  constructor(cfg: PluginConfig) {
    this.http = axios.create({
      baseURL: cfg.baseUrl + "/api/v1",
      headers: {
        "X-BGOS-Pairing": cfg.pairingToken,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });
    this.http.interceptors.response.use(
      (r) => r,
      (err) => {
        if (err?.response?.status === 401) {
          return Promise.reject(
            new PairingRevokedError(
              err.response?.data?.message ?? "pairing rejected by BGOS",
            ),
          );
        }
        return Promise.reject(err);
      },
    );
  }

  /** Internal tool transport. Paths are constructed by our handlers, never supplied by a model. */
  async agentRequest(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    assistantId: number,
    body?: unknown,
  ): Promise<any> {
    // Board names are percent-encoded path segments, including Unicode,
    // spaces, uppercase letters and punctuation. Validate route structure
    // without rejecting those legitimate names or permitting an absolute URL.
    const segments = path.split("?", 1)[0]!.split("/");
    let unsafeSegment = false;
    try {
      unsafeSegment = segments.some((segment) => {
        const decoded = decodeURIComponent(segment);
        return (
          /[\\\x00-\x1f\x7f]/.test(decoded) ||
          decoded.split("/").some((part) => part === "." || part === "..")
        );
      });
    } catch {
      unsafeSegment = true;
    }
    if (
      !/^[a-z][a-z0-9_.~!'()*%/-]*(?:\?[^#\r\n]*)?$/i.test(path) ||
      unsafeSegment
    )
      throw new Error("Invalid HOAI tool route");
    const response = await this.http.request({
      method,
      url: path,
      data: body,
      headers: { "X-Caller-Assistant-Id": String(assistantId) },
      timeout: 55_000,
      maxContentLength: 8 * 1024 * 1024,
    });
    return response.data;
  }

  /** GET /integrations/me - confirms token + touches last_seen_at.
   *  Includes assistant→agent_route bindings so the plugin can seed
   *  its dispatch map on cold start.
   */
  async whoami(): Promise<{
    pairing_id: number;
    user_id: string;
    device_label: string;
    integration: string;
    assistants?: Array<{
      assistant_id: number;
      agent_route: string | null;
      name: string;
      /** Count of slash-commands currently set; lets callers decide
       *  whether to seed defaults without a second round-trip. */
      command_count?: number;
    }>;
  }> {
    const r = await this.http.get("integrations/me");
    return r.data;
  }

  /**
   * Fetch the served capability canon for this channel (capability bootstrap).
   * The backend owns the machine-readable canon and serves a per-channel
   * payload; the daemon injects the returned `text` into the Codex agent's
   * AGENTS.md at connect, falling back to the bundled copy when this is
   * unreachable. GET is pairing-token authed like every other method here.
   *
   * `text` is header + shared core + the codex channel delta, ready to inject.
   * Any non-2xx (including a 404 from an older backend that predates the
   * endpoint) throws, and the caller keeps the bundled fallback.
   */
  async getCapabilities(
    channel = "codex",
    daemonVersion?: string,
  ): Promise<{
    channel: string;
    version: string;
    text: string;
    core: string;
    channelSyntax: string;
  }> {
    // SECURITY: cap the response size at the transport layer. The canon is a
    // few KB and is written to AGENTS.md for a shell-capable agent, so a
    // compromised or MITM'd backend must not be able to stream a giant body
    // (disk/memory DoS). axios rejects past maxContentLength and the caller
    // keeps the bundled fallback.
    const r = await this.http.get("integrations/capabilities", {
      params: { channel, ...(daemonVersion ? { daemonVersion } : {}) },
      maxContentLength: 1024 * 1024,
      maxBodyLength: 1024 * 1024,
    });
    return r.data;
  }

  /** Pair exchange (Public; does NOT need X-BGOS-Pairing). */
  static async pairExchange(
    baseUrl: string,
    params: {
      code: string;
      deviceLabel: string;
      agentCatalog?: AgentCatalogEntry[];
      /**
       * Channel label persisted on the pairing row. MUST be `'codex'` for
       * Codex pairings - without it, the backend falls back to `'openclaw'`
       * and the pairing surfaces under the OpenClaw card with assistants
       * created as code='openclaw' (wrong UI gates, wrong slash picker).
       */
      integration?: string;
      /** Daemon version stamped on the pairing row (contract C1). */
      daemonVersion?: string;
      intended_assistant_id?: number;
    },
  ): Promise<PairExchangeResponse> {
    const base = baseUrl.replace(/\/+$/, "") + "/api/v1";
    const r = await axios.post(`${base}/integrations/pair-exchange`, params, {
      timeout: 15_000,
    });
    return r.data;
  }

  /** Plugin pushes (or updates) the agent catalog for this pairing. */
  async pushAgentCatalog(
    pairingId: number,
    agents: AgentCatalogEntry[],
  ): Promise<void> {
    await this.http.post(`integrations/pairings/${pairingId}/agent-catalog`, {
      agents,
    });
  }

  /** Plugin replaces the slash-command manifest for a single bound assistant. */
  async putCommands(
    assistantId: number,
    commands: CommandManifestEntry[],
  ): Promise<void> {
    await this.http.put(`integrations/assistants/${assistantId}/commands`, {
      commands,
    });
  }

  /**
   * Replace the live Steps snapshot for one of this pairing's chats: the
   * agent's own to do list for the reply it is working on. Sent whole on
   * every write, an empty list clears it. Additive route: an older backend
   * answers 404, and callers must treat any failure as non-fatal (a step
   * list may never break a turn). It can never touch the chat's mission.
   */
  async replaceSteps(
    assistantId: number,
    chatId: number,
    body: ReplaceStepsBody,
    options?: { timeout?: number },
  ): Promise<void> {
    await this.http.put(
      `integrations/assistants/${assistantId}/chats/${chatId}/steps`,
      body,
      options,
    );
  }

  async mergeCommands(
    assistantId: number,
    commands: CommandManifestEntry[],
  ): Promise<void> {
    await this.http.post(
      `integrations/assistants/${assistantId}/commands/merge`,
      { commands },
    );
  }

  /** REST backfill after a WS reconnect. */
  async inboundSince(sinceMessageId: number): Promise<{
    messages: InboundMessagePayload[];
  }> {
    const r = await this.http.get("integrations/inbound", {
      params: { since_message_id: sinceMessageId },
    });
    return r.data;
  }

  /** Fetch the recent message history for a chat - used by the daemon to
   *  rebuild conversation context before dispatching to a stateless
   *  gateway. Backend returns up to 100 entries ASC by created_at. */
  async getMessages(
    chatId: number,
    userId: string,
  ): Promise<BgosMessageEnvelope[]> {
    const r = await this.http.get(`chats/${chatId}/messages`, {
      params: { userId },
    });
    const rows = r.data?.messages;
    return Array.isArray(rows) ? (rows as BgosMessageEnvelope[]) : [];
  }

  /**
   * Self-resolve (or create) this assistant's primary BGOS delivery chat -
   * the target for proactive / check-in sends when no `CODEX_BGOS_CHAT_ID`
   * env override is set (parity root cause D). Pairing-token auth only (the
   * pairing must own the assistant; the backend enforces this).
   *
   * `POST /integrations/assistants/:assistantId/primary-chat` (no body). The
   * backend resolves the assistant's `primaryChatId`, else the newest
   * `kind='main'` chat, else creates a fresh main chat (pinning only on a
   * fresh create). Response is `{ chat_id: number }`.
   *
   * Throws on any non-2xx or a malformed response - the caller (proactive
   * `loadTargets`) treats a throw as "skip this assistant".
   */
  async getOrCreatePrimaryChat(assistantId: number): Promise<number> {
    const r = await this.http.post(
      `integrations/assistants/${assistantId}/primary-chat`,
      {},
    );
    const chatId = (r.data as { chat_id?: number } | null)?.chat_id;
    if (typeof chatId !== "number" || !Number.isFinite(chatId) || chatId <= 0) {
      throw new Error(
        `primary-chat endpoint returned no chat_id for assistant ${assistantId}`,
      );
    }
    return chatId;
  }

  /** Agent reply - assistant message with optional inline buttons/approval. */
  async postMessage(payload: OutboundMessagePayload): Promise<{ id: number }> {
    const r = await this.http.post("messages", payload);
    return r.data;
  }

  /**
   * Agent reply via `POST /api/v1/send-message` - the SAME wire payload as
   * `postMessage`, but the endpoint the backend runs its peer-reply bridge
   * (`bridgePeerReplyIfApplicable`) on. For an a2a side-thread chat that
   * bridge stamps `peer_conversation_id` on the reply, which is what
   * resolves the initiating peer's `wait_for_reply`. `/messages` has no
   * such bridge, so peer replies sent there never resolve the wait - hence
   * a dedicated method (see inbound-handler.ts; reference impl
   * bgos-claude-plugin/server.ts uses `bgosPost('send-message', …)`).
   *
   * Response shape differs from `/messages`: the controller returns the
   * created message nested under `message` (HTTP 200) rather than a bare
   * `{ id }` (HTTP 201), so unwrap both shapes.
   */
  async sendMessage(payload: OutboundMessagePayload): Promise<{ id: number }> {
    const r = await this.http.post("send-message", payload);
    const data = (r.data ?? {}) as {
      id?: number;
      message?: { id?: number };
    };
    return { id: data.message?.id ?? data.id ?? 0 };
  }

  /**
   * PATCH an existing message. Used by the tool_progress card flow to
   * update a card in place - adding new tools as they fire, transitioning
   * state running → done at end-of-turn.
   *
   * The backend (BGOS PR #200, deployed 2026-05-16) auto-fills userId from
   * the authenticated principal when omitted from the body. We always omit
   * it from this client - pairing auth on the request itself carries the
   * identity. Returns the updated message dto.
   */
  async patchMessage(
    messageId: number,
    payload: {
      text?: string;
      toolProgress?: {
        state: "running" | "done";
        tools: Array<{
          icon: string;
          name: string;
          args?: string;
          status: "running" | "done" | "error";
        }>;
      };
    },
  ): Promise<{ id: number }> {
    const r = await this.http.patch(`messages/${messageId}`, payload);
    return r.data;
  }

  /** Create a host-derived or self-reported mission for one assistant. */
  async createMission(
    assistantId: number,
    body: CreateMissionInput,
  ): Promise<MissionSnapshot> {
    const r = await this.http.post(
      `integrations/assistants/${assistantId}/missions`,
      body,
    );
    return r.data.mission;
  }

  /** Fetch the assistant's current open mission, if any. */
  async getActiveMission(assistantId: number): Promise<MissionSnapshot | null> {
    const r = await this.http.get(
      `integrations/assistants/${assistantId}/missions/active`,
    );
    return r.data?.mission ?? null;
  }

  /** Replace mission progress and optionally append one feed entry. */
  async patchMissionProgress(
    assistantId: number,
    missionId: number,
    body: PatchMissionProgressInput,
  ): Promise<MissionSnapshot> {
    const r = await this.http.patch(
      `integrations/assistants/${assistantId}/missions/${missionId}/progress`,
      body,
    );
    return r.data.mission;
  }

  /** Mark a mission completed with an optional final summary. */
  async completeMission(
    assistantId: number,
    missionId: number,
    body: { summary?: string } = {},
  ): Promise<MissionSnapshot> {
    const r = await this.http.patch(
      `integrations/assistants/${assistantId}/missions/${missionId}/complete`,
      body,
    );
    return r.data.mission;
  }

  /** Mark a mission failed with an optional error summary. */
  async failMission(
    assistantId: number,
    missionId: number,
    body: { summary?: string } = {},
    options?: { timeout?: number },
  ): Promise<MissionSnapshot> {
    const r = await this.http.patch(
      `integrations/assistants/${assistantId}/missions/${missionId}/fail`,
      body,
      options,
    );
    return r.data.mission;
  }

  /** Request a presigned PUT for a file ≥500 KB that the agent wants to send.
   *
   * Route is `POST /api/v1/files/upload-url` (FileController) - NOT under
   * `/integrations/`; the old `integrations/files/upload-url` path 404'd,
   * silently breaking every ≥500 KB media send. The request DTO is camelCase
   * `{ fileName, contentType, size }` and the response is `{ uploadUrl, key }`
   * - both diverged from the snake_case shape this client used. We send the
   * right keys and normalize the response to the `{ upload_url, s3_key }`
   * shape `publishMediaPath` consumes. */
  async createUploadUrl(params: {
    filename: string;
    mimeType: string;
    size: number;
  }): Promise<{
    upload_url: string;
    s3_key: string;
  }> {
    const r = await this.http.post("files/upload-url", {
      fileName: params.filename,
      contentType: params.mimeType,
      size: params.size,
    });
    return { upload_url: r.data.uploadUrl, s3_key: r.data.key };
  }

  /** List this pairing's active/paired state. Mostly used in setup wizard. */
  async listPairings(): Promise<IntegrationPairing[]> {
    const r = await this.http.get("integrations/pairings");
    return r.data;
  }

  /**
   * POST a liveness heartbeat (contract C1). Pairing-token auth only. The
   * backend touches last_seen_at + records daemon_version / last_error_*.
   * Additive: older backends 404 this route; callers must treat any failure
   * as non-fatal (the HeartbeatController swallows it).
   */
  async postHeartbeat(body: HeartbeatDto): Promise<void> {
    await this.http.post("integrations/heartbeat", body);
  }

  /**
   * Set (or clear) an assistant's status line (contract C4). PATCHes the
   * pairing-scoped `/integrations/assistants/:assistantId/status`. Pass an
   * empty string to clear. Fail-open at the call site (fork throttles + never
   * lets a status write suppress a reply).
   */
  async setStatus(
    assistantId: number,
    body: { statusText: string | null; statusEmoji?: string | null },
  ): Promise<void> {
    await this.http.patch(
      `integrations/assistants/${assistantId}/status`,
      body,
    );
  }

  /**
   * Swap the pairing token (and optionally base URL) in place after a token
   * rotation, so existing references (outbound, tool-progress) keep working
   * without a rebuild. Used by the adapter's re-pair recovery path.
   */
  updateToken(token: string, baseUrl?: string): void {
    const headers = this.http.defaults.headers as unknown as {
      common: Record<string, unknown>;
      [k: string]: unknown;
    };
    headers.common["X-BGOS-Pairing"] = token;
    headers["X-BGOS-Pairing"] = token;
    if (baseUrl) {
      this.http.defaults.baseURL = baseUrl.replace(/\/+$/, "") + "/api/v1";
    }
  }

  // -------------------------------------------------------------------
  // Native voice control plane (voice_rpc - see voice-rpc.ts)
  // -------------------------------------------------------------------

  /** ACK a voice_rpc frame - cancels the backend's 1.5 s retry-emit.
   *  Best-effort; callers must treat a failure as non-fatal. */
  async postVoiceRpcAck(rpcId: string): Promise<unknown> {
    const r = await this.http.post(
      `integrations/voice-rpc/${encodeURIComponent(rpcId)}/ack`,
      {},
    );
    return r.data;
  }

  /** Settle a voice_rpc op (mint / consult / dispatch-accept). The backend
   *  drops results that arrive after its own per-op deadline, so callers
   *  keep their inner caps strictly under it (see voice-rpc.ts). */
  async postVoiceRpcResult(
    rpcId: string,
    body: VoiceRpcResultBody,
  ): Promise<unknown> {
    const r = await this.http.post(
      `integrations/voice-rpc/${encodeURIComponent(rpcId)}/result`,
      body,
    );
    return r.data;
  }

  /** Report the outcome of a detached voice dispatch - flips the durable
   *  voice_tasks row and fans `voice_task_update` to the user's devices. */
  async postVoiceTaskResult(
    taskId: string,
    body: VoiceRpcResultBody,
  ): Promise<unknown> {
    const r = await this.http.post(
      `integrations/voice-tasks/${encodeURIComponent(taskId)}/result`,
      body,
    );
    return r.data;
  }

  /** ACK a skills_rpc frame. */
  async skillsRpcAck(rpcId: string): Promise<unknown> {
    const r = await this.http.post(
      `integrations/skills-rpc/${encodeURIComponent(rpcId)}/ack`,
      {},
      { timeout: SKILLS_RPC_POST_TIMEOUT_MS },
    );
    return r.data;
  }

  /** Report progress for a skills_rpc install operation. */
  async skillsRpcProgress(
    rpcId: string,
    body: { stage: string; detail?: string },
  ): Promise<unknown> {
    const r = await this.http.post(
      `integrations/skills-rpc/${encodeURIComponent(rpcId)}/progress`,
      body,
      { timeout: SKILLS_RPC_POST_TIMEOUT_MS },
    );
    return r.data;
  }

  /** Settle a skills_rpc operation. */
  async skillsRpcResult(
    rpcId: string,
    body: {
      ok: boolean;
      payload?: Record<string, unknown>;
      error?: { code: string; message: string };
    },
  ): Promise<unknown> {
    const r = await this.http.post(
      `integrations/skills-rpc/${encodeURIComponent(rpcId)}/result`,
      body,
      { timeout: SKILLS_RPC_POST_TIMEOUT_MS },
    );
    return r.data;
  }
}
