/**
 * HeartbeatController (contract C1): local file writes + network POST cadence,
 * error transitions, and the fatal-latch network disable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DECLARED_CAPABILITIES } from "../src/declared-capabilities.js";
import {
  parseSessionStatus,
  SESSION_STATUS_FIELDS,
} from "../src/session-status-contract.js";
import {
  HeartbeatController,
  heartbeatEnv,
  type HeartbeatDto,
} from "../src/heartbeat.js";

function heartbeatFile(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, "bgos_heartbeat.json"), "utf8"));
}

describe("HeartbeatController", () => {
  let tempHome: string;
  const originalCodexBgosHome = process.env.CODEX_BGOS_HOME;
  const originalInterval = process.env.CODEX_BGOS_HEARTBEAT_INTERVAL;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-hb-test-"));
    process.env.CODEX_BGOS_HOME = tempHome;
    delete process.env.CODEX_BGOS_HEARTBEAT_INTERVAL;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodexBgosHome === undefined) delete process.env.CODEX_BGOS_HOME;
    else process.env.CODEX_BGOS_HOME = originalCodexBgosHome;
    if (originalInterval === undefined) delete process.env.CODEX_BGOS_HEARTBEAT_INTERVAL;
    else process.env.CODEX_BGOS_HEARTBEAT_INTERVAL = originalInterval;
  });

  it("writes the local file + posts once on start", () => {
    const posts: HeartbeatDto[] = [];
    const hb = new HeartbeatController({
      version: "0.11.0",
      postHeartbeat: async (b) => void posts.push(b),
    });
    hb.start();
    try {
      const f = heartbeatFile(tempHome);
      expect(f.version).toBe("0.11.0");
      expect(f.pid).toBe(process.pid);
      expect(f).toHaveProperty("wsConnected", false);
      expect(f).toHaveProperty("lastError", null);
      expect(posts).toHaveLength(1);
      expect(posts[0].daemonVersion).toBe("0.11.0");
    } finally {
      hb.stop();
    }
  });

  it("an error transition writes the file + posts a network heartbeat", () => {
    const posts: HeartbeatDto[] = [];
    const hb = new HeartbeatController({
      version: "0.11.0",
      postHeartbeat: async (b) => void posts.push(b),
    });
    hb.start();
    try {
      expect(posts).toHaveLength(1); // start post
      hb.setLastError({ code: "backfill_failed", message: "boom", at: "2026-07-07T00:00:00Z" });
      expect(posts).toHaveLength(2); // transition post
      expect(posts[1].lastError?.code).toBe("backfill_failed");
      expect(heartbeatFile(tempHome).lastError).toMatchObject({ code: "backfill_failed" });
      // Same code again is NOT a transition.
      hb.setLastError({ code: "backfill_failed", message: "boom2", at: "x" });
      expect(posts).toHaveLength(2);
      // Clearing IS a transition.
      hb.setLastError(null);
      expect(posts).toHaveLength(3);
      expect(posts[2].lastError).toBeNull();
    } finally {
      hb.stop();
    }
  });

  it("setNetEnabled(false) keeps writing the file but stops network posts", () => {
    const posts: HeartbeatDto[] = [];
    const hb = new HeartbeatController({
      version: "0.11.0",
      postHeartbeat: async (b) => void posts.push(b),
    });
    hb.start();
    try {
      posts.length = 0;
      hb.setNetEnabled(false); // fatal latch
      hb.setLastError({ code: "pairing_revoked", message: "gone", at: "x" });
      expect(posts).toHaveLength(0); // no network post while latched
      expect(heartbeatFile(tempHome).lastError).toMatchObject({ code: "pairing_revoked" });
    } finally {
      hb.stop();
    }
  });

  it("CODEX_BGOS_HEARTBEAT_INTERVAL=0 disables network posts", () => {
    process.env.CODEX_BGOS_HEARTBEAT_INTERVAL = "0";
    const post = vi.fn(async () => {});
    const hb = new HeartbeatController({ version: "0.11.0", postHeartbeat: post });
    hb.start();
    try {
      expect(post).not.toHaveBeenCalled();
      // The local file is still written.
      expect(heartbeatFile(tempHome).version).toBe("0.11.0");
    } finally {
      hb.stop();
    }
  });

  it("snapshot records ws + inbound/outbound timestamps", () => {
    const hb = new HeartbeatController({
      version: "0.11.0",
      postHeartbeat: async () => {},
      now: () => 1_000_000,
    });
    hb.setWsConnected(true, "2026-07-07T00:00:00Z");
    hb.setPairingId(5);
    hb.recordInbound();
    hb.recordOutbound();
    const snap = hb.snapshotFile();
    expect(snap.wsConnected).toBe(true);
    expect(snap.wsConnectedSince).toBe("2026-07-07T00:00:00Z");
    expect(snap.pairingId).toBe(5);
    expect(snap.lastInboundAt).not.toBeNull();
    expect(snap.lastOutboundAt).not.toBeNull();
  });

  describe("declared capabilities (mission program stage 5)", () => {
    it("carries the declared set on the posted body", () => {
      const posts: HeartbeatDto[] = [];
      const hb = new HeartbeatController({
        version: "0.7.0",
        capabilities: DECLARED_CAPABILITIES,
        postHeartbeat: async (b) => void posts.push(b),
      });
      hb.start();
      try {
        // P6 stage 3 (C-32) added stop_pauses_mission: an owner Stop now
        // pauses the chat's open mission instead of failing it. Its Wave E
        // added sessions_library: this daemon answers the Sessions ops.
        expect(posts[0]!.capabilities).toEqual([
          "mission_events",
          "mission_goal_loop",
          "mission_pause",
          "request_reason",
          "stop_pauses_mission",
          "sessions_library",
          "changes_rpc",
          "session_model_control",
        ]);
      } finally {
        hb.stop();
      }
    });

    it("omits the key entirely when the set is empty, never sending []", () => {
      // The backend REPLACES the stored declaration with whatever arrives, so
      // an empty array would silently wipe a set another release declared.
      const posts: HeartbeatDto[] = [];
      const hb = new HeartbeatController({
        version: "0.7.0",
        capabilities: [],
        postHeartbeat: async (b) => void posts.push(b),
      });
      hb.start();
      try {
        expect(posts[0]).not.toHaveProperty("capabilities");
      } finally {
        hb.stop();
      }
      const none: HeartbeatDto[] = [];
      const hb2 = new HeartbeatController({
        version: "0.7.0",
        postHeartbeat: async (b) => void none.push(b),
      });
      hb2.start();
      try {
        expect(none[0]).not.toHaveProperty("capabilities");
      } finally {
        hb2.stop();
      }
    });

    it("carries the FULL set on every beat, not a delta", () => {
      const posts: HeartbeatDto[] = [];
      const hb = new HeartbeatController({
        version: "0.7.0",
        capabilities: DECLARED_CAPABILITIES,
        postHeartbeat: async (b) => void posts.push(b),
      });
      hb.start();
      try {
        hb.setLastError({ code: "backfill_failed", message: "boom", at: "x" });
        expect(posts).toHaveLength(2);
        for (const post of posts)
          expect(post.capabilities).toEqual([
            "mission_events",
            "mission_goal_loop",
            "mission_pause",
            "request_reason",
            "stop_pauses_mission",
            "sessions_library",
            "changes_rpc",
            "session_model_control",
          ]);
      } finally {
        hb.stop();
      }
    });

    it("carries the pause and the goal loop, and never the checker", () => {
      // The beat is where a declaration actually reaches the app, so the
      // inversion is pinned here as well as at the constant. mission_pause
      // and mission_goal_loop ship with stage 6's native goal;
      // mission_goal_checks never does, because there is no separate judge on
      // this channel and the owner's card must never say there is.
      const posts: HeartbeatDto[] = [];
      const hb = new HeartbeatController({
        version: "0.8.0",
        capabilities: DECLARED_CAPABILITIES,
        postHeartbeat: async (b) => void posts.push(b),
      });
      hb.start();
      try {
        expect(posts[0]!.capabilities).toContain("mission_pause");
        expect(posts[0]!.capabilities).toContain("mission_goal_loop");
        expect(posts[0]!.capabilities).not.toContain("mission_goal_checks");
      } finally {
        hb.stop();
      }
    });

    it("copies the set so a caller cannot mutate what was already posted", () => {
      const declared = ["mission_events"];
      const posts: HeartbeatDto[] = [];
      const hb = new HeartbeatController({
        version: "0.7.0",
        capabilities: declared,
        postHeartbeat: async (b) => void posts.push(b),
      });
      hb.start();
      try {
        declared.push("invented_later");
        expect(posts[0]!.capabilities).toEqual(["mission_events"]);
      } finally {
        hb.stop();
      }
    });
  });
});

/**
 * Mission 104 (design 2.2, Visibility): the heartbeat carries the computer's
 * identity and the supervisor's update readiness, in the backend
 * HeartbeatDto's exact shape, and the local file carries the busy signal the
 * supervisor's safe moment reads (finding 9).
 */
describe("identity, update readiness and the busy signal", () => {
  let tempHome: string;
  const originalCodexBgosHome = process.env.CODEX_BGOS_HOME;
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-hb-ka-"));
    process.env.CODEX_BGOS_HOME = tempHome;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodexBgosHome === undefined) delete process.env.CODEX_BGOS_HOME;
    else process.env.CODEX_BGOS_HOME = originalCodexBgosHome;
  });

  const readiness = {
    latestKnownVersion: "0.19.2",
    updateReadiness: {
      supervised: "launchd" as const,
      autoUpdateEnabled: true,
      rollbackLatched: false,
      pendingRestartVersion: "0.19.2",
    },
  };

  it("posts env {platform, machineId, role:'agent'}, latestKnownVersion and updateReadiness", () => {
    const posts: HeartbeatDto[] = [];
    const hb = new HeartbeatController({
      version: "0.19.0",
      postHeartbeat: async (b) => void posts.push(b),
      env: () => heartbeatEnv(() => "machine-0001-abcd", "darwin"),
      updateReport: () => readiness,
    });
    hb.start();
    try {
      expect(posts[0]).toMatchObject({
        daemonVersion: "0.19.0",
        env: { platform: "darwin", machineId: "machine-0001-abcd", role: "agent" },
        latestKnownVersion: "0.19.2",
        updateReadiness: readiness.updateReadiness,
      });
      // Exactly the backend's keys: HeartbeatEnvDto and sanitizeUpdateReadiness.
      expect(Object.keys(posts[0].env!).sort()).toEqual(["machineId", "platform", "role"]);
      expect(Object.keys(posts[0].updateReadiness!).sort()).toEqual([
        "autoUpdateEnabled",
        "pendingRestartVersion",
        "rollbackLatched",
        "supervised",
      ]);
    } finally {
      hb.stop();
    }
  });

  it("omits machineId when none could be persisted, and sends null for an unknown latest", () => {
    const posts: HeartbeatDto[] = [];
    const hb = new HeartbeatController({
      version: "0.19.0",
      postHeartbeat: async (b) => void posts.push(b),
      env: () => heartbeatEnv(() => "", "linux"),
      updateReport: () => ({ ...readiness, latestKnownVersion: null }),
    });
    hb.start();
    try {
      expect(posts[0].env).toEqual({ platform: "linux", role: "agent" });
      expect(posts[0]).toHaveProperty("latestKnownVersion", null);
    } finally {
      hb.stop();
    }
  });

  it("a failing readiness read never stops the heartbeat", () => {
    const posts: HeartbeatDto[] = [];
    const hb = new HeartbeatController({
      version: "0.19.0",
      postHeartbeat: async (b) => void posts.push(b),
      env: () => {
        throw new Error("no home");
      },
      updateReport: () => {
        throw new Error("unreadable");
      },
    });
    hb.start();
    try {
      expect(posts).toHaveLength(1);
      expect(posts[0]).not.toHaveProperty("env");
      expect(posts[0]).not.toHaveProperty("updateReadiness");
    } finally {
      hb.stop();
    }
  });

  it("writes busy and lastActivityAt, immediately on a busy change", () => {
    let now = Date.parse("2026-10-06T20:00:00.000Z");
    const hb = new HeartbeatController({
      version: "0.19.0",
      postHeartbeat: async () => {},
      now: () => now,
    });
    hb.start();
    try {
      const first = heartbeatFile(tempHome);
      expect(first.busy).toBe(false);
      // Process start counts as activity: a fresh child waits out the window.
      expect(first.lastActivityAt).toBe("2026-10-06T20:00:00.000Z");
      now += 5_000;
      hb.setBusy(true);
      expect(heartbeatFile(tempHome)).toMatchObject({
        busy: true,
        lastActivityAt: "2026-10-06T20:00:05.000Z",
      });
      now += 60_000;
      hb.setBusy(false);
      expect(heartbeatFile(tempHome)).toMatchObject({
        busy: false,
        lastActivityAt: "2026-10-06T20:01:05.000Z",
      });
    } finally {
      hb.stop();
    }
  });

  it("review F1: an inbound message is written to the file at once, not at the next 30 s beat", () => {
    let now = Date.parse("2026-10-06T20:00:00.000Z");
    const hb = new HeartbeatController({
      version: "0.19.0",
      postHeartbeat: async () => {},
      now: () => now,
    });
    hb.start();
    try {
      now += 11 * 60_000;
      hb.recordInbound();
      expect(heartbeatFile(tempHome)).toMatchObject({
        lastInboundAt: "2026-10-06T20:11:00.000Z",
        lastActivityAt: "2026-10-06T20:11:00.000Z",
      });
    } finally {
      hb.stop();
    }
  });

  it("an inbound or outbound message is activity too", () => {
    let now = Date.parse("2026-10-06T20:00:00.000Z");
    const hb = new HeartbeatController({
      version: "0.19.0",
      postHeartbeat: async () => {},
      now: () => now,
    });
    now += 1_000;
    hb.recordInbound();
    expect(hb.snapshotFile().lastActivityAt).toBe("2026-10-06T20:00:01.000Z");
    now += 1_000;
    hb.recordOutbound();
    expect(hb.snapshotFile().lastActivityAt).toBe("2026-10-06T20:00:02.000Z");
  });
});

/**
 * HOAI board row 9c3d6b2c, session liveness: the heartbeat this daemon already
 * POSTs every minute now carries the busy signal and the last activity it
 * already writes to its local file, under the shared contract's key and field
 * names (`sessionStatus: { v, at, busy, lastActivityAt }`), so the server can
 * tell a Codex agent that is working from one that has stopped. Nothing else:
 * this daemon does not report a task, a question or a running command, and the
 * server claims nothing from a field it was not sent.
 */
describe("session status on the network heartbeat", () => {
  let tempHome: string;
  const originalCodexBgosHome = process.env.CODEX_BGOS_HOME;
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "codex-hb-status-"));
    process.env.CODEX_BGOS_HOME = tempHome;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalCodexBgosHome === undefined) delete process.env.CODEX_BGOS_HOME;
    else process.env.CODEX_BGOS_HOME = originalCodexBgosHome;
  });

  it("rides every beat, with the same busy and last activity as the local file", () => {
    let now = Date.parse("2026-10-09T12:00:00.000Z");
    const posts: HeartbeatDto[] = [];
    const hb = new HeartbeatController({
      version: "0.19.0",
      postHeartbeat: async (b) => void posts.push(b),
      now: () => now,
    });
    hb.start();
    try {
      expect(posts[0].sessionStatus).toEqual({
        v: 1,
        at: "2026-10-09T12:00:00.000Z",
        busy: false,
        lastActivityAt: "2026-10-09T12:00:00.000Z",
      });
      now += 5_000;
      hb.setBusy(true);
      now += 55_000;
      vi.advanceTimersByTime(60_000);
      expect(posts).toHaveLength(2);
      expect(posts[1].sessionStatus).toEqual({
        v: 1,
        at: "2026-10-09T12:01:00.000Z",
        busy: true,
        lastActivityAt: "2026-10-09T12:00:05.000Z",
      });
      const file = heartbeatFile(tempHome);
      expect(posts[1].sessionStatus?.busy).toBe(file.busy);
      expect(posts[1].sessionStatus?.lastActivityAt).toBe(file.lastActivityAt);
    } finally {
      hb.stop();
    }
  });

  it("is a report the server's own parser reads, carrying the four Codex fields only", () => {
    const posts: HeartbeatDto[] = [];
    const hb = new HeartbeatController({
      version: "0.19.0",
      postHeartbeat: async (b) => void posts.push(b),
      now: () => Date.parse("2026-10-09T12:00:00.000Z"),
    });
    hb.start();
    try {
      const wire = JSON.parse(JSON.stringify(posts[0].sessionStatus));
      expect(Object.keys(wire)).toEqual(["v", "at", "busy", "lastActivityAt"]);
      expect(parseSessionStatus(wire)).toEqual({ ok: true, report: wire });
      // Nothing it does not know: no task, no counts, so the server claims
      // nothing from them.
      for (const field of SESSION_STATUS_FIELDS.slice(4)) {
        expect(wire).not.toHaveProperty(field);
      }
    } finally {
      hb.stop();
    }
  });
});
