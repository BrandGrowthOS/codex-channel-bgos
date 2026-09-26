/**
 * The Changes panel's collector (P7 stage 3, C-31, spec 9.3 and 10.1).
 *
 * The owner's Changes panel asks this daemon for the agent's uncommitted
 * changes. The daemon is thin on purpose: it runs seven READ ONLY Git
 * commands in the working folder, stops reading at the frame's byte caps,
 * reads at most 20 small new files, and sends the raw output. The backend
 * splits, counts, masks and cuts (backend/src/changes-panel/changes-view.ts),
 * so none of that is tested here.
 *
 * Most cases drive `collectChanges` over a scripted fake `runGit` that records
 * every argv, folder and environment, and an in memory file system. The node
 * adapter (the stream cap, the kill, a missing Git) is driven against real
 * child processes, and one block runs the whole collector against a real Git
 * repository, because a host's own Git config (diff.noprefix,
 * diff.mnemonicPrefix) is exactly the thing a fake cannot show.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  collectChanges,
  createFindGit,
  createNodeRunGit,
  nodeChangesFs,
  readCaps,
  type ChangesFs,
  type GitRunOptions,
  type GitRunResult,
  type RunGit,
} from "../src/git-changes.js";

// ---------------------------------------------------------------------------
// the commands, written out whole (never imported from the code under test)
// ---------------------------------------------------------------------------

// -c core.fsmonitor=false first on EVERY command: a core.fsmonitor the
// repository's own config names is a program Git runs on a read (both diffs
// and ls-files ran one on Git 2.55.0.windows.3), and the agent writes that
// config (fix round w4, F1).
const TOPLEVEL = ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"];
const VERIFY_HEAD = [
  "-c",
  "core.fsmonitor=false",
  "rev-parse",
  "--verify",
  "--quiet",
  "HEAD",
];
const BRANCH = [
  "-c",
  "core.fsmonitor=false",
  "symbolic-ref",
  "--quiet",
  "--short",
  "HEAD",
];
const SHORT_HEAD = ["-c", "core.fsmonitor=false", "rev-parse", "--short", "HEAD"];
// -c diff.autoRefreshIndex=false on both diffs: a porcelain `git diff` would
// otherwise refresh .git/index (taking index.lock) when a tracked file has
// only a stat change, and GIT_OPTIONAL_LOCKS=0 does not stop that path
// (review round 1, C-R1).
const NUMSTAT = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.autoRefreshIndex=false",
  "diff",
  "--numstat",
  "-z",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "HEAD",
  "--",
];
// --src-prefix and --dst-prefix: a host whose Git config sets diff.noprefix,
// diff.mnemonicPrefix or diff.srcPrefix would otherwise write headers the
// backend cannot read as a/ and b/ (lane B review, round 1). --submodule=short:
// a host with diff.submodule=log or =diff would otherwise write a moved
// submodule as "Submodule ..." lines with no diff --git header, which the
// backend's splitter would hang on the previous file (review round 1, C-R3).
// The options in spec 10.1 item 7's own order (fix round w4, F9).
const PATCH = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.autoRefreshIndex=false",
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
];
const UNTRACKED = [
  "-c",
  "core.fsmonitor=false",
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
];

const key = (argv: readonly string[]) => argv.join(" ");

/** The frame's numbers (backend CHANGES_FRAME_PAYLOAD), written out. */
const DEFAULT_CAPS = {
  maxPatchBytes: 1_048_576,
  maxNumstatBytes: 262_144,
  maxUntrackedListBytes: 65_536,
  maxUntrackedTextFiles: 20,
  maxUntrackedTextBytes: 65_536,
  budgetMs: 10_000,
};

const ROOT = "/home/owner/billing-export";
const WORKDIR = "/home/owner/billing-export/services/billing";
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type Reply =
  | { code?: number; stdout?: string; stderr?: string }
  | Error
  | "hang"
  | "hang-deaf";

interface Call {
  args: string[];
  cwd: string;
  env: GitRunOptions["env"];
  maxBytes: number;
  signal: AbortSignal;
}

/**
 * A scripted Git. It honours `maxBytes` the way the node adapter does (it
 * cuts and says so), records every call, and rejects an argv it was not
 * given, so an extra command fails the case loudly.
 */
function fakeGit(script: Record<string, Reply>) {
  const calls: Call[] = [];
  const runGit: RunGit = (args, options) => {
    calls.push({ args: [...args], ...options });
    const reply = script[key(args)];
    if (reply === undefined) {
      return Promise.reject(new Error(`unscripted git ${key(args)}`));
    }
    if (reply instanceof Error) return Promise.reject(reply);
    if (reply === "hang") {
      return new Promise<GitRunResult>((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new Error("killed")),
        );
      });
    }
    if (reply === "hang-deaf") return new Promise<GitRunResult>(() => {});
    const out = Buffer.from(reply.stdout ?? "", "utf8");
    const truncated = out.length > options.maxBytes;
    return Promise.resolve({
      code: truncated ? null : (reply.code ?? 0),
      stdout: out.subarray(0, options.maxBytes).toString("utf8"),
      stderr: reply.stderr ?? "",
      truncated,
    });
  };
  return { runGit, calls };
}

interface MemFile {
  data?: Uint8Array;
  size?: number;
  symlink?: boolean;
  /** A folder (parity round 2): lstat says it is not a file. */
  dir?: boolean;
  /** The file id lstat reports; 0 is a host that reports none. Default: one
   * per name. */
  ino?: number;
  /** What a handle finds at the open when the name changed after the lstat
   * (parity round, D-R3): another file, a link followed, or a device. */
  open?: { data: Uint8Array; ino: number; isFile: boolean };
}

function memoryFs(files: Record<string, MemFile>) {
  const lstatCalls: string[] = [];
  const readCalls: string[] = [];
  /** The maxBytes of each readAtMost. */
  const askedFor: number[] = [];
  /** Calls of the old whole name read (readPrefix): a TRAP, it answers the
   * way a plain open would, and must never be used. */
  const trapCalls: string[] = [];
  const names = Object.keys(files);
  const inoOf = (path: string) => files[path]?.ino ?? 1_000 + names.indexOf(path);
  const at = (path: string): MemFile => {
    const file = files[path];
    if (!file) {
      throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    }
    return file;
  };
  /** What an open of the name reaches now. */
  const opened = (path: string, file: MemFile) =>
    file.open ?? {
      data: file.data,
      ino: inoOf(path),
      isFile: file.symlink !== true && file.dir !== true,
    };
  const fs = {
    async lstat(path: string) {
      lstatCalls.push(path);
      const file = at(path);
      return {
        isFile: () => file.symlink !== true && file.dir !== true,
        size: file.size ?? file.data?.length ?? 0,
        ino: inoOf(path),
        dev: 7,
      };
    },
    async readAtMost(path: string, maxBytes: number) {
      readCalls.push(path);
      askedFor.push(maxBytes);
      const handle = opened(path, at(path));
      if (!handle.data) throw new Error(`cannot read ${path}`);
      return {
        stat: {
          isFile: () => handle.isFile,
          size: handle.data.length,
          ino: handle.ino,
          dev: 7,
        },
        data: handle.data.subarray(0, maxBytes),
      };
    },
    async readPrefix(path: string, limit: number) {
      readCalls.push(path);
      trapCalls.push(path);
      const handle = opened(path, at(path));
      if (!handle.data) throw new Error(`cannot read ${path}`);
      return handle.data.subarray(0, limit);
    },
  } as unknown as ChangesFs;
  return { fs, lstatCalls, readCalls, askedFor, trapCalls };
}

const PATCH_TEXT =
  "diff --git a/services/billing/export.py b/services/billing/export.py\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/services/billing/export.py\n" +
  "+++ b/services/billing/export.py\n" +
  "@@ -1 +1 @@\n" +
  "-old\n" +
  "+new\n";

function okScript(extra: Record<string, Reply> = {}): Record<string, Reply> {
  return {
    [key(TOPLEVEL)]: { stdout: `${ROOT}\n` },
    [key(VERIFY_HEAD)]: {
      stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n",
    },
    [key(BRANCH)]: { stdout: "fix/export-dupes\n" },
    [key(SHORT_HEAD)]: { stdout: "4b825dc\n" },
    [key(NUMSTAT)]: { stdout: "1\t1\tservices/billing/export.py\0" },
    [key(PATCH)]: { stdout: PATCH_TEXT },
    [key(UNTRACKED)]: { stdout: "notes/todo.md\0" },
    ...extra,
  };
}

const TODO = Buffer.from("- ship it\n", "utf8");

function okFs() {
  return memoryFs({ [`${ROOT}/notes/todo.md`]: { data: TODO } });
}

const FIXED_NOW = () => Date.parse("2026-09-26T09:00:00.000Z");

/** Where Git for Windows puts its launcher, written out. */
const GIT_EXE = "C:\\Program Files\\Git\\cmd\\git.exe";

/**
 * A spawn that starts no process: it records the command it is handed and
 * answers each argv from `script` the way a Git child would (stdout, then
 * close with the exit code). An argv it was not given exits 99.
 */
function recordingSpawn(script: Record<string, Reply>) {
  const commands: string[] = [];
  const spawnImpl = ((command: string, args: string[]) => {
    commands.push(command);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const reply = script[key(args)];
    setImmediate(() => {
      const scripted =
        reply && typeof reply === "object" && !(reply instanceof Error)
          ? reply
          : { code: 99, stderr: `unscripted git ${key(args)}\n` };
      child.stdout.end(scripted.stdout ?? "");
      child.stderr.end(scripted.stderr ?? "");
      setImmediate(() => child.emit("close", scripted.code ?? 0));
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, commands };
}

// ---------------------------------------------------------------------------
// the collector
// ---------------------------------------------------------------------------

describe("collectChanges", () => {
  it("a folder that is not a repository answers not_git with its basename", async () => {
    const { runGit, calls } = fakeGit({
      [key(TOPLEVEL)]: {
        code: 128,
        stderr:
          "fatal: not a git repository (or any of the parent directories): .git\n",
      },
    });
    const { fs } = memoryFs({});
    const result = await collectChanges({
      workdir: "/home/owner/notes",
      caps: readCaps({}),
      runGit,
      fs,
      now: FIXED_NOW,
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        v: 1,
        state: "not_git",
        folder: "notes",
        branch: null,
        head: null,
        numstat: "",
        numstatTruncated: false,
        patch: "",
        patchTruncated: false,
        untracked: "",
        untrackedTruncated: false,
        untrackedFiles: [],
        takenAt: "2026-09-26T09:00:00.000Z",
      },
    });
    expect(calls.map((c) => c.args)).toEqual([TOPLEVEL]);
  });

  it("Git missing answers git_missing", async () => {
    const missing = Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
    });
    const { runGit } = fakeGit({ [key(TOPLEVEL)]: missing });
    const result = await collectChanges({
      workdir: WORKDIR,
      caps: readCaps({}),
      runGit,
      // The working folder is there (parity round 2: ENOENT is Git missing
      // only while it is).
      fs: memoryFs({ [WORKDIR]: { dir: true } }).fs,
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.state).toBe("git_missing");
    expect(result.payload.folder).toBe("billing");
    expect(result.payload.patch).toBe("");
    expect(result.payload.untrackedFiles).toEqual([]);

    // And the real node adapter says ENOENT for a binary that is not there.
    const real = createNodeRunGit({ bin: "bgos-no-such-git-binary-p7s3" });
    const viaAdapter = await collectChanges({
      workdir: process.cwd(),
      caps: readCaps({}),
      runGit: real,
      fs: nodeChangesFs,
    });
    expect(viaAdapter.ok && viaAdapter.payload.state).toBe("git_missing");
  });

  // Parity round 2 (lane D's collector): node reports a spawn whose working
  // folder does not exist as ENOENT, the same code as a missing Git. An agent
  // whose folder was removed while the daemon ran must not tell the owner
  // that Git is not installed.
  it("a working folder that is gone, or is a file, is a failed read, never Git missing", async () => {
    const missing = Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
    });
    for (const [label, files] of [
      ["gone", {}],
      ["a file", { [WORKDIR]: { data: Buffer.from("not a folder\n") } }],
    ] as Array<[string, Record<string, MemFile>]>) {
      const { runGit, calls } = fakeGit({ [key(TOPLEVEL)]: missing });
      const { fs, lstatCalls } = memoryFs(files);
      await expect(
        collectChanges({
          workdir: WORKDIR,
          caps: readCaps({}),
          runGit,
          fs,
          now: FIXED_NOW,
        }),
        label,
      ).rejects.toThrow("the working folder is not there");
      expect(calls.map((c) => c.args), label).toEqual([TOPLEVEL]);
      expect(lstatCalls, label).toEqual([WORKDIR]);
    }
  });

  it("real Git: a working folder that is gone is a failed read, never Git missing", async () => {
    // No skip: with Git on PATH or not, a folder that is not there must
    // never read as "Git missing". The real spawn into a missing folder is
    // what says ENOENT here.
    const base = mkdtempSync(join(tmpdir(), "bgos-changes-gone-"));
    try {
      await expect(
        collectChanges({
          workdir: join(base, "gone"),
          caps: readCaps({}),
          runGit: createNodeRunGit(),
          fs: nodeChangesFs,
        }),
      ).rejects.toThrow("the working folder is not there");
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 30_000);

  it("no first commit answers no_commits", async () => {
    const { runGit, calls } = fakeGit({
      [key(TOPLEVEL)]: { stdout: `${ROOT}\n` },
      [key(VERIFY_HEAD)]: { code: 1 },
    });
    const result = await collectChanges({
      workdir: WORKDIR,
      caps: readCaps({}),
      runGit,
      fs: memoryFs({}).fs,
      now: FIXED_NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      state: "no_commits",
      folder: "billing-export",
      branch: null,
      head: null,
      numstat: "",
      patch: "",
      untracked: "",
      untrackedFiles: [],
    });
    expect(calls.map((c) => c.args)).toEqual([TOPLEVEL, VERIFY_HEAD]);
  });

  it("runs exactly the read only commands, in order, the first in the working folder and the rest in the root it printed, with GIT_OPTIONAL_LOCKS=0", async () => {
    const { runGit, calls } = fakeGit(okScript());
    const { fs, lstatCalls, readCalls } = okFs();
    const result = await collectChanges({
      workdir: WORKDIR,
      caps: readCaps({}),
      runGit,
      fs,
      now: FIXED_NOW,
    });

    expect(calls.map((c) => c.args)).toEqual([
      TOPLEVEL,
      VERIFY_HEAD,
      BRANCH,
      SHORT_HEAD,
      NUMSTAT,
      PATCH,
      UNTRACKED,
    ]);
    expect(calls.map((c) => c.cwd)).toEqual([
      WORKDIR,
      ROOT,
      ROOT,
      ROOT,
      ROOT,
      ROOT,
      ROOT,
    ]);
    for (const call of calls) {
      expect(call.env.GIT_OPTIONAL_LOCKS, key(call.args)).toBe("0");
      expect(call.env.GIT_TERMINAL_PROMPT, key(call.args)).toBe("0");
      expect(call.env.LC_ALL, key(call.args)).toBe("C");
    }
    // The three raw reads carry the frame's own caps.
    expect(calls[4]!.maxBytes).toBe(262_144);
    expect(calls[5]!.maxBytes).toBe(1_048_576);
    expect(calls[6]!.maxBytes).toBe(65_536);
    // The new file is read under the ROOT, where its name is relative to.
    expect(lstatCalls).toEqual([`${ROOT}/notes/todo.md`]);
    expect(readCalls).toEqual([`${ROOT}/notes/todo.md`]);

    expect(result).toEqual({
      ok: true,
      payload: {
        v: 1,
        state: "ok",
        folder: "billing-export",
        branch: "fix/export-dupes",
        head: "4b825dc",
        numstat: "1\t1\tservices/billing/export.py\0",
        numstatTruncated: false,
        patch: PATCH_TEXT,
        patchTruncated: false,
        untracked: "notes/todo.md\0",
        untrackedTruncated: false,
        untrackedFiles: [
          { path: "notes/todo.md", bytes: TODO.length, text: "- ship it\n" },
        ],
        takenAt: "2026-09-26T09:00:00.000Z",
      },
    });
  });

  // Parity round 2 (lane D's collector): a daemon started from inside a Git
  // hook, or from a shell with GIT_DIR exported, would otherwise read THAT
  // repository or index whatever folder the read runs in.
  it("drops every variable that points Git at another repository or index, passes the rest through, and leaves the daemon's own environment alone", async () => {
    const daemonEnv: Record<string, string | undefined> = {
      PATH: "/usr/local/bin:/usr/bin",
      GIT_CONFIG_GLOBAL: "/home/owner/.gitconfig",
      GIT_DIR: "/home/owner/other/.git",
      GIT_WORK_TREE: "/home/owner/other",
      GIT_INDEX_FILE: "/home/owner/other/.git/index",
      GIT_COMMON_DIR: "/home/owner/other/.git",
      GIT_OBJECT_DIRECTORY: "/home/owner/other/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/home/owner/shared/objects",
      GIT_NAMESPACE: "elsewhere",
      GIT_PREFIX: "services/",
    };
    const given = { ...daemonEnv };
    const { runGit, calls } = fakeGit(okScript());
    const result = await collectChanges({
      workdir: WORKDIR,
      caps: readCaps({}),
      runGit,
      fs: okFs().fs,
      now: FIXED_NOW,
      env: daemonEnv,
    });
    expect(result.ok && result.payload.state).toBe("ok");
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call.env, key(call.args)).toEqual({
        PATH: "/usr/local/bin:/usr/bin",
        GIT_CONFIG_GLOBAL: "/home/owner/.gitconfig",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      });
    }
    expect(daemonEnv, "the daemon's own environment is left as it was").toEqual(
      given,
    );
  });

  it("a detached HEAD answers branch null and keeps the short head", async () => {
    const { runGit } = fakeGit(okScript({ [key(BRANCH)]: { code: 1 } }));
    const result = await collectChanges({
      workdir: ROOT,
      caps: readCaps({}),
      runGit,
      fs: okFs().fs,
    });
    expect(result.ok && result.payload.branch).toBe(null);
    expect(result.ok && result.payload.head).toBe("4b825dc");
  });

  it("never runs anything that writes", async () => {
    const WRITES = [
      "add",
      "status",
      "checkout",
      "reset",
      "stash",
      "commit",
      "update-index",
    ];
    const READS = ["rev-parse", "symbolic-ref", "diff", "ls-files"];
    const scenarios: Array<Record<string, Reply>> = [
      okScript(),
      okScript({ [key(BRANCH)]: { code: 1 } }),
      { [key(TOPLEVEL)]: { stdout: `${ROOT}\n` }, [key(VERIFY_HEAD)]: { code: 1 } },
      {
        [key(TOPLEVEL)]: {
          code: 128,
          stderr: "fatal: not a git repository\n",
        },
      },
    ];
    for (const script of scenarios) {
      const { runGit, calls } = fakeGit(script);
      await collectChanges({
        workdir: WORKDIR,
        caps: readCaps({}),
        runGit,
        fs: okFs().fs,
      }).catch(() => undefined);
      for (const call of calls) {
        for (const word of WRITES) {
          expect(call.args, key(call.args)).not.toContain(word);
        }
        expect(call.args, key(call.args)).not.toContain("-N");
        // The subcommand is the first word that is not a global option.
        const words = [...call.args];
        while (words[0] === "-c" || words[0] === "--no-pager") {
          words.splice(0, words[0] === "-c" ? 2 : 1);
        }
        expect(READS, key(call.args)).toContain(words[0]);
        // Every read turns off a fsmonitor the repository's config names,
        // before the subcommand (fix round w4, F1).
        expect(call.args.slice(0, 2), key(call.args)).toEqual([
          "-c",
          "core.fsmonitor=false",
        ]);
        // A porcelain diff refreshes the index unless told not to.
        if (words[0] === "diff") {
          const at = call.args.indexOf("diff.autoRefreshIndex=false");
          expect(at, key(call.args)).toBeGreaterThan(0);
          expect(call.args[at - 1], key(call.args)).toBe("-c");
        }
      }
    }

    // And no write subcommand is spelled anywhere in the collector's source.
    const source = readFileSync("src/git-changes.ts", "utf8");
    const literals = [...source.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
    for (const word of WRITES) {
      expect(literals, word).not.toContain(word);
    }
  });

  it("stops reading at the byte cap, says it was cut, and kills the child", async () => {
    // The node adapter over a REAL child: 3 MB on stdout, then twenty idle
    // seconds, so only a kill can end it in time.
    const children: ChildProcess[] = [];
    const spawnImpl = ((command: string, args: string[], options: object) => {
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    }) as unknown as typeof spawn;
    const adapter = createNodeRunGit({ bin: process.execPath, spawnImpl });
    const script =
      "const b=Buffer.alloc(65536,120);let n=0;" +
      "(function w(){while(n<48){n++;if(!process.stdout.write(b)){process.stdout.once('drain',w);return;}}" +
      "setTimeout(()=>{},20000);})();";
    const started = Date.now();
    const run = await adapter(["-e", script], {
      cwd: process.cwd(),
      env: process.env,
      maxBytes: 1_048_576,
      signal: new AbortController().signal,
    });
    expect(run.truncated).toBe(true);
    expect(Buffer.byteLength(run.stdout, "utf8")).toBe(1_048_576);
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);

    // And the collector hands the frame's cap to the read and says it was cut.
    const big = "+" + "x".repeat(3 * 1_048_576) + "\n";
    const { runGit, calls } = fakeGit(
      okScript({ [key(PATCH)]: { stdout: PATCH_TEXT + big } }),
    );
    const result = await collectChanges({
      workdir: ROOT,
      caps: readCaps({ maxPatchBytes: 1_048_576 }),
      runGit,
      fs: okFs().fs,
    });
    expect(calls.find((c) => key(c.args) === key(PATCH))!.maxBytes).toBe(
      1_048_576,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.byteLength(result.payload.patch, "utf8")).toBeLessThanOrEqual(
      1_048_576,
    );
    expect(result.payload.patchTruncated).toBe(true);
    expect(result.payload.numstatTruncated).toBe(false);
  }, 15_000);

  it("a cut read settles at the cap, without waiting for the child to close", async () => {
    // On Windows, Git's cmd\git.exe is a launcher: a grandchild can keep the
    // pipes open after the kill, so waiting for "close" could let the budget
    // turn a good cut read into too_slow. A child that never closes:
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    // The adapter looks Git up before it spawns (parity round, D-R2), so the
    // child writes only once it has been started, as a real one would.
    let started!: () => void;
    const spawned = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = createNodeRunGit({
      spawnImpl: (() => {
        started();
        return child;
      }) as unknown as typeof spawn,
      // The environment below has no PATH; the lookup names Git outright.
      findGit: async () => GIT_EXE,
    } as Parameters<typeof createNodeRunGit>[0]);
    const pending = adapter(PATCH, {
      cwd: ROOT,
      env: {},
      maxBytes: 1_024,
      signal: new AbortController().signal,
    });
    await spawned;
    child.stderr.write("warning: something\n");
    child.stdout.write(Buffer.alloc(4_096, 0x78));
    const run = await pending;
    expect(run).toEqual({
      code: null,
      stdout: "x".repeat(1_024),
      stderr: "warning: something\n",
      truncated: true,
    });
    expect(child.kill).toHaveBeenCalled();
  });

  // Parity round, D-R2 (lane D's review): spawn("git", { cwd }) on Windows
  // looks in the child's working folder BEFORE PATH (libuv's search_path),
  // and a relative PATH entry does the same anywhere. The agent writes that
  // folder, so a git.exe it left there would run as the owner each time the
  // owner opened the panel.
  it("the node adapter runs the Git that PATH names by its absolute path, never a bare git a folder could answer", async () => {
    const { spawnImpl, commands } = recordingSpawn(okScript());
    const lookups: Array<Record<string, string | undefined>> = [];
    const runGit = createNodeRunGit({
      spawnImpl,
      findGit: async (env: Record<string, string | undefined>) => {
        lookups.push(env);
        return GIT_EXE;
      },
    } as Parameters<typeof createNodeRunGit>[0]);
    const result = await collectChanges({
      workdir: WORKDIR,
      caps: readCaps({}),
      runGit,
      fs: okFs().fs,
      env: { Path: "C:\\Program Files\\Git\\cmd" },
    });
    expect(result.ok && result.payload.state).toBe("ok");
    expect(
      commands,
      "every command runs the absolute path, never a bare name the working folder could answer",
    ).toEqual(Array.from({ length: 7 }, () => GIT_EXE));
    expect(lookups, "PATH is looked up once per read").toHaveLength(1);
    // With the environment Git itself gets.
    expect(lookups[0]).toMatchObject({
      Path: "C:\\Program Files\\Git\\cmd",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("a PATH with no Git answers git_missing and starts nothing", async () => {
    const { spawnImpl, commands } = recordingSpawn(okScript());
    const runGit = createNodeRunGit({
      spawnImpl,
      findGit: async () => null,
    } as Parameters<typeof createNodeRunGit>[0]);
    const result = await collectChanges({
      workdir: WORKDIR,
      caps: readCaps({}),
      runGit,
      // The working folder is there (parity round 2).
      fs: memoryFs({ [WORKDIR]: { dir: true } }).fs,
      now: FIXED_NOW,
    });
    expect(result).toEqual({
      ok: true,
      payload: {
        v: 1,
        state: "git_missing",
        folder: "billing",
        branch: null,
        head: null,
        numstat: "",
        numstatTruncated: false,
        patch: "",
        patchTruncated: false,
        untracked: "",
        untrackedTruncated: false,
        untrackedFiles: [],
        takenAt: "2026-09-26T09:00:00.000Z",
      },
    });
    expect(commands).toEqual([]);
  });

  it("never sends more than the cap, even when a read hands back more", async () => {
    // A runGit that ignores maxBytes (a future adapter bug) still cannot push
    // the answer past the frame's cap, which the backend would refuse whole.
    const over: RunGit = async (args) => {
      if (key(args) === key(PATCH)) {
        return {
          code: 0,
          stdout: "y".repeat(5_000),
          stderr: "",
          truncated: false,
        };
      }
      return fakeGit(okScript()).runGit(args, {
        cwd: ROOT,
        env: {},
        maxBytes: 1_048_576,
        signal: new AbortController().signal,
      });
    };
    const result = await collectChanges({
      workdir: ROOT,
      caps: readCaps({ maxPatchBytes: 4_096 }),
      runGit: over,
      fs: okFs().fs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.patch.length).toBe(4_096);
    expect(result.payload.patchTruncated).toBe(true);

    // The fence counts what the backend counts (UTF-16 units), and never
    // leaves half of a surrogate pair at the cut.
    const face = String.fromCodePoint(0x1f600);
    const pairs: RunGit = async (args, options) =>
      key(args) === key(PATCH)
        ? { code: 0, stdout: face.repeat(3_000), stderr: "", truncated: false }
        : fakeGit(okScript()).runGit(args, options);
    const cut = await collectChanges({
      workdir: ROOT,
      caps: readCaps({ maxPatchBytes: 4_095 }),
      runGit: pairs,
      fs: okFs().fs,
    });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.payload.patch).toBe(face.repeat(2_047));
    expect(cut.payload.patchTruncated).toBe(true);
  });

  it("a complete read under the cap is sent whole, even when its bytes are not UTF-8", async () => {
    // A legacy Latin-1 file: every accented byte decodes as one U+FFFD,
    // which is 3 bytes if the text were encoded again. The read itself fits
    // the cap, so nothing may be cut or called cut (review round 1, C-R5).
    const raw = Buffer.concat([
      Buffer.from(
        "diff --git a/legacy.txt b/legacy.txt\n" +
          "index 1111111..2222222 100644\n" +
          "--- a/legacy.txt\n" +
          "+++ b/legacy.txt\n" +
          "@@ -1 +1 @@\n" +
          "-old\n" +
          "+",
        "utf8",
      ),
      Buffer.from("caf\u00e9 ".repeat(1_500), "latin1"),
      Buffer.from("\n", "utf8"),
    ]);
    const cap = 8_192;
    expect(raw.length).toBeLessThanOrEqual(cap);
    expect(Buffer.byteLength(raw.toString("utf8"), "utf8")).toBeGreaterThan(cap);

    // The patch comes through the REAL node adapter, from a child that
    // writes those bytes, so the decode is the adapter's own.
    const adapter = createNodeRunGit({ bin: process.execPath });
    const scripted = fakeGit(okScript());
    const runGit: RunGit = (args, options) =>
      key(args) === key(PATCH)
        ? adapter(
            [
              "-e",
              `process.stdout.write(Buffer.from("${raw.toString("base64")}","base64"))`,
            ],
            // The scripted root is not on this disk; the child runs here.
            { ...options, cwd: process.cwd() },
          )
        : scripted.runGit(args, options);
    const result = await collectChanges({
      workdir: ROOT,
      caps: readCaps({ maxPatchBytes: cap }),
      runGit,
      fs: okFs().fs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.patchTruncated).toBe(false);
    expect(result.payload.patch).toBe(raw.toString("utf8"));
    // What the backend checks: the string's length against the frame's cap.
    expect(result.payload.patch.length).toBeLessThanOrEqual(cap);
  }, 15_000);

  it("reads the first 20 untracked regular files: text, binary by a NUL, too large by size, a symlink as binary", async () => {
    const names = [
      "a-new.txt",
      "logo.png",
      "dump.log",
      "latest",
      ...Array.from({ length: 16 }, (_, i) => `n${i + 1}.md`),
      "twenty-one.md",
      "twenty-two.md",
    ];
    const withNul = Buffer.alloc(9_000, 0x61);
    withNul[100] = 0;
    const lateNul = Buffer.alloc(9_000, 0x62);
    lateNul[8_500] = 0;
    const files: Record<string, MemFile> = {
      [`${ROOT}/a-new.txt`]: { data: Buffer.from("hello\nworld", "utf8") },
      [`${ROOT}/logo.png`]: { data: withNul },
      [`${ROOT}/dump.log`]: { size: 70_000 },
      [`${ROOT}/latest`]: { symlink: true, size: 12 },
      [`${ROOT}/twenty-one.md`]: { data: Buffer.from("21\n") },
      [`${ROOT}/twenty-two.md`]: { data: Buffer.from("22\n") },
    };
    for (let i = 1; i <= 16; i += 1) {
      files[`${ROOT}/n${i}.md`] = {
        data: i === 1 ? lateNul : Buffer.from(`note ${i}\n`),
      };
    }
    const { runGit } = fakeGit(
      okScript({ [key(UNTRACKED)]: { stdout: names.join("\0") + "\0" } }),
    );
    const { fs, lstatCalls, readCalls } = memoryFs(files);
    const result = await collectChanges({
      workdir: ROOT,
      caps: readCaps({}),
      runGit,
      fs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = result.payload.untrackedFiles;
    expect(entries).toHaveLength(20);
    expect(entries.map((e) => e.path)).toEqual(names.slice(0, 20));
    expect(entries[0]).toEqual({
      path: "a-new.txt",
      bytes: 11,
      text: "hello\nworld",
    });
    expect(entries[1]).toEqual({ path: "logo.png", bytes: 9_000, binary: true });
    expect(entries[2]).toEqual({ path: "dump.log", bytes: 70_000 });
    expect(entries[3]).toEqual({ path: "latest", bytes: 12, binary: true });
    // A NUL past the first 8,000 bytes does not make a file binary.
    expect(entries[4]!.text).toBe(lateNul.toString("utf8"));
    expect(entries[5]).toEqual({ path: "n2.md", bytes: 7, text: "note 2\n" });
    // The too large file and the symlink are never opened; the 21st and 22nd
    // names are never touched at all.
    expect(readCalls).not.toContain(`${ROOT}/dump.log`);
    expect(readCalls).not.toContain(`${ROOT}/latest`);
    expect(lstatCalls).not.toContain(`${ROOT}/twenty-one.md`);
    expect(lstatCalls).not.toContain(`${ROOT}/twenty-two.md`);
    // The whole list still goes to the backend, which names the rest.
    expect(result.payload.untracked).toBe(names.join("\0") + "\0");
  });

  it("reads no half name the list cap cut", async () => {
    const whole = "kept.md\0";
    const cut = "cut-in-the-middle-of-its-name.md\0";
    const { runGit } = fakeGit(
      okScript({ [key(UNTRACKED)]: { stdout: whole + cut } }),
    );
    const { fs, lstatCalls } = memoryFs({
      [`${ROOT}/kept.md`]: { data: Buffer.from("k\n") },
    });
    const result = await collectChanges({
      workdir: ROOT,
      caps: readCaps({ maxUntrackedListBytes: whole.length + 5 }),
      runGit,
      fs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.untrackedTruncated).toBe(true);
    expect(result.payload.untrackedFiles.map((e) => e.path)).toEqual([
      "kept.md",
    ]);
    expect(lstatCalls).toEqual([`${ROOT}/kept.md`]);
  });

  // Parity round, D-R3 (lane D's review): an lstat and then a second open of
  // the same NAME can reach another file. The read is one handle, at most the
  // text cap and one byte, and only while it is still the regular file the
  // lstat saw (Windows has no O_NOFOLLOW, so the file id is what tells).
  it("a file that changes between its check and its read is read through one handle, never past the text cap, and never through a name swapped in", async () => {
    const names = ["grows.log", "swapped.txt", "fifo", "steady.md"];
    const forty = Buffer.alloc(40, 0x61);
    const { runGit } = fakeGit(
      okScript({ [key(UNTRACKED)]: { stdout: names.join("\0") + "\0" } }),
    );
    const { fs, askedFor, trapCalls } = memoryFs({
      // 40 bytes at the lstat, 500,000 by the read: the same file, grown.
      [`${ROOT}/grows.log`]: {
        data: forty,
        ino: 21,
        open: { data: Buffer.alloc(500_000, 0x62), ino: 21, isFile: true },
      },
      // A regular file at the lstat, then a link put in its place and
      // followed on a host with no O_NOFOLLOW: another file id at the read.
      [`${ROOT}/swapped.txt`]: {
        data: forty,
        ino: 22,
        open: {
          data: Buffer.from("the target of a link put in its place\n", "utf8"),
          ino: 99,
          isFile: true,
        },
      },
      // A host that reports no file id, and a device at the read: only the
      // handle's kind tells.
      [`${ROOT}/fifo`]: {
        data: forty,
        ino: 0,
        open: { data: Buffer.alloc(200_000, 0x63), ino: 0, isFile: false },
      },
      [`${ROOT}/steady.md`]: { data: Buffer.from("steady\n", "utf8"), ino: 24 },
    });
    const result = await collectChanges({
      workdir: ROOT,
      caps: readCaps({}),
      runGit,
      fs,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.untrackedFiles).toEqual([
      { path: "grows.log", bytes: 500_000 },
      { path: "swapped.txt", bytes: 40 },
      { path: "fifo", bytes: 40 },
      { path: "steady.md", bytes: 7, text: "steady\n" },
    ]);
    expect(trapCalls, "no whole name read").toEqual([]);
    expect(askedFor, "each read asks for the text cap and one byte, no more").toEqual([
      65_537, 65_537, 65_537, 65_537,
    ]);
  });

  it("the node read opens one handle and reads at most what it is asked for, from the same file lstat saw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bgos-changes-read-"));
    try {
      const big = join(dir, "big.log");
      const bytes = Buffer.alloc(200_000);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = 0x61 + (i % 26);
      writeFileSync(big, bytes);
      const fs = nodeChangesFs as unknown as {
        lstat(path: string): Promise<{ ino: number; dev: number }>;
        readAtMost(
          path: string,
          maxBytes: number,
        ): Promise<{
          stat: { isFile(): boolean; size: number; ino: number; dev: number };
          data: Uint8Array;
        }>;
      };
      const seen = await fs.lstat(big);
      const read = await fs.readAtMost(big, 1_000);
      expect(read.data.length, "at most what was asked for").toBe(1_000);
      expect(Buffer.from(read.data).equals(bytes.subarray(0, 1_000))).toBe(true);
      expect(read.stat.isFile()).toBe(true);
      expect(read.stat.size).toBe(200_000);
      // The handle's id is the lstat's on this host, so the check is live.
      expect(seen.ino).toBeGreaterThan(0);
      expect(read.stat.ino).toBe(seen.ino);
      expect(read.stat.dev).toBe(seen.dev);

      const small = join(dir, "small.md");
      writeFileSync(small, "hi\n");
      const whole = await fs.readAtMost(small, 65_537);
      expect(Buffer.from(whole.data).toString("utf8")).toBe("hi\n");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it.skipIf(process.platform === "win32")(
    "the node read refuses a symlink, where the host has O_NOFOLLOW",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bgos-changes-link-"));
      try {
        writeFileSync(join(dir, "target.txt"), "secret\n");
        symlinkSync(join(dir, "target.txt"), join(dir, "link.txt"));
        const fs = nodeChangesFs as unknown as {
          readAtMost(path: string, maxBytes: number): Promise<unknown>;
        };
        await expect(fs.readAtMost(join(dir, "link.txt"), 65_537)).rejects.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  );

  it("takes caps from the frame, never above the defaults", () => {
    expect(readCaps({})).toEqual(DEFAULT_CAPS);
    expect(readCaps(undefined)).toEqual(DEFAULT_CAPS);
    expect(readCaps(null)).toEqual(DEFAULT_CAPS);
    expect(readCaps({ maxPatchBytes: 999_999_999 }).maxPatchBytes).toBe(
      1_048_576,
    );
    expect(readCaps({ budgetMs: 60_000 }).budgetMs).toBe(10_000);
    expect(readCaps({ maxUntrackedTextFiles: 500 }).maxUntrackedTextFiles).toBe(
      20,
    );
    // A smaller positive whole number is honoured.
    expect(
      readCaps({ maxPatchBytes: 4_096, budgetMs: 500, maxUntrackedTextFiles: 3 }),
    ).toEqual({
      ...DEFAULT_CAPS,
      maxPatchBytes: 4_096,
      budgetMs: 500,
      maxUntrackedTextFiles: 3,
    });
    // Anything that is not a positive whole number is the default.
    for (const bad of [0, -1, 2.5, "4096", Number.NaN, Infinity, null, true]) {
      expect(readCaps({ maxNumstatBytes: bad }).maxNumstatBytes, String(bad)).toBe(
        262_144,
      );
    }
  });

  it("past the budget it answers too_slow", async () => {
    // A read that hangs until it is killed: the collector kills it.
    const hanging = fakeGit(okScript({ [key(PATCH)]: "hang" }));
    const started = Date.now();
    const result = await collectChanges({
      workdir: ROOT,
      caps: readCaps({ budgetMs: 60 }),
      runGit: hanging.runGit,
      fs: okFs().fs,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("too_slow");
    expect(result.error.message.length).toBeGreaterThan(0);
    expect(result.error.message).not.toMatch(new RegExp(`[${EN_DASH}${EM_DASH}]`));
    expect(hanging.calls.at(-1)!.signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);

    // A read that never answers at all, not even to its signal.
    const deaf = fakeGit(okScript({ [key(NUMSTAT)]: "hang-deaf" }));
    const deafResult = await collectChanges({
      workdir: ROOT,
      caps: readCaps({ budgetMs: 60 }),
      runGit: deaf.runGit,
      fs: okFs().fs,
    });
    expect(deafResult.ok === false && deafResult.error.code).toBe("too_slow");

    // And the node adapter kills a real child when the budget runs out.
    const children: ChildProcess[] = [];
    const spawnImpl = ((command: string, args: string[], options: object) => {
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    }) as unknown as typeof spawn;
    const adapter = createNodeRunGit({ bin: process.execPath, spawnImpl });
    const controller = new AbortController();
    const killedAt = Date.now();
    setTimeout(() => controller.abort(), 100);
    await expect(
      adapter(["-e", "setTimeout(()=>{},20000)"], {
        cwd: process.cwd(),
        env: process.env,
        maxBytes: 1_024,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(children[0]!.killed).toBe(true);
    expect(Date.now() - killedAt).toBeLessThan(10_000);
  }, 15_000);

  it("sends the basename, never the absolute path", async () => {
    const { runGit } = fakeGit(okScript());
    const result = await collectChanges({
      workdir: WORKDIR,
      caps: readCaps({}),
      runGit,
      fs: okFs().fs,
    });
    expect(result.ok && result.payload.folder).toBe("billing-export");
    expect(JSON.stringify(result)).not.toContain("/home/owner");

    // A Windows working folder, not a repository, with its own separators.
    const notGit = fakeGit({
      [key(TOPLEVEL)]: { code: 128, stderr: "fatal: not a git repository\n" },
    });
    const windows = await collectChanges({
      workdir: "C:\\Users\\owner\\notes\\",
      caps: readCaps({}),
      runGit: notGit.runGit,
      fs: memoryFs({}).fs,
    });
    expect(windows.ok && windows.payload.folder).toBe("notes");
    expect(JSON.stringify(windows)).not.toContain("Users");

    // A Git root printed with forward slashes on Windows.
    const drive = fakeGit(
      okScript({ [key(TOPLEVEL)]: { stdout: "C:/Users/owner/billing-export\n" } }),
    );
    const onWindows = await collectChanges({
      workdir: "C:\\Users\\owner\\billing-export",
      caps: readCaps({}),
      runGit: drive.runGit,
      fs: memoryFs({
        "C:/Users/owner/billing-export/notes/todo.md": { data: TODO },
      }).fs,
    });
    expect(onWindows.ok && onWindows.payload.folder).toBe("billing-export");
    expect(JSON.stringify(onWindows)).not.toContain("Users");
  });

  it("a repository at a drive root keeps its slash, so Git runs in the root and not in the drive's current folder", async () => {
    const { runGit, calls } = fakeGit(
      okScript({
        [key(TOPLEVEL)]: { stdout: "C:/\n" },
        [key(UNTRACKED)]: { stdout: "notes.md\0" },
      }),
    );
    const { fs, lstatCalls } = memoryFs({
      "C:/notes.md": { data: Buffer.from("n\n") },
    });
    const result = await collectChanges({
      workdir: "C:\\work",
      caps: readCaps({}),
      runGit,
      fs,
    });
    expect(result.ok).toBe(true);
    expect(calls.slice(1).map((c) => c.cwd)).toEqual(Array(6).fill("C:/"));
    expect(lstatCalls).toEqual(["C:/notes.md"]);
  });

  it("a Git command that fails for another reason is thrown, never dressed up as a state", async () => {
    const dubious = fakeGit({
      [key(TOPLEVEL)]: {
        code: 128,
        stderr: "fatal: detected dubious ownership in repository\n",
      },
    });
    await expect(
      collectChanges({
        workdir: WORKDIR,
        caps: readCaps({}),
        runGit: dubious.runGit,
        fs: memoryFs({}).fs,
      }),
    ).rejects.toThrow(/dubious ownership/);

    const broken = fakeGit(okScript({ [key(PATCH)]: { code: 129, stderr: "usage" } }));
    await expect(
      collectChanges({
        workdir: ROOT,
        caps: readCaps({}),
        runGit: broken.runGit,
        fs: okFs().fs,
      }),
    ).rejects.toThrow(/exited 129/);
  });
});

// ---------------------------------------------------------------------------
// against a real Git repository
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// finding Git (parity round, D-R2)
// ---------------------------------------------------------------------------

describe("createFindGit", () => {
  /** A lookup where EVERY candidate "exists" except the ones named absent,
   * so an entry that should never be looked at would win if it were. */
  function lookup(platform: string, absent: string[] = []) {
    const probed: string[] = [];
    const findGit = createFindGit({
      platform,
      isRunnable: async (path: string) => {
        probed.push(path);
        return !absent.includes(path);
      },
    });
    return { findGit, probed };
  }

  it("finds Git on the absolute PATH entries only, in order; an empty or relative entry, which names the folder Git runs in, is never looked at", async () => {
    // Windows, where the variable is spelled Path and read case blind.
    const win = lookup("win32", ["D:\\empty\\git.exe"]);
    const found = await win.findGit({
      Path: [
        ".",
        "",
        "bin",
        "C:tools",
        "\\tools",
        "D:\\empty\\",
        '  "C:\\Program Files\\Git\\cmd"  ',
        "E:\\later",
      ].join(";"),
    });
    expect(found).toBe(GIT_EXE);
    expect(win.probed).toEqual(["D:\\empty\\git.exe", GIT_EXE]);

    // A UNC entry is absolute.
    const unc = lookup("win32");
    expect(await unc.findGit({ PATH: "bin;\\\\server\\share\\git\\cmd" })).toBe(
      "\\\\server\\share\\git\\cmd\\git.exe",
    );
    expect(unc.probed).toEqual(["\\\\server\\share\\git\\cmd\\git.exe"]);

    // Elsewhere: a leading slash, and a runnable file named git.
    const posix = lookup("linux", ["/usr/local/bin/git"]);
    expect(
      await posix.findGit({ PATH: ":.:bin:./tools:/usr/local/bin/:/usr/bin:/bin" }),
    ).toBe("/usr/bin/git");
    expect(posix.probed).toEqual(["/usr/local/bin/git", "/usr/bin/git"]);
  });

  it("only relative entries, or no PATH at all, find nothing and look at nothing", async () => {
    const win = lookup("win32");
    expect(await win.findGit({ Path: ".;bin;C:tools;\\tools" })).toBeNull();
    expect(await win.findGit({})).toBeNull();
    expect(win.probed).toEqual([]);
    const posix = lookup("linux");
    expect(await posix.findGit({ PATH: ".:bin:" })).toBeNull();
    expect(await posix.findGit({})).toBeNull();
    expect(posix.probed).toEqual([]);
  });
});

const gitOnPath = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

describe.skipIf(!gitOnPath)("against a real Git repository", () => {
  const made: string[] = [];
  let repo = "";
  let globalConfig = "";
  let env: Record<string, string | undefined> = {};

  /** One repository with one commit, one edit and one new file, and a
   * tracked file whose content equals HEAD but whose stat moved (see
   * statOnlyChange). The host's own Git config is isolated: each case writes
   * the setting it is about into the isolated GLOBAL config, where an owner
   * usually sets it. */
  beforeAll(() => {
    const home = mkdtempSync(join(tmpdir(), "bgos-changes-home-"));
    made.push(home);
    globalConfig = join(home, "gitconfig");
    writeFileSync(globalConfig, "");
    env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_AUTHOR_NAME: "p7",
      GIT_AUTHOR_EMAIL: "p7@example.test",
      GIT_COMMITTER_NAME: "p7",
      GIT_COMMITTER_EMAIL: "p7@example.test",
    };
    repo = mkdtempSync(join(tmpdir(), "bgos-changes-repo-"));
    made.push(repo);
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: repo, env, windowsHide: true });
      if (run.status !== 0) {
        throw new Error(`setup git ${args.join(" ")}: ${String(run.stderr)}`);
      }
    };
    git("-c", "init.defaultBranch=main", "init", "-q");
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "sub", "keep.txt"), "keep\n");
    git("add", "a.txt", "sub/keep.txt");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "first");
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "new.txt"), "hello\n");
    statOnlyChange();
  }, 60_000);

  afterAll(() => {
    for (const dir of made) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  const indexHash = () =>
    createHash("sha256")
      .update(readFileSync(join(repo, ".git", "index")))
      .digest("hex");

  let statMoves = 0;
  /** Rewrite sub/keep.txt with its own text and move its mtime: the content
   * still equals HEAD and only the stat moved. That is what a revert to the
   * HEAD text, a formatter or an editor save of an unchanged file leaves
   * behind. A porcelain `git diff` then refreshes the index (it takes
   * index.lock and rewrites .git/index) unless diff.autoRefreshIndex is off,
   * and GIT_OPTIONAL_LOCKS=0 does not stop it (review round 1, C-R1). Each
   * call picks a new time, so the index never already holds it. */
  function statOnlyChange(): void {
    const file = join(repo, "sub", "keep.txt");
    writeFileSync(file, "keep\n");
    statMoves += 1;
    const at = new Date(Date.UTC(2020, 0, 1) + statMoves * 86_400_000);
    utimesSync(file, at, at);
  }

  /** One Git command run directly, with the collector's own environment. */
  const runDirect = (argv: string[], cwd = repo) =>
    spawnSync("git", argv, {
      cwd,
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      windowsHide: true,
    });

  /** The same argv without the `-c diff.autoRefreshIndex=false` pair. */
  const withoutAutoRefresh = (argv: string[]) => {
    const at = argv.indexOf("diff.autoRefreshIndex=false");
    return at < 1 ? [...argv] : [...argv.slice(0, at - 1), ...argv.slice(at + 1)];
  };

  /** The same argv without the `-c core.fsmonitor=false` pair (fix round w4). */
  const withoutFsmonitor = (argv: string[]) => {
    const at = argv.indexOf("core.fsmonitor=false");
    return at < 1 ? [...argv] : [...argv.slice(0, at - 1), ...argv.slice(at + 1)];
  };

  /** The same patch WITHOUT the two prefix flags: the control that proves
   * the host setting really bites on this Git. */
  const controlMinusLine = () => {
    const run = runDirect(
      PATCH.filter(
        (word) => !word.startsWith("--src-prefix=") && !word.startsWith("--dst-prefix="),
      ),
    );
    return String(run.stdout)
      .split(/\r?\n/)
      .find((line) => line.startsWith("--- "));
  };

  it("a file with only a stat change leaves the index alone, where a plain porcelain diff rewrites it", async () => {
    writeFileSync(globalConfig, "");
    // The controls: each diff WITHOUT -c diff.autoRefreshIndex=false, under
    // the collector's own environment (GIT_OPTIONAL_LOCKS=0 included),
    // rewrites .git/index on this Git. So the case below can fail.
    for (const argv of [NUMSTAT, PATCH]) {
      statOnlyChange();
      const controlBefore = indexHash();
      const run = runDirect(withoutAutoRefresh(argv));
      expect(run.status, key(argv)).toBe(0);
      expect(indexHash(), `control: ${key(withoutAutoRefresh(argv))}`).not.toBe(
        controlBefore,
      );
    }

    statOnlyChange();
    const before = indexHash();
    const result = await collectChanges({
      workdir: repo,
      caps: readCaps({}),
      runGit: createNodeRunGit(),
      fs: nodeChangesFs,
      env,
    });
    expect(indexHash()).toBe(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A file whose content equals HEAD is nothing to draw: Git gives it no
    // numstat record and no patch section, so the backend never sees it.
    expect(result.payload.numstat).toBe("1\t1\ta.txt\0");
    expect(result.payload.patch).not.toContain("keep.txt");
    expect(result.payload.untracked).toBe("new.txt\0");
  }, 30_000);

  for (const [label, config, control] of [
    [
      "diff.mnemonicPrefix",
      "[diff]\n\tmnemonicPrefix = true\n",
      ["--- c/a.txt"],
    ],
    ["diff.noprefix", "[diff]\n\tnoprefix = true\n", ["--- a.txt"]],
    [
      "diff.srcPrefix and diff.dstPrefix",
      "[diff]\n\tsrcPrefix = x/\n\tdstPrefix = y/\n",
      // A Git older than 2.45 does not know these two keys and keeps a/.
      ["--- x/a.txt", "--- a/a.txt"],
    ],
  ] as Array<[string, string, string[]]>) {
    it(`a host with ${label} set still writes a/ and b/, reads from a subfolder, and leaves the index alone`, async () => {
      writeFileSync(globalConfig, config);
      expect(control).toContain(controlMinusLine());
      // The control may refresh the index; move the stat again so the read
      // below has a stat only file to leave alone.
      statOnlyChange();
      const before = indexHash();
      const result = await collectChanges({
        workdir: join(repo, "sub"),
        caps: readCaps({}),
        runGit: createNodeRunGit(),
        fs: nodeChangesFs,
        env,
      });
      expect(indexHash()).toBe(before);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const payload = result.payload;
      expect(payload.state).toBe("ok");
      expect(payload.folder).toBe(basename(repo));
      expect(payload.branch).toBe("main");
      expect(payload.head).toMatch(/^[0-9a-f]{4,40}$/);
      expect(payload.numstat).toBe("1\t1\ta.txt\0");
      const lines = payload.patch.replace(/\r\n/g, "\n").split("\n");
      expect(lines).toContain("diff --git a/a.txt b/a.txt");
      expect(lines).toContain("--- a/a.txt");
      expect(lines).toContain("+++ b/a.txt");
      expect(lines).toContain("-one");
      expect(lines).toContain("+two");
      expect(payload.untracked).toBe("new.txt\0");
      expect(payload.untrackedFiles).toEqual([
        { path: "new.txt", bytes: 6, text: "hello\n" },
      ]);
      // Git prints the root with forward slashes; the parent must not travel.
      expect(JSON.stringify(payload)).not.toContain(
        dirname(repo).replace(/\\/g, "/"),
      );
    }, 30_000);
  }

  /** A second repository whose one change is a moved submodule: vendor/lib is
   * an embedded repository recorded at its first commit, then moved on to a
   * second one. Built once, on first use. */
  let submodule: { outer: string; first: string; second: string } | null = null;
  function submoduleRepo(): { outer: string; first: string; second: string } {
    if (submodule) return submodule;
    const outer = mkdtempSync(join(tmpdir(), "bgos-changes-submodule-"));
    made.push(outer);
    const inner = join(outer, "vendor", "lib");
    const git = (cwd: string, ...args: string[]) => {
      const run = spawnSync("git", args, { cwd, env, windowsHide: true });
      if (run.status !== 0) {
        throw new Error(`setup git ${args.join(" ")}: ${String(run.stderr)}`);
      }
      return String(run.stdout).trim();
    };
    git(outer, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(outer, "a.txt"), "one\n");
    mkdirSync(inner, { recursive: true });
    git(inner, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(inner, "lib.txt"), "v1\n");
    git(inner, "add", "lib.txt");
    git(inner, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "lib one");
    const first = git(inner, "rev-parse", "HEAD");
    git(outer, "add", "a.txt", "vendor/lib");
    git(outer, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "first");
    writeFileSync(join(inner, "lib.txt"), "v2\n");
    git(inner, "-c", "commit.gpgsign=false", "commit", "-q", "-a", "-m", "lib two");
    const second = git(inner, "rev-parse", "HEAD");
    submodule = { outer, first, second };
    return submodule;
  }

  for (const [label, config] of [
    ["diff.submodule=log", "[diff]\n\tsubmodule = log\n"],
    ["diff.submodule=diff", "[diff]\n\tsubmodule = diff\n"],
  ] as Array<[string, string]>) {
    it(`a host with ${label} set still writes a moved submodule as its own a/ b/ section`, async () => {
      const { outer, first, second } = submoduleRepo();
      writeFileSync(globalConfig, config);
      // The control: the same patch without --submodule=short writes Git's
      // "Submodule vendor/lib ..." line, which starts no diff --git section.
      const control = runDirect(
        PATCH.filter((word) => word !== "--submodule=short"),
        outer,
      );
      expect(control.status).toBe(0);
      const controlLines = String(control.stdout).split(/\r?\n/);
      expect(
        controlLines.some((line) => line.startsWith("Submodule vendor/lib ")),
        String(control.stdout),
      ).toBe(true);

      const result = await collectChanges({
        workdir: outer,
        caps: readCaps({}),
        runGit: createNodeRunGit(),
        fs: nodeChangesFs,
        env,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const lines = result.payload.patch.replace(/\r\n/g, "\n").split("\n");
      // One section, named by its own diff --git line, and nothing the
      // splitter would hang on another file.
      expect(lines.filter((line) => line.startsWith("diff --git "))).toEqual([
        "diff --git a/vendor/lib b/vendor/lib",
      ]);
      expect(lines.filter((line) => line.startsWith("Submodule "))).toEqual([]);
      expect(lines).toContain("--- a/vendor/lib");
      expect(lines).toContain("+++ b/vendor/lib");
      expect(lines).toContain(`-Subproject commit ${first}`);
      expect(lines).toContain(`+Subproject commit ${second}`);
      expect(result.payload.numstat).toBe("1\t1\tvendor/lib\0");
    }, 30_000);
  }

  it("a git planted in the folder Git runs in is never the one that runs (parity round, D-R2)", async () => {
    writeFileSync(globalConfig, "");
    const win = process.platform === "win32";
    const scratch = mkdtempSync(join(tmpdir(), "bgos-changes-planted-"));
    made.push(scratch);
    const sub = join(scratch, "sub");
    mkdirSync(sub);
    // Built with real Git BEFORE anything is planted.
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: scratch, env, windowsHide: true });
      if (run.status !== 0) {
        throw new Error(`setup git ${args.join(" ")}: ${String(run.stderr)}`);
      }
    };
    git("-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(scratch, "a.txt"), "one\n");
    git("add", "a.txt");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "first");
    writeFileSync(join(scratch, "a.txt"), "two\n");
    // The planted names stay out of the untracked list.
    mkdirSync(join(scratch, ".git", "info"), { recursive: true });
    writeFileSync(join(scratch, ".git", "info", "exclude"), "git.exe\ngit\n");

    // A harmless binary named git in the working folder AND at the root: a
    // copy of whoami.exe on Windows (it only refuses Git's arguments), a
    // script that exits 3 elsewhere, where a folder is searched only through
    // a relative PATH entry, so one is added.
    const plantedEnv: Record<string, string | undefined> = { ...env };
    for (const dir of [sub, scratch]) {
      if (win) {
        copyFileSync(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
          join(dir, "git.exe"),
        );
      } else {
        writeFileSync(join(dir, "git"), "#!/bin/sh\nexit 3\n");
        chmodSync(join(dir, "git"), 0o755);
      }
    }
    if (!win) plantedEnv.PATH = `.:${plantedEnv.PATH ?? ""}`;

    // The control: on this host a bare git started in that folder IS the
    // planted one, so the case below can fail.
    const control = spawnSync("git", ["--version"], {
      cwd: sub,
      env: plantedEnv,
      windowsHide: true,
    });
    expect(
      String(control.stdout),
      "control: a bare git in the planted folder is not Git",
    ).not.toMatch(/^git version/);

    const result = await collectChanges({
      workdir: sub,
      caps: readCaps({}),
      runGit: createNodeRunGit(),
      fs: nodeChangesFs,
      env: plantedEnv,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      state: "ok",
      folder: basename(scratch),
      branch: "main",
      numstat: "1\t1\ta.txt\0",
      untracked: "",
      untrackedFiles: [],
    });
  }, 30_000);

  // Fix round w4, F1: core.fsmonitor in a repository's own config names a
  // program Git runs when it reads the index. The agent writes that config.
  it("a repository whose core.fsmonitor names a program never has it run by a read (fix round w4, F1)", async () => {
    writeFileSync(globalConfig, "");
    const scratch = mkdtempSync(join(tmpdir(), "bgos-changes-fsmonitor-"));
    made.push(scratch);
    const outside = mkdtempSync(join(tmpdir(), "bgos-changes-fsmonitor-hook-"));
    made.push(outside);
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: scratch, env, windowsHide: true });
      if (run.status !== 0) {
        throw new Error(`setup git ${args.join(" ")}: ${String(run.stderr)}`);
      }
    };
    git("-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(scratch, "a.txt"), "one\n");
    git("add", "a.txt");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "first");
    writeFileSync(join(scratch, "a.txt"), "two\n");
    writeFileSync(join(scratch, "new.txt"), "hello\n");
    // The program: it writes a marker and fails, so Git falls back to its own
    // scan and the read's output is unchanged whether it ran or not.
    const marker = join(outside, "fsmonitor-ran.txt");
    const hook = join(outside, "fsmonitor-hook.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\necho ran >> '${marker.replace(/\\/g, "/")}'\nexit 1\n`,
    );
    chmodSync(hook, 0o755);
    git("config", "core.fsmonitor", hook.replace(/\\/g, "/"));

    // The controls: each index read WITHOUT the pair, under the collector's
    // own environment, runs the program on this Git. So the case can fail.
    for (const argv of [NUMSTAT, PATCH, UNTRACKED]) {
      rmSync(marker, { force: true });
      const run = runDirect(withoutFsmonitor(argv), scratch);
      expect(run.status, key(argv)).toBe(0);
      expect(
        existsSync(marker),
        `control: ${key(withoutFsmonitor(argv))} runs the program`,
      ).toBe(true);
    }

    rmSync(marker, { force: true });
    const result = await collectChanges({
      workdir: scratch,
      caps: readCaps({}),
      runGit: createNodeRunGit(),
      fs: nodeChangesFs,
      env,
    });
    expect(existsSync(marker), "the program the repository names never ran").toBe(
      false,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      state: "ok",
      folder: basename(scratch),
      branch: "main",
      numstat: "1\t1\ta.txt\0",
      untracked: "new.txt\0",
      untrackedFiles: [{ path: "new.txt", bytes: 6, text: "hello\n" }],
    });
  }, 30_000);

  /** A second repository, elsewhere: its own branch, its own commit and its
   * own index, holding only b.txt. Built once, on first use. */
  let elsewhere = "";
  function elsewhereRepo(): string {
    if (elsewhere) return elsewhere;
    const dir = mkdtempSync(join(tmpdir(), "bgos-changes-elsewhere-"));
    made.push(dir);
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: dir, env, windowsHide: true });
      if (run.status !== 0) {
        throw new Error(`setup git ${args.join(" ")}: ${String(run.stderr)}`);
      }
    };
    git("-c", "init.defaultBranch=elsewhere", "init", "-q");
    writeFileSync(join(dir, "b.txt"), "bee\n");
    git("add", "b.txt");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "elsewhere");
    elsewhere = dir;
    return elsewhere;
  }

  // Parity round 2 (lane D's collector): GIT_DIR, GIT_INDEX_FILE and the
  // other repository variables, when the daemon's own environment carries
  // them, point every Git read at that repository or index, whatever folder
  // the read runs in.
  for (const variable of ["GIT_DIR", "GIT_INDEX_FILE"] as const) {
    it(`a daemon started with ${variable} naming another repository still reads the folder it is given (parity round 2)`, async () => {
      writeFileSync(globalConfig, "");
      const other = elsewhereRepo();
      const daemonEnv: Record<string, string | undefined> = {
        ...env,
        [variable]:
          variable === "GIT_DIR"
            ? join(other, ".git")
            : join(other, ".git", "index"),
      };
      const tracked = (runEnv: Record<string, string | undefined>) =>
        String(
          spawnSync("git", ["ls-files"], {
            cwd: repo,
            env: runEnv,
            windowsHide: true,
          }).stdout,
        )
          .split(/\r?\n/)
          .filter((line) => line.length > 0);
      // The control: on this Git the variable really moves a read. ls-files
      // in this repository lists the OTHER repository's index with it, and
      // this one's without it, so the case below can fail.
      expect(tracked(env), "control: without the variable").toEqual([
        "a.txt",
        "sub/keep.txt",
      ]);
      expect(tracked(daemonEnv), `control: with ${variable}`).toEqual(["b.txt"]);

      const head = String(runDirect(["rev-parse", "--short", "HEAD"]).stdout).trim();
      expect(head).toMatch(/^[0-9a-f]{4,40}$/);
      const result = await collectChanges({
        workdir: repo,
        caps: readCaps({}),
        runGit: createNodeRunGit(),
        fs: nodeChangesFs,
        env: daemonEnv,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.payload).toMatchObject({
        state: "ok",
        folder: basename(repo),
        branch: "main",
        head,
        numstat: "1\t1\ta.txt\0",
        untracked: "new.txt\0",
        untrackedFiles: [{ path: "new.txt", bytes: 6, text: "hello\n" }],
      });
      const lines = result.payload.patch.replace(/\r\n/g, "\n").split("\n");
      expect(lines).toContain("diff --git a/a.txt b/a.txt");
      expect(lines).toContain("+two");
      expect(lines.filter((line) => line.includes("b.txt"))).toEqual([]);
    }, 30_000);
  }
});
