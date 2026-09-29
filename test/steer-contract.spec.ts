/**
 * THE CROSS REPO PIN for Send now's steer (P5 stage 5, C-27, Build C), from
 * the plugin's side.
 *
 * The HOAI app's follow ups tray sends Send now to a Codex agent as a slash
 * command: text `/steer <text>`, message type `slash_command`, command name
 * `steer`, command args `<text>`, and only to a daemon at or past 0.15.0, the
 * first release whose `/steer` with nothing to steer runs the text as a normal
 * message instead of answering an error and dropping it. That is one contract
 * written in two repos, so it is pinned by ONE hash in both:
 *
 *   sha256("steer;slash_command;/steer {text};0.15.0")
 *     = TRAY_STEER_CONTRACT_SHA256 (src/native-commands.ts here, and
 *       frontend/expo-app/src/components/chat/followUpTrayModel.ts in
 *       BrandGrowthOS/BGOS, whose twin test rebuilds the string from the
 *       app's own `steerVarsFor` output and CODEX_STEER_FALLBACK_SINCE).
 *
 * Each side rebuilds the string from its OWN source values, never from a copy
 * of it: here the command name the router answers to (STEER_COMMAND_NAME, the
 * same constant the catalog registers), the message type the inbound handler
 * reads a command off (SLASH_COMMAND_MESSAGE_TYPE, the constant it compares
 * against), the text shape the router parses back to that name and those
 * args, and the floor (STEER_FALLBACK_SINCE, which package.json must be at or
 * past). A one sided edit that also updates its own word for word pin (the
 * floor moved to 0.15.1 here and in the pin below, say) leaves the word for
 * word case green and turns ONLY the hash case red. Change the contract only
 * with the other repo's PR, and move the hash in both.
 *
 * The rest of the file proves the plugin READS exactly that frame: through the
 * real inbound handler, the adapter's real dispatch and the real router, into
 * a real CodexHost on a fake app server (a running turn is steered and nothing
 * is posted; no turn, or a refusal, runs the text once; a steer Codex did not
 * answer in time is neither run nor steered twice).
 *
 * Mutations recorded in BGOS's docs/reports/2026-09-24-p5-s5-followups/
 * red-proofs.md, under "Build C". No em or en dashes anywhere in this file.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestTimeoutError } from "../src/app-server.js";
import { CodexAdapter } from "../src/adapter.js";
import { CodexHost } from "../src/codex-host.js";
import {
  SLASH_COMMAND_MESSAGE_TYPE,
  createInboundHandler,
} from "../src/inbound-handler.js";
import {
  NATIVE_COMMAND_DESCRIPTIONS,
  NativeCommands,
  STEER_COMMAND_NAME,
  STEER_FALLBACK_SINCE,
  STEER_UNCONFIRMED_TEXT,
  TRAY_STEER_CONTRACT_SHA256,
  parseNativeCommand,
} from "../src/native-commands.js";

const TEXT = "{text}";

/** The canonical string, rebuilt from the plugin's own values. */
function rebuilt(): string {
  return [
    STEER_COMMAND_NAME,
    SLASH_COMMAND_MESSAGE_TYPE,
    `/${STEER_COMMAND_NAME} ${TEXT}`,
    STEER_FALLBACK_SINCE,
  ].join(";");
}

/** a >= b over plain x.y.z versions. */
function atLeast(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return true;
}

describe("the steer contract with HOAI's Send now, pinned from the plugin's side", () => {
  it("word for word: the command, the message type, the text shape and the floor", () => {
    expect(STEER_COMMAND_NAME).toBe("steer");
    expect(SLASH_COMMAND_MESSAGE_TYPE).toBe("slash_command");
    expect(STEER_FALLBACK_SINCE).toBe("0.15.0");
    expect(rebuilt()).toBe("steer;slash_command;/steer {text};0.15.0");
  });

  it("the hash matches the constant the HOAI app carries", () => {
    const hash = createHash("sha256").update(rebuilt(), "utf8").digest("hex");
    expect(hash).toBe(TRAY_STEER_CONTRACT_SHA256);
  });

  it("the text shape parses back to the command name and the args", () => {
    expect(parseNativeCommand(`/${STEER_COMMAND_NAME} ${TEXT}`)).toEqual({
      name: STEER_COMMAND_NAME,
      args: TEXT,
    });
  });

  it("this release is at or past the floor the app steers from", () => {
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    expect(
      atLeast(version, STEER_FALLBACK_SINCE),
      `package.json is ${version}, below the steer floor ${STEER_FALLBACK_SINCE}`,
    ).toBe(true);
  });

  it("the catalog registers the command under the pinned name, which is what the app looks for", () => {
    expect(NATIVE_COMMAND_DESCRIPTIONS.map((entry) => entry[0])).toContain(
      STEER_COMMAND_NAME,
    );
  });
});

/**
 * A small app server: threads, a turn that stays running until the test ends
 * it, and a `turn/steer` whose answer each case chooses.
 */
class Server extends EventEmitter {
  next = 0;
  steer: (params: any) => Promise<unknown> = async () => ({});
  start = vi.fn(async () => {});
  close = vi.fn(() => this.emit("closed", new Error("closed")));
  request = vi.fn(async (method: string, p: any) => {
    if (method === "thread/start")
      return { thread: { id: `thread-${++this.next}` } };
    if (method === "thread/read") return { thread: { id: p.threadId } };
    if (method === "thread/resume") return { thread: { id: p.threadId } };
    if (method === "turn/start") return { turn: { id: `turn-${p.threadId}` } };
    if (method === "turn/steer") return this.steer(p);
    return {};
  });
  finish(threadId: string) {
    this.emit("notification", "item/completed", {
      threadId,
      item: { id: "message", type: "agentMessage", text: "done" },
    });
    this.emit("notification", "turn/completed", {
      threadId,
      turn: { status: "completed" },
    });
  }
}

describe("the plugin reads exactly the app's frame, end to end", () => {
  let home: string;
  let server: Server;
  let host: CodexHost;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hoai-steer-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    server = new Server();
    host = new CodexHost({
      auth: { ok: true, mode: "chatgpt", label: "test" },
      workdir: home,
      server: server as any,
      tools: [],
    });
  });
  afterEach(() => {
    host.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * The app's Send now frame, as `steerVarsFor` builds it and the backend
   * forwards it, through the real inbound handler into the adapter's real
   * dispatch (the cold catalog parse, the alias normaliser, the router).
   */
  function wire() {
    const run = vi.fn(async () => {});
    const outbound = {
      sendText: vi.fn(async () => ({ id: 1 })),
      sendAgentError: vi.fn(async () => {}),
    };
    const router = new NativeCommands({
      host,
      interactions: { ask: vi.fn() } as any,
      ownerId: () => "owner",
      status: () => "connected",
      run,
      goalLane: {} as any,
    });
    const adapter = Object.create(CodexAdapter.prototype) as any;
    Object.assign(adapter, {
      chatToAssistant: new Map<number, number>(),
      nativeCommands: router,
    });
    const seen: any[] = [];
    const handle = createInboundHandler({
      outbound: outbound as any,
      getRouteForAssistant: () => "codex",
      getDispatch: () => async (args) => {
        seen.push(args);
        await adapter.codexDispatch(args);
      },
    });
    let nextId = 1;
    const send = (text: string) =>
      handle({
        assistantId: 10,
        userId: "owner",
        chatId: 20,
        messageId: nextId++,
        text: `/${STEER_COMMAND_NAME} ${text}`,
        messageType: SLASH_COMMAND_MESSAGE_TYPE as any,
        commandName: STEER_COMMAND_NAME,
        commandArgs: text,
        files: [],
      });
    return { run, outbound, seen, send };
  }

  /**
   * A turn the runtime has started and named: the only kind a steer can land
   * on (the host learns the id when `turn/start` answers).
   */
  async function runningTurn() {
    const turn = host.runTurn(20, "build the page");
    await vi.waitFor(() =>
      expect((host as any).active.get("thread-1")?.id).toBe("turn-thread-1"),
    );
    // Wrapped: an async function returning the turn itself would wait for it.
    return { turn };
  }

  function steerCalls() {
    return server.request.mock.calls.filter(([method]) => method === "turn/steer");
  }

  it("reads the command off the tagged frame, not only off its text", async () => {
    const w = wire();
    await w.send("Keep the public API");
    expect(w.seen[0].messageType).toBe(SLASH_COMMAND_MESSAGE_TYPE);
    expect(w.seen[0].command).toEqual({
      name: STEER_COMMAND_NAME,
      args: "Keep the public API",
    });
  });

  it("steers a running turn with the frame's args and posts nothing", async () => {
    const w = wire();
    const { turn } = await runningTurn();
    await w.send("Keep the public API");
    expect(steerCalls()).toHaveLength(1);
    expect(steerCalls()[0]![1]).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "turn-thread-1",
    });
    expect(JSON.stringify(steerCalls()[0]![1].input)).toContain(
      "Keep the public API",
    );
    expect(w.run).not.toHaveBeenCalled();
    expect(w.outbound.sendText).not.toHaveBeenCalled();
    server.finish("thread-1");
    await turn;
  });

  it("with no turn running, runs the text once as a normal message and posts nothing", async () => {
    const w = wire();
    await w.send("Keep the public API");
    expect(steerCalls()).toHaveLength(0);
    expect(w.run).toHaveBeenCalledTimes(1);
    expect(w.run.mock.calls[0]![1]).toBe("Keep the public API");
    expect(w.outbound.sendText).not.toHaveBeenCalled();
  });

  it("when the runtime refuses the steer because the turn just ended, runs it once", async () => {
    const w = wire();
    server.steer = async () => {
      throw new Error("expected active turn id `turn-thread-1` but found none");
    };
    const { turn } = await runningTurn();
    await w.send("Keep the public API");
    expect(steerCalls()).toHaveLength(1);
    expect(w.run).toHaveBeenCalledTimes(1);
    expect(w.run.mock.calls[0]![1]).toBe("Keep the public API");
    expect(w.outbound.sendText).not.toHaveBeenCalled();
    server.finish("thread-1");
    await turn;
  });

  it("a steer Codex did not answer in time is neither run nor steered twice", async () => {
    const w = wire();
    server.steer = async () => {
      throw new RequestTimeoutError("Codex turn/steer timed out.");
    };
    const { turn } = await runningTurn();
    await w.send("Keep the public API");
    expect(steerCalls()).toHaveLength(1);
    expect(w.run).not.toHaveBeenCalled();
    expect(w.outbound.sendText).toHaveBeenCalledTimes(1);
    expect(w.outbound.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 20, text: STEER_UNCONFIRMED_TEXT }),
    );
    server.finish("thread-1");
    await turn;
  });
});
