/**
 * Main adapter for the Codex <-> BGOS channel.
 *
 * Lifecycle mirrors the proven Gobot/OpenClaw shape:
 *   1. Wire WS handlers, connect the socket, start the heartbeat.
 *   2. Resolve identity (whoami) with forever exp-backoff retry; stay UP even if
 *      identity is not yet resolvable.
 *   3. Run the initial backfill after the first identity success (cold-start
 *      seed), then start the 5s poll loop + the 60s outbox replay loop.
 *   4. Inbound messages flow through inbound-handler.ts into codexDispatch,
 *      which drives the Codex SDK and posts the reply + tool_progress.
 *   5. On token revoke/rotate enter a fatal latch and watch the secrets dir to
 *      self-recover when a new token is applied.
 */
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "./bgos-api.js";
import { BgosWs } from "./bgos-ws.js";
import { BgosOutbound } from "./outbound.js";
import { CommandsSync } from "./commands-sync.js";
import { CommandUpgrade } from "./command-upgrade.js";
import { ToolProgressOrchestrator } from "./tool-progress.js";
import { MissionControlLane } from "./mission-control.js";
import { MissionLane, type MissionTurnToken } from "./mission-lane.js";
import { abortCauseOf, abortWith, missionAbortOutcome } from "./abort-cause.js";
import {
  LIST_SESSIONS,
  RENAME_SESSION,
  RESUME_SESSION,
  SESSION_ID_PATTERN,
  SESSION_QUERY_MAX,
  SESSION_RENAME_MAX,
  SESSIONS_LIST_MAX,
  STOP_CONFIRMATION_HARD,
  type ListSessionsAnswer,
  type RenameSessionAnswer,
  type ResumeSessionAnswer,
  type SessionRow,
} from "./session-controls-contract.js";
import { GoalLane } from "./goal-lane.js";
import { StepsLane, stepsChatKindAdmits } from "./steps-lane.js";
import { MeetingLane } from "./meeting-lane.js";
import { TaskJournal, type TaskResult } from "./task-journal.js";
import { HeartbeatController } from "./heartbeat.js";
import { getPackageVersion } from "./version.js";
import { syncCatalog, type CatalogAgent } from "./catalog-sync.js";
import {
  DEFAULT_COMMANDS,
  resolveCommandSeedMode,
  shouldSeedDefaults,
  type CommandSeedMode,
} from "./default-commands.js";
import {
  buildReplyHandle,
  createInboundHandler,
  type DispatchArgs,
  type DispatchFn,
  type ReplyHandle,
} from "./inbound-handler.js";
import { pendingUnknownStats } from "./pending-unknown-store.js";
import { pickCapabilitiesText } from "./capabilities.js";
import {
  CodexHost,
  ControlRefusal,
  type AdoptedTurn,
  type RunTurnResult,
  type SavedThread,
} from "./codex-host.js";
import type { RpcObject } from "./app-server.js";
import {
  markerEventBody,
  type ActivityMarker,
} from "./activity-markers.js";
import type { BrowserRelayCredentials } from "./browser-mcp.js";
import { HOAI_TOOLS, HoaiTools, type ToolContext } from "./hoai-tools.js";
import { BGOS_AGENT_HINTS } from "./agent-hints.js";
import { DECLARED_CAPABILITIES } from "./declared-capabilities.js";
import { unescapeButton } from "./interactions.js";
import type { VoiceRpcFrame, VoiceRpcResultBody } from "./voice-rpc.js";
import { VoiceRpcHandler } from "./hoai-shared/voice-rpc.js";
import { buildCodexInput, type InboundFileForCodex } from "./inbound-input.js";
import { characterCount } from "./clip-text.js";
import { parseReply } from "./reply-markers.js";
import { createSkillsHandler } from "./skills-handler.js";
import type { AuthResolutionOk } from "./auth-mode.js";
import type { Input } from "@openai/codex-sdk";
import {
  NativeCommands,
  RESUMED_SAVED_CONVERSATION,
  parseNativeCommand,
  normalizeNativeCommand,
  type NativeRunOptions,
} from "./native-commands.js";
import {
  PairingRevokedError,
  type AssistantBoundPayload,
  type AssistantUnboundPayload,
  type InboundClickPayload,
  type PairingRevokedPayload,
  type PluginConfig,
} from "./types.js";

const LOG = "[codex-channel-bgos]";

function promptTextFromInput(input: Input): string {
  if (typeof input === "string") return input;
  return input.find((part) => part.type === "text")?.text ?? "";
}

/**
 * Is this turn a person coming back to the chat (P6 stage 3, D11)? A typed
 * message, the Resume sentence, an owner slash command that starts a turn,
 * a button they clicked. Never a scheduled wake (sender system), a peer
 * agent's message or side thread, or a meeting turn; a goal's continuation
 * turn never reaches executeAndReply at all. A turn with no person on it is
 * not one: only the owner coming back resumes a mission their Stop paused.
 */
function isOwnerAuthoredTurn(source?: Partial<DispatchArgs>): boolean {
  if (!source || typeof source.userId !== "string" || !source.userId) return false;
  if (source.senderType === "agent" || source.senderType === "system") return false;
  if (source.peerConversationId) return false;
  return source.chatKind !== "meeting";
}

/*
 * The Sessions ops' payloads (P6 stage 3, spec 5.5), read against the
 * contract file's limits. The backend validates first; these are the
 * daemon's own check on a frame that crossed a machine boundary, and each
 * refusal is the contract's `invalid`.
 */

/** The chat a Sessions op is about. */
function sessionChatOf(chatId: number): number {
  if (!Number.isSafeInteger(chatId) || chatId <= 0)
    throw new ControlRefusal("invalid", "No chat was given for this session request.");
  return chatId;
}

/** `list_sessions`' optional search, trimmed, at most SESSION_QUERY_MAX characters. */
function sessionQueryOf(payload: Record<string, unknown>): string | undefined {
  const query = payload.query;
  if (query === undefined || query === null) return undefined;
  if (typeof query !== "string")
    throw new ControlRefusal("invalid", "A session search must be text.");
  const trimmed = query.trim();
  if (characterCount(trimmed) > SESSION_QUERY_MAX)
    throw new ControlRefusal(
      "invalid",
      `A session search holds at most ${SESSION_QUERY_MAX} characters.`,
    );
  return trimmed || undefined;
}

/** At most SESSIONS_LIST_MAX rows, whatever the frame asks for. */
function sessionLimitOf(payload: Record<string, unknown>): number {
  const limit = payload.limit;
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1
    ? Math.min(limit, SESSIONS_LIST_MAX)
    : SESSIONS_LIST_MAX;
}

/** A session id, as this daemon lists it and the app sends it back. */
function sessionIdOf(payload: Record<string, unknown>): string {
  const id = payload.sessionId;
  if (typeof id !== "string" || !SESSION_ID_PATTERN.test(id))
    throw new ControlRefusal("invalid", "That is not a session id.");
  return id;
}

/** A new name: 1 to SESSION_RENAME_MAX characters after trimming, one line, no control characters. */
function sessionTitleOf(payload: Record<string, unknown>): string {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (
    !title ||
    characterCount(title) > SESSION_RENAME_MAX ||
    /[\u0000-\u001f\u007f]/.test(title)
  )
    throw new ControlRefusal(
      "invalid",
      `A session name needs 1 to ${SESSION_RENAME_MAX} characters on one line.`,
    );
  return title;
}

/** A saved thread as a list answer's row. Codex titles are not withheld: every thread was fed from this HOAI chat (D24). */
function sessionRowOf(thread: SavedThread): SessionRow {
  return {
    id: thread.id,
    title: thread.name,
    preview: thread.preview,
    lastActivityAt: thread.lastActivityAt,
    branch: thread.branch,
    current: thread.current,
  };
}

export interface FatalInfo {
  code: string;
  message: string;
  reason: string;
}

export interface CodexAdapterOptions {
  /** Agent catalog to push on connect (defaults to a single "codex" agent). */
  agents?: CatalogAgent[];
  /** Model override (CODEX_BGOS_MODEL). */
  model?: string;
  commandSeedMode?: CommandSeedMode;
  onFatal?: (info: FatalInfo) => void;
}

export class CodexAdapter {
  readonly api: BgosApi;
  readonly outbound: BgosOutbound;
  readonly commandsSync: CommandsSync;
  readonly toolProgress: ToolProgressOrchestrator;
  readonly missionLane: MissionLane;
  /** The owner's Keep working, carried out as the runtime's own thread goal. */
  readonly goalLane: GoalLane;
  /** The owner's mission decisions, relayed to the model in band. */
  readonly missionControl: MissionControlLane;
  /** The live Steps list for the reply in flight. Never touches a mission. */
  readonly stepsLane: StepsLane;

  private readonly cfg: PluginConfig;
  private readonly ws: BgosWs;
  private readonly skillsHandler: ReturnType<typeof createSkillsHandler>;
  private readonly heartbeat: HeartbeatController;
  private readonly host: CodexHost;
  private readonly tools: HoaiTools;
  private readonly meetings: MeetingLane;
  private readonly turnControllers = new Map<number, Set<AbortController>>();
  private capabilityText = BGOS_AGENT_HINTS;
  private ownerId = "";
  private readonly rpcSeen = new Set<string>();
  private readonly voiceTasks = new Map<string, AbortController>();
  private readonly voiceJournal: TaskJournal;
  private readonly mintHandlers = new Map<number, VoiceRpcHandler>();
  private readonly replyQueues = new Map<number, Promise<void>>();
  private readonly generations = new Map<number, number>();
  private readonly assistantToRoute = new Map<number, string>();
  /**
   * Which assistant a chat belongs to, learned from the events that carry both
   * ids. The Agent Browser relay needs it: the backend requires the assistant
   * id on every relayed MCP call, and a thread only knows its chat.
   */
  private readonly chatToAssistant = new Map<number, number>();
  private readonly lastInput = new Map<number, Input>();
  private readonly lastNativeOptions = new Map<number, NativeRunOptions>();
  private readonly nativeCommands: NativeCommands;
  private readonly dispatch: DispatchFn;
  private catalog: CatalogAgent[];
  private commandSeedModeOverride: CommandSeedMode | null;
  private pairingId: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private spoolTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  private readonly onFatal?: (info: FatalInfo) => void;

  private identityReady = false;
  private capabilitiesLoaded = false;
  private identityRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollStarted = false;
  private lastScopeRefreshAt = 0;
  private scopeRefreshInFlight: Promise<void> | null = null;

  private currentToken: string;
  private fatalLatched = false;
  private fatalNotified = false;
  private last401LogAt = 0;
  private secretsWatcher: FSWatcher | null = null;
  private secretsStatTimer: ReturnType<typeof setInterval> | null = null;
  private secretsDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    cfg: PluginConfig,
    auth: AuthResolutionOk,
    opts: CodexAdapterOptions = {},
  ) {
    this.cfg = cfg;
    this.currentToken = cfg.pairingToken;
    this.api = new BgosApi(cfg);
    this.skillsHandler = createSkillsHandler({ api: this.api });
    this.ws = new BgosWs(cfg, this.api);
    this.outbound = new BgosOutbound(this.api);
    this.commandsSync = new CommandsSync(this.api);
    this.toolProgress = new ToolProgressOrchestrator(this.api);
    this.missionLane = new MissionLane(this.api, {
      // A backend older than stage 5 sends no `cleared_by`, so the control
      // lane needs its own record of what this daemon wrote to tell its own
      // turn end completion apart from the owner marking a mission done.
      onSelfWrite: (missionId) => this.missionControl.noteSelfWrite(missionId),
      // A chat whose work is a native goal already has a mission. Without
      // this the first plan of the goal's own first turn would create a
      // SECOND derived mission for one piece of work.
      goalOwnsChat: (chatId) => this.goalLane.owns(chatId),
      // An owner Stop holds the chat's native goal before it pauses the
      // mission, so no continuation turn starts ahead of the mission_paused
      // echo; the owner's next turn gives it back (P6 stage 3, C-32).
      pauseGoalForChat: (chatId) => this.goalLane.pauseForChat(chatId),
      resumeGoalForMission: (missionId) => this.goalLane.noteResumed(missionId),
    });
    this.goalLane = new GoalLane({
      api: this.api,
      host: {
        setGoal: (chatId, objective, opts) =>
          this.host.setGoal(chatId, objective, opts),
        clearGoal: (chatId) => this.host.clearGoal(chatId),
        // A goal lives on a thread, so a chat with none carries none. Asked
        // before every frame driven control, so a control can never CREATE
        // the thread it was only supposed to act on.
        hasThread: (chatId) => this.host.hasThread(chatId),
      },
      // Same reason the plan lane stamps: this lane completes missions
      // itself, and an unstamped completion comes back from a backend with no
      // `cleared_by` looking like the owner marking the mission done.
      onSelfWrite: (missionId) => this.missionControl.noteSelfWrite(missionId),
      log: (message) => console.warn(`${LOG} ${message}`),
    });
    this.missionControl = new MissionControlLane({
      host: { steer: (chatId, text) => this.host.steer(chatId, text) },
      missionLane: this.missionLane,
      // Pause, Resume, Set aside, Mark done and "Give it 10 more turns" reach
      // the runtime's own goal here, not only the model.
      goalLane: this.goalLane,
      // Arming a goal starts the chat's thread, and the thread's config names
      // the agent, so the pair is recorded before the arm. A mission started
      // from the app is often the FIRST thing this process ever hears about
      // that chat, which is exactly when the answer would otherwise be null.
      noteChat: (chatId, assistantId) =>
        this.noteChatAssistant(chatId, assistantId),
      chatsForAssistant: (assistantId) =>
        [...this.chatToAssistant.entries()]
          .filter(([, owner]) => owner === assistantId)
          .map(([chatId]) => chatId),
      isOwned: (assistantId) => this.ownsAssistantForMission(assistantId),
      log: (message) => console.warn(`${LOG} ${message}`),
    });
    this.stepsLane = new StepsLane(this.api);
    this.host = new CodexHost({
      auth,
      model: opts.model,
      tools: HOAI_TOOLS,
      // The Agent Browser shim reaches the owner's desktop app through HOAI
      // when it is not on this machine, using this daemon's own pairing. Read
      // lazily so a re-pair (recover()) hands the next thread the live token,
      // and per chat so the relayed call names the agent the owner sees in the
      // rail. No known assistant means no relay env at all: the backend
      // requires the id, so an anonymous relay call is a 400 and the shim
      // would silently look offline. Local and offline still work.
      relay: (chatId) => this.browserRelay(chatId),
      // A compaction that arrives between turns (the owner's own /compact)
      // has no turn to hang off, so the host resolves the chat from its
      // thread map and this resolves that chat's assistant.
      onIdleActivityMarker: (chatId, marker) => {
        const assistantId = this.assistantForChat(chatId);
        if (assistantId) void this.postActivityMarker(assistantId, chatId, marker);
      },
      // A goal update arrives between turns far more often than inside one,
      // which is why the host routes it above its own turn guard.
      onGoalUpdate: (chatId, goal) => this.goalLane.handleGoalUpdate(chatId, goal),
      // And the continuation turn itself, which nobody here asked for.
      onAdoptedTurn: (chatId) => this.adoptGoalTurn(chatId),
    });
    // The third argument is not optional in practice: every mission the
    // typed tools write is stamped here, so a backend that sends no
    // `cleared_by` cannot make the agent's own last tick come back looking
    // like its owner marking the mission done.
    this.tools = new HoaiTools(this.api, () => this.capabilityText, {
      starting: (missionId) => this.missionControl.noteSelfWrite(missionId),
      leftOpen: (missionId) => this.missionControl.dropSelfWrite(missionId),
    });
    this.nativeCommands = new NativeCommands({
      host: this.host,
      interactions: this.tools.interactions,
      ownerId: () => this.ownerId,
      status: () => this.statusLine(),
      // `/goal` goes through the lane, never straight to the host: the
      // mission has to exist and the lane has to be watching before the goal
      // is set, because setting one starts a turn at once.
      goalLane: this.goalLane,
      run: async (args, prompt, options = {}) => {
        const files = args.attachments.map((a) => ({
          path: a.localPath,
          mime: a.mimeType,
          name: a.fileName,
          isImage: a.kind === "photo",
        }));
        const input = buildCodexInput(
          `HOAI event: assistant_id=${args.assistantId}, chat_id=${args.chatId}, sender_user_id=${args.senderUserId ?? args.userId}.\n${args.senderGuardrail ?? ""}\n\n${prompt}`,
          files,
        );
        this.lastInput.set(args.chatId, input);
        this.lastNativeOptions.set(args.chatId, options);
        await this.runAndReply(
          args.assistantId,
          args.chatId,
          input,
          args.replyHandle,
          args,
          options,
        );
      },
    });
    this.voiceJournal = new TaskJournal(
      join(
        process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos"),
        "voice-tasks.json",
      ),
    );
    this.meetings = new MeetingLane({
      api: this.api,
      host: this.host,
      tools: this.tools,
      owned: () => [...this.assistantToRoute.keys()],
      owner: () => this.ownerId,
      noteChat: (chatId, assistantId) =>
        this.noteChatAssistant(chatId, assistantId),
      stateFile: join(
        process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos"),
        "meeting-turns.json",
      ),
      log: (error) =>
        console.warn(
          `${LOG} meeting turn: ${error instanceof Error ? error.message : "failed"}`,
        ),
    });
    this.heartbeat = new HeartbeatController({
      version: getPackageVersion(),
      authMode: auth.mode,
      capabilities: DECLARED_CAPABILITIES,
      postHeartbeat: (body) => this.api.postHeartbeat(body),
    });

    this.catalog = opts.agents ?? [{ route: "codex", name: "Codex" }];
    this.commandSeedModeOverride = opts.commandSeedMode ?? null;
    this.onFatal = opts.onFatal;

    this.outbound.setTypingEmitter((p) => this.ws.emitTyping(p));
    this.outbound.setOutboundReporter(() => this.heartbeat.recordOutbound());
    this.outbound.setLastErrorReporter((code, message) =>
      this.heartbeat.setLastError({
        code,
        message,
        at: new Date().toISOString(),
      }),
    );

    this.dispatch = (args) => this.codexDispatch(args);
  }

  get authMode(): "chatgpt" | "apikey" {
    return this.host.authMode;
  }

  private getCommandSeedMode(): CommandSeedMode {
    return this.commandSeedModeOverride ?? resolveCommandSeedMode();
  }

  private getRouteForAssistant(assistantId: number): string | null {
    return this.assistantToRoute.get(assistantId) ?? null;
  }
  /**
   * Remember which agent a chat belongs to, from any event carrying both.
   * Every path that can start a Codex thread calls this before the thread, so
   * even the first browser call in a chat this process has not served yet can
   * name the agent. `test/browser-relay-cold-start.spec.ts` pins that list and
   * fails if a new thread-starting path appears without it.
   */
  private noteChatAssistant(chatId: number, assistantId: number): void {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) return;
    if (!Number.isSafeInteger(assistantId) || assistantId <= 0) return;
    this.chatToAssistant.set(chatId, assistantId);
    // Bounded: one entry per chat this process has actually served, and the
    // oldest go first. The map is a cache, never the source of truth.
    if (this.chatToAssistant.size > 500)
      this.chatToAssistant.delete(this.chatToAssistant.keys().next().value!);
  }
  /**
   * What the Agent Browser shim needs to reach the owner's desktop app as this
   * chat's agent, or null when we cannot name the agent (see relay above).
   */
  private browserRelay(chatId: number): BrowserRelayCredentials | null {
    const assistantId = this.assistantForChat(chatId);
    if (!assistantId) return null;
    return {
      backendUrl: this.cfg.baseUrl,
      pairingToken: this.currentToken,
      assistantId,
    };
  }
  /**
   * The agent a chat belongs to, for the Agent Browser relay. A daemon that
   * owns exactly one assistant needs no event to know the answer; otherwise
   * we only answer for a chat we have actually served, and null (no relay env)
   * is the honest answer rather than guessing the wrong agent.
   *
   * The ownership check has one exception: before the first successful scope
   * load `assistantToRoute` is empty because we do not KNOW what we own, not
   * because we own nothing, and a pair learned from an event the backend
   * routed to this pairing is better evidence than an unloaded map. Once the
   * scope is in, a chat whose assistant we no longer own gets no relay.
   */
  private assistantForChat(chatId: number): number | null {
    const known = this.chatToAssistant.get(chatId);
    if (known && (!this.identityReady || this.getRouteForAssistant(known)))
      return known;
    if (this.assistantToRoute.size === 1)
      return [...this.assistantToRoute.keys()][0];
    return null;
  }

  /**
   * Whether a mission frame for this assistant is ours to act on.
   *
   * Same cold scope exception as above, and for the same reason: before the
   * first successful scope load assistantToRoute is empty because we do not
   * KNOW what we own, not because we own nothing, and a frame the backend
   * routed to this pairing is better evidence than an unloaded map.
   */
  private ownsAssistantForMission(assistantId: number): boolean {
    if (!this.identityReady) return true;
    return this.getRouteForAssistant(assistantId) !== null;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    await this.host.preflight();
    this.started = true;

    const inboundHandler = createInboundHandler({
      outbound: this.outbound,
      getRouteForAssistant: (id) => this.getRouteForAssistant(id),
      getDispatch: () => this.dispatch,
      getSystemPrompt: () => "",
      toolProgress: this.toolProgress,
      onInbound: () => this.heartbeat.recordInbound(),
      onUnknownAssistant: () => this.refreshScopeRateLimited(),
    });

    this.ws.on("inbound_message", (msg) => {
      void inboundHandler(msg);
    });
    this.ws.on("skills_rpc", (frame) => {
      void this.skillsHandler(frame);
    });
    this.ws.on("voice_rpc", (frame) => {
      void this.handleControl(frame);
    });
    this.ws.on("mission_event", (frame) => {
      void this.missionControl.handle(frame);
    });
    this.ws.on("meeting_event", (event) => {
      void (async () => {
        if (!this.identityReady) await this.refreshScopeRateLimited();
        await this.meetings.handle(event);
      })();
    });
    this.ws.on("inbound_click", (click) => this.handleInboundClick(click));
    this.ws.on("assistant_bound", (p: AssistantBoundPayload) => {
      this.assistantToRoute.set(p.assistantId, p.agentRoute);
      void this.seedDefaultCommands(p.assistantId, "bind");
    });
    this.ws.on("assistant_unbound", (p: AssistantUnboundPayload) => {
      this.assistantToRoute.delete(p.assistantId);
    });
    this.ws.on("commands_updated", () => {
      // No-op: user changed commands via the BGOS UI.
    });
    this.ws.on("pairing_revoked", (p: PairingRevokedPayload) => {
      const reason = p.reason === "rotated" ? "rotated" : "revoked";
      const message =
        reason === "rotated" ? "Pairing token rotated" : "Pairing revoked";
      this.enterFatalLatch(reason, message);
    });
    this.ws.on("error", (err) => this.handleWsError(err));
    this.ws.on("connect", () => {
      this.heartbeat.setWsConnected(true, this.ws.connectedSince);
    });
    this.ws.on("disconnect", () => {
      this.heartbeat.setWsConnected(false, null);
    });
    this.ws.on("reconnect", () => {
      void this.onReconnect();
    });
    this.ws.on("backfill_ok", () => {
      const code = this.heartbeat.getLastErrorCode();
      if (code === "backfill_failed" || code === "backfill_storm_skipped") {
        this.heartbeat.setLastError(null);
      }
      this.reconcilePendingUnknownError();
    });
    this.ws.on("backfill_error", (err) => {
      this.heartbeat.setLastError({
        code: "backfill_failed",
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      });
    });
    this.ws.on("backfill_storm", (count) => {
      this.heartbeat.setLastError({
        code: "backfill_storm_skipped",
        message: `skipped ${count} messages`,
        at: new Date().toISOString(),
      });
    });

    await this.ws.connect();
    this.heartbeat.start();

    // Fetch the served capability canon once at connect and inject it into the
    // agent's AGENTS.md (best-effort; falls back to the bundled copy).
    void this.loadServedCapabilities();

    const ok = await this.refreshIdentity();
    if (ok) {
      this.identityReady = true;
      await this.ws.triggerBackfill({ initial: true });
      this.startPollLoop();
    } else if (!this.fatalLatched) {
      this.scheduleIdentityRetry(1000);
    }

    this.spoolTimer = setInterval(() => {
      void this.outbound.replaySpool();
    }, 60_000);
    this.spoolTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.nativeCommands.close();
    if (!this.started) return;
    this.started = false;
    this.stopPollLoop();
    if (this.spoolTimer !== null) {
      clearInterval(this.spoolTimer);
      this.spoolTimer = null;
    }
    if (this.identityRetryTimer !== null) {
      clearTimeout(this.identityRetryTimer);
      this.identityRetryTimer = null;
    }
    this.stopSecretsWatch();
    this.meetings.stop();
    for (const controller of this.voiceTasks.values()) controller.abort();
    // Tagged, so the unwind fails the plan's mission with the shutdown's own
    // words; a mission a Stop already paused is left paused by dispose.
    for (const controllers of this.turnControllers.values())
      for (const controller of controllers) abortWith(controller, "shutdown");
    this.host.close();
    this.heartbeat.stop();
    this.ws.disconnect();
    this.toolProgress.dispose();
    this.missionControl.dispose();
    // Forgets every goal and closes NOTHING: a thread goal lives in the
    // runtime's own store and keeps going without this daemon, so the mission
    // behind it is still true when the daemon comes back.
    this.goalLane.dispose();
    await this.missionLane.dispose();
    await this.stepsLane?.dispose();
    try {
      await this.commandsSync.flushAll();
    } catch {
      /* best-effort on shutdown */
    }
  }

  // -------------------------------------------------------------------
  // Capability bootstrap (fetch-on-connect)
  // -------------------------------------------------------------------

  /**
   * Fetch the served capability canon once and inject it into the Codex agent's
   * AGENTS.md, replacing the bundled fallback the host wrote at construction.
   * Never throws: any failure (network, 401, 404 on an old backend, malformed
   * body) leaves the bundled copy in place so the daemon is never blocked on
   * this. Runs once per process (start() is guarded), i.e. once at connect.
   */
  private async loadServedCapabilities(): Promise<void> {
    if (this.capabilitiesLoaded) return;
    this.capabilitiesLoaded = true;
    try {
      const served = await this.api.getCapabilities(
        "codex",
        getPackageVersion(),
      );
      const picked = pickCapabilitiesText(served);
      if (picked.source === "backend") {
        // Older servers describe the SDK-only v1 surface. The local transport
        // contract wins until the version-aware canon is deployed.
        this.capabilityText = `${picked.text}\n\n${BGOS_AGENT_HINTS}`;
        this.host.applyAgentHints(this.capabilityText);
        // eslint-disable-next-line no-console
        console.log(
          `${LOG} capability canon applied version=${served.version} chars=${picked.text.length} source=backend`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `${LOG} served capability canon malformed; keeping bundled fallback`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} capability canon fetch failed; keeping bundled fallback:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -------------------------------------------------------------------
  // Codex dispatch
  // -------------------------------------------------------------------

  private statusLine(): string {
    const wsState = this.ws.connectedSince ? "connected" : "connecting";
    return (
      `Codex daemon online (v${getPackageVersion()}).\n` +
      `Auth: ${this.authMode === "chatgpt" ? "codex login" : "OPENAI_API_KEY"}. ` +
      `Link: ${wsState}. Workspace: ${this.host.workdir}.`
    );
  }

  private async codexDispatch(args: DispatchArgs): Promise<void> {
    if (args.chatKind === "meeting") {
      await this.meetings.inbound(args.chatId, args.assistantId);
      return;
    }
    // BEFORE the native command router, not after it. `/goal <condition>` is
    // answered there and never reaches runAndReply, and the goal it sets is
    // what starts this chat's thread: the thread's config is where the agent
    // is named, so a pair recorded later is recorded too late and every
    // continuation turn the goal runs is dropped for want of an agent.
    this.noteChatAssistant(args.chatId, args.assistantId);
    // A cold/old HOAI command catalog must not turn native controls into model prompts.
    if (
      !args.command &&
      args.senderType !== "agent" &&
      args.senderType !== "system"
    ) {
      args = { ...args, command: parseNativeCommand(args.text) };
    }
    if (args.command)
      args = { ...args, command: normalizeNativeCommand(args.command) };
    const { chatId, assistantId, command, replyHandle } = args;
    if (await this.nativeCommands.handle(args)) return;

    if (
      command &&
      args.senderType !== "agent" &&
      args.senderType !== "system" &&
      ["new", "retry", "status", "stop", "compact"].includes(command.name)
    ) {
      if (command.name === "stop" || command.name === "new") {
        this.nativeCommands.cancel(chatId);
        this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
        // BEFORE the abort: an owner turn racing the unwind waits for the
        // pause, so a quick Resume ends active (P6 stage 3, D11).
        if (command.name === "stop") this.missionLane.noteStopRequested(chatId);
        // /stop is the owner's Stop and pauses the chat's open mission; /new
        // ends the plan's mission, with its own words.
        for (const controller of this.turnControllers.get(chatId) ?? [])
          abortWith(controller, command.name === "stop" ? "owner_stop" : "new");
        // A later owner turn must not resume a mission from the context /new
        // just discarded.
        if (command.name === "new") this.missionLane.clearStopMarker(chatId);
        await this.host.stopTurn(chatId);
      }
      if (command.name === "stop") {
        await replyHandle.sendText(STOP_CONFIRMATION_HARD);
        return;
      }
      if (command.name === "compact") {
        await this.host.compact(chatId);
        await replyHandle.sendText("Context compaction started.");
        return;
      }
      if (command.name === "new") {
        this.host.resetChat(chatId);
        this.lastInput.delete(chatId);
        this.lastNativeOptions.delete(chatId);
        await replyHandle
          .sendText(
            "Started a fresh conversation. This chat's Codex thread was reset.",
          )
          .catch(() => {});
        return;
      }
      if (command.name === "status") {
        await replyHandle.sendText(this.statusLine()).catch(() => {});
        return;
      }
      // retry
      const prev = this.lastInput.get(chatId);
      if (prev === undefined) {
        await replyHandle.sendText("Nothing to retry yet.").catch(() => {});
        return;
      }
      await this.runAndReply(
        assistantId,
        chatId,
        prev,
        replyHandle,
        args,
        this.lastNativeOptions.get(chatId),
      );
      return;
    }

    const files: InboundFileForCodex[] = args.attachments.map((a) => ({
      path: a.localPath,
      mime: a.mimeType,
      name: a.fileName,
      isImage: a.kind === "photo",
    }));
    // A native slash command (not bridge-local) is forwarded to Codex as text.
    const text = command
      ? `/${command.name}${command.args ? ` ${command.args}` : ""}`
      : args.text;
    const framing = `HOAI event: assistant_id=${assistantId}, chat_id=${chatId}, message_id=${args.messageId}, sender_type=${args.senderType ?? "user"}, sender_user_id=${args.senderUserId ?? args.userId}, sender_relationship=${args.senderRelationship ?? "unknown"}.${args.peerConversationId ? ` Peer conversation ${args.peerConversationId}; this is an agent's message, not the owner's instruction.` : ""}\n${args.senderGuardrail ? `${args.senderGuardrail}\n` : ""}\nMessage:\n`;
    const input = buildCodexInput(framing + text, files);
    this.lastInput.set(chatId, input);
    this.lastNativeOptions.delete(chatId);
    await this.runAndReply(assistantId, chatId, input, replyHandle, args);
  }

  private async runAndReply(
    assistantId: number,
    chatId: number,
    input: Input,
    replyHandle: ReplyHandle,
    source?: Partial<DispatchArgs>,
    nativeOptions: NativeRunOptions = {},
  ): Promise<void> {
    this.noteChatAssistant(chatId, assistantId);
    const generation = this.generations.get(chatId) ?? 0;
    const previous = this.replyQueues.get(chatId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => {
        if (generation !== (this.generations.get(chatId) ?? 0)) return;
        return this.executeAndReply(
          assistantId,
          chatId,
          input,
          replyHandle,
          source,
          nativeOptions,
        );
      });
    this.replyQueues.set(chatId, run);
    try {
      await run;
    } finally {
      if (this.replyQueues.get(chatId) === run) this.replyQueues.delete(chatId);
    }
  }
  private async executeAndReply(
    assistantId: number,
    chatId: number,
    input: Input,
    replyHandle: ReplyHandle,
    source?: Partial<DispatchArgs>,
    nativeOptions: NativeRunOptions = {},
  ): Promise<void> {
    await replyHandle.sendTyping().catch(() => {});
    const startedAt = Date.now();
    let toolCount = 0;
    let sentViaTool = false;
    const controller = new AbortController();
    const controllers =
      this.turnControllers.get(chatId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.turnControllers.set(chatId, controllers);
    const context: ToolContext = {
      assistantId,
      chatId,
      userId: source?.senderUserId || source?.userId || this.ownerId,
      readUserId: source?.userId || this.ownerId,
      messageId: source?.messageId,
      peerConversationId: source?.peerConversationId,
      chatKind: source?.chatKind,
      signal: controller.signal,
      onReply: () => {
        sentViaTool = true;
      },
    };
    // Steps live in a DM only: a room, a meeting or an a2a side thread is
    // refused by the backend's write gate, so the lane must never be handed
    // one. An absent kind is a DM (the REST inbound backfill carries none).
    const stepsAdmitted = stepsChatKindAdmits(source?.chatKind);
    // The owner coming back resumes the mission their own Stop paused in this
    // chat, and the first owner turn after a restart asks the server once
    // (P6 stage 3, D11 and D12). Awaited BEFORE beginTurn, so the plan this
    // turn makes lands on the resumed mission. Never throws.
    if (isOwnerAuthoredTurn(source))
      await this.missionLane.noteOwnerTurn(chatId, assistantId);
    const missionTurn = this.missionLane.beginTurn({
      assistantId,
      chatId,
      prompt: promptTextFromInput(input),
    });
    // AFTER beginTurn, never before: beginTurn's prompt feeds titleFromPrompt,
    // which takes the first line, so a bulletin prefixed earlier would title
    // every derived mission "HOAI mission update: ...". And here rather than
    // at compose time, so the note is never baked into `lastInput` and
    // replayed on every /retry.
    const turnInput = this.missionControl.applyBulletin(chatId, input);

    let progressWork = Promise.resolve();
    const seenTools = new Set<string>();
    let result: RunTurnResult;
    try {
      result = await this.host.runTurn(chatId, turnInput, {
        ...nativeOptions,
        signal: controller.signal,
        onRequest: (method, params) =>
          this.tools.handleRequest(method, params, context),
        onUsage: (usage) => this.reportContextPct(assistantId, usage),
        onTool: (card, itemId) => {
          if (!seenTools.has(itemId)) {
            seenTools.add(itemId);
            toolCount += 1;
          }
          // Native tools can complete in parallel. Serialize publication so a
          // completion cannot race the first POST or create duplicate cards.
          progressWork = progressWork
            .then(() =>
              this.toolProgress.sendToolStart({
                assistantId,
                chatId,
                toolName: card.name,
                icon: card.icon,
                args: card.args,
                itemId,
                status: card.status,
                // The stage 4 and stage 7 fields travel exactly as the mapper
                // built them, each only when the event actually carried it.
                // `!== undefined` and never a falsy test: a command that
                // succeeded exits with zero.
                ...(card.kind !== undefined ? { kind: card.kind } : {}),
                ...(card.path !== undefined ? { path: card.path } : {}),
                ...(card.pathCount !== undefined
                  ? { pathCount: card.pathCount }
                  : {}),
                ...(card.detail !== undefined ? { detail: card.detail } : {}),
                ...(card.durationMs !== undefined
                  ? { durationMs: card.durationMs }
                  : {}),
                ...(card.output !== undefined ? { output: card.output } : {}),
                ...(card.exitCode !== undefined
                  ? { exitCode: card.exitCode }
                  : {}),
                ...(card.linesAdded !== undefined
                  ? { linesAdded: card.linesAdded }
                  : {}),
                ...(card.linesRemoved !== undefined
                  ? { linesRemoved: card.linesRemoved }
                  : {}),
                // The stage 8 three, which only a CHILD AGENT's row carries.
                ...(card.id !== undefined ? { id: card.id } : {}),
                ...(card.startedAt !== undefined
                  ? { startedAt: card.startedAt }
                  : {}),
                ...(card.result !== undefined ? { result: card.result } : {}),
              }),
            )
            .catch(() => {});
          return progressWork;
        },
        onTick: () => {
          void replyHandle.sendTyping().catch(() => {});
        },
        onTodoList: (signal) =>
          this.missionLane.handleTodoList({
            chatId,
            turnToken: missionTurn,
            ...signal,
          }),
        // The same plan, statuses intact, as the owner's live Steps. A
        // sibling of the mission lane, never a caller of it.
        // Quiet lines from the agent's own events. Posted INSIDE the turn, so
        // a marker lands before the reply bubble rather than after the card
        // has closed. Never gated by chat kind: the card is not either.
        onActivityMarker: (marker) =>
          this.postActivityMarker(assistantId, chatId, marker),
        onPlan: stepsAdmitted
          ? (signal) =>
              this.stepsLane?.handlePlan({
                assistantId,
                chatId,
                turnId: signal.turnId,
                plan: signal.plan,
              })
          : undefined,
      });
      if (controller.signal.aborted) {
        // Stop already acknowledges in chat. Native interruption may resolve
        // with partial text and an error; neither is a new assistant reply.
        await progressWork;
        await this.settleAbortedMission(
          assistantId,
          chatId,
          missionTurn,
          controller.signal,
        );
        if (stepsAdmitted) await this.stepsLane?.finalizeTurn(chatId);
        await replyHandle.finalizeTurn().catch(() => {});
        return;
      }
    } catch (err) {
      // The abort's cause FIRST. This branch used to fail the mission before
      // it looked at the signal, so an owner Stop that made the runtime throw
      // read Did not finish. An abort is never a failure of its own.
      if (controller.signal.aborted) {
        await this.settleAbortedMission(
          assistantId,
          chatId,
          missionTurn,
          controller.signal,
        );
      } else {
        await this.missionLane.finalizeTurn({
          chatId,
          turnToken: missionTurn,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (stepsAdmitted) await this.stepsLane?.finalizeTurn(chatId);
      if (controller.signal.aborted) {
        await progressWork;
        await replyHandle.finalizeTurn().catch(() => {});
        return;
      }
      throw err;
    } finally {
      controller.abort();
      controllers.delete(controller);
      if (!controllers.size) this.turnControllers.delete(chatId);
    }
    const missionError =
      result.error ??
      (result.turnCompleted
        ? null
        : "Codex turn stream ended without a terminal event");
    await this.missionLane.finalizeTurn({
      chatId,
      turnToken: missionTurn,
      finalText: result.finalAgentMessageText,
      error: missionError,
    });
    if (stepsAdmitted) await this.stepsLane?.finalizeTurn(chatId);
    // eslint-disable-next-line no-console
    console.log(`${LOG} codex turn done`, {
      chatId,
      assistantId,
      tools: toolCount,
      chars: result.replyText.length,
      error: result.error ?? undefined,
      ms: Date.now() - startedAt,
    });

    // The turn's own clock, on its way to the card that is about to close.
    // BEFORE publishTurnResult, because that is where the final PATCH goes
    // out and the final PATCH is the only one that carries it.
    this.noteTurnClock(chatId, result);

    await this.publishTurnResult({
      assistantId,
      chatId,
      replyHandle,
      result,
      sentViaTool,
    });
  }

  /**
   * An aborted turn's mission, by the abort's cause (P6 stage 3, D9). An
   * owner Stop PAUSES it with the contract's reason; /new, a shutdown, a
   * revoked pairing and an untagged abort FAIL it, each with its own words,
   * as an abort always did.
   */
  private async settleAbortedMission(
    assistantId: number,
    chatId: number,
    turnToken: MissionTurnToken,
    signal: AbortSignal,
  ): Promise<void> {
    const outcome = missionAbortOutcome(abortCauseOf(signal));
    if (outcome.kind === "pause") {
      await this.missionLane.stoppedByOwner({ chatId, turnToken, assistantId });
      return;
    }
    await this.missionLane.finalizeTurn({
      chatId,
      turnToken,
      error: outcome.summary,
    });
  }

  /**
   * Hand the card orchestrator the clock the RUNTIME reported for this turn.
   *
   * Both ends or nothing. A turn the owner stopped and a turn the watchdog
   * gave up on carry no clock at all, and leaving the card without minutes is
   * the honest answer there: the app draws every part of the summary line
   * only where its data exists, and it is forbidden from working the minutes
   * out from when a message was created.
   */
  private noteTurnClock(chatId: number, result: RunTurnResult): void {
    // A card that is staying open has no finish yet, and the minutes this
    // turn took are not the minutes the card will end up showing.
    if (result.helpersStillRunning) return;
    const startedAtMs = result.turnStartedAtMs;
    const finishedAtMs = result.turnFinishedAtMs;
    if (typeof startedAtMs !== "number" || typeof finishedAtMs !== "number")
      return;
    this.toolProgress.noteTurnMeta(chatId, { startedAtMs, finishedAtMs });
  }

  /**
   * Put one finished turn into the chat: the status line, the buttons or the
   * questions, the text, the files, and the error when there is one.
   *
   * Extracted so a CONTINUATION turn, which the app server starts by itself
   * while a goal is active, reaches the owner through exactly the same path
   * as a turn they asked for. A second copy of this would be a second place
   * to forget a marker, a file or an error.
   */
  private async publishTurnResult(params: {
    assistantId: number;
    chatId: number;
    replyHandle: ReplyHandle;
    result: RunTurnResult;
    sentViaTool: boolean;
  }): Promise<void> {
    const { assistantId, chatId, replyHandle, result, sentViaTool } = params;
    /**
     * A helper this turn spawned is still working, so the card stays open:
     * the last patch it got said `running` and no later one closes it. A
     * finished card folds, and a helper ticking behind a fold helps nobody.
     *
     * The limit, named rather than papered over: this daemon gets no further
     * notification for a thread whose turn has ended, so a card left open
     * this way carries the helper's last reported state until the model's
     * next turn mentions that child again. Folding over a working helper, or
     * marking a row done that nobody checked, are the two worse answers.
     */
    const helpersStillRunning = result.helpersStillRunning === true;
    if (result.error && !result.replyText.trim()) {
      if (!helpersStillRunning)
        await replyHandle.finalizeTurn().catch(() => {});
      await this.outbound
        .sendAgentError({ assistantId, chatId, reason: result.error })
        .catch(() => {});
      return;
    }

    const parsed = parseReply(result.replyText);

    if (parsed.status) {
      await this.api
        .setStatus(assistantId, { statusText: parsed.status.text || null })
        .catch(() => {});
    }

    const body = parsed.cleanText;
    if (parsed.buttons) {
      await replyHandle
        .sendButtons(body || "Choose an option:", parsed.buttons.options)
        .catch(() => {});
    } else if (parsed.ask) {
      if (body) await replyHandle.sendText(body).catch(() => {});
      for (const q of parsed.ask.questions) {
        await replyHandle
          .sendAskUserInput(q.text, q.options, true)
          .catch(() => {});
      }
    } else if (body) {
      await replyHandle.sendText(body).catch(() => {});
    } else if (parsed.media.length === 0 && !sentViaTool) {
      await replyHandle
        .sendText("(Codex finished the turn without a text reply.)")
        .catch(() => {});
    }

    for (const path of parsed.media) {
      await replyHandle.sendFile(path).catch(() => {});
    }

    if (!helpersStillRunning) await replyHandle.finalizeTurn().catch(() => {});
    if (result.error)
      await this.outbound
        .sendAgentError({ assistantId, chatId, reason: result.error })
        .catch(() => {});
  }

  /**
   * Take ownership of a turn the app server started by itself.
   *
   * While a goal is active the runtime runs continuation turns with nobody
   * asking, and the host offers each one here. Everything the owner sees of
   * that work depends on this: the tool cards, the typing indicator and the
   * reply all ride the same path an ordinary turn takes, or none of it
   * happens at all.
   *
   * Two refusals, both deliberate. A chat the goal lane does not own is left
   * exactly as it is today, which covers the goal an owner set in their own
   * terminal: this daemon did not arm it, has no mission for it, and has no
   * business posting its replies into a chat. And a chat this process cannot
   * place with an assistant is left alone, because a reply needs an agent to
   * come from.
   */
  private adoptGoalTurn(chatId: number): AdoptedTurn | null {
    if (!this.goalLane.owns(chatId)) return null;
    const assistantId = this.assistantForChat(chatId);
    if (!assistantId) return null;
    const replyHandle = buildReplyHandle(
      { outbound: this.outbound, toolProgress: this.toolProgress },
      { assistantId, chatId },
    );
    let sentViaTool = false;
    const context: ToolContext = {
      assistantId,
      chatId,
      // A continuation turn has no sender: the runtime started it, so the
      // owner is the only person it can act for.
      userId: this.ownerId,
      readUserId: this.ownerId,
      signal: new AbortController().signal,
      onReply: () => {
        sentViaTool = true;
      },
    };
    const seenTools = new Set<string>();
    let progressWork = Promise.resolve();
    this.goalLane.noteTurnStarted(chatId);
    return {
      callbacks: {
        onRequest: (method, params) =>
          this.tools.handleRequest(method, params, context),
        // The row fields below are the SAME list as the ordinary turn's call
        // site, 230 lines up. A field spread there and not here is a field
        // missing for the whole of an autonomous goal run, which is exactly
        // the run the owner is least able to watch.
        onTool: (card, itemId) => {
          seenTools.add(itemId);
          progressWork = progressWork
            .then(() =>
              this.toolProgress.sendToolStart({
                assistantId,
                chatId,
                toolName: card.name,
                icon: card.icon,
                args: card.args,
                itemId,
                status: card.status,
                ...(card.kind !== undefined ? { kind: card.kind } : {}),
                ...(card.path !== undefined ? { path: card.path } : {}),
                ...(card.pathCount !== undefined
                  ? { pathCount: card.pathCount }
                  : {}),
                ...(card.detail !== undefined ? { detail: card.detail } : {}),
                ...(card.durationMs !== undefined
                  ? { durationMs: card.durationMs }
                  : {}),
                ...(card.output !== undefined ? { output: card.output } : {}),
                ...(card.exitCode !== undefined
                  ? { exitCode: card.exitCode }
                  : {}),
                ...(card.linesAdded !== undefined
                  ? { linesAdded: card.linesAdded }
                  : {}),
                ...(card.linesRemoved !== undefined
                  ? { linesRemoved: card.linesRemoved }
                  : {}),
                // The stage 8 three, which only a CHILD AGENT's row carries.
                ...(card.id !== undefined ? { id: card.id } : {}),
                ...(card.startedAt !== undefined
                  ? { startedAt: card.startedAt }
                  : {}),
                ...(card.result !== undefined ? { result: card.result } : {}),
              }),
            )
            .catch(() => {});
          return progressWork;
        },
        onTick: () => {
          void replyHandle.sendTyping().catch(() => {});
        },
        onActivityMarker: (marker) =>
          this.postActivityMarker(assistantId, chatId, marker),
        // The same two readers an ordinary turn has. Without them the owner's
        // live Steps stay blank and the context reading stops moving for the
        // whole autonomous run, which is the opposite of what this channel
        // promises: the goal's work reaches the owner between messages
        // exactly as it does inside a turn they asked for.
        onUsage: (usage) => this.reportContextPct(assistantId, usage),
        // A continuation turn carries no chat kind, and an absent kind is a
        // DM, which is the only place the backend accepts Steps. A goal on
        // any other kind of chat is refused once and then left alone by the
        // lane's own permanent 4xx silencing.
        onPlan: (signal) =>
          this.stepsLane?.handlePlan({
            assistantId,
            chatId,
            turnId: signal.turnId,
            plan: signal.plan,
          }),
        // `onTodoList` stays unwired on purpose: the plan lane already stands
        // down for a chat the goal lane owns, and a first plan arriving after
        // the goal ended would make it build a SECOND mission for this work.
      },
      deliver: async (result) => {
        await progressWork;
        // The same clock an ordinary turn notes, in the same place: before
        // this turn's card is closed inside publishTurnResult.
        this.noteTurnClock(chatId, result);
        // Before the reply, exactly where an ordinary turn clears it: a list
        // left behind is the finished turn's plan sitting under the next
        // turn's work, re sent by the lane's keepalive until the backend
        // sweeps it.
        await this.stepsLane?.finalizeTurn(chatId);
        await this.publishTurnResult({
          assistantId,
          chatId,
          replyHandle,
          result,
          sentViaTool,
        });
        // After the reply, never before: the run report is the record of a
        // turn that finished, and the cap is only reached at the end of one.
        await this.goalLane.noteTurnFinished(chatId, {
          text: result.finalAgentMessageText,
          error: result.error,
        });
      },
    };
  }

  /**
   * How full this agent's context window is, from the runtime's own count.
   *
   * Shared by the turn the owner asked for and the continuation turn the app
   * server starts by itself, because the reading is about the THREAD and a
   * goal's turns fill the same window. Best effort: a failed patch is a
   * stale percentage, never a broken turn.
   */
  private reportContextPct(assistantId: number, usage: RpcObject): void {
    const window = Number(usage.modelContextWindow),
      tokens = Number(usage.last?.inputTokens);
    if (!(window > 0) || !(tokens >= 0)) return;
    void this.api
      .agentRequest(
        "PATCH",
        `integrations/assistants/${assistantId}/status`,
        assistantId,
        {
          contextPct: Math.min(
            100,
            Math.max(0, Math.round((tokens / window) * 100)),
          ),
        },
      )
      .catch(() => {});
  }

  /**
   * Post one activity marker as an ordinary `event` message. Best effort by
   * design: a refused marker is a missing line, never a broken turn, so every
   * failure is swallowed the way the other lanes swallow theirs.
   */
  private async postActivityMarker(
    assistantId: number,
    chatId: number,
    marker: ActivityMarker,
  ): Promise<void> {
    const body = markerEventBody(marker, { assistantId, chatId });
    if (!body) return;
    try {
      await this.api.postMessage(body);
    } catch {
      // Swallowed on purpose. See the docblock.
    }
  }

  /**
   * A user tapped an inline button or answered an ask question. Feed the choice
   * back to Codex as the next turn (the thread keeps context), so the agent
   * continues naturally. Correlate by (assistantId, chatId).
   */
  private handleInboundClick(click: InboundClickPayload): void {
    if (this.tools.interactions.handleClick(click)) return;
    const route = this.getRouteForAssistant(click.assistantId);
    if (!route) return;
    const replyHandle = buildReplyHandle(
      { outbound: this.outbound, toolProgress: this.toolProgress },
      { assistantId: click.assistantId, chatId: click.chatId },
    );
    const choice = (click.callbackData ?? "").trim();
    if (!choice || choice === "__skip__") return;
    const text =
      choice === "__custom__"
        ? (click.customText ?? "")
        : `The user selected: ${unescapeButton(choice)}`;
    if (!text) return;
    const input = buildCodexInput(text, []);
    this.lastInput.set(click.chatId, input);
    this.lastNativeOptions.delete(click.chatId);
    void this.runAndReply(click.assistantId, click.chatId, input, replyHandle, {
      userId: click.userId,
    }).catch((error) =>
      this.outbound
        .sendAgentError({
          assistantId: click.assistantId,
          chatId: click.chatId,
          reason:
            error instanceof Error
              ? error.message
              : "Codex could not process the selection.",
        })
        .catch(() => {}),
    );
  }

  /** Control frames are server-issued and pairing-scoped, never inferred from chat text. */
  private async handleControl(frame: VoiceRpcFrame): Promise<void> {
    const assistantId = Number(frame.assistantId),
      chatId = Number(frame.chatId);
    if (!this.getRouteForAssistant(assistantId))
      await this.refreshScopeRateLimited();
    if (
      !this.getRouteForAssistant(assistantId) ||
      (frame.op !== "dispatch" && this.rpcSeen.has(frame.rpcId))
    )
      return;
    this.noteChatAssistant(chatId, assistantId);
    this.rpcSeen.add(frame.rpcId);
    if (this.rpcSeen.size > 1000)
      this.rpcSeen.delete(this.rpcSeen.values().next().value!);
    try {
      await this.api.postVoiceRpcAck(frame.rpcId).catch(() => {});
      if (frame.op === "mint") {
        let handler = this.mintHandlers.get(assistantId);
        if (!handler) {
          handler = new VoiceRpcHandler({
            config: {
              assistantId: String(assistantId),
              openaiApiKey: "",
              model: "gpt-realtime",
              voice: "marin",
              persona: "",
            },
            postAck: (id) => this.api.postVoiceRpcAck(id),
            postResult: (id, body) => this.api.postVoiceRpcResult(id, body),
            notify: async () => {
              throw new Error("Use the Codex control handler for consults.");
            },
            getIdentity: async () => ({
              name: this.catalog[0]?.name ?? "Codex",
              subtitle: "Your Codex agent",
            }),
            log: (message) => console.log(`${LOG} ${message}`),
          });
          this.mintHandlers.set(assistantId, handler);
        }
        await handler.handle({ ...frame, op: "mint" });
        return;
      }
      if (frame.op === "stop_turn") {
        if (!Number.isSafeInteger(chatId) || chatId <= 0)
          throw new Error("No chat to stop.");
        const active = this.turnControllers.get(chatId);
        const stoppedControl = this.nativeCommands.cancel(chatId);
        const stoppedTurn = !!active?.size;
        this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
        // BEFORE the abort: an owner turn racing the unwind waits for the
        // pause, so a quick Resume ends active (P6 stage 3, D11).
        this.missionLane.noteStopRequested(chatId);
        // The owner's Stop: the unwind pauses the chat's open mission with
        // "Stopped by you" instead of failing it.
        for (const controller of active ?? []) abortWith(controller, "owner_stop");
        await this.host.stopTurn(chatId);
        // The stop endpoint is advisory: its RPC result does not reach the
        // chat UI. A reply also settles a pending picker or stale Thinking
        // state when there is no native model turn left to emit completion.
        await this.outbound.sendText({
          assistantId,
          chatId,
          text: STOP_CONFIRMATION_HARD,
        });
        await this.api.postVoiceRpcResult(frame.rpcId, {
          ok: true,
          payload: { stopped: stoppedTurn || stoppedControl, supported: true },
        });
        return;
      }
      // The Sessions sheet (P6 stage 3, spec 5.6): this chat's own threads,
      // the set /resume offers, answered with the contract's shapes and
      // refusal codes.
      if (frame.op === LIST_SESSIONS) {
        await this.answerSessionOp(frame.rpcId, () =>
          this.listSessions(chatId, frame.payload),
        );
        return;
      }
      if (frame.op === RESUME_SESSION) {
        await this.answerSessionOp(frame.rpcId, () =>
          this.resumeSession(assistantId, chatId, frame.payload),
        );
        return;
      }
      if (frame.op === RENAME_SESSION) {
        await this.answerSessionOp(frame.rpcId, () =>
          this.renameSession(chatId, frame.payload),
        );
        return;
      }
      if (frame.op === "cancel") {
        const controller = this.voiceTasks.get(String(frame.payload.taskId));
        controller?.abort();
        await this.api.postVoiceRpcResult(frame.rpcId, {
          ok: true,
          payload: { cancelled: !!controller },
        });
        return;
      }
      if (frame.op === "consult") {
        if (!Number.isSafeInteger(chatId) || chatId <= 0)
          throw new Error("No chat to consult.");
        const args = frame.payload.args as Record<string, unknown>;
        if (!args || typeof args.question !== "string" || !args.question.trim())
          throw new Error("The consult has no question.");
        const result = await this.host.runDetached(
          chatId,
          `Invisible, read-only consult. Do not send messages or call HOAI tools. Return only the answer.\n${String(args.responseStyle ?? "Use 1-3 speakable sentences.")}\n${String(args.context ?? "")}\n${args.question}`,
        );
        if (result.error || !result.replyText.trim())
          throw new Error(result.error ?? "Codex returned no answer.");
        await this.api.postVoiceRpcResult(frame.rpcId, {
          ok: true,
          payload: { text: result.finalAgentMessageText || result.replyText },
        });
        return;
      }
      if (frame.op === "dispatch") {
        const taskId = String(frame.payload.taskId ?? ""),
          args = frame.payload.args as Record<string, unknown>;
        if (
          !taskId ||
          frame.payload.confirmed !== true ||
          !args ||
          typeof args.question !== "string"
        )
          throw new Error("No confirmed voice task was provided.");
        if (this.voiceTasks.has(taskId)) {
          await this.api.postVoiceRpcResult(frame.rpcId, {
            ok: true,
            payload: { accepted: true },
          });
          return;
        }
        const prior = this.voiceJournal.get(taskId);
        if (prior) {
          const result =
            prior.result ??
            this.voiceJournal.complete(taskId, {
              ok: false,
              error: {
                code: "CODEX_INTERRUPTED",
                message:
                  "The agent restarted during this task. Check its result before requesting another run.",
              },
            });
          await this.api.postVoiceTaskResult(taskId, result);
          await this.api.postVoiceRpcResult(frame.rpcId, {
            ok: true,
            payload: { accepted: true },
          });
          return;
        }
        this.voiceJournal.begin(taskId);
        const controller = new AbortController();
        this.voiceTasks.set(taskId, controller);
        await this.api.postVoiceRpcResult(frame.rpcId, {
          ok: true,
          payload: { accepted: true },
        });
        void (async () => {
          let completion: Promise<unknown> | undefined;
          const complete = (result: TaskResult) => {
            if (!completion)
              completion = this.api.postVoiceTaskResult(
                taskId,
                this.voiceJournal.complete(taskId, result),
              );
            return completion;
          };
          try {
            const targetChatId =
              await this.api.getOrCreatePrimaryChat(assistantId);
            this.noteChatAssistant(targetChatId, assistantId);
            const context: ToolContext = {
              assistantId,
              chatId: targetChatId,
              userId: this.ownerId,
              signal: controller.signal,
              voiceTaskId: taskId,
              completeVoiceTask: async (args) => {
                await complete(
                  args.failed
                    ? {
                        ok: false,
                        error: { code: "CODEX_FAILED", message: args.result },
                      }
                    : { ok: true, payload: { text: args.result } },
                );
                return { completed: true };
              },
            };
            const result = await this.host.runDetached(
              targetChatId,
              `Authorized voice task. task_id=${taskId}. Work on the request below. Call complete_voice_task when done or return your final result and the host will report it to the call.\n${String(args.context ?? "")}\n${args.question}`,
              {
                signal: controller.signal,
                onRequest: (method, params) =>
                  this.tools.handleRequest(method, params, context),
              },
              false,
              30 * 60_000,
            );
            await complete(
              result.error
                ? {
                    ok: false,
                    error: { code: "CODEX_FAILED", message: result.error },
                  }
                : {
                    ok: true,
                    payload: {
                      text: result.finalAgentMessageText || result.replyText,
                    },
                  },
            );
          } catch (error) {
            await complete({
              ok: false,
              error: {
                code: "CODEX_FAILED",
                message:
                  error instanceof Error ? error.message : "Task failed.",
              },
            }).catch(() => {});
          } finally {
            controller.abort();
            this.voiceTasks.delete(taskId);
          }
        })();
      }
    } catch (error) {
      await this.api
        .postVoiceRpcResult(frame.rpcId, {
          ok: false,
          error: {
            code: "CODEX_CONTROL_FAILED",
            message:
              error instanceof Error
                ? error.message
                : "Codex could not complete the request.",
          },
        })
        .catch(() => {});
    }
  }

  /**
   * Post a Sessions op's answer: its payload, or its refusal. A host refusal
   * carries the contract's code (busy, not_found, unsupported, invalid);
   * anything else is `failed`, with the sentence the owner would read.
   */
  private async answerSessionOp(
    rpcId: string,
    answer: () => Promise<
      ListSessionsAnswer | ResumeSessionAnswer | RenameSessionAnswer
    >,
  ): Promise<void> {
    let body: VoiceRpcResultBody;
    try {
      body = { ok: true, payload: { ...(await answer()) } };
    } catch (error) {
      body = {
        ok: false,
        error: {
          code: error instanceof ControlRefusal ? error.code : "failed",
          message:
            error instanceof Error
              ? error.message
              : "Codex could not complete the request.",
        },
      };
    }
    await this.api.postVoiceRpcResult(rpcId, body);
  }

  private async listSessions(
    chatId: number,
    payload: Record<string, unknown>,
  ): Promise<ListSessionsAnswer> {
    const chat = sessionChatOf(chatId);
    const query = sessionQueryOf(payload);
    const limit = sessionLimitOf(payload);
    const { threads, truncated } = await this.host.listSavedThreads(chat, query);
    return {
      sessions: threads.slice(0, limit).map(sessionRowOf),
      abilities: this.host.sessionAbilities(),
      truncated: truncated || threads.length > limit,
      runtime: "codex",
    };
  }

  private async resumeSession(
    assistantId: number,
    chatId: number,
    payload: Record<string, unknown>,
  ): Promise<ResumeSessionAnswer> {
    const chat = sessionChatOf(chatId);
    const sessionId = sessionIdOf(payload);
    const thread = await this.host.resumeSavedThread(chat, sessionId);
    // The context a Stop paused belongs to the thread just left, so no later
    // owner turn may resume that mission from it (as on /new, D25).
    this.missionLane.clearStopMarker(chat);
    // /resume's own line. The switch has happened whether or not it posts,
    // so a failed post is logged and never turns the answer into a failure.
    await this.outbound
      .sendText({ assistantId, chatId: chat, text: RESUMED_SAVED_CONVERSATION })
      .catch((error) =>
        console.warn(
          `${LOG} the resume line for chat ${chat} was not posted: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return { resumed: true, sessionId, title: thread.name };
  }

  private async renameSession(
    chatId: number,
    payload: Record<string, unknown>,
  ): Promise<RenameSessionAnswer> {
    const chat = sessionChatOf(chatId);
    const sessionId = sessionIdOf(payload);
    const title = sessionTitleOf(payload);
    const thread = await this.host.renameThread(chat, sessionId, title);
    return { renamed: true, sessionId, title: thread.name };
  }

  // -------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------

  private async refreshIdentity(): Promise<boolean> {
    try {
      const me = await this.api.whoami();
      this.ownerId = me.user_id;
      this.pairingId = me.pairing_id;
      this.heartbeat.setPairingId(this.pairingId);
      this.assistantToRoute.clear();
      const seedMode = this.getCommandSeedMode();
      const emptyManifestAssistantIds: number[] = [];
      for (const a of me.assistants ?? []) {
        if (a.agent_route)
          this.assistantToRoute.set(a.assistant_id, a.agent_route);
        if (shouldSeedDefaults(a.command_count, seedMode)) {
          emptyManifestAssistantIds.push(a.assistant_id);
        }
      }
      if (this.pairingId !== null && this.catalog.length > 0) {
        await syncCatalog(this.api, this.pairingId, this.catalog);
      }
      for (const id of emptyManifestAssistantIds) {
        await this.seedDefaultCommands(id, "startup");
      }
      if (seedMode !== "never") {
        const upgrade = new CommandUpgrade(
          process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos"),
          this.api,
        );
        for (const assistant of me.assistants ?? []) {
          await upgrade
            .apply(
              assistant.assistant_id,
              DEFAULT_COMMANDS.filter(
                (c) =>
                  !["new", "retry", "status", "stop", "compact"].includes(
                    c.command,
                  ),
              ),
            )
            .catch((error) => {
              // Older backends may not yet expose merge. Never fall back to an
              // unconditional replacement of an existing user-edited catalog.
              console.warn(
                `${LOG} command upgrade deferred:`,
                error instanceof Error ? error.message : String(error),
              );
            });
        }
      }
      return true;
    } catch (err) {
      if (err instanceof PairingRevokedError) {
        this.enterFatalLatch("revoked", err.message);
        return false;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} refreshIdentity failed (will retry):`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  private scheduleIdentityRetry(delayMs: number): void {
    if (this.fatalLatched || !this.started) return;
    const jitter = Math.floor((delayMs % 7) * 30);
    this.identityRetryTimer = setTimeout(() => {
      void (async () => {
        if (this.fatalLatched || !this.started) return;
        const ok = await this.refreshIdentity();
        if (ok) {
          this.identityReady = true;
          await this.ws.triggerBackfill({ initial: true });
          this.startPollLoop();
          return;
        }
        if (this.fatalLatched) return;
        this.scheduleIdentityRetry(Math.min(delayMs * 2, 60_000));
      })();
    }, delayMs + jitter);
    this.identityRetryTimer.unref?.();
  }

  private refreshScopeRateLimited(): Promise<void> {
    if (this.scopeRefreshInFlight) return this.scopeRefreshInFlight;
    const now = Date.now();
    if (now - this.lastScopeRefreshAt < 10_000) return Promise.resolve();
    this.lastScopeRefreshAt = now;
    this.scopeRefreshInFlight = this.refreshIdentity()
      .then(() => {})
      .finally(() => {
        this.scopeRefreshInFlight = null;
      });
    return this.scopeRefreshInFlight;
  }

  private reconcilePendingUnknownError(): void {
    const STUCK_MS = 5 * 60_000;
    const stats = pendingUnknownStats();
    const code = this.heartbeat.getLastErrorCode();
    if (stats.count === 0) {
      if (code === "pending_unknown_stuck") this.heartbeat.setLastError(null);
      return;
    }
    if (stats.oldestAt !== null && Date.now() - stats.oldestAt >= STUCK_MS) {
      if (code === null || code === "pending_unknown_stuck") {
        this.heartbeat.setLastError({
          code: "pending_unknown_stuck",
          message: `${stats.count} inbound message(s) await an unbound assistant`,
          at: new Date().toISOString(),
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------

  private startPollLoop(): void {
    if (this.pollStarted || this.fatalLatched) return;
    const raw = process.env.CODEX_BGOS_POLL_INTERVAL;
    const interval = raw !== undefined && raw !== "" ? Number(raw) : 5;
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.pollStarted = true;
    this.pollTimer = setInterval(() => {
      void this.ws.triggerBackfill();
    }, interval * 1000);
    this.pollTimer.unref?.();
  }

  private stopPollLoop(): void {
    this.pollStarted = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async onReconnect(): Promise<void> {
    if (this.fatalLatched) return;
    await this.refreshIdentity();
    await this.ws.triggerBackfill();
    await this.outbound.replaySpool();
  }

  // -------------------------------------------------------------------
  // Fatal latch + re-pair recovery
  // -------------------------------------------------------------------

  private handleWsError(err: Error): void {
    if (err instanceof PairingRevokedError) {
      const now = Date.now();
      if (now - this.last401LogAt >= 60_000) {
        this.last401LogAt = now;
        // eslint-disable-next-line no-console
        console.error(`${LOG} pairing rejected (401):`, err.message);
      }
      this.enterFatalLatch("revoked", err.message);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(
      `${LOG} WS error:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  private enterFatalLatch(
    reason: "revoked" | "rotated",
    message: string,
  ): void {
    if (this.fatalLatched) return;
    this.fatalLatched = true;
    // Tagged, so the unwind fails the plan's mission with the latch's own
    // words rather than "Stopped by you", which is now a pause reason.
    for (const controllers of this.turnControllers.values())
      for (const controller of controllers) abortWith(controller, "revoked");
    for (const controller of this.voiceTasks.values()) controller.abort();
    this.meetings.stop();
    this.nativeCommands.close();
    this.host.close();
    const code = reason === "rotated" ? "token_rotated" : "pairing_revoked";
    this.stopPollLoop();
    if (this.identityRetryTimer !== null) {
      clearTimeout(this.identityRetryTimer);
      this.identityRetryTimer = null;
    }
    this.heartbeat.setNetEnabled(false);
    this.heartbeat.setLastError({
      code,
      message,
      at: new Date().toISOString(),
    });
    this.ws.disconnect();
    this.heartbeat.setWsConnected(false, null);
    this.startSecretsWatch();
    if (!this.fatalNotified) {
      this.fatalNotified = true;
      try {
        this.onFatal?.({ code, message, reason });
      } catch {
        /* best-effort */
      }
    }
  }

  private resolveSecretsDir(): string {
    const fromEnv = process.env.CODEX_BGOS_HOME?.trim();
    let root: string;
    if (fromEnv) {
      root = fromEnv.startsWith("~")
        ? join(homedir(), fromEnv.slice(1))
        : fromEnv;
    } else {
      root = join(homedir(), ".codex-bgos");
    }
    return join(root, "secrets");
  }

  private readSecretsFile(): {
    baseUrl?: string;
    pairingToken?: string;
  } | null {
    try {
      const path = join(this.resolveSecretsDir(), "bgos.json");
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw) as { baseUrl?: string; pairingToken?: string };
    } catch {
      return null;
    }
  }

  private armSecretsWatch(): void {
    const dir = this.resolveSecretsDir();
    if (!existsSync(dir)) return;
    try {
      this.secretsWatcher = watch(dir, () => {
        if (this.secretsDebounce !== null) return;
        this.secretsDebounce = setTimeout(() => {
          this.secretsDebounce = null;
          this.rearmSecretsWatch();
          void this.checkSecretsForChange();
        }, 300);
        this.secretsDebounce.unref?.();
      });
    } catch {
      /* stat-poll fallback still covers us */
    }
  }

  private startSecretsWatch(): void {
    if (this.secretsWatcher !== null || this.secretsStatTimer !== null) return;
    this.armSecretsWatch();
    this.secretsStatTimer = setInterval(() => {
      void this.checkSecretsForChange();
    }, 60_000);
    this.secretsStatTimer.unref?.();
  }

  private rearmSecretsWatch(): void {
    if (this.secretsWatcher === null) return;
    try {
      this.secretsWatcher.close();
    } catch {
      /* ignore */
    }
    this.secretsWatcher = null;
    this.armSecretsWatch();
  }

  private stopSecretsWatch(): void {
    if (this.secretsWatcher !== null) {
      try {
        this.secretsWatcher.close();
      } catch {
        /* ignore */
      }
      this.secretsWatcher = null;
    }
    if (this.secretsStatTimer !== null) {
      clearInterval(this.secretsStatTimer);
      this.secretsStatTimer = null;
    }
    if (this.secretsDebounce !== null) {
      clearTimeout(this.secretsDebounce);
      this.secretsDebounce = null;
    }
  }

  private async checkSecretsForChange(): Promise<void> {
    if (!this.fatalLatched) return;
    const secrets = this.readSecretsFile();
    if (!secrets || !secrets.pairingToken) return;
    if (secrets.pairingToken.length < 20) return;
    if (secrets.pairingToken === this.currentToken) return;
    await this.recover(secrets.pairingToken, secrets.baseUrl);
  }

  private async recover(newToken: string, newBaseUrl?: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.error(`${LOG} re-pair detected, applying new token`);
    this.currentToken = newToken;
    this.api.updateToken(newToken, newBaseUrl);
    this.ws.updateToken(newToken, newBaseUrl);
    this.fatalLatched = false;
    this.fatalNotified = false;
    this.meetings.resume();
    this.heartbeat.setNetEnabled(true);
    this.heartbeat.setLastError(null);
    this.stopSecretsWatch();
    this.ws.disconnect();
    try {
      await this.ws.connect();
      const ok = await this.refreshIdentity();
      if (ok) {
        this.identityReady = true;
        await this.ws.triggerBackfill();
      }
      this.startPollLoop();
      await this.outbound.replaySpool();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} recovery reconnect failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------

  private async seedDefaultCommands(
    assistantId: number,
    origin: "bind" | "startup",
  ): Promise<void> {
    try {
      await this.api.putCommands(assistantId, [...DEFAULT_COMMANDS]);
      // eslint-disable-next-line no-console
      console.log(`${LOG} seeded default commands`, {
        assistantId,
        origin,
        count: DEFAULT_COMMANDS.length,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`${LOG} default command seed failed (non-fatal):`, {
        assistantId,
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
