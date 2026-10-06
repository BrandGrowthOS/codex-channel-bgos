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
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  childSpawnOptions,
  createChildRunner,
  handOverToSuccessor,
  installBackgroundService,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsLauncher,
  serviceEnvironment,
  serviceInstalled,
  serviceLabel,
} from "../src/setup/background-service.js";

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
