/**
 * The native /diff (fix round w4, R-3). A PRE EXISTING gap: since /diff was
 * written (63d9f12, 2026-09-11) it ran a bare `git` from the agent's folder,
 * a porcelain diff with no `-c diff.autoRefreshIndex=false`, no
 * GIT_OPTIONAL_LOCKS, no dropped repository variables and the fsmonitor on.
 * /diff reads the same folder the Changes panel reads, so it keeps the
 * collector's rules (src/git-changes.ts): Git by the absolute path found on
 * PATH's absolute entries, Git's read environment, the fsmonitor off and no
 * index refresh.
 *
 * The fake cases pin the command, the folder and the environment. The real
 * cases run /diff against a real Git repository, each with a control that
 * shows the case can fail on this host.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeCommands } from "../src/native-commands.js";

/** /diff's command, written out whole (never imported from the code). */
const DIFF = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
  "--no-pager",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "HEAD",
  "--",
];

/** Where Git for Windows puts its launcher, written out. */
const GIT_EXE = "C:\\Program Files\\Git\\cmd\\git.exe";

/** The top level, read before the diff (fix round w5, W4-N4), written out. */
const TOPLEVEL = ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"];

/** What /diff says when the top level is not the agent's folder or a folder
 * above it (fix round w5, W4-N4). */
const OUTSIDE =
  "This agent's repository keeps its working files outside the agent's folder, so its diff is not shown.";

/** `git version`, read before anything else (fix round w5, W4-N3). */
const VERSION = ["version"];
const HOST_VERSION = "git version 2.55.0.windows.3\n";

/** What /diff says for a Git below the floor, or one whose version cannot
 * be read (fix round w5, W4-N3). */
const TOO_OLD =
  "Git 2.36 or later is needed to read changes safely. Update Git on this computer, then retry.";

const NOT_LOADED =
  "The Git diff could not be loaded. Check that Git is installed and the project is accessible, then retry.";

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** The owner's /diff, through the real router, with the agent's folder. */
function router(workdir: string, extra: Record<string, unknown> = {}) {
  const sendText = vi.fn(async (_text: string) => ({ id: 1 }));
  const commands = new NativeCommands({
    host: { workdir } as never,
    interactions: { ask: vi.fn() } as never,
    ownerId: () => "owner",
    status: () => "connected",
    run: vi.fn(),
    goalLane: {} as never,
    ...extra,
  } as ConstructorParameters<typeof NativeCommands>[0]);
  const args = {
    assistantId: 10,
    chatId: 20,
    userId: "owner",
    command: { name: "diff", args: "" },
    replyHandle: { sendText },
  } as never;
  return {
    diff: () => commands.handle(args),
    said: () => sendText.mock.calls.map((call) => String(call[0])),
  };
}

interface Run {
  file: string;
  args: string[];
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    windowsHide: boolean;
    timeout: number;
    maxBuffer: number;
  };
}

describe("/diff (fix round w4, R-3)", () => {
  it("runs the Git that PATH names by its absolute path, with the fsmonitor off and no index refresh, in the agent's folder, under Git's read environment", async () => {
    const workdir = scratch("bgos-native-diff-");
    vi.stubEnv("GIT_DIR", "C:\\Users\\owner\\other\\.git");
    vi.stubEnv("GIT_INDEX_FILE", "C:\\Users\\owner\\other\\.git\\index");
    vi.stubEnv("GIT_OPTIONAL_LOCKS", "1");
    const lookups: Array<Record<string, string | undefined>> = [];
    const runs: Run[] = [];
    const r = router(workdir, {
      findGit: async (env: Record<string, string | undefined>) => {
        lookups.push(env);
        return GIT_EXE;
      },
      execGit: async (file: string, args: readonly string[], options: Run["options"]) => {
        runs.push({ file, args: [...args], options });
        const argv = args.join(" ");
        return {
          stdout:
            argv === "version"
              ? HOST_VERSION
              : argv === TOPLEVEL.join(" ")
                ? `${workdir.replace(/\\/g, "/")}\n`
                : "diff --git a/a.txt b/a.txt\n-one\n+two\n",
        };
      },
      gitVersions: new Map(),
    });
    await r.diff();
    expect(runs.map((run) => run.file), "the absolute path, never a bare git").toEqual([
      GIT_EXE,
      GIT_EXE,
      GIT_EXE,
    ]);
    // Its version first (fix round w5, W4-N3), then the top level (W4-N4),
    // in the same folder and environment, then the diff.
    expect(runs.map((run) => run.args)).toEqual([VERSION, TOPLEVEL, DIFF]);
    for (const run of runs.slice(0, 2)) {
      expect(run.options.cwd).toBe(workdir);
      expect(run.options.env).toBe(runs[2]!.options.env);
    }
    runs.splice(0, 2);
    expect(runs[0]!.options).toMatchObject({
      cwd: workdir,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 512_000,
    });
    const env = runs[0]!.options.env;
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.LC_ALL).toBe("C");
    // No read starts a fetch from a promisor remote (fix round w5, W4-N1).
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    // Looked up once, with the environment Git itself gets.
    expect(lookups).toEqual([env]);
    expect(r.said()).toEqual([
      "```diff\ndiff --git a/a.txt b/a.txt\n-one\n+two\n\n```",
    ]);
  });

  it("with no Git on an absolute PATH entry runs nothing and says the diff could not be loaded", async () => {
    const workdir = scratch("bgos-native-diff-");
    const runs: Run[] = [];
    const r = router(workdir, {
      findGit: async () => null,
      execGit: async (file: string, args: readonly string[], options: Run["options"]) => {
        runs.push({ file, args: [...args], options });
        return { stdout: "" };
      },
    });
    await r.diff();
    expect(runs).toEqual([]);
    expect(r.said()).toEqual([NOT_LOADED]);
  });

  it("keeps its three answers for a failed Git: not a repository, no first commit, anything else (characterisation through the new seam)", async () => {
    const workdir = scratch("bgos-native-diff-");
    const said: string[] = [];
    for (const stderr of [
      "fatal: not a git repository (or any of the parent directories): .git\n",
      "fatal: bad revision 'HEAD'\n",
      "fatal: detected dubious ownership in repository at 'C:/Users/owner/work'\n",
    ]) {
      const r = router(workdir, {
        findGit: async () => GIT_EXE,
        // Its version reads (fix round w5, W4-N3); the read after it fails.
        execGit: async (_file: string, args: readonly string[]) => {
          if (args.join(" ") === "version") return { stdout: HOST_VERSION };
          throw Object.assign(new Error("Command failed"), { code: 128, stderr });
        },
        gitVersions: new Map(),
      });
      await r.diff();
      said.push(...r.said());
    }
    expect(said).toEqual([
      "This agent's folder is not a Git repository yet. Open a project with Git history to view its diff.",
      "This repository has no first commit yet. Commit its initial files before comparing working changes.",
      NOT_LOADED,
    ]);
  });
});

describe("/diff and the Git floor (fix round w5, W4-N3)", () => {
  it("a Git older than 2.36, or one whose version cannot be read, is refused in plain words before any other Git command", async () => {
    const workdir = scratch("bgos-native-diff-");
    for (const answer of [
      { stdout: "git version 2.35.1\n" },
      { stdout: "git version 2.9.5\n" },
      { stdout: "" },
      Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "whoami: extra operand\n" }),
    ]) {
      const label = answer instanceof Error ? "exit 1" : JSON.stringify(answer);
      const runs: string[][] = [];
      const r = router(workdir, {
        findGit: async () => GIT_EXE,
        execGit: async (_file: string, args: readonly string[]) => {
          runs.push([...args]);
          if (args.join(" ") !== "version") return { stdout: "diff --git a/a.txt b/a.txt\n" };
          if (answer instanceof Error) throw answer;
          return answer;
        },
        gitVersions: new Map(),
      });
      await r.diff();
      expect(r.said(), label).toEqual([TOO_OLD]);
      expect(runs, `${label}: its version, and nothing else`).toEqual([VERSION]);
    }
  });

  it("reads a Git's version once: a second /diff with the same Git reads none", async () => {
    const workdir = scratch("bgos-native-diff-");
    const runs: string[][] = [];
    const gitVersions = new Map();
    for (let i = 0; i < 2; i += 1) {
      const r = router(workdir, {
        findGit: async () => GIT_EXE,
        execGit: async (_file: string, args: readonly string[]) => {
          runs.push([...args]);
          const argv = args.join(" ");
          return {
            stdout:
              argv === "version"
                ? HOST_VERSION
                : argv === TOPLEVEL.join(" ")
                  ? `${workdir}\n`
                  : "diff --git a/a.txt b/a.txt\n",
          };
        },
        gitVersions,
      });
      await r.diff();
      expect(r.said()).toEqual(["```diff\ndiff --git a/a.txt b/a.txt\n\n```"]);
    }
    expect(runs).toEqual([VERSION, TOPLEVEL, DIFF, TOPLEVEL, DIFF]);
  });
});

describe("/diff stays inside the agent's folder (fix round w5, W4-N4)", () => {
  it("a top level that is not the agent's folder or a folder above it: /diff says so and runs no diff", async () => {
    const parent = scratch("bgos-native-diff-");
    const workdir = join(parent, "agent-folder");
    const inside = join(workdir, "inside");
    // A folder whose name is the start of the agent's folder's name.
    const sameStart = join(parent, "agent");
    for (const dir of [workdir, inside, sameStart]) mkdirSync(dir);
    expect(workdir.startsWith(sameStart), "the agent's folder's name starts with it").toBe(true);
    for (const [label, top] of [
      ["another folder", scratch("bgos-native-diff-elsewhere-")],
      ["a folder inside the agent's folder", inside],
      ["a name that only starts the same", sameStart],
    ] as Array<[string, string]>) {
      const runs: string[][] = [];
      const r = router(workdir, {
        findGit: async () => GIT_EXE,
        execGit: async (_file: string, args: readonly string[]) => {
          runs.push([...args]);
          const argv = args.join(" ");
          return {
            stdout:
              argv === "version"
                ? HOST_VERSION
                : argv === TOPLEVEL.join(" ")
                  ? `${top.replace(/\\/g, "/")}\n`
                  : "diff --git a/a.txt b/a.txt\n+the owner's other text\n",
          };
        },
        gitVersions: new Map(),
      });
      await r.diff();
      expect(r.said(), label).toEqual([OUTSIDE]);
      expect(runs, `${label}: no diff`).toEqual([VERSION, TOPLEVEL]);
    }
  });

  it("the agent's folder, or a folder above it, reads as before", async () => {
    const above = scratch("bgos-native-diff-above-");
    const workdir = join(above, "agent");
    mkdirSync(workdir);
    for (const top of [workdir, above]) {
      const r = router(workdir, {
        findGit: async () => GIT_EXE,
        execGit: async (_file: string, args: readonly string[]) => {
          const argv = args.join(" ");
          return {
            stdout:
              argv === "version"
                ? HOST_VERSION
                : argv === TOPLEVEL.join(" ")
                  ? `${top.replace(/\\/g, "/")}\n`
                  : "diff --git a/a.txt b/a.txt\n",
          };
        },
        gitVersions: new Map(),
      });
      await r.diff();
      expect(r.said(), top).toEqual(["```diff\ndiff --git a/a.txt b/a.txt\n\n```"]);
    }
  });
});

const gitOnPath = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

describe.skipIf(!gitOnPath)("/diff against a real Git repository (fix round w4, R-3)", () => {
  let setupEnv: Record<string, string | undefined> = {};

  // The owner's own Git config is kept out: /diff reads process.env, so the
  // isolated config goes there, for the router and the setup alike.
  beforeEach(() => {
    const home = scratch("bgos-native-diff-home-");
    const globalConfig = join(home, "gitconfig");
    writeFileSync(globalConfig, "");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    setupEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "p7",
      GIT_AUTHOR_EMAIL: "p7@example.test",
      GIT_COMMITTER_NAME: "p7",
      GIT_COMMITTER_EMAIL: "p7@example.test",
    };
  });

  /** Git's read environment as the collector sets it, for the controls. */
  const readEnv = () => ({
    ...setupEnv,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  });

  /** A repository with one commit (a.txt, sub/keep.txt) and a.txt edited. */
  function repoWithEdit(prefix: string): string {
    const repo = scratch(prefix);
    const git = (...args: string[]) => {
      const run = spawnSync("git", args, { cwd: repo, env: setupEnv, windowsHide: true });
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
    return repo;
  }

  /** The same argv without the `-c <setting>` pair. */
  const without = (argv: string[], setting: string) => {
    const at = argv.indexOf(setting);
    return at < 1 ? [...argv] : [...argv.slice(0, at - 1), ...argv.slice(at + 1)];
  };

  /** What /diff posted, as lines. */
  const lines = (said: string[]) => said.join("\n").replace(/\r\n/g, "\n").split("\n");

  it("a git planted in the agent's folder is never the one /diff runs", async () => {
    const win = process.platform === "win32";
    const repo = repoWithEdit("bgos-native-diff-planted-");
    // A harmless binary named git in the agent's folder: a copy of whoami.exe
    // on Windows (it only refuses Git's arguments), a script that exits 3
    // elsewhere, where a folder is searched only through a relative PATH
    // entry, so one is added.
    if (win) {
      copyFileSync(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
        join(repo, "git.exe"),
      );
    } else {
      writeFileSync(join(repo, "git"), "#!/bin/sh\nexit 3\n");
      chmodSync(join(repo, "git"), 0o755);
      vi.stubEnv("PATH", `.:${process.env.PATH ?? ""}`);
    }
    // The control: on this host a bare git started in that folder IS the
    // planted one, so the case can fail.
    const control = spawnSync("git", ["--version"], {
      cwd: repo,
      env: process.env,
      windowsHide: true,
    });
    expect(
      String(control.stdout),
      "control: a bare git in the agent's folder is not Git",
    ).not.toMatch(/^git version/);

    const r = router(repo);
    await r.diff();
    const posted = lines(r.said());
    // The message is what /diff posted, so a red run shows it.
    expect(posted, r.said().join("\n")).toContain("diff --git a/a.txt b/a.txt");
    expect(posted).toContain("-one");
    expect(posted).toContain("+two");
  }, 30_000);

  it("a repository whose core.fsmonitor names a program never has it run by /diff", async () => {
    const repo = repoWithEdit("bgos-native-diff-fsmonitor-");
    const outside = scratch("bgos-native-diff-fsmonitor-hook-");
    const marker = join(outside, "fsmonitor-ran.txt");
    const hook = join(outside, "fsmonitor-hook.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\necho ran >> '${marker.replace(/\\/g, "/")}'\nexit 1\n`,
    );
    chmodSync(hook, 0o755);
    const set = spawnSync("git", ["config", "core.fsmonitor", hook.replace(/\\/g, "/")], {
      cwd: repo,
      env: setupEnv,
      windowsHide: true,
    });
    expect(set.status).toBe(0);
    // The control: the same diff WITHOUT the pair runs the program here.
    const control = spawnSync("git", without(DIFF, "core.fsmonitor=false"), {
      cwd: repo,
      env: readEnv(),
      windowsHide: true,
    });
    expect(control.status).toBe(0);
    expect(existsSync(marker), "control: the diff without the pair runs the program").toBe(
      true,
    );

    rmSync(marker, { force: true });
    const r = router(repo);
    await r.diff();
    expect(existsSync(marker), "the program the repository names never ran").toBe(false);
    expect(lines(r.said())).toContain("diff --git a/a.txt b/a.txt");
  }, 30_000);

  it("a file with only a stat change: /diff leaves the index alone, where a plain porcelain diff rewrites it", async () => {
    const repo = repoWithEdit("bgos-native-diff-index-");
    let moves = 0;
    /** sub/keep.txt rewritten with its own text and a new mtime each call. */
    const statOnlyChange = () => {
      const file = join(repo, "sub", "keep.txt");
      writeFileSync(file, "keep\n");
      moves += 1;
      const at = new Date(Date.UTC(2020, 0, 1) + moves * 86_400_000);
      utimesSync(file, at, at);
    };
    const indexHash = () =>
      createHash("sha256")
        .update(readFileSync(join(repo, ".git", "index")))
        .digest("hex");

    // The control: the same diff WITHOUT the pair, under Git's read
    // environment (GIT_OPTIONAL_LOCKS=0 included), rewrites the index.
    statOnlyChange();
    const controlBefore = indexHash();
    const control = spawnSync("git", without(DIFF, "diff.autoRefreshIndex=false"), {
      cwd: repo,
      env: readEnv(),
      windowsHide: true,
    });
    expect(control.status).toBe(0);
    expect(indexHash(), "control: a porcelain diff rewrites the index").not.toBe(
      controlBefore,
    );

    statOnlyChange();
    const before = indexHash();
    const r = router(repo);
    await r.diff();
    expect(indexHash(), "/diff left the index as it was").toBe(before);
    const posted = lines(r.said());
    expect(posted).toContain("diff --git a/a.txt b/a.txt");
    expect(posted.filter((line) => line.includes("keep.txt"))).toEqual([]);
  }, 30_000);

  /**
   * A fresh partial clone (fix round w5, W4-N1): its promisor remote is a
   * file:// URL to a source repository that serves filtered clones, it holds
   * HEAD's trees and no blobs, its index is read from HEAD (no stat data),
   * a.txt is edited and sub/keep.txt is as in HEAD. A diff then needs a.txt's
   * HEAD blob, which is missing, and Git fetches it on demand; that fetch
   * runs the upload-pack program the clone's OWN config names, here a script
   * outside it that writes a marker and then runs the real one.
   */
  function partialClone(): { clone: string; marker: string; missing: () => string[] } {
    const fwd = (path: string) => path.replace(/\\/g, "/");
    const setup = (cwd: string, ...args: string[]) => {
      const run = spawnSync("git", args, { cwd, env: setupEnv, windowsHide: true });
      if (run.status !== 0) {
        throw new Error(`setup git ${args.join(" ")}: ${String(run.stderr)}`);
      }
    };
    const source = scratch("bgos-native-diff-promisor-src-");
    setup(source, "-c", "init.defaultBranch=main", "init", "-q");
    mkdirSync(join(source, "sub"));
    writeFileSync(join(source, "a.txt"), "one\n");
    writeFileSync(join(source, "sub", "keep.txt"), "keep\n");
    setup(source, "add", "a.txt", "sub/keep.txt");
    setup(source, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "first");
    setup(source, "config", "uploadpack.allowFilter", "true");
    setup(source, "config", "uploadpack.allowAnySHA1InWant", "true");
    const outside = scratch("bgos-native-diff-promisor-hook-");
    const marker = join(outside, "upload-pack-ran.txt");
    const wrapper = join(outside, "upload-pack.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho ran >> '${fwd(marker)}'\nexec git-upload-pack "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const clone = scratch("bgos-native-diff-partial-");
    setup(
      tmpdir(),
      "clone",
      "-q",
      "--filter=blob:none",
      "--no-checkout",
      `file:///${fwd(source).replace(/^\/+/, "")}`,
      clone,
    );
    setup(clone, "read-tree", "HEAD");
    writeFileSync(join(clone, "a.txt"), "two\n");
    mkdirSync(join(clone, "sub"));
    writeFileSync(join(clone, "sub", "keep.txt"), "keep\n");
    setup(clone, "config", "remote.origin.uploadpack", fwd(wrapper));
    const missing = () =>
      String(
        spawnSync("git", ["rev-list", "--objects", "--missing=print", "HEAD"], {
          cwd: clone,
          env: { ...setupEnv, GIT_NO_LAZY_FETCH: "1" },
          windowsHide: true,
        }).stdout,
      )
        .split(/\r?\n/)
        .filter((line) => line.startsWith("?"));
    return { clone, marker, missing };
  }

  it("a partial clone's missing blob is never fetched by /diff on a Git that knows GIT_NO_LAZY_FETCH (fix round w5, W4-N1)", async () => {
    // The control: the same diff under the read environment WITHOUT the
    // variable starts a fetch on this Git (the program ran, the blobs came).
    const control = partialClone();
    expect(control.missing().length, "control: starts with blobs missing").toBeGreaterThan(0);
    const run = spawnSync("git", DIFF, { cwd: control.clone, env: readEnv(), windowsHide: true });
    expect(run.status).toBe(0);
    expect(existsSync(control.marker), "control: the diff started a fetch").toBe(true);
    expect(control.missing(), "control: the diff fetched the blobs").toEqual([]);

    const subject = partialClone();
    const before = subject.missing();
    expect(before.length).toBeGreaterThan(0);
    const r = router(subject.clone);
    await r.diff();
    expect(existsSync(subject.marker), "/diff started no fetch").toBe(false);
    expect(subject.missing(), "the missing blobs are still missing").toEqual(before);
    // Without the blob Git cannot diff: the existing "could not be loaded".
    expect(r.said()).toEqual([NOT_LOADED]);
  }, 60_000);

  it("a repository whose core.worktree names another folder: /diff posts nothing from there (fix round w5, W4-N4)", async () => {
    const repo = repoWithEdit("bgos-native-diff-worktree-");
    // The owner's other folder, with a file of the same name.
    const other = scratch("bgos-native-diff-worktree-other-");
    writeFileSync(join(other, "a.txt"), "the owner's other text\n");
    // The control: without the setting /diff posts the agent's own edit.
    const before = router(repo);
    await before.diff();
    expect(lines(before.said())).toContain("+two");
    const set = spawnSync("git", ["config", "core.worktree", other.replace(/\\/g, "/")], {
      cwd: repo,
      env: setupEnv,
      windowsHide: true,
    });
    expect(set.status).toBe(0);
    // And on this Git the setting makes the same diff read the other folder.
    const control = spawnSync("git", DIFF, { cwd: repo, env: readEnv(), windowsHide: true });
    expect(control.status).toBe(0);
    expect(
      lines([String(control.stdout)]),
      "control: the diff reads the other folder",
    ).toContain("+the owner's other text");

    const r = router(repo);
    await r.diff();
    // The message is what /diff posted, so a red run shows it.
    expect(r.said(), r.said().join("\n")).toEqual([OUTSIDE]);
  }, 30_000);

  const variables =
    process.platform === "win32" ? ["GIT_DIR", "Git_Dir"] : ["GIT_DIR"];
  for (const variable of variables) {
    it(`a daemon started with ${variable} naming another repository: /diff still reads the agent's folder`, async () => {
      const repo = repoWithEdit("bgos-native-diff-env-");
      const other = scratch("bgos-native-diff-elsewhere-");
      const git = (...args: string[]) => {
        const run = spawnSync("git", args, { cwd: other, env: setupEnv, windowsHide: true });
        if (run.status !== 0) {
          throw new Error(`setup git ${args.join(" ")}: ${String(run.stderr)}`);
        }
      };
      git("-c", "init.defaultBranch=elsewhere", "init", "-q");
      writeFileSync(join(other, "b.txt"), "bee\n");
      git("add", "b.txt");
      git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "elsewhere");

      vi.stubEnv(variable, join(other, ".git"));
      // The control: with the variable in the daemon's environment, a read
      // in the agent's folder reads the OTHER repository.
      const tracked = String(
        spawnSync("git", ["ls-files"], { cwd: repo, env: process.env, windowsHide: true })
          .stdout,
      )
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
      expect(tracked, `control: with ${variable}`).toEqual(["b.txt"]);

      const r = router(repo);
      await r.diff();
      const posted = lines(r.said());
      // The message is what /diff posted, so a red run shows it.
      expect(posted, r.said().join("\n")).toContain("diff --git a/a.txt b/a.txt");
      expect(posted).toContain("+two");
      expect(posted.filter((line) => line.includes("b.txt"))).toEqual([]);
    }, 30_000);
  }
});
