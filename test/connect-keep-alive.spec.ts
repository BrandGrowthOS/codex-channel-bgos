/**
 * `connect --keep-alive` (design 2.2): the manual path installed nothing, so a
 * Codex agent connected by hand died with its terminal and never came back
 * after a reboot. With the flag, once pairing succeeds the agent gets the same
 * per agent background service the desktop setup installs, running from its
 * own `<home>/runtime` (an npx cache is not a place a service can live in, and
 * the runtime is the layout self update can swap), and connect exits instead
 * of running in the foreground. Without it, one line says keep-alive is
 * recommended and names the flag. Every effect is injected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  KEEP_ALIVE_FLAG,
  KEEP_ALIVE_RECOMMENDED,
  completeConnect,
  finishConnect,
  keepAlivePrecheck,
  setUpKeepAlive,
  takeFlag,
} from "../src/keep-alive.js";
import {
  nodeRuntimeFs,
  npmCliPath,
  runtimeCli,
  runtimePaths,
  type Exec,
  type RuntimeFs,
} from "../src/setup/self-update.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "codex-keep-alive-"));
  dirs.push(d);
  return d;
};
function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function makeRuntime(dir: string, version: string, codex = "0.154.0") {
  writeJson(join(dir, "node_modules", "codex-channel-bgos", "package.json"), { version });
  mkdirSync(dirname(runtimeCli(dir)), { recursive: true });
  writeFileSync(runtimeCli(dir), `// ${version}\n`);
  writeJson(join(dir, "node_modules", "@openai", "codex", "package.json"), { version: codex });
  // npm's hidden lockfile, written once the install is finished.
  writeJson(join(dir, "node_modules", ".package-lock.json"), { lockfileVersion: 3 });
}

const EXEC_PATH = "/opt/node/bin/node";
const NPM_CLI = npmCliPath(EXEC_PATH, "darwin", () => true)!;
const fs: RuntimeFs = { ...nodeRuntimeFs, exists: (p) => p === NPM_CLI || existsSync(p) };

function recordingExec(events: string[]): Exec {
  return async (_command, args) => {
    if (args[1] === "install") {
      events.push(`npm ${args.slice(-2).join(" ")}`);
      const prefix = args[args.indexOf("--prefix") + 1];
      makeRuntime(prefix, args.at(-2)!.split("@")[1], args.at(-1)!.split("@")[2]);
      return { code: 0, stdout: "", stderr: "" };
    }
    events.push("probe");
    return { code: 0, stdout: readFileSync(args[0], "utf8").replace(/[/\s]/g, "") + "\n", stderr: "" };
  };
}

describe("takeFlag", () => {
  it("removes the flag wherever it is and says whether it was there", () => {
    const argv = ["connect", "BGOS-AB12-CD", KEEP_ALIVE_FLAG, "--assistant-id", "9"];
    expect(takeFlag(argv, KEEP_ALIVE_FLAG)).toBe(true);
    expect(argv).toEqual(["connect", "BGOS-AB12-CD", "--assistant-id", "9"]);
    expect(takeFlag(argv, KEEP_ALIVE_FLAG)).toBe(false);
  });
});

describe("keepAlivePrecheck: refuse BEFORE the one time code is spent", () => {
  const table: Array<[string, Parameters<typeof keepAlivePrecheck>[0], RegExp | null]> = [
    ["a pinned agent signed in to Codex", { assistantId: 9, authMode: "chatgpt", platform: "darwin" }, null],
    ["no --assistant-id: the service would not know which agent it runs", { authMode: "chatgpt", platform: "linux" }, /--assistant-id/],
    ["an API key from this terminal: the service would not see it", { assistantId: 9, authMode: "apikey", platform: "darwin" }, /codex login/],
    ["an unsupported computer", { assistantId: 9, authMode: "chatgpt", platform: "aix" }, /not available/],
  ];
  for (const [name, input, expected] of table)
    it(name, () => {
      const result = keepAlivePrecheck(input);
      if (expected === null) expect(result).toBeNull();
      else expect(result).toMatch(expected);
    });
});

describe("setUpKeepAlive", () => {
  it("from npx: installs this version into <home>/runtime (Codex pinned to this copy's), then the service runs it", async () => {
    const home = temp();
    const events: string[] = [];
    const cli = await setUpKeepAlive({
      home,
      currentCli: "/Users/kc/.npm/_npx/abc/node_modules/codex-channel-bgos/dist/cli.js",
      version: "0.19.0",
      codexVersion: "0.154.2",
      execPath: EXEC_PATH,
      platform: "darwin",
      exec: recordingExec(events),
      fs,
      pause: async () => void events.push("pause"),
      install: async (h, c) => void events.push(`install ${h === home} ${c}`),
    });
    expect(cli).toBe(runtimeCli(runtimePaths(home).runtime));
    expect(events).toEqual([
      "npm codex-channel-bgos@0.19.0 @openai/codex@0.154.2",
      "probe",
      "pause",
      `install true ${cli}`,
    ]);
    expect(existsSync(runtimeCli(runtimePaths(home).runtime))).toBe(true);
    expect(existsSync(runtimePaths(home).next)).toBe(false);
    expect(existsSync(runtimePaths(home).prev)).toBe(false);
  });

  it("replaces an older runtime in place (its service paused first)", async () => {
    const home = temp();
    makeRuntime(runtimePaths(home).runtime, "0.18.0");
    const events: string[] = [];
    await setUpKeepAlive({
      home,
      currentCli: "/elsewhere/cli.js",
      version: "0.19.0",
      codexVersion: "0.154.0",
      execPath: EXEC_PATH,
      platform: "darwin",
      exec: recordingExec(events),
      fs,
      pause: async () => void events.push("pause"),
      install: async () => void events.push("install"),
    });
    expect(
      JSON.parse(readFileSync(join(runtimePaths(home).runtime, "node_modules", "codex-channel-bgos", "package.json"), "utf8")).version,
    ).toBe("0.19.0");
    expect(events.indexOf("pause")).toBeLessThan(events.indexOf("install"));
  });

  it("review F6: a switch that fails puts the existing runtime back, and installs no service", async () => {
    const home = temp();
    const p = runtimePaths(home);
    makeRuntime(p.runtime, "0.18.0");
    const events: string[] = [];
    const install = vi.fn(async () => {});
    const failing: RuntimeFs = {
      ...fs,
      rename: (from, to) => {
        if (from === p.next) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
        nodeRuntimeFs.rename(from, to);
      },
    };
    await expect(
      setUpKeepAlive({
        home,
        currentCli: "/elsewhere/cli.js",
        version: "0.19.0",
        codexVersion: "0.154.0",
        execPath: EXEC_PATH,
        // Not Windows, so nothing is retried and the failure stands at once.
        platform: "darwin",
        exec: recordingExec(events),
        fs: failing,
        pause: async () => void events.push("pause"),
        install,
      }),
    ).rejects.toThrow("EPERM");
    // The desktop installed runtime (and the service that runs it) is intact.
    expect(
      JSON.parse(readFileSync(join(p.runtime, "node_modules", "codex-channel-bgos", "package.json"), "utf8")).version,
    ).toBe("0.18.0");
    expect(existsSync(p.prev)).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it("reuses a runtime already on this version (no npm)", async () => {
    const home = temp();
    makeRuntime(runtimePaths(home).runtime, "0.19.0");
    const events: string[] = [];
    await setUpKeepAlive({
      home,
      currentCli: "/elsewhere/cli.js",
      version: "0.19.0",
      codexVersion: "0.154.0",
      execPath: EXEC_PATH,
      platform: "darwin",
      exec: recordingExec(events),
      fs,
      pause: async () => void events.push("pause"),
      install: async () => void events.push("install"),
    });
    expect(events).toEqual(["install"]);
  });

  it("run from the runtime itself: nothing to install, only the service", async () => {
    const home = temp();
    makeRuntime(runtimePaths(home).runtime, "0.19.0");
    const events: string[] = [];
    const cli = await setUpKeepAlive({
      home,
      currentCli: runtimeCli(runtimePaths(home).runtime),
      version: "0.19.1",
      codexVersion: null,
      execPath: EXEC_PATH,
      platform: "darwin",
      exec: recordingExec(events),
      fs,
      pause: async () => void events.push("pause"),
      install: async () => void events.push("install"),
    });
    expect(events).toEqual(["install"]);
    expect(cli).toBe(runtimeCli(runtimePaths(home).runtime));
  });

  it("never installs a service when this copy's Codex version is unknown", async () => {
    const home = temp();
    const install = vi.fn(async () => {});
    await expect(
      setUpKeepAlive({
        home,
        currentCli: "/elsewhere/cli.js",
        version: "0.19.0",
        codexVersion: null,
        execPath: EXEC_PATH,
        platform: "darwin",
        exec: recordingExec([]),
        fs,
        pause: async () => {},
        install,
      }),
    ).rejects.toThrow("Codex");
    expect(install).not.toHaveBeenCalled();
  });
});

describe("finishConnect", () => {
  it("without the flag: one line recommends keep-alive and names the flag, then the foreground run", async () => {
    const out: string[] = [];
    const setUp = vi.fn(async () => "/cli.js");
    expect(
      await finishConnect({ keepAlive: false, setUp, out: (l) => out.push(l), err: () => {} }),
    ).toBe("foreground");
    expect(out).toEqual([KEEP_ALIVE_RECOMMENDED]);
    expect(KEEP_ALIVE_RECOMMENDED).toContain("--keep-alive");
    expect(KEEP_ALIVE_RECOMMENDED).toMatch(/recommended/i);
    expect(setUp).not.toHaveBeenCalled();
  });

  it("with the flag: installs the service and connect exits instead of running in the foreground", async () => {
    const out: string[] = [];
    expect(
      await finishConnect({
        keepAlive: true,
        setUp: async () => "/h/runtime/node_modules/codex-channel-bgos/dist/cli.js",
        out: (l) => out.push(l),
        err: () => {},
      }),
    ).toBe("service");
    expect(out.join("\n")).toMatch(/background service/i);
    expect(out).not.toContain(KEEP_ALIVE_RECOMMENDED);
  });

  it("a keep-alive install that fails still leaves a working agent: it runs in the foreground", async () => {
    const err: string[] = [];
    expect(
      await finishConnect({
        keepAlive: true,
        setUp: async () => {
          throw new Error("npm could not install 0.19.0: ENOTFOUND");
        },
        out: () => {},
        err: (l) => err.push(l),
      }),
    ).toBe("foreground");
    expect(err.join("\n")).toContain("ENOTFOUND");
  });
});

describe("completeConnect: what connect does once pairing succeeded", () => {
  function run(keepAlive: boolean, setUp: () => Promise<string>) {
    const exit = vi.fn();
    const runForeground = vi.fn(async () => {});
    return {
      exit,
      runForeground,
      done: completeConnect({
        keepAlive,
        setUp,
        out: () => {},
        err: () => {},
        exit,
        runForeground,
      }),
    };
  }

  it("--keep-alive with the service installed: exits 0 and never starts a second, foreground copy", async () => {
    const r = run(true, async () => "/h/runtime/node_modules/codex-channel-bgos/dist/cli.js");
    await r.done;
    expect(r.exit.mock.calls).toEqual([[0]]);
    expect(r.runForeground).not.toHaveBeenCalled();
  });

  it("--keep-alive whose install failed: runs in the foreground, no exit", async () => {
    const r = run(true, async () => {
      throw new Error("EACCES");
    });
    await r.done;
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.runForeground).toHaveBeenCalledTimes(1);
  });

  it("without --keep-alive: the foreground run, as before", async () => {
    const setUp = vi.fn(async () => "/cli.js");
    const r = run(false, setUp);
    await r.done;
    expect(setUp).not.toHaveBeenCalled();
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.runForeground).toHaveBeenCalledTimes(1);
  });
});
