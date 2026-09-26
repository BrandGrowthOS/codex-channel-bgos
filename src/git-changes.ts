/**
 * The Changes panel's collector (P7 stage 3, C-31; BGOS spec 9.3 and 10.1).
 *
 * The owner can turn on a Changes panel for this agent in BGOS. When the
 * panel reads, the backend sends a `changes_rpc` frame and this file answers
 * it with the agent's UNCOMMITTED changes: `git diff HEAD` of the working
 * folder, plus the files Git does not track yet.
 *
 * THIN ON PURPOSE. This file runs read only Git and sends its RAW output, cut
 * at the frame's byte caps. It does not split the patch into files, count
 * lines or mask secrets: the backend does all three, once, in one language,
 * before any client sees the answer (backend/src/changes-panel/changes-view.ts).
 * A mask here would also make the backend's "N lines hidden" count wrong.
 *
 * READ ONLY. Seven commands, in order, and nothing else (each after
 * `-c core.fsmonitor=false`, see below):
 *   1. rev-parse --show-toplevel   (in the working folder; prints the root)
 *   2. rev-parse --verify --quiet HEAD   (a first commit exists?)
 *   3. symbolic-ref --quiet --short HEAD, then rev-parse --short HEAD
 *   4. diff --numstat -z   (exact counts, past any drawing cap)
 *   5. diff   (the patch, with a/ and b/ and the short submodule format
 *      pinned whatever the host config says)
 *   6. ls-files --others --exclude-standard -z   (new files, .gitignore kept)
 * Every command after the first runs in the ROOT the first one printed, so the
 * tracked paths (which `git diff` prints root relative) and the new file names
 * (which `ls-files` would print folder relative) agree.
 *
 * THE FOLDER IT IS GIVEN, NOTHING ELSE. The variables that point Git at
 * another repository or index whatever folder it runs in (GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY,
 * GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE, GIT_PREFIX) are dropped
 * from Git's environment: a daemon started from inside a Git hook, or from a
 * shell with GIT_DIR exported, would otherwise send THAT repository's changes
 * as this folder's (measured with real Git, parity round 2). On Windows,
 * which reads environment names case blind, they are dropped in any spelling
 * (Git_Dir moved a read there too, fix round w4). The daemon's own
 * environment is never edited; Git gets a copy.
 *
 * NEVER WRITES THE INDEX. A porcelain `git diff` refreshes .git/index on its
 * own (it takes index.lock and rewrites the file) whenever a tracked file has
 * only a stat change, for example a file reverted to its HEAD text or saved
 * unchanged: that is Git's diff.autoRefreshIndex, on by default, and
 * GIT_OPTIONAL_LOCKS=0 does NOT reach it. So both diffs pass
 * `-c diff.autoRefreshIndex=false`, and a file whose content equals HEAD is
 * still left out of the numstat and the patch (Git compares the content).
 * Every command also runs with GIT_OPTIONAL_LOCKS=0, which keeps the other
 * optional lock takers quiet. Nothing here stages, stashes, checks out, or
 * asks for status, and an agent's own `git add` or `git commit` never meets
 * an index.lock this read took.
 *
 * RUNS NO PROGRAM THE REPOSITORY NAMES FOR ITS FSMONITOR. core.fsmonitor in
 * the repository's own config (which the agent writes) names a program Git
 * runs whenever it reads the index: both diffs and ls-files ran one on Git
 * 2.55.0.windows.3, the rev-parse and symbolic-ref reads did not (measured,
 * fix round w4). So every command starts with `-c core.fsmonitor=false`,
 * which Git documents as the fsmonitor off, in its program form and its
 * built in daemon form alike (the program form is the one measured). The
 * diffs already pass --no-ext-diff and --no-textconv, which keep out an
 * external diff and a textconv program. A clean filter the repository names
 * still runs on both diffs: no flag here stops it (measured, and left open
 * in the fix round's record).
 *
 * GIT BY ITS ABSOLUTE PATH. `spawn("git", { cwd })` on Windows looks in the
 * child's working folder BEFORE PATH (libuv's search_path, which uv_spawn
 * hands the child's cwd), and a relative PATH entry does the same on any
 * host. The agent writes that folder, so a git.exe it left there would run as
 * the owner, outside the agent's own approvals, each time the owner opened the
 * panel (measured on this plugin's node, parity round D-R2). So Git is looked
 * up on PATH's ABSOLUTE entries only, once per read, and spawned by that path;
 * no Git there reads as `git_missing`, and nothing is started.
 *
 * `git_missing` ONLY WHILE THE FOLDER IS THERE. Node reports a spawn into a
 * working folder that does not exist as ENOENT, the code a missing Git gives,
 * so an ENOENT is Git missing only when the folder still is (an lstat that
 * finds something other than a regular file). A folder removed while the
 * daemon ran is a failed read, never "Git is not installed" (parity round 2).
 *
 * The frame's caps are honoured and never raised (`readCaps`), the reads stop
 * at the byte cap and kill the child (a large diff never fails the whole read
 * the way a `maxBuffer` would), and the whole collection runs under the
 * frame's budget: past it the running child is killed and the answer is
 * `too_slow`.
 *
 * The folder travels as a BASENAME only: an absolute path names the operating
 * system user.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access as fsAccess,
  lstat as fsLstat,
  open as fsOpen,
  stat as fsStat,
} from "node:fs/promises";

/** The frame's numbers, and the ceiling on each (backend CHANGES_FRAME_PAYLOAD). */
export interface ChangesCaps {
  maxPatchBytes: number;
  maxNumstatBytes: number;
  maxUntrackedListBytes: number;
  maxUntrackedTextFiles: number;
  maxUntrackedTextBytes: number;
  budgetMs: number;
}

export const DEFAULT_CHANGES_CAPS: Readonly<ChangesCaps> = Object.freeze({
  maxPatchBytes: 1_048_576,
  maxNumstatBytes: 262_144,
  maxUntrackedListBytes: 65_536,
  maxUntrackedTextFiles: 20,
  maxUntrackedTextBytes: 65_536,
  budgetMs: 10_000,
});

/**
 * The caps a frame asks for: each field that is a positive whole number is
 * taken, but never above this daemon's own default; anything else (missing,
 * zero, negative, fractional, a string) is the default.
 */
export function readCaps(payload: unknown): ChangesCaps {
  const source =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const out: ChangesCaps = { ...DEFAULT_CHANGES_CAPS };
  for (const name of Object.keys(DEFAULT_CHANGES_CAPS) as Array<
    keyof ChangesCaps
  >) {
    const value = source[name];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      out[name] = Math.min(value, DEFAULT_CHANGES_CAPS[name]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the commands
// ---------------------------------------------------------------------------

/**
 * First on EVERY command: a core.fsmonitor the repository's own config names
 * is a program Git runs when it reads the index (see the header). Exported
 * for the native /diff, which reads the same folder.
 */
export const NO_FSMONITOR = ["-c", "core.fsmonitor=false"] as const;
const GIT_TOPLEVEL = [...NO_FSMONITOR, "rev-parse", "--show-toplevel"] as const;
const GIT_VERIFY_HEAD = [
  ...NO_FSMONITOR,
  "rev-parse",
  "--verify",
  "--quiet",
  "HEAD",
] as const;
const GIT_BRANCH = [
  ...NO_FSMONITOR,
  "symbolic-ref",
  "--quiet",
  "--short",
  "HEAD",
] as const;
const GIT_SHORT_HEAD = [...NO_FSMONITOR, "rev-parse", "--short", "HEAD"] as const;
/** A porcelain diff that never refreshes the index (see the header).
 * Exported for the native /diff. */
export const NO_INDEX_REFRESH = ["-c", "diff.autoRefreshIndex=false"] as const;
const GIT_NUMSTAT = [
  ...NO_FSMONITOR,
  "-c",
  "core.quotepath=false",
  ...NO_INDEX_REFRESH,
  "diff",
  "--numstat",
  "-z",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "HEAD",
  "--",
] as const;
/**
 * `--src-prefix=a/ --dst-prefix=b/` overrides a host whose Git config sets
 * diff.noprefix (headers with no prefix), diff.mnemonicPrefix (`c/` and `w/`)
 * or diff.srcPrefix and diff.dstPrefix, so the backend always reads the
 * `a/` and `b/` it splits on. Both flags are as old as Git 1.5.
 *
 * `--submodule=short` overrides a host with diff.submodule=log (a moved
 * submodule written as `Submodule <path> <a>..<b>:` and its commit subjects)
 * or diff.submodule=diff (the submodule's own files inline): neither starts
 * with a `diff --git` line, so the backend's splitter would hang them on the
 * previous file's section, or draw files the numstat never names. Short is
 * Git's default: one `diff --git a/<path> b/<path>` section whose two lines
 * are the old and the new `Subproject commit`.
 *
 * The options are in spec 10.1 item 7's own order (fix round w4, F9).
 */
const GIT_PATCH = [
  ...NO_FSMONITOR,
  "-c",
  "core.quotepath=false",
  ...NO_INDEX_REFRESH,
  "--no-pager",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
  "--find-renames",
  "HEAD",
  "--",
] as const;
const GIT_UNTRACKED = [
  ...NO_FSMONITOR,
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
] as const;

/** Variables that make Git read another repository or index, whatever
 * folder it runs in (see the header). */
const REPOSITORY_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
] as const;

const OVERRIDE_NAMES: ReadonlySet<string> = new Set(REPOSITORY_OVERRIDES);

/**
 * The environment Git gets: a COPY of the daemon's, with the repository
 * overrides dropped and the three read settings set. Windows reads
 * environment names case blind, so there a key in ANY spelling whose capitals
 * are one of the eight is dropped (Git_Dir reached Git there, measured in fix
 * round w4); elsewhere another spelling is another variable, which Git never
 * reads, and it passes through. Exported for the native /diff.
 */
export function gitReadEnv(
  base: Record<string, string | undefined>,
  platform: string = process.platform,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (platform === "win32") {
    for (const name of Object.keys(env)) {
      if (OVERRIDE_NAMES.has(name.toUpperCase())) delete env[name];
    }
  } else {
    for (const name of REPOSITORY_OVERRIDES) delete env[name];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  return env;
}

/** The cap on the small reads (the root, the branch, the head). */
const SMALL_OUTPUT_MAX = 65_536;
/** A NUL in this many first bytes makes a new file binary (Git's own rule). */
const BINARY_SNIFF_BYTES = 8_000;
const FOLDER_MAX = 120;
const STDERR_MAX = 4_096;

// ---------------------------------------------------------------------------
// the seams: how Git runs and how files are read
// ---------------------------------------------------------------------------

export interface GitRunOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Stop reading stdout past this many bytes, and kill the child. */
  maxBytes: number;
  /** Aborted when the budget runs out: the child is killed. */
  signal: AbortSignal;
}

export interface GitRunResult {
  /** The exit code, or null when the child was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout passed `maxBytes` and the child was killed. */
  truncated: boolean;
}

export type RunGit = (
  args: readonly string[],
  options: GitRunOptions,
) => Promise<GitRunResult>;

/** What the untracked step reads of a file: its kind, size and identity. */
export interface ChangesStat {
  isFile(): boolean;
  size: number;
  dev?: number;
  ino?: number;
}

/** One open file. The collector asks for its `stat` FIRST, and reads only
 * when it is still the regular file the lstat saw (fix round w4, F7). */
export interface ChangesFileHandle {
  /** The OPEN file's kind, size and identity (an fstat). */
  stat(): Promise<ChangesStat>;
  /** At most `maxBytes` from the start of the open file, never more. */
  read(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface ChangesFs {
  lstat(path: string): Promise<ChangesStat>;
  /**
   * Opens `path` ONCE (never through a symlink, where the host can refuse
   * one) and reads nothing: the handle's `stat` shows a name swapped after
   * an lstat before a single byte is read.
   */
  open(path: string): Promise<ChangesFileHandle>;
}

/** Finds the Git to run: an absolute path, or null when no PATH entry holds one. */
export type FindGit = (
  env: Record<string, string | undefined>,
) => Promise<string | null>;

export interface FindGitDeps {
  platform: string;
  /** True when the path is a file this process may run. */
  isRunnable: (path: string) => Promise<boolean>;
}

async function nodeIsRunnable(path: string): Promise<boolean> {
  try {
    const found = await fsStat(path);
    if (!found.isFile()) return false;
    if (process.platform !== "win32") await fsAccess(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH's value. Windows spells the name Path and reads it case blind. */
function pathVariable(
  env: Record<string, string | undefined>,
  win: boolean,
): string {
  if (!win) return typeof env.PATH === "string" ? env.PATH : "";
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === "PATH" && typeof value === "string") return value;
  }
  return "";
}

/**
 * An entry that names a folder on its own, whatever folder Git runs in.
 * Empty, `.`, `bin`, a drive relative `C:tools` and a rooted `\tools` with no
 * drive all depend on the working folder, so they are never looked at.
 */
function isAbsoluteEntry(dir: string, win: boolean): boolean {
  if (win) return /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir);
  return dir.startsWith("/");
}

/**
 * The Git lookup: the first absolute PATH entry holding `git.exe` (Windows)
 * or a runnable `git` (elsewhere), in PATH order. Never the working folder.
 */
export function createFindGit(deps: Partial<FindGitDeps> = {}): FindGit {
  const win = (deps.platform ?? process.platform) === "win32";
  const isRunnable = deps.isRunnable ?? nodeIsRunnable;
  return async (env) => {
    for (const raw of pathVariable(env, win).split(win ? ";" : ":")) {
      const dir = win ? raw.trim().replace(/^"(.*)"$/, "$1").trim() : raw;
      if (!isAbsoluteEntry(dir, win)) continue;
      const candidate = win
        ? `${dir.replace(/[\\/]+$/, "")}\\git.exe`
        : `${dir.replace(/\/+$/, "")}/git`;
      if (await isRunnable(candidate)) return candidate;
    }
    return null;
  };
}

/** What a read gets when no absolute PATH entry holds Git: ENOENT, as the
 * spawn of a missing binary says, which the collector answers git_missing. */
function gitNotFound(): Error {
  return Object.assign(
    new Error("git was not found on an absolute PATH entry"),
    { code: "ENOENT" },
  );
}

/**
 * Git through `spawn`, never a shell, and by its ABSOLUTE path (see the
 * header): `findGit` looks it up on PATH's absolute entries once per adapter,
 * with the environment Git gets, and the handler makes one adapter per read.
 * `bin` names the binary outright instead (the tests' own child processes).
 * stdout is read until `maxBytes` and the child is then killed, so a large
 * diff is cut instead of failing the whole read. The budget's abort kills the
 * child too. No Git on PATH rejects with `code` `ENOENT` and starts nothing;
 * so does a spawn of a binary that is not there.
 */
export function createNodeRunGit(
  options: { bin?: string; spawnImpl?: typeof spawn; findGit?: FindGit } = {},
): RunGit {
  const spawnImpl = options.spawnImpl ?? spawn;
  const findGit = options.findGit ?? createFindGit();
  let located: Promise<string | null> | null =
    options.bin !== undefined ? Promise.resolve(options.bin) : null;
  return async (args, runOptions) => {
    if (runOptions.signal.aborted) throw new Error("changes read aborted");
    located ??= findGit(runOptions.env).catch(() => null);
    const bin = await located;
    if (!bin) throw gitNotFound();
    return spawnGit(spawnImpl, bin, args, runOptions);
  };
}

function spawnGit(
  spawnImpl: typeof spawn,
  bin: string,
  args: readonly string[],
  { cwd, env, maxBytes, signal }: GitRunOptions,
): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("changes read aborted"));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawnImpl(bin, [...args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const errChunks: Buffer[] = [];
    let errSize = 0;
    let settled = false;

    const kill = () => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      kill();
      settle(() => reject(new Error("changes read aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const stderrText = () => Buffer.concat(errChunks).toString("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - size;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        truncated = true;
        kill();
        child.stdout?.destroy();
        // Settle now, not on "close": on Windows Git's launcher can leave a
        // grandchild holding the pipes for a while after the kill, and the
        // read already has everything it will send.
        settle(() =>
          resolve({
            code: null,
            stdout: Buffer.concat(chunks).toString("utf8"),
            stderr: stderrText(),
            truncated: true,
          }),
        );
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errSize >= STDERR_MAX) return;
      errChunks.push(chunk.subarray(0, STDERR_MAX - errSize));
      errSize += Math.min(chunk.length, STDERR_MAX - errSize);
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) =>
      settle(() =>
        resolve({
          code: truncated ? null : code,
          stdout: Buffer.concat(chunks).toString("utf8"),
          stderr: stderrText(),
          truncated,
        }),
      ),
    );
  });
}

/**
 * O_NOFOLLOW refuses a symlink at the open, and O_NONBLOCK keeps a FIFO put
 * in a file's place from blocking the open (and a thread of the pool with
 * it). Windows has neither (both are undefined in fs.constants there); the
 * file id check in readOne is what catches a swapped name on that host.
 */
const OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0);

/**
 * The real file system: `lstat`, and one handle whose open reads nothing,
 * whose `stat` is an fstat, and whose `read` fills a buffer of at most the
 * size asked for, so it never loads more.
 */
export const nodeChangesFs: ChangesFs = {
  lstat: (path) => fsLstat(path),
  async open(path) {
    const handle = await fsOpen(path, OPEN_FLAGS);
    return {
      stat: () => handle.stat(),
      async read(maxBytes) {
        const buffer = Buffer.alloc(Math.max(0, maxBytes));
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            filled,
            buffer.length - filled,
            filled,
          );
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buffer.subarray(0, filled);
      },
      close: () => handle.close(),
    };
  },
};

// ---------------------------------------------------------------------------
// the answer
// ---------------------------------------------------------------------------

export type ChangesState = "ok" | "not_git" | "no_commits" | "git_missing";

export interface UntrackedFileEntry {
  path: string;
  bytes: number;
  text?: string;
  binary?: true;
}

/** The `ok: true` payload the backend reads (spec 9.3, `readDaemonAnswer`). */
export interface ChangesPayload {
  v: 1;
  state: ChangesState;
  folder: string;
  branch: string | null;
  head: string | null;
  numstat: string;
  numstatTruncated: boolean;
  patch: string;
  patchTruncated: boolean;
  untracked: string;
  untrackedTruncated: boolean;
  untrackedFiles: UntrackedFileEntry[];
  takenAt: string;
}

export type ChangesResultBody =
  | { ok: true; payload: ChangesPayload }
  | { ok: false; error: { code: string; message: string } };

export interface CollectChangesInput {
  workdir: string;
  caps: ChangesCaps;
  runGit: RunGit;
  fs: ChangesFs;
  now?: () => number;
  /** The environment Git inherits (the process's own by default), less the
   * repository overrides; it is copied, never edited. */
  env?: Record<string, string | undefined>;
  /** The host's platform (process.platform by default): on win32 the
   * overrides are dropped in any spelling. */
  platform?: string;
}

export const TOO_SLOW_MESSAGE =
  "the changes took too long to read on the agent host";

class BudgetExpired extends Error {
  constructor() {
    super(TOO_SLOW_MESSAGE);
    this.name = "BudgetExpired";
  }
}

/** The last name of a folder path, whichever separator the host uses. */
function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = at >= 0 ? trimmed.slice(at + 1) : trimmed;
  return Array.from(name).slice(0, FOLDER_MAX).join("");
}

/** A name Git printed relative to the root, as a path under the root. */
function underRoot(root: string, name: string): string {
  return /[\\/]$/.test(root) ? `${root}${name}` : `${root}/${name}`;
}

function firstLine(text: string): string {
  const end = text.search(/\r?\n/);
  return end >= 0 ? text.slice(0, end) : text;
}

/**
 * Cut a string to at most `max` UTF-16 units, the measure the backend checks
 * the answer against (`readDaemonAnswer` compares each string's length with
 * the frame's cap), and never between the two halves of a surrogate pair.
 *
 * Only a fence: the node adapter already stops reading at the byte cap, and
 * text decoded from at most `max` bytes is never longer than `max` units
 * (every byte decodes to at most one unit, and a byte that is not UTF-8, as
 * in a legacy Latin-1 file, becomes one U+FFFD). Measuring the DECODED text
 * in UTF-8 bytes instead would count each such U+FFFD as three bytes, and so
 * cut, and call cut, a read that arrived whole (review round 1, C-R5).
 */
function cutToUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function emptyPayload(
  state: ChangesState,
  folder: string,
  takenAt: string,
): ChangesPayload {
  return {
    v: 1,
    state,
    folder,
    branch: null,
    head: null,
    numstat: "",
    numstatTruncated: false,
    patch: "",
    patchTruncated: false,
    untracked: "",
    untrackedTruncated: false,
    untrackedFiles: [],
    takenAt,
  };
}

/**
 * A Git command that failed. Only `summary` may travel to the backend: the
 * subcommand and its exit code. Git's own words can name the absolute
 * repository path (`detected dubious ownership in repository at
 * 'C:/Users/<name>/...'`), and so the operating system user (spec 9.3 and
 * 10.1 rule 8), so the first line of Git's stderr rides in the message, for
 * the daemon's local log only (review round 1, C-R4).
 */
export class GitCommandError extends Error {
  readonly summary: string;

  constructor(summary: string, detail = "") {
    super(detail ? `${summary}: ${detail}` : summary);
    this.name = "GitCommandError";
    this.summary = summary;
  }
}

function gitFailure(args: readonly string[], run: GitRunResult): GitCommandError {
  const subcommand = args.find((word, index) =>
    !word.startsWith("-") && args[index - 1] !== "-c",
  );
  const detail = firstLine(run.stderr.trim()).slice(0, 160);
  return new GitCommandError(
    `git ${subcommand ?? "command"} exited ${String(run.code)}`,
    detail,
  );
}

function isMissingGit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** The working folder is there: something that is not a regular file. */
async function folderExists(fs: ChangesFs, path: string): Promise<boolean> {
  try {
    return !(await fs.lstat(path)).isFile();
  } catch {
    return false;
  }
}

function wholeBytes(size: unknown): number {
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0
    ? size
    : 0;
}

/**
 * Collect the uncommitted changes of `workdir`. Answers the result body the
 * backend settles with: `ok: true` with the payload for every state, or
 * `ok: false` with `too_slow` when the budget ran out. Anything else a read
 * could not survive (a working folder that is gone included) is THROWN, and
 * the handler answers `read_failed`.
 */
export async function collectChanges(
  input: CollectChangesInput,
): Promise<ChangesResultBody> {
  const now = input.now ?? Date.now;
  const takenAt = new Date(now()).toISOString();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("expired");
    }, input.caps.budgetMs);
  });

  try {
    const outcome = await Promise.race([
      readChanges(input, controller.signal, takenAt),
      expired,
    ]);
    if (outcome === "expired") return tooSlow();
    return { ok: true, payload: outcome };
  } catch (error) {
    if (controller.signal.aborted || error instanceof BudgetExpired) {
      return tooSlow();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function tooSlow(): ChangesResultBody {
  return { ok: false, error: { code: "too_slow", message: TOO_SLOW_MESSAGE } };
}

async function readChanges(
  input: CollectChangesInput,
  signal: AbortSignal,
  takenAt: string,
): Promise<ChangesPayload> {
  const { caps } = input;
  const env = gitReadEnv(input.env ?? process.env, input.platform);
  const git = async (
    args: readonly string[],
    cwd: string,
    maxBytes: number,
  ): Promise<GitRunResult> => {
    if (signal.aborted) throw new BudgetExpired();
    return input.runGit(args, { cwd, env, maxBytes, signal });
  };
  /** A raw read: cut at its cap (said so), else it must exit 0. */
  const capped = async (
    args: readonly string[],
    cwd: string,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean }> => {
    const run = await git(args, cwd, maxBytes);
    const text = cutToUnits(run.stdout, maxBytes);
    const truncated = run.truncated || text.length !== run.stdout.length;
    if (!truncated && run.code !== 0) throw gitFailure(args, run);
    return { text, truncated };
  };

  let top: GitRunResult;
  try {
    top = await git(GIT_TOPLEVEL, input.workdir, SMALL_OUTPUT_MAX);
  } catch (error) {
    if (isMissingGit(error)) {
      // Node reports a spawn whose working folder does not exist as ENOENT
      // too, so ENOENT means Git is missing only while the folder is there
      // (parity round 2). A folder that is gone is a failed read.
      if (!(await folderExists(input.fs, input.workdir))) {
        throw new Error("the working folder is not there");
      }
      return emptyPayload("git_missing", folderName(input.workdir), takenAt);
    }
    throw error;
  }
  if (top.code !== 0) {
    if (/not a git repository/i.test(top.stderr)) {
      return emptyPayload("not_git", folderName(input.workdir), takenAt);
    }
    throw gitFailure(GIT_TOPLEVEL, top);
  }
  // Kept exactly as printed: a repository at a drive root prints `C:/`, and
  // `C:` without its slash is that drive's CURRENT folder on Windows.
  const root = firstLine(top.stdout);
  if (!root) throw new GitCommandError("git rev-parse printed no folder");
  const folder = folderName(root);

  const verify = await git(GIT_VERIFY_HEAD, root, SMALL_OUTPUT_MAX);
  if (verify.code !== 0) return emptyPayload("no_commits", folder, takenAt);

  const branchRun = await git(GIT_BRANCH, root, SMALL_OUTPUT_MAX);
  const branch =
    branchRun.code === 0 ? firstLine(branchRun.stdout) || null : null;
  const headRun = await git(GIT_SHORT_HEAD, root, SMALL_OUTPUT_MAX);
  if (headRun.code !== 0) throw gitFailure(GIT_SHORT_HEAD, headRun);
  const head = firstLine(headRun.stdout) || null;

  const numstat = await capped(GIT_NUMSTAT, root, caps.maxNumstatBytes);
  const patch = await capped(GIT_PATCH, root, caps.maxPatchBytes);
  const untracked = await capped(
    GIT_UNTRACKED,
    root,
    caps.maxUntrackedListBytes,
  );
  const untrackedFiles = await readUntracked(
    root,
    untracked.text,
    caps,
    input.fs,
    signal,
  );

  return {
    v: 1,
    state: "ok",
    folder,
    branch,
    head,
    numstat: numstat.text,
    numstatTruncated: numstat.truncated,
    patch: patch.text,
    patchTruncated: patch.truncated,
    untracked: untracked.text,
    untrackedTruncated: untracked.truncated,
    untrackedFiles,
    takenAt,
  };
}

/**
 * The first `maxUntrackedTextFiles` names of the NUL separated list, each
 * `lstat`ed under the root: a regular file up to the text cap is read (a NUL
 * in its first 8,000 bytes makes it binary), a larger one is named by its
 * size only, and a symlink or anything else is binary. The text after the
 * last NUL is a name the list's cap cut, and is never read.
 *
 * The read is ONE handle and at most the text cap and one byte, and it must
 * still be the regular file the lstat saw (parity round, D-R3): a file that
 * grew past the cap since the lstat is its size only, and a name that is no
 * longer that file (swapped for a link, another file or a device) is its
 * name and the lstat's size. The handle's kind and id are checked BEFORE any
 * byte is read, so such a name is never read at all (fix round w4, F7).
 */
async function readUntracked(
  root: string,
  list: string,
  caps: ChangesCaps,
  fs: ChangesFs,
  signal: AbortSignal,
): Promise<UntrackedFileEntry[]> {
  const names = list.split("\0");
  names.pop();
  const out: UntrackedFileEntry[] = [];
  for (const name of names) {
    if (out.length >= caps.maxUntrackedTextFiles) break;
    if (name.length === 0) continue;
    if (signal.aborted) throw new BudgetExpired();
    out.push(await readOne(underRoot(root, name), name, caps, fs));
  }
  return out;
}

/**
 * The same file, as far as the host can tell: the file ids match. A host that
 * reports no id (0 or none) cannot tell, and the kind check and the bounded
 * read still hold.
 */
function sameFile(a: ChangesStat, b: ChangesStat): boolean {
  const known = (s: ChangesStat) => typeof s.ino === "number" && s.ino > 0;
  if (!known(a) || !known(b)) return true;
  return a.ino === b.ino && a.dev === b.dev;
}

async function readOne(
  full: string,
  name: string,
  caps: ChangesCaps,
  fs: ChangesFs,
): Promise<UntrackedFileEntry> {
  let stat: ChangesStat;
  try {
    stat = await fs.lstat(full);
  } catch {
    // Gone since Git listed it: named, never drawn.
    return { path: name, bytes: 0 };
  }
  const size = wholeBytes(stat.size);
  if (!stat.isFile()) return { path: name, bytes: size, binary: true };
  if (size > caps.maxUntrackedTextBytes) return { path: name, bytes: size };
  let handle: ChangesFileHandle;
  try {
    handle = await fs.open(full);
  } catch {
    return { path: name, bytes: size };
  }
  let opened: ChangesStat;
  let data: Uint8Array;
  try {
    // The handle is checked BEFORE any byte is read (fix round w4, F7):
    // swapped since the lstat, no longer a regular file or another file, is
    // its name and the lstat's size, and not one byte of it is read.
    opened = await handle.stat();
    if (!opened.isFile() || !sameFile(stat, opened)) {
      return { path: name, bytes: size };
    }
    data = await handle.read(caps.maxUntrackedTextBytes + 1);
  } catch {
    return { path: name, bytes: size };
  } finally {
    await handle.close().catch(() => {});
  }
  if (data.length > caps.maxUntrackedTextBytes) {
    // It grew past the cap since the lstat: its size now, never its text.
    return {
      path: name,
      bytes: Math.max(wholeBytes(opened.size), data.length),
    };
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { path: name, bytes: bytes.length, binary: true };
  }
  return { path: name, bytes: bytes.length, text: bytes.toString("utf8") };
}
