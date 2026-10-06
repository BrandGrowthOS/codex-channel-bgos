/**
 * Self update owned by the supervisor (design 2.2, decision D7).
 *
 * WHY HERE. A Codex agent never updated itself: new versions arrived only
 * when the owner ran repair in the desktop app (design 2.2, "Updated today").
 * The per agent `supervise` process already outlives the agent process and
 * restarts it, so it is the one place that can install a new version, stop
 * the agent at a moment nobody is using it, switch, and come back.
 *
 * WHAT. A check of the npm `latest` dist tag every 24 h plus up to 6 h of
 * jitter (the curated published pin: held versions go to `next`,
 * .github/workflows/publish.yml). Same major only, never a downgrade, never a
 * version that was rolled back here. A newer version is STAGED into
 * `<home>/runtime.next` beside the live `<home>/runtime` (the npm prefix the
 * HOAI desktop setup installs into), with the Codex runtime pinned to the
 * version already installed, so Codex itself does not change underneath the
 * agent; then its CLI is probed (`--version`). It is APPLIED only at a safe
 * moment: the child's heartbeat is fresh, it is connected to BGOS (the new
 * version confirms by connecting, so an offline switch would roll a good
 * release back), no chat is busy and nothing happened for 10 minutes
 * (finding 9: never restart an agent mid job, and never kill a busy child). Applying stops the child through its own idle
 * check, renames runtime to runtime.prev and runtime.next to runtime, and
 * exits 75 so launchd (KeepAlive) or systemd (Restart=on-failure counts 75)
 * start the new supervisor; the Windows Run key restarts nothing, so there
 * the hidden start-agent.vbs successor is spawned first. The new supervisor
 * confirms health (its child connected within 3 minutes) or swaps
 * runtime.prev back, records the version as rolled back and restarts; a
 * rollback that fails stays owed and is tried again (ROLLBACK_MAX_ATTEMPTS).
 *
 * An update that keeps waiting is never forced (decision D6: the owner may
 * decide otherwise, the supervisor never does). update-state.json records
 * why it waits and since when (`waitingReason`, `waitingSince`), and after
 * 24 h service.log says so once. The heartbeat cannot carry it yet: the
 * backend rebuilds updateReadiness key by key (sanitizeUpdateReadiness) and
 * its env has no such key, so a field sent today would be stripped.
 *
 * Findings 7 and 8 need nothing here: a Codex chat keeps its conversation
 * through a restart (threads.json maps each chat to its persisted Codex
 * thread) and compaction is a native app-server request, not keystrokes into
 * a terminal, so no tmux is involved.
 *
 * Pure decisions first (table tested in test/self-update.spec.ts), then the
 * effects, every one injected (test/self-update-runtime.spec.ts).
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, posix, win32 } from "node:path";

export const PACKAGE_NAME = "codex-channel-bgos";
export const CODEX_PACKAGE = "@openai/codex";
export const REGISTRY_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`;
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_JITTER_MAX_MS = 6 * 60 * 60 * 1000;
/** A supervisor with no schedule yet (first boot) checks shortly after start. */
export const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
/** A failed registry read is retried sooner than a day, never in a loop. */
export const CHECK_RETRY_MS = 60 * 60 * 1000;
export const QUIET_WINDOW_MS = 10 * 60 * 1000;
/** The child writes its heartbeat file every 30 s; three beats of slack. */
export const HEARTBEAT_FRESH_MS = 90 * 1000;
export const CONFIRM_WINDOW_MS = 3 * 60 * 1000;
/** A new supervisor that keeps dying before it can confirm is rolled back. */
export const CONFIRM_MAX_BOOTS = 3;
/**
 * A rollback that fails (on Windows a rename can meet a file still held) is
 * tried again on the next passes, with restarts held; after this many tries
 * the agent is let run on the version it is on (review F3).
 */
export const ROLLBACK_MAX_ATTEMPTS = 5;
/** EX_TEMPFAIL: non zero, so systemd's Restart=on-failure restarts it. */
export const UPDATE_EXIT_CODE = 75;
export const UPDATE_TICK_MS = 15 * 1000;
/** A child that agreed to stop gets this long to finish its own shutdown. */
export const CHILD_STOP_GRACE_MS = 30 * 1000;
/** Decision D6: an update waiting this long is said so (never forced). */
export const UPDATE_WAIT_NOTICE_MS = 24 * 60 * 60 * 1000;
export const UPDATE_STATE_FILE = "update-state.json";
/** Set by the installed service definition, naming its own label. */
export const SERVICE_MARKER_ENV = "CODEX_BGOS_SERVICE";
/** Set by supervise on its child, so the child trusts only its own supervisor's state. */
export const SUPERVISOR_PID_ENV = "CODEX_BGOS_SUPERVISOR_PID";
export const AUTO_UPDATE_ENV = "CODEX_BGOS_AUTO_UPDATE";
const ROLLED_BACK_KEEP = 20;

/**
 * The backend's UPDATE_SUPERVISED_MODES, which reads anything else as 'none'.
 * The Windows Run key has no value of its own there, so a supervise loop on
 * an npm runtime is reported as 'supervise-npm'.
 */
export type SupervisedMode = "launchd" | "systemd" | "supervise-npm" | "none";

export interface PendingConfirm {
  version: string;
  previousVersion: string;
  appliedAt: string;
  boots: number;
  /** Rollbacks of this version that failed so far; above 0 one is owed. */
  rollbackFailures: number;
}

export interface UpdateState {
  schemaVersion: 1;
  supervisorPid: number | null;
  supervised: SupervisedMode;
  autoUpdateEnabled: boolean;
  latestKnownVersion: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
  stagedVersion: string | null;
  /**
   * The Codex version of the live runtime the stage was built beside (its
   * pin). A repair that changed it makes the stage stale (review F7).
   */
  stagedCodexVersion: string | null;
  rolledBack: string[];
  pendingConfirm: PendingConfirm | null;
  waitingReason: string | null;
  /** When the staged update began waiting for a safe moment (decision D6). */
  waitingSince: string | null;
  lastError: { at: string; message: string } | null;
}

/** The heartbeat's updateReadiness, the backend's sanitizeUpdateReadiness shape. */
export interface UpdateReadiness {
  supervised: SupervisedMode;
  autoUpdateEnabled: boolean;
  rollbackLatched: boolean;
  pendingRestartVersion: string | null;
}

export interface UpdateReport {
  latestKnownVersion: string | null;
  updateReadiness: UpdateReadiness;
}

/** The fields of the child's bgos_heartbeat.json the supervisor reads. */
export interface ChildHeartbeat {
  ts?: string;
  pid?: number;
  version?: string;
  wsConnected?: boolean;
  busy?: boolean;
  lastActivityAt?: string;
}

export type UnsafeReason =
  | "no_child"
  | "heartbeat_missing"
  | "heartbeat_other_process"
  | "heartbeat_stale"
  | "disconnected"
  | "busy"
  | "recent_activity";
export type SafeMoment = { safe: true } | { safe: false; reason: UnsafeReason };

export type ChildStopReply = "stopping" | "busy" | "unavailable";

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/** A plain MAJOR.MINOR.PATCH; a pre-release is never staged. */
export function parseVersion(
  value: unknown,
): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** CODEX_BGOS_AUTO_UPDATE=off (or 0, false, no) turns self update off. */
export function autoUpdateEnabledFromEnv(
  env: Record<string, string | undefined>,
): boolean {
  const raw = (env[AUTO_UPDATE_ENV] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}

export type UpdateDecision =
  | { action: "stage"; version: string }
  | {
      action: "none";
      reason:
        | "disabled"
        | "latest_unknown"
        | "current_unknown"
        | "not_newer"
        | "other_major"
        | "rolled_back";
    };

/** Which version, if any, to stage. */
export function decideUpdate(input: {
  enabled: boolean;
  current: string;
  latest: string | null;
  rolledBack: readonly string[];
}): UpdateDecision {
  if (!input.enabled) return { action: "none", reason: "disabled" };
  const latest = parseVersion(input.latest);
  if (!latest) return { action: "none", reason: "latest_unknown" };
  const current = parseVersion(input.current);
  if (!current) return { action: "none", reason: "current_unknown" };
  if (compareVersions(latest, current) <= 0)
    return { action: "none", reason: "not_newer" };
  if (latest[0] !== current[0]) return { action: "none", reason: "other_major" };
  const version = input.latest!.trim();
  if (input.rolledBack.includes(version))
    return { action: "none", reason: "rolled_back" };
  return { action: "stage", version };
}

export function nextCheckAt(nowMs: number, random: () => number): number {
  return (
    nowMs +
    UPDATE_CHECK_INTERVAL_MS +
    Math.floor(Math.max(0, Math.min(random(), 0.999999)) * UPDATE_JITTER_MAX_MS)
  );
}

/** The persisted schedule wins, so a reboot never turns into a fresh check. */
export function isCheckDue(
  state: Pick<UpdateState, "nextCheckAt">,
  nowMs: number,
  startedAtMs: number,
): boolean {
  const at = Date.parse(state.nextCheckAt ?? "");
  if (Number.isFinite(at)) return nowMs >= at;
  return nowMs >= startedAtMs + FIRST_CHECK_DELAY_MS;
}

/**
 * Is now a moment nobody is using this agent (finding 9)? Every unknown
 * reads unsafe: a guard that fails open restarts an agent mid job.
 */
export function decideSafeMoment(input: {
  heartbeat: ChildHeartbeat | null;
  childPid: number | null;
  nowMs: number;
}): SafeMoment {
  const { heartbeat, childPid, nowMs } = input;
  if (childPid === null) return { safe: false, reason: "no_child" };
  if (!heartbeat) return { safe: false, reason: "heartbeat_missing" };
  if (heartbeat.pid !== childPid)
    return { safe: false, reason: "heartbeat_other_process" };
  const ts = Date.parse(heartbeat.ts ?? "");
  if (!Number.isFinite(ts) || nowMs - ts > HEARTBEAT_FRESH_MS)
    return { safe: false, reason: "heartbeat_stale" };
  // The new version confirms only by connecting (decideConfirmation). Offline,
  // a backend outage or a fatal latch looks idle and quiet, and applying then
  // rolls back a good release and latches it here for good (review F2). So
  // the version that switches away must itself be connected.
  if (heartbeat.wsConnected !== true)
    return { safe: false, reason: "disconnected" };
  if (heartbeat.busy !== false) return { safe: false, reason: "busy" };
  const last = Date.parse(heartbeat.lastActivityAt ?? "");
  if (!Number.isFinite(last) || nowMs - last < QUIET_WINDOW_MS)
    return { safe: false, reason: "recent_activity" };
  return { safe: true };
}

export type ApplyDecision =
  | { action: "apply"; version: string }
  | { action: "wait"; reason: UnsafeReason }
  | {
      action: "none";
      reason:
        | "disabled"
        | "unsupervised"
        | "unmanaged_runtime"
        | "nothing_staged"
        | "stale_stage";
    };

/** Apply the staged version now, wait for a safe moment, or do nothing. */
export function decideApply(input: {
  enabled: boolean;
  supervised: SupervisedMode;
  managedRuntime: boolean;
  stagedVersion: string | null;
  /** The npm `latest` the last check read (state.latestKnownVersion). */
  latest: string | null;
  current: string;
  rolledBack: readonly string[];
  safety: SafeMoment;
}): ApplyDecision {
  if (!input.enabled) return { action: "none", reason: "disabled" };
  // Exiting with nothing to bring the supervisor back would leave the agent
  // dead until the next login.
  if (input.supervised === "none")
    return { action: "none", reason: "unsupervised" };
  if (!input.managedRuntime)
    return { action: "none", reason: "unmanaged_runtime" };
  if (!input.stagedVersion) return { action: "none", reason: "nothing_staged" };
  // Latest is the curated published pin (D7): a stage that latest no longer
  // names, because the release was pulled by moving latest back, is never
  // applied (review F4). A newer latest restages in checkAndStage instead.
  if (input.stagedVersion !== input.latest)
    return { action: "none", reason: "stale_stage" };
  if (
    decideUpdate({
      enabled: true,
      current: input.current,
      latest: input.stagedVersion,
      rolledBack: input.rolledBack,
    }).action !== "stage"
  )
    return { action: "none", reason: "stale_stage" };
  if (!input.safety.safe) return { action: "wait", reason: input.safety.reason };
  return { action: "apply", version: input.stagedVersion };
}

/**
 * A rollback is owed whatever the child says: the new supervisor booted more
 * than CONFIRM_MAX_BOOTS times without confirming, or a rollback was decided
 * and failed (review F3).
 */
export function rollbackOwed(pending: PendingConfirm): boolean {
  return pending.boots > CONFIRM_MAX_BOOTS || pending.rollbackFailures > 0;
}

/** After an apply: did the new version come up, is it still starting, or roll back? */
export function decideConfirmation(input: {
  pending: PendingConfirm;
  heartbeat: ChildHeartbeat | null;
  childPid: number | null;
  startedAtMs: number;
  nowMs: number;
}): "confirmed" | "wait" | "rollback" {
  const { pending, heartbeat, childPid, startedAtMs, nowMs } = input;
  // The verdict was taken and the rollback failed: it is owed, whatever the
  // child does in the meantime (review F3).
  if (rollbackOwed(pending)) return "rollback";
  if (
    heartbeat &&
    childPid !== null &&
    heartbeat.pid === childPid &&
    heartbeat.version === pending.version &&
    heartbeat.wsConnected === true
  ) {
    const ts = Date.parse(heartbeat.ts ?? "");
    if (Number.isFinite(ts) && ts >= startedAtMs) return "confirmed";
  }
  if (nowMs - startedAtMs >= CONFIRM_WINDOW_MS) return "rollback";
  return "wait";
}

/**
 * Stopping the new child for a rollback. It may be broken, but a child that
 * says it is busy, or whose fresh heartbeat says so, is never killed.
 */
export function decideRollbackStop(input: {
  reply: ChildStopReply;
  heartbeat: ChildHeartbeat | null;
  childPid: number | null;
  nowMs: number;
}): "proceed" | "wait" | "force" {
  const { reply, heartbeat, childPid, nowMs } = input;
  if (reply === "stopping") return "proceed";
  if (childPid === null) return "proceed";
  if (reply === "busy") return "wait";
  const ts = Date.parse(heartbeat?.ts ?? "");
  const fresh =
    heartbeat?.pid === childPid &&
    Number.isFinite(ts) &&
    nowMs - ts <= HEARTBEAT_FRESH_MS;
  if (fresh && heartbeat?.busy === true) return "wait";
  return "force";
}

/**
 * Running under `supervise` as the service installed for THIS home. The
 * marker is written into the service definition by installBackgroundService,
 * so a supervise started by hand (nothing would restart it after exit 75)
 * reads 'none'.
 */
export function resolveSupervised(input: {
  platform: string;
  env: Record<string, string | undefined>;
  label: string;
  serviceInstalled: boolean;
}): SupervisedMode {
  if (input.env[SERVICE_MARKER_ENV] !== input.label || !input.serviceInstalled)
    return "none";
  if (input.platform === "darwin") return "launchd";
  if (input.platform === "linux") return "systemd";
  if (input.platform === "win32") return "supervise-npm";
  return "none";
}

/** The supervisor's pid as supervise hands it to the child, or null. */
export function supervisorPidFromEnv(
  env: Record<string, string | undefined>,
): number | null {
  const raw = env[SUPERVISOR_PID_ENV];
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

const UNSUPERVISED_REPORT: UpdateReport = {
  latestKnownVersion: null,
  updateReadiness: {
    supervised: "none",
    autoUpdateEnabled: false,
    rollbackLatched: false,
    pendingRestartVersion: null,
  },
};

/**
 * What the child reports on its heartbeat. Only its OWN live supervisor's
 * state counts: a foreground daemon, or a file a dead supervisor left, would
 * otherwise claim an update authority nobody holds.
 */
export function updateReportFromState(
  state: UpdateState | null,
  supervisorPid: number | null,
): UpdateReport {
  if (!state || supervisorPid === null || state.supervisorPid !== supervisorPid)
    return {
      ...UNSUPERVISED_REPORT,
      updateReadiness: { ...UNSUPERVISED_REPORT.updateReadiness },
    };
  const latest = parseVersion(state.latestKnownVersion)
    ? state.latestKnownVersion
    : null;
  return {
    latestKnownVersion: latest,
    updateReadiness: {
      supervised: state.supervised,
      autoUpdateEnabled: state.autoUpdateEnabled,
      // Paused, in the app's words: the newest version failed here and will
      // not be tried again by itself.
      rollbackLatched: latest !== null && state.rolledBack.includes(latest),
      pendingRestartVersion:
        state.autoUpdateEnabled && parseVersion(state.stagedVersion)
          ? state.stagedVersion
          : null,
    },
  };
}

const NPM_CLI = ["node_modules", "npm", "bin", "npm-cli.js"];

/**
 * Where npm-cli.js sits beside the node that runs this supervisor, in the
 * order they are tried. Never a PATH guess: a service starts with a minimal
 * PATH, and the HOAI desktop setup may have installed a private node.
 *
 * - win32 `<dir>\node.exe`: `<dir>\node_modules\npm`.
 * - posix `<prefix>/bin/node`: `<prefix>/lib/node_modules/npm` (the official
 *   installer, nvm, the HOAI private node, a distro package).
 * - Homebrew. Its node runs from the keg (process.execPath is the resolved
 *   `<brew>/Cellar/node/<v>/bin/node`), and the keg's lib holds no npm. The
 *   keg's own `bin/npm` links to `<brew>/lib/node_modules/npm`, so that is
 *   the npm this node runs and comes first; the formula's private copy in
 *   `<keg>/libexec/lib/node_modules/npm` (what post install copies there)
 *   is the fallback. `<brew>` is the folder holding `Cellar`, so Apple
 *   silicon, Intel (/usr/local) and Linuxbrew all resolve.
 * - Debian and Ubuntu's own packages (apt's nodejs and npm). Node is
 *   /usr/bin/node, npm is /usr/share/nodejs/npm and /usr/lib/node_modules
 *   holds nothing. Debian 13 and Ubuntu 25.10 and 26.04 ship node 20 or newer,
 *   which the desktop installer keeps, so without this every stage there
 *   failed with "npm was not found" (review F8).
 */
export function npmCliCandidates(execPath: string, platform: string): string[] {
  if (platform === "win32")
    return [win32.join(win32.dirname(execPath), ...NPM_CLI)];
  const prefix = posix.dirname(posix.dirname(execPath));
  const candidates = [posix.join(prefix, "lib", ...NPM_CLI)];
  if (platform === "linux")
    candidates.push(posix.join(prefix, "share", "nodejs", ...NPM_CLI.slice(1)));
  const formula = posix.dirname(prefix);
  if (posix.basename(posix.dirname(formula)) === "Cellar")
    candidates.push(
      posix.join(posix.dirname(posix.dirname(formula)), "lib", ...NPM_CLI),
      posix.join(prefix, "libexec", "lib", ...NPM_CLI),
    );
  return candidates;
}

/** The first of npmCliCandidates that exists, or null. */
export function npmCliPath(
  execPath: string,
  platform: string,
  exists: (path: string) => boolean,
): string | null {
  return npmCliCandidates(execPath, platform).find((path) => exists(path)) ?? null;
}

/** The same flags the HOAI desktop installer uses, with Codex pinned. */
export function stageInstallArgs(input: {
  npmCli: string;
  prefix: string;
  version: string;
  codexVersion: string;
}): string[] {
  return [
    input.npmCli,
    "install",
    "--prefix",
    input.prefix,
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    `${PACKAGE_NAME}@${input.version}`,
    `${CODEX_PACKAGE}@${input.codexVersion}`,
  ];
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

export function emptyUpdateState(): UpdateState {
  return {
    schemaVersion: 1,
    supervisorPid: null,
    supervised: "none",
    autoUpdateEnabled: false,
    latestKnownVersion: null,
    checkedAt: null,
    nextCheckAt: null,
    stagedVersion: null,
    stagedCodexVersion: null,
    rolledBack: [],
    pendingConfirm: null,
    waitingReason: null,
    waitingSince: null,
    lastError: null,
  };
}

const SUPERVISED_MODES: readonly SupervisedMode[] = [
  "launchd",
  "systemd",
  "supervise-npm",
  "none",
];
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Read and sanitize `<home>/update-state.json`; null when absent or unreadable. */
export function readUpdateState(
  home: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): UpdateState | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(read(join(home, UPDATE_STATE_FILE)));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const pending = raw.pendingConfirm as Record<string, unknown> | null;
  const lastError = raw.lastError as Record<string, unknown> | null;
  return {
    schemaVersion: 1,
    supervisorPid: Number.isSafeInteger(raw.supervisorPid)
      ? (raw.supervisorPid as number)
      : null,
    supervised: SUPERVISED_MODES.includes(raw.supervised as SupervisedMode)
      ? (raw.supervised as SupervisedMode)
      : "none",
    autoUpdateEnabled: raw.autoUpdateEnabled === true,
    latestKnownVersion: str(raw.latestKnownVersion),
    checkedAt: str(raw.checkedAt),
    nextCheckAt: str(raw.nextCheckAt),
    stagedVersion: str(raw.stagedVersion),
    stagedCodexVersion: str(raw.stagedCodexVersion),
    rolledBack: Array.isArray(raw.rolledBack)
      ? raw.rolledBack.filter((v): v is string => typeof v === "string")
      : [],
    pendingConfirm:
      pending &&
      typeof pending === "object" &&
      typeof pending.version === "string" &&
      typeof pending.previousVersion === "string" &&
      typeof pending.appliedAt === "string"
        ? {
            version: pending.version,
            previousVersion: pending.previousVersion,
            appliedAt: pending.appliedAt,
            boots: Number.isSafeInteger(pending.boots)
              ? (pending.boots as number)
              : 0,
            rollbackFailures: Number.isSafeInteger(pending.rollbackFailures)
              ? (pending.rollbackFailures as number)
              : 0,
          }
        : null,
    waitingReason: str(raw.waitingReason),
    waitingSince: str(raw.waitingSince),
    lastError:
      lastError &&
      typeof lastError === "object" &&
      typeof lastError.message === "string"
        ? { at: String(lastError.at ?? ""), message: lastError.message }
        : null,
  };
}

/** Atomic (tmp then rename), 0600, like the heartbeat file. */
export function writeUpdateState(home: string, state: UpdateState): void {
  mkdirSync(home, { recursive: true });
  const target = join(home, UPDATE_STATE_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, target);
}

// ---------------------------------------------------------------------------
// Runtime folders
// ---------------------------------------------------------------------------

export function runtimePaths(home: string): {
  runtime: string;
  next: string;
  prev: string;
  failed: string;
} {
  return {
    runtime: join(home, "runtime"),
    next: join(home, "runtime.next"),
    prev: join(home, "runtime.prev"),
    failed: join(home, "runtime.failed"),
  };
}

/** `<runtime>/node_modules/codex-channel-bgos/dist/cli.js` */
export function runtimeCli(runtimeDir: string): string {
  return join(runtimeDir, "node_modules", PACKAGE_NAME, "dist", "cli.js");
}

/** The version of a package installed at the top of a runtime, or null. */
export function installedPackageVersion(
  runtimeDir: string,
  pkg: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  try {
    const version = JSON.parse(
      read(join(runtimeDir, "node_modules", ...pkg.split("/"), "package.json")),
    ).version;
    return parseVersion(version) ? (version as string) : null;
  } catch {
    return null;
  }
}

/**
 * This supervisor runs from `<home>/runtime`, the only layout a swap can
 * update. An npx cache, a global install or a dev checkout never stages.
 */
export function isManagedRuntime(
  home: string,
  cliPath: string,
  realpath: (path: string) => string = realpathSync,
): boolean {
  try {
    return realpath(cliPath) === realpath(runtimeCli(runtimePaths(home).runtime));
  } catch {
    return false;
  }
}

export interface RuntimeFs {
  exists: (path: string) => boolean;
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
}

export const nodeRuntimeFs: RuntimeFs = {
  exists: existsSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

/** runtime -> runtime.prev, runtime.next -> runtime; undone if the second rename fails. */
export function swapRuntime(home: string, fs: RuntimeFs = nodeRuntimeFs): void {
  const { runtime, next, prev } = runtimePaths(home);
  if (!fs.exists(next)) throw new Error("Nothing is staged.");
  fs.remove(prev);
  fs.rename(runtime, prev);
  try {
    fs.rename(next, runtime);
  } catch (error) {
    fs.rename(prev, runtime);
    throw error;
  }
}

/** runtime -> runtime.failed (then removed), runtime.prev -> runtime. */
export function rollbackRuntime(
  home: string,
  fs: RuntimeFs = nodeRuntimeFs,
): void {
  const { runtime, prev, failed } = runtimePaths(home);
  if (!fs.exists(prev)) throw new Error("There is no previous version to return to.");
  fs.remove(failed);
  fs.rename(runtime, failed);
  try {
    fs.rename(prev, runtime);
  } catch (error) {
    fs.rename(failed, runtime);
    throw error;
  }
  try {
    fs.remove(failed);
  } catch {}
}

export type Exec = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** No shell, no window, output captured and bounded. */
export const nodeExec: Exec = (command, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "",
      stderr = "";
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(
      () => child.kill(),
      opts.timeoutMs ?? 10 * 60 * 1000,
    );
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-64 * 1024);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(error.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

/** The `latest` dist tag of the connector, or null when it is not a plain version. */
export async function fetchLatestVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const response = await fetchImpl(REGISTRY_DIST_TAGS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`The npm registry answered ${response.status}.`);
  const body = (await response.json()) as { latest?: unknown };
  return parseVersion(body?.latest) ? String(body.latest).trim() : null;
}

const tail = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(-300) || "no output";

/**
 * Install `version` into runtime.next next to the Codex version the live
 * runtime has (or `codexVersion`, for a first install by connect
 * --keep-alive), then prove the staged CLI runs and the Codex pin held.
 */
export async function stageRuntime(input: {
  home: string;
  version: string;
  execPath: string;
  platform: string;
  exec: Exec;
  fs?: RuntimeFs;
  read?: (path: string) => string;
  codexVersion?: string;
}): Promise<void> {
  const fs = input.fs ?? nodeRuntimeFs;
  const { runtime, next } = runtimePaths(input.home);
  const codexVersion =
    input.codexVersion ??
    installedPackageVersion(runtime, CODEX_PACKAGE, input.read);
  if (!codexVersion)
    throw new Error("The installed Codex runtime version is unknown, so nothing was staged.");
  const npmCli = npmCliPath(input.execPath, input.platform, fs.exists);
  if (!npmCli) throw new Error("npm was not found next to node, so nothing was staged.");
  fs.remove(next);
  const install = await input.exec(
    input.execPath,
    stageInstallArgs({ npmCli, prefix: next, version: input.version, codexVersion }),
    { timeoutMs: 10 * 60 * 1000 },
  );
  if (install.code !== 0) {
    fs.remove(next);
    throw new Error(`npm could not install ${input.version}: ${tail(install.stderr)}`);
  }
  const probe = await input.exec(input.execPath, [runtimeCli(next), "--version"], {
    timeoutMs: 60 * 1000,
  });
  const staged = installedPackageVersion(next, CODEX_PACKAGE, input.read);
  if (probe.code !== 0 || probe.stdout.trim() !== input.version) {
    fs.remove(next);
    throw new Error(
      `The staged ${input.version} did not start (${probe.code === 0 ? `it said ${tail(probe.stdout)}` : tail(probe.stderr)}).`,
    );
  }
  if (staged !== codexVersion) {
    fs.remove(next);
    throw new Error(
      `The staged runtime carries Codex ${staged ?? "unknown"}, not ${codexVersion}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The supervisor's updater
// ---------------------------------------------------------------------------

export interface SelfUpdaterDeps {
  home: string;
  currentVersion: string;
  supervised: SupervisedMode;
  /** CODEX_BGOS_AUTO_UPDATE, read once by the supervisor. */
  enabled: boolean;
  managedRuntime: boolean;
  supervisorPid: number;
  startedAtMs: number;
  now: () => number;
  random: () => number;
  fetchLatest: () => Promise<string | null>;
  stage: (version: string) => Promise<void>;
  hasStaged: () => boolean;
  swap: () => void;
  rollback: () => void;
  removePrevious: () => void;
  /** Remove runtime.next (a stage that will never be applied). */
  removeStaged: () => void;
  /** The Codex version installed in the live runtime, or null. */
  runtimeCodexVersion: () => string | null;
  readHeartbeat: () => ChildHeartbeat | null;
  childPid: () => number | null;
  /** Ask the child to stop if, and only if, it is idle (child-control.ts). */
  requestChildStop: () => Promise<ChildStopReply>;
  waitChildExit: (ms: number) => Promise<boolean>;
  forceStopChild: () => Promise<void>;
  /** Restarts allowed again; relaunch the child if it is not running. */
  resumeChild: () => void;
  /** Release the lock and hand over to the next supervisor (exit 75). */
  restartSupervisor: () => Promise<void>;
  log: (message: string) => void;
  read?: (path: string) => string;
}

export class SelfUpdater {
  private state: UpdateState;
  private running = false;
  /** The 24 h wait was logged by this supervisor. */
  private waitNoticed = false;

  constructor(private readonly deps: SelfUpdaterDeps) {
    this.state = readUpdateState(deps.home, deps.read) ?? emptyUpdateState();
  }

  /** Whether this supervisor will update by itself at all. */
  get active(): boolean {
    return (
      this.deps.enabled &&
      this.deps.supervised !== "none" &&
      this.deps.managedRuntime
    );
  }

  snapshot(): UpdateState {
    return JSON.parse(JSON.stringify(this.state));
  }

  /** A rollback is owed now, before any child should run (rollbackOwed). */
  get rollbackDue(): boolean {
    const pending = this.state.pendingConfirm;
    return pending !== null && rollbackOwed(pending);
  }

  /**
   * Review F10. Run right after boot(), which supervise calls as soon as it
   * holds the lock, before the control server, service.json or the child: a
   * new version whose supervisor dies anywhere after that still had its boot
   * counted, and the start that finds CONFIRM_MAX_BOOTS exceeded rolls it
   * back here, before running anything else of it. No child runs yet, so
   * nothing is asked or stopped. True when it rolled back and handed over;
   * false when nothing was owed or the rollback failed and stays owed (the
   * child then stays down and the passes retry it).
   */
  async rollBackBeforeStart(): Promise<boolean> {
    const pending = this.state.pendingConfirm;
    if (!pending || !rollbackOwed(pending)) return false;
    return (await this.rollBack(pending, false)) === "rolled_back";
  }

  /** Claim the state for this supervisor and count a boot of an applied version. */
  boot(): void {
    const s = this.state;
    s.supervisorPid = this.deps.supervisorPid;
    s.supervised = this.deps.supervised;
    s.autoUpdateEnabled = this.active;
    if (s.pendingConfirm) {
      // A repair from the app installed something else meanwhile: there is
      // nothing of ours left to confirm.
      if (s.pendingConfirm.version !== this.deps.currentVersion)
        s.pendingConfirm = null;
      else s.pendingConfirm.boots += 1;
    }
    if (s.stagedVersion && !this.deps.hasStaged()) this.dropStage();
    // A repair from the app reinstalls the runtime (Codex @latest) while
    // runtime.next keeps the Codex pinned at stage time. Applying it would
    // silently undo the repair, so a stage built beside another Codex is
    // dropped and the next check stages again beside this one (review F7).
    else if (
      s.stagedVersion &&
      s.stagedCodexVersion !== this.deps.runtimeCodexVersion()
    ) {
      this.deps.log(
        `update ${s.stagedVersion} dropped: it was staged beside Codex ${s.stagedCodexVersion ?? "unknown"}, and the runtime now has ${this.deps.runtimeCodexVersion() ?? "an unknown one"}`,
      );
      this.dropStage();
      try {
        this.deps.removeStaged();
      } catch {}
    }
    this.save();
  }

  private dropStage(): void {
    this.state.stagedVersion = null;
    this.state.stagedCodexVersion = null;
  }

  /** One pass; never two at once (a stage runs npm for a while). */
  async tick(): Promise<string> {
    if (this.running) return "running";
    this.running = true;
    try {
      return await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<string> {
    const now = this.deps.now();
    if (this.state.pendingConfirm) return this.confirm(now);
    if (!this.active) return "inactive";
    let outcome = "idle";
    if (isCheckDue(this.state, now, this.deps.startedAtMs))
      outcome = await this.checkAndStage(now);
    const decision = decideApply({
      enabled: this.deps.enabled,
      supervised: this.deps.supervised,
      managedRuntime: this.deps.managedRuntime,
      stagedVersion: this.state.stagedVersion,
      latest: this.state.latestKnownVersion,
      current: this.deps.currentVersion,
      rolledBack: this.state.rolledBack,
      safety: decideSafeMoment({
        heartbeat: this.deps.readHeartbeat(),
        childPid: this.deps.childPid(),
        nowMs: now,
      }),
    });
    if (decision.action === "apply") return this.apply(decision.version, now);
    if (decision.action === "wait") return this.waiting(decision.reason, now);
    // Nothing is left to apply, so nothing waits any more.
    const s = this.state;
    if (decision.reason === "stale_stage" || s.waitingReason || s.waitingSince) {
      if (decision.reason === "stale_stage") {
        this.dropStage();
        try {
          this.deps.removeStaged();
        } catch {}
      }
      s.waitingReason = null;
      s.waitingSince = null;
      this.waitNoticed = false;
      this.save();
    }
    return outcome;
  }

  /**
   * Record why the staged update waits and since when (decision D6); the
   * wait keeps its start while its reason moves. Never forced: after 24 h
   * the log says so, once per supervisor.
   */
  private waiting(reason: string, now: number): string {
    const s = this.state;
    const since = Number.isFinite(Date.parse(s.waitingSince ?? ""))
      ? s.waitingSince!
      : new Date(now).toISOString();
    if (s.waitingReason !== reason || s.waitingSince !== since) {
      s.waitingReason = reason;
      s.waitingSince = since;
      this.save();
    }
    const waited = now - Date.parse(since);
    if (!this.waitNoticed && waited >= UPDATE_WAIT_NOTICE_MS) {
      this.waitNoticed = true;
      this.deps.log(
        `update ${s.stagedVersion} has waited ${Math.floor(waited / 3_600_000)} h for an idle moment (${reason}); it is never forced`,
      );
    }
    return `waiting:${reason}`;
  }

  private async checkAndStage(now: number): Promise<string> {
    const s = this.state;
    let latest: string | null;
    try {
      latest = await this.deps.fetchLatest();
    } catch (error) {
      s.nextCheckAt = new Date(now + CHECK_RETRY_MS).toISOString();
      s.lastError = {
        at: new Date(now).toISOString(),
        message: `Update check failed: ${errorMessage(error)}`,
      };
      this.save();
      return "check_failed";
    }
    s.latestKnownVersion = latest;
    s.checkedAt = new Date(now).toISOString();
    s.nextCheckAt = new Date(nextCheckAt(now, this.deps.random)).toISOString();
    s.lastError = null;
    const decision = decideUpdate({
      enabled: true,
      current: this.deps.currentVersion,
      latest,
      rolledBack: s.rolledBack,
    });
    if (decision.action !== "stage" || decision.version === s.stagedVersion) {
      this.save();
      return "checked";
    }
    this.save();
    try {
      // The pin stageRuntime installs beside, read the same way.
      const codex = this.deps.runtimeCodexVersion();
      await this.deps.stage(decision.version);
      s.stagedVersion = decision.version;
      s.stagedCodexVersion = codex;
      this.deps.log(`update ${decision.version} staged; it applies when the agent is idle`);
    } catch (error) {
      this.dropStage();
      s.lastError = {
        at: new Date(this.deps.now()).toISOString(),
        message: errorMessage(error),
      };
      this.deps.log(`update ${decision.version} not staged: ${errorMessage(error)}`);
    }
    this.save();
    return s.stagedVersion ? "staged" : "stage_failed";
  }

  private async apply(version: string, now: number): Promise<string> {
    const s = this.state;
    const reply = await this.deps.requestChildStop();
    if (reply !== "stopping") {
      // The child's own check is the last word: it saw a turn or a
      // background terminal the heartbeat had not, or did not answer.
      const outcome = this.waiting(
        reply === "busy" ? "busy" : "child_unresponsive",
        now,
      );
      this.deps.resumeChild();
      return outcome;
    }
    // It checked itself idle and is shutting down; only a shutdown that hangs
    // is ended for it.
    if (!(await this.deps.waitChildExit(CHILD_STOP_GRACE_MS)))
      await this.deps.forceStopChild();
    try {
      this.deps.swap();
    } catch (error) {
      this.dropStage();
      s.lastError = {
        at: new Date(this.deps.now()).toISOString(),
        message: `Could not switch to ${version}: ${errorMessage(error)}`,
      };
      this.save();
      this.deps.log(s.lastError.message);
      this.deps.resumeChild();
      return "apply_failed";
    }
    s.pendingConfirm = {
      version,
      previousVersion: this.deps.currentVersion,
      appliedAt: new Date(now).toISOString(),
      boots: 0,
      rollbackFailures: 0,
    };
    this.dropStage();
    s.waitingReason = null;
    s.waitingSince = null;
    this.save();
    this.deps.log(`switched to ${version}; restarting the supervisor on it`);
    await this.deps.restartSupervisor();
    return "applied";
  }

  private async confirm(now: number): Promise<string> {
    const s = this.state;
    const pending = s.pendingConfirm!;
    const verdict = decideConfirmation({
      pending,
      heartbeat: this.deps.readHeartbeat(),
      childPid: this.deps.childPid(),
      startedAtMs: this.deps.startedAtMs,
      nowMs: now,
    });
    if (verdict === "wait") return "confirming";
    if (verdict === "confirmed") {
      s.pendingConfirm = null;
      s.lastError = null;
      this.save();
      this.deps.log(`update ${pending.version} confirmed healthy`);
      try {
        this.deps.removePrevious();
      } catch {}
      return "confirmed";
    }
    const reply = await this.deps.requestChildStop();
    const stop = decideRollbackStop({
      reply,
      heartbeat: this.deps.readHeartbeat(),
      childPid: this.deps.childPid(),
      nowMs: this.deps.now(),
    });
    if (stop === "wait") {
      this.deps.resumeChild();
      return "rollback_waiting";
    }
    if (stop === "force") await this.deps.forceStopChild();
    else if (
      reply === "stopping" &&
      !(await this.deps.waitChildExit(CHILD_STOP_GRACE_MS))
    )
      await this.deps.forceStopChild();
    return this.rollBack(pending, true);
  }

  /**
   * Swap runtime.prev back with no child running, record the version as
   * rolled back and hand over to the previous version's supervisor.
   * `relaunchOnGiveUp`: after ROLLBACK_MAX_ATTEMPTS the child is relaunched
   * here; before start, supervise launches it itself.
   */
  private async rollBack(
    pending: PendingConfirm,
    relaunchOnGiveUp: boolean,
  ): Promise<"rolled_back" | "rollback_failed"> {
    const s = this.state;
    if (!s.rolledBack.includes(pending.version))
      s.rolledBack = [...s.rolledBack, pending.version].slice(-ROLLED_BACK_KEEP);
    try {
      this.deps.rollback();
    } catch (error) {
      // The rollback stays owed until it succeeds (review F3): clearing it
      // here relaunched the version just judged broken, for good. Restarts
      // stay held, so nothing runs from a runtime being renamed, and the next
      // pass tries again; only after ROLLBACK_MAX_ATTEMPTS is the agent let
      // run on what it has.
      const failures = pending.rollbackFailures + 1;
      const giveUp = failures >= ROLLBACK_MAX_ATTEMPTS;
      s.pendingConfirm = giveUp ? null : { ...pending, rollbackFailures: failures };
      s.lastError = {
        at: new Date(this.deps.now()).toISOString(),
        message: giveUp
          ? `Could not return to ${pending.previousVersion} after ${failures} attempts (${errorMessage(error)}); staying on ${pending.version}.`
          : `Could not return to ${pending.previousVersion} yet (attempt ${failures} of ${ROLLBACK_MAX_ATTEMPTS}): ${errorMessage(error)}`,
      };
      this.save();
      this.deps.log(s.lastError.message);
      if (giveUp && relaunchOnGiveUp) this.deps.resumeChild();
      return "rollback_failed";
    }
    s.pendingConfirm = null;
    s.lastError = {
      at: new Date(this.deps.now()).toISOString(),
      message: `${pending.version} did not come up and was rolled back to ${pending.previousVersion}.`,
    };
    this.save();
    this.deps.log(s.lastError.message);
    await this.deps.restartSupervisor();
    return "rolled_back";
  }

  private save(): void {
    try {
      writeUpdateState(this.deps.home, this.state);
    } catch (error) {
      this.deps.log(`update state not saved: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
