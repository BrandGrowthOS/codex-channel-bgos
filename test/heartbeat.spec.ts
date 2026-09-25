/**
 * HeartbeatController (contract C1): local file writes + network POST cadence,
 * error transitions, and the fatal-latch network disable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DECLARED_CAPABILITIES } from "../src/declared-capabilities.js";
import { HeartbeatController, type HeartbeatDto } from "../src/heartbeat.js";

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
          "stop_pauses_mission",
          "sessions_library",
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
            "stop_pauses_mission",
            "sessions_library",
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
