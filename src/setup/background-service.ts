/** Per-agent, per-user background service. Credentials never enter startup arguments. */
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  renameSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { lock } from "proper-lockfile";

import { requestStopIfIdle } from "../child-control.js";
import { getPackageVersion } from "../version.js";
import {
  AUTO_UPDATE_ENV,
  CODEX_PACKAGE,
  SERVICE_MARKER_ENV,
  SUPERVISOR_PID_ENV,
  UPDATE_EXIT_CODE,
  UPDATE_TICK_MS,
  SelfUpdater,
  autoUpdateEnabledFromEnv,
  fetchLatestVersion,
  installedPackageVersion,
  isManagedRuntime,
  nodeExec,
  nodeRuntimeFs,
  resolveSupervised,
  rollbackRuntime,
  runtimePaths,
  stageRuntime,
  swapRuntime,
  type ChildHeartbeat,
  type ChildStopReply,
  type SelfUpdaterDeps,
} from "./self-update.js";

export function serviceLabel(home: string): string {
  return `ai.hoai.codex.${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
}
export function quoteWindowsArg(value: string): string {
  return (
    '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"'
  );
}
export function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
const entry = () => fileURLToPath(new URL("../cli.js", import.meta.url));
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/**
 * The service's own environment (mission 104). It names the service's label,
 * which is how `supervise` knows it runs as THIS home's installed service and
 * may exit 75 for an update: a supervise started by hand has nothing to bring
 * it back. CODEX_BGOS_AUTO_UPDATE, when set where the service is installed
 * (setup, repair, `connect --keep-alive`), is written in too, because launchd,
 * systemd and the Run key start the service with their own environment, not
 * the installer's. Only a plain token is carried: these values land inside a
 * plist, a unit file and a script.
 */
export function serviceEnvironment(
  home: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const autoUpdate = env[AUTO_UPDATE_ENV]?.trim();
  return {
    [SERVICE_MARKER_ENV]: serviceLabel(home),
    ...(autoUpdate && /^[A-Za-z0-9_-]{1,16}$/.test(autoUpdate)
      ? { [AUTO_UPDATE_ENV]: autoUpdate }
      : {}),
  };
}

export function renderLaunchAgent(
  node: string,
  cli: string,
  home: string,
  env: Record<string, string> = serviceEnvironment(home, {}),
): string {
  const variables = Object.entries(env)
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${serviceLabel(home)}</string><key>ProgramArguments</key><array>${[node, cli, "supervise", "--home", home].map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict>${variables}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(posix.join(home, "logs", "service.log"))}</string><key>StandardErrorPath</key><string>${xml(posix.join(home, "logs", "service.err"))}</string></dict></plist>`;
}
export function renderWindowsLauncher(
  node: string,
  cli: string,
  home: string,
  env: Record<string, string> = serviceEnvironment(home, {}),
): string {
  const command = [node, cli, "supervise", "--home", home]
    .map(quoteWindowsArg)
    .join(" ");
  // The Run key starts wscript with the logon environment; the variables go
  // into this script's process environment, which shell.Run hands on.
  const variables = Object.entries(env)
    .map(
      ([key, value]) =>
        `shell.Environment("PROCESS")("${key.replace(/"/g, '""')}") = "${value.replace(/"/g, '""')}"\r\n`,
    )
    .join("");
  return `Set shell = CreateObject("WScript.Shell")\r\n${variables}shell.Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
}
/**
 * Restart=on-failure restarts the supervisor after any non zero exit, which
 * includes the 75 it exits with to hand over to an updated version.
 */
export function renderSystemdUnit(
  node: string,
  cli: string,
  home: string,
  env: Record<string, string> = serviceEnvironment(home, {}),
): string {
  const quote = (s: string) =>
    '"' +
    s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
    '"';
  const variables = Object.entries(env)
    .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}\n`)
    .join("");
  return `[Unit]\nDescription=HOAI Codex agent\n[Service]\n${variables}ExecStart=${[node, cli, "supervise", "--home", home].map(quote).join(" ")}\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n`;
}
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Could not configure the background agent (${command}). ${result.error?.message ?? result.stderr.slice(0, 300)}`,
    );
}
function quietRun(command: string, args: string[]): void {
  spawnSync(command, args, { stdio: "ignore", windowsHide: true });
}

/**
 * Is the service for THIS home installed: the LaunchAgent plist, the systemd
 * user unit, or the Run key value. Half of "supervised" (resolveSupervised).
 */
export function serviceInstalled(
  home: string,
  platform: string = process.platform,
  deps: {
    exists?: (path: string) => boolean;
    regQuery?: (label: string) => boolean;
    userHome?: string;
  } = {},
): boolean {
  const label = serviceLabel(home);
  const exists = deps.exists ?? existsSync;
  const userHome = deps.userHome ?? homedir();
  if (platform === "darwin")
    return exists(join(userHome, "Library", "LaunchAgents", `${label}.plist`));
  if (platform === "linux")
    return exists(join(userHome, ".config", "systemd", "user", `${label}.service`));
  if (platform === "win32")
    return (deps.regQuery ??
      ((value: string) =>
        spawnSync("reg.exe", ["query", RUN_KEY, "/v", value], {
          windowsHide: true,
          stdio: "ignore",
        }).status === 0))(label);
  return false;
}

export async function stopService(home: string): Promise<void> {
  try {
    const state = JSON.parse(readFileSync(join(home, "service.json"), "utf8"));
    if (
      !Number.isInteger(state.port) ||
      state.port < 1 ||
      state.port > 65535 ||
      typeof state.token !== "string"
    )
      return;
    const response = await fetch(`http://127.0.0.1:${state.port}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error("The background agent did not accept the restart.");
    // The response precedes shutdown. Do not race the old instance's lock.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if (
          JSON.parse(readFileSync(join(home, "service.json"), "utf8")).token !==
          state.token
        )
          return;
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      "The previous background agent is still stopping. Retry shortly.",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /still stopping|did not accept/.test(error.message)
    )
      throw error;
    // No reachable instance. Never kill an arbitrary PID from an old file.
  }
}

export interface InstallServiceDeps {
  /** The CLI the service runs; `connect --keep-alive` passes the runtime's. */
  cli?: string;
  platform?: string;
  userHome?: string;
  uid?: number;
  /** The installer's environment, for serviceEnvironment. */
  env?: Record<string, string | undefined>;
  run?: (command: string, args: string[]) => void;
  quietRun?: (command: string, args: string[]) => void;
  pause?: (home: string) => Promise<void>;
  logsDir?: string;
}

export async function installBackgroundService(
  home: string,
  deps: InstallServiceDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const userHome = deps.userHome ?? homedir();
  const exec = deps.run ?? run;
  const quiet = deps.quietRun ?? quietRun;
  await (deps.pause ?? pauseBackgroundService)(home);
  mkdirSync(deps.logsDir ?? join(home, "logs"), { recursive: true });
  const label = serviceLabel(home),
    cli = deps.cli ?? entry(),
    env = serviceEnvironment(home, deps.env ?? process.env);
  if (platform === "win32") {
    const launcher = join(home, "start-agent.vbs");
    // Windows Script Host reads Unicode scripts as UTF-16, not UTF-8.
    writeFileSync(
      launcher,
      Buffer.from(
        "\ufeff" + renderWindowsLauncher(process.execPath, cli, home, env),
        "utf16le",
      ),
    );
    const command = ["wscript.exe", launcher].map(quoteWindowsArg).join(" ");
    exec("reg.exe", [
      "add",
      RUN_KEY,
      "/v",
      label,
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ]);
    exec("wscript.exe", [launcher]);
  } else if (platform === "darwin") {
    const file = join(userHome, "Library", "LaunchAgents", `${label}.plist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderLaunchAgent(process.execPath, cli, home, env));
    const domain = `gui/${deps.uid ?? process.getuid!()}`;
    quiet("launchctl", ["bootout", `${domain}/${label}`]);
    exec("launchctl", ["bootstrap", domain, file]);
  } else if (platform === "linux") {
    const file = join(
      userHome,
      ".config",
      "systemd",
      "user",
      `${label}.service`,
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderSystemdUnit(process.execPath, cli, home, env));
    exec("systemctl", ["--user", "daemon-reload"]);
    exec("systemctl", ["--user", "enable", "--now", `${label}.service`]);
    exec("systemctl", ["--user", "restart", `${label}.service`]);
  } else
    throw new Error(
      "Automatic background setup is not available on this computer.",
    );
}

/** Unload only this agent's auto-restart before updating files in use. */
export async function pauseBackgroundService(home: string): Promise<void> {
  const label = serviceLabel(home);
  if (process.platform === "darwin")
    spawnSync("launchctl", ["bootout", `gui/${process.getuid!()}/${label}`], {
      stdio: "ignore",
    });
  if (process.platform === "linux")
    spawnSync("systemctl", ["--user", "stop", `${label}.service`], {
      stdio: "ignore",
    });
  await stopService(home);
}

/**
 * The `start` child: an IPC channel for the one question asked before an
 * update (child-control.ts, finding 9), and the supervisor's pid, the only
 * supervisor whose update state the child reports.
 */
export function childSpawnOptions(
  home: string,
  supervisorPid: number,
  out: number,
  err: number,
  env: NodeJS.ProcessEnv = process.env,
): SpawnOptions {
  return {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", out, err, "ipc"],
    env: {
      ...env,
      CODEX_BGOS_HOME: home,
      [SUPERVISOR_PID_ENV]: String(supervisorPid),
    },
  };
}

/**
 * Hand over to the updated (or rolled back) supervisor. launchd (KeepAlive)
 * and systemd (Restart=on-failure) start it again after the exit; the Windows
 * Run key starts it only at the next logon, so there the hidden launcher
 * starts the successor first. The successor waits for this supervisor's lock.
 */
export function handOverToSuccessor(deps: {
  platform: string;
  home: string;
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => { unref: () => void };
  exit: (code: number) => void;
}): void {
  if (deps.platform === "win32")
    deps
      .spawn("wscript.exe", [join(deps.home, "start-agent.vbs")], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
      .unref();
  deps.exit(UPDATE_EXIT_CODE);
}

interface RunnableChild {
  pid?: number;
  on(event: "error" | "exit", listener: (...args: any[]) => void): unknown;
}

/**
 * The supervisor's restart loop: relaunch the child 5 s after every exit,
 * forever, EXCEPT while the updater holds restarts (it asked the child to
 * stop for an update; a child relaunched then would start from a runtime
 * folder that is being renamed) or once the supervisor is stopping.
 */
export function createChildRunner<C extends RunnableChild>(deps: {
  spawnChild: () => C;
  restartDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let child: C | null = null;
  let stopping = false;
  let held = false;
  let timer: unknown;
  const cancel = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const launch = () => {
    if (stopping || held || child) return;
    const spawned = deps.spawnChild();
    child = spawned;
    let scheduled = false;
    const retry = () => {
      if (scheduled) return;
      scheduled = true;
      if (child === spawned) child = null;
      if (!stopping && !held)
        timer = setTimer(() => {
          timer = undefined;
          launch();
        }, deps.restartDelayMs ?? 5000);
    };
    spawned.on("error", retry);
    spawned.on("exit", retry);
  };
  return {
    launch,
    current: () => child,
    /** The updater asked the child to stop: its exit is not a crash. */
    hold: () => {
      held = true;
      cancel();
    },
    /** Restarts allowed again; start the child now if none runs. */
    resume: () => {
      held = false;
      launch();
    },
    /** The supervisor is ending: never relaunch. */
    stop: () => {
      stopping = true;
      cancel();
    },
  };
}

/**
 * How the updater reaches the child and hands over, as supervise wires it
 * (self-update.ts). The order is the point:
 * - restarts are held BEFORE the child is asked to stop: an idle child exits
 *   at once, and a relaunch 5 s later would start from a runtime folder that
 *   is being renamed;
 * - every question goes to the runner's CURRENT child, so the heartbeat is
 *   matched against the live process, never a pid from an earlier start;
 * - the supervisor lock is released BEFORE the hand over: the successor
 *   waits on that lock, and on Windows it is started before this one exits.
 */
export function supervisorUpdateControls<C extends { pid?: number }>(deps: {
  runner: {
    current: () => C | null;
    hold: () => void;
    resume: () => void;
  };
  /** requestStopIfIdle (child-control.ts). */
  askToStop: (child: C | null) => Promise<ChildStopReply>;
  waitForExit: (child: C | null, ms: number) => Promise<boolean>;
  terminate: (child: C) => Promise<void>;
  /** End the restart loop, the update timer and the control server; drop service.json. */
  closeDown: () => void;
  /** Release the supervisor lock. */
  release: () => Promise<void>;
  /** handOverToSuccessor: exit 75 (on Windows, the successor started first). */
  handOver: () => void;
}): Pick<
  SelfUpdaterDeps,
  | "childPid"
  | "requestChildStop"
  | "waitChildExit"
  | "forceStopChild"
  | "resumeChild"
  | "restartSupervisor"
> {
  const { runner } = deps;
  return {
    childPid: () => runner.current()?.pid ?? null,
    requestChildStop: () => {
      runner.hold();
      return deps.askToStop(runner.current());
    },
    waitChildExit: (ms) => deps.waitForExit(runner.current(), ms),
    forceStopChild: async () => {
      const child = runner.current();
      if (child) await deps.terminate(child);
    },
    resumeChild: () => runner.resume(),
    restartSupervisor: async () => {
      deps.closeDown();
      await deps.release().catch(() => {});
      deps.handOver();
    },
  };
}

/**
 * The updater's start: it claims update-state.json for this supervisor
 * BEFORE the child starts (the child reports only its own supervisor's
 * state), then a pass every UPDATE_TICK_MS. A pass that throws is logged:
 * an unhandled rejection would end the supervisor, and with it the agent.
 * Returns the timer the supervisor clears when it stops.
 */
export function startSelfUpdate<T>(deps: {
  updater: { boot: () => void; tick: () => Promise<string> };
  runner: { launch: () => void };
  log: (message: string) => void;
  every: (fn: () => void, ms: number) => T;
}): T {
  deps.updater.boot();
  deps.runner.launch();
  return deps.every(() => {
    void deps.updater.tick().catch((error) =>
      deps.log(
        `update pass failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }, UPDATE_TICK_MS);
}

/** End a child: graceful first, forced after 5 s, settled within 7 s. */
async function terminateChild(target: ChildProcess): Promise<void> {
  if (target.exitCode !== null || target.signalCode !== null) return;
  if (process.platform === "win32") {
    if (target.pid)
      spawnSync("taskkill.exe", ["/PID", String(target.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(force);
      clearTimeout(deadline);
      resolve();
    };
    const force = setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null)
        target.kill("SIGKILL");
    }, 5000);
    const deadline = setTimeout(done, 7000);
    target.once("exit", done);
    target.kill("SIGTERM");
  });
}

function waitForExit(target: ChildProcess | null, ms: number): Promise<boolean> {
  if (!target || target.exitCode !== null || target.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      target.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    target.once("exit", onExit);
  });
}

export async function supervise(home: string): Promise<void> {
  mkdirSync(join(home, "logs"), { recursive: true });
  // A renewable filesystem lease avoids two concurrent startups claiming a
  // stale PID file. The library atomically owns/reclaims the lock directory.
  let release: () => Promise<void>;
  try {
    release = await lock(home, {
      realpath: false,
      lockfilePath: join(home, "supervisor.lock"),
      stale: 30_000,
      update: 5_000,
      retries: { retries: 20, factor: 1, minTimeout: 2000, maxTimeout: 2000 },
      onCompromised: () => {
        void stop();
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return;
    throw error;
  }
  const startedAtMs = Date.now();
  const token = randomBytes(24).toString("hex");
  let stopping = false;
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  // The restart loop exists before anything can call stop() (a signal, a
  // compromised lock), so stop() always has a runner to end.
  const runner = createChildRunner<ChildProcess>({
    spawnChild: () => {
      for (const file of ["agent.log", "agent.err"]) {
        const path = join(home, "logs", file);
        try {
          if (statSync(path).size > 5 * 1024 * 1024) {
            try {
              unlinkSync(path + ".1");
            } catch {}
            renameSync(path, path + ".1");
          }
        } catch {}
      }
      const out = openSync(join(home, "logs", "agent.log"), "a", 0o600),
        err = openSync(join(home, "logs", "agent.err"), "a", 0o600);
      const spawned = spawn(
        process.execPath,
        [entry(), "start", "--home", home],
        childSpawnOptions(home, process.pid, out, err),
      );
      closeSync(out);
      closeSync(err);
      return spawned;
    },
  });
  const log = (message: string) =>
    process.stdout.write(
      `[codex-channel-bgos supervise] ${new Date().toISOString()} ${message}\n`,
    );
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/stop") {
      response.writeHead(404).end();
      return;
    }
    response.end("stopping");
    void stop();
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    runner.stop();
    if (updateTimer) clearInterval(updateTimer);
    server.close();
    const child = runner.current();
    if (child) await terminateChild(child);
    try {
      unlinkSync(join(home, "service.json"));
    } catch {}
    await release().catch(() => {});
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Background control socket failed.");
  writeFileSync(
    join(home, "service.json"),
    JSON.stringify({ pid: process.pid, port: address.port, token }),
    { mode: 0o600 },
  );

  // Self update (design 2.2, decision D7): owned here because this process
  // outlives the agent it restarts. See self-update.ts.
  const cli = entry();
  const updater = new SelfUpdater({
    home,
    currentVersion: getPackageVersion(),
    supervised: resolveSupervised({
      platform: process.platform,
      env: process.env,
      label: serviceLabel(home),
      serviceInstalled: serviceInstalled(home),
    }),
    enabled: autoUpdateEnabledFromEnv(process.env),
    managedRuntime: isManagedRuntime(home, cli),
    supervisorPid: process.pid,
    startedAtMs,
    now: Date.now,
    random: Math.random,
    fetchLatest: () => fetchLatestVersion(),
    stage: (version) =>
      stageRuntime({
        home,
        version,
        execPath: process.execPath,
        platform: process.platform,
        exec: nodeExec,
      }),
    hasStaged: () => existsSync(runtimePaths(home).next),
    swap: () => swapRuntime(home),
    rollback: () => rollbackRuntime(home),
    removePrevious: () => nodeRuntimeFs.remove(runtimePaths(home).prev),
    removeStaged: () => nodeRuntimeFs.remove(runtimePaths(home).next),
    runtimeCodexVersion: () =>
      installedPackageVersion(runtimePaths(home).runtime, CODEX_PACKAGE),
    readHeartbeat: () => {
      try {
        return JSON.parse(
          readFileSync(join(home, "bgos_heartbeat.json"), "utf8"),
        ) as ChildHeartbeat;
      } catch {
        return null;
      }
    },
    ...supervisorUpdateControls<ChildProcess>({
      runner,
      askToStop: (child) => requestStopIfIdle(child),
      waitForExit,
      terminate: terminateChild,
      closeDown: () => {
        stopping = true;
        runner.stop();
        if (updateTimer) clearInterval(updateTimer);
        server.close();
        try {
          unlinkSync(join(home, "service.json"));
        } catch {}
      },
      release: () => release(),
      handOver: () =>
        handOverToSuccessor({
          platform: process.platform,
          home,
          spawn: (command, args, options) => spawn(command, args, options),
          exit: (code) => process.exit(code),
        }),
    }),
    log,
  });
  updateTimer = startSelfUpdate({ updater, runner, log, every: setInterval });
}
