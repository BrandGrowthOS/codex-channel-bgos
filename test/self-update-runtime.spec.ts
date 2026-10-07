/**
 * Self update effects (design 2.2, decision D7): the staged install, the
 * runtime swap and the rollback against a real temp dir with a fake exec, and
 * the supervisor's updater driven through whole flows with every effect
 * faked. No network, no npm, no service manager: everything is injected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CHECK_RETRY_MS,
  CONFIRM_MAX_BOOTS,
  CONFIRM_WINDOW_MS,
  FIRST_CHECK_DELAY_MS,
  LATEST_FRESH_MS,
  QUIET_WINDOW_MS,
  RENAME_RETRY_MS,
  ROLLBACK_MAX_ATTEMPTS,
  SelfUpdater,
  UPDATE_WAIT_NOTICE_MS,
  fetchLatestVersion,
  nodeRuntimeFs,
  npmCliPath,
  readUpdateState,
  renameWithRetry,
  restoreRuntime,
  rollbackRuntime,
  runtimeCli,
  runtimePaths,
  stageRuntime,
  swapRuntime,
  writeUpdateState,
  emptyUpdateState,
  type ChildHeartbeat,
  type ChildStopReply,
  type Exec,
  type RenameRetry,
  type RuntimeFs,
  type SelfUpdaterDeps,
} from "../src/setup/self-update.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const tempHome = () => {
  const home = mkdtempSync(join(tmpdir(), "codex-self-update-"));
  homes.push(home);
  return home;
};

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** A runtime folder the way npm --prefix leaves it, with a marker to tell versions apart. */
function makeRuntime(dir: string, version: string, codex = "0.154.0") {
  writeJson(join(dir, "node_modules", "codex-channel-bgos", "package.json"), { version });
  mkdirSync(dirname(runtimeCli(dir)), { recursive: true });
  writeFileSync(runtimeCli(dir), `// ${version}\n`);
  writeJson(join(dir, "node_modules", "@openai", "codex", "package.json"), { version: codex });
  writeFileSync(join(dir, "MARKER"), version);
}
const marker = (dir: string) => readFileSync(join(dir, "MARKER"), "utf8");
/** No retry: a failure stands at once, as it does off Windows. */
const POSIX: RenameRetry = {
  platform: "darwin",
  budgetMs: 0,
  now: () => 0,
  sleep: async () => {},
};

const EXEC_PATH = "/opt/node/bin/node";
const NPM_CLI = npmCliPath(EXEC_PATH, "darwin", () => true)!;
const fsWithNpm: RuntimeFs = {
  ...nodeRuntimeFs,
  exists: (path) => path === NPM_CLI || existsSync(path),
};

/** npm and the staged CLI's --version, as a recording fake. */
function fakeExec(opts: {
  installCode?: number;
  probeOut?: (version: string) => string;
  stagedCodex?: string;
} = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    if (args[1] === "install") {
      const prefix = args[args.indexOf("--prefix") + 1];
      if (opts.installCode) {
        // npm can die half way, leaving a partial prefix behind.
        mkdirSync(join(prefix, "node_modules", ".staging"), { recursive: true });
        return { code: opts.installCode, stdout: "", stderr: "ETARGET no matching version" };
      }
      const version = args.find((a) => a.startsWith("codex-channel-bgos@"))!.split("@")[1];
      makeRuntime(prefix, version, opts.stagedCodex ?? args.find((a) => a.startsWith("@openai/codex@"))!.split("@")[2]);
      return { code: 0, stdout: "added 120 packages", stderr: "" };
    }
    if (args[1] === "--version") {
      const version = readFileSync(args[0], "utf8").replace(/[/\s]/g, "");
      return { code: 0, stdout: `${opts.probeOut ? opts.probeOut(version) : version}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { exec, calls };
}

describe("stageRuntime: install into runtime.next with Codex pinned, then probe", () => {
  it("installs the new connector beside the installed Codex version and probes its CLI", async () => {
    const home = tempHome();
    makeRuntime(runtimePaths(home).runtime, "0.19.0", "0.154.3");
    const { exec, calls } = fakeExec();
    await stageRuntime({ home, version: "0.19.2", execPath: EXEC_PATH, platform: "darwin", exec, fs: fsWithNpm });
    expect(calls[0]).toEqual({
      command: EXEC_PATH,
      args: [NPM_CLI, "install", "--prefix", runtimePaths(home).next, "--no-audit", "--no-fund", "--ignore-scripts", "codex-channel-bgos@0.19.2", "@openai/codex@0.154.3"],
    });
    expect(calls[1]).toEqual({ command: EXEC_PATH, args: [runtimeCli(runtimePaths(home).next), "--version"] });
    expect(marker(runtimePaths(home).next)).toBe("0.19.2");
    // The live runtime is untouched while staging.
    expect(marker(runtimePaths(home).runtime)).toBe("0.19.0");
  });

  it("refuses to stage when the installed Codex version is unknown (never let Codex float)", async () => {
    const home = tempHome();
    mkdirSync(runtimePaths(home).runtime, { recursive: true });
    const { exec, calls } = fakeExec();
    await expect(
      stageRuntime({ home, version: "0.19.2", execPath: EXEC_PATH, platform: "darwin", exec, fs: fsWithNpm }),
    ).rejects.toThrow("Codex runtime version is unknown");
    expect(calls).toHaveLength(0);
  });

  it("refuses when npm is not next to node", async () => {
    const home = tempHome();
    makeRuntime(runtimePaths(home).runtime, "0.19.0");
    const { exec, calls } = fakeExec();
    await expect(
      stageRuntime({ home, version: "0.19.2", execPath: EXEC_PATH, platform: "darwin", exec, fs: nodeRuntimeFs }),
    ).rejects.toThrow("npm was not found");
    expect(calls).toHaveLength(0);
  });

  it("a failed npm install leaves no runtime.next behind", async () => {
    const home = tempHome();
    makeRuntime(runtimePaths(home).runtime, "0.19.0");
    mkdirSync(runtimePaths(home).next, { recursive: true });
    const { exec } = fakeExec({ installCode: 1 });
    await expect(
      stageRuntime({ home, version: "0.19.2", execPath: EXEC_PATH, platform: "darwin", exec, fs: fsWithNpm }),
    ).rejects.toThrow("ETARGET");
    expect(existsSync(runtimePaths(home).next)).toBe(false);
  });

  it("a staged CLI that does not answer its own version is thrown away", async () => {
    const home = tempHome();
    makeRuntime(runtimePaths(home).runtime, "0.19.0");
    const { exec } = fakeExec({ probeOut: () => "SyntaxError: Unexpected token" });
    await expect(
      stageRuntime({ home, version: "0.19.2", execPath: EXEC_PATH, platform: "darwin", exec, fs: fsWithNpm }),
    ).rejects.toThrow("did not start");
    expect(existsSync(runtimePaths(home).next)).toBe(false);
  });

  it("a staged runtime whose Codex drifted from the pin is thrown away", async () => {
    const home = tempHome();
    makeRuntime(runtimePaths(home).runtime, "0.19.0", "0.154.0");
    const { exec } = fakeExec({ stagedCodex: "0.160.0" });
    await expect(
      stageRuntime({ home, version: "0.19.2", execPath: EXEC_PATH, platform: "darwin", exec, fs: fsWithNpm }),
    ).rejects.toThrow("Codex 0.160.0");
    expect(existsSync(runtimePaths(home).next)).toBe(false);
  });
});

describe("swapRuntime and rollbackRuntime on a real folder", () => {
  it("swaps runtime.next in and keeps the old one as runtime.prev", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    makeRuntime(p.runtime, "0.19.0");
    makeRuntime(p.next, "0.19.2");
    await swapRuntime(home);
    expect(marker(p.runtime)).toBe("0.19.2");
    expect(marker(p.prev)).toBe("0.19.0");
    expect(existsSync(p.next)).toBe(false);
  });

  it("puts the old runtime back when the second rename fails", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    makeRuntime(p.runtime, "0.19.0");
    makeRuntime(p.next, "0.19.2");
    const failing: RuntimeFs = {
      ...nodeRuntimeFs,
      rename: (from, to) => {
        if (from === p.next) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
        nodeRuntimeFs.rename(from, to);
      },
    };
    await expect(swapRuntime(home, failing, POSIX)).rejects.toThrow("EBUSY");
    expect(marker(p.runtime)).toBe("0.19.0");
    expect(existsSync(p.prev)).toBe(false);
    expect(marker(p.next)).toBe("0.19.2");
  });

  it("refuses to swap with nothing staged", async () => {
    const home = tempHome();
    makeRuntime(runtimePaths(home).runtime, "0.19.0");
    await expect(swapRuntime(home)).rejects.toThrow("Nothing is staged");
    expect(marker(runtimePaths(home).runtime)).toBe("0.19.0");
  });

  it("rolls back: runtime.prev becomes runtime again and the failed one is removed", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    makeRuntime(p.runtime, "0.19.0");
    makeRuntime(p.next, "0.19.2");
    await swapRuntime(home);
    await rollbackRuntime(home);
    expect(marker(p.runtime)).toBe("0.19.0");
    expect(existsSync(p.prev)).toBe(false);
    expect(existsSync(p.failed)).toBe(false);
  });

  it("a rollback that cannot finish leaves the running version in place", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    makeRuntime(p.runtime, "0.19.2");
    makeRuntime(p.prev, "0.19.0");
    const failing: RuntimeFs = {
      ...nodeRuntimeFs,
      rename: (from, to) => {
        if (from === p.prev) throw new Error("EPERM");
        nodeRuntimeFs.rename(from, to);
      },
    };
    await expect(rollbackRuntime(home, failing, POSIX)).rejects.toThrow("EPERM");
    expect(marker(p.runtime)).toBe("0.19.2");
    expect(marker(p.prev)).toBe("0.19.0");
  });
});

describe("review F5: renames on Windows are retried, and a runtime that could not be put back is restored", () => {
  /** A clock that sleeping moves forward, so a 60 s budget runs in no time. */
  function windowsRetry() {
    let now = 0;
    const sleeps: number[] = [];
    const retry: RenameRetry = {
      platform: "win32",
      budgetMs: RENAME_RETRY_MS,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    };
    return { retry, sleeps };
  }
  const held = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

  it("a rename that antivirus or the indexer holds a moment goes through once it is let go", async () => {
    const { retry, sleeps } = windowsRetry();
    let calls = 0;
    await renameWithRetry(
      () => {
        if (++calls <= 2) throw held("EPERM");
      },
      "a",
      "b",
      retry,
    );
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it("EACCES and EBUSY are retried too, for up to RENAME_RETRY_MS, then the error stands", async () => {
    for (const code of ["EACCES", "EBUSY"]) {
      const { retry, sleeps } = windowsRetry();
      let calls = 0;
      await expect(
        renameWithRetry(() => void (calls++, (() => { throw held(code); })()), "a", "b", retry),
      ).rejects.toThrow(code);
      expect(calls).toBeGreaterThan(2);
      expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(RENAME_RETRY_MS);
    }
    expect(RENAME_RETRY_MS).toBe(60_000);
  });

  it("anything else, and any error off Windows, fails at once", async () => {
    const { retry } = windowsRetry();
    let calls = 0;
    await expect(
      renameWithRetry(() => void (calls++, (() => { throw held("ENOENT"); })()), "a", "b", retry),
    ).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
    await expect(
      renameWithRetry(() => void (calls++, (() => { throw held("EPERM"); })()), "a", "b", { ...retry, platform: "darwin" }),
    ).rejects.toThrow("EPERM");
    expect(calls).toBe(2);
  });

  it("the swap seconds after npm wrote runtime.next goes through on Windows", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    makeRuntime(p.runtime, "0.19.0");
    makeRuntime(p.next, "0.19.2");
    let held2 = 2;
    const fresh: RuntimeFs = {
      ...nodeRuntimeFs,
      rename: (from, to) => {
        if (from === p.next && held2-- > 0) throw held("EPERM");
        nodeRuntimeFs.rename(from, to);
      },
    };
    await swapRuntime(home, fresh, windowsRetry().retry);
    expect(marker(p.runtime)).toBe("0.19.2");
    expect(marker(p.prev)).toBe("0.19.0");
  });

  it("a swap whose undo fails too names the first error, and restoreRuntime puts the running version back", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    makeRuntime(p.runtime, "0.19.0");
    makeRuntime(p.next, "0.19.2");
    const stuck: RuntimeFs = {
      ...nodeRuntimeFs,
      rename: (from, to) => {
        if (from === p.next) throw held("EPERM");
        if (from === p.prev) throw held("EBUSY");
        nodeRuntimeFs.rename(from, to);
      },
    };
    await expect(swapRuntime(home, stuck, POSIX)).rejects.toThrow("EPERM");
    expect(existsSync(p.runtime)).toBe(false);
    expect(await restoreRuntime(home, "0.19.0", nodeRuntimeFs, undefined, POSIX)).toBe(true);
    expect(marker(p.runtime)).toBe("0.19.0");
    expect(marker(p.next)).toBe("0.19.2");
  });

  it("restoreRuntime brings back the folder holding the running version first, and says when it cannot", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    // A rollback whose undo failed: the target in prev, the running one in failed.
    makeRuntime(p.prev, "0.19.0");
    makeRuntime(p.failed, "0.19.2");
    const stuck: RuntimeFs = {
      ...nodeRuntimeFs,
      rename: () => {
        throw held("EPERM");
      },
    };
    expect(await restoreRuntime(home, "0.19.2", stuck, undefined, POSIX)).toBe(false);
    expect(await restoreRuntime(home, "0.19.2", nodeRuntimeFs, undefined, POSIX)).toBe(true);
    expect(marker(p.runtime)).toBe("0.19.2");
    // In place already: nothing moves.
    expect(await restoreRuntime(home, "0.19.0", nodeRuntimeFs, undefined, POSIX)).toBe(true);
    expect(marker(p.runtime)).toBe("0.19.2");
  });

  it("a rollback tried again after its undo failed finishes it: runtime.prev is all that is left to move", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    makeRuntime(p.prev, "0.19.0");
    makeRuntime(p.failed, "0.19.2");
    await rollbackRuntime(home, nodeRuntimeFs, POSIX);
    expect(marker(p.runtime)).toBe("0.19.0");
    expect(existsSync(p.prev)).toBe(false);
    expect(existsSync(p.failed)).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  it("reads the latest dist tag", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ latest: "0.19.2", next: "0.20.0" }))) as unknown as typeof fetch;
    expect(await fetchLatestVersion(fetchImpl)).toBe("0.19.2");
    expect((fetchImpl as any).mock.calls[0][0]).toBe(
      "https://registry.npmjs.org/-/package/codex-channel-bgos/dist-tags",
    );
  });
  it("is null for a tag that is not a plain version, and throws on an HTTP error", async () => {
    const odd = (async () => new Response(JSON.stringify({ latest: "next-please" }))) as unknown as typeof fetch;
    expect(await fetchLatestVersion(odd)).toBeNull();
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchLatestVersion(down)).rejects.toThrow("503");
  });
});

// ---------------------------------------------------------------------------
// The updater, flow by flow
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-10-06T20:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function idleHeartbeat(now: number, change: Partial<ChildHeartbeat> = {}): ChildHeartbeat {
  return {
    ts: iso(now - 2_000),
    pid: 4242,
    version: "0.19.0",
    wsConnected: true,
    busy: false,
    lastActivityAt: iso(now - QUIET_WINDOW_MS - 1_000),
    ...change,
  };
}

function harness(home: string, change: Partial<SelfUpdaterDeps> = {}) {
  const events: string[] = [];
  let now = T0 + FIRST_CHECK_DELAY_MS;
  let heartbeat: ChildHeartbeat | null = idleHeartbeat(now);
  let reply: ChildStopReply = "stopping";
  let staged = false;
  const deps: SelfUpdaterDeps = {
    home,
    currentVersion: "0.19.0",
    supervised: "launchd",
    enabled: true,
    managedRuntime: true,
    supervisorPid: 900,
    startedAtMs: T0,
    now: () => now,
    random: () => 0,
    fetchLatest: vi.fn(async () => "0.19.2"),
    stage: vi.fn(async (v: string) => {
      events.push(`stage:${v}`);
      staged = true;
    }),
    hasStaged: () => staged,
    swap: vi.fn(() => void events.push("swap")),
    rollback: vi.fn(() => void events.push("rollback")),
    removePrevious: vi.fn(() => void events.push("removePrevious")),
    removeStaged: vi.fn(() => void events.push("removeStaged")),
    runtimeCodexVersion: () => "0.154.0",
    stopRequested: () => false,
    restoreRuntime: vi.fn(async () => true),
    readHeartbeat: () => heartbeat,
    childPid: () => 4242,
    requestChildStop: vi.fn(async () => {
      events.push(`requestStop:${reply}`);
      return reply;
    }),
    waitChildExit: vi.fn(async () => {
      events.push("waitExit");
      return true;
    }),
    forceStopChild: vi.fn(async () => void events.push("forceStop")),
    resumeChild: vi.fn(() => void events.push("resume")),
    restartSupervisor: vi.fn(async () => void events.push("restartSupervisor")),
    log: () => {},
    ...change,
  };
  return {
    deps,
    events,
    setNow: (ms: number) => (now = ms),
    setHeartbeat: (hb: ChildHeartbeat | null) => (heartbeat = hb),
    setReply: (r: ChildStopReply) => (reply = r),
    setStaged: (s: boolean) => (staged = s),
    get now() {
      return now;
    },
  };
}

describe("SelfUpdater flows", () => {
  it("boot claims the state for this supervisor so the child reports it", () => {
    const home = tempHome();
    const h = harness(home);
    new SelfUpdater(h.deps).boot();
    expect(readUpdateState(home)).toMatchObject({
      supervisorPid: 900,
      supervised: "launchd",
      autoUpdateEnabled: true,
    });
  });

  it("checks, stages, and applies at a safe moment: stop through the child, swap, restart the supervisor", async () => {
    const home = tempHome();
    const h = harness(home);
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("applied");
    expect(h.events).toEqual([
      "stage:0.19.2",
      "requestStop:stopping",
      "waitExit",
      "swap",
      "restartSupervisor",
    ]);
    const state = readUpdateState(home)!;
    expect(state.latestKnownVersion).toBe("0.19.2");
    expect(state.stagedVersion).toBeNull();
    expect(state.pendingConfirm).toMatchObject({ version: "0.19.2", previousVersion: "0.19.0", boots: 0 });
    expect(Date.parse(state.nextCheckAt!)).toBe(h.now + 24 * 60 * 60 * 1000);
  });

  it("never applies while the heartbeat says busy, and never asks the child to stop", async () => {
    const home = tempHome();
    const h = harness(home);
    h.setHeartbeat(idleHeartbeat(h.now, { busy: true }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:busy");
    expect(h.events).toEqual(["stage:0.19.2"]);
    expect(h.deps.requestChildStop).not.toHaveBeenCalled();
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: "0.19.2", waitingReason: "busy" });
  });

  it("the next daily check never installs a version already staged again (npm runs for up to 10 minutes)", async () => {
    const home = tempHome();
    const h = harness(home);
    h.setHeartbeat(idleHeartbeat(h.now, { busy: true }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:busy");
    // A day later the agent is still busy and the registry still says 0.19.2.
    h.setNow(Date.parse(readUpdateState(home)!.nextCheckAt!) + 1);
    h.setHeartbeat(idleHeartbeat(h.now, { busy: true }));
    expect(await updater.tick()).toBe("waiting:busy");
    expect(h.deps.fetchLatest).toHaveBeenCalledTimes(2);
    expect(h.deps.stage).toHaveBeenCalledTimes(1);
    expect(readUpdateState(home)!.stagedVersion).toBe("0.19.2");
    // A newer version than the staged one is staged in its place.
    h.deps.fetchLatest = vi.fn(async () => "0.19.3");
    h.setNow(Date.parse(readUpdateState(home)!.nextCheckAt!) + 1);
    h.setHeartbeat(idleHeartbeat(h.now, { busy: true }));
    expect(await updater.tick()).toBe("waiting:busy");
    expect(h.events).toEqual(["stage:0.19.2", "stage:0.19.3"]);
    expect(readUpdateState(home)!.stagedVersion).toBe("0.19.3");
  });

  it("review F4: a staged version that latest no longer names (a pulled release) is dropped, never applied", async () => {
    const home = tempHome();
    const h = harness(home, { fetchLatest: vi.fn(async () => "0.20.0") });
    h.setHeartbeat(idleHeartbeat(h.now, { busy: true }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:busy");
    expect(readUpdateState(home)!.stagedVersion).toBe("0.20.0");
    // The maintainers pull 0.20.0 by moving latest back to 0.19.0.
    h.deps.fetchLatest = vi.fn(async () => "0.19.0");
    h.setNow(Date.parse(readUpdateState(home)!.nextCheckAt!) + 1);
    h.setHeartbeat(idleHeartbeat(h.now));
    expect(await updater.tick()).toBe("checked");
    expect(h.deps.requestChildStop).not.toHaveBeenCalled();
    expect(h.deps.swap).not.toHaveBeenCalled();
    // Its folder goes too (a whole runtime, some 300 MB).
    expect(h.events).toEqual(["stage:0.20.0", "removeStaged"]);
    expect(readUpdateState(home)).toMatchObject({
      latestKnownVersion: "0.19.0",
      stagedVersion: null,
      pendingConfirm: null,
    });
  });

  it("review F4: a release pulled hours after it was staged is dropped at the safe moment, not applied", async () => {
    const home = tempHome();
    const h = harness(home, { fetchLatest: vi.fn(async () => "0.20.0") });
    h.setHeartbeat(idleHeartbeat(h.now, { busy: true }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:busy");
    // Two hours later, a whole day before the next check, the maintainers
    // pull 0.20.0 by moving latest back, and the agent goes quiet.
    h.deps.fetchLatest = vi.fn(async () => "0.19.0");
    h.setNow(h.now + 2 * 60 * 60 * 1000);
    expect(h.now).toBeLessThan(Date.parse(readUpdateState(home)!.nextCheckAt!));
    h.setHeartbeat(idleHeartbeat(h.now));
    expect(await updater.tick()).toBe("checked");
    expect(h.deps.fetchLatest).toHaveBeenCalledTimes(1);
    expect(h.deps.requestChildStop).not.toHaveBeenCalled();
    expect(h.deps.swap).not.toHaveBeenCalled();
    expect(h.events).toEqual(["stage:0.20.0", "removeStaged"]);
    expect(readUpdateState(home)).toMatchObject({
      latestKnownVersion: "0.19.0",
      stagedVersion: null,
      waitingReason: null,
      pendingConfirm: null,
    });
  });

  it("review F4: latest read within the hour is trusted; an older read is read again and still applies while latest names the stage", async () => {
    expect(LATEST_FRESH_MS).toBe(60 * 60 * 1000);
    for (const [after, reads] of [
      [LATEST_FRESH_MS - 1, 1],
      [LATEST_FRESH_MS, 2],
    ] as const) {
      const home = tempHome();
      const h = harness(home);
      h.setHeartbeat(idleHeartbeat(h.now, { busy: true }));
      const updater = new SelfUpdater(h.deps);
      updater.boot();
      expect(await updater.tick()).toBe("waiting:busy");
      h.setNow(h.now + after);
      h.setHeartbeat(idleHeartbeat(h.now));
      expect(await updater.tick(), String(after)).toBe("applied");
      expect(h.deps.fetchLatest, String(after)).toHaveBeenCalledTimes(reads);
    }
  });

  it("review F4: a registry that cannot be read right before the switch makes it wait, and is asked again only after CHECK_RETRY_MS", async () => {
    const home = tempHome();
    const h = harness(home);
    h.setHeartbeat(idleHeartbeat(h.now, { busy: true }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:busy");
    h.deps.fetchLatest = vi.fn(async () => {
      throw new Error("ENOTFOUND registry.npmjs.org");
    });
    const at = (ms: number) => {
      h.setNow(ms);
      h.setHeartbeat(idleHeartbeat(ms));
    };
    const failedAt = h.now + 2 * 60 * 60 * 1000;
    at(failedAt);
    expect(await updater.tick()).toBe("waiting:latest_unknown");
    at(failedAt + 15_000);
    expect(await updater.tick()).toBe("waiting:latest_unknown");
    at(failedAt + CHECK_RETRY_MS - 1);
    expect(await updater.tick()).toBe("waiting:latest_unknown");
    expect(h.deps.fetchLatest).toHaveBeenCalledTimes(1);
    expect(h.deps.requestChildStop).not.toHaveBeenCalled();
    expect(h.deps.swap).not.toHaveBeenCalled();
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: "0.19.2", waitingReason: "latest_unknown" });
    // An hour on the registry answers again and still names the stage.
    h.deps.fetchLatest = vi.fn(async () => "0.19.2");
    at(failedAt + CHECK_RETRY_MS);
    expect(await updater.tick()).toBe("applied");
    expect(h.deps.fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("D6: a waiting update records since when, and after 24 h says so once; it is never forced", async () => {
    const home = tempHome();
    const log = vi.fn();
    const h = harness(home, { log });
    const start = h.now;
    const at = (ms: number, change: Partial<ChildHeartbeat>) => {
      h.setNow(start + ms);
      h.setHeartbeat(idleHeartbeat(h.now, change));
    };
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    at(0, { busy: true });
    expect(await updater.tick()).toBe("waiting:busy");
    expect(readUpdateState(home)).toMatchObject({ waitingReason: "busy", waitingSince: iso(start) });
    // The reason moves; the wait it belongs to started when it started.
    at(60 * 60 * 1000, { lastActivityAt: iso(start + 60 * 60 * 1000 - 1_000) });
    expect(await updater.tick()).toBe("waiting:recent_activity");
    expect(readUpdateState(home)).toMatchObject({ waitingReason: "recent_activity", waitingSince: iso(start) });
    at(UPDATE_WAIT_NOTICE_MS - 1, { busy: true });
    await updater.tick();
    const waited = () => log.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("has waited"));
    expect(waited()).toEqual([]);
    at(UPDATE_WAIT_NOTICE_MS, { busy: true });
    expect(await updater.tick()).toBe("waiting:busy");
    at(UPDATE_WAIT_NOTICE_MS + 60 * 60 * 1000, { busy: true });
    await updater.tick();
    expect(waited()).toEqual(["update 0.19.2 has waited 24 h for an idle moment (busy); it is never forced"]);
    expect(h.deps.requestChildStop).not.toHaveBeenCalled();
    // The child is idle at last: the update applies and the wait is over.
    at(UPDATE_WAIT_NOTICE_MS + 2 * 60 * 60 * 1000, {});
    expect(await updater.tick()).toBe("applied");
    expect(readUpdateState(home)).toMatchObject({ waitingReason: null, waitingSince: null });
  });

  it("D6: a child that refuses at the last moment is a wait too", async () => {
    const home = tempHome();
    const h = harness(home);
    h.setReply("busy");
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:busy");
    expect(readUpdateState(home)).toMatchObject({ waitingReason: "busy", waitingSince: iso(h.now) });
  });

  it("nothing left to apply: no wait is recorded any more", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      stagedVersion: "0.19.0",
      stagedCodexVersion: "0.154.0",
      nextCheckAt: iso(T0 + 365 * 24 * 60 * 60 * 1000),
      waitingReason: "busy",
      waitingSince: iso(T0 - 60_000),
    });
    const h = harness(home);
    h.setStaged(true);
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("idle");
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: null, waitingReason: null, waitingSince: null });
  });

  it("D6: a wait that ends without an apply is over; the next update waits from its own start and is said again", async () => {
    const home = tempHome();
    const log = vi.fn();
    const h = harness(home, {
      log,
      swap: vi.fn(() => {
        throw new Error("EBUSY runtime");
      }),
    });
    const start = h.now;
    const at = (ms: number, change: Partial<ChildHeartbeat>) => {
      h.setNow(ms);
      h.setHeartbeat(idleHeartbeat(h.now, change));
    };
    const waited = () => log.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("has waited"));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    at(start, { busy: true });
    expect(await updater.tick()).toBe("waiting:busy");
    at(start + UPDATE_WAIT_NOTICE_MS, { busy: true });
    expect(await updater.tick()).toBe("waiting:busy");
    expect(waited()).toHaveLength(1);
    // Idle at last, but the switch fails: nothing is staged any more, so the
    // wait is over (not only after a stale stage).
    at(start + UPDATE_WAIT_NOTICE_MS + 60 * 60 * 1000, {});
    expect(await updater.tick()).toBe("apply_failed");
    at(start + UPDATE_WAIT_NOTICE_MS + 2 * 60 * 60 * 1000, {});
    expect(await updater.tick()).toBe("idle");
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: null, waitingReason: null, waitingSince: null });
    // The next version waits from its own start, and its 24 h are said too.
    h.deps.fetchLatest = vi.fn(async () => "0.19.3");
    const next = Date.parse(readUpdateState(home)!.nextCheckAt!) + 1;
    at(next, { busy: true });
    expect(await updater.tick()).toBe("waiting:busy");
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: "0.19.3", waitingSince: iso(next) });
    at(next + UPDATE_WAIT_NOTICE_MS - 1, { busy: true });
    await updater.tick();
    expect(waited()).toHaveLength(1);
    at(next + UPDATE_WAIT_NOTICE_MS, { busy: true });
    await updater.tick();
    expect(waited()).toEqual([
      "update 0.19.2 has waited 24 h for an idle moment (busy); it is never forced",
      "update 0.19.3 has waited 24 h for an idle moment (busy); it is never forced",
    ]);
  });

  it("review F2: an agent that is not connected waits; the new version could never confirm and would be latched as rolled back", async () => {
    const home = tempHome();
    const h = harness(home);
    h.setHeartbeat(idleHeartbeat(h.now, { wsConnected: false }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:disconnected");
    expect(h.deps.requestChildStop).not.toHaveBeenCalled();
    expect(h.deps.swap).not.toHaveBeenCalled();
    // Connected again, and still idle and quiet: the update applies.
    h.setHeartbeat(idleHeartbeat(h.now));
    expect(await updater.tick()).toBe("applied");
    expect(readUpdateState(home)!.rolledBack).toEqual([]);
  });

  it("waits out the 10 minute quiet window", async () => {
    const home = tempHome();
    const h = harness(home);
    h.setHeartbeat(idleHeartbeat(h.now, { lastActivityAt: iso(h.now - 60_000) }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:recent_activity");
    expect(h.deps.swap).not.toHaveBeenCalled();
  });

  it("a child that finds itself busy at the last moment keeps running: no swap, restarts resume", async () => {
    const home = tempHome();
    const h = harness(home);
    h.setReply("busy");
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:busy");
    expect(h.events).toEqual(["stage:0.19.2", "requestStop:busy", "resume"]);
    expect(h.deps.forceStopChild).not.toHaveBeenCalled();
  });

  it("a child that does not answer is never stopped for an update", async () => {
    const home = tempHome();
    const h = harness(home);
    h.setReply("unavailable");
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("waiting:child_unresponsive");
    expect(h.deps.forceStopChild).not.toHaveBeenCalled();
    expect(h.deps.swap).not.toHaveBeenCalled();
  });

  it("review F9: a stop request (a Repair's pause-service) while the child shuts down cancels the swap and the hand over", async () => {
    const home = tempHome();
    let stopRequested = false;
    const h = harness(home, {
      stopRequested: () => stopRequested,
      waitChildExit: vi.fn(async () => {
        // POST /stop lands while the child is shutting down.
        stopRequested = true;
        h.events.push("waitExit");
        return true;
      }),
    });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("stopped");
    expect(h.events).toEqual(["stage:0.19.2", "requestStop:stopping", "waitExit"]);
    expect(h.deps.swap).not.toHaveBeenCalled();
    expect(h.deps.restartSupervisor).not.toHaveBeenCalled();
    expect(h.deps.resumeChild).not.toHaveBeenCalled();
    // Still staged: the next supervisor applies it at its own safe moment.
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: "0.19.2", pendingConfirm: null });
  });

  it("review F9: a stop request before a rollback leaves the rollback owed and the folders alone", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 20_000), boots: 0, rollbackFailures: 0 },
    });
    let stopRequested = false;
    const h = harness(home, {
      currentVersion: "0.19.2",
      stopRequested: () => stopRequested,
      waitChildExit: vi.fn(async () => {
        stopRequested = true;
        return true;
      }),
    });
    h.setHeartbeat(null);
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    h.setNow(T0 + CONFIRM_WINDOW_MS);
    expect(await updater.tick()).toBe("stopped");
    expect(h.deps.rollback).not.toHaveBeenCalled();
    expect(h.deps.restartSupervisor).not.toHaveBeenCalled();
    expect(readUpdateState(home)!.pendingConfirm).toMatchObject({ version: "0.19.2" });
  });

  it("a shutdown that hangs after the child agreed is ended before the swap", async () => {
    const home = tempHome();
    const h = harness(home, {
      waitChildExit: vi.fn(async () => false),
    });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("applied");
    expect(h.events).toEqual(["stage:0.19.2", "requestStop:stopping", "forceStop", "swap", "restartSupervisor"]);
  });

  it("a failed swap keeps the agent on its version and running", async () => {
    const home = tempHome();
    const h = harness(home, {
      swap: vi.fn(() => {
        throw new Error("EBUSY");
      }),
    });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("apply_failed");
    expect(h.deps.restartSupervisor).not.toHaveBeenCalled();
    expect(h.deps.resumeChild).toHaveBeenCalled();
    expect(readUpdateState(home)!.lastError?.message).toContain("EBUSY");
  });

  it("review F5: a switch that could not even be undone relaunches nothing until the runtime is back", async () => {
    const home = tempHome();
    const restored = [false, true];
    const h = harness(home, {
      swap: vi.fn(() => {
        throw new Error("EPERM: operation not permitted, rename 'runtime.next'");
      }),
      restoreRuntime: vi.fn(async () => {
        const ok = restored.shift()!;
        h.events.push(`restore:${ok}`);
        return ok;
      }),
    });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("apply_failed");
    // No child from a runtime folder that is not there (it would exit every 5 s).
    expect(h.deps.resumeChild).not.toHaveBeenCalled();
    expect(readUpdateState(home)!.lastError?.message).toContain("runtime.next");
    // The next pass puts it back first, then the agent runs again.
    expect(await updater.tick()).toBe("runtime_restored");
    expect(h.events.slice(-2)).toEqual(["restore:true", "resume"]);
  });

  it("review F5: a rollback is never given up while there is no runtime to run", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 20_000), boots: 0, rollbackFailures: ROLLBACK_MAX_ATTEMPTS - 1 },
    });
    const h = harness(home, {
      currentVersion: "0.19.2",
      rollback: vi.fn(() => {
        throw new Error("EBUSY");
      }),
      restoreRuntime: vi.fn(async () => false),
    });
    h.setHeartbeat(null);
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    h.setNow(T0 + CONFIRM_WINDOW_MS);
    expect(await updater.tick()).toBe("rollback_failed");
    expect(readUpdateState(home)!.pendingConfirm).toMatchObject({ rollbackFailures: ROLLBACK_MAX_ATTEMPTS });
    expect(h.deps.resumeChild).not.toHaveBeenCalled();
  });

  it("CODEX_BGOS_AUTO_UPDATE=off: no check, no stage, no apply", async () => {
    const home = tempHome();
    const h = harness(home, { enabled: false });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("inactive");
    expect(h.deps.fetchLatest).not.toHaveBeenCalled();
    expect(readUpdateState(home)!.autoUpdateEnabled).toBe(false);
  });

  it("a supervise started by hand (no service) never updates, since nothing would bring it back", async () => {
    const home = tempHome();
    const h = harness(home, { supervised: "none" });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("inactive");
    expect(h.deps.fetchLatest).not.toHaveBeenCalled();
  });

  it("a failed registry read retries in an hour, not in a loop", async () => {
    const home = tempHome();
    const h = harness(home, {
      fetchLatest: vi.fn(async () => {
        throw new Error("ENOTFOUND registry.npmjs.org");
      }),
    });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    await updater.tick();
    const state = readUpdateState(home)!;
    expect(Date.parse(state.nextCheckAt!)).toBe(h.now + CHECK_RETRY_MS);
    expect(state.lastError?.message).toContain("ENOTFOUND");
    expect(await updater.tick()).not.toBe("check_failed");
    expect(h.deps.fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("does not stage a version that was rolled back here", async () => {
    const home = tempHome();
    writeUpdateState(home, { ...emptyUpdateState(), rolledBack: ["0.19.2"] });
    const h = harness(home);
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("checked");
    expect(h.deps.stage).not.toHaveBeenCalled();
  });

  it("the new supervisor confirms a healthy child and drops runtime.prev", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 20_000), boots: 0 },
    });
    const h = harness(home, { currentVersion: "0.19.2" });
    h.setNow(T0 + 30_000);
    h.setHeartbeat(idleHeartbeat(T0 + 30_000, { version: "0.19.2", lastActivityAt: iso(T0) }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(readUpdateState(home)!.pendingConfirm!.boots).toBe(1);
    expect(await updater.tick()).toBe("confirmed");
    expect(h.events).toEqual(["removePrevious"]);
    expect(readUpdateState(home)!.pendingConfirm).toBeNull();
  });

  it("rolls back when the new child does not connect within 3 minutes", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 20_000), boots: 0 },
    });
    const h = harness(home, { currentVersion: "0.19.2" });
    h.setHeartbeat(idleHeartbeat(T0, { version: "0.19.2", wsConnected: false }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    h.setNow(T0 + 60_000);
    expect(await updater.tick()).toBe("confirming");
    h.setNow(T0 + CONFIRM_WINDOW_MS);
    expect(await updater.tick()).toBe("rolled_back");
    expect(h.events).toEqual(["requestStop:stopping", "waitExit", "rollback", "restartSupervisor"]);
    const state = readUpdateState(home)!;
    expect(state.rolledBack).toEqual(["0.19.2"]);
    expect(state.pendingConfirm).toBeNull();
  });

  it("review F3: a rollback that fails keeps its pending confirmation, holds restarts and is tried again", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 20_000), boots: 0, rollbackFailures: 0 },
    });
    let failures = 1;
    const h = harness(home, {
      currentVersion: "0.19.2",
      rollback: vi.fn(() => {
        if (failures-- > 0) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
        h.events.push("rollback");
      }),
    });
    h.setHeartbeat(idleHeartbeat(T0, { version: "0.19.2", wsConnected: false }));
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    h.setNow(T0 + CONFIRM_WINDOW_MS);
    expect(await updater.tick()).toBe("rollback_failed");
    let state = readUpdateState(home)!;
    expect(state.pendingConfirm).toMatchObject({ version: "0.19.2", rollbackFailures: 1 });
    expect(state.rolledBack).toEqual(["0.19.2"]);
    expect(state.lastError?.message).toContain("EPERM");
    // The version judged broken is NOT relaunched while the rollback is owed.
    expect(h.deps.resumeChild).not.toHaveBeenCalled();
    expect(h.deps.restartSupervisor).not.toHaveBeenCalled();
    // Next pass: the same rollback, and this time it goes through.
    h.setNow(T0 + CONFIRM_WINDOW_MS + 15_000);
    expect(await updater.tick()).toBe("rolled_back");
    expect(h.deps.rollback).toHaveBeenCalledTimes(2);
    expect(h.events.slice(-2)).toEqual(["rollback", "restartSupervisor"]);
    state = readUpdateState(home)!;
    expect(state.pendingConfirm).toBeNull();
    expect(state.rolledBack).toEqual(["0.19.2"]);
  });

  it("review F3: a rollback that never succeeds gives up after ROLLBACK_MAX_ATTEMPTS and lets the agent run", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 20_000), boots: 0, rollbackFailures: 0 },
    });
    const h = harness(home, {
      currentVersion: "0.19.2",
      rollback: vi.fn(() => {
        throw new Error("There is no previous version to return to.");
      }),
    });
    h.setHeartbeat(null);
    h.setReply("unavailable");
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    for (let attempt = 1; attempt <= ROLLBACK_MAX_ATTEMPTS; attempt++) {
      h.setNow(T0 + CONFIRM_WINDOW_MS + attempt * 15_000);
      expect(await updater.tick()).toBe("rollback_failed");
      expect(h.deps.resumeChild).toHaveBeenCalledTimes(attempt < ROLLBACK_MAX_ATTEMPTS ? 0 : 1);
    }
    const state = readUpdateState(home)!;
    expect(state.pendingConfirm).toBeNull();
    expect(state.lastError?.message).toContain(`after ${ROLLBACK_MAX_ATTEMPTS} attempts`);
    expect(h.deps.rollback).toHaveBeenCalledTimes(ROLLBACK_MAX_ATTEMPTS);
    // Nothing is owed any more: the next pass does not try again.
    h.setNow(h.now + 15_000);
    await updater.tick();
    expect(h.deps.rollback).toHaveBeenCalledTimes(ROLLBACK_MAX_ATTEMPTS);
  });

  it("review F10: a version whose supervisor keeps dying before its first pass is rolled back by the next start, before anything else runs", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 60_000), boots: CONFIRM_MAX_BOOTS, rollbackFailures: 0 },
    });
    const h = harness(home, { currentVersion: "0.19.2" });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(updater.rollbackDue).toBe(true);
    expect(await updater.rollBackBeforeStart()).toBe(true);
    // No child runs yet: nothing is asked, held or killed.
    expect(h.events).toEqual(["rollback", "restartSupervisor"]);
    const state = readUpdateState(home)!;
    expect(state.pendingConfirm).toBeNull();
    expect(state.rolledBack).toEqual(["0.19.2"]);
  });

  it("review F10: nothing is owed on an ordinary boot", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 60_000), boots: 0, rollbackFailures: 0 },
    });
    const h = harness(home, { currentVersion: "0.19.2" });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(updater.rollbackDue).toBe(false);
    expect(await updater.rollBackBeforeStart()).toBe(false);
    expect(h.events).toEqual([]);
  });

  it("review F10 with F3: a rollback before start that fails stays owed, and the child is not relaunched", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0 - 60_000), boots: 0, rollbackFailures: 1 },
    });
    const h = harness(home, {
      currentVersion: "0.19.2",
      rollback: vi.fn(() => {
        throw new Error("EBUSY");
      }),
    });
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.rollBackBeforeStart()).toBe(false);
    expect(updater.rollbackDue).toBe(true);
    expect(readUpdateState(home)!.pendingConfirm).toMatchObject({ rollbackFailures: 2 });
    expect(h.deps.resumeChild).not.toHaveBeenCalled();
    expect(h.deps.requestChildStop).not.toHaveBeenCalled();
  });

  it("a rollback waits for a busy child too", async () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0), boots: 0 },
    });
    const h = harness(home, { currentVersion: "0.19.2" });
    h.setHeartbeat(null);
    h.setReply("busy");
    h.setNow(T0 + CONFIRM_WINDOW_MS);
    const updater = new SelfUpdater(h.deps);
    updater.boot();
    expect(await updater.tick()).toBe("rollback_waiting");
    expect(h.deps.rollback).not.toHaveBeenCalled();
    expect(readUpdateState(home)!.pendingConfirm).not.toBeNull();
  });

  it("review F7: a stage built before a repair changed the live Codex is dropped at boot, never applied", async () => {
    const home = tempHome();
    // 0.19.0 staged 0.19.2 beside Codex 0.154.0 and waited (busy).
    const first = harness(home);
    first.setHeartbeat(idleHeartbeat(first.now, { busy: true }));
    const old = new SelfUpdater(first.deps);
    old.boot();
    expect(await old.tick()).toBe("waiting:busy");
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: "0.19.2", stagedCodexVersion: "0.154.0" });
    // The owner's Repair reinstalled 0.19.0 with Codex 0.160.0 and started a
    // new supervisor. runtime.next (Codex 0.154.0) is still on disk.
    const second = harness(home, { runtimeCodexVersion: () => "0.160.0" });
    second.setStaged(true);
    const fresh = new SelfUpdater(second.deps);
    fresh.boot();
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: null, stagedCodexVersion: null });
    expect(second.events).toEqual(["removeStaged"]);
    expect(await fresh.tick()).toBe("idle");
    expect(second.deps.swap).not.toHaveBeenCalled();
  });

  it("a supervisor restart with the same live Codex keeps its stage", () => {
    const home = tempHome();
    writeUpdateState(home, { ...emptyUpdateState(), stagedVersion: "0.19.2", stagedCodexVersion: "0.154.0" });
    const h = harness(home);
    h.setStaged(true);
    new SelfUpdater(h.deps).boot();
    expect(readUpdateState(home)).toMatchObject({ stagedVersion: "0.19.2", stagedCodexVersion: "0.154.0" });
    expect(h.events).toEqual([]);
  });

  it("a repair from the app that installed another version clears the pending confirmation", () => {
    const home = tempHome();
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: { version: "0.19.2", previousVersion: "0.19.0", appliedAt: iso(T0), boots: 2 },
    });
    const h = harness(home, { currentVersion: "0.19.5" });
    new SelfUpdater(h.deps).boot();
    expect(readUpdateState(home)!.pendingConfirm).toBeNull();
  });
});

describe("the whole cycle on a real folder: stage, swap, new supervisor rolls back, old one skips", () => {
  it("returns to the previous runtime and never stages the failed version again", async () => {
    const home = tempHome();
    const p = runtimePaths(home);
    makeRuntime(p.runtime, "0.19.0");
    const { exec } = fakeExec();
    const real = (h: ReturnType<typeof harness>) => {
      h.deps.stage = (version) =>
        stageRuntime({ home, version, execPath: EXEC_PATH, platform: "darwin", exec, fs: fsWithNpm });
      h.deps.hasStaged = () => existsSync(p.next);
      h.deps.swap = () => swapRuntime(home);
      h.deps.rollback = () => rollbackRuntime(home);
      h.deps.restoreRuntime = () => restoreRuntime(home, h.deps.currentVersion);
      h.deps.removePrevious = () => nodeRuntimeFs.remove(p.prev);
      return h;
    };

    // The 0.19.0 supervisor stages 0.19.2 and switches at an idle moment.
    const first = real(harness(home));
    const old = new SelfUpdater(first.deps);
    old.boot();
    expect(await old.tick()).toBe("applied");
    expect(marker(p.runtime)).toBe("0.19.2");
    expect(marker(p.prev)).toBe("0.19.0");

    // The 0.19.2 supervisor starts; its child never connects.
    const second = real(harness(home, { currentVersion: "0.19.2" }));
    second.setHeartbeat(null);
    second.setReply("unavailable");
    const fresh = new SelfUpdater(second.deps);
    fresh.boot();
    second.setNow(T0 + CONFIRM_WINDOW_MS);
    expect(await fresh.tick()).toBe("rolled_back");
    expect(marker(p.runtime)).toBe("0.19.0");
    expect(existsSync(p.prev)).toBe(false);

    // The 0.19.0 supervisor is back and reports itself paused on 0.19.2.
    const third = real(harness(home));
    const back = new SelfUpdater(third.deps);
    back.boot();
    third.setNow(Date.parse(readUpdateState(home)!.nextCheckAt ?? iso(T0)) + 1);
    expect(await back.tick()).toBe("checked");
    expect(existsSync(p.next)).toBe(false);
    expect(readUpdateState(home)!.rolledBack).toEqual(["0.19.2"]);
  });
});
