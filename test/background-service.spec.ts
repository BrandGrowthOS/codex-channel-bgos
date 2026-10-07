/**
 * The per agent background service (design 2.2), as mission 104 changes it.
 * Every OS effect is injected: no launchctl, systemctl or reg.exe runs here,
 * and no file is written outside a temp dir.
 *
 * - The service definition names its own label (CODEX_BGOS_SERVICE), which
 *   is how `supervise` knows it runs as THIS home's service and may exit 75
 *   for an update (nothing restarts a supervise started by hand).
 * - CODEX_BGOS_AUTO_UPDATE set when the service is installed is written into
 *   it, so the off switch survives into launchd, systemd and the Run key.
 * - The child runs with an IPC channel (stop only if idle, finding 9) and
 *   the supervisor's pid (its readiness is trusted only from that pid).
 * - The hand over: exit 75 for launchd and systemd; on Windows, whose Run
 *   key restarts nothing, the hidden start-agent.vbs successor first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  childSpawnOptions,
  closeSupervisor,
  createChildRunner,
  handOverToSuccessor,
  installBackgroundService,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsLauncher,
  serviceEnvironment,
  serviceInstalled,
  serviceLabel,
  startSelfUpdate,
  supervisorUpdateControls,
} from "../src/setup/background-service.js";
import {
  CONFIRM_MAX_BOOTS,
  RENAME_RETRY_MS,
  RuntimeSwitches,
  SWITCH_SETTLE_MS,
  SelfUpdater,
  UPDATE_TICK_MS,
  countedRuntimeSwitches,
  emptyUpdateState,
  runtimePaths,
  writeUpdateState,
  type RenameRetry,
  type RuntimeFs,
} from "../src/setup/self-update.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "codex-bg-service-"));
  dirs.push(d);
  return d;
};

const HOME = "/Users/kc/.codex-bgos/agents/9";
const LABEL = serviceLabel(HOME);

describe("serviceEnvironment", () => {
  it("always names the service's own label", () => {
    expect(serviceEnvironment(HOME, {})).toEqual({ CODEX_BGOS_SERVICE: LABEL });
  });
  it("carries the auto update switch set at install time", () => {
    expect(serviceEnvironment(HOME, { CODEX_BGOS_AUTO_UPDATE: "off" })).toEqual({
      CODEX_BGOS_SERVICE: LABEL,
      CODEX_BGOS_AUTO_UPDATE: "off",
    });
  });
  it("never writes a value that could break out of a unit, a plist or a script", () => {
    expect(
      serviceEnvironment(HOME, { CODEX_BGOS_AUTO_UPDATE: 'off"\nExecStart=/bin/sh' }),
    ).toEqual({ CODEX_BGOS_SERVICE: LABEL });
  });
});

describe("service definitions carry the environment", () => {
  const env = { CODEX_BGOS_SERVICE: LABEL, CODEX_BGOS_AUTO_UPDATE: "off" };
  it("LaunchAgent: EnvironmentVariables, and still a valid plist", () => {
    const plist = renderLaunchAgent("/opt/node/bin/node", "/x/cli.js", HOME, env);
    expect(plist).toContain(
      `<key>EnvironmentVariables</key><dict><key>CODEX_BGOS_SERVICE</key><string>${LABEL}</string><key>CODEX_BGOS_AUTO_UPDATE</key><string>off</string></dict>`,
    );
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    if (process.platform === "darwin") {
      const path = join(temp(), "agent.plist");
      writeFileSync(path, plist);
      expect(spawnSync("plutil", ["-lint", path]).status).toBe(0);
    }
  });
  it("systemd: Environment lines, and Restart=on-failure so exit 75 restarts it", () => {
    const unit = renderSystemdUnit("/opt/node/bin/node", "/x/cli.js", HOME, env);
    expect(unit).toContain(`Environment="CODEX_BGOS_SERVICE=${LABEL}"\n`);
    expect(unit).toContain('Environment="CODEX_BGOS_AUTO_UPDATE=off"\n');
    expect(unit).toContain("Restart=on-failure\n");
    expect(unit).toContain(
      `ExecStart="/opt/node/bin/node" "/x/cli.js" "supervise" "--home" "${HOME}"`,
    );
  });
  it("Windows launcher: sets the process environment before it runs supervise", () => {
    const vbs = renderWindowsLauncher("C:\\node\\node.exe", "C:\\x\\cli.js", "C:\\h", env);
    const setLine = `shell.Environment("PROCESS")("CODEX_BGOS_SERVICE") = "${LABEL}"`;
    expect(vbs).toContain(setLine);
    expect(vbs).toContain('shell.Environment("PROCESS")("CODEX_BGOS_AUTO_UPDATE") = "off"');
    expect(vbs.indexOf(setLine)).toBeLessThan(vbs.indexOf("shell.Run"));
  });
});

describe("serviceInstalled: the service for THIS home exists", () => {
  it("macOS: the LaunchAgent plist", () => {
    const exists = vi.fn(() => true);
    expect(serviceInstalled(HOME, "darwin", { exists, regQuery: () => false, userHome: "/Users/kc" })).toBe(true);
    expect(exists).toHaveBeenCalledWith(join("/Users/kc", "Library", "LaunchAgents", `${LABEL}.plist`));
  });
  it("Linux: the systemd user unit", () => {
    const exists = vi.fn(() => false);
    expect(serviceInstalled(HOME, "linux", { exists, regQuery: () => true, userHome: "/home/kc" })).toBe(false);
    expect(exists).toHaveBeenCalledWith(join("/home/kc", ".config", "systemd", "user", `${LABEL}.service`));
  });
  it("Windows: the Run key value", () => {
    const regQuery = vi.fn(() => true);
    expect(serviceInstalled(HOME, "win32", { exists: () => false, regQuery, userHome: "C:\\Users\\kc" })).toBe(true);
    expect(regQuery).toHaveBeenCalledWith(LABEL);
  });
});

describe("the child", () => {
  it("runs with an IPC channel, its home and its supervisor's pid", () => {
    const options = childSpawnOptions(HOME, 900, 11, 12, { PATH: "/usr/bin" });
    expect(options.stdio).toEqual(["ignore", 11, 12, "ipc"]);
    expect(options.env).toMatchObject({
      PATH: "/usr/bin",
      CODEX_BGOS_HOME: HOME,
      CODEX_BGOS_SUPERVISOR_PID: "900",
    });
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
  });
});

describe("handOverToSuccessor", () => {
  it("launchd and systemd: exit 75 and let the service manager start the new supervisor", () => {
    const spawn = vi.fn();
    const exit = vi.fn();
    handOverToSuccessor({ platform: "darwin", home: HOME, spawn, exit });
    handOverToSuccessor({ platform: "linux", home: HOME, spawn, exit });
    expect(spawn).not.toHaveBeenCalled();
    expect(exit.mock.calls).toEqual([[75], [75]]);
  });
  it("Windows: the Run key restarts nothing, so the hidden launcher starts the successor first", () => {
    const order: string[] = [];
    const unref = vi.fn();
    const spawn = vi.fn((..._args: unknown[]) => {
      order.push("spawn");
      return { unref };
    });
    const exit = vi.fn(() => void order.push("exit"));
    handOverToSuccessor({ platform: "win32", home: "C:\\h", spawn, exit });
    expect(spawn).toHaveBeenCalledWith("wscript.exe", [join("C:\\h", "start-agent.vbs")], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(unref).toHaveBeenCalled();
    expect(order).toEqual(["spawn", "exit"]);
    expect(exit).toHaveBeenCalledWith(75);
  });
});

describe("installBackgroundService with every effect injected", () => {
  it("macOS: writes the plist for the given CLI with its marker, then bootstraps it", async () => {
    const userHome = temp();
    const calls: string[][] = [];
    const quiet: string[][] = [];
    await installBackgroundService(HOME, {
      cli: "/h/runtime/node_modules/codex-channel-bgos/dist/cli.js",
      platform: "darwin",
      userHome,
      uid: 501,
      env: { CODEX_BGOS_AUTO_UPDATE: "off" },
      run: (command, args) => void calls.push([command, ...args]),
      quietRun: (command, args) => void quiet.push([command, ...args]),
      pause: async () => {},
      logsDir: temp(),
    });
    const plist = readFileSync(join(userHome, "Library", "LaunchAgents", `${LABEL}.plist`), "utf8");
    expect(plist).toContain("<string>/h/runtime/node_modules/codex-channel-bgos/dist/cli.js</string><string>supervise</string>");
    expect(plist).toContain(`<key>CODEX_BGOS_SERVICE</key><string>${LABEL}</string>`);
    expect(plist).toContain("<key>CODEX_BGOS_AUTO_UPDATE</key><string>off</string>");
    expect(quiet).toEqual([["launchctl", "bootout", `gui/501/${LABEL}`]]);
    expect(calls).toEqual([["launchctl", "bootstrap", "gui/501", join(userHome, "Library", "LaunchAgents", `${LABEL}.plist`)]]);
  });
  it("Linux: writes the unit with its marker, then enables and restarts it", async () => {
    const userHome = temp();
    const calls: string[][] = [];
    await installBackgroundService(HOME, {
      cli: "/h/cli.js",
      platform: "linux",
      userHome,
      env: {},
      run: (command, args) => void calls.push([command, ...args]),
      quietRun: () => {},
      pause: async () => {},
      logsDir: temp(),
    });
    const unit = readFileSync(join(userHome, ".config", "systemd", "user", `${LABEL}.service`), "utf8");
    expect(unit).toContain(`Environment="CODEX_BGOS_SERVICE=${LABEL}"`);
    expect(unit).not.toContain("CODEX_BGOS_AUTO_UPDATE");
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", `${LABEL}.service`],
      ["systemctl", "--user", "restart", `${LABEL}.service`],
    ]);
  });
});

describe("createChildRunner: the supervisor's restart loop", () => {
  function setup() {
    const children: any[] = [];
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const runner = createChildRunner({
      spawnChild: () => {
        const child = new EventEmitter() as any;
        child.pid = 1000 + children.length;
        children.push(child);
        return child;
      },
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        (timer as { cleared: boolean }).cleared = true;
      },
    });
    const fire = () => {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
    };
    return { runner, children, timers, fire };
  }

  it("restarts the child 5 s after every exit, forever", () => {
    const { runner, children, timers, fire } = setup();
    runner.launch();
    expect(children).toHaveLength(1);
    children[0].emit("exit", 1, null);
    expect(runner.current()).toBeNull();
    expect(timers.map((t) => t.ms)).toEqual([5000]);
    fire();
    expect(children).toHaveLength(2);
    expect(runner.current()).toBe(children[1]);
  });

  it("while the updater holds restarts, the child's exit is not relaunched", () => {
    const { runner, children, timers, fire } = setup();
    runner.launch();
    runner.hold();
    children[0].emit("exit", 0, null);
    fire();
    expect(timers).toHaveLength(0);
    expect(children).toHaveLength(1);
    expect(runner.current()).toBeNull();
  });

  it("a hold cancels a restart already scheduled (the swap must not race a relaunch)", () => {
    const { runner, children, timers, fire } = setup();
    runner.launch();
    children[0].emit("exit", 1, null);
    runner.hold();
    expect(timers[0].cleared).toBe(true);
    fire();
    expect(children).toHaveLength(1);
  });

  it("nothing launches while held, whoever asks", () => {
    const { runner, children } = setup();
    runner.hold();
    runner.launch();
    expect(children).toHaveLength(0);
    runner.resume();
    expect(children).toHaveLength(1);
  });

  it("resume starts the child at once when none runs, and never a second one", () => {
    const { runner, children } = setup();
    runner.launch();
    runner.hold();
    runner.resume();
    expect(children).toHaveLength(1);
    children[0].emit("exit", 0, null);
    expect(children).toHaveLength(1);
    runner.hold();
    runner.resume();
    expect(children).toHaveLength(2);
  });

  it("a stopping supervisor never relaunches", () => {
    const { runner, children, timers, fire } = setup();
    runner.launch();
    runner.stop();
    children[0].emit("exit", 0, null);
    fire();
    expect(timers).toHaveLength(0);
    runner.resume();
    expect(children).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// supervise()'s self update wiring, through the seams it is built from
// ---------------------------------------------------------------------------

describe("supervisorUpdateControls: how the updater reaches the child and hands over", () => {
  function setup(change: Partial<Parameters<typeof supervisorUpdateControls>[0]> = {}) {
    const events: string[] = [];
    const children: any[] = [];
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const runner = createChildRunner({
      spawnChild: () => {
        const child = new EventEmitter() as any;
        child.pid = 1000 + children.length;
        children.push(child);
        return child;
      },
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        (timer as { cleared: boolean }).cleared = true;
      },
    });
    const pending = () => timers.filter((t) => !t.cleared);
    const controls = supervisorUpdateControls({
      runner: {
        current: runner.current,
        hold: () => {
          events.push("hold");
          runner.hold();
        },
        resume: () => {
          events.push("resume");
          runner.resume();
        },
      },
      askToStop: async (child) => {
        events.push(`ask:${child?.pid ?? "none"}`);
        // An idle child agrees and is gone a moment later.
        setImmediate(() => child?.emit("exit", 0, null));
        return "stopping";
      },
      waitForExit: async (child, ms) => {
        events.push(`wait:${child?.pid ?? "none"}:${ms}`);
        return true;
      },
      terminate: async (child) => void events.push(`terminate:${child.pid}`),
      closeDown: () => void events.push("closeDown"),
      release: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push("released");
      },
      handOver: () => void events.push("handOver"),
      stopRequested: () => false,
      ...change,
    });
    return { controls, runner, children, events, pending, timers };
  }

  it("review F9: once the supervisor was asked to stop, it hands over to no successor (a Repair is about to reinstall the runtime)", async () => {
    const { controls, events } = setup({ stopRequested: () => true });
    await controls.restartSupervisor();
    expect(events).toEqual(["closeDown", "released"]);
  });

  it("holds restarts BEFORE asking the child to stop, so its exit is never relaunched from a runtime being renamed", async () => {
    const { controls, runner, children, events, pending } = setup();
    runner.launch();
    expect(await controls.requestChildStop()).toBe("stopping");
    expect(events).toEqual(["hold", "ask:1000"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.current()).toBeNull();
    expect(pending()).toHaveLength(0);
    expect(children).toHaveLength(1);
  });

  it("childPid is the runner's CURRENT child, so the heartbeat is matched against the live process", () => {
    const { controls, runner, children, timers } = setup();
    expect(controls.childPid()).toBeNull();
    runner.launch();
    expect(controls.childPid()).toBe(1000);
    children[0].emit("exit", 1, null);
    expect(controls.childPid()).toBeNull();
    timers[0].fn();
    expect(controls.childPid()).toBe(1001);
  });

  it("waits for, and ends, only the current child", async () => {
    const { controls, runner, events } = setup();
    await controls.forceStopChild();
    expect(events).toEqual([]);
    runner.launch();
    expect(await controls.waitChildExit(30_000)).toBe(true);
    await controls.forceStopChild();
    expect(events).toEqual(["wait:1000:30000", "terminate:1000"]);
  });

  it("resumeChild lets the restart loop run again", () => {
    const { controls, runner, children } = setup();
    runner.launch();
    runner.hold();
    children[0].emit("exit", 0, null);
    controls.resumeChild();
    expect(children).toHaveLength(2);
  });

  it("releases the supervisor lock BEFORE the hand over: the successor waits on that lock", async () => {
    const { controls, events } = setup();
    await controls.restartSupervisor();
    expect(events).toEqual(["closeDown", "released", "handOver"]);
  });

  it("a lock that cannot be released still hands over (the lease goes stale on its own)", async () => {
    const { controls, events } = setup({
      release: async () => {
        throw new Error("ECOMPROMISED");
      },
    });
    await controls.restartSupervisor();
    expect(events).toEqual(["closeDown", "handOver"]);
  });
});

describe("startSelfUpdate: boot, serve, an owed rollback, launch, then a pass every 15 s", () => {
  function setup(
    tick: () => Promise<string>,
    opts: {
      rolledBackBeforeStart?: boolean;
      rollbackDue?: boolean;
      serve?: () => Promise<void>;
    } = {},
  ) {
    const events: string[] = [];
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const log = vi.fn();
    const timer = startSelfUpdate({
      updater: {
        boot: () => void events.push("boot"),
        rollBackBeforeStart: async () => {
          events.push("rollBackBeforeStart");
          return opts.rolledBackBeforeStart ?? false;
        },
        get rollbackDue() {
          return opts.rollbackDue ?? false;
        },
        tick: async () => {
          events.push("tick");
          return tick();
        },
      },
      runner: { launch: () => void events.push("launch") },
      serve: async () => {
        events.push("serve");
        await opts.serve?.();
      },
      log,
      every: (fn, ms) => {
        intervals.push({ fn, ms });
        return "timer-1";
      },
    });
    return { events, intervals, log, timer };
  }

  it("claims the update state before the child starts (the child reports only its own supervisor's state)", async () => {
    const { events, timer } = setup(async () => "idle");
    expect(await timer).toBe("timer-1");
    expect(events).toEqual(["boot", "serve", "rollBackBeforeStart", "launch"]);
  });

  it("review F10: the boot is counted before anything of this version can throw (the control server, service.json)", async () => {
    const { events, timer } = setup(async () => "idle", {
      serve: async () => {
        throw new Error("Background control socket failed.");
      },
    });
    await expect(timer).rejects.toThrow("control socket");
    // Counted, so a release that dies here on every start still reaches
    // CONFIRM_MAX_BOOTS and is rolled back by a later start.
    expect(events).toEqual(["boot", "serve"]);
  });

  it("review F10: an owed rollback runs before the child, and then nothing else starts", async () => {
    const { events, intervals, timer } = setup(async () => "idle", {
      rolledBackBeforeStart: true,
    });
    expect(await timer).toBeNull();
    expect(events).toEqual(["boot", "serve", "rollBackBeforeStart"]);
    expect(intervals).toEqual([]);
  });

  it("review F10 window: the control server and service.json are up before an owed rollback, so a Repair's pause-service can stop it", async () => {
    // On Windows a Repair's pause-service has no service manager to signal:
    // it reaches the supervisor only through service.json and POST /stop.
    // A rollback running before them found no instance, so the Repair
    // installed into the folder the rollback was renaming, and the rollback
    // then handed over to a successor on top of it.
    let served = false;
    let servedAtRollback: boolean | undefined;
    const timer = startSelfUpdate({
      updater: {
        boot: () => {},
        rollBackBeforeStart: async () => {
          servedAtRollback = served;
          return true;
        },
        rollbackDue: true,
        tick: async () => "idle",
      },
      runner: { launch: () => {} },
      serve: async () => {
        served = true;
      },
      log: () => {},
      every: () => "timer-1",
    });
    expect(await timer).toBeNull();
    expect(servedAtRollback).toBe(true);
  });

  it("review F10: a control server that cannot open never keeps an owed rollback from running", async () => {
    const { events, log, timer } = setup(async () => "idle", {
      rollbackDue: true,
      rolledBackBeforeStart: true,
      serve: async () => {
        throw new Error("Background control socket failed.");
      },
    });
    expect(await timer).toBeNull();
    expect(events).toEqual(["boot", "serve", "rollBackBeforeStart"]);
    expect(log).toHaveBeenCalledWith(
      "control server not started (Background control socket failed.); the owed rollback runs anyway",
    );
  });

  it("review F3: a rollback still owed after a failed try keeps the child down; the passes retry it", async () => {
    const { events, intervals, timer } = setup(async () => "rollback_failed", {
      rollbackDue: true,
    });
    expect(await timer).toBe("timer-1");
    expect(events).toEqual(["boot", "serve", "rollBackBeforeStart"]);
    expect(intervals.map((i) => i.ms)).toEqual([UPDATE_TICK_MS]);
  });

  it("runs an update pass every UPDATE_TICK_MS and returns the timer stop() clears", async () => {
    const { events, intervals, timer } = setup(async () => "idle");
    expect(await timer).toBe("timer-1");
    expect(intervals.map((i) => i.ms)).toEqual([UPDATE_TICK_MS]);
    expect(UPDATE_TICK_MS).toBe(15_000);
    intervals[0].fn();
    intervals[0].fn();
    expect(events).toEqual(["boot", "serve", "rollBackBeforeStart", "launch", "tick", "tick"]);
  });

  it("a pass that throws is logged, never an unhandled rejection that ends the supervisor", async () => {
    const { intervals, log, timer } = setup(async () => {
      throw new Error("EACCES update-state.json");
    });
    await timer;
    intervals[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith("update pass failed: EACCES update-state.json");
  });
});

describe("review C1: a stop lets a runtime switch in flight finish before it lets go", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Never created: every runtime folder below lives in memory.
  const SWITCH_HOME = join(tmpdir(), "codex-c1-no-such-home");
  const p = runtimePaths(SWITCH_HOME);

  /**
   * The runtime folders in memory, with renames Windows holds while `held`
   * says so. Each is a whole install (runtimeCanRun): every file asked about
   * inside one is there, and its package.json names a version.
   */
  function memoryRuntime(present: string[], held: (from: string) => boolean) {
    const dirs = new Set(present);
    const inside = (path: string) => [...dirs].some((dir) => path.startsWith(dir + sep));
    const read = (path: string) => {
      if (inside(path) && path.endsWith("package.json")) return JSON.stringify({ version: "0.19.0" });
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
    };
    const fs: RuntimeFs = {
      exists: (path) => dirs.has(path) || inside(path),
      rename: (from, to) => {
        if (held(from))
          throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), {
            code: "EPERM",
          });
        if (!dirs.delete(from))
          throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}'`), {
            code: "ENOENT",
          });
        dirs.add(to);
      },
      remove: (path) => void dirs.delete(path),
    };
    return { fs, dirs, read };
  }
  /** The first `n` calls say held (Defender or the indexer on fresh files). */
  const firstTimes = (n: number) => () => n-- > 0;
  /** Windows renames, retried on the fake clock. */
  const windows: RenameRetry = {
    platform: "win32",
    budgetMs: RENAME_RETRY_MS,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  /** supervise()'s stop, recording what it tears down and whether a runtime was left at the release. */
  function stopDuring(
    switches: RuntimeSwitches,
    runtimeInPlace: () => boolean,
    child: { pid: number } | null = null,
  ) {
    const events: string[] = [];
    const stopped = closeSupervisor({
      runner: { stop: () => void events.push("runner stopped"), current: () => child },
      clearUpdates: () => void events.push("updates cleared"),
      terminate: async (c) => void events.push(`terminate:${c.pid}`),
      switches,
      closeServer: () => void events.push("server closed"),
      removeServiceFile: () => void events.push("service.json removed"),
      release: async () =>
        void events.push(runtimeInPlace() ? "released, runtime in place" : "released, NO runtime"),
      exit: () => void events.push("exit"),
      log: (message) => void events.push(`log: ${message}`),
    });
    return { events, stopped };
  }
  const TORN_DOWN = ["server closed", "service.json removed", "released, runtime in place", "exit"];

  it("a stop while Windows holds runtime.next -> runtime waits for the swap, so <home>/runtime is never left missing", async () => {
    vi.useFakeTimers();
    const held = firstTimes(20);
    const { fs, dirs, read } = memoryRuntime([p.runtime, p.next], (from) => from === p.next && held());
    const switches = new RuntimeSwitches();
    const { swap } = countedRuntimeSwitches(SWITCH_HOME, "0.19.0", switches, fs, windows, read);
    const swapped = swap();
    await vi.advanceTimersByTimeAsync(2_000);
    // runtime -> runtime.prev went through and runtime.next -> runtime is
    // held: right now there is no runtime folder at all.
    expect(dirs.has(p.runtime)).toBe(false);
    const { events, stopped } = stopDuring(switches, () => dirs.has(p.runtime));
    await vi.advanceTimersByTimeAsync(5_000);
    // Neither service.json nor the lock goes while the swap is renaming.
    expect(events).toEqual(["runner stopped", "updates cleared"]);
    await vi.advanceTimersByTimeAsync(20_000);
    await swapped;
    await stopped;
    expect(events).toEqual(["runner stopped", "updates cleared", ...TORN_DOWN]);
    expect(dirs).toEqual(new Set([p.runtime, p.prev]));
  });

  it("a swap that could not even undo itself goes straight on to the restore, and the stop waits for that too", async () => {
    vi.useFakeTimers();
    let phase: "swap" | "restore" = "swap";
    const restoreHeld = firstTimes(10);
    const { fs, dirs, read } = memoryRuntime(
      [p.runtime, p.next],
      (from) => from === p.next || (from === p.prev && (phase === "swap" || restoreHeld())),
    );
    const switches = new RuntimeSwitches();
    const counted = countedRuntimeSwitches(SWITCH_HOME, "0.19.0", switches, fs, windows, read);
    // SelfUpdater.apply: a swap that throws is followed at once by the restore.
    const applied = counted.swap().then(
      () => true,
      () => {
        phase = "restore";
        return counted.restoreRuntime();
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const { events, stopped } = stopDuring(switches, () => dirs.has(p.runtime));
    // The swap and its undo each spend their whole retry budget, then the
    // restore is held for a few seconds more.
    await vi.advanceTimersByTimeAsync(2 * (RENAME_RETRY_MS + 1000));
    expect(dirs.has(p.runtime)).toBe(false);
    expect(events).toEqual(["runner stopped", "updates cleared"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await applied).toBe(true);
    await stopped;
    expect(events).toEqual(["runner stopped", "updates cleared", ...TORN_DOWN]);
    expect(dirs).toEqual(new Set([p.runtime, p.next]));
  });

  it("a rollback and a restore count while they run, as the swap does", async () => {
    vi.useFakeTimers();
    for (const [which, present] of [
      ["rollback", [p.runtime, p.prev]],
      ["restoreRuntime", [p.prev]],
    ] as const) {
      const { fs, dirs, read } = memoryRuntime([...present], firstTimes(10));
      const switches = new RuntimeSwitches();
      const running = countedRuntimeSwitches(SWITCH_HOME, "0.19.0", switches, fs, windows, read)[which]();
      let settled: boolean | undefined;
      void switches.settled(SWITCH_SETTLE_MS).then((value) => (settled = value));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled, which).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      await running;
      expect(settled, which).toBe(true);
      expect(dirs.has(p.runtime), which).toBe(true);
    }
  });

  it("is bounded: a switch that never settles keeps the supervisor for SWITCH_SETTLE_MS at most", async () => {
    vi.useFakeTimers();
    const switches = new RuntimeSwitches();
    void switches.run(() => new Promise<void>(() => {}));
    const { events, stopped } = stopDuring(switches, () => true);
    await vi.advanceTimersByTimeAsync(SWITCH_SETTLE_MS - 1);
    expect(events).toEqual(["runner stopped", "updates cleared"]);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(events).toEqual([
      "runner stopped",
      "updates cleared",
      "log: a runtime switch is still running after 305 s; stopping anyway",
      ...TORN_DOWN,
    ]);
    // Five renames, each retried for a minute: the longest switch there is.
    expect(SWITCH_SETTLE_MS).toBe(5 * (RENAME_RETRY_MS + 1000));
  });

  it("with no switch in flight it stops at once: the loop, the child, then the server, service.json and the lock", async () => {
    const { events, stopped } = stopDuring(new RuntimeSwitches(), () => true, { pid: 1000 });
    await stopped;
    expect(events).toEqual(["runner stopped", "updates cleared", "terminate:1000", ...TORN_DOWN]);
  });

  it("review F10 window: a Repair during the rollback before start reaches the supervisor, which finishes the rollback and hands over to no one", async () => {
    vi.useFakeTimers();
    const home = temp();
    const p = runtimePaths(home);
    // A new version that never confirmed: this start owes the rollback.
    writeUpdateState(home, {
      ...emptyUpdateState(),
      pendingConfirm: {
        version: "0.19.2",
        previousVersion: "0.19.0",
        appliedAt: new Date().toISOString(),
        boots: CONFIRM_MAX_BOOTS,
        rollbackFailures: 0,
      },
    });
    const held = firstTimes(20);
    const { fs, dirs, read } = memoryRuntime([p.runtime, p.prev], (from) => from === p.prev && held());
    const switches = new RuntimeSwitches();
    const events: string[] = [];
    let served = false;
    let stopRequested = false;
    const runner = {
      current: () => null,
      hold: () => {},
      resume: () => void events.push("resume"),
      launch: () => void events.push("launch"),
      stop: () => void events.push("runner stopped"),
    };
    // A Windows Repair's pause-service (stopService): POST /stop when
    // service.json answers, else no reachable instance and nothing to wait for.
    let stopped: Promise<void> | undefined;
    const pauseService = () => {
      if (!served) return;
      stopRequested = true;
      stopped = closeSupervisor({
        runner,
        clearUpdates: () => {},
        terminate: async () => {},
        switches,
        closeServer: () => void events.push("server closed"),
        removeServiceFile: () =>
          void events.push(
            dirs.has(p.runtime) ? "service.json removed, runtime in place" : "service.json removed, NO runtime",
          ),
        release: async () => {},
        exit: () => void events.push("exit"),
        log: () => {},
      });
    };
    const updater = new SelfUpdater({
      home,
      currentVersion: "0.19.2",
      supervised: "supervise-npm",
      enabled: true,
      managedRuntime: true,
      supervisorPid: 900,
      startedAtMs: Date.now(),
      now: () => Date.now(),
      random: () => 0,
      fetchLatest: async () => "0.19.2",
      stage: async () => {},
      hasStaged: () => false,
      ...countedRuntimeSwitches(home, "0.19.2", switches, fs, windows, read),
      removePrevious: () => {},
      removeStaged: () => {},
      runtimeCodexVersion: () => "0.154.0",
      readHeartbeat: () => null,
      ...supervisorUpdateControls<{ pid?: number }>({
        runner,
        askToStop: async () => "unavailable",
        waitForExit: async () => true,
        terminate: async () => {},
        closeDown: () => void events.push("closeDown"),
        release: async () => {},
        handOver: () => void events.push("handOver"),
        stopRequested: () => stopRequested,
      }),
      log: () => {},
    });
    const started = startSelfUpdate({
      updater,
      runner,
      serve: async () => {
        served = true;
      },
      log: () => {},
      every: () => "timer-1",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    // runtime -> runtime.failed went through and runtime.prev -> runtime is
    // held when the owner clicks Repair (the agent shows offline).
    expect(dirs.has(p.runtime)).toBe(false);
    pauseService();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await started).toBeNull();
    await stopped;
    // The stop waited for the rollback, then let go; no successor was
    // started on the runtime the Repair is about to reinstall.
    expect(events).toEqual([
      "runner stopped",
      "closeDown",
      "server closed",
      "service.json removed, runtime in place",
      "exit",
    ]);
    expect(dirs).toEqual(new Set([p.runtime]));
  });
});
