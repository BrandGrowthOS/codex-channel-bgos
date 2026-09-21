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
import { MissionLane } from "./mission-lane.js";
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
import { CodexHost, type RunTurnResult } from "./codex-host.js";
import {
  markerEventBody,
  type ActivityMarker,
} from "./activity-markers.js";
import type { BrowserRelayCredentials } from "./browser-mcp.js";
import { HOAI_TOOLS, HoaiTools, type ToolContext } from "./hoai-tools.js";
import { BGOS_AGENT_HINTS } from "./agent-hints.js";
import { DECLARED_CAPABILITIES } from "./declared-capabilities.js";
import { unescapeButton } from "./interactions.js";
import type { VoiceRpcFrame } from "./voice-rpc.js";
import { VoiceRpcHandler } from "./hoai-shared/voice-rpc.js";
import { buildCodexInput, type InboundFileForCodex } from "./inbound-input.js";
import { parseReply } from "./reply-markers.js";
import { createSkillsHandler } from "./skills-handler.js";
import type { AuthResolutionOk } from "./auth-mode.js";
import type { Input } from "@openai/codex-sdk";
import {
  NativeCommands,
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
    });
    this.missionControl = new MissionControlLane({
      host: { steer: (chatId, text) => this.host.steer(chatId, text) },
      missionLane: this.missionLane,
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
    for (const controllers of this.turnControllers.values())
      for (const controller of controllers) controller.abort();
    this.host.close();
    this.heartbeat.stop();
    this.ws.disconnect();
    this.toolProgress.dispose();
    this.missionControl.dispose();
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
        for (const controller of this.turnControllers.get(chatId) ?? [])
          controller.abort();
        await this.host.stopTurn(chatId);
      }
      if (command.name === "stop") {
        await replyHandle.sendText("Stopped.");
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
        onUsage: (usage) => {
          const window = Number(usage.modelContextWindow),
            tokens = Number(usage.last?.inputTokens);
          if (window > 0 && tokens >= 0)
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
        },
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
                // The stage 4 fields travel exactly as the mapper built them,
                // each only when the event actually carried it.
                ...(card.kind !== undefined ? { kind: card.kind } : {}),
                ...(card.path !== undefined ? { path: card.path } : {}),
                ...(card.pathCount !== undefined
                  ? { pathCount: card.pathCount }
                  : {}),
                ...(card.detail !== undefined ? { detail: card.detail } : {}),
                ...(card.durationMs !== undefined
                  ? { durationMs: card.durationMs }
                  : {}),
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
        await this.missionLane.finalizeTurn({
          chatId,
          turnToken: missionTurn,
          error: "Stopped by you.",
        });
        if (stepsAdmitted) await this.stepsLane?.finalizeTurn(chatId);
        await replyHandle.finalizeTurn().catch(() => {});
        return;
      }
    } catch (err) {
      await this.missionLane.finalizeTurn({
        chatId,
        turnToken: missionTurn,
        error: err instanceof Error ? err.message : String(err),
      });
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

    if (result.error && !result.replyText.trim()) {
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

    await replyHandle.finalizeTurn().catch(() => {});
    if (result.error)
      await this.outbound
        .sendAgentError({ assistantId, chatId, reason: result.error })
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
        for (const controller of active ?? []) controller.abort();
        await this.host.stopTurn(chatId);
        // The stop endpoint is advisory: its RPC result does not reach the
        // chat UI. A reply also settles a pending picker or stale Thinking
        // state when there is no native model turn left to emit completion.
        await this.outbound.sendText({ assistantId, chatId, text: "Stopped." });
        await this.api.postVoiceRpcResult(frame.rpcId, {
          ok: true,
          payload: { stopped: stoppedTurn || stoppedControl, supported: true },
        });
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
    for (const controllers of this.turnControllers.values())
      for (const controller of controllers) controller.abort();
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
