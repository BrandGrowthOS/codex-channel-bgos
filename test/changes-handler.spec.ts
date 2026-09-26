/**
 * The changes lane's handler (P7 stage 3, C-31; BGOS spec 9.2, 10.1, 10.2).
 *
 * The backend sends one `changes_rpc` frame to the pairing room when the
 * owner's Changes panel reads, re emits it ONCE after 1.5 s without an ack,
 * and takes the first result. Several daemons can share one pairing room, so
 * a frame for an agent this daemon does not run gets NOTHING, not even an
 * ack. A frame with an rpcId this daemon owns is always answered exactly
 * once per id: a re sent id is answered from memory, never run twice.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import {
  createChangesHandler,
  normalizeChangesRpc,
  type ChangesRpcFrame,
} from "../src/changes-handler.js";
import {
  collectChanges,
  type ChangesCaps,
  type ChangesFs,
  type ChangesResultBody,
  type RunGit,
} from "../src/git-changes.js";

const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const DASHES = new RegExp(`[${EN_DASH}${EM_DASH}]`);

const OK_BODY: ChangesResultBody = {
  ok: true,
  payload: {
    v: 1,
    state: "ok",
    folder: "billing-export",
    branch: "fix/export-dupes",
    head: "4b825dc",
    numstat: "1\t1\texport.py\0",
    numstatTruncated: false,
    patch: "diff --git a/export.py b/export.py\n",
    patchTruncated: false,
    untracked: "",
    untrackedTruncated: false,
    untrackedFiles: [],
    takenAt: "2026-09-26T09:00:00.000Z",
  },
};

function frame(overrides: Partial<ChangesRpcFrame> = {}): ChangesRpcFrame {
  return {
    rpcId: "rpc-1",
    op: "diff",
    assistantId: "703",
    payload: {
      scope: "uncommitted",
      maxPatchBytes: 1_048_576,
      maxNumstatBytes: 262_144,
      maxUntrackedListBytes: 65_536,
      maxUntrackedTextFiles: 20,
      maxUntrackedTextBytes: 65_536,
      budgetMs: 10_000,
    },
    ...overrides,
  };
}

function harness(
  options: {
    owns?: (assistantId: string) => boolean;
    collect?: (input: {
      workdir: string;
      caps: ChangesCaps;
    }) => Promise<ChangesResultBody>;
    ack?: () => Promise<unknown>;
    result?: () => Promise<unknown>;
    now?: () => number;
  } = {},
) {
  // The clock for the answer hold: every timer the handler asks for is kept
  // here and runs only when a case runs it (parity round, D-R1).
  const timers: Array<{ run: () => void; ms: number }> = [];
  const schedule = (run: () => void, ms: number) => {
    timers.push({ run, ms });
  };
  const events: string[] = [];
  const api = {
    changesRpcAck: vi.fn(async (rpcId: string) => {
      events.push(`ack:${rpcId}`);
      return options.ack ? options.ack() : {};
    }),
    changesRpcResult: vi.fn(async (rpcId: string, _body: ChangesResultBody) => {
      events.push(`result:${rpcId}`);
      return options.result ? options.result() : {};
    }),
  };
  const collect = vi.fn(
    options.collect ?? (async () => OK_BODY),
  );
  const logs: string[] = [];
  const handle = createChangesHandler({
    api,
    workdir: "/home/owner/billing-export",
    owns: options.owns ?? (() => true),
    collect,
    log: (message) => logs.push(message),
    nowImpl: options.now,
    schedule,
  } as Parameters<typeof createChangesHandler>[0]);
  return { handle, api, collect, events, logs, timers };
}

describe("normalizeChangesRpc", () => {
  it("drops a frame with no string rpcId, and keeps everything else to answer", () => {
    expect(normalizeChangesRpc(null)).toBeNull();
    expect(normalizeChangesRpc("changes")).toBeNull();
    expect(normalizeChangesRpc({ op: "diff" })).toBeNull();
    expect(normalizeChangesRpc({ rpcId: 5, op: "diff" })).toBeNull();
    expect(normalizeChangesRpc({ rpcId: "", op: "diff" })).toBeNull();
    expect(
      normalizeChangesRpc({
        rpcId: "rpc-9",
        op: "diff",
        assistantId: 703,
        payload: { scope: "uncommitted" },
      }),
    ).toEqual({
      rpcId: "rpc-9",
      op: "diff",
      assistantId: "703",
      payload: { scope: "uncommitted" },
    });
    // An op that is not a string is still ANSWERED (unsupported), not dropped.
    expect(normalizeChangesRpc({ rpcId: "rpc-10", op: 7 })).toEqual({
      rpcId: "rpc-10",
      op: "",
      assistantId: "",
      payload: {},
    });
  });
});

describe("createChangesHandler", () => {
  it("acks, then always posts one result", async () => {
    const h = harness();
    await h.handle(frame());
    expect(h.events).toEqual(["ack:rpc-1", "result:rpc-1"]);
    expect(h.api.changesRpcResult).toHaveBeenCalledTimes(1);
    expect(h.api.changesRpcResult).toHaveBeenCalledWith("rpc-1", OK_BODY);
    // The collector reads the daemon's own folder with the frame's caps.
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(h.collect.mock.calls[0]![0]).toEqual({
      workdir: "/home/owner/billing-export",
      caps: {
        maxPatchBytes: 1_048_576,
        maxNumstatBytes: 262_144,
        maxUntrackedListBytes: 65_536,
        maxUntrackedTextFiles: 20,
        maxUntrackedTextBytes: 65_536,
        budgetMs: 10_000,
      },
    });
  });

  it("drops a frame with no rpcId; answers an unknown op unsupported and a scope other than uncommitted bad_request", async () => {
    const h = harness();
    await h.handle(frame({ rpcId: "rpc-op", op: "stage" }));
    await h.handle(
      frame({ rpcId: "rpc-scope", payload: { scope: "branch" } }),
    );
    await h.handle(frame({ rpcId: "rpc-none", payload: {} }));
    expect(h.events).toEqual([
      "ack:rpc-op",
      "result:rpc-op",
      "ack:rpc-scope",
      "result:rpc-scope",
      "ack:rpc-none",
      "result:rpc-none",
    ]);
    const bodies = h.api.changesRpcResult.mock.calls.map((call) => call[1]);
    expect(bodies[0]).toEqual({
      ok: false,
      error: { code: "unsupported", message: expect.any(String) },
    });
    expect(bodies[1]).toEqual({
      ok: false,
      error: { code: "bad_request", message: expect.any(String) },
    });
    expect(bodies[2]).toEqual(bodies[1]);
    expect(h.collect).not.toHaveBeenCalled();
    // The socket layer drops a frame with no rpcId before it gets here.
    expect(normalizeChangesRpc({ op: "diff", assistantId: "703" })).toBeNull();
  });

  it("gives an agent this daemon does not own nothing, once the scope is loaded", async () => {
    const h = harness({ owns: (id) => id === "703" });
    await h.handle(frame({ assistantId: "704" }));
    expect(h.events).toEqual([]);
    expect(h.collect).not.toHaveBeenCalled();
    // Its own agent is answered.
    await h.handle(frame({ rpcId: "rpc-own" }));
    expect(h.events).toEqual(["ack:rpc-own", "result:rpc-own"]);
  });

  it("answers before the scope loads, because the backend routed the frame here", async () => {
    // The adapter's own rule, the one the mission frames already use: before
    // the first scope load an empty route map means UNKNOWN, not empty.
    const adapter = Object.create(CodexAdapter.prototype) as any;
    Object.assign(adapter, {
      identityReady: false,
      assistantToRoute: new Map<number, string>(),
    });
    const owns = (id: string): boolean =>
      adapter.ownsAssistantForMission(Number(id));

    const h = harness({ owns });
    await h.handle(frame({ rpcId: "rpc-cold" }));
    expect(h.events).toEqual(["ack:rpc-cold", "result:rpc-cold"]);

    // Once the scope is in, an agent it does not list gets nothing, and one
    // it lists is answered.
    adapter.identityReady = true;
    await h.handle(frame({ rpcId: "rpc-warm-other" }));
    expect(h.events).toHaveLength(2);
    adapter.assistantToRoute.set(703, "codex");
    await h.handle(frame({ rpcId: "rpc-warm-own" }));
    expect(h.events.slice(2)).toEqual(["ack:rpc-warm-own", "result:rpc-warm-own"]);
  });

  it("never runs a re sent frame twice, and answers it again from memory", async () => {
    let release!: (body: ChangesResultBody) => void;
    const pending = new Promise<ChangesResultBody>((resolve) => {
      release = resolve;
    });
    const h = harness({ collect: () => pending });

    const first = h.handle(frame());
    // The backend's one re emit, while the first read is still running.
    await h.handle(frame());
    expect(h.events).toEqual(["ack:rpc-1"]);

    release(OK_BODY);
    await first;
    expect(h.events).toEqual(["ack:rpc-1", "result:rpc-1"]);

    // The same id after it was answered: the same answer, Git not run again.
    await h.handle(frame());
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(h.api.changesRpcResult).toHaveBeenCalledTimes(2);
    expect(h.api.changesRpcResult.mock.calls[1]).toEqual(["rpc-1", OK_BODY]);
  });

  it("remembers the last 256 ids", async () => {
    const h = harness();
    for (let i = 1; i <= 257; i += 1) {
      await h.handle(frame({ rpcId: `rpc-${i}` }));
    }
    expect(h.collect).toHaveBeenCalledTimes(257);
    // rpc-2 is still remembered: answered from memory.
    await h.handle(frame({ rpcId: "rpc-2" }));
    expect(h.collect).toHaveBeenCalledTimes(257);
    // rpc-1 was the oldest of 257 and is forgotten: it runs again.
    await h.handle(frame({ rpcId: "rpc-1" }));
    expect(h.collect).toHaveBeenCalledTimes(258);
  });

  it("keeps the answer itself for the newest 8 ids only, so 256 remembered ids never hold 256 patches", async () => {
    // One answer can carry a 1 MB patch and 20 new files. The backend re
    // emits once, 1.5 s after the frame, and waits 20 s at most, so only the
    // newest answers can ever be asked for again.
    const h = harness();
    for (let i = 1; i <= 10; i += 1) {
      await h.handle(frame({ rpcId: `rpc-${i}` }));
    }
    expect(h.api.changesRpcResult).toHaveBeenCalledTimes(10);
    // An old id is still remembered (Git never runs twice) but its answer is
    // gone, and the backend stopped waiting for it long ago: nothing is sent.
    await h.handle(frame({ rpcId: "rpc-1" }));
    await h.handle(frame({ rpcId: "rpc-2" }));
    expect(h.collect).toHaveBeenCalledTimes(10);
    expect(h.api.changesRpcResult).toHaveBeenCalledTimes(10);
    // One of the newest 8 is answered again from memory.
    await h.handle(frame({ rpcId: "rpc-3" }));
    expect(h.collect).toHaveBeenCalledTimes(10);
    expect(h.api.changesRpcResult).toHaveBeenCalledTimes(11);
    expect(h.api.changesRpcResult.mock.calls[10]).toEqual(["rpc-3", OK_BODY]);
  });

  // Parity round, D-R1 (lane D's review): the answer is held only for the
  // backend's own hold. The backend re emits once, 1.5 s after the frame,
  // takes the first result, and gives up at CHANGES_READ_TIMEOUT_MS (20 s,
  // backend/src/changes-panel/changes-panel.service.ts); anything later is
  // logged as a late result and dropped. A copy kept past that buys nothing,
  // and the newest 8 would otherwise stay in a daemon that runs for days.
  it("keeps a whole answer for the backend's 20 s hold, then lets it go: a later re send runs nothing and posts nothing", async () => {
    const h = harness();
    await h.handle(frame());
    // The re emit inside the hold: the same answer again, Git not run again.
    await h.handle(frame());
    expect(h.collect).toHaveBeenCalledTimes(1);
    expect(h.api.changesRpcResult).toHaveBeenCalledTimes(2);
    expect(h.api.changesRpcResult.mock.calls[1]).toEqual(["rpc-1", OK_BODY]);

    // The hold runs out.
    for (const timer of h.timers.splice(0)) timer.run();
    await h.handle(frame());
    expect(
      h.api.changesRpcResult,
      "a re send past the hold posts nothing",
    ).toHaveBeenCalledTimes(2);
    expect(
      h.collect,
      "Git never runs twice, even after the answer is let go",
    ).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual(["ack:rpc-1", "result:rpc-1", "result:rpc-1"]);
  });

  it("the hold is the backend's own 20 s, one timer per answer, and every answer is held, a failure too", async () => {
    const h = harness();
    await h.handle(frame({ rpcId: "rpc-ok" }));
    await h.handle(frame({ rpcId: "rpc-op", op: "stage" }));
    expect(h.timers.map((timer) => timer.ms)).toEqual([20_000, 20_000]);

    // Only the answer whose hold ran out is let go.
    h.timers[0]!.run();
    await h.handle(frame({ rpcId: "rpc-ok" }));
    await h.handle(frame({ rpcId: "rpc-op", op: "stage" }));
    const posted = h.api.changesRpcResult.mock.calls.map((call) => call[0]);
    expect(posted, "only the answer whose hold ran out is let go").toEqual([
      "rpc-ok",
      "rpc-op",
      "rpc-op",
    ]);
    expect(h.collect).toHaveBeenCalledTimes(1);
  });

  it("with no clock injected the hold is a real 20 s timer that never keeps the daemon alive", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const api = {
        changesRpcAck: vi.fn(async () => ({})),
        changesRpcResult: vi.fn(async () => ({})),
      };
      const collect = vi.fn(async () => OK_BODY);
      const handle = createChangesHandler({
        api,
        workdir: "/home/owner/billing-export",
        owns: () => true,
        collect,
      });
      await handle(frame());
      const holds = setTimeoutSpy.mock.calls
        .map((call, index) => ({ ms: call[1], timer: setTimeoutSpy.mock.results[index]!.value }))
        .filter((entry) => entry.ms === 20_000);
      expect(holds).toHaveLength(1);
      expect(
        (holds[0]!.timer as { hasRef(): boolean }).hasRef(),
        "the hold timer is unref'd",
      ).toBe(false);

      vi.advanceTimersByTime(19_999);
      await handle(frame());
      expect(api.changesRpcResult).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      await handle(frame());
      expect(api.changesRpcResult).toHaveBeenCalledTimes(2);
      expect(collect).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("each read makes its own Git runner, so Git is looked up on PATH per read, never once for the daemon's life", async () => {
    // Parity round, D-R2: Git runs by the absolute path found on PATH's
    // absolute entries, looked up once per read, so a Git installed, moved
    // or removed while the daemon runs is what the next read finds.
    const notGit: RunGit = async () => ({
      code: 128,
      stdout: "",
      stderr:
        "fatal: not a git repository (or any of the parent directories): .git\n",
      truncated: false,
    });
    const newRunGit = vi.fn(() => notGit);
    const api = {
      changesRpcAck: vi.fn(async () => ({})),
      changesRpcResult: vi.fn(async (_rpcId: string, _body: ChangesResultBody) => ({})),
    };
    const handle = createChangesHandler({
      api,
      workdir: "/home/owner/billing-export",
      owns: () => true,
      newRunGit,
      schedule: () => {},
    } as Parameters<typeof createChangesHandler>[0]);
    expect(newRunGit, "nothing is looked up before a read").not.toHaveBeenCalled();
    await handle(frame({ rpcId: "rpc-a" }));
    await handle(frame({ rpcId: "rpc-b" }));
    expect(newRunGit, "one runner per read").toHaveBeenCalledTimes(2);
    expect(
      api.changesRpcResult.mock.calls.map(([, body]) => body.ok && body.payload.state),
    ).toEqual(["not_git", "not_git"]);
  });

  it("a failed ack does not stop the work", async () => {
    const h = harness({
      ack: () => Promise.reject(new Error("Request failed with status code 502")),
    });
    await h.handle(frame());
    expect(h.api.changesRpcResult).toHaveBeenCalledWith("rpc-1", OK_BODY);
    await Promise.resolve();
    expect(h.logs.some((line) => line.includes("ack failed"))).toBe(true);
  });

  it("a throw answers read_failed, short and dash free", async () => {
    const long = `fatal ${EM_DASH} ${"x".repeat(880)} ${EN_DASH} end`;
    const h = harness({
      collect: async () => {
        throw new Error(long);
      },
    });
    await h.handle(frame());
    const body = h.api.changesRpcResult.mock.calls[0]![1];
    expect(body.ok).toBe(false);
    if (body.ok) return;
    expect(body.error.code).toBe("read_failed");
    expect(body.error.message.startsWith(
      "changes could not be read on the agent host",
    )).toBe(true);
    expect(body.error.message.length).toBeLessThanOrEqual(300);
    expect(body.error.message).not.toMatch(DASHES);
  });

  it("a Git failure answers read_failed with the command and its exit code only; Git's own words, which can name the owner's folder, stay in the local log", async () => {
    // A workspace owned by another account: Git's message names the
    // absolute path, and so the operating system user (spec 9.3 and 10.1
    // rule 8). The REAL collector throws it here.
    const stderr =
      "fatal: detected dubious ownership in repository at 'C:/Users/owner/.codex-bgos/workspace'\n";
    const runGit: RunGit = async () => ({
      code: 128,
      stdout: "",
      stderr,
      truncated: false,
    });
    const unusedFs: ChangesFs = {
      lstat: async () => {
        throw new Error("not read");
      },
      readAtMost: async () => {
        throw new Error("not read");
      },
    };
    const h = harness({
      collect: (input) => collectChanges({ ...input, runGit, fs: unusedFs }),
    });
    await h.handle(frame());
    expect(h.api.changesRpcResult.mock.calls[0]![1]).toEqual({
      ok: false,
      error: {
        code: "read_failed",
        message:
          "changes could not be read on the agent host: git rev-parse exited 128",
      },
    });
    // Git's own line is kept on this computer, in the daemon's log.
    expect(h.logs.some((line) => line.includes("dubious ownership"))).toBe(true);

    // Anything else thrown answers the spec's sentence alone.
    const other = harness({
      collect: async () => {
        throw new Error(
          "EPERM: operation not permitted, open 'C:\\Users\\owner\\notes.txt'",
        );
      },
    });
    await other.handle(frame());
    expect(other.api.changesRpcResult.mock.calls[0]![1]).toEqual({
      ok: false,
      error: {
        code: "read_failed",
        message: "changes could not be read on the agent host",
      },
    });
    expect(other.logs.some((line) => line.includes("EPERM"))).toBe(true);
  });

  it("passes the collector's too_slow through, dash free", async () => {
    const h = harness({
      collect: async () => ({
        ok: false,
        error: { code: "too_slow", message: `slow ${EN_DASH} really` },
      }),
    });
    await h.handle(frame());
    expect(h.api.changesRpcResult.mock.calls[0]![1]).toEqual({
      ok: false,
      error: { code: "too_slow", message: "slow - really" },
    });
  });

  it("retries the result once, only while it can still land within 18 s of the frame's arrival", async () => {
    // Arrival at 0; the first post fails at 1 s; 1 s plus the 8 s post
    // timeout lands at 9 s, inside 18 s: one retry.
    let clock = 0;
    let fails = 1;
    const h = harness({
      now: () => clock,
      collect: async () => {
        clock = 1_000;
        return OK_BODY;
      },
      result: async () => {
        if (fails > 0) {
          fails -= 1;
          throw new Error("timeout of 8000ms exceeded");
        }
        return {};
      },
    });
    await h.handle(frame());
    expect(h.api.changesRpcResult).toHaveBeenCalledTimes(2);

    // The same failure at 10.5 s: a retry could not land by 18 s, so none.
    clock = 0;
    fails = 5;
    const late = harness({
      now: () => clock,
      collect: async () => {
        clock = 10_500;
        return OK_BODY;
      },
      result: async () => {
        throw new Error("timeout of 8000ms exceeded");
      },
    });
    await late.handle(frame());
    expect(late.api.changesRpcResult).toHaveBeenCalledTimes(1);
    expect(late.logs.some((line) => line.includes("result failed"))).toBe(true);
  });

  it("reads the owner's Changes switch nowhere in src/", () => {
    // The switch is enforced by the backend, which sends no frame while it
    // is off. A plugin that read a per agent setting would be a second gate
    // nobody can see (spec F4 and 10.1 rule 9).
    function sourceFiles(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.isFile() && full.endsWith(".ts") ? [full] : [];
      });
    }
    const files = sourceFiles("src");
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((file) => file.endsWith("changes-handler.ts"))).toBe(true);
    const offenders = files.filter((file) =>
      /showChanges|show_changes/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
