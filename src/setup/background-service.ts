/** Per-agent, per-user background service. Credentials never enter startup arguments. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
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
export function renderLaunchAgent(
  node: string,
  cli: string,
  home: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${serviceLabel(home)}</string><key>ProgramArguments</key><array>${[node, cli, "supervise", "--home", home].map((s) => `<string>${xml(s)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(posix.join(home, "logs", "service.log"))}</string><key>StandardErrorPath</key><string>${xml(posix.join(home, "logs", "service.err"))}</string></dict></plist>`;
}
export function renderWindowsLauncher(
  node: string,
  cli: string,
  home: string,
): string {
  const command = [node, cli, "supervise", "--home", home]
    .map(quoteWindowsArg)
    .join(" ");
  return `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
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
export async function installBackgroundService(home: string): Promise<void> {
  await pauseBackgroundService(home);
  mkdirSync(join(home, "logs"), { recursive: true });
  const label = serviceLabel(home),
    cli = entry();
  if (process.platform === "win32") {
    const launcher = join(home, "start-agent.vbs");
    // Windows Script Host reads Unicode scripts as UTF-16, not UTF-8.
    writeFileSync(
      launcher,
      Buffer.from(
        "\ufeff" + renderWindowsLauncher(process.execPath, cli, home),
        "utf16le",
      ),
    );
    const command = ["wscript.exe", launcher].map(quoteWindowsArg).join(" ");
    run("reg.exe", [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      label,
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ]);
    run("wscript.exe", [launcher]);
  } else if (process.platform === "darwin") {
    const file = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderLaunchAgent(process.execPath, cli, home));
    const domain = `gui/${process.getuid!()}`;
    spawnSync("launchctl", ["bootout", `${domain}/${label}`], {
      stdio: "ignore",
    });
    run("launchctl", ["bootstrap", domain, file]);
  } else if (process.platform === "linux") {
    const file = join(
      homedir(),
      ".config",
      "systemd",
      "user",
      `${label}.service`,
    );
    mkdirSync(dirname(file), { recursive: true });
    const quote = (s: string) =>
      '"' +
      s.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
      '"';
    writeFileSync(
      file,
      `[Unit]\nDescription=HOAI Codex agent\n[Service]\nExecStart=${[process.execPath, cli, "supervise", "--home", home].map(quote).join(" ")}\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n`,
    );
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${label}.service`]);
    run("systemctl", ["--user", "restart", `${label}.service`]);
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
  const token = randomBytes(24).toString("hex");
  let child: ChildProcess | null = null,
    stopping = false;
  let restart: ReturnType<typeof setTimeout> | undefined;
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
    if (restart) clearTimeout(restart);
    server.close();
    if (child?.pid) {
      if (process.platform === "win32")
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else {
        const ownedChild = child;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(force);
            clearTimeout(deadline);
            resolve();
          };
          const force = setTimeout(() => {
            if (ownedChild.exitCode === null && ownedChild.signalCode === null)
              ownedChild.kill("SIGKILL");
          }, 5000);
          const deadline = setTimeout(done, 7000);
          ownedChild.once("exit", done);
          ownedChild.kill("SIGTERM");
        });
      }
    }
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
  const launch = () => {
    if (stopping) return;
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
    child = spawn(process.execPath, [entry(), "start", "--home", home], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", out, err],
      env: { ...process.env, CODEX_BGOS_HOME: home },
    });
    closeSync(out);
    closeSync(err);
    let scheduled = false;
    const retry = () => {
      if (scheduled) return;
      scheduled = true;
      child = null;
      if (!stopping) restart = setTimeout(launch, 5000);
    };
    child.on("error", retry);
    child.on("exit", retry);
  };
  launch();
}
