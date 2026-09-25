import type { TodoListItem } from "@openai/codex-sdk";

import type {
  BgosApi,
  MissionSnapshot,
  PatchMissionProgressInput,
} from "./bgos-api.js";
import { STOP_PAUSE_REASON } from "./session-controls-contract.js";

const LOG = "[codex-channel-bgos]";
const DISPOSE_TIMEOUT_MS = 3_000;
const DISPOSE_SUMMARY = "Daemon stopped before the plan finished";
/**
 * How long an owner turn waits for a Stop's own pause to land before it reads
 * the mission (P6 stage 3, D11). The pause normally lands in well under a
 * second; the bound only keeps a lost unwind from holding the owner's next
 * message back for ever.
 */
const STOP_SETTLE_MAX_MS = 10_000;

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
  /**
   * Is this chat's work a native goal the goal lane already armed (stage 6).
   *
   * A goal mission is `origin: "derived"`, exactly like the ones this lane
   * makes, so attachMission's self report guard does not step aside for it
   * and the first plan of the goal's own first turn would create a SECOND
   * mission for one piece of work. Fail closed: no answer means no goal.
   */
  goalOwnsChat?: (chatId: number) => boolean;
  /**
   * Hold this chat's native goal (P6 stage 3, C-32). An owner Stop pauses the
   * chat's open mission, and a goal left active could start a continuation
   * turn before the mission_paused echo reached the goal lane. Called only
   * for a chat goalOwnsChat answers yes for, BEFORE the pause PATCH. A
   * failure is logged, never thrown.
   */
  pauseGoalForChat?: (chatId: number) => Promise<unknown>;
  /**
   * Give the goal back when the owner's next turn resumes the mission a Stop
   * paused. The goal lane answers only for a goal it holds.
   */
  resumeGoalForMission?: (missionId: number) => Promise<unknown>;
  /** The bound on an owner turn's wait for a Stop's pause. Tests shorten it. */
  stopSettleMaxMs?: number;
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

export interface StoppedByOwnerParams {
  chatId: number;
  turnToken: MissionTurnToken;
  assistantId: number;
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
  private readonly goalOwnsChat: (chatId: number) => boolean;
  private readonly pauseGoalForChat: (chatId: number) => Promise<unknown>;
  private readonly resumeGoalForMission: (missionId: number) => Promise<unknown>;
  private readonly stopSettleMaxMs: number;
  /**
   * chat -> the mission this daemon's own owner Stop paused there, recorded
   * only when the server answered with STOP_PAUSE_REASON. The owner's next
   * turn in that chat resumes it.
   */
  private readonly stopPausedByChat = new Map<number, number>();
  /**
   * Chats an owner turn has read the open mission of since this process
   * started (D12). A restart forgets every marker above, so the first owner
   * turn in each chat asks the server once.
   */
  private readonly checkedChats = new Set<number>();
  /** chat -> the owner Stop still unwinding there. An owner turn waits on it. */
  private readonly stopSettles = new Map<
    number,
    { promise: Promise<void>; resolve: () => void }
  >();

  constructor(api: BgosApi, options: MissionLaneOptions = {}) {
    this.api = api;
    this.debounceMs = options.debounceMs ?? 600;
    this.onSelfWrite = options.onSelfWrite ?? (() => {});
    this.goalOwnsChat = options.goalOwnsChat ?? (() => false);
    this.pauseGoalForChat = options.pauseGoalForChat ?? (async () => {});
    this.resumeGoalForMission = options.resumeGoalForMission ?? (async () => {});
    this.stopSettleMaxMs = options.stopSettleMaxMs ?? STOP_SETTLE_MAX_MS;
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
      // The native goal lane owns this chat and its mission already exists.
      // Standing down here rather than inside attachMission also saves the
      // active read, which is the one call that would otherwise happen on
      // every first plan of every goal turn.
      if (this.goalOwnsChat(params.chatId)) return;
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
      // A turn that ended on its own before a Stop reached it settles that
      // Stop as surely as an unwind does: there is nothing left to pause.
      this.settleStop(params.chatId);
    }
  }

  /**
   * An owner Stop is about to abort this chat's turn (the stop_turn frame or
   * the owner's /stop). Opens the chat's settle, so an owner turn racing the
   * unwinding one waits for the pause before it reads the mission (D11): a
   * quick Resume ends active, never paused. A Stop between turns opens
   * nothing and pauses nothing (D10).
   */
  noteStopRequested(chatId: number): void {
    if (!this.turnByChat.has(chatId) || this.stopSettles.has(chatId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.stopSettles.set(chatId, { promise, resolve });
  }

  /**
   * `/new`: the context this chat's Stop paused is gone, so no later owner
   * turn may resume it. The chat also counts as read, so the restart check
   * cannot find the same pause on the server and resume it after all.
   */
  clearStopMarker(chatId: number): void {
    this.stopPausedByChat.delete(chatId);
    this.checkedChats.add(chatId);
  }

  /**
   * The owner Stop aborted this turn: PAUSE the chat's open mission with
   * STOP_PAUSE_REASON, never fail it (D9, D10). The mission is the turn's
   * own managed one, else the chat's active mission read from the server,
   * which covers a Keep working goal and an owner started mission. A mission
   * already paused keeps its owner's reason. Never throws: a refused PATCH is
   * logged and the mission stays as the server has it.
   */
  async stoppedByOwner(params: StoppedByOwnerParams): Promise<void> {
    try {
      const state = this.turnByChat.get(params.chatId);
      if (!state || state.token !== params.turnToken) return;
      const operation = this.stoppedByOwnerForState(params, state);
      state.operations.add(operation);
      try {
        await operation;
      } finally {
        state.operations.delete(operation);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} mission stop pause failed chat=` +
          params.chatId +
          " err=" +
          errorText(err),
      );
    } finally {
      this.settleStop(params.chatId);
    }
  }

  /**
   * The owner's own turn is about to begin in this chat: a typed message,
   * Resume, an owner slash command that starts a turn. Resumes the mission
   * this daemon's own Stop paused there, and nothing else (D11): an owner's
   * Pause from the Mission view carries no reason and is never undone by a
   * message. Wakes, peer messages, meeting turns and goal continuation turns
   * never call this. The first owner turn in a chat after the daemon starts
   * asks the server once (D12). Never throws and never blocks the turn: a
   * failure is logged and the next owner turn tries again.
   */
  async noteOwnerTurn(chatId: number, assistantId: number): Promise<void> {
    const settle = this.stopSettles.get(chatId);
    if (settle) await waitAtMost(settle.promise, this.stopSettleMaxMs);
    if (!this.stopPausedByChat.has(chatId) && this.checkedChats.has(chatId)) return;
    try {
      const active = await this.api.getActiveMission(assistantId, { chatId });
      if (
        active !== null &&
        active.status === "paused" &&
        active.pausedReason === STOP_PAUSE_REASON &&
        belongsToChat(active, chatId)
      ) {
        await this.resumeStopPause(assistantId, chatId, active);
      }
      this.stopPausedByChat.delete(chatId);
      this.checkedChats.add(chatId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} mission stop resume failed chat=` +
          chatId +
          " err=" +
          errorText(err),
      );
    }
  }

  private async stoppedByOwnerForState(
    params: StoppedByOwnerParams,
    state: TurnState,
  ): Promise<void> {
    const { chatId, assistantId } = params;
    await state.predecessor;
    if (this.turnByChat.get(chatId) !== state || state.token !== params.turnToken) {
      return;
    }
    if (state.pendingFlush) {
      clearTimeout(state.pendingFlush);
      state.pendingFlush = null;
    }
    try {
      // What the work really reached goes out first, unless the mission is
      // already paused: a paused drain leaves its snapshot in place, which
      // would spin this loop.
      const managed = state.managedThisTurn ? state.missionId : null;
      if (managed !== null && !this.pausedMissions.has(managed)) {
        do {
          await this.flush(chatId, state);
        } while (
          this.turnByChat.get(chatId) === state &&
          (state.flushInFlight !== null || state.pendingSnapshot !== null)
        );
      }
      if (this.turnByChat.get(chatId) !== state) return;

      const missionId =
        state.managedThisTurn && state.missionId !== null
          ? state.missionId
          : await this.openMissionIn(assistantId, chatId);
      if (missionId === null) return;
      // Paused already, by the owner: theirs stands, with their reason.
      if (this.pausedMissions.has(missionId)) return;
      await this.pauseForStop(assistantId, chatId, missionId);
    } finally {
      // The turn is over. storedByChat is kept, so the next plan adopts.
      if (this.turnByChat.get(chatId) === state) this.turnByChat.delete(chatId);
    }
  }

  /** The chat's active mission, when the server says it is open in this chat. */
  private async openMissionIn(
    assistantId: number,
    chatId: number,
  ): Promise<number | null> {
    let active: MissionSnapshot | null = null;
    try {
      active = await this.api.getActiveMission(assistantId, { chatId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} mission active GET failed chat=` + chatId + " err=" + errorText(err),
      );
      return null;
    }
    if (active === null || active.status !== "active") return null;
    return belongsToChat(active, chatId) ? active.id : null;
  }

  private async pauseForStop(
    assistantId: number,
    chatId: number,
    missionId: number,
  ): Promise<void> {
    // Stamped BEFORE the write, as a close is: the gateway emits
    // mission_paused from inside the request, and an unstamped frame would be
    // told to the model as the OWNER pausing its mission.
    this.onSelfWrite(missionId);
    // Held locally first: no progress and no close from here on, and a
    // native goal cannot start a continuation turn before the echo.
    this.notePaused(missionId);
    if (this.goalOwnsChat(chatId)) {
      try {
        await this.pauseGoalForChat(chatId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `${LOG} goal hold on stop failed chat=` + chatId + " err=" + errorText(err),
        );
      }
    }
    try {
      const answer = await this.api.pauseMission(assistantId, missionId, {
        reason: STOP_PAUSE_REASON,
      });
      // Ours only when the server says so. A mission the owner had already
      // paused comes back unchanged, with their reason, and is not ours to
      // resume on their next message.
      if (answer?.pausedReason === STOP_PAUSE_REASON) {
        this.stopPausedByChat.set(chatId, missionId);
      }
    } catch (err) {
      // Refused or unreachable: the mission stays as the server has it, so it
      // is not held as paused here either, or this lane would never write to
      // it again.
      this.pausedMissions.delete(missionId);
      if (isNotFound(err)) this.forgetMission(missionId);
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} mission pause PATCH failed chat=` +
          chatId +
          " mission=" +
          missionId +
          " err=" +
          errorText(err),
      );
    }
  }

  private async resumeStopPause(
    assistantId: number,
    chatId: number,
    mission: MissionSnapshot,
  ): Promise<void> {
    this.onSelfWrite(mission.id);
    await this.api.resumeMission(assistantId, mission.id);
    this.noteResumed(mission.id);
    try {
      await this.resumeGoalForMission(mission.id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} goal resume on owner turn failed chat=` + chatId + " err=" + errorText(err),
      );
    }
    // A derived plan mission is this lane's own work again, so canAdopt takes
    // it when the plan arrives instead of creating a second one; after a
    // restart nothing else would tell the lane. A goal's mission is not: the
    // goal lane owns it and closes nothing on shutdown, the plan lane stands
    // down for its chat, and registering it here would hand it to dispose.
    if (
      mission.origin === "derived" &&
      mission.keepWorking !== true &&
      !this.goalOwnsChat(chatId)
    ) {
      this.createdMissionIds.add(mission.id);
      if (this.storedByChat.get(chatId)?.missionId !== mission.id) {
        this.storedByChat.set(chatId, {
          assistantId,
          missionId: mission.id,
          lastSnapshot: [],
        });
      }
    }
  }

  private settleStop(chatId: number): void {
    const settle = this.stopSettles.get(chatId);
    if (!settle) return;
    this.stopSettles.delete(chatId);
    settle.resolve();
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

  /**
   * Fail managed missions, cancel deferred work, and forget ownership.
   *
   * A PAUSED mission is left paused (D12): it has no work in flight, so
   * "Daemon stopped before the plan finished" is not what happened to it,
   * and failing it would turn every Stop into Did not finish at the next
   * update restart.
   */
  async dispose(): Promise<void> {
    const managed = new Map<
      string,
      { assistantId: number; missionId: number }
    >();
    for (const stored of this.storedByChat.values()) {
      if (this.pausedMissions.has(stored.missionId)) continue;
      managed.set(`${stored.assistantId}:${stored.missionId}`, {
        assistantId: stored.assistantId,
        missionId: stored.missionId,
      });
    }
    for (const state of this.turnByChat.values()) {
      if (state.pendingFlush) clearTimeout(state.pendingFlush);
      if (
        state.managedThisTurn &&
        state.missionId !== null &&
        !this.pausedMissions.has(state.missionId)
      ) {
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
    this.stopPausedByChat.clear();
    this.checkedChats.clear();
    for (const settle of this.stopSettles.values()) settle.resolve();
    this.stopSettles.clear();

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

/** An old backend echoes no chat; a chat scoped one must echo this one. */
function belongsToChat(mission: MissionSnapshot, chatId: number): boolean {
  return (
    mission.chatId === undefined ||
    mission.chatId === null ||
    mission.chatId === chatId
  );
}

async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((done) => {
        timer = setTimeout(done, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
