/**
 * Mission 104 wiring in the real adapter (design 2.2): the host's busy edges
 * reach the heartbeat file at once, the POST carries the computer's identity
 * from the SHARED ~/.bgos-agent/machine-id and the supervisor's readiness, and
 * the child control questions reach the host. HOME is a temp dir: the real
 * ~/.bgos-agent is never read or written.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import { STOP_IF_IDLE, STOP_REPLY, attachChildControl } from "../src/child-control.js";
import { emptyUpdateState, writeUpdateState } from "../src/setup/self-update.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("the adapter wires busy, identity and readiness", () => {
  let home: string, userHome: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-ka-wiring-"));
    userHome = mkdtempSync(join(tmpdir(), "codex-ka-user-"));
    vi.stubEnv("CODEX_BGOS_HOME", home);
    vi.stubEnv("HOME", userHome);
    vi.stubEnv("USERPROFILE", userHome);
    vi.stubEnv("CODEX_BGOS_SUPERVISOR_PID", "4321");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  });

  const build = () =>
    new CodexAdapter(
      {
        baseUrl: "http://127.0.0.1:9",
        pairingToken: "t".repeat(32),
        reconnect: { initialDelayMs: 1, maxDelayMs: 2 },
      } as any,
      { ok: true, mode: "chatgpt", label: "codex login (test)" },
    ) as any;

  it("a busy edge on the host rewrites the heartbeat file at once", () => {
    const adapter = build();
    try {
      adapter.host.queues.set(5, Promise.resolve());
      const file = () =>
        JSON.parse(readFileSync(join(home, "bgos_heartbeat.json"), "utf8"));
      expect(file().busy).toBe(true);
      expect(adapter.isAnyBusy()).toBe(true);
      adapter.host.queues.delete(5);
      expect(file().busy).toBe(false);
      expect(adapter.isAnyBusy()).toBe(false);
    } finally {
      adapter.host.close();
    }
  });

  it("posts the shared machine id, role agent and the supervisor's readiness", async () => {
    mkdirSync(join(userHome, ".bgos-agent"), { recursive: true });
    writeFileSync(join(userHome, ".bgos-agent", "machine-id"), "shared-machine-0042\n");
    writeUpdateState(home, {
      ...emptyUpdateState(),
      supervisorPid: 4321,
      supervised: "systemd",
      autoUpdateEnabled: true,
      latestKnownVersion: "0.19.3",
      stagedVersion: "0.19.3",
    });
    const adapter = build();
    try {
      const postHeartbeat = vi.fn(async () => {});
      adapter.api.postHeartbeat = postHeartbeat;
      await adapter.heartbeat.postNetwork();
      expect(postHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          env: {
            platform: process.platform,
            machineId: "shared-machine-0042",
            role: "agent",
          },
          latestKnownVersion: "0.19.3",
          updateReadiness: {
            supervised: "systemd",
            autoUpdateEnabled: true,
            rollbackLatched: false,
            pendingRestartVersion: "0.19.3",
          },
        }),
      );
    } finally {
      adapter.host.close();
    }
  });

  /**
   * The real start() with the socket, the runtime and the backend stubbed:
   * the handlers it registers on the socket are returned, so a test can
   * deliver a frame the way BgosWs does.
   */
  async function started(adapter: any) {
    const handlers = new Map<string, (payload: any) => void>();
    adapter.host.preflight = vi.fn(async () => {});
    adapter.ws = {
      on: (event: string, fn: (payload: any) => void) => handlers.set(event, fn),
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(),
      triggerBackfill: vi.fn(async () => {}),
      connectedSince: null,
    };
    adapter.api.postHeartbeat = vi.fn(async () => {});
    adapter.loadServedCapabilities = vi.fn(async () => {});
    adapter.sweepOrphanedApprovals = vi.fn(async () => {});
    adapter.refreshIdentity = vi.fn(async () => false);
    adapter.scheduleIdentityRetry = vi.fn();
    await adapter.start();
    clearInterval(adapter.spoolTimer);
    adapter.assistantToRoute.set(10, "codex");
    return handlers;
  }

  /** The supervisor's question, asked of this adapter the way cli.ts wires it. */
  async function askToStop(adapter: any) {
    const listeners: Array<(message: unknown) => void> = [];
    const sent: any[] = [];
    const shutdown = vi.fn();
    attachChildControl({
      channel: {
        on: (_event, listener) => void listeners.push(listener),
        send: (message) => (sent.push(message), true),
      },
      busyNow: () => adapter.isAnyBusy(),
      backgroundJobs: async () => 0,
      shutdown,
    });
    for (const listener of listeners) listener({ type: STOP_IF_IDLE, id: "q1" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: STOP_REPLY, id: "q1" });
    return { result: sent[0].result, shutdown };
  }

  it("review F1: a message taken from the wire is busy before its turn reaches the host, so the child never says stopping", async () => {
    const adapter = build();
    try {
      const handlers = await started(adapter);
      // The cursor is saved and the message is consumed; the turn is not
      // queued on the host yet (an attachment download, a native command,
      // the first owner turn's mission lookup).
      const taken = deferred();
      adapter.dispatch = vi.fn(() => taken.promise);
      handlers.get("inbound_message")!({
        assistantId: 10,
        chatId: 20,
        messageId: 501,
        userId: "owner-1",
        text: "summarise the attached report",
      });
      await settle();
      expect(adapter.dispatch).toHaveBeenCalledTimes(1);
      expect(adapter.host.isAnyBusy()).toBe(false);
      expect(adapter.isAnyBusy()).toBe(true);
      const answer = await askToStop(adapter);
      expect(answer.result).toBe("busy");
      expect(answer.shutdown).not.toHaveBeenCalled();
      // The supervisor's file check sees the message at once too.
      const file = JSON.parse(readFileSync(join(home, "bgos_heartbeat.json"), "utf8"));
      expect(Date.now() - Date.parse(file.lastInboundAt)).toBeLessThan(60_000);
      taken.resolve();
      await settle();
      expect(adapter.isAnyBusy()).toBe(false);
    } finally {
      adapter.heartbeat.stop();
      adapter.host.close();
    }
  });

  it("review F1: a confirmed voice task is busy from its frame until its turn ends", async () => {
    const adapter = build();
    try {
      const handlers = await started(adapter);
      const chat = deferred<number>();
      const turn = deferred<any>();
      adapter.api.postVoiceRpcAck = vi.fn(async () => {});
      adapter.api.postVoiceRpcResult = vi.fn(async () => {});
      adapter.api.postVoiceTaskResult = vi.fn(async () => {});
      adapter.api.getOrCreatePrimaryChat = vi.fn(() => chat.promise);
      adapter.host.runDetached = vi.fn(() => turn.promise);
      handlers.get("voice_rpc")!({
        rpcId: "rpc-1",
        op: "dispatch",
        assistantId: "10",
        chatId: "20",
        payload: { taskId: "task-1", confirmed: true, args: { question: "book the room" } },
      });
      await settle();
      expect(adapter.isAnyBusy()).toBe(true);
      expect((await askToStop(adapter)).result).toBe("busy");
      chat.resolve(20);
      await settle();
      expect(adapter.host.runDetached).toHaveBeenCalledTimes(1);
      turn.resolve({ replyText: "Booked.", finalAgentMessageText: "Booked." });
      await vi.waitFor(() => expect(adapter.isAnyBusy()).toBe(false));
    } finally {
      adapter.heartbeat.stop();
      adapter.host.close();
    }
  });

  it("review F1: a button tap is busy from the tap, before its turn reaches the host", async () => {
    const adapter = build();
    try {
      const handlers = await started(adapter);
      const before = deferred();
      adapter.executeAndReply = vi.fn(() => before.promise);
      adapter.tools.interactions.handleClick = vi.fn(() => false);
      handlers.get("inbound_click")!({
        assistantId: 10,
        chatId: 20,
        messageId: 77,
        userId: "owner-1",
        callbackData: "Yes, ship it",
      });
      await settle();
      expect(adapter.executeAndReply).toHaveBeenCalledTimes(1);
      expect(adapter.isAnyBusy()).toBe(true);
      before.resolve();
      await settle();
      expect(adapter.isAnyBusy()).toBe(false);
    } finally {
      adapter.heartbeat.stop();
      adapter.host.close();
    }
  });

  it("asks the host for background terminals", async () => {
    const adapter = build();
    try {
      adapter.host.backgroundTerminalCount = vi.fn(async () => 2);
      expect(await adapter.backgroundJobCount()).toBe(2);
    } finally {
      adapter.host.close();
    }
  });
});
