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
import { emptyUpdateState, writeUpdateState } from "../src/setup/self-update.js";

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
