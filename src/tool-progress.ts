/**
 * Tool-progress card lifecycle for Codex.
 *
 * Unlike OpenClaw (which hides tool lifecycle from the channel adapter and
 * relies on a post-hoc agent-emitted marker block), Codex streams Claude's
 * `tool_use` blocks LIVE in `src/lib/claude.ts:391` of the fork via the
 * `onToolStart` hook. The fork wires this hook into our `sendToolStart`
 * method below, so we render REAL live cards - pulsing-dot + auto-collapse
 * at end-of-turn, identical to Hermes's behavior.
 *
 * Lifecycle (per chat, per turn):
 *
 *   first sendToolStart(toolName)
 *     → POST messages { messageType:"tool_progress", toolProgress: {
 *         state:"running", tools:[{ icon, name, status:"done" }] } }
 *     → store new card id in `cardByChat[chatId]`
 *
 *   subsequent sendToolStart(toolName) within the same turn
 *     → push entry, debounce ≥600 ms (configurable), PATCH the card
 *
 *   finalizeTurn() at end of dispatch
 *     → PATCH the card to { state:"done", tools:[...] }
 *     → drop `cardByChat[chatId]`
 *
 * "All status fires post-hoc done" is the same simplification Hermes makes:
 * Claude doesn't emit per-tool result events to the streaming pipeline,
 * only the start event. By the time the next tool_use arrives (or the turn
 * ends), the previous tool has obviously settled. State="running" on the
 * top-level card stays accurate while at least one tool's run might still
 * be in flight; finalize flips it.
 *
 * Throttling: each tool fires its own PATCH only after `debounceMs`
 * elapses since the last PATCH for the same chat. Cumulative tool list
 * lives in memory; the PATCH always carries the FULL list (server-side
 * is replace-not-append for `toolProgress.tools`).
 *
 * Best-effort by design: a PATCH failure logs a warning but does not block
 * the agent's actual reply. The state is pruned from `cardByChat` so the
 * next tool starts a fresh card cleanly.
 */
import type { BgosApi } from "./bgos-api.js";

/** Per-tool entry on a tool_progress card. */
export interface ToolProgressEntry {
  icon: string;
  name: string;
  args?: string;
  status: "running" | "done" | "error";
}

interface ChatState {
  /** Backend message id of the card. POSTed on first tool, PATCHed thereafter. */
  cardId: number;
  /** Full tool list accumulated for this turn. Server replaces on each PATCH. */
  tools: ToolProgressEntry[];
  /** Last PATCH timestamp (monotonic ms). Used to throttle subsequent updates. */
  lastPatchAt: number;
  /** Pending debounced flush if a tool fired during the throttle window. */
  pendingFlush: ReturnType<typeof setTimeout> | null;
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
  }): Promise<void> {
    const { assistantId, chatId, toolName, args } = params;
    const entry: ToolProgressEntry = {
      icon: this.iconForToolName(toolName),
      name: toolName,
      status: "done", // see lifecycle comment at top - only start events stream
    };
    if (args !== undefined && args.length > 0) {
      entry.args = args.length > 120 ? args.slice(0, 119) + "…" : args;
    }

    const existing = this.cardByChat.get(chatId);
    if (existing) {
      existing.tools.push(entry);
      // Backend caps tools[] at 50 - clip so the PATCH doesn't 400.
      if (existing.tools.length > 50) {
        existing.tools = existing.tools.slice(0, 50);
      }
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
        lastPatchAt: Date.now(),
        pendingFlush: null,
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

function buildSummary(
  tools: ToolProgressEntry[],
  done: boolean,
): string {
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
  if (t === "glob" || t === "find" || t === "ls" || t.startsWith("list")) return "📂";
  if (t === "fetch" || t === "web_fetch" || t === "curl") return "🌐";
  if (t === "task" || t === "todowrite" || t === "todo_write") return "✅";
  if (t.includes("test")) return "🧪";
  if (t.includes("install") || t.includes("npm") || t.includes("pip")) return "📦";
  if (t.includes("db") || t.includes("sql") || t.includes("psql")) return "🗃️";
  // Sensible default - a single-character glyph the frontend can render
  // in the card's icon slot without breaking layout.
  return "🔧";
}
