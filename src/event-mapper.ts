/**
 * Fold a Codex `runStreamed()` event stream into the pieces the daemon posts to
 * BGOS: the reply text (agent_message items), the tool_progress cards
 * (command_execution / file_change / mcp_tool_call / web_search items), the
 * token usage, the captured thread id, and any error.
 *
 * Codex streams real tool events, so tool_progress is host-driven here (an
 * advantage over OpenClaw, which has to ask the agent to self-report). The daemon
 * reads `tools()` after each event to POST a running card on the first tool and
 * PATCH it as tools stream in, then finalizes to "done" at turn end.
 *
 * SDK item/event shapes are @openai/codex-sdk 0.144.1 (see docs/DESIGN.md).
 */
import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";

export type ToolStatus = "running" | "done" | "error";

export interface ToolCard {
  icon: string;
  name: string;
  args?: string;
  status: ToolStatus;
}

const ARGS_MAX = 120;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > ARGS_MAX ? t.slice(0, ARGS_MAX) : t;
}

function statusFrom(raw: unknown): ToolStatus {
  if (raw === "in_progress") return "running";
  if (raw === "failed") return "error";
  return "done";
}

/** Map a Codex ThreadItem to a display card, or null if it is not a tool. */
export function toolCardFromItem(item: ThreadItem): ToolCard | null {
  switch (item.type) {
    case "command_execution":
      return {
        icon: "⚡",
        name: "shell",
        args: clip(item.command ?? ""),
        status: statusFrom(item.status),
      };
    case "file_change": {
      const paths = (item.changes ?? [])
        .map((c) => `${c.kind} ${c.path}`)
        .join(", ");
      return {
        icon: "✏️",
        name: "edit",
        args: clip(paths),
        status: statusFrom(item.status),
      };
    }
    case "mcp_tool_call": {
      let args = "";
      try {
        args = item.arguments != null ? JSON.stringify(item.arguments) : "";
      } catch {
        args = "";
      }
      return {
        icon: "🔌",
        name: `${item.server}.${item.tool}`,
        args: clip(args),
        status: statusFrom(item.status),
      };
    }
    case "web_search":
      return {
        icon: "🔎",
        name: "web_search",
        args: clip(item.query ?? ""),
        status: "done",
      };
    default:
      return null;
  }
}

function itemText(item: ThreadItem): string | null {
  return item.type === "agent_message" ? item.text ?? "" : null;
}

/** Stateful accumulator: feed it each event with handle(). */
export class RunAccumulator {
  threadId: string | null = null;
  usage: Usage | null = null;
  error: string | null = null;

  private readonly messages: string[] = [];
  private readonly toolOrder: string[] = [];
  private readonly toolById = new Map<string, ToolCard>();

  handle(event: ThreadEvent): void {
    switch (event.type) {
      case "thread.started":
        this.threadId = event.thread_id;
        return;
      case "turn.completed":
        this.usage = event.usage;
        return;
      case "turn.failed":
        this.error = event.error?.message ?? "turn failed";
        return;
      case "error":
        this.error = event.message ?? "error";
        return;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        this.absorbItem(event.item, event.type === "item.completed");
        return;
      }
      default:
        return;
    }
  }

  private absorbItem(item: ThreadItem, completed: boolean): void {
    const text = itemText(item);
    if (text !== null) {
      if (completed && text.trim().length > 0) this.messages.push(text);
      return;
    }
    const card = toolCardFromItem(item);
    if (!card) return;
    const id = (item as { id: string }).id;
    if (!this.toolById.has(id)) this.toolOrder.push(id);
    this.toolById.set(id, card);
  }

  /** The accumulated reply text (agent_message items joined by a blank line). */
  get replyText(): string {
    return this.messages.join("\n\n");
  }

  /** Whether any tool item has appeared this run. */
  get hadToolActivity(): boolean {
    return this.toolOrder.length > 0;
  }

  /** The tool cards in first-seen order. */
  tools(): ToolCard[] {
    return this.toolOrder.map((id) => this.toolById.get(id)!).filter(Boolean);
  }

  /** [id, card] pairs in first-seen order (lets the host report each tool once). */
  toolEntries(): Array<[string, ToolCard]> {
    return this.toolOrder.map(
      (id) => [id, this.toolById.get(id)!] as [string, ToolCard],
    );
  }
}
