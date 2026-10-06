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
import { BgosOutbound, OutboundSpooledError } from "./outbound.js";
import { CommandsSync } from "./commands-sync.js";
import { CommandUpgrade } from "./command-upgrade.js";
import { ToolProgressOrchestrator } from "./tool-progress.js";
import { MissionControlLane } from "./mission-control.js";
import {
  MissionLane,
  type GoalStop,
  type MissionTurnToken,
} from "./mission-lane.js";
import { StopDiscards } from "./stop-discards.js";
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
import { HeartbeatController, daemonHome, heartbeatEnv } from "./heartbeat.js";
import { sharedMachineId } from "./machine-id.js";
import {
  readUpdateState,
  supervisorPidFromEnv,
  updateReportFromState,
} from "./setup/self-update.js";
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
  type GeneratedImage,
  type RunTurnResult,
  type SavedThread,
} from "./codex-host.js";
import {
  imageCaption,
  imageFailureLine,
  imageNotShownLine,
} from "./generated-images.js";
import {
  mediaLineIsPostedPicture,
  newTurnPictures,
  rememberPostedPicture,
  type TurnPictures,
} from "./posted-pictures.js";
import type { RpcObject } from "./app-server.js";
import {
  markerEventBody,
  type ActivityMarker,
} from "./activity-markers.js";
import type { BrowserRelayCredentials } from "./browser-mcp.js";
import { HOAI_TOOLS, HoaiTools, type ToolContext } from "./hoai-tools.js";
import { BGOS_AGENT_HINTS } from "./agent-hints.js";
import { DECLARED_CAPABILITIES } from "./declared-capabilities.js";
import {
  reportKey,
  sessionReportRetryDelayMs,
  sessionReportRetryable,
  type SessionReport,
} from "./session-report.js";
import { ChatAssistantStore } from "./chat-assistants.js";
import { retireOrphanedApprovals, unescapeButton } from "./interactions.js";
import type { VoiceRpcFrame, VoiceRpcResultBody } from "./voice-rpc.js";
import { VoiceRpcHandler } from "./hoai-shared/voice-rpc.js";
import { buildCodexInput, type InboundFileForCodex } from "./inbound-input.js";
import { characterCount } from "./clip-text.js";
import { parseReply } from "./reply-markers.js";
import {
  PlanLane,
  planAnswerPrompt,
  sweepMissedPlanAnswers,
  type OpenPlan,
} from "./plan-lane.js";
import { diskPendingPlans } from "./pending-plans-store.js";
import { turnDirectiveLines } from "./turn-directives.js";
import {
  parsePlanChip,
  parseProposedPlan,
  planCardFromMarkdown,
  type PlanDoor,
} from "./plan-card.js";
import { createSkillsHandler } from "./skills-handler.js";
import { createChangesHandler } from "./changes-handler.js";
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
 * Is this turn the OWNER coming back to the chat (P6 stage 3, D11)? A typed
 * message, the Resume sentence, an owner slash command that starts a turn,
 * a button they clicked. Never a scheduled wake (sender system), a peer
 * agent's message or side thread, or a meeting turn; a goal's continuation
 * turn never reaches executeAndReply at all. And never another person: a
 * group member or a shared agent's recipient is not the owner, so the sender
 * must be the owner whoami named, compared exactly as the native session
 * controls compare it (NativeCommands.handle) and as the Claude plugin reads
 * D11 (isOwnerAuthoredInbound). A turn with no person on it is not one, and
 * neither is any turn before the daemon knows who its owner is.
 */
function isOwnerAuthoredTurn(
  source: Partial<DispatchArgs> | undefined,
  ownerId: string,
): boolean {
  if (!source || typeof ownerId !== "string" || !ownerId) return false;
  if (source.senderType === "agent" || source.senderType === "system") return false;
  if (source.peerConversationId) return false;
  if (source.chatKind === "meeting") return false;
  const sender = source.senderUserId ?? source.userId;
  return typeof sender === "string" && sender !== "" && sender === ownerId;
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
  /** The plan card this chat is waiting on, and the three answers to it. */
  readonly planLane: PlanLane;

  private readonly cfg: PluginConfig;
  private readonly ws: BgosWs;
  private readonly skillsHandler: ReturnType<typeof createSkillsHandler>;
  private readonly changesHandler: ReturnType<typeof createChangesHandler>;
  private readonly heartbeat: HeartbeatController;
  private readonly host: CodexHost;
  private readonly tools: HoaiTools;
  private readonly meetings: MeetingLane;
  private readonly turnControllers = new Map<number, Set<AbortController>>();
  /**
   * chat -> the continuation turn the runtime is running there, which the
   * host adopted outside executeAndReply. An owner Stop marks it, so its
   * interrupted result is the Stop's and not a reply or an error (D35).
   */
  private readonly adoptedTurns = new Map<number, AbortController>();
  private capabilityText = BGOS_AGENT_HINTS;
  private ownerId = "";
  private readonly rpcSeen = new Set<string>();
  private readonly voiceTasks = new Map<string, AbortController>();
  private readonly voiceJournal: TaskJournal;
  private readonly mintHandlers = new Map<number, VoiceRpcHandler>();
  /**
   * How the plan this chat is about to propose was asked for.
   *
   * `/plan <task>` sets `typed` and the first card of that turn spends it;
   * anything else in plan mode is `mode`. It is a HINT and never state: a
   * missing entry means plan mode's own door, which is the truthful default
   * for a plan the runtime raised without the owner typing anything.
   */
  private readonly planDoorHint = new Map<number, PlanDoor>();
  /**
   * Chats whose last plan card FAILED to post, read and cleared by the turn
   * that proposed it. One entry per chat is enough: replies are serialised per
   * chat by `replyQueues`, so a chat never has two turns publishing at once.
   */
  private readonly planCardFailures = new Set<number>();
  /**
   * Per chat, the line a /stop or /new is posting ("Stopped.", or the fresh
   * conversation line) while it is on its way. A stopped turn's pictures
   * wait for it, so they always land AFTER the stop line (review finding 6).
   * Created on first use, like `pictureTails`.
   */
  private stopLines?: Map<number, Promise<void>>;
  /**
   * Per chat, a stopped turn's pictures still uploading. The Stop branch no
   * longer waits for them (the card, the mission and the owner's next message
   * would all wait on a presigned PUT), so the NEXT turn's own posts wait
   * instead: its card rows, its requests (an approval card, an ask), a plan
   * card it raises and its reply all land after them, and no done from an old
   * picture runs over the new turn's working or its blocked. The next turn
   * itself starts at once.
   */
  private pictureTails?: Map<number, Promise<void>>;
  /**
   * The `(mode, enforced)` pair last REPORTED for a chat, so an unchanged one
   * is not sent again.
   *
   * `ChatRepository.setSessionMode` is an unconditional UPDATE with
   * `returning('*')`, and `chats_sidebar_bump_trigger` carries no column list,
   * so writing the value the row already holds still bumps the owner's sidebar
   * version and makes every connected client refetch assistants with chats.
   * Three paths repeat: every "Change the plan" click reports `plan` for a chat
   * already in plan mode, every `/code` in a chat that was never in plan mode
   * reports `default` unconditionally, and connect reports every stored plan
   * chat. The first two are now free; the third is deliberately forced, because
   * it is the cutover and this map is empty at boot.
   *
   * The pair, not the mode: `enforced` is what chooses the chip's WORDS, so a
   * `/permissions` inside plan mode has to reach the app even though the mode
   * did not move.
   */
  private readonly lastSessionModeByChat = new Map<number, string>();
  /**
   * The model and effort report last SENT per chat (P5 stage 7, C-26, S15),
   * keyed by the value without its timestamp, so an unchanged value is not
   * sent again: the backend's no op makes a repeat harmless, but not free (a
   * request per turn per chat for nothing). Forgotten when a send fails, so
   * the next source retries. Created on first use, like `stopLines`.
   */
  private lastSessionSettingsByChat?: Map<number, string>;
  /**
   * Per chat, the report on its way. Two reports for one chat leave in
   * order, never racing: the backend's last write wins, so order is ours to
   * keep. Another chat is never held behind this one.
   */
  private sessionReportChains?: Map<number, Promise<void>>;
  /**
   * A failed report waiting to be sent again (P5 stage 7, Phase B, decision
   * 3): per chat, ONLY the chat's latest value, after a backoff that doubles
   * and is capped. A report that lands drops it; stop and a revoked pairing
   * clear them all. `generation` is the value's own (round C, decision 2).
   */
  private sessionReportRetries?: Map<
    number,
    {
      assistantId: number;
      report: SessionReport;
      generation: number;
      attempt: number;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >;
  /**
   * Per chat, the generation of the newest report ENQUEUED (P5 stage 7,
   * round C, decision 2), stamped from one counter that only grows. A failure
   * holds its value for a retry only while it is still the chat's newest, and
   * a report that lands drops a held retry only when the held value is not
   * newer than it; so an older value can never replace, or drop, a newer one.
   * A retry carries the generation of the value it holds and stamps nothing.
   * Created on first use, like the maps above.
   */
  private sessionReportGenerations?: Map<number, number>;
  private sessionReportSeq?: number;
  /**
   * Chats that already had a LIVE report in this process (Phase B, decision
   * 1). The connect sweep skips them: that report is this process's truth,
   * and a forced boot value landing after it would be the last write and win.
   */
  private liveSessionReportChats?: Set<number>;
  /** Chats this process has already asked the host about (Phase B, decision 4). */
  private boundSessionChats?: Set<number>;
  /**
   * The chat to agent pairs kept on disk, so the connect sweep can name the
   * agent of every stored chat on a daemon serving several (Phase B, decision
   * 3). Built in the constructor, so an adapter made without one (a unit
   * test's bare prototype) writes nothing anywhere.
   */
  private readonly chatAssistants?: ChatAssistantStore;
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
      // echo; the owner's next turn gives it back (P6 stage 3, C-32). The
      // Stop's own hold, never the /goal pause door: it records whether the
      // goal was running, and only a running goal is given back (D36).
      pauseGoalForChat: (chatId) => this.goalLane.holdForStop(chatId),
      resumeGoalForMission: (missionId) => this.goalLane.noteResumed(missionId),
      // A Stop pause /new or a Sessions resume discarded must not come back
      // to life at the next restart's first owner turn (review F4).
      stopDiscards: new StopDiscards(
        join(
          process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos"),
          "stop-discards.json",
        ),
      ),
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
      // The chats whose goal an owner Stop found held (D36), on disk: a
      // restart before the owner's next message must not let that
      // message's resume start the goal again (review F1). The same small
      // bounded id file as the discards, holding chat ids.
      keptByStop: new StopDiscards(
        join(
          process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos"),
          "goal-kept-by-stop.json",
        ),
      ),
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
      // What each chat is really running, from the host's five sources (P5
      // stage 7). The daemon reports ALWAYS and never reads the owner's
      // switch: the app decides whether to draw the row.
      onSessionSettings: (chatId, report) =>
        this.noteSessionSettings(chatId, report),
    });
    // The owner's Changes panel (P7 stage 3). Built after the host because it
    // reads the host's folder: every agent this daemon runs works in that one
    // folder, so each owned agent's panel shows it, which is the truth. A
    // frame for an agent this daemon does not run is not answered at all,
    // under the same cold scope rule the mission frames use.
    this.changesHandler = createChangesHandler({
      api: this.api,
      workdir: this.host.workdir,
      owns: (id) => this.ownsAssistantForMission(Number(id)),
      log: (message) => console.warn(`${LOG} ${message}`),
    });
    // The third argument is not optional in practice: every mission the
    // typed tools write is stamped here, so a backend that sends no
    // `cleared_by` cannot make the agent's own last tick come back looking
    // like its owner marking the mission done.
    // The lane answers `enforced` per chat by asking the host what sandbox
    // that chat's next turn runs under. Lazy on purpose: this reads `this.host`
    // at call time, so neither construction order nor a later re-pair matters.
    this.planLane = new PlanLane(
      this.api,
      (chatId) => this.host.planWaitEnforcedIn(chatId),
      // The MODE, separately from the lock, because the card's `mode` door is
      // a claim about the host and the model is the one that fills the field.
      // Same lazy read of `this.host` as the line above.
      (chatId) => this.host.planModeChats().includes(chatId),
      // The durable half. A plan wait lasts a day and its answer arrives on
      // the WS click alone, so a card the daemon was not up for is a card
      // nothing ever replays. See pending-plans-store.ts.
      diskPendingPlans,
      // Read as the OWNER, which is how this daemon reads any row it did not
      // just write, and lazily for the same reason as the two above: identity
      // lands after construction.
      () => this.ownerId,
    );
    this.tools = new HoaiTools(
      this.api,
      () => this.capabilityText,
      {
        starting: (missionId) => this.missionControl.noteSelfWrite(missionId),
        leftOpen: (missionId) => this.missionControl.dropSelfWrite(missionId),
      },
      // `propose_plan` posts through the lane, never through the tool, so the
      // agent-decided door and plan mode's door produce the SAME card and the
      // same supersede behaviour.
      this.planLane,
    );
    this.nativeCommands = new NativeCommands({
      host: this.host,
      interactions: this.tools.interactions,
      ownerId: () => this.ownerId,
      status: () => this.statusLine(),
      // `/goal` goes through the lane, never straight to the host: the
      // mission has to exist and the lane has to be watching before the goal
      // is set, because setting one starts a turn at once.
      goalLane: this.goalLane,
      onSessionMode: async (args, mode, typedTask, enforced) => {
        // `/plan <task>` is the typed door; `/plan` on its own just turns the
        // mode on, and a plan that comes out of it came through the mode.
        if (mode === "plan" && typedTask)
          this.planDoorHint.set(args.chatId, "typed");
        else this.planDoorHint.delete(args.chatId);
        await this.reportSessionMode(
          args.assistantId,
          args.chatId,
          mode,
          enforced,
        );
      },
      // The MODE did not move, only the lock did: `/permissions` inside plan
      // mode. Re-reported so the chip stops promising a read only chat the
      // owner has just handed its files back to, and the door hint is left
      // exactly where it was, because a typed plan is still a typed plan.
      onPlanEnforcement: async (args, enforced) => {
        await this.reportSessionMode(
          args.assistantId,
          args.chatId,
          "plan",
          enforced,
        );
      },
      // `/resume` leaves the context a Stop paused, as /new and the Sessions
      // resume do: no later owner turn may resume that mission (review F4).
      clearStopMarker: (chatId, assistantId) =>
        this.missionLane.clearStopMarker(chatId, assistantId),
      run: async (args, prompt, options = {}) => {
        const files = args.attachments.map((a) => ({
          path: a.localPath,
          mime: a.mimeType,
          name: a.fileName,
          isImage: a.kind === "photo",
        }));
        // The SAME directive block the ordinary framing carries. `/plan <task>`
        // and `/code <task>` are native commands, so a framing that built its
        // own line list left slash command turns as the only ones never told
        // what the owner's plan level is.
        const input = buildCodexInput(
          `HOAI event: assistant_id=${args.assistantId}, chat_id=${args.chatId}, sender_user_id=${args.senderUserId ?? args.userId}.\n${turnDirectiveLines(args)}\n${prompt}`,
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
    this.chatAssistants = new ChatAssistantStore(
      join(
        process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos"),
        "chat-assistants.json",
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
      // Design 2.2, Visibility: the computer this agent runs on (the machine
      // id every framework's daemon and the watcher share) and what its
      // supervisor knows about updates, read fresh on every beat.
      env: () => heartbeatEnv(sharedMachineId),
      updateReport: () =>
        updateReportFromState(
          readUpdateState(daemonHome()),
          supervisorPidFromEnv(process.env),
        ),
    });
    // The busy signal the supervisor reads before an update (finding 9):
    // every edge, any chat, written to the heartbeat file at once.
    this.host.onBusyChange((busy) => this.heartbeat.setBusy(busy));

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
    // And on disk, for the next process's model and effort sweep (P5 stage
    // 7, Phase B, decision 3). Written only when the pair changed.
    this.chatAssistants?.set(chatId, assistantId);
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
   * The agent a model and effort report goes out as (P5 stage 7, Phase B,
   * decision 3): the answer above, else the pair kept on disk from an
   * earlier process, used only for an agent this daemon still owns. So on a
   * daemon serving several agents a stored chat is reported at connect
   * although no event has named it since the restart. Null (nothing sent)
   * rather than a guess: the route refuses a wrong agent anyway.
   */
  private assistantForReport(chatId: number): number | null {
    const live = this.assistantForChat(chatId);
    if (live) return live;
    const kept = this.chatAssistants?.get(chatId) ?? null;
    if (kept !== null && this.getRouteForAssistant(kept)) return kept;
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
    this.ws.on("changes_rpc", (frame) => {
      void this.changesHandler(frame);
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

    // Take the buttons off any approval card whose turn died with the last
    // daemon. Best-effort and never awaited: a card left tappable is a real
    // defect, a slow boot is a worse one.
    void this.sweepOrphanedApprovals();

    const ok = await this.refreshIdentity();
    if (ok) {
      this.identityReady = true;
      await this.ws.triggerBackfill({ initial: true });
      this.startPollLoop();
      // AFTER identity, because a chat can only be reported once we know which
      // assistant it belongs to. Never awaited: the chip is worth a request,
      // never a slower boot.
      //
      // The plan sweep is CHAINED behind it rather than fired beside it. Both
      // touch the same chat's mode and the sweep is the one that may take it
      // DOWN (a Go ahead answered while this daemon was off hands the files
      // back), so a race would leave the app drawing a chip for a chat that is
      // already coding again.
      void this.reportStoredPlanModes().then(() =>
        this.sweepMissedPlanAnswers(),
      );
      // The model and effort of every chat the store holds one for, for the
      // same reason and on the same terms: after identity, never awaited.
      void this.reportStoredSessionSettings();
    } else if (!this.fatalLatched) {
      this.scheduleIdentityRetry(1000);
    }

    this.spoolTimer = setInterval(() => {
      void this.outbound.replaySpool();
    }, 60_000);
    this.spoolTimer.unref?.();
  }

  /**
   * The supervisor's stop-if-idle question (child-control.ts, finding 9):
   * any chat's turn running or queued, and the background terminals a turn
   * left running.
   */
  isAnyBusy(): boolean {
    return this.host.isAnyBusy();
  }
  backgroundJobCount(): Promise<number> {
    return this.host.backgroundTerminalCount();
  }

  async stop(): Promise<void> {
    this.nativeCommands.close();
    if (!this.started) return;
    this.started = false;
    this.clearSessionReportRetries();
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

  /**
   * The boot half of the approval restart contract (see the restart note in
   * interactions.ts approve()). The app server is our child, so a restart takes
   * the turn and the request with it and nothing can ever answer the card the
   * owner is still looking at. This retires those cards. Never throws. Named
   * apart from the imported sweep it calls, so the call below is unmistakably
   * the module function and not this method.
   */
  private async sweepOrphanedApprovals(): Promise<void> {
    try {
      const retired = await retireOrphanedApprovals(this.api);
      if (retired > 0)
        // eslint-disable-next-line no-console
        console.log(
          `${LOG} retired ${retired} approval card(s) left open by a previous run`,
        );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} could not retire approval cards from a previous run:`,
        err instanceof Error ? err.message : String(err),
      );
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
      // The declared list rides the fetch itself: this runs before the first
      // heartbeat of a new release stores it, and the canon tells some
      // sentences (the request reason clause) only to a daemon that declares
      // their token. See BgosApi.getCapabilities.
      const served = await this.api.getCapabilities(
        "codex",
        getPackageVersion(),
        DECLARED_CAPABILITIES,
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
    // The first message in an agent DM this process serves: a chat the host
    // holds nothing for retracts any model and effort value another host
    // left on it (P5 stage 7, Phase B, decision 4). Main chats only, the
    // one kind the report route admits.
    if (!args.chatKind || args.chatKind === "main")
      this.noteChatBound(args.chatId);
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
      let goalStop: GoalStop | null = null;
      if (command.name === "stop" || command.name === "new") {
        // Held from BEFORE the abort until the line has posted: the stopped
        // turn's pictures post after it, never racing it to the chat.
        const stopLine = this.holdStopLine(chatId);
        try {
          const active = this.turnControllers.get(chatId);
          this.nativeCommands.cancel(chatId);
          this.generations.set(
            chatId,
            (this.generations.get(chatId) ?? 0) + 1,
          );
          // BEFORE the abort: an owner turn racing the unwind waits for the
          // pause, so a quick Resume ends active (P6 stage 3, D11).
          if (command.name === "stop") this.missionLane.noteStopRequested(chatId);
          // A turn the owner asked for in a Keep working chat: the abort sends
          // the interrupt at once, so the goal is held first (review F3).
          if (command.name === "stop")
            await this.holdGoalBeforeOwnerTurnStop(chatId, active);
          // /stop is the owner's Stop and pauses the chat's open mission; /new
          // ends the plan's mission, with its own words.
          for (const controller of active ?? [])
            abortWith(controller, command.name === "stop" ? "owner_stop" : "new");
          // A Keep working chat with no turn of the owner's to unwind (D35):
          // the goal is held BEFORE the interrupt below.
          if (command.name === "stop")
            goalStop = this.stopKeepWorking(chatId, assistantId, !!active?.size);
          await goalStop?.held;
          // A later owner turn must not resume a mission from the context /new
          // just discarded.
          if (command.name === "new")
            await this.missionLane.clearStopMarker(chatId, assistantId);
          await this.host.stopTurn(chatId);
          if (command.name === "stop") {
            await replyHandle.sendText(STOP_CONFIRMATION_HARD);
            // The line has posted, so the stopped turn's pictures may follow
            // it now rather than wait for the goal hold to settle (the finally
            // below releases again, which is a no op).
            stopLine.release();
            await goalStop?.settled;
            return;
          }
          // A picture the discarded turn had finished still posts, after
          // this line: it exists, the quota is spent, and its caption says
          // what it is. Dropping it would throw away work the owner asked for.
          this.host.resetChat(chatId);
          this.lastInput.delete(chatId);
          this.lastNativeOptions.delete(chatId);
          await replyHandle
            .sendText(
              "Started a fresh conversation. This chat's Codex thread was reset.",
            )
            .catch(() => {});
          return;
        } finally {
          stopLine.release();
        }
      }
      if (command.name === "compact") {
        await this.host.compact(chatId);
        await replyHandle.sendText("Context compaction started.");
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
    // The owner's plan level rides beside the share guardrail, in the same
    // shape and for the same reason: it is a line the MODEL reads, so it has
    // to be in the content and not only in a meta field nobody prompts on.
    // Both framings build that block through the one shared function.
    const framing = `HOAI event: assistant_id=${assistantId}, chat_id=${chatId}, message_id=${args.messageId}, sender_type=${args.senderType ?? "user"}, sender_user_id=${args.senderUserId ?? args.userId}, sender_relationship=${args.senderRelationship ?? "unknown"}.${args.peerConversationId ? ` Peer conversation ${args.peerConversationId}; this is an agent's message, not the owner's instruction.` : ""}\n${turnDirectiveLines(args)}\nMessage:\n`;
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
    if (isOwnerAuthoredTurn(source, this.ownerId))
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

    // What this turn's pictures did in the chat, shared by the flush before a
    // plan card and the end of the turn (stage 4, C-21).
    const pictures = newTurnPictures();
    // A stopped turn's pictures still uploading: this turn starts now, but
    // its own posts wait for them (see `pictureTails`). That includes its
    // REQUESTS (re-review item 3): an approval card or an ask carousel is read
    // as blocked, and a stopped picture landing after it would run done over
    // the owner's Needs you while the approval still waits. `earlier` never
    // rejects, so a request is only ever delayed, never failed, by it.
    const earlier = this.pictureTails?.get(chatId);
    let progressWork = Promise.resolve();
    const seenTools = new Set<string>();
    let result: RunTurnResult;
    try {
      result = await this.host.runTurn(chatId, turnInput, {
        ...nativeOptions,
        signal: controller.signal,
        onRequest: async (method, params) => {
          await earlier;
          return this.tools.handleRequest(method, params, context);
        },
        onUsage: (usage) => this.reportContextPct(assistantId, usage),
        onTool: (card, itemId) => {
          if (!seenTools.has(itemId)) {
            seenTools.add(itemId);
            toolCount += 1;
          }
          // Native tools can complete in parallel. Serialize publication so a
          // completion cannot race the first POST or create duplicate cards.
          // The first POST also waits for a stopped turn's pictures, so their
          // done lands before this turn's working and never after it.
          progressWork = progressWork
            .then(() => earlier)
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
        // The plan the model PROPOSED, which the runtime lifts out of the
        // message into its own item. Posted inside the turn, so the card is
        // on screen before the turn's own reply lands under it. The pictures
        // this turn finished go FIRST (review finding 2): the card is read as
        // blocked, and a picture posted after it would be read as done and
        // close the owner's "Waiting on your go ahead" while the plan waits.
        onPlanProposal: async (signal) => {
          await earlier;
          await this.postGeneratedImages(
            replyHandle,
            signal.images,
            {},
            pictures,
          );
          await this.postPlanCard(assistantId, chatId, signal.text);
        },
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
        // A picture that FINISHED before the Stop is still posted: it exists,
        // the quota is spent, and the stop line has already set done, so it
        // costs no status honesty. Pictures only: no plain line, no text. And
        // posted WITHOUT holding anything (review finding 6): the card and the
        // mission are closed above, and the owner's next message runs now.
        this.postStoppedPictures(chatId, replyHandle, result.images, pictures);
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

    // A stopped turn's pictures land before this turn's reply.
    await earlier;
    await this.publishTurnResult({
      assistantId,
      chatId,
      replyHandle,
      result,
      sentViaTool,
      pictures,
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
   * Post the pictures a turn made, in the order they finished: each one as a
   * normal image with `Prompt: <revisedPrompt>` as its caption (no caption
   * without one), and one plain line per distinct refusal, saying roughly how
   * long until the limit resets when that is still ahead, measured from one
   * clock reading per turn (`ledger.clockMs`).
   *
   * A picture that did not reach the chat says so in one plain line (review
   * finding 3): one with no bytes the app can draw, or one whose upload
   * failed after its retries. `imageNotShownLine` picks the words (re-review
   * item 2): "made" and where it is saved when the runtime saved a copy,
   * "made" alone when only the bytes came back or a non empty result came
   * back that could not be drawn (Round 5), and "tried" when none of that did.
   * Each distinct line posts once per turn, so two pictures saved at one
   * place read as one line and two saved at two places name both.
   * The runtime has already told the model the picture is "displayed to the
   * user", so silence would leave the owner, and the model's next answer,
   * believing it arrived. A picture the outbox QUEUED is not lost: it will
   * land, so it counts as posted and says nothing (finding 8).
   *
   * Every post is best effort, like every other post in publishTurnResult.
   * The record is the turn's `ledger`: a picture already dealt with (posted
   * before a plan card, say) is never dealt with again, `posted` feeds the
   * "finished without a text reply" guard, and the posted pictures' saved
   * paths and bytes are what a later MEDIA: line is checked against.
   *
   * `picturesOnly` is the Stop branch: the owner asked for quiet, so no
   * plain line of either kind.
   */
  private async postGeneratedImages(
    replyHandle: ReplyHandle,
    images: GeneratedImage[] | undefined,
    opts: { picturesOnly?: boolean } = {},
    ledger: TurnPictures = newTurnPictures(),
  ): Promise<TurnPictures> {
    const outcome = (sent: Promise<unknown>) =>
      sent.then(
        () => "landed" as const,
        (error: unknown) =>
          error instanceof OutboundSpooledError
            ? ("queued" as const)
            : ("lost" as const),
      );
    const say = async (line: string): Promise<void> => {
      if (opts.picturesOnly || ledger.lines.has(line)) return;
      ledger.lines.add(line);
      if ((await outcome(replyHandle.sendText(line))) !== "lost")
        ledger.posted += 1;
    };
    for (const image of images ?? []) {
      if (ledger.handled.has(image.itemId)) continue;
      ledger.handled.add(image.itemId);
      if (image.failure) {
        await say(
          imageFailureLine(image.failure, { now: (ledger.clockMs ??= Date.now()) }),
        );
        continue;
      }
      if (!image.bytes || !image.mimeType) {
        await say(imageNotShownLine(image));
        continue;
      }
      const sent = await outcome(
        replyHandle.sendImageBytes(
          {
            bytes: image.bytes,
            fileName: image.fileName ?? "codex-image.png",
            mimeType: image.mimeType,
          },
          imageCaption(image.revisedPrompt),
        ),
      );
      if (sent === "lost") {
        await say(imageNotShownLine(image));
        continue;
      }
      ledger.posted += 1;
      rememberPostedPicture(ledger, image);
    }
    return ledger;
  }

  /**
   * Hold the chat's stop line open while a /stop or /new posts it. Taken
   * BEFORE the turn is aborted and released once the line has posted (or
   * failed to), so a stopped turn's pictures, which wait for it, always land
   * after it. The race it closes: the runtime can end the turn before the
   * interrupt's own answer comes back, and an upload could then beat
   * "Stopped." to the chat.
   */
  private holdStopLine(chatId: number): { release: () => void } {
    const lines = (this.stopLines ??= new Map());
    let release!: () => void;
    const line = new Promise<void>((resolve) => {
      release = resolve;
    });
    lines.set(chatId, line);
    return {
      release: () => {
        release();
        if (lines.get(chatId) === line) lines.delete(chatId);
      },
    };
  }

  /**
   * Post a stopped turn's finished pictures in the background (review
   * finding 6): after the stop line, after any earlier stopped turn's
   * pictures, and ahead of the next turn's own posts, which wait for this
   * (see `pictureTails`). Nothing the stopped turn closes waits for it.
   */
  private postStoppedPictures(
    chatId: number,
    replyHandle: ReplyHandle,
    images: GeneratedImage[] | undefined,
    ledger: TurnPictures,
  ): void {
    const pending = (images ?? []).filter(
      (image) => !ledger.handled.has(image.itemId),
    );
    if (pending.length === 0) return;
    const tails = (this.pictureTails ??= new Map());
    const after = Promise.all([
      this.stopLines?.get(chatId),
      tails.get(chatId),
    ]);
    const posting = after
      .then(() =>
        this.postGeneratedImages(
          replyHandle,
          pending,
          { picturesOnly: true },
          ledger,
        ),
      )
      .then(
        () => undefined,
        () => undefined,
      );
    tails.set(chatId, posting);
    void posting.then(() => {
      if (tails.get(chatId) === posting) tails.delete(chatId);
    });
  }

  /**
   * Put one finished turn into the chat: the pictures it made, the status
   * line, the buttons or the questions, the text, the files, and the error
   * when there is one.
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
    /** The turn's picture record, when a plan card already flushed some. */
    pictures?: TurnPictures;
  }): Promise<void> {
    const { assistantId, chatId, replyHandle, result, sentViaTool } = params;
    const ledger = params.pictures ?? newTurnPictures();
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
      // A turn that made a picture and then failed still delivers the
      // picture, BEFORE the card closes and the error lands.
      await this.postGeneratedImages(replyHandle, result.images, {}, ledger);
      if (!helpersStillRunning)
        await replyHandle.finalizeTurn().catch(() => {});
      await this.outbound
        .sendAgentError({ assistantId, chatId, reason: result.error })
        .catch(() => {});
      return;
    }

    /**
     * THE FALLBACK, and it is deliberately narrow.
     *
     * The app server at 0.154.0 lifts the model's `<proposed_plan>` block out
     * of the message into its own `plan` item, which `onPlanProposal` already
     * caught (`result.sawPlanProposal`). A runtime that does NOT do that leaves
     * the block in the text, where markdown would render it as an unclosed tag
     * and the owner would get a plan with no buttons. So: only when no plan
     * item arrived, and only when the block is actually there. Never "a message
     * in plan mode is a plan", because phases 1 and 2 of plan mode are ordinary
     * chat and every question would become a card.
     */
    let replyText = result.replyText;

    // THE PICTURES THIS TURN MADE, FIRST (stage 4, C-21). Here, at the end of
    // the turn, and never from inside it: a standard post mid turn marks a
    // Codex agent done for the whole rest of the turn, because only the first
    // tool of a turn POSTs its card and nothing puts working back (gap 04).
    // The one exception is a plan card raised inside the turn, which posts
    // the pictures finished so far just before itself; those are in the
    // ledger and are not posted again. First in the reply means before EVERY
    // card, ask and button post (review finding 2), the fallback plan card
    // below included: each is read as blocked, and a picture posted after it
    // would run done over it. Buttons belong on the last bubble, and the
    // picture reads before the sentence about it. The cost, named: the text
    // waits for the uploads (an S3 PUT above 500 KB, 120 s at most).
    const pictures = await this.postGeneratedImages(
      replyHandle,
      result.images,
      {},
      ledger,
    );

    // A plan card IS an answer. Without this, a turn whose whole reply was the
    // plan would get "(Codex finished the turn without a text reply.)" posted
    // under its own card.
    //
    // POSTED, not merely RAISED. `sawPlanProposal` is set the moment the plan
    // item arrives and says nothing about the POST, which `postPlanCard`
    // swallows; a failed card plus an empty reply was a turn that said
    // absolutely nothing. `planCardFailures` carries the real outcome.
    let planCardFailed = this.planCardFailures.delete(chatId);
    let planCardPosted = result.sawPlanProposal === true && !planCardFailed;
    if (!planCardPosted) {
      const block = parseProposedPlan(replyText);
      if (block) {
        if (await this.postPlanCard(assistantId, chatId, block.plan)) {
          planCardPosted = true;
          planCardFailed = false;
          // The block only leaves the text once the card has taken its place.
          // Stripping it after a failed post threw the plan away entirely.
          replyText = block.rest;
        } else {
          planCardFailed = true;
        }
      }
    }

    const parsed = parseReply(replyText);

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
    } else if (
      parsed.media.length === 0 &&
      !sentViaTool &&
      !planCardPosted &&
      // A picture answers the turn, but it never stands in for a lost plan
      // (review finding 7): the "card could not be posted" line goes out
      // whatever the pictures did. Counted on answers that LANDED or were
      // queued, never on attempts.
      (planCardFailed || pictures.posted === 0)
    ) {
      await replyHandle
        .sendText(
          planCardFailed
            ? "(Codex proposed a plan, but the card could not be posted. Ask it to write the plan out in chat.)"
            : "(Codex finished the turn without a text reply.)",
        )
        .catch(() => {});
    }

    for (const path of parsed.media) {
      // The model was told the picture posts itself, but a MEDIA: line naming
      // the same file, or a copy of it (the runtime tells the model to COPY a
      // picture it needs elsewhere), would be a second copy: dropped by real
      // path and by the bytes' sha256 (review finding 9). Only once the
      // picture itself landed or was queued; if it did not, the line is the
      // owner's last chance.
      if (await mediaLineIsPostedPicture(path, pictures)) continue;
      await replyHandle.sendFile(path).catch(() => {});
    }

    if (!helpersStillRunning) await replyHandle.finalizeTurn().catch(() => {});
    if (result.error)
      await this.outbound
        .sendAgentError({ assistantId, chatId, reason: result.error })
        .catch(() => {});
  }

  /**
   * An owner Stop (the Stop button or /stop) in a chat Keep working holds,
   * when no turn the owner asked for was aborted (D35, review F1).
   *
   * The runtime runs a goal's continuation turns by itself and the host
   * adopts them outside executeAndReply, so they have no turn controller and
   * no unwind: the Stop interrupted one turn, the goal stayed active and the
   * runtime could start the next one, while the mission kept reading On it.
   * Here the Stop pauses the goal's mission as D10 pauses a running turn's,
   * and the owner's next turn resumes both (D11). The continuation turn, if
   * one is running, is marked stopped by the owner, so its interrupted
   * result is not posted as a reply or an error.
   *
   * Null when there is nothing for this path to do: a turn the owner asked
   * for was aborted (its own unwind pauses the mission, and
   * holdGoalBeforeOwnerTurnStop held the goal before that abort), or no goal
   * this daemon armed holds the chat (a Stop between turns pauses nothing).
   */
  private stopKeepWorking(
    chatId: number,
    assistantId: number,
    ownerTurnAborted: boolean,
  ): GoalStop | null {
    const continuation = this.adoptedTurns.get(chatId);
    if (continuation) abortWith(continuation, "owner_stop");
    if (ownerTurnAborted) return null;
    const missionId = this.goalLane.missionFor(chatId);
    if (missionId === null) return null;
    return this.missionLane.stoppedGoalByOwner({ chatId, assistantId, missionId });
  }

  /**
   * An owner Stop about to abort a turn the owner asked for, in a chat Keep
   * working holds (review F3, D35). The abort's listener sends the runtime's
   * interrupt at once, and that turn's unwind reaches the goal only after its
   * read of the chat's mission, so without this the goal stayed active across
   * that round trip and the runtime could start a continuation turn after
   * the interrupt, which the host adopts and nothing stops. The goal is held
   * here, awaited, BEFORE the abort; the pause stays with the unwind (D10).
   * Nothing to do with no such turn running, or with no goal holding the
   * chat.
   */
  private async holdGoalBeforeOwnerTurnStop(
    chatId: number,
    active: Set<AbortController> | undefined,
  ): Promise<void> {
    if (!active?.size) return;
    const missionId = this.goalLane.missionFor(chatId);
    if (missionId === null) return;
    await this.missionLane.holdGoalBeforeInterrupt(chatId, missionId);
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
    // An owner Stop aborts it (stopKeepWorking, D35): its tool waits end, and
    // its interrupted result is the Stop's, not a reply.
    const controller = new AbortController();
    this.adoptedTurns.set(chatId, controller);
    const context: ToolContext = {
      assistantId,
      chatId,
      // A continuation turn has no sender: the runtime started it, so the
      // owner is the only person it can act for.
      userId: this.ownerId,
      readUserId: this.ownerId,
      signal: controller.signal,
      onReply: () => {
        sentViaTool = true;
      },
    };
    const seenTools = new Set<string>();
    let progressWork = Promise.resolve();
    // The same picture record an ordinary turn keeps (stage 4, C-21).
    const pictures = newTurnPictures();
    // THE STOP PICTURE RULES, the same as an ordinary turn's (Round 7). A
    // stopped turn's pictures still uploading: this turn's rows, requests,
    // plan card and reply wait for them (see `pictureTails`). And the stop
    // generation it started under: a /stop, a /new or the voice stop moves
    // it, and that is how `deliver` knows the owner asked this turn to stop.
    // The controller above is aborted only by an owner Stop's Keep working
    // path (D35), so a /new is known by the generation alone.
    const earlier = this.pictureTails?.get(chatId);
    const generation = this.generations.get(chatId) ?? 0;
    this.goalLane.noteTurnStarted(chatId);
    return {
      callbacks: {
        onRequest: async (method, params) => {
          await earlier;
          return this.tools.handleRequest(method, params, context);
        },
        // The row fields below are the SAME list as the ordinary turn's call
        // site, 230 lines up. A field spread there and not here is a field
        // missing for the whole of an autonomous goal run, which is exactly
        // the run the owner is least able to watch.
        onTool: (card, itemId) => {
          seenTools.add(itemId);
          progressWork = progressWork
            .then(() => earlier)
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
        //
        // A proposed plan IS wired, and for the opposite reason: a continuation
        // turn that stops to propose one is a turn asking its owner a question,
        // and a question nobody is shown is a run that stalls in silence. Its
        // finished pictures go first, exactly as in an ordinary turn.
        onPlanProposal: async (signal) => {
          await earlier;
          await this.postGeneratedImages(
            replyHandle,
            signal.images,
            {},
            pictures,
          );
          await this.postPlanCard(assistantId, chatId, signal.text);
        },
      },
      deliver: async (result) => {
        try {
          await progressWork;
          if (controller.signal.aborted && result.error) {
            // The owner's Stop interrupted it (D35). "Stopped." already said
            // so, and the partial text and the runtime's "Stopped by you."
            // are neither a reply nor an error, exactly as for a turn the
            // owner asked for. A turn that finished before the Stop reached
            // it has no error and is delivered below as usual. The goal
            // lane still counts the turn it started. And, as for a turn the
            // owner asked for, a picture that finished before the Stop still
            // posts, in the background after the stop line (stage 4).
            await this.stepsLane?.finalizeTurn(chatId);
            await replyHandle.finalizeTurn().catch(() => {});
            this.postStoppedPictures(chatId, replyHandle, result.images, pictures);
            await this.goalLane.noteTurnFinished(chatId, {
              text: result.finalAgentMessageText,
              error: result.error,
            });
            return;
          }
          // The same clock an ordinary turn notes, in the same place: before
          // this turn's card is closed inside publishTurnResult.
          this.noteTurnClock(chatId, result);
          // Before the reply, exactly where an ordinary turn clears it: a list
          // left behind is the finished turn's plan sitting under the next
          // turn's work, re sent by the lane's keepalive until the backend
          // sweeps it.
          await this.stepsLane?.finalizeTurn(chatId);
          // An owner Stop that aborted this turn's controller was settled
          // above by the result (D35): with an error it is the Stop's, and
          // with none the turn finished before the Stop reached it and is
          // delivered below. Otherwise the chat's stop generation decides
          // (Round 7): a /new moves it without touching the controller.
          if (
            !controller.signal.aborted &&
            generation !== (this.generations.get(chatId) ?? 0)
          ) {
            // The owner stopped this turn: the ordinary turn's Stop branch,
            // word for word. "Stopped." already answered, so no partial text
            // and no red error; the card closes now; a picture that finished
            // posts in the background after the stop line and any earlier
            // stopped pictures, pictures only, and the next turn waits for it.
            await replyHandle.finalizeTurn().catch(() => {});
            this.postStoppedPictures(chatId, replyHandle, result.images, pictures);
            await this.goalLane.noteTurnFinished(chatId, {
              text: result.finalAgentMessageText,
              error: result.error,
            });
            return;
          }
          // A stopped turn's pictures land before this turn's reply.
          await earlier;
          await this.publishTurnResult({
            assistantId,
            chatId,
            replyHandle,
            result,
            sentViaTool,
            pictures,
          });
          // After the reply, never before: the run report is the record of a
          // turn that finished, and the cap is only reached at the end of one.
          await this.goalLane.noteTurnFinished(chatId, {
            text: result.finalAgentMessageText,
            error: result.error,
          });
        } finally {
          if (this.adoptedTurns.get(chatId) === controller)
            this.adoptedTurns.delete(chatId);
        }
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
   * Tell BGOS about every chat this daemon has stored in plan mode.
   *
   * The mode is persisted on disk per chat, so a daemon that restarts comes
   * back with chats still in plan mode and an app drawing no chip for any of
   * them. The STORE is the truth here, not the running threads: a chat whose
   * thread has not started yet still has a mode.
   *
   * Only `plan` is reported. A chat in default mode is the absence of a chip,
   * and telling the backend that about every chat this daemon has ever served
   * would be a request storm for nothing.
   */
  private async reportStoredPlanModes(): Promise<void> {
    for (const chatId of this.host.planModeChats()) {
      const assistantId = this.assistantForChat(chatId);
      if (!assistantId) continue;
      // Per chat, from the store that just came off disk. A chat left in plan
      // mode was left with its read only sandbox too, and both halves are in
      // the same file, so a restart restores the lock and reports it rather
      // than downgrading every recovered chat to the convention.
      // FORCED, and it is the one caller that is. This is the cutover: the
      // dedupe map is empty at boot, and the app may be drawing a chip left by
      // the daemon that died, so the value this process believes has to reach
      // the row whatever it is.
      await this.reportSessionMode(
        assistantId,
        chatId,
        "plan",
        this.host.planWaitEnforcedIn(chatId),
        { force: true },
      );
    }
  }

  /**
   * The boot half of the plan restart contract (see pending-plans-store.ts).
   *
   * Every plan card this daemon left waiting is read back. One still open is
   * adopted into the lane, so a later tap resolves against it at all; one
   * ANSWERED while this process was down is delivered exactly as a live click
   * would have been, which is what ends the wait, takes the status line down,
   * and on a Go ahead hands the chat's files back.
   *
   * Never throws and never blocks a boot: a read that fails leaves the entry
   * for the next start rather than guessing.
   */
  private async sweepMissedPlanAnswers(): Promise<void> {
    let missed: Awaited<ReturnType<typeof sweepMissedPlanAnswers>>;
    try {
      missed = await sweepMissedPlanAnswers(this.api, this.planLane);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} could not read back the plan cards from a previous run:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    for (const answer of missed) {
      // eslint-disable-next-line no-console
      console.log(
        `${LOG} delivering the answer to plan card ${answer.entry.id} in chat ` +
          `${answer.entry.chatId}, missed by a run that had stopped`,
      );
      await this.handlePlanClick({
        assistantId: answer.entry.assistantId,
        chatId: answer.entry.chatId,
        messageId: answer.entry.id,
        callbackData: answer.callbackData,
        ...(answer.customText ? { customText: answer.customText } : {}),
        userId: answer.entry.userId,
      } as never).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `${LOG} could not act on a missed plan answer:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  }

  /**
   * Post the plan a Codex turn proposed, as the card the owner answers.
   *
   * The DOOR is the one thing the plan text cannot tell us, so it is read from
   * the hint `/plan <task>` leaves behind and falls back to plan mode's own
   * door, which is the truthful answer for a plan the runtime raised without
   * the owner typing anything WHILE THE CHAT IS ACTUALLY IN PLAN MODE.
   *
   * IT IS CLAMPED, exactly as `propose_plan`'s own door is clamped in
   * hoai-tools.ts, and this was the one of the two mounts that was not. The
   * fallback used to be a flat `"mode"`, which the app renders as the line
   * "Plan mode is on." This path is reachable outside plan mode: the
   * `<proposed_plan>` fallback runs on EVERY reply, so an owner on plan policy
   * `always` whose model writes Codex's native block inside an ORDINARY coding
   * chat got a card announcing a mode nobody switched. It was worse on the
   * answer: `planModeChat` reads the payload's door first and anything but
   * `decided` means yes, so Go ahead wrote settings, restored a permission,
   * PATCHed `chats.session_mode` and posted "Plan approved, switched from Plan
   * to Code mode" into a chat that switched nothing. So the door claims `mode`
   * only when the HOST says the chat is planning.
   *
   * `enforced` is ASKED, per chat, and never a constant. A live probe on
   * 2026-09-23 ran a workspace write with `collaborationMode: plan` on the
   * thread and on the turn, and it succeeded with no approval raised, because
   * the mode sets `developer_instructions` and leaves `sandboxPolicy` exactly
   * where it was (docs/learnings/codex-plan-mode-wire.md). So the mode alone
   * proves nothing and this used to report a flat false. `/plan` now turns the
   * chat's read only sandbox on WITH the mode, which the same probe, re-run
   * coupled, shows the runtime does refuse writes under, so the answer is true
   * for a chat under that pair and false for a chat where a model decided to
   * propose a plan inside an ordinary coding session. Both happen on one
   * daemon, which is why it is a question and not a setting.
   */
  private async postPlanCard(
    assistantId: number,
    chatId: number,
    markdown: string,
  ): Promise<boolean> {
    const hinted = this.planDoorHint.get(chatId);
    // `typed` is never clamped: the owner's own `/plan` is what put the model
    // here and the daemon's mode flip for it is async, so the hint is the
    // better evidence. Everything else asks the host.
    const door: PlanDoor =
      hinted ?? (this.planLane.planModeIn(chatId) ? "mode" : "decided");
    this.planDoorHint.delete(chatId);
    try {
      await this.planLane.propose({
        assistantId,
        chatId,
        plan: planCardFromMarkdown(markdown, {
          door,
          // The host is the one source: the lane's own `enforcedIn` (which
          // `propose_plan` uses) is a thin wrapper of this very call, so both
          // doors stamp the card from the same store.
          enforced: this.host.planWaitEnforcedIn(chatId),
        }),
      });
      this.planCardFailures.delete(chatId);
      return true;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} could not post a plan card`,
        error instanceof Error ? error.message : String(error),
      );
      // The turn has to know. It reads `sawPlanProposal`, which says the
      // runtime RAISED a plan and nothing about whether the card reached the
      // chat, and it uses that to suppress the "no text reply" line. A plan
      // whose card failed and whose turn said nothing is total silence.
      this.planCardFailures.add(chatId);
      return false;
    }
  }

  /**
   * The owner answered a plan card.
   *
   * Go ahead: Codex's mode goes back to default (so the next turn may actually
   * edit), BGOS is told, the announced line is posted, and the turn starts with
   * the instruction to implement the plan the thread already holds. The plan
   * text is NOT re-sent: the thread kept it.
   *
   * Change the plan: the mode STAYS in plan, and the owner's typed words (which
   * arrive on the click itself, from the armed composer, never as a second
   * message) start a plan mode turn. The agent answers with a revised card that
   * supersedes this one.
   *
   * Do not do this: the mode goes back to default, the card is retired, and NO
   * turn starts. The agent waits to be told something new.
   *
   * ALL THREE OF THOSE MODE EFFECTS ARE GATED ON THE DOOR. A card raised by
   * `propose_plan` under a plan policy (`door: "decided"`) comes from a chat
   * that is in ORDINARY coding mode, and answering it must not write a mode
   * the chat never had: flipping settings for nothing, announcing a switch
   * that did not happen, or reporting `plan` to BGOS, which is persisted on
   * the chat row and would draw the Plan chip and the gold pill until an
   * explicit `/code`. `planModeChat` answers from the payload first and the
   * host's own store second, so a card whose payload was lost to a restart is
   * still read correctly.
   */
  private async handlePlanClick(click: InboundClickPayload): Promise<void> {
    const route = this.getRouteForAssistant(click.assistantId);
    if (!route) return;
    const decision = await this.planLane.answer(click).catch(() => null);
    if (!decision) return;
    const inPlanMode = this.planModeChat(click.chatId, decision.plan);
    const toDefault = decision.answer !== "change";
    if (inPlanMode) {
      // Change the plan keeps BOTH halves, so the lock the card was proposed
      // under is still the lock the revision is written under, and the report
      // says so off the store rather than off the answer.
      let enforced = this.host.planWaitEnforcedIn(click.chatId);
      if (toDefault) {
        // Persisted before it is announced, exactly as `/code` does it: a mode
        // BGOS shows that the daemon did not manage to store would survive a
        // restart as a lie. `setPlanMode` also GIVES THE ACCESS BACK: Go ahead
        // has to leave the chat able to do the work it just approved, at the
        // permission the owner had before `/plan` took it read only.
        const applied = await this.host
          .setPlanMode(click.chatId, false)
          .catch(() => null);
        // A restore that failed leaves the chat read only, and the honest
        // report of a chat that is still locked is the one it already had.
        enforced = applied ? applied.enforced : enforced;
      }
      await this.reportSessionMode(
        click.assistantId,
        click.chatId,
        toDefault ? "default" : "plan",
        enforced,
      );
    }
    const replyHandle = buildReplyHandle(
      { outbound: this.outbound, toolProgress: this.toolProgress },
      { assistantId: click.assistantId, chatId: click.chatId },
    );
    if (decision.answer === "go" && inPlanMode)
      await replyHandle
        .sendText("Plan approved, switched from Plan to Code mode")
        .catch(() => {});
    const prompt = planAnswerPrompt(decision);
    if (!prompt) return;
    const input = buildCodexInput(prompt, []);
    this.lastInput.set(click.chatId, input);
    this.lastNativeOptions.delete(click.chatId);
    await this.runAndReply(
      click.assistantId,
      click.chatId,
      input,
      replyHandle,
      { userId: click.userId },
    ).catch((error) =>
      this.outbound
        .sendAgentError({
          assistantId: click.assistantId,
          chatId: click.chatId,
          reason:
            error instanceof Error
              ? error.message
              : "Codex could not act on the plan answer.",
        })
        .catch(() => {}),
    );
  }

  /**
   * Was Codex actually PLANNING in this chat when the card was raised?
   *
   * The payload's door is the first answer and the cheapest: `typed` and
   * `mode` are plan mode's own two doors, `decided` is the plan policy asking
   * a coding chat for a plan. It is not the only answer, because a model
   * already in plan mode that calls `propose_plan` without naming a door gets
   * `decided` by default, and because a restart loses the payload. So the
   * host's persisted per chat setting is consulted whenever the payload does
   * not already say yes. The two can only widen the answer, never narrow it,
   * which is the safe direction: the cost of a missed flip is a chat left in
   * plan mode the owner can leave with `/code`, and the cost of a wrong flip
   * is a chip the app draws for ever.
   */
  private planModeChat(chatId: number, plan: OpenPlan | null): boolean {
    if (plan && plan.payload.door !== "decided") return true;
    return this.host.planModeChats().includes(chatId);
  }

  /**
   * Tell BGOS what mode this CHAT is in.
   *
   * Per chat, because Codex's mode is per chat: one daemon can be planning in
   * one chat and coding in another, and the assistant's status row cannot hold
   * both. Swallowed on every failure, including the 404 an older backend
   * answers: a chip the app cannot draw is never worth a turn.
   *
   * AN UNCHANGED PAIR IS NOT RE-SENT (see `lastSessionModeByChat`), because
   * the backend's write is not free: it bumps the owner's sidebar version and
   * every connected client refetches. `force` is for the connect time report,
   * which is the cutover.
   *
   * `enforced` IS PASSED IN, from whatever actually happened. It was a
   * constant `false` while plan mode moved nothing but the model's
   * instructions; now `/plan` couples the read only sandbox to it, so the
   * answer is "true while that sandbox is on" and every caller hands over the
   * value the host gave back rather than a hope. A `default` mode always
   * arrives here as false, because `setPlanMode(false)` restored the
   * permission and `planWaitEnforced` needs both halves.
   */
  private async reportSessionMode(
    assistantId: number,
    chatId: number,
    mode: "plan" | "default",
    enforced: boolean,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const pair = `${mode}:${enforced ? "1" : "0"}`;
    if (!options.force && this.lastSessionModeByChat.get(chatId) === pair)
      return;
    this.lastSessionModeByChat.set(chatId, pair);
    try {
      await this.api.reportSessionMode(assistantId, chatId, { mode, enforced });
    } catch {
      // A memory is only worth keeping while it describes a write that landed.
      // Forgetting here is what makes the next attempt retry rather than dedupe
      // against a report the backend never took.
      this.lastSessionModeByChat.delete(chatId);
    }
  }

  /**
   * The host learned what a chat is really running (P5 stage 7, C-26). Sent
   * as the chat's own agent; a chat whose agent this daemon cannot name is
   * skipped, because the route needs the assistant and a wrong one is
   * refused. Never throws and never waits: the listener sits on the host's
   * notification path. A report that leaves marks the chat LIVE, so the
   * connect sweep never follows it with a boot value (Phase B, decision 1).
   */
  private noteSessionSettings(chatId: number, report: SessionReport): void {
    const assistantId = this.assistantForReport(chatId);
    if (!assistantId) return;
    (this.liveSessionReportChats ??= new Set()).add(chatId);
    void this.reportSessionSettings(assistantId, chatId, report);
  }

  /**
   * The first bind of a chat in this process (P5 stage 7, Phase B, decision
   * 4): ask the host, once, whether it holds anything for the chat. One that
   * holds nothing retracts, through the listener above. Never throws: a
   * stand in host without the seam simply says nothing.
   */
  private noteChatBound(chatId: number): void {
    const bound = (this.boundSessionChats ??= new Set());
    if (bound.has(chatId)) return;
    bound.add(chatId);
    try {
      this.host.noteChatBound(chatId);
    } catch {
      // See the docblock.
    }
  }

  /**
   * Send one chat's model and effort report (S15): per chat in order, an
   * unchanged value skipped unless `force`, a failure's key forgotten. A
   * failure worth repeating (no answer, a timeout, a 5xx, a 408 or a 429) is
   * held for a retry, the chat's latest value only (Phase B, decision 3);
   * a refusal is dropped. `report` may be a function, called when this
   * report's turn in the chain comes (the connect sweep, Phase B, decision
   * 1), answering null to send nothing. Resolves when this report has left
   * (or been skipped), never rejects.
   *
   * Each call stamps the chat's next GENERATION (round C, decision 2), so a
   * failure can tell whether a newer report is already on its way.
   */
  private reportSessionSettings(
    assistantId: number,
    chatId: number,
    report: SessionReport | (() => SessionReport | null),
    options: { force?: boolean } = {},
  ): Promise<void> {
    const generation = (this.sessionReportSeq =
      (this.sessionReportSeq ?? 0) + 1);
    (this.sessionReportGenerations ??= new Map()).set(chatId, generation);
    return this.enqueueSessionReport(
      chatId,
      () => {
        const value = typeof report === "function" ? report() : report;
        return value ? { assistantId, report: value, generation } : null;
      },
      options,
    );
  }

  /**
   * The chat's chain itself: `next` is called when this report's turn comes
   * and answers what to send, as which agent and of which generation, or
   * null to send nothing. A report that lands drops a held retry that is not
   * newer; a failure holds its value only while it is the chat's NEWEST
   * report and the pairing is not latched (a report in flight when the latch
   * closed comes back after the latch cleared the retries, round C, decision
   * 3), and otherwise drops a held retry that is not newer.
   */
  private enqueueSessionReport(
    chatId: number,
    next: () => {
      assistantId: number;
      report: SessionReport;
      generation: number;
    } | null,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const chains = (this.sessionReportChains ??= new Map());
    const sent = (this.lastSessionSettingsByChat ??= new Map());
    const run = (chains.get(chatId) ?? Promise.resolve())
      .then(async () => {
        const turn = next();
        if (!turn) return;
        const { assistantId, report: value, generation } = turn;
        const key = reportKey(value);
        if (!options.force && sent.get(chatId) === key) return;
        sent.set(chatId, key);
        try {
          await this.api.reportSessionSettings(assistantId, chatId, value);
          // It landed: anything older still waiting is stale now, and
          // anything newer is not.
          this.dropSessionReportRetry(chatId, generation);
        } catch (error) {
          // A 404 from a backend without the route, or anything else: the
          // row stays as it was. Forget the key only while it is still ours,
          // so a newer report that already left is not re-sent for nothing.
          if (sent.get(chatId) === key) sent.delete(chatId);
          const newest =
            this.sessionReportGenerations?.get(chatId) === generation;
          if (newest && !this.fatalLatched && sessionReportRetryable(error))
            this.holdSessionReportRetry(assistantId, chatId, value, generation);
          else this.dropSessionReportRetry(chatId, generation);
        }
      })
      .catch(() => {});
    chains.set(chatId, run);
    void run.then(() => {
      if (chains.get(chatId) === run) chains.delete(chatId);
    });
    return run;
  }

  /**
   * Hold a failed report for a retry (Phase B, decision 3). One entry per
   * chat holding only its LATEST value: a newer failure replaces the value
   * and keeps the timer already running. The wait doubles per attempt from
   * SESSION_REPORT_RETRY_FIRST_MS up to SESSION_REPORT_RETRY_MAX_MS, and the
   * timer never holds the process open.
   */
  private holdSessionReportRetry(
    assistantId: number,
    chatId: number,
    report: SessionReport,
    generation: number,
  ): void {
    const retries = (this.sessionReportRetries ??= new Map());
    const held = retries.get(chatId) ?? {
      assistantId,
      report,
      generation,
      attempt: 0,
      timer: null,
    };
    held.assistantId = assistantId;
    held.report = report;
    held.generation = generation;
    retries.set(chatId, held);
    if (held.timer) return;
    held.timer = setTimeout(() => {
      held.timer = null;
      held.attempt += 1;
      // THE VALUE IS READ AT THE RETRY'S TURN, not when the timer fires
      // (round C, decision 2). The timer can fire while a newer report is
      // still in flight; this retry then waits behind it in the chat's
      // chain, and when its turn comes the chat's latest held value is
      // whatever that newer report left (its own, if it failed), or nothing
      // at all (it landed). A value captured here would land an older value
      // after a newer one.
      void this.enqueueSessionReport(chatId, () => {
        const latest = this.sessionReportRetries?.get(chatId);
        return latest
          ? {
              assistantId: latest.assistantId,
              report: latest.report,
              generation: latest.generation,
            }
          : null;
      });
    }, sessionReportRetryDelayMs(held.attempt));
    held.timer.unref?.();
  }

  /**
   * Drop the chat's held retry; with `upTo`, only when the held value is not
   * newer than that generation (round C, decision 2). Without it, whatever is
   * held (stop, a revoked pairing).
   */
  private dropSessionReportRetry(chatId: number, upTo?: number): void {
    const held = this.sessionReportRetries?.get(chatId);
    if (!held) return;
    if (upTo !== undefined && held.generation > upTo) return;
    if (held.timer) clearTimeout(held.timer);
    this.sessionReportRetries!.delete(chatId);
  }

  /**
   * Forget every model and effort report this process believes BGOS holds
   * (P5 stage 7, round C, decision 4): the dedupe keys and the live marks.
   * Called by recover() on an in process re pair, because the new pairing's
   * bind cleared every chat's value on BGOS's side; kept, the dedupe map
   * would swallow every unchanged value, and the live marks would keep the
   * connect sweep from sending the stored ones, so every Codex row stayed
   * missing until a value changed or the daemon restarted.
   */
  private forgetSessionReports(): void {
    this.lastSessionSettingsByChat?.clear();
    this.liveSessionReportChats?.clear();
  }

  /** Cancel every waiting retry: the daemon is stopping, or was revoked. */
  private clearSessionReportRetries(): void {
    for (const chatId of [...(this.sessionReportRetries?.keys() ?? [])])
      this.dropSessionReportRetry(chatId);
  }

  /**
   * At connect: report every chat the store holds a model for, one at a
   * time, FORCED (S15). The dedupe map is empty at boot and the app may be
   * drawing a value left by the daemon that died, so this process's value has
   * to reach the row; the backend's no op keeps an unchanged one from
   * writing anything. A chat with nothing stored has a value only the runtime
   * knows, reported the next time its thread is started or resumed (S16).
   *
   * NEVER OVER A NEWER REPORT (Phase B, decision 1). Each chat's report is
   * built when its turn in the chain comes, from the store as it is then, and
   * a chat that already had a live report in this process (one sent after the
   * sweep began, or during the boot backfill before it) is skipped: that
   * report is this process's truth. Every agent this daemon serves is covered
   * (decision 3): a chat's agent comes from the pairs kept on disk when no
   * event has named it since the restart. Never throws: a row the app cannot
   * draw never costs a boot.
   *
   * AND AFTER AN IN PROCESS RE PAIR (round C, decision 4): recover() forgets
   * what it sent and runs this again once identity is back, because the new
   * pairing's bind cleared every chat's value on BGOS's side.
   *
   * NEVER A CHANGE STILL IN FLIGHT (round D): the host answers null for a
   * chat whose settings change is waiting on the runtime, so this sends
   * nothing for it; the change's own landing report, or none, decides.
   */
  private async reportStoredSessionSettings(): Promise<void> {
    try {
      for (const chatId of this.host.storedSessionChats()) {
        if (this.liveSessionReportChats?.has(chatId)) continue;
        const assistantId = this.assistantForReport(chatId);
        if (!assistantId) continue;
        await this.reportSessionSettings(
          assistantId,
          chatId,
          () =>
            this.liveSessionReportChats?.has(chatId)
              ? null
              : this.host.storedSessionReport(chatId),
          { force: true },
        );
      }
    } catch {
      // See the docblock.
    }
  }

  /**
   * A user tapped an inline button or answered an ask question. Feed the choice
   * back to Codex as the next turn (the thread keeps context), so the agent
   * continues naturally. Correlate by (assistantId, chatId).
   */
  private handleInboundClick(click: InboundClickPayload): void {
    if (this.tools.interactions.handleClick(click)) return;
    // The plan chips are not ordinary buttons: two of them change Codex's mode
    // and one of them starts no turn at all, so they are taken before the
    // generic "The user selected: ..." path below.
    //
    // `isChangeClick` is the third door and it is not decoration. "Change the
    // plan" (and a step's "Comment") never reach the wire as `plan:change`:
    // the app arms the composer and Send posts the custom sentinel against the
    // CARD's message id, so without this the revision arrived here as an
    // ordinary typed reply, started a plain coding turn on the owner's words,
    // left the "Waiting for your go ahead" line up for its full day and never
    // asked for a revised plan at all.
    if (parsePlanChip(click.callbackData) || this.planLane.isChangeClick(click)) {
      void this.handlePlanClick(click);
      return;
    }
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
        // The same hold the typed /stop takes: pictures after the line.
        const stopLine = this.holdStopLine(chatId);
        let stoppedTurn = false;
        let goalStop: GoalStop | null = null;
        try {
          this.generations.set(
            chatId,
            (this.generations.get(chatId) ?? 0) + 1,
          );
          // BEFORE the abort: an owner turn racing the unwind waits for the
          // pause, so a quick Resume ends active (P6 stage 3, D11).
          this.missionLane.noteStopRequested(chatId);
          // A turn the owner asked for in a Keep working chat: the abort below
          // sends the interrupt at once, so the goal is held first (review F3).
          await this.holdGoalBeforeOwnerTurnStop(chatId, active);
          // Read after that hold: a turn that ended while it was taken has
          // nothing to unwind, and the Keep working path below pauses instead.
          stoppedTurn = !!active?.size;
          // The owner's Stop: the unwind pauses the chat's open mission with
          // "Stopped by you" instead of failing it.
          for (const controller of active ?? []) abortWith(controller, "owner_stop");
          // A Keep working chat with no turn of the owner's to unwind (D35):
          // the goal is held BEFORE the interrupt, so the runtime cannot start
          // its next continuation turn in between.
          goalStop = this.stopKeepWorking(chatId, assistantId, stoppedTurn);
          await goalStop?.held;
          await this.host.stopTurn(chatId);
          // The stop endpoint is advisory: its RPC result does not reach the
          // chat UI. A reply also settles a pending picker or stale Thinking
          // state when there is no native model turn left to emit completion.
          await this.outbound.sendText({
            assistantId,
            chatId,
            text: STOP_CONFIRMATION_HARD,
          });
        } finally {
          stopLine.release();
        }
        await this.api.postVoiceRpcResult(frame.rpcId, {
          ok: true,
          payload: { stopped: stoppedTurn || stoppedControl, supported: true },
        });
        await goalStop?.settled;
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
    await this.missionLane.clearStopMarker(chat, assistantId);
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
    this.clearSessionReportRetries();
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
    // The new pairing starts from nothing on BGOS's side: a bind to a new
    // pairing clears every chat's model and effort (Phase B, decision 4), so
    // what this process remembers having sent is no longer true (round C,
    // decision 4).
    this.forgetSessionReports();
    try {
      await this.ws.connect();
      const ok = await this.refreshIdentity();
      if (ok) {
        this.identityReady = true;
        await this.ws.triggerBackfill();
        // The connect sweep again, on the boot's own terms: after identity,
        // never awaited.
        void this.reportStoredSessionSettings();
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
