import type { TodoListItem } from "@openai/codex-sdk";

import type {
  BgosApi,
  PatchMissionProgressInput,
} from "./bgos-api.js";

const LOG = "[codex-channel-bgos]";

type TodoEventType = "item.started" | "item.updated" | "item.completed";
type TodoStep = TodoListItem["items"][number];

interface StoredMission {
  assistantId: number;
  missionId: number;
  lastSnapshot: TodoStep[];
}

interface TurnState {
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
}

export interface BeginMissionTurnParams {
  assistantId: number;
  chatId: number;
  prompt: string;
}

export interface HandleTodoListParams {
  chatId: number;
  eventType: TodoEventType;
  item: TodoListItem;
}

export interface FinalizeMissionTurnParams {
  chatId: number;
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

  constructor(api: BgosApi, options: MissionLaneOptions = {}) {
    this.api = api;
    this.debounceMs = options.debounceMs ?? 600;
  }

  /** Start one Codex turn and remember the prompt used for its mission title. */
  beginTurn(params: BeginMissionTurnParams): void {
    const existing = this.turnByChat.get(params.chatId);
    if (existing) this.detachState(existing);
    this.turnByChat.set(params.chatId, {
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
    });
  }

  /** Consume one todo_list event from the current turn. */
  async handleTodoList(params: HandleTodoListParams): Promise<void> {
    const state = this.turnByChat.get(params.chatId);
    if (!state) return;

    if (!state.firstTodoSeen) {
      state.firstTodoSeen = true;
      if (params.item.items.length < 3) return;
      await this.attachMission(params.chatId, state, params.item);
      return;
    }

    if (!state.managedThisTurn || state.missionId === null) return;
    if (params.eventType !== "item.updated") return;

    this.recordUpdate(state, params.item.items);
    await this.maybePatchSoon(params.chatId);
  }

  /** Flush progress, then complete or fail the mission managed by this turn. */
  async finalizeTurn(params: FinalizeMissionTurnParams): Promise<void> {
    const state = this.turnByChat.get(params.chatId);
    if (!state) return;
    if (state.pendingFlush) {
      clearTimeout(state.pendingFlush);
      state.pendingFlush = null;
    }

    await this.flush(params.chatId);
    if (this.turnByChat.get(params.chatId) !== state) return;

    const missionId = state.missionId;
    if (!state.managedThisTurn || missionId === null) {
      this.turnByChat.delete(params.chatId);
      return;
    }

    const failed = params.error !== undefined && params.error !== null;
    const summary = clipAtWordBoundary(
      failed ? params.error ?? "" : params.finalText ?? "",
      500,
    );
    const body = summary.length > 0 ? { summary } : {};

    try {
      if (failed) {
        await this.api.failMission(state.assistantId, missionId, body);
      } else {
        await this.api.completeMission(state.assistantId, missionId, body);
      }
      this.forgetMission(missionId);
    } catch (err) {
      if (isNotFound(err)) this.clearMission(params.chatId, state, missionId);
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} mission ${failed ? "fail" : "complete"} PATCH failed chat=` +
          params.chatId +
          " mission=" +
          missionId +
          " err=" +
          errorText(err),
      );
    } finally {
      if (this.turnByChat.get(params.chatId) === state) {
        this.turnByChat.delete(params.chatId);
      }
    }
  }

  /** Cancel deferred work and forget process-local mission ownership. */
  dispose(): void {
    for (const state of this.turnByChat.values()) {
      if (state.pendingFlush) clearTimeout(state.pendingFlush);
    }
    this.turnByChat.clear();
    this.storedByChat.clear();
    this.createdMissionIds.clear();
  }

  private async attachMission(
    chatId: number,
    state: TurnState,
    item: TodoListItem,
  ): Promise<void> {
    let active = null;
    try {
      active = await this.api.getActiveMission(state.assistantId);
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
    const canAdopt =
      active !== null &&
      (active.status === "active" || active.status === "paused") &&
      active.origin === "derived" &&
      this.createdMissionIds.has(active.id);

    if (canAdopt && active !== null) {
      this.setMission(chatId, state, active.id, item.items);
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
        progress,
        origin: "derived",
        firstFeedText: `Planned ${item.items.length} steps`,
      });
      if (!Number.isInteger(created?.id) || created.id <= 0) {
        throw new Error("mission create returned no valid id");
      }
      this.createdMissionIds.add(created.id);
      if (this.turnByChat.get(chatId) === state) {
        this.setMission(chatId, state, created.id, item.items);
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
  ): void {
    for (const [otherChatId, other] of this.turnByChat) {
      if (other === state || other.assistantId !== state.assistantId) continue;
      this.detachState(other);
      this.storedByChat.delete(otherChatId);
    }
    for (const [storedChatId, stored] of this.storedByChat) {
      if (
        storedChatId !== chatId &&
        stored.assistantId === state.assistantId
      ) {
        this.storedByChat.delete(storedChatId);
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
    for (let index = 0; index < next.length; index += 1) {
      const before = state.latestObserved[index];
      const after = next[index]!;
      if (before?.completed === false && after.completed) {
        state.pendingWorkedText = clipText(after.text, 200);
      }
    }
    state.latestObserved = next;
    state.pendingSnapshot = copyItems(next);
  }

  private async maybePatchSoon(chatId: number): Promise<void> {
    const state = this.turnByChat.get(chatId);
    if (!state || state.missionId === null) return;
    const elapsed = Date.now() - state.lastPatchAt;
    if (elapsed >= this.debounceMs) {
      await this.flush(chatId);
      return;
    }
    if (state.pendingFlush) return;
    state.pendingFlush = setTimeout(() => {
      void this.flush(chatId);
    }, this.debounceMs - elapsed);
  }

  private async flush(chatId: number): Promise<void> {
    let state = this.turnByChat.get(chatId);
    if (!state) return;
    if (state.flushInFlight) {
      await state.flushInFlight;
      state = this.turnByChat.get(chatId);
      if (state?.pendingSnapshot) await this.flush(chatId);
      return;
    }
    if (state.missionId === null || state.pendingSnapshot === null) return;
    if (state.pendingFlush) {
      clearTimeout(state.pendingFlush);
      state.pendingFlush = null;
    }

    const missionId = state.missionId;
    const snapshot = state.pendingSnapshot;
    const workedText = state.pendingWorkedText;
    state.pendingSnapshot = null;
    state.pendingWorkedText = null;
    state.lastPatchAt = Date.now();

    const stored = this.storedByChat.get(chatId);
    if (stored?.missionId === missionId) {
      stored.lastSnapshot = copyItems(snapshot);
    }

    const body: PatchMissionProgressInput = {
      progress: {
        current: completedCount(snapshot),
        total: snapshot.length,
      },
    };
    if (workedText !== null) {
      body.feedEntry = { kind: "worked", text: workedText };
    }

    const operation = (async () => {
      try {
        await this.api.patchMissionProgress(
          state.assistantId,
          missionId,
          body,
        );
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
      } finally {
        state.flushInFlight = null;
      }
    })();
    state.flushInFlight = operation;
    await operation;
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
      if (stored.missionId === missionId) this.storedByChat.delete(storedChatId);
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
