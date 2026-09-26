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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  collectChanges,
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

const TOPLEVEL = ["rev-parse", "--show-toplevel"];
const VERIFY_HEAD = ["rev-parse", "--verify", "--quiet", "HEAD"];
const BRANCH = ["symbolic-ref", "--quiet", "--short", "HEAD"];
const SHORT_HEAD = ["rev-parse", "--short", "HEAD"];
const NUMSTAT = [
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
];
// --src-prefix and --dst-prefix: a host whose Git config sets diff.noprefix,
// diff.mnemonicPrefix or diff.srcPrefix would otherwise write headers the
// backend cannot read as a/ and b/ (lane B review, round 1).
const PATCH = [
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
];
const UNTRACKED = ["ls-files", "--others", "--exclude-standard", "-z"];

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
}

function memoryFs(files: Record<string, MemFile>) {
  const lstatCalls: string[] = [];
  const readCalls: string[] = [];
  const fs: ChangesFs = {
    async lstat(path) {
      lstatCalls.push(path);
      const file = files[path];
      if (!file) {
        throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      }
      return {
        isFile: () => file.symlink !== true,
        size: file.size ?? file.data?.length ?? 0,
      };
    },
    async readPrefix(path, limit) {
      readCalls.push(path);
      const file = files[path];
      if (!file?.data) throw new Error(`cannot read ${path}`);
      return file.data.subarray(0, limit);
    },
  };
  return { fs, lstatCalls, readCalls };
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
      fs: memoryFs({}).fs,
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
    const adapter = createNodeRunGit({
      spawnImpl: (() => child) as unknown as typeof spawn,
    });
    const pending = adapter(PATCH, {
      cwd: ROOT,
      env: {},
      maxBytes: 1_024,
      signal: new AbortController().signal,
    });
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
  });

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

const gitOnPath = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

describe.skipIf(!gitOnPath)("against a real Git repository", () => {
  const made: string[] = [];
  let repo = "";
  let globalConfig = "";
  let env: Record<string, string | undefined> = {};

  /** One repository with one commit, one edit and one new file. The host's
   * own Git config is isolated: each case writes the setting it is about
   * into the isolated GLOBAL config, where an owner usually sets it. */
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

  /** The same patch WITHOUT the two prefix flags: the control that proves
   * the host setting really bites on this Git. */
  const controlMinusLine = () => {
    const run = spawnSync(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "HEAD",
        "--",
      ],
      { cwd: repo, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, windowsHide: true },
    );
    return String(run.stdout)
      .split(/\r?\n/)
      .find((line) => line.startsWith("--- "));
  };

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
});
