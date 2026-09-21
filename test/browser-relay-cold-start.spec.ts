/**
 * The first browser call in a chat this process has not served yet.
 *
 * `assistantForChat` answers null rather than guessing, so on a daemon owning
 * two or more assistants the relay exists only if the chat-to-assistant pair
 * was already recorded when the thread's config was built. Every path that can
 * start a Codex thread records it first, which used to be a claim in a review
 * report; these tests are the claim turned into a gate.
 *
 * Two layers:
 *   1. A coverage guard over `src/`: the set of methods that call into the
 *      host's thread-starting API is pinned. Add a fifth and this fails until
 *      the pair is recorded on that path too and the allowlist says where.
 *   2. Four runtime proofs, one per path, driving the real prototype methods
 *      with a fake host that asks the REAL `browserRelay` resolver at the
 *      moment the thread config would be built. A cold chat on a multi-agent
 *      daemon must come back with the right assistant id, not null.
 *
 * No daemon, model, network or backend runs.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import { MeetingLane } from "../src/meeting-lane.js";

const SRC = join(fileURLToPath(new URL("../src", import.meta.url)));
const TOKEN = "pair-cold-0123456789abcdefghij";
const OWNED: [number, string][] = [
  [10, "codex"],
  [11, "codex-2"],
];
/** The chat no event in this process has ever named before the call. */
const COLD_CHAT = 4242;

/**
 * Every method allowed to reach the host's thread-starting API, with the
 * method that records the chat's assistant ahead of it. Keep this list and the
 * runtime proofs below in step.
 */
const THREAD_STARTERS: Record<string, string> = {
  "adapter.ts#executeAndReply": "runAndReply records the pair before queueing",
  "adapter.ts#handleControl": "handleControl records the pair before the ack",
  "meeting-lane.ts#run": "run calls deps.noteChat before the turn",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

/**
 * A call into the host's thread-starting API. The shape is deliberately loose:
 * `.runTurn(`, `.runTurn?.(`, `.runDetached ?. (` all reach the same API, and a
 * pattern that only knows the plain form is one a new path slips past without
 * anyone meaning to (the reviewer's probe was `host?.runTurn?.(1)`).
 */
const THREAD_START_CALL = /\.(runTurn|runDetached)\s*\??\.?\s*\(/;

/** The nearest class-member declaration above a line, prettier-formatted. */
function enclosingMethod(lines: string[], index: number): string {
  const decl =
    /^ {2}(?:private |public |protected )?(?:async )?([A-Za-z_]\w*)\s*\(/;
  for (let i = index; i >= 0; i -= 1) {
    const hit = decl.exec(lines[i]);
    if (hit) return hit[1];
  }
  return "<top level>";
}

/**
 * Every thread-starting call in one file's source, keyed `<file>#<method>` with
 * a count. Taking a source string rather than a path is what lets the case
 * below feed it a mutation without writing to `src/`.
 */
function threadStarters(name: string, source: string): Map<string, number> {
  const found = new Map<string, number>();
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (!THREAD_START_CALL.test(line)) return;
    const key = `${name}#${enclosingMethod(lines, index)}`;
    found.set(key, (found.get(key) ?? 0) + 1);
  });
  return found;
}

function adapterFixture(overrides: Record<string, unknown> = {}) {
  const adapter = Object.create(CodexAdapter.prototype) as any;
  const seen: Array<{ chatId: number; assistantId: number | null }> = [];
  /** What the host would put in `mcp_servers.hoai_browser.env` right now. */
  const askRelay = (chatId: number) => {
    const relay = adapter.browserRelay(chatId);
    seen.push({ chatId, assistantId: relay ? relay.assistantId : null });
  };
  Object.assign(adapter, {
    cfg: { baseUrl: "https://api.brandgrowthos.test/" },
    currentToken: TOKEN,
    identityReady: true,
    assistantToRoute: new Map<number, string>(OWNED),
    chatToAssistant: new Map<number, number>(),
    ownerId: "user_1",
    turnControllers: new Map(),
    generations: new Map(),
    replyQueues: new Map(),
    rpcSeen: new Set<string>(),
    voiceTasks: new Map(),
    lastInput: new Map(),
    lastNativeOptions: new Map(),
    refreshScopeRateLimited: vi.fn(async () => {}),
    tools: { handleRequest: vi.fn(async () => ({})) },
    toolProgress: { sendToolStart: vi.fn(async () => {}) },
    outbound: {
      sendText: vi.fn(async () => ({ id: 1 })),
      sendAgentError: vi.fn(async () => {}),
    },
    missionLane: {
      beginTurn: vi.fn(() => "turn-1"),
      finalizeTurn: vi.fn(async () => {}),
      handleTodoList: vi.fn(async () => {}),
    },
    missionControl: { applyBulletin: (_chatId: number, input: unknown) => input },
    voiceJournal: {
      get: vi.fn(() => undefined),
      begin: vi.fn(),
      complete: vi.fn((_id: string, result: unknown) => result),
    },
    api: {
      setStatus: vi.fn(async () => {}),
      agentRequest: vi.fn(async () => ({})),
      postVoiceRpcAck: vi.fn(async () => {}),
      postVoiceRpcResult: vi.fn(async () => {}),
      postVoiceTaskResult: vi.fn(async () => {}),
      getOrCreatePrimaryChat: vi.fn(async () => COLD_CHAT),
    },
    host: {
      // Both entry points build the thread config, which is where the relay
      // credentials are resolved. Ask for them exactly there.
      runTurn: vi.fn(async (chatId: number) => {
        askRelay(chatId);
        return {
          replyText: "ok",
          finalAgentMessageText: "ok",
          error: null,
          turnCompleted: true,
        };
      }),
      runDetached: vi.fn(async (chatId: number) => {
        askRelay(chatId);
        return { replyText: "ok", finalAgentMessageText: "ok", error: null };
      }),
    },
    ...overrides,
  });
  return { adapter, seen };
}

function replyHandle() {
  return {
    sendTyping: vi.fn(async () => {}),
    finalizeTurn: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendButtons: vi.fn(async () => {}),
    sendAskUserInput: vi.fn(async () => {}),
    sendFile: vi.fn(async () => {}),
  };
}

describe("the paths that can start a thread all name the agent first", () => {
  it("is the complete list of methods reaching the host's thread-starting API", () => {
    const found = new Map<string, number>();
    for (const file of sourceFiles(SRC)) {
      const name = relative(SRC, file).split(/[\\/]/).join("/");
      // The host is where these methods are DEFINED, not a caller.
      if (name === "codex-host.ts") continue;
      for (const [key, count] of threadStarters(
        name,
        readFileSync(file, "utf8"),
      ))
        found.set(key, (found.get(key) ?? 0) + count);
    }
    // Fails on a new path: record the chat's assistant there, then list it.
    expect([...found.keys()].sort()).toEqual(
      Object.keys(THREAD_STARTERS).sort(),
    );
    expect(found.get("adapter.ts#handleControl")).toBe(2);
  });

  it("the scan catches an optional call, not only the plain one", () => {
    // The middle line is verbatim the probe a reviewer used to walk a new
    // thread-starting path straight past the first version of this guard.
    const mutated = [
      "export class Sneaky {",
      "  sneak(): void {",
      "    void (this as any).host?.runTurn?.(1);",
      "  }",
      "  detach(chatId: number): void {",
      "    void this.host?.runDetached?.(chatId);",
      "  }",
      "  plain(chatId: number): void {",
      "    void this.host.runTurn(chatId);",
      "  }",
      "}",
    ].join("\n");
    expect([...threadStarters("sneaky.ts", mutated).keys()].sort()).toEqual([
      "sneaky.ts#detach",
      "sneaky.ts#plain",
      "sneaky.ts#sneak",
    ]);
  });

  it("a normal turn: the pair is known by the time the turn runs", async () => {
    const { adapter, seen } = adapterFixture();
    await adapter.runAndReply(11, COLD_CHAT, "hello", replyHandle(), {});
    expect(adapter.host.runTurn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ chatId: COLD_CHAT, assistantId: 11 }]);
  });

  it("an invisible voice consult: the pair is known before the fork", async () => {
    const { adapter, seen } = adapterFixture();
    await adapter.handleControl({
      rpcId: "rpc-consult",
      op: "consult",
      assistantId: "11",
      chatId: String(COLD_CHAT),
      payload: { args: { question: "Is the page up?" } },
    });
    expect(adapter.host.runDetached).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ chatId: COLD_CHAT, assistantId: 11 }]);
  });

  it("a voice task: the pair is known for the primary chat it opens", async () => {
    const { adapter, seen } = adapterFixture();
    const ran = new Promise<void>((resolve) => {
      adapter.api.postVoiceTaskResult = vi.fn(async () => {
        resolve();
      });
    });
    await adapter.handleControl({
      rpcId: "rpc-dispatch",
      op: "dispatch",
      assistantId: "11",
      chatId: "0",
      payload: {
        taskId: "task-1",
        confirmed: true,
        args: { question: "Check the deploy" },
      },
    });
    await ran;
    expect(adapter.host.runDetached).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ chatId: COLD_CHAT, assistantId: 11 }]);
  });

  it("a meeting turn: the lane names the chat's agent before the turn", async () => {
    const { adapter, seen } = adapterFixture();
    const room = {
      id: 3,
      chatId: COLD_CHAT,
      status: "open",
      currentSpeakerId: 11,
      turnStartedAt: "now",
      participants: [{ assistantId: 11 }],
    };
    const lane = new MeetingLane({
      api: {
        agentRequest: vi.fn(async (_method: string, path: string) =>
          path.endsWith("transcript")
            ? { messages: [{ message: { id: 1, sender: "user", text: "Go" } }] }
            : room,
        ),
      } as any,
      host: adapter.host as any,
      tools: {
        call: vi.fn(async () => ({ id: 2 })),
        handleRequest: vi.fn(),
      } as any,
      owner: () => "user_1",
      owned: () => [11],
      stateFile: join(mkdtempSync(join(tmpdir(), "hoai-cold-")), "turns.json"),
      log: vi.fn(),
      // A COPY of how the adapter wires the lane, so this case proves the lane
      // calls the dep and nothing more. That the adapter actually passes it is
      // a separate claim, pinned on the real constructor by
      // test/browser-relay-meeting-wiring.spec.ts (and now a type error too:
      // the lane's `noteChat` dep is required).
      noteChat: (chatId: number, assistantId: number) =>
        adapter.noteChatAssistant(chatId, assistantId),
    });
    await lane.handle({ meetingId: 3 });
    expect(adapter.host.runTurn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ chatId: COLD_CHAT, assistantId: 11 }]);
  });

  it("mutation check: without the pair the same cold call has no relay", async () => {
    const { adapter, seen } = adapterFixture();
    adapter.noteChatAssistant = () => {};
    await adapter.runAndReply(11, COLD_CHAT, "hello", replyHandle(), {});
    expect(seen).toEqual([{ chatId: COLD_CHAT, assistantId: null }]);
  });
});
