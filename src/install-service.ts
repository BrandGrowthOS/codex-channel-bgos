/**
 * Install the always-on service (launchd on macOS, systemd user unit on Linux)
 * that runs `codex-channel-bgos start`. Run this AFTER a successful `connect`
 * (so the pairing token is on disk) and from a persistent install (a global
 * `npm i -g codex-channel-bgos`), not an ephemeral `npx` cache dir.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  pickSupervisor,
  renderLaunchdPlist,
  renderSystemdUnit,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
} from "./setup/supervisor.js";

function codexBgosHome(): string {
  return process.env.CODEX_BGOS_HOME ?? join(homedir(), ".codex-bgos");
}

/** Absolute path to the installed CLI entry (dist/cli.js). */
export function cliEntryPath(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "cli.js");
}

export interface InstallResult {
  ok: boolean;
  message: string;
}

export function installService(): InstallResult {
  const kind = pickSupervisor(process.platform);
  const home = codexBgosHome();
  const nodePath = process.execPath;
  const cliEntry = cliEntryPath();

  try {
    mkdirSync(join(home, "logs"), { recursive: true });
  } catch {
    /* logs dir is best-effort */
  }

  if (kind === "launchd") {
    const dir = join(homedir(), "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${LAUNCHD_LABEL}.plist`);
    writeFileSync(path, renderLaunchdPlist({ nodePath, cliEntry, home }));
    spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["load", path], { encoding: "utf8" });
    return {
      ok: r.status === 0,
      message:
        `launchd agent installed at ${path} (label ${LAUNCHD_LABEL}).\n` +
        `Manage it with: launchctl unload/load ${path}`,
    };
  }

  if (kind === "systemd") {
    const dir = join(homedir(), ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, SYSTEMD_UNIT);
    writeFileSync(path, renderSystemdUnit({ nodePath, cliEntry, home }));
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    const r = spawnSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], {
      encoding: "utf8",
    });
    return {
      ok: r.status === 0,
      message:
        `systemd user unit installed at ${path} (${SYSTEMD_UNIT}).\n` +
        `To keep it running after logout: loginctl enable-linger "$USER"`,
    };
  }

  return {
    ok: false,
    message:
      `Automatic service install is not supported on ${process.platform}. ` +
      `Run 'codex-channel-bgos start' under your own supervisor (pm2, nohup, or Task Scheduler on Windows).`,
  };
}
