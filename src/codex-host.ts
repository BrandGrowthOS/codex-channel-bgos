/**
 * The Codex brain: wraps @openai/codex-sdk and maps one BGOS chat to one
 * persistent Codex thread.
 *
 *   - First message in a chat: `codex.startThread()`, capture the thread id from
 *     the `thread.started` event, persist it (thread-map).
 *   - Later messages: `codex.resumeThread(id)` so context carries across daemon
 *     restarts (Codex persists the thread body under ~/.codex/sessions).
 *   - `/new`: resetChat() drops the mapping so the next message starts fresh.
 *
 * Runs are streamed (`runStreamed`) so tool events map to a live tool_progress
 * card. Auth is decided by auth-mode (D7): the child env has OPENAI_API_KEY and
 * CODEX_API_KEY stripped so exactly one credential path is active, either the
 * apikey (injected by the SDK as CODEX_API_KEY) or the existing `codex login`
 * (~/.codex/auth.json).
 */
import { Codex } from "@openai/codex-sdk";
import type { Input, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import { RunAccumulator, type ToolCard } from "./event-mapper.js";
import {
  loadThreadMap,
  getThreadId,
  setThreadId,
  resetChat,
  threadsPath,
  type ThreadMap,
} from "./thread-map.js";
import { BGOS_AGENT_HINTS } from "./agent-hints.js";
import type { AuthResolutionOk } from "./auth-mode.js";

function codexBgosHome(): string {
  return process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
}

export interface CodexHostOptions {
  auth: AuthResolutionOk;
  /** Working directory Codex operates in. Default `<home>/workspace`. */
  workdir?: string;
  /** Optional model override (CODEX_BGOS_MODEL). */
  model?: string;
}

export interface RunTurnCallbacks {
  /** Fired once the first time each tool item appears (drives tool_progress). */
  onTool?: (card: ToolCard, id: string) => void;
  /** Periodic keepalive while a turn is in flight (drives the typing dots). */
  onTick?: () => void;
}

export interface RunTurnResult {
  replyText: string;
  error: string | null;
  threadId: string | null;
}

export class CodexHost {
  readonly authMode: "chatgpt" | "apikey";
  readonly workdir: string;

  private readonly codex: Codex;
  private readonly model?: string;
  private readonly threadsFile: string;
  private readonly map: ThreadMap;

  constructor(opts: CodexHostOptions) {
    this.authMode = opts.auth.mode;
    this.workdir = opts.workdir ?? join(codexBgosHome(), "workspace");
    this.model = opts.model;
    this.threadsFile = threadsPath();
    this.map = loadThreadMap(this.threadsFile);

    mkdirSync(this.workdir, { recursive: true });
    // Codex reads AGENTS.md from the working directory, so every turn sees the
    // BGOS capability hints without a per-turn system-prompt injection.
    try {
      writeFileSync(join(this.workdir, "AGENTS.md"), BGOS_AGENT_HINTS);
    } catch {
      /* non-fatal: hints are a nicety, chat still works without them */
    }

    // Build a child env WITHOUT the OpenAI/Codex keys so exactly one auth path
    // is live and the CLI never warns about multiple auth env vars.
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === "OPENAI_API_KEY" || k === "CODEX_API_KEY") continue;
      cleanEnv[k] = v;
    }

    this.codex =
      opts.auth.mode === "apikey"
        ? new Codex({ env: cleanEnv, apiKey: opts.auth.apiKey })
        : new Codex({ env: cleanEnv });
  }

  private threadOptions(): ThreadOptions {
    const opts: ThreadOptions = {
      workingDirectory: this.workdir,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      // Let Codex read user attachments downloaded to the OS temp dir.
      additionalDirectories: [tmpdir()],
    };
    if (this.model) opts.model = this.model;
    return opts;
  }

  /** Drop a chat's thread binding so the next message starts fresh (/new). */
  resetChat(chatId: string | number): void {
    resetChat(this.threadsFile, this.map, chatId);
  }

  /** Run one turn for a chat, streaming events to the callbacks. */
  async runTurn(
    chatId: string | number,
    input: Input,
    cb: RunTurnCallbacks = {},
  ): Promise<RunTurnResult> {
    const existing = getThreadId(this.map, chatId);
    const thread = existing
      ? this.codex.resumeThread(existing, this.threadOptions())
      : this.codex.startThread(this.threadOptions());

    const acc = new RunAccumulator();
    const reported = new Set<string>();
    let thrown: string | null = null;

    let tick: ReturnType<typeof setInterval> | null = null;
    if (cb.onTick) {
      tick = setInterval(() => cb.onTick?.(), 4000);
      tick.unref?.();
    }

    try {
      const { events } = await thread.runStreamed(input);
      for await (const event of events) {
        acc.handle(event as ThreadEvent);
        if (cb.onTool) {
          for (const [id, card] of acc.toolEntries()) {
            if (!reported.has(id)) {
              reported.add(id);
              cb.onTool(card, id);
            }
          }
        }
      }
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    } finally {
      if (tick) clearInterval(tick);
    }

    const threadId = acc.threadId ?? thread.id ?? existing ?? null;
    if (threadId && threadId !== existing) {
      setThreadId(this.threadsFile, this.map, chatId, threadId);
    }

    return {
      replyText: acc.replyText,
      error: acc.error ?? thrown,
      threadId,
    };
  }
}
