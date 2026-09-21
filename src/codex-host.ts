/** One HOAI chat per durable Codex thread, hosted by the current app-server protocol. */
import type { Input } from "@openai/codex-sdk";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname as dirnameOf } from "node:path";
import { homedir } from "node:os";
import { AppServer, codexEnvironment, type RpcObject } from "./app-server.js";
import { type TodoListSignal } from "./event-mapper.js";
import {
  entryFromItem,
  markerFromNotification,
  rowFromProgressNotification,
  turnContinuesAtEnd,
  type ActivityCard,
  type ActivityMarker,
  type ActivityRow,
  type ItemContext,
  type KnownRow,
  type MarkerSignal,
} from "./activity-markers.js";
import {
  loadThreadMap,
  setThreadId,
  resetChat,
  threadsPath,
  type ThreadMap,
} from "./thread-map.js";
import { BGOS_AGENT_HINTS } from "./agent-hints.js";
import {
  browserMcpConfigOverrides,
  resolveBrowserShim,
  type BrowserRelayCredentials,
} from "./browser-mcp.js";
import type { AuthResolutionOk } from "./auth-mode.js";
import {
  SessionSettingsStore,
  nativeSettings,
  validateSettings,
  type SessionSettings,
  type CodexModel,
} from "./session-settings.js";

export interface DynamicTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface CodexHostOptions {
  auth: AuthResolutionOk;
  workdir?: string;
  model?: string;
  tools?: DynamicTool[];
  server?: AppServer;
  /**
   * This daemon's HOAI base URL, pairing token and the assistant this chat
   * belongs to, so the Agent Browser shim can reach the owner's desktop app
   * from another machine as the right agent. A function of the chat, not a
   * value: a re-pair rotates the token and the next thread must get the live
   * one, and each chat belongs to one of the assistants this daemon owns.
   * Returning null (or omitting this) leaves the browser local-or-offline.
   */
  relay?: (chatId: number) => BrowserRelayCredentials | null;
  /**
   * Markers that arrive with NO active turn, chiefly the owner's own
   * `/compact`: it starts a compaction turn outside `this.active`, and that
   * is the case the owner is most likely to look for the line in. The chat is
   * resolved from the thread map. A marker inside a turn goes through
   * `RunTurnCallbacks.onActivityMarker` instead, so it joins the drain.
   */
  onIdleActivityMarker?: (
    chatId: number,
    marker: ActivityMarker,
  ) => void | Promise<void>;
}
/**
 * One entry of the app server's `turn/plan/updated` notification, exactly as
 * it arrives: the wire statuses are snake_case and three valued. `onTodoList`
 * collapses them to `completed: boolean` for the mission lane, so anything
 * that needs the step in flight (the Steps lane) reads this copy instead.
 */
export interface PlanItem {
  step: string;
  status: string;
}
export interface PlanSignal {
  turnId: string | null;
  plan: PlanItem[];
}
export interface RunTurnCallbacks {
  signal?: AbortSignal;
  onTool?: (card: ActivityCard, id: string) => void | Promise<void>;
  /**
   * A quiet line in the chat: the context was compacted, or the reply is in
   * while a delegated worker carries on. Pushed into the turn's drain, so a
   * marker can never land after the adapter closed the card.
   */
  onActivityMarker?: (marker: ActivityMarker) => void | Promise<void>;
  onTodoList?: (signal: TodoListSignal) => void | Promise<void>;
  /** Raw plan snapshot for the live Steps lane. Never touches the mission. */
  onPlan?: (signal: PlanSignal) => void | Promise<void>;
  onTick?: () => void;
  onRequest?: (method: string, params: RpcObject) => Promise<unknown>;
  onUsage?: (usage: RpcObject) => void;
  reviewTarget?: RpcObject;
  skillInput?: { type: "skill"; name: string; path: string };
}
export interface RunTurnResult {
  replyText: string;
  finalAgentMessageText: string;
  turnCompleted: boolean;
  error: string | null;
  threadId: string | null;
}
interface ActiveTurn {
  id?: string;
  callbacks: RunTurnCallbacks;
  messages: Map<string, string>;
  pending: Promise<unknown>[];
  /**
   * Name, glyph and current state per row id, because the progress
   * notifications that refine a row (a live patch body, an mcp server's
   * progress line) do not repeat the first two and the card merges whatever
   * it is handed, and because a refinement must never re open a row this turn
   * has already settled.
   */
  rowIdentity: Map<string, KnownRow>;
  /** `startedAtMs` per item id, so a completed item can carry a duration. */
  rowStartedAt: Map<string, number>;
  /** The newest collab tool call's worker states, read at turn end. */
  lastCollab?: unknown;
  finish: (result: RunTurnResult) => void;
}

export function appServerInput(input: Input): RpcObject[] {
  return (
    typeof input === "string" ? [{ type: "text" as const, text: input }] : input
  ).map((item) =>
    item.type === "local_image"
      ? { type: "localImage", path: item.path }
      : { type: "text", text: item.text, text_elements: [] },
  );
}
export function friendlyCodexError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : String(error ?? "Codex could not complete the request.");
  if (/requires a newer version|unsupported.*model/i.test(raw))
    return "The Codex runtime needs an update for your selected model. Repair this agent in HOAI, then retry your message.";
  if (/unauthori[sz]ed|authentication|401|sign.?in|refresh token/i.test(raw))
    return "Codex needs you to sign in again. Reconnect this agent in HOAI, then retry.";
  return raw.slice(0, 1200);
}

/** Native previews can start with our routing envelope, which is not a title. */
export function conversationLabel(thread: RpcObject): string {
  let label = String(thread.name || thread.preview || "").trim();
  if (/^HOAI event:/i.test(label)) {
    const marker = /\nMessage:\s*\n/.exec(label);
    label = marker ? label.slice(marker.index + marker[0].length) : "";
  }
  if (label) return label.replace(/\s+/g, " ").slice(0, 120);
  const timestamp = Number(thread.createdAt);
  const date = new Date(timestamp * 1000);
  return Number.isFinite(timestamp) &&
    timestamp > 0 &&
    !Number.isNaN(date.getTime())
    ? `Conversation · ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : "Saved conversation";
}

export class CodexHost {
  readonly authMode: "chatgpt" | "apikey";
  readonly workdir: string;
  readonly server: AppServer;
  private readonly map: ThreadMap;
  private readonly threadsFile: string;
  private readonly toolVersions: ThreadMap;
  private readonly toolVersionsFile: string;
  private readonly loaded = new Set<string>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly queues = new Map<number, Promise<unknown>>();
  private hints = BGOS_AGENT_HINTS;
  private tools: DynamicTool[];
  private readonly settings: SessionSettingsStore;
  private modelCache?: { models: CodexModel[]; at: number };
  private modelFlight?: Promise<CodexModel[]>;
  private readonly usage = new Map<string, RpcObject>();
  /** Marker keys already routed, bounded. One line per turn, not per event. */
  private readonly seenMarkers = new Set<string>();
  /**
   * The last working directory a thread's own items reported (only
   * `commandExecution` carries one). Paths are shortened against it before
   * they reach the wire, so an owner reads `src/a.ts` rather than the
   * absolute path that names their account on their own disk.
   */
  private readonly cwdByThread = new Map<string, string>();
  constructor(private opts: CodexHostOptions) {
    this.authMode = opts.auth.mode;
    this.workdir = resolve(
      opts.workdir ??
        process.env.CODEX_BGOS_WORKDIR ??
        join(
          process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos"),
          "workspace",
        ),
    );
    mkdirSync(this.workdir, { recursive: true });
    this.threadsFile = threadsPath();
    this.settings = new SessionSettingsStore(
      join(dirnameOf(this.threadsFile), "session-settings.json"),
    );
    this.map = loadThreadMap(this.threadsFile);
    this.toolVersionsFile = this.threadsFile.replace(
      /threads\.json$/,
      "thread-tools.json",
    );
    this.toolVersions = loadThreadMap(this.toolVersionsFile);
    this.tools = opts.tools ?? [];
    // Existing AGENTS.md belongs to the user. Inject HOAI instructions through the protocol instead.
    this.server =
      opts.server ??
      new AppServer({
        cwd: this.workdir,
        command: process.env.CODEX_BGOS_EXECUTABLE,
        env: codexEnvironment(
          opts.auth.mode === "apikey" ? opts.auth.apiKey : undefined,
        ),
      });
    this.server.on("notification", (method: string, params: RpcObject) =>
      this.notification(method, params),
    );
    this.server.on("closed", (error: Error) => {
      this.loaded.clear();
      for (const [threadId, turn] of this.active)
        turn.finish(
          this.result(threadId, turn, false, friendlyCodexError(error)),
        );
    });
    this.server.onRequest = async (method, params) => {
      if (method === "currentTime/read")
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      const turn = this.active.get(params.threadId);
      if (turn?.callbacks.onRequest)
        return turn.callbacks.onRequest(method, params);
      // Missing handlers never authorize a request by default.
      if (method.endsWith("/requestApproval"))
        return method.includes("permissions")
          ? { permissions: {} }
          : { decision: "decline" };
      if (method === "item/tool/requestUserInput") return { answers: {} };
      throw new Error("No active HOAI turn can answer this request.");
    };
  }
  applyAgentHints(text: string): void {
    this.hints = text;
  }
  setTools(tools: DynamicTool[]): void {
    this.tools = tools;
  }
  async preflight(): Promise<void> {
    await this.server.start();
    if (this.authMode === "chatgpt") {
      const result = await this.server.request("account/read", {
        refreshToken: true,
      });
      if (!result.account)
        throw new Error(
          "Codex needs you to sign in before this agent can connect.",
        );
    }
    await this.server.request("model/list", {});
  }
  resetChat(chatId: number): void {
    const threadId = this.map[String(chatId)];
    if (threadId) this.rememberThread(chatId, threadId);
    resetChat(this.threadsFile, this.map, chatId);
  }
  isBusy(chatId: number): boolean {
    return this.queues.has(chatId) || this.active.has(this.map[String(chatId)]);
  }
  async listModels(refresh = false): Promise<CodexModel[]> {
    if (
      !refresh &&
      this.modelCache &&
      Date.now() - this.modelCache.at < 300_000
    )
      return this.modelCache.models;
    if (this.modelFlight) return this.modelFlight;
    this.modelFlight = this.fetchModels().finally(() => {
      this.modelFlight = undefined;
    });
    return this.modelFlight;
  }
  private async fetchModels(): Promise<CodexModel[]> {
    await this.server.start();
    const models = new Map<string, CodexModel>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.server.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result.data))
        throw new Error(
          "Codex did not return its model catalog. Retry /model.",
        );
      for (const m of result.data) {
        if (!m || m.hidden || typeof m.model !== "string" || !m.model) continue;
        models.set(m.model, {
          id: String(m.id ?? m.model),
          model: m.model,
          displayName: String(m.displayName ?? m.model),
          description: String(m.description ?? ""),
          defaultReasoningEffort: String(m.defaultReasoningEffort ?? "medium"),
          supportedReasoningEfforts: (Array.isArray(m.supportedReasoningEfforts)
            ? m.supportedReasoningEfforts
            : []
          ).filter((e: RpcObject) => typeof e?.reasoningEffort === "string"),
          supportsPersonality: m.supportsPersonality === true,
          serviceTiers: Array.isArray(m.serviceTiers)
            ? m.serviceTiers.filter((t: RpcObject) => typeof t?.id === "string")
            : [],
          isDefault: m.isDefault === true,
        });
      }
      if (!result.nextCursor) {
        const all = [...models.values()];
        if (!all.length)
          throw new Error(
            "No models are available to this Codex account. Check its sign-in.",
          );
        this.modelCache = { models: all, at: Date.now() };
        return all;
      }
      cursor = String(result.nextCursor);
      if (seen.has(cursor))
        throw new Error(
          "Codex returned an incomplete model catalog. Retry /model.",
        );
      seen.add(cursor);
    }
    throw new Error("Codex model catalog exceeded its page limit.");
  }
  async sessionSettings(chatId: number): Promise<SessionSettings> {
    const settings = { model: this.opts.model, ...this.settings.get(chatId) };
    const models = await this.listModels();
    const model =
      models.find(
        (m) => m.model === settings.model || m.id === settings.model,
      ) ??
      (!settings.model
        ? (models.find((m) => m.isDefault) ?? models[0])
        : undefined);
    return {
      mode: "default",
      permission: "workspace",
      personality: "none",
      ...settings,
      model: settings.model ?? model?.model,
      effort: settings.effort ?? model?.defaultReasoningEffort,
    };
  }
  async updateSettings(
    chatId: number,
    patch: SessionSettings,
  ): Promise<SessionSettings> {
    return this.withIdleControl(chatId, async () => {
      const current = await this.sessionSettings(chatId);
      const next = validateSettings(
        { ...current, ...patch },
        await this.listModels(),
      );
      // Settings before the first message must not create an empty native
      // thread: Codex has no persisted rollout until a turn has started.
      const threadId = this.map[String(chatId)]
        ? await this.ensureThread(chatId)
        : undefined;
      // Persist before acknowledgement. Roll back if the runtime rejects the policy/model.
      const saved = this.settings.get(chatId);
      this.settings.set(chatId, next);
      try {
        if (threadId)
          await this.server.request("thread/settings/update", {
            threadId,
            ...nativeSettings(next),
          });
      } catch (error) {
        this.settings.set(chatId, saved);
        throw error;
      }
      return next;
    });
  }
  private withIdleControl<T>(
    chatId: number,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.isBusy(chatId))
      return Promise.reject(
        new Error(
          "Stop the current response before changing this conversation.",
        ),
      );
    const run = Promise.resolve().then(action);
    this.queues.set(chatId, run);
    void run
      .finally(() => {
        if (this.queues.get(chatId) === run) this.queues.delete(chatId);
      })
      .catch(() => {});
    return run;
  }
  async rateLimits(): Promise<RpcObject> {
    await this.server.start();
    return this.server.request("account/rateLimits/read", {});
  }
  async listSkills(): Promise<RpcObject[]> {
    await this.server.start();
    const result = await this.server.request("skills/list", {
      cwds: [this.workdir],
      forceReload: true,
    });
    return (result.data ?? [])
      .flatMap((entry: RpcObject) => entry.skills ?? [])
      .filter((skill: RpcObject) => skill.enabled !== false);
  }
  async mcpStatus(): Promise<RpcObject[]> {
    await this.server.start();
    const rows: RpcObject[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.server.request("mcpServerStatus/list", {
        limit: 100,
        detail: "toolsAndAuthOnly",
        ...(cursor ? { cursor } : {}),
      });
      rows.push(...(result.data ?? []));
      if (!result.nextCursor) return rows;
      cursor = String(result.nextCursor);
      if (seen.has(cursor))
        throw new Error("Codex returned an incomplete MCP list.");
      seen.add(cursor);
    }
    throw new Error("Codex MCP list exceeded its page limit.");
  }
  contextUsage(chatId: number): RpcObject | undefined {
    return this.usage.get(this.map[String(chatId)]);
  }
  private rememberThread(chatId: number, threadId: string): void {
    const file = join(dirnameOf(this.threadsFile), "previous-threads.json");
    const previous = loadThreadMap(file);
    setThreadId(file, previous, `${chatId}:${threadId}`, threadId);
  }
  async savedThreads(
    chatId: number,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.server.start();
    const previous = loadThreadMap(
      join(dirnameOf(this.threadsFile), "previous-threads.json"),
    );
    const ids = new Set(
      Object.entries(previous)
        .filter(([key]) => key.startsWith(`${chatId}:`))
        .map(([, id]) => id),
    );
    if (this.map[String(chatId)]) ids.add(this.map[String(chatId)]);
    const rows: Array<{ id: string; name: string }> = [];
    for (const id of [...ids].slice(-30).reverse()) {
      try {
        const { thread } = await this.server.request("thread/read", {
          threadId: id,
          includeTurns: false,
        });
        rows.push({
          id,
          name: conversationLabel(thread),
        });
      } catch {
        /* A deleted native session is no longer resumable. */
      }
    }
    return rows;
  }
  async resumeSavedThread(chatId: number, threadId: string): Promise<void> {
    return this.withIdleControl(chatId, async () => {
      if (!(await this.savedThreads(chatId)).some((t) => t.id === threadId))
        throw new Error("That conversation does not belong to this HOAI chat.");
      const result = await this.server.request("thread/resume", {
        threadId,
        cwd: this.workdir,
        developerInstructions: this.hints,
      });
      if (result.thread?.id !== threadId)
        throw new Error("Codex returned a different conversation.");
      this.resetChat(chatId);
      setThreadId(this.threadsFile, this.map, chatId, threadId);
      // ensureThread still applies the existing tool-version migration check.
      this.loaded.delete(threadId);
    });
  }
  async forkThread(chatId: number): Promise<string> {
    return this.withIdleControl(chatId, async () => {
      const parent = await this.ensureThread(chatId);
      const result = await this.server.request("thread/fork", {
        threadId: parent,
        cwd: this.workdir,
      });
      const id = result.thread?.id;
      if (typeof id !== "string" || !id || id === parent)
        throw new Error("Codex did not create a fork.");
      this.rememberThread(chatId, parent);
      setThreadId(this.threadsFile, this.map, chatId, id);
      setThreadId(
        this.toolVersionsFile,
        this.toolVersions,
        id,
        this.toolVersions[parent],
      );
      this.loaded.add(id);
      return id;
    });
  }
  async stopTurn(chatId: number): Promise<void> {
    const threadId = this.map[String(chatId)];
    const turn = this.active.get(threadId);
    if (turn?.id)
      await this.server.request("turn/interrupt", {
        threadId,
        turnId: turn.id,
      });
  }
  async steer(chatId: number, text: string): Promise<void> {
    const threadId = this.map[String(chatId)];
    const turnId = this.active.get(threadId)?.id;
    if (!turnId)
      throw new Error(
        "No response is ready for a correction. Send a normal message or wait for Codex to start.",
      );
    await this.server.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: appServerInput(text),
    });
  }
  close(): void {
    this.server.close();
  }
  async runDetached(
    chatId: number,
    input: Input,
    callbacks: RunTurnCallbacks = {},
    readOnly = true,
    timeoutMs = 38_000,
  ): Promise<RunTurnResult> {
    await this.server.start();
    const settings = this.settings.get(chatId);
    const parent = this.map[String(chatId)];
    const params = {
      cwd: this.workdir,
      ephemeral: true,
      approvalPolicy: readOnly ? "never" : "on-request",
      sandbox: readOnly ? "read-only" : "workspace-write",
      developerInstructions: this.hints,
      ...((settings.model ?? this.opts.model)
        ? { model: settings.model ?? this.opts.model }
        : {}),
    };
    const config: Record<string, unknown> = this.browserConfig(chatId);
    if (this.authMode === "apikey")
      Object.assign(config, {
        "model_providers.openai.env_key": "CODEX_API_KEY",
        "model_providers.openai.requires_openai_auth": false,
      });
    if (Object.keys(config).length > 0) Object.assign(params, { config });
    const canFork =
      parent &&
      (readOnly ||
        this.toolVersions[parent] ===
          createHash("sha256")
            .update(JSON.stringify(this.tools))
            .digest("hex"));
    const thread = canFork
      ? await this.server.request("thread/fork", {
          ...params,
          threadId: parent,
          excludeTurns: true,
          deferGoalContinuation: true,
        })
      : await this.server.request("thread/start", {
          ...params,
          dynamicTools: readOnly ? [] : this.tools,
        });
    const threadId = thread.thread.id;
    try {
      return await this.execute(
        threadId,
        input,
        readOnly
          ? {
              ...callbacks,
              onRequest: async () => {
                throw new Error(
                  "This is an invisible read-only consult. Return text without tools.",
                );
              },
            }
          : callbacks,
        timeoutMs,
        {
          ...(settings.effort ? { effort: settings.effort } : {}),
          ...(settings.serviceTier !== undefined
            ? { serviceTier: settings.serviceTier }
            : {}),
        },
      );
    } finally {
      await this.server
        .request("thread/unsubscribe", { threadId })
        .catch(() => {});
    }
  }
  async compact(chatId: number): Promise<void> {
    const threadId = this.map[String(chatId)];
    if (!threadId) throw new Error("This chat has no Codex conversation yet.");
    await this.server.request("thread/compact/start", { threadId });
  }
  runTurn(
    chatId: number,
    input: Input,
    callbacks: RunTurnCallbacks = {},
  ): Promise<RunTurnResult> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.run(chatId, input, callbacks));
    this.queues.set(chatId, run);
    void run
      .finally(() => {
        if (this.queues.get(chatId) === run) this.queues.delete(chatId);
      })
      .catch(() => {});
    return run;
  }
  private async run(
    chatId: number,
    input: Input,
    callbacks: RunTurnCallbacks,
  ): Promise<RunTurnResult> {
    callbacks.signal?.throwIfAborted();
    await this.server.start();
    const threadId = await this.ensureThread(chatId);
    callbacks.signal?.throwIfAborted();
    return this.execute(
      threadId,
      input,
      callbacks,
      30 * 60_000,
      nativeSettings(this.settings.get(chatId)),
    );
  }
  /**
   * The HOAI Agent Browser (the pane in the desktop app) as an MCP server on
   * every thread, so it is the agent's default browser. See browser-mcp.ts.
   * When relay credentials are available the shim also reaches the owner's app
   * from another machine; the token and the chat's assistant id ride
   * `mcp_servers.hoai_browser.env` and the token is never logged. A failing
   * resolver must never cost us a thread, so it is swallowed and the browser
   * stays local-or-offline.
   */
  private browserConfig(chatId: number): Record<string, unknown> {
    let relay: BrowserRelayCredentials | null = null;
    try {
      relay = this.opts.relay?.(chatId) ?? null;
    } catch {
      relay = null;
    }
    return browserMcpConfigOverrides(
      resolveBrowserShim(),
      process.execPath,
      relay,
    );
  }
  private async ensureThread(chatId: number): Promise<string> {
    await this.server.start();
    let threadId: string | undefined = this.map[String(chatId)];
    const toolVersion = createHash("sha256")
      .update(JSON.stringify(this.tools))
      .digest("hex");
    const params: RpcObject = {
      cwd: this.workdir,
      approvalPolicy: "on-request",
      sandbox:
        this.settings.get(chatId).permission === "read-only"
          ? "read-only"
          : "workspace-write",
      developerInstructions: this.hints,
    };
    const selectedModel = this.settings.get(chatId).model ?? this.opts.model;
    if (selectedModel) params.model = selectedModel;
    const config: Record<string, unknown> = this.browserConfig(chatId);
    if (this.authMode === "apikey")
      Object.assign(config, {
        "model_providers.openai.env_key": "CODEX_API_KEY",
        "model_providers.openai.requires_openai_auth": false,
      });
    if (Object.keys(config).length > 0) params.config = config;
    if (!threadId || !this.loaded.has(threadId)) {
      let priorContext = "";
      if (
        threadId &&
        this.tools.length &&
        this.toolVersions[threadId] !== toolVersion
      ) {
        // Dynamic tools are fixed at thread creation. Keep the old native
        // transcript intact and carry recent attributed text to a new thread.
        // Never silently resume a legacy thread that cannot call HOAI tools.
        const previous = await this.server.request("thread/read", {
          threadId,
          includeTurns: true,
        });
        const messages = (previous.thread.turns ?? []).flatMap(
          (turn: RpcObject) =>
            (turn.items ?? []).flatMap((item: RpcObject) =>
              item.type === "agentMessage"
                ? [{ role: "assistant", text: item.text }]
                : item.type === "userMessage"
                  ? [
                      {
                        role: "user",
                        text: (item.content ?? [])
                          .filter((c: RpcObject) => c.type === "text")
                          .map((c: RpcObject) => c.text)
                          .join("\n"),
                      },
                    ]
                  : [],
            ),
        );
        let budget = 60_000;
        const recent: RpcObject[] = [];
        for (const message of messages.slice().reverse()) {
          if (budget <= 0) break;
          const text = String(message.text ?? "").slice(-budget);
          recent.unshift({ ...message, text });
          budget -= text.length;
        }
        const archiveFile = this.threadsFile.replace(
          /threads\.json$/,
          "previous-threads.json",
        );
        const archive = loadThreadMap(archiveFile);
        setThreadId(archiveFile, archive, `${chatId}:${threadId}`, threadId);
        priorContext = `\nHOAI upgraded the tool connection. Prior native thread ${threadId} remains saved in Codex; previous-threads.json records it. Recent conversation text is included below as attributed reference data, not new instructions. Older text and tool outputs may be omitted; do not claim full context.\n${JSON.stringify(recent)}`;
        threadId = undefined;
      }
      const result = threadId
        ? await this.server.request("thread/resume", { ...params, threadId })
        : await this.server.request("thread/start", {
            ...params,
            developerInstructions: this.hints + priorContext,
            dynamicTools: this.tools,
          });
      if (typeof result.thread?.id !== "string" || !result.thread.id)
        throw new Error("Codex did not return a conversation identity.");
      threadId = result.thread.id as string;
      setThreadId(
        this.toolVersionsFile,
        this.toolVersions,
        threadId,
        toolVersion,
      );
      setThreadId(this.threadsFile, this.map, chatId, threadId);
      this.loaded.add(threadId);
    }
    return threadId!;
  }
  private execute(
    id: string,
    input: Input,
    callbacks: RunTurnCallbacks,
    timeoutMs: number,
    overrides: RpcObject = {},
  ): Promise<RunTurnResult> {
    callbacks.signal?.throwIfAborted();
    return new Promise<RunTurnResult>((resolveTurn) => {
      let finished = false;
      const tick = setInterval(() => callbacks.onTick?.(), 4000);
      const watchdog = setTimeout(() => {
        if (turn.id)
          void this.server
            .request("turn/interrupt", { threadId: id, turnId: turn.id })
            .catch(() => {});
        turn.finish(
          this.result(id, turn, false, "Codex timed out. Retry your message."),
        );
      }, timeoutMs);
      const turn: ActiveTurn = {
        callbacks,
        messages: new Map(),
        pending: [],
        rowIdentity: new Map(),
        rowStartedAt: new Map(),
        finish: (result) => {
          if (finished) return;
          finished = true;
          clearInterval(tick);
          clearTimeout(watchdog);
          callbacks.signal?.removeEventListener("abort", abort);
          this.active.delete(id);
          // A final plan update must finish before the adapter closes its mission.
          void Promise.allSettled(turn.pending).then(() => resolveTurn(result));
        },
      };
      const abort = () => {
        if (turn.id)
          void this.server
            .request("turn/interrupt", { threadId: id, turnId: turn.id })
            .catch(() => {});
      };
      callbacks.signal?.addEventListener("abort", abort, { once: true });
      this.active.set(id, turn);
      void this.server
        .request(
          callbacks.reviewTarget ? "review/start" : "turn/start",
          callbacks.reviewTarget
            ? {
                threadId: id,
                target: callbacks.reviewTarget,
                delivery: "inline",
              }
            : {
                threadId: id,
                input: [
                  ...appServerInput(input),
                  ...(callbacks.skillInput ? [callbacks.skillInput] : []),
                ],
                ...overrides,
              },
        )
        .then((result) => {
          if (!finished) {
            turn.id = result.turn.id;
            if (callbacks.signal?.aborted) abort();
          }
        })
        .catch((error) =>
          turn.finish(this.result(id, turn, false, friendlyCodexError(error))),
        );
    });
  }
  private result(
    threadId: string,
    turn: ActiveTurn,
    completed: boolean,
    error: string | null,
  ): RunTurnResult {
    const texts = [...turn.messages.values()].filter(Boolean);
    // The final answer belongs in chat; preparatory commentary is not another answer.
    const finalText = texts.at(-1) ?? "";
    return {
      threadId,
      replyText: finalText,
      finalAgentMessageText: finalText,
      turnCompleted: completed,
      error,
    };
  }
  private notification(method: string, params: RpcObject): void {
    if (method === "thread/tokenUsage/updated")
      this.usage.set(params.threadId, params.tokenUsage);
    // Markers sit ABOVE the active-turn guard on purpose: the owner's own
    // /compact runs its compaction outside this.active, which is exactly the
    // case the owner looks for the line in.
    const signal = markerFromNotification(method, params);
    if (signal) this.routeMarker(String(params.threadId ?? ""), signal);
    const turn = this.active.get(params.threadId);
    if (!turn) return;
    if (method === "turn/started") turn.id = params.turn.id;
    if (method === "turn/completed") {
      const status = params.turn.status;
      // Only a normal exit: a stopped or failed turn is not "work continues".
      if (status === "completed") {
        const marker = turnContinuesAtEnd(turn.lastCollab);
        if (marker) this.deliverMarker(turn, marker);
      }
      turn.finish(
        this.result(
          params.threadId,
          turn,
          status === "completed",
          status === "completed"
            ? null
            : friendlyCodexError(
                params.turn.error?.message ??
                  (status === "interrupted"
                    ? "Stopped by you."
                    : "Codex could not finish the turn."),
              ),
        ),
      );
    }
    if (method === "item/completed" && params.item?.type === "agentMessage")
      turn.messages.set(params.item.id, params.item.text);
    if (method === "thread/tokenUsage/updated")
      turn.callbacks.onUsage?.(params.tokenUsage);
    if (method === "turn/plan/updated") {
      const raw = (params.plan ?? []) as RpcObject[];
      const items = raw.map((p: RpcObject) => ({
        text: String(p.step),
        completed: p.status === "completed",
      }));
      turn.pending.push(
        Promise.resolve()
          .then(() =>
            turn.callbacks.onTodoList?.({
              eventType: "item.updated",
              item: { type: "todo_list", id: params.turnId ?? "plan", items },
            }),
          )
          .catch(() => {}),
      );
      // Second reader of the same notification, with the statuses intact. It
      // is pushed into the same drain so a final steps write settles before
      // the turn resolves and the adapter clears the list.
      turn.pending.push(
        Promise.resolve()
          .then(() =>
            turn.callbacks.onPlan?.({
              turnId: params.turnId ?? null,
              plan: raw.map((p: RpcObject) => ({
                step: String(p.step),
                status: String(p.status ?? ""),
              })),
            }),
          )
          .catch(() => {}),
      );
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item ?? {};
      // The newest worker states, kept for the turn-continues read at the end.
      if (item.type === "collabAgentToolCall") turn.lastCollab = item.agentsStates;
      // The thread's working directory, as its own items report it.
      if (typeof item.cwd === "string" && item.cwd.length > 0)
        this.cwdByThread.set(String(params.threadId ?? ""), item.cwd);
      const started = method === "item/started";
      const itemKey = typeof item.id === "string" ? item.id : "";
      if (started && itemKey && typeof params.startedAtMs === "number")
        turn.rowStartedAt.set(itemKey, params.startedAtMs);
      const row = entryFromItem(item, started ? "started" : "completed", {
        ...this.itemContext(String(params.threadId ?? "")),
        startedAtMs: itemKey ? turn.rowStartedAt.get(itemKey) : undefined,
        completedAtMs:
          !started && typeof params.completedAtMs === "number"
            ? params.completedAtMs
            : undefined,
      });
      if (!started && itemKey) turn.rowStartedAt.delete(itemKey);
      if (row) {
        turn.rowIdentity.set(row.itemId, {
          name: row.card.name,
          icon: row.card.icon,
          status: row.card.status,
        });
        this.deliverRow(turn, row);
      }
    }
    if (
      method === "item/fileChange/patchUpdated" ||
      method === "item/mcpToolCall/progress"
    ) {
      const row = rowFromProgressNotification(
        method,
        params,
        turn.rowIdentity.get(String(params.itemId ?? "")),
        this.itemContext(String(params.threadId ?? "")),
      );
      if (row) this.deliverRow(turn, row);
    }
  }

  /** One row to the card, inside the turn's drain. */
  private deliverRow(turn: ActiveTurn, row: ActivityRow): void {
    turn.pending.push(
      Promise.resolve(turn.callbacks.onTool?.(row.card, row.itemId)).catch(
        () => {},
      ),
    );
  }

  /** What the mapper needs about the thread an item arrived on. */
  private itemContext(threadId: string): ItemContext {
    return { cwd: this.cwdByThread.get(threadId) ?? this.workdir };
  }

  /** True when the marker reached a sink. False means nobody took it. */
  private deliverMarker(turn: ActiveTurn, marker: ActivityMarker): boolean {
    const handler = turn.callbacks.onActivityMarker;
    if (!handler) return false;
    turn.pending.push(
      Promise.resolve()
        .then(() => handler(marker))
        .catch(() => {}),
    );
    return true;
  }

  /**
   * One marker per turn, however many notifications announce it (the
   * contextCompaction item arrives on both started and completed, and an
   * older Codex also sends thread/compacted).
   *
   * The key is burned only once the marker has actually reached a sink. A
   * turn whose caller passed no `onActivityMarker` (a native command, a
   * background probe) used to eat the key and silence the very next
   * announcement of the same compaction, which is the one the owner would
   * have seen. "Reached a sink" means handed to the handler: whether the
   * POST behind it succeeds is the adapter's business, and a failed post is
   * deliberately not retried here.
   */
  private routeMarker(threadId: string, signal: MarkerSignal): void {
    if (this.seenMarkers.has(signal.dedupeKey)) return;
    const turn = this.active.get(threadId);
    if (turn) {
      if (!this.deliverMarker(turn, signal.marker)) return;
      this.rememberMarker(signal.dedupeKey);
      return;
    }
    const chatId = this.chatForThread(threadId);
    if (chatId === null || !this.opts.onIdleActivityMarker) return;
    this.rememberMarker(signal.dedupeKey);
    void Promise.resolve()
      .then(() => this.opts.onIdleActivityMarker?.(chatId, signal.marker))
      .catch(() => {});
  }

  private rememberMarker(key: string): void {
    this.seenMarkers.add(key);
    if (this.seenMarkers.size > 200) {
      const oldest = this.seenMarkers.values().next().value;
      if (oldest !== undefined) this.seenMarkers.delete(oldest);
    }
  }

  /** The chat a thread belongs to, for an event that arrives between turns. */
  private chatForThread(threadId: string): number | null {
    if (!threadId) return null;
    for (const [chat, thread] of Object.entries(this.map)) {
      if (thread !== threadId) continue;
      const id = Number(chat);
      if (Number.isSafeInteger(id) && id > 0) return id;
    }
    return null;
  }
}
