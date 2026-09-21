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
import { OUTPUT_MAX, tailClip } from "./output-tail.js";

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
   * `kind` absent reads as `tool`. Stage 7 adds the last four: what a command
   * printed, the code it exited with, and the lines an edit moved. A diff
   * BODY still never leaves the agent's machine; only two integers do.
   */
  kind?: "tool" | "subagent";
  /** First file path the row touched, already shortened by the sender. */
  path?: string;
  /** How many paths the row touched, when it touched more than the first. */
  pathCount?: number;
  /** One short human qualifier (a worker's state word), never output. */
  detail?: string;
  durationMs?: number;
  /**
   * The masked TAIL of what a command printed, at most 2048 characters. It is
   * the only field on this row measured in kilobytes and it rides every
   * coalesced PATCH, which is why the card also has a total budget for it
   * (see `spendOutputBudget`).
   */
  output?: string;
  /** The process exit code. Zero is legal and is the commonest one there is. */
  exitCode?: number;
  /** Lines this edit added. Absent when nothing was measured. */
  linesAdded?: number;
  /** Lines this edit removed. Absent when nothing was measured. */
  linesRemoved?: number;
}

/**
 * The largest line count the wire carries. The platform declares an integer
 * from zero to a million on both counts and refuses the WHOLE patch for
 * anything else, and a refusal is not recovered here: the offending row rides
 * every later patch and the card freezes at its last accepted state. So a
 * count past this is dropped, exactly as an out of range exit code is, and
 * the row keeps its path and its status without a `+N -M`.
 */
export const LINE_COUNT_MAX = 1_000_000;

/** A line count the wire accepts, or null. Rounds first, as the sender did. */
export function lineCountForWire(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= LINE_COUNT_MAX ? rounded : null;
}

/**
 * The turn's own clock, as the RUNTIME reported it, in epoch milliseconds.
 *
 * Held per chat OUTSIDE the card, because the card is only created on the
 * first tool and the clock arrives at the end of the turn, by which time the
 * chat may have no card at all.
 */
export interface TurnCardMeta {
  startedAtMs: number;
  finishedAtMs: number;
}

/** The clock as the wire carries it: two ISO 8601 strings, or nothing. */
interface CardClock {
  startedAt: string;
  finishedAt: string;
}

/**
 * Characters of output one CARD may carry in total, spent on the newest rows
 * first. The per row cap bounds one row; this bounds the whole array, which
 * is what actually rides every PATCH and every WS frame to every viewer.
 */
const CARD_OUTPUT_BUDGET = 8192;

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
  /**
   * The turn clock per chat, deliberately NOT on `ChatState`: a turn can
   * report its clock for a chat whose card was never created, and a clock
   * left behind would be the previous turn's minutes on the next turn's card.
   */
  private readonly metaByChat = new Map<number, CardClock>();

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
    /** The masked tail of what the command printed. */
    output?: string;
    /** The process exit code, zero included. */
    exitCode?: number;
    linesAdded?: number;
    linesRemoved?: number;
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
    // The sender already masked and cut this to its tail; the cut is repeated
    // here because the platform refuses the whole PATCH over the cap, and the
    // cost of a refusal is the card for the rest of the turn. `tailClip` and
    // not `clipText`: a tail keeps its END, and a lone surrogate at the front
    // is what Postgres refuses inside JSONB.
    if (params.output !== undefined && params.output.length > 0)
      entry.output = tailClip(params.output, OUTPUT_MAX);
    // `typeof`, never a falsy check, for all three: a successful command exits
    // with zero, and a zero count a sender measured is still a measurement.
    if (typeof params.exitCode === "number" && Number.isFinite(params.exitCode))
      entry.exitCode = Math.round(params.exitCode);
    // The counts travel as a PAIR: one of them refused and the other sent
    // reads as a measured zero on the half that is missing, so a value the
    // wire will not carry costs both.
    const added = lineCountForWire(params.linesAdded);
    const removed = lineCountForWire(params.linesRemoved);
    const refused =
      (params.linesAdded !== undefined && added === null) ||
      (params.linesRemoved !== undefined && removed === null);
    if (!refused) {
      if (added !== null) entry.linesAdded = added;
      if (removed !== null) entry.linesRemoved = removed;
    }

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
      spendOutputBudget(existing);
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
   * Record the clock THIS TURN's runtime reported, for the card about to be
   * closed. Call it before `finalizeTurn`, because the final PATCH is the
   * only one that carries it.
   *
   * Both ends or neither: a card that shows a start with no finish would be
   * asking the app to invent the missing half, and the app is forbidden from
   * reading a message timestamp for it. A value that cannot be written as an
   * ISO 8601 instant is no clock at all.
   */
  noteTurnMeta(chatId: number, meta: TurnCardMeta): void {
    const startedAt = isoInstant(meta?.startedAtMs);
    const finishedAt = isoInstant(meta?.finishedAtMs);
    if (!startedAt || !finishedAt) return;
    this.metaByChat.set(chatId, { startedAt, finishedAt });
  }

  /**
   * End-of-turn signal. Flushes any pending PATCH, then PATCHes the card
   * one last time with state="done". Idempotent - no-op when no active
   * card exists for this chat.
   */
  async finalizeTurn(chatId: number): Promise<void> {
    // BEFORE the early return, always: a turn that ran no tools has no card,
    // and a clock left behind here is the finished turn's minutes drawn on
    // the next turn's card.
    const clock = this.metaByChat.get(chatId);
    this.metaByChat.delete(chatId);
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
        // The clock rides the FINAL patch and no other: a turn still running
        // has no finish time, and the running card is redrawn every 600 ms.
        toolProgress: { state: "done", tools: state.tools, ...(clock ?? {}) },
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
    this.metaByChat.clear();
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
 * Hold the card inside its total output budget by spending it on the NEWEST
 * rows, for the same reason `clipToCap` drops rows from the front: the end of
 * a turn is what the owner is looking at.
 *
 * Walk from the last row back, adding each output's length to a running
 * total. The first row whose output would take the total past the budget
 * loses its `output`, and so does every older row, whatever its size, so the
 * card can never keep an old scrap while a newer one was refused. Only
 * `output` is ever dropped: the exit code, the counts, the detail and the
 * duration are what the owner reads at a glance and they cost almost nothing.
 *
 * A dropped output is invisible in the app: the row simply has no chevron.
 */
function spendOutputBudget(state: ChatState): void {
  let spent = 0;
  let exhausted = false;
  for (let i = state.tools.length - 1; i >= 0; i -= 1) {
    const row = state.tools[i]!;
    if (row.output === undefined) continue;
    if (!exhausted && spent + row.output.length <= CARD_OUTPUT_BUDGET) {
      spent += row.output.length;
      continue;
    }
    exhausted = true;
    delete row.output;
  }
}

/** One epoch millisecond reading as an ISO 8601 instant, or null. */
function isoInstant(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
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
