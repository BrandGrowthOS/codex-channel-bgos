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
 * READ ONLY. Seven commands, in order, and nothing else:
 *   1. rev-parse --show-toplevel   (in the working folder; prints the root)
 *   2. rev-parse --verify --quiet HEAD   (a first commit exists?)
 *   3. symbolic-ref --quiet --short HEAD, then rev-parse --short HEAD
 *   4. diff --numstat -z   (exact counts, past any drawing cap)
 *   5. diff   (the patch, with a/ and b/ pinned whatever the host config says)
 *   6. ls-files --others --exclude-standard -z   (new files, .gitignore kept)
 * Every command after the first runs in the ROOT the first one printed, so the
 * tracked paths (which `git diff` prints root relative) and the new file names
 * (which `ls-files` would print folder relative) agree. Every one runs with
 * GIT_OPTIONAL_LOCKS=0, so even a read never refreshes the index behind the
 * agent's back. Nothing here stages, stashes, checks out, or asks for status.
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
import { lstat as fsLstat, open as fsOpen } from "node:fs/promises";

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
  const out = { ...DEFAULT_CHANGES_CAPS };
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

const GIT_TOPLEVEL = ["rev-parse", "--show-toplevel"] as const;
const GIT_VERIFY_HEAD = ["rev-parse", "--verify", "--quiet", "HEAD"] as const;
const GIT_BRANCH = ["symbolic-ref", "--quiet", "--short", "HEAD"] as const;
const GIT_SHORT_HEAD = ["rev-parse", "--short", "HEAD"] as const;
const GIT_NUMSTAT = [
  "-c",
  "core.quotepath=false",
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
 */
const GIT_PATCH = [
  "-c",
  "core.quotepath=false",
  "--no-pager",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "HEAD",
  "--",
] as const;
const GIT_UNTRACKED = ["ls-files", "--others", "--exclude-standard", "-z"] as const;

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

export interface ChangesFs {
  lstat(path: string): Promise<{ isFile(): boolean; size: number }>;
  /** At most `limit` bytes from the start of the file. */
  readPrefix(path: string, limit: number): Promise<Uint8Array>;
}

/**
 * Git through `spawn`, never a shell: stdout is read until `maxBytes` and the
 * child is then killed, so a large diff is cut instead of failing the whole
 * read. The budget's abort kills the child too. A Git that is not on PATH
 * rejects with the spawn error, whose `code` is `ENOENT`.
 */
export function createNodeRunGit(
  options: { bin?: string; spawnImpl?: typeof spawn } = {},
): RunGit {
  const bin = options.bin ?? "git";
  const spawnImpl = options.spawnImpl ?? spawn;
  return (args, { cwd, env, maxBytes, signal }) =>
    new Promise<GitRunResult>((resolve, reject) => {
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

      child.stdout?.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          truncated = true;
          kill();
          child.stdout?.destroy();
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
            stderr: Buffer.concat(errChunks).toString("utf8"),
            truncated,
          }),
        ),
      );
    });
}

/** The real file system: `lstat`, and a bounded read that never loads more. */
export const nodeChangesFs: ChangesFs = {
  lstat: (path) => fsLstat(path),
  async readPrefix(path, limit) {
    const handle = await fsOpen(path, "r");
    try {
      const buffer = Buffer.alloc(limit);
      let filled = 0;
      while (filled < limit) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          limit - filled,
          filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    } finally {
      await handle.close();
    }
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
  /** The environment Git inherits (the process's own by default). */
  env?: Record<string, string | undefined>;
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

function firstLine(text: string): string {
  const end = text.search(/\r?\n/);
  return end >= 0 ? text.slice(0, end) : text;
}

/** Cut a string to at most `maxBytes` UTF-8 bytes. */
function cutToBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  // A cut inside one character decodes as the replacement character, which
  // is never longer than the bytes it replaces.
  return bytes.subarray(0, maxBytes).toString("utf8");
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

function gitFailure(args: readonly string[], run: GitRunResult): Error {
  const subcommand = args.find((word, index) =>
    !word.startsWith("-") && args[index - 1] !== "-c",
  );
  const detail = firstLine(run.stderr.trim()).slice(0, 160);
  return new Error(
    `git ${subcommand ?? "command"} exited ${String(run.code)}${detail ? `: ${detail}` : ""}`,
  );
}

function isMissingGit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
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
 * could not survive is THROWN, and the handler answers `read_failed`.
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
  const env = {
    ...(input.env ?? process.env),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
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
    const text = cutToBytes(run.stdout, maxBytes);
    const truncated = run.truncated || text !== run.stdout;
    if (!truncated && run.code !== 0) throw gitFailure(args, run);
    return { text, truncated };
  };

  let top: GitRunResult;
  try {
    top = await git(GIT_TOPLEVEL, input.workdir, SMALL_OUTPUT_MAX);
  } catch (error) {
    if (isMissingGit(error)) {
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
  const root = firstLine(top.stdout).replace(/[\\/]+$/, "");
  if (!root) throw new Error("git rev-parse printed no folder");
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
    out.push(await readOne(`${root}/${name}`, name, caps, fs));
  }
  return out;
}

async function readOne(
  full: string,
  name: string,
  caps: ChangesCaps,
  fs: ChangesFs,
): Promise<UntrackedFileEntry> {
  let stat: { isFile(): boolean; size: number };
  try {
    stat = await fs.lstat(full);
  } catch {
    // Gone since Git listed it: named, never drawn.
    return { path: name, bytes: 0 };
  }
  const size = wholeBytes(stat.size);
  if (!stat.isFile()) return { path: name, bytes: size, binary: true };
  if (size > caps.maxUntrackedTextBytes) return { path: name, bytes: size };
  let data: Uint8Array;
  try {
    data = await fs.readPrefix(full, caps.maxUntrackedTextBytes + 1);
  } catch {
    return { path: name, bytes: size };
  }
  if (data.length > caps.maxUntrackedTextBytes) {
    // It grew past the cap since the lstat.
    return { path: name, bytes: Math.max(size, data.length) };
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { path: name, bytes: bytes.length, binary: true };
  }
  return { path: name, bytes: bytes.length, text: bytes.toString("utf8") };
}
