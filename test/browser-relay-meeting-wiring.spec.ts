/**
 * The meeting path's relay wiring, through the REAL adapter.
 *
 * WHY THIS FILE EXISTS. A meeting turn can be the first thread a chat ever
 * gets, so `MeetingLane` is the one thread-starting path that cannot learn the
 * chat's assistant from an inbound event: it is told, through the `noteChat`
 * dep the adapter passes in its constructor. `browser-relay-cold-start.spec.ts`
 * proves the LANE calls that dep, but it hands the lane its own copy of the
 * wiring:
 *
 *     noteChat: (chatId, assistantId) => adapter.noteChatAssistant(...)
 *
 * which is the production line retyped inside the test. So deleting the real
 * line from `CodexAdapter`'s constructor left every test green while the
 * cross-machine browser went silently missing for every meeting chat on a
 * multi-agent daemon. The dep was optional (`noteChat?:`) and called with `?.`,
 * so nothing even threw.
 *
 * Two changes close it, and both are exercised here:
 *   - `noteChat` is now REQUIRED in the lane's deps, so dropping the wiring is
 *     a type error (`npm run lint`) as well as a test failure.
 *   - these cases construct a REAL `CodexAdapter` and drive a REAL meeting
 *     inbound through `codexDispatch`, so the lane under test is the one the
 *     constructor built. The assertion is the production artefact: the thread
 *     config that `CodexHost` would hand Codex carries
 *     `mcp_servers.hoai_browser.env` naming this chat's agent.
 *
 * Mutation-proven: delete `noteChat:` from the adapter's `new MeetingLane({…})`
 * and both cases fail (the turn throws before `runTurn`, and the probe calls
 * undefined), while `tsc --noEmit` fails too.
 *
 * No daemon, model, network or backend runs: the adapter's constructors are
 * inert (the Codex app-server is only spawned by `preflight`), and the three
 * collaborators the meeting path touches are replaced on the real instances.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/adapter.js";
import { HOAI_BROWSER_SERVER, bundledShimPath } from "../src/browser-mcp.js";

const TOKEN = "pair-meeting-0123456789abcdefghij";
const BASE_URL = "https://api.brandgrowthos.test/";
/** The chat no event in this process has ever named before the meeting turn. */
const COLD_CHAT = 5150;
const MEETING_ID = 3;
/** Two owned agents, so nothing can answer by "we only own one". */
const OWNED: [number, string][] = [
  [10, "codex"],
  [11, "codex-2"],
];
const SPEAKER = 11;

let home: string | null = null;
const envBefore = {
  codexHome: process.env.CODEX_BGOS_HOME,
  hoaiHome: process.env.HOAI_HOME,
};

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  for (const [key, value] of [
    ["CODEX_BGOS_HOME", envBefore.codexHome],
    ["HOAI_HOME", envBefore.hoaiHome],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * A real adapter, with only the three collaborators a meeting turn reaches
 * replaced (the HTTP client's request method, the host's turn runner, the tool
 * dispatcher). Everything between the dispatch and the relay env is production
 * code, including the lane, its `noteChat` wiring, the chat-to-assistant cache
 * and `CodexHost.browserConfig`.
 */
function realAdapter() {
  home = mkdtempSync(join(tmpdir(), "hoai-meeting-wiring-"));
  // State files land in the temp home; no ~/.hoai/bin here, so the shim
  // resolver falls back to the vendored copy in the tree and the overrides are
  // exactly the ones a real thread would get.
  process.env.CODEX_BGOS_HOME = home;
  process.env.HOAI_HOME = home;

  const adapter = new CodexAdapter(
    {
      baseUrl: BASE_URL,
      pairingToken: TOKEN,
      reconnect: { initialDelayMs: 1, maxDelayMs: 2 },
    },
    { ok: true, mode: "chatgpt", label: "codex login (test)" },
  ) as any;

  for (const [id, route] of OWNED) adapter.assistantToRoute.set(id, route);
  // What the adapter flips after its first successful scope load: the
  // ownership check is live, so a learned pair has to survive it.
  adapter.identityReady = true;
  adapter.ownerId = "user_1";

  const room = {
    id: MEETING_ID,
    chatId: COLD_CHAT,
    status: "open",
    currentSpeakerId: SPEAKER,
    turnStartedAt: "now",
    title: "Launch",
    objective: "Ship it",
    participants: [{ assistantId: SPEAKER }],
  };
  adapter.api.agentRequest = vi.fn(async (_method: string, path: string) => {
    if (path === "meetings")
      return { meetings: [{ id: MEETING_ID, chatId: COLD_CHAT }] };
    if (path.endsWith("/transcript"))
      return { messages: [{ message: { id: 1, sender: "user", text: "Go" } }] };
    return room;
  });
  adapter.tools.call = vi.fn(async () => ({ id: 2 }));

  /**
   * The thread config Codex would be handed, captured at the moment the turn
   * starts. `browserConfig` is the same private method `ensureThread` calls, so
   * this is the production resolver, not a re-implementation.
   */
  const configs: Array<Record<string, unknown>> = [];
  adapter.host.runTurn = vi.fn(async (chatId: number) => {
    configs.push(adapter.host.browserConfig(chatId));
    return {
      replyText: "ok",
      finalAgentMessageText: "ok",
      error: null,
      turnCompleted: true,
    };
  });

  return { adapter, configs, room };
}

/** A meeting inbound as the dispatcher receives one. */
function meetingInbound(chatId = COLD_CHAT, assistantId = SPEAKER) {
  return {
    origin: "bgos",
    agentRoute: "codex-2",
    assistantId,
    chatId,
    messageId: 1,
    userId: "user_1",
    text: "Your turn",
    attachments: [],
    systemPrompt: "",
    replyHandle: {},
    messageType: "text",
    chatKind: "meeting",
  };
}

describe("the adapter's own meeting wiring names the agent for the relay", () => {
  it("is the vendored shim that a cold meeting chat's thread would launch", () => {
    // Guards the premise of the case below: if the resolver found nothing the
    // overrides would be `{}` and the env assertion could not fail.
    expect(existsSync(bundledShimPath())).toBe(true);
  });

  it("a real meeting inbound leaves the chat's thread config carrying the speaker's id", async () => {
    const { adapter, configs } = realAdapter();
    // Before the meeting nothing in this process can name the chat's agent.
    expect(adapter.browserRelay(COLD_CHAT)).toBeNull();

    await adapter.codexDispatch(meetingInbound());

    expect(adapter.host.runTurn).toHaveBeenCalledTimes(1);
    expect(configs).toHaveLength(1);
    // The production artefact: what the shim is handed for this chat.
    expect(configs[0][`mcp_servers.${HOAI_BROWSER_SERVER}.env`]).toEqual({
      HOAI_RELAY_BACKEND_URL: "https://api.brandgrowthos.test",
      HOAI_RELAY_PAIRING_TOKEN: TOKEN,
      HOAI_RELAY_ASSISTANT_ID: String(SPEAKER),
    });
    // And the pair outlives the turn, so a later browser call in the same chat
    // relays as the same agent.
    expect(adapter.browserRelay(COLD_CHAT)).toEqual({
      backendUrl: BASE_URL,
      pairingToken: TOKEN,
      assistantId: SPEAKER,
    });
  });

  it("the lane the constructor built notes into the adapter, not into a copy a test wired", () => {
    const { adapter } = realAdapter();
    // Reach the dep the production constructor passed in, and call it. This is
    // the one assertion that fails for exactly one reason: the wiring is gone.
    const noteChat = adapter.meetings.deps.noteChat;
    expect(typeof noteChat).toBe("function");
    noteChat(COLD_CHAT, SPEAKER);
    expect(adapter.browserRelay(COLD_CHAT)?.assistantId).toBe(SPEAKER);
  });

  it("a chat the meeting never named still gets no relay, so the note is what did the work", async () => {
    const { adapter } = realAdapter();
    await adapter.codexDispatch(meetingInbound());
    expect(adapter.browserRelay(COLD_CHAT + 1)).toBeNull();
  });
});
