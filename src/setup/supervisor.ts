/**
 * Process-supervisor rendering + install for the codex-channel-bgos daemon.
 *
 * The pure render* functions produce a launchd plist (macOS) or systemd user
 * unit (Linux) that runs `node <cli.js> start` and keeps it alive. installService
 * writes and loads the unit; the renderers are unit-tested without touching disk.
 */
import { posix } from "node:path";
import { xml } from "./background-service.js";

export const LAUNCHD_LABEL = "ai.brandgrowthos.codex-bgos";
export const SYSTEMD_UNIT = "codex-bgos.service";

export type SupervisorKind = "launchd" | "systemd" | "manual";

export function pickSupervisor(platform: string): SupervisorKind {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "manual";
}

export interface SupervisorRenderOptions {
  /** Absolute path to the node binary (process.execPath). */
  nodePath: string;
  /** Absolute path to the daemon CLI entry (dist/cli.js). */
  cliEntry: string;
  /** The CODEX_BGOS_HOME root, for log file placement. */
  home: string;
  label?: string;
}

export function renderLaunchdPlist(opts: SupervisorRenderOptions): string {
  const label = xml(opts.label ?? LAUNCHD_LABEL);
  const outLog = xml(posix.join(opts.home, "logs", "codex-bgos.log"));
  const errLog = xml(posix.join(opts.home, "logs", "codex-bgos.err"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.nodePath)}</string>
    <string>${xml(opts.cliEntry)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>StandardOutPath</key><string>${outLog}</string>
  <key>StandardErrorPath</key><string>${errLog}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export function renderSystemdUnit(opts: SupervisorRenderOptions): string {
  return `[Unit]
Description=codex-channel-bgos daemon (chat with your Codex agents in BGOS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=NODE_ENV=production
ExecStart=${opts.nodePath} ${opts.cliEntry} start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}
