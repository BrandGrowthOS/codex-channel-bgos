import type { TodoListItem } from "@openai/codex-sdk";

import type { BgosApi, PatchMissionProgressInput } from "./bgos-api.js";

const LOG = "[codex-channel-bgos]";
const DISPOSE_TIMEOUT_MS = 3_000;
const DISPOSE_SUMMARY = "Daemon stopped before the plan finished";

declare const missionTurnTokenBrand: unique symbol;

/** Opaque identity for one Codex turn in a chat. */
export interface MissionTurnToken {
  readonly [missionTurnTokenBrand]: true;
}

type TodoEventType = "item.started" | "item.updated" | "item.completed";
type TodoStep = TodoListItem["items"][number];

interface StoredMission {
  assistantId: number;
  missionId: number;
  lastSnapshot: TodoStep[];
}

interface TurnState {
  token: MissionTurnToken;
  predecessor: Promise<void>;
  operations: Set<Promise<void>>;
  assistantId: number;
  prompt: string;
  firstTodoSeen: boolean;
  managedThisTurn: boolean;
  missionId: number | null;
  latestObserved: TodoStep[];
  pendingSnapshot: TodoStep[] | null;
  pendingWorkedText: string | null;
  lastPatchAt: number;
  pendingFlush: ReturnType<typeof setTimeout> | null;
  flushInFlight: Promise<void> | null;
}

export interface MissionLaneOptions {
  debounceMs?: number;
  /**
   * Called just BEFORE this lane closes a mission itself (complete, fail).
   * The mission control lane stamps it so a backend older than stage 5,
   * which sends no `cleared_by`, cannot make the daemon's own turn end
   * completion look like the owner marking the mission done. A create is not
   * stamped: see attachMission for why.
   */
  onSelfWrite?: (missionId: number) => void;
}

export interface BeginMissionTurnParams {
  assistantId: number;
  chatId: number;
  prompt: string;
}

export interface HandleTodoListParams {
  chatId: number;
  turnToken: MissionTurnToken;
  eventType: TodoEventType;
  item: TodoListItem;
}

export interface FinalizeMissionTurnParams {
  chatId: number;
  turnToken: MissionTurnToken;
  finalText?: string;
  error?: string | null;
}

/** Host-driven mission lifecycle derived from Codex todo_list events. */
export class MissionLane {
  private readonly api: BgosApi;
  private readonly debounceMs: number;
  private readonly turnByChat = new Map<number, TurnState>();
  private readonly storedByChat = new Map<number, StoredMission>();
  private readonly createdMissionIds = new Set<number>();
  /** Missions the owner paused. This lane stops writing to them. */
  private readonly pausedMissions = new Set<number>();
  private readonly onSelfWrite: (missionId: number) => void;

  constructor(api: BgosApi, options: MissionLaneOptions = {}) {
    this.api = api;
    this.debounceMs = options.debounceMs ?? 600;
    this.onSelfWrite = options.onSelfWrite ?? (() => {});
  }

  /**
   * The owner paused this mission. Hold every progress PATCH and do NOT close
   * it at turn end: a turn that ends during a pause must leave the mission
   * paused rather than silently completing it over the owner's decision. This
   * is the whole of Codex's honest pause behaviour in this stage.
   */
  notePaused(missionId: number): void {
    if (!Number.isSafeInteger(missionId) || missionId <= 0) return;
    this.pausedMissions.add(missionId);
  }

  /** The owner resumed it. Writing may continue, starting with what was held. */
  noteResumed(missionId: number): void {
    if (!this.pausedMissions.delete(missionId)) return;
    for (const [chatId, state] of this.turnByChat) {
      if (state.missionId !== missionId || state.pendingSnapshot === null) continue;
      void this.flush(chatId, state);
    }
  }

  /**
   * The mission is gone (completed, abandoned or failed elsewhere). Forget it,
   * so finalizeTurn falls into its unmanaged branch and issues no /complete
   * and no /fail against a mission the server already closed.
   */
  noteClosed(missionId: number): void {
    this.pausedMissions.delete(missionId);
    this.forgetMission(missionId);
  }

  /** Start one Codex turn and remember the prompt used for its mission title. */
  beginTurn(params: BeginMissionTurnParams): MissionTurnToken {
    const existing = this.turnByChat.get(params.chatId);
    const predecessor = existing
      ? waitForStateOperations(existing)
      : Promise.resolve();
    if (existing) this.detachState(existing);
    const token = {} as MissionTurnToken;
    const state: TurnState = {
      token,
      predecessor,
      operations: new Set(),
      assistantId: params.assistantId,
      prompt: params.prompt,
      firstTodoSeen: false,
      managedThisTurn: false,
      missionId: null,
      latestObserved: [],
      pendingSnapshot: null,
      pendingWorkedText: null,
      lastPatchAt: 0,
      pendingFlush: null,
      flushInFlight: null,
    };
    this.turnByChat.set(params.chatId, state);
    return token;
  }

  /** Consume one todo_list event from the current turn. */
  async handleTodoList(params: HandleTodoListParams): Promise<void> {
    const state = this.turnByChat.get(params.chatId);
    if (!state || state.token !== params.turnToken) return;
    const operation = this.handleTodoListForState(params, state);
    state.operations.add(operation);
    try {
      await operation;
    } finally {
      state.operations.delete(operation);
    }
  }

  private async handleTodoListForState(
    params: HandleTodoListParams,
    state: TurnState,
  ): Promise<void> {
    await state.predecessor;
    if (
      this.turnByChat.get(params.chatId) !== state ||
      state.token !== params.turnToken
    ) {
      return;
    }

    if (!state.firstTodoSeen) {
      state.firstTodoSeen = true;
      if (params.item.items.length < 3) return;
      await this.attachMission(params.chatId, state, params.item);
      return;
    }

    if (!state.managedThisTurn || state.missionId === null) return;
    if (params.eventType !== "item.updated") return;

    this.recordUpdate(state, params.item.items);
    await this.maybePatchSoon(params.chatId, state);
  }

  /** Flush progress, then complete or fail the mission managed by this turn. */
  async finalizeTurn(params: FinalizeMissionTurnParams): Promise<void> {
    const state = this.turnByChat.get(params.chatId);
    if (!state || state.token !== params.turnToken) return;
    const operation = this.finalizeTurnForState(params, state);
    state.operations.add(operation);
    try {
      await operation;
    } finally {
      state.operations.delete(operation);
    }
  }

  private async finalizeTurnForState(
    params: FinalizeMissionTurnParams,
    state: TurnState,
  ): Promise<void> {
    await state.predecessor;
    if (
      this.turnByChat.get(params.chatId) !== state ||
      state.token !== params.turnToken
    ) {
      return;
    }
    if (state.pendingFlush) {
      clearTimeout(state.pendingFlush);
      state.pendingFlush = null;
    }

    // Paused by the owner: hold whatever is pending, close nothing, and let
    // the turn end. Flushing here would also spin the loop below, because a
    // paused drain deliberately leaves pendingSnapshot in place.
    if (state.missionId !== null && this.pausedMissions.has(state.missionId)) {
      this.turnByChat.delete(params.chatId);
      return;
    }

    do {
      await this.flush(params.chatId, state);
    } while (
      this.turnByChat.get(params.chatId) === state &&
      (state.flushInFlight !== null || state.pendingSnapshot !== null)
    );
    if (this.turnByChat.get(params.chatId) !== state) return;

    const missionId = state.missionId;
    if (!state.managedThisTurn || missionId === null) {
      this.turnByChat.delete(params.chatId);
      return;
    }

    const failed = params.error !== undefined && params.error !== null;
    const summary = clipAtWordBoundary(
      failed ? (params.error ?? "") : (params.finalText ?? ""),
      500,
    );
    const body = summary.length > 0 ? { summary } : {};

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (this.turnByChat.get(params.chatId) !== state) break;
        try {
          // Stamp BEFORE the write: the gateway emits the mission event from
          // inside the request that closes the mission, so the frame can beat
          // the response back. Stamped after, a racing frame would be read as
          // the OWNER closing the mission and the model would be told a lie.
          this.onSelfWrite(missionId);
          if (failed) {
            await this.api.failMission(state.assistantId, missionId, body);
          } else {
            await this.api.completeMission(state.assistantId, missionId, body);
          }
          this.forgetMission(missionId);
          break;
        } catch (err) {
          if (this.turnByChat.get(params.chatId) !== state) break;
          const notFound = isNotFound(err);
          if (!notFound && attempt === 0) continue;
          if (notFound) {
            this.clearMission(params.chatId, state, missionId);
          }
          // eslint-disable-next-line no-console
          console.warn(
            `${LOG} mission ${failed ? "fail" : "complete"} PATCH failed chat=` +
              params.chatId +
              " mission=" +
              missionId +
              " err=" +
              errorText(err),
          );
          break;
        }
      }
    } finally {
      if (this.turnByChat.get(params.chatId) === state) {
        this.turnByChat.delete(params.chatId);
      }
    }
  }

  /** Fail managed missions, cancel deferred work, and forget ownership. */
  async dispose(): Promise<void> {
    const managed = new Map<
      string,
      { assistantId: number; missionId: number }
    >();
    for (const stored of this.storedByChat.values()) {
      managed.set(`${stored.assistantId}:${stored.missionId}`, {
        assistantId: stored.assistantId,
        missionId: stored.missionId,
      });
    }
    for (const state of this.turnByChat.values()) {
      if (state.pendingFlush) clearTimeout(state.pendingFlush);
      if (state.managedThisTurn && state.missionId !== null) {
        managed.set(`${state.assistantId}:${state.missionId}`, {
          assistantId: state.assistantId,
          missionId: state.missionId,
        });
      }
    }
    this.turnByChat.clear();
    this.storedByChat.clear();
    this.createdMissionIds.clear();
    this.pausedMissions.clear();

    await Promise.all(
      Array.from(managed.values(), async ({ assistantId, missionId }) => {
        try {
          await this.api.failMission(
            assistantId,
            missionId,
            { summary: DISPOSE_SUMMARY },
            { timeout: DISPOSE_TIMEOUT_MS },
          );
        } catch (err) {
          if (isNotFound(err)) return;
          // eslint-disable-next-line no-console
          console.warn(
            `${LOG} mission shutdown fail PATCH failed assistant=` +
              assistantId +
              " mission=" +
              missionId +
              " err=" +
              errorText(err),
          );
        }
      }),
    );
  }

  private async attachMission(
    chatId: number,
    state: TurnState,
    item: TodoListItem,
  ): Promise<void> {
    let active = null;
    try {
      active = await this.api.getActiveMission(state.assistantId, { chatId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} mission active GET failed chat=` +
          chatId +
          " err=" +
          errorText(err),
      );
      return;
    }

    if (this.turnByChat.get(chatId) !== state) return;
    // Explicit goal cards belong to the agent/user, not the Codex plan stream.
    if (active?.origin === "self_report") return;
    const stored = this.storedByChat.get(chatId);
    const canAdopt =
      active !== null &&
      (active.status === "active" || active.status === "paused") &&
      active.origin === "derived" &&
      // A chat scoped backend can hand back a mission that belongs to another
      // chat; adopting it would tick the wrong card.
      (active.chatId === undefined || active.chatId === null || active.chatId === chatId) &&
      this.createdMissionIds.has(active.id) &&
      stored?.assistantId === state.assistantId &&
      stored?.missionId === active.id;

    if (canAdopt && active !== null) {
      this.setMission(chatId, state, active.id, item.items, active.chatId != null);
      return;
    }

    this.storedByChat.delete(chatId);
    const progress = {
      current: completedCount(item.items),
      total: item.items.length,
      label: "steps",
    };
    try {
      const created = await this.api.createMission(state.assistantId, {
        title: titleFromPrompt(state.prompt),
        chatId,
        progress,
        origin: "derived",
        firstFeedText: `Planned ${item.items.length} steps`,
      });
      if (!Number.isInteger(created?.id) || created.id <= 0) {
        throw new Error("mission create returned no valid id");
      }
      // NO self write stamp here, deliberately. The id only exists once the
      // response is back, while the gateway emits mission_created from inside
      // that request, so a stamp taken here normally arrives too late to
      // answer for its own frame and then sits there waiting to be eaten by
      // the OWNER's next Set aside of the same mission. It would buy nothing
      // even when it won the race: mission_created carries
      // createdByAssistant, which every backend has always sent and which the
      // control lane already skips on.
      if (this.turnByChat.get(chatId) === state) {
        this.createdMissionIds.add(created.id);
        // Self configuring: a backend that echoes the chat is chat scoped, so
        // a create in chat B does NOT abandon chat A's mission and the local
        // eviction would be a lie. A backend that echoes none still enforces
        // one open mission per assistant, so the eviction stays load bearing.
        this.setMission(chatId, state, created.id, item.items, created.chatId != null);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} mission POST failed chat=` + chatId + " err=" + errorText(err),
      );
    }
  }

  private setMission(
    chatId: number,
    state: TurnState,
    missionId: number,
    items: TodoStep[],
    chatScopedBackend: boolean,
  ): void {
    if (!chatScopedBackend) {
      for (const [otherChatId, other] of this.turnByChat) {
        if (other === state || other.assistantId !== state.assistantId) continue;
        this.detachState(other);
        this.turnByChat.delete(otherChatId);
        this.storedByChat.delete(otherChatId);
      }
      for (const [storedChatId, stored] of this.storedByChat) {
        if (storedChatId !== chatId && stored.assistantId === state.assistantId) {
          this.storedByChat.delete(storedChatId);
        }
      }
    }
    const snapshot = copyItems(items);
    state.managedThisTurn = true;
    state.missionId = missionId;
    state.latestObserved = copyItems(snapshot);
    state.pendingSnapshot = null;
    state.pendingWorkedText = null;
    state.lastPatchAt = Date.now();
    this.storedByChat.set(chatId, {
      assistantId: state.assistantId,
      missionId,
      lastSnapshot: copyItems(snapshot),
    });
  }

  private recordUpdate(state: TurnState, items: TodoStep[]): void {
    const next = copyItems(items);
    const previouslyCompleted = new Set(
      state.latestObserved
        .filter((item) => item.completed)
        .map((item) => item.text),
    );
    for (const item of next) {
      if (item.completed && !previouslyCompleted.has(item.text)) {
        state.pendingWorkedText = clipText(item.text, 200);
      }
    }
    state.latestObserved = next;
    state.pendingSnapshot = copyItems(next);
  }

  private async maybePatchSoon(
    chatId: number,
    state: TurnState,
  ): Promise<void> {
    if (this.turnByChat.get(chatId) !== state || state.missionId === null) {
      return;
    }
    if (state.flushInFlight) {
      await state.flushInFlight;
      return;
    }
    const elapsed = Date.now() - state.lastPatchAt;
    if (elapsed >= this.debounceMs) {
      await this.flush(chatId, state);
      return;
    }
    if (state.pendingFlush) return;
    state.pendingFlush = setTimeout(() => {
      void this.flush(chatId, state);
    }, this.debounceMs - elapsed);
  }

  private async flush(chatId: number, state: TurnState): Promise<void> {
    if (this.turnByChat.get(chatId) !== state) return;
    if (state.pendingFlush) {
      clearTimeout(state.pendingFlush);
      state.pendingFlush = null;
    }
    if (state.flushInFlight) {
      await state.flushInFlight;
      return;
    }
    if (state.missionId === null || state.pendingSnapshot === null) return;
    if (this.pausedMissions.has(state.missionId)) return;

    const operation = this.drainProgress(chatId, state).finally(() => {
      state.flushInFlight = null;
    });
    state.flushInFlight = operation;
    await operation;
  }

  private async drainProgress(chatId: number, state: TurnState): Promise<void> {
    while (
      this.turnByChat.get(chatId) === state &&
      state.missionId !== null &&
      state.pendingSnapshot !== null
    ) {
      const missionId = state.missionId;
      // Hold the snapshot rather than dropping it: resume flushes it.
      if (this.pausedMissions.has(missionId)) return;
      const snapshot = state.pendingSnapshot;
      const workedText = state.pendingWorkedText;
      state.pendingSnapshot = null;
      state.pendingWorkedText = null;

      const stored = this.storedByChat.get(chatId);
      if (stored?.missionId === missionId) {
        stored.lastSnapshot = copyItems(snapshot);
      }
      if (snapshot.length === 0) continue;

      state.lastPatchAt = Date.now();
      const body: PatchMissionProgressInput = {
        progress: {
          current: completedCount(snapshot),
          total: snapshot.length,
        },
      };
      if (workedText !== null) {
        body.feedEntry = { kind: "worked", text: workedText };
      }

      try {
        await this.api.patchMissionProgress(state.assistantId, missionId, body);
      } catch (err) {
        if (isNotFound(err)) this.clearMission(chatId, state, missionId);
        // eslint-disable-next-line no-console
        console.warn(
          `${LOG} mission progress PATCH failed chat=` +
            chatId +
            " mission=" +
            missionId +
            " err=" +
            errorText(err),
        );
      }
    }
  }

  private clearMission(
    chatId: number,
    state: TurnState,
    missionId: number,
  ): void {
    if (state.missionId !== missionId) return;
    this.forgetMission(missionId);
  }

  private forgetMission(missionId: number): void {
    for (const state of this.turnByChat.values()) {
      if (state.missionId !== missionId) continue;
      this.detachState(state);
    }
    for (const [storedChatId, stored] of this.storedByChat) {
      if (stored.missionId === missionId)
        this.storedByChat.delete(storedChatId);
    }
    this.createdMissionIds.delete(missionId);
  }

  private detachState(state: TurnState): void {
    if (state.pendingFlush) clearTimeout(state.pendingFlush);
    state.pendingFlush = null;
    state.pendingSnapshot = null;
    state.pendingWorkedText = null;
    state.managedThisTurn = false;
    state.missionId = null;
  }
}

function waitForStateOperations(state: TurnState): Promise<void> {
  const pending = new Set([state.predecessor, ...state.operations]);
  if (state.flushInFlight) pending.add(state.flushInFlight);
  return Promise.allSettled(Array.from(pending)).then(() => undefined);
}

function copyItems(items: TodoStep[]): TodoStep[] {
  return items.map((item) => ({ ...item }));
}

function completedCount(items: TodoStep[]): number {
  return items.filter((item) => item.completed).length;
}

function titleFromPrompt(prompt: string): string {
  const firstLine = (prompt.split(/\r?\n/, 1)[0] ?? "").trim();
  return firstLine.length > 0 ? firstLine.slice(0, 200) : "Working plan";
}

function clipText(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function clipAtWordBoundary(text: string, max: number): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (plain.length <= max) return plain;
  const clipped = plain.slice(0, max);
  const boundary = clipped.lastIndexOf(" ");
  return boundary > 0 ? clipped.slice(0, boundary) : clipped;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 404
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
