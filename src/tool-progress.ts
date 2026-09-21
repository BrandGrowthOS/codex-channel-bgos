/**
 * One tool-progress card per chat/turn. Native item ids update entries in place
 * from running to done/error. The adapter serializes publication, then waits
 * for result events before finalizing. Legacy sendToolStart callers without
 * ids retain their historical post-hoc done behavior.
 *
 * Patches carry the full bounded list and are debounced. Failures never block
 * the agent's reply. Cards are pruned after finalizeTurn.
 */
import type { BgosApi } from "./bgos-api.js";
import { clipText } from "./clip-text.js";

/** Per-tool entry on a tool_progress card. */
export interface ToolProgressEntry {
  icon: string;
  name: string;
  args?: string;
  status: "running" | "done" | "error";
  /**
   * Stage 4 additions, every one optional: an older backend drops what it
   * does not know and an older app draws the row exactly as before. The
   * sender fills them in only when it has them, so an absent field never
   * travels as an empty string.
   *
   * `kind` absent reads as `tool`. Output, stderr, exit codes and diffs are
   * deliberately NOT here: stage 7 owns those, and a diff never leaves the
   * agent's machine.
   */
  kind?: "tool" | "subagent";
  /** First file path the row touched, already shortened by the sender. */
  path?: string;
  /** How many paths the row touched, when it touched more than the first. */
  pathCount?: number;
  /** One short human qualifier (a worker's state word), never output. */
  detail?: string;
  durationMs?: number;
}

/** Rows kept when the cap bites, plus the one row that says what was dropped. */
const ROW_CAP = 50;
const ROWS_KEPT_AT_CAP = ROW_CAP - 1;

interface ChatState {
  /** Backend message id of the card. POSTed on first tool, PATCHed thereafter. */
  cardId: number;
  /** Full tool list accumulated for this turn. Server replaces on each PATCH. */
  tools: ToolProgressEntry[];
  itemIds: Array<string | undefined>;
  /** Last PATCH timestamp (monotonic ms). Used to throttle subsequent updates. */
  lastPatchAt: number;
  /** Pending debounced flush if a tool fired during the throttle window. */
  pendingFlush: ReturnType<typeof setTimeout> | null;
  /** The PATCH currently going out for this card, or null. */
  flushInFlight: Promise<void> | null;
  /** Real rows dropped by the cap so far, for the synthetic head row. */
  dropped: number;
}

export interface ToolProgressOptions {
  /** Minimum delay between PATCHes for the same chat. Default 600 ms -
   *  matches Hermes's `_PROGRESS_EDIT_INTERVAL/2` throttle so tightly-
   *  packed tools don't slam the backend. */
  debounceMs?: number;
  /** Friendly-name → emoji map override. The default covers Claude Code
   *  CLI's canonical tool names (`Bash`, `Read`, `Edit`, …). */
  iconForToolName?: (toolName: string) => string;
}

/**
 * Per-chat card lifecycle for Codex. Construct one per `BGOSAdapter`
 * (the adapter owns it; the fork interacts via `ReplyHandle.sendToolStart`
 * + `ReplyHandle.finalizeTurn`).
 */
export class ToolProgressOrchestrator {
  private readonly api: BgosApi;
  private readonly debounceMs: number;
  private readonly iconForToolName: (toolName: string) => string;
  private readonly cardByChat = new Map<number, ChatState>();

  constructor(api: BgosApi, options: ToolProgressOptions = {}) {
    this.api = api;
    this.debounceMs = options.debounceMs ?? 600;
    this.iconForToolName = options.iconForToolName ?? defaultIconForToolName;
  }

  /**
   * Record that a tool just started on the agent's side and surface it
   * to BGOS. First call per chat POSTs a new card; subsequent calls PATCH.
   *
   * `toolName` should be the canonical tool id (`Bash`, `Read`, `Edit`,
   * `Grep`, …) - Codex's `friendlyToolName()` already normalizes this.
   * `args` is an optional short summary (≤120 chars, plugin truncates).
   */
  async sendToolStart(params: {
    assistantId: number;
    chatId: number;
    toolName: string;
    args?: string;
    itemId?: string;
    status?: ToolProgressEntry["status"];
    /** The sender's own glyph. Absent falls back to the name mapper. */
    icon?: string;
    kind?: ToolProgressEntry["kind"];
    path?: string;
    pathCount?: number;
    detail?: string;
    durationMs?: number;
  }): Promise<void> {
    const { assistantId, chatId, toolName, args } = params;
    // Every clip here goes through clipText: a bare slice can cut a surrogate
    // pair in half, and Postgres refuses a lone surrogate inside JSONB, so the
    // whole card would be rejected rather than drawn short.
    const entry: ToolProgressEntry = {
      icon:
        params.icon !== undefined && params.icon.length > 0
          ? clipText(params.icon, 16)
          : this.iconForToolName(toolName),
      name: toolName,
      status: params.status ?? "done", // legacy callers have no result event
    };
    if (args !== undefined && args.length > 0) {
      entry.args = args.length > 120 ? clipText(args, 119) + "…" : args;
    }
    // Only what we actually have: an absent field must not reach the wire as
    // an empty string, so an in place merge cannot blank a row it knows less
    // about than the row it is updating.
    if (params.kind !== undefined) entry.kind = params.kind;
    if (params.path !== undefined && params.path.length > 0)
      entry.path = clipText(params.path, 200);
    if (typeof params.pathCount === "number" && params.pathCount >= 1)
      entry.pathCount = Math.round(params.pathCount);
    if (params.detail !== undefined && params.detail.length > 0)
      entry.detail = clipText(params.detail, 120);
    if (typeof params.durationMs === "number" && params.durationMs >= 0)
      entry.durationMs = Math.round(params.durationMs);

    const existing = this.cardByChat.get(chatId);
    if (existing) {
      const index = params.itemId
        ? existing.itemIds.indexOf(params.itemId)
        : -1;
      if (index >= 0) {
        const merged = { ...existing.tools[index], ...entry };
        if (clearsDetail(params)) delete merged.detail;
        existing.tools[index] = merged as ToolProgressEntry;
      } else {
        existing.tools.push(entry);
        existing.itemIds.push(params.itemId);
      }
      clipToCap(existing);
      await this.maybePatchSoon(chatId);
      return;
    }

    // First tool of the turn - POST a new card.
    try {
      const created = await this.api.postMessage({
        assistantId,
        chatId,
        sender: "assistant",
        text: buildSummary([entry], false),
        messageType: "tool_progress",
        toolProgress: { state: "running", tools: [entry] },
      });
      this.cardByChat.set(chatId, {
        cardId: created.id,
        tools: [entry],
        itemIds: [params.itemId],
        lastPatchAt: Date.now(),
        pendingFlush: null,
        flushInFlight: null,
        dropped: 0,
      });
    } catch (err) {
      // POST failed - log + drop. Next tool will retry the POST cleanly.
      // eslint-disable-next-line no-console
      console.warn(
        "[codex-channel-bgos] tool_progress POST failed chat=" +
          chatId +
          " err=" +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * End-of-turn signal. Flushes any pending PATCH, then PATCHes the card
   * one last time with state="done". Idempotent - no-op when no active
   * card exists for this chat.
   */
  async finalizeTurn(chatId: number): Promise<void> {
    const state = this.cardByChat.get(chatId);
    if (!state) return;
    // Clear pending flush - we're about to send the final PATCH ourselves.
    if (state.pendingFlush) {
      clearTimeout(state.pendingFlush);
      state.pendingFlush = null;
    }
    this.cardByChat.delete(chatId);
    // A running PATCH already going out must land first, or it overwrites the
    // final list and leaves the card stuck on "running".
    if (state.flushInFlight) await state.flushInFlight.catch(() => undefined);

    try {
      await this.api.patchMessage(state.cardId, {
        text: buildSummary(state.tools, true),
        toolProgress: { state: "done", tools: state.tools },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[codex-channel-bgos] tool_progress finalize PATCH failed chat=" +
          chatId +
          " card=" +
          state.cardId +
          " err=" +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Disconnect path: cancel pending debounced PATCHes so we don't leak
   * timers across an adapter restart. Does NOT issue final PATCHes - the
   * next adapter boot will see the cards in state="running" until the
   * frontend's derived-done heuristic collapses them (BGOS desktop v2.5.4+).
   */
  dispose(): void {
    for (const [, state] of this.cardByChat) {
      if (state.pendingFlush) {
        clearTimeout(state.pendingFlush);
        state.pendingFlush = null;
      }
    }
    this.cardByChat.clear();
  }

  /** Test-only - surface internal state so vitest can assert. */
  get _internal(): { activeChats: number[] } {
    return { activeChats: Array.from(this.cardByChat.keys()) };
  }

  private async maybePatchSoon(chatId: number): Promise<void> {
    const state = this.cardByChat.get(chatId);
    if (!state) return;
    const now = Date.now();
    const elapsed = now - state.lastPatchAt;
    if (elapsed >= this.debounceMs) {
      await this.flush(chatId);
      return;
    }
    // Within debounce window - schedule a single deferred flush. Repeat
    // calls within the window coalesce (later writes supersede earlier
    // ones because we always send the FULL tool list).
    if (state.pendingFlush) return;
    state.pendingFlush = setTimeout(() => {
      void this.flush(chatId);
    }, this.debounceMs - elapsed);
  }

  private async flush(chatId: number): Promise<void> {
    const state = this.cardByChat.get(chatId);
    if (!state) return;
    if (state.pendingFlush) {
      clearTimeout(state.pendingFlush);
      state.pendingFlush = null;
    }
    if (state.flushInFlight) {
      // One PATCH per card at a time. Two in flight can land out of order and
      // leave a stale list on screen; the running one drains what we have and
      // the next tool (or the finalize) carries anything newer.
      await state.flushInFlight.catch(() => undefined);
      return;
    }
    const operation = this.drain(chatId, state).finally(() => {
      if (state.flushInFlight === operation) state.flushInFlight = null;
    });
    state.flushInFlight = operation;
    await operation;
  }

  private async drain(chatId: number, state: ChatState): Promise<void> {
    state.lastPatchAt = Date.now();
    try {
      await this.api.patchMessage(state.cardId, {
        text: buildSummary(state.tools, false),
        toolProgress: { state: "running", tools: state.tools },
      });
    } catch (err) {
      // Card may have been deleted upstream - drop our tracking so the
      // next tool starts cleanly via POST. Anything else is just a flaky
      // PATCH; we'll retry on the next tool.
      const msg = err instanceof Error ? err.message : String(err);
      if (/404|not found/i.test(msg)) {
        this.cardByChat.delete(chatId);
      }
      // eslint-disable-next-line no-console
      console.warn(
        "[codex-channel-bgos] tool_progress PATCH failed chat=" +
          chatId +
          " card=" +
          state.cardId +
          " err=" +
          msg,
      );
    }
  }
}

/**
 * Hold the card inside the backend's 50 row cap by dropping from the FRONT,
 * not the back: the end of a turn is what the owner is looking at, and the
 * old clip froze a long turn at its first 50 tools. One synthetic head row
 * keeps the count honest, and `itemIds` moves in lockstep so a later in place
 * update still writes into the row it names. Called AFTER the push or merge,
 * never before, so an update to a row about to be dropped still applies.
 */
function clipToCap(state: ChatState): void {
  if (state.tools.length <= ROW_CAP) return;
  const hasHead = state.dropped > 0;
  const rows = hasHead ? state.tools.slice(1) : state.tools;
  const ids = hasHead ? state.itemIds.slice(1) : state.itemIds;
  state.dropped += rows.length - ROWS_KEPT_AT_CAP;
  state.tools = [earlierRow(state.dropped), ...rows.slice(-ROWS_KEPT_AT_CAP)];
  // The head row carries no native id, so `indexOf` of a real id never hits it.
  state.itemIds = [undefined, ...ids.slice(-ROWS_KEPT_AT_CAP)];
}

/**
 * Write once, with exactly one exception, and this is the decision:
 *
 *  - `path` and `pathCount` are STICKY. A later event that knows less about a
 *    row must never blank them, because a file a row has already touched does
 *    not become unknown. An `item/mcpToolCall/progress` line carries no path
 *    and is not evidence that the row has none.
 *  - `detail` is CLEARED when a SUBAGENT row reports none. On a subagent row
 *    `detail` IS the worker's state word ("running", "1 running, 1 done"), so
 *    an event that reports no state is reporting that the state it named has
 *    ended. Leaving "running" on a worker that stopped is worse than leaving
 *    the slot blank, and only the sender can tell the two apart.
 *
 * A tool row's `detail` stays sticky: there it is a free qualifier, not a
 * state, and a progress line that simply says nothing new must not erase the
 * last thing the server said.
 */
function clearsDetail(params: {
  kind?: ToolProgressEntry["kind"];
  detail?: string;
}): boolean {
  return (
    params.kind === "subagent" &&
    (params.detail === undefined || params.detail.length === 0)
  );
}

function earlierRow(dropped: number): ToolProgressEntry {
  const noun = dropped === 1 ? "tool" : "tools";
  return {
    icon: "…",
    name: "earlier",
    args: `${dropped} earlier ${noun}`,
    status: "done",
  };
}

function buildSummary(tools: ToolProgressEntry[], done: boolean): string {
  if (tools.length === 0) {
    return done ? "No tools used" : "Working…";
  }
  const names = tools.slice(0, 4).map((t) => t.name);
  const tail = tools.length > 4 ? `, +${tools.length - 4} more` : "";
  if (done) {
    const noun = tools.length === 1 ? "tool" : "tools";
    return `Used ${tools.length} ${noun} · ${names.join(", ")}${tail}`;
  }
  return `Working… · ${names.join(", ")}${tail}`;
}

/**
 * Default emoji mapper. Mirrors Hermes's per-tool icons + Codex's own
 * Telegram progress format. Lowercase comparison covers Claude Code CLI's
 * `Bash`/`Read`/`Edit`/`Grep`/… as well as the friendlyToolName variants
 * the fork passes through.
 */
function defaultIconForToolName(toolName: string): string {
  const t = toolName.toLowerCase();
  if (t === "bash" || t === "terminal" || t.startsWith("exec")) return "💻";
  if (t === "read" || t === "read_file" || t.startsWith("read")) return "📖";
  if (t === "edit" || t === "write" || t === "write_file") return "📝";
  if (t === "grep" || t === "search" || t.startsWith("search")) return "🔎";
  if (t === "glob" || t === "find" || t === "ls" || t.startsWith("list"))
    return "📂";
  if (t === "fetch" || t === "web_fetch" || t === "curl") return "🌐";
  if (t === "task" || t === "todowrite" || t === "todo_write") return "✅";
  if (t.includes("test")) return "🧪";
  if (t.includes("install") || t.includes("npm") || t.includes("pip"))
    return "📦";
  if (t.includes("db") || t.includes("sql") || t.includes("psql")) return "🗃️";
  // Sensible default - a single-character glyph the frontend can render
  // in the card's icon slot without breaking layout.
  return "🔧";
}
