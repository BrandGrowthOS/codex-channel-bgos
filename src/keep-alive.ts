/**
 * `connect --keep-alive` (design 2.2, Codex "Alive today").
 *
 * The desktop setup always installs a per agent service, so an app installed
 * Codex agent survives crashes and reboots. The manual `connect` path
 * installed nothing: the agent ran in the foreground and died with its
 * terminal. With `--keep-alive`, once pairing succeeds the agent gets the same
 * service, and connect exits instead of running in the foreground. Without
 * it, one line says keep-alive is recommended and names the flag.
 *
 * The service runs from `<home>/runtime`, the npm prefix the desktop setup
 * uses, never from wherever this copy happens to be: an npx cache can be
 * cleaned under a running service, and the runtime is the layout the
 * supervisor's self update swaps (self-update.ts). So this copy's version is
 * installed there first, with Codex pinned to this copy's own Codex.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import {
  CODEX_PACKAGE,
  PACKAGE_NAME,
  installedPackageVersion,
  isManagedRuntime,
  nodeRuntimeFs,
  runtimeCli,
  runtimePaths,
  stageRuntime,
  type Exec,
  type RuntimeFs,
} from "./setup/self-update.js";

export const KEEP_ALIVE_FLAG = "--keep-alive";

export const KEEP_ALIVE_RECOMMENDED =
  "Keep-alive is recommended: add --keep-alive to this connect command to run the agent as a background service that restarts after a crash or a reboot and updates itself when idle.";

/** Remove `flag` from argv wherever it is; true when it was there. */
export function takeFlag(argv: string[], flag: string): boolean {
  let found = false;
  for (let i = argv.indexOf(flag); i >= 0; i = argv.indexOf(flag)) {
    argv.splice(i, 1);
    found = true;
  }
  return found;
}

/**
 * Why keep-alive cannot work here, or null. Asked before pairing, so a
 * refusal never spends the one time code.
 */
export function keepAlivePrecheck(input: {
  assistantId?: number;
  authMode: string;
  platform: string;
}): string | null {
  if (!input.assistantId)
    return "--keep-alive needs --assistant-id <id> (the command HOAI shows includes it), so the background service knows which agent it runs.";
  if (input.authMode === "apikey")
    return "--keep-alive needs a Codex sign-in (run codex login first): a background service does not see this terminal's OPENAI_API_KEY, so it could not start.";
  if (!["darwin", "linux", "win32"].includes(input.platform))
    return "Keep-alive is not available on this computer. Run connect without --keep-alive.";
  return null;
}

/** This copy's own @openai/codex version, or null. */
export function ownCodexVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const version = JSON.parse(
      readFileSync(require.resolve(`${CODEX_PACKAGE}/package.json`), "utf8"),
    ).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Make `<home>/runtime` hold this version, then install the service that runs
 * it. Returns the CLI the service runs.
 */
export async function setUpKeepAlive(deps: {
  home: string;
  /** The CLI file this process runs from. */
  currentCli: string;
  version: string;
  codexVersion: string | null;
  execPath: string;
  platform: string;
  exec: Exec;
  fs?: RuntimeFs;
  read?: (path: string) => string;
  /** Stop a service already installed for this home before its folder moves. */
  pause: (home: string) => Promise<void>;
  install: (home: string, cli: string) => Promise<void>;
}): Promise<string> {
  const fs = deps.fs ?? nodeRuntimeFs;
  const { runtime, next, prev } = runtimePaths(deps.home);
  const cli = runtimeCli(runtime);
  const ready =
    isManagedRuntime(deps.home, deps.currentCli) ||
    (installedPackageVersion(runtime, PACKAGE_NAME, deps.read) === deps.version &&
      installedPackageVersion(runtime, CODEX_PACKAGE, deps.read) !== null);
  if (!ready) {
    if (!deps.codexVersion)
      throw new Error(
        "This copy's Codex runtime version is unknown, so no background copy was installed.",
      );
    await stageRuntime({
      home: deps.home,
      version: deps.version,
      execPath: deps.execPath,
      platform: deps.platform,
      exec: deps.exec,
      fs,
      read: deps.read,
      codexVersion: deps.codexVersion,
    });
    await deps.pause(deps.home);
    fs.remove(prev);
    if (fs.exists(runtime)) fs.rename(runtime, prev);
    fs.rename(next, runtime);
    fs.remove(prev);
  }
  await deps.install(deps.home, cli);
  return cli;
}

/**
 * After pairing: the background service when asked for (connect then exits),
 * otherwise the recommendation and the foreground run. A failed install still
 * leaves a working agent, in the foreground.
 */
export async function finishConnect(opts: {
  keepAlive: boolean;
  setUp: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
}): Promise<"service" | "foreground"> {
  if (!opts.keepAlive) {
    opts.out(KEEP_ALIVE_RECOMMENDED);
    return "foreground";
  }
  try {
    const cli = await opts.setUp();
    opts.out(
      `Keep-alive is on: this agent now runs as a background service (${cli}). It restarts after a crash or a reboot and updates itself when idle. You can close this terminal.`,
    );
    return "service";
  } catch (error) {
    opts.err(
      `Keep-alive could not be set up (${error instanceof Error ? error.message : String(error)}). Running in the foreground instead.`,
    );
    return "foreground";
  }
}

/**
 * The end of connect. With the service installed, connect exits 0: the
 * service runs the agent now, and a foreground copy would be a second daemon
 * on the same pairing; 0 because keep-alive is what was asked for and it
 * worked. Otherwise the agent runs in the foreground, as before.
 */
export async function completeConnect(
  opts: Parameters<typeof finishConnect>[0] & {
    exit: (code: number) => void;
    runForeground: () => Promise<void>;
  },
): Promise<void> {
  if ((await finishConnect(opts)) === "service") return opts.exit(0);
  await opts.runForeground();
}
