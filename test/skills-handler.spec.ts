import {
  execFile,
  type ExecFileException,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSkillsHandler,
  normalizeSkillsRpc,
  resolveCodexBin,
  type SkillsRpcFrame,
} from "../src/skills-handler.js";

interface ExecStep {
  args: string[];
  timeout: number;
  stdout?: string;
  stderr?: string;
  error?: ExecFileException;
  event?: string;
}

type ExecCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

function createExecMock(steps: ExecStep[], events: string[]) {
  return vi.fn(
    (
      file: string,
      args: string[],
      options: { timeout?: number },
      callback: ExecCallback,
    ) => {
      const step = steps.shift();
      if (!step) throw new Error(`unexpected exec: ${args.join(" ")}`);
      events.push(step.event ?? `exec:${args.join(" ")}`);
      expect(file).toBe("/test/codex");
      expect(args).toEqual(step.args);
      expect(options).toEqual({ timeout: step.timeout });
      queueMicrotask(() =>
        callback(
          step.error ?? null,
          step.stdout ?? "",
          step.stderr ?? "",
        ),
      );
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function createApiMock(events: string[]) {
  return {
    skillsRpcAck: vi.fn(async (_rpcId: string) => {
      events.push("ack");
      return {};
    }),
    skillsRpcProgress: vi.fn(
      async (_rpcId: string, body: { stage: string; detail?: string }) => {
        events.push(`progress:${body.stage}`);
        return {};
      },
    ),
    skillsRpcResult: vi.fn(
      async (
        _rpcId: string,
        _body: {
          ok: boolean;
          payload?: Record<string, unknown>;
          error?: { code: string; message: string };
        },
      ) => {
        events.push("result");
        return {};
      },
    ),
  };
}

function frame(
  op: string,
  payload: SkillsRpcFrame["payload"] = {},
  rpcId = `rpc-${op}`,
): SkillsRpcFrame {
  return { rpcId, op, assistantId: "assistant-1", payload };
}

function setup(steps: ExecStep[] = []) {
  const events: string[] = [];
  const api = createApiMock(events);
  const execFileMock = createExecMock(steps, events);
  const log = vi.fn();
  let nowMs = 0;
  const readFileImpl = vi.fn((path: string, encoding: "utf8") =>
    readFile(path, encoding),
  );
  const sleepImpl = vi.fn(async (delayMs: number) => {
    nowMs += delayMs;
  });
  const advanceTime = (delayMs: number): void => {
    nowMs += delayMs;
  };
  const handler = createSkillsHandler({
    api,
    execFileImpl: execFileMock as unknown as typeof execFile,
    codexBin: "/test/codex",
    log,
    nowImpl: () => nowMs,
    readFileImpl,
    sleepImpl,
  });
  return {
    api,
    advanceTime,
    events,
    execFileMock,
    handler,
    log,
    readFileImpl,
    sleepImpl,
    steps,
  };
}

function installedJson(
  entries: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({ installed: entries });
}

describe("createSkillsHandler", () => {
  it.each([
    {
      op: "list_installed",
      payload: {},
      steps: [
        {
          args: ["plugin", "list", "--json"],
          timeout: 60_000,
          stdout: installedJson([]),
        },
      ],
    },
    {
      op: "catalog",
      payload: {},
      steps: [
        {
          args: ["plugin", "list", "--available", "--json"],
          timeout: 60_000,
          stdout: JSON.stringify({ available: [], installed: [] }),
        },
      ],
    },
    {
      op: "install",
      payload: { identifier: "writer@market" },
      steps: [
        {
          args: ["plugin", "list", "--json"],
          timeout: 60_000,
          stdout: installedJson([]),
        },
        {
          args: ["plugin", "add", "writer@market", "--json"],
          timeout: 120_000,
          stdout: JSON.stringify({
            pluginId: "writer@market",
            name: "Writer",
          }),
        },
        {
          args: ["plugin", "list", "--json"],
          timeout: 60_000,
          stdout: installedJson([
            { pluginId: "writer@market", name: "Writer" },
          ]),
        },
      ],
    },
    {
      op: "remove",
      payload: { identifier: "writer@market" },
      steps: [
        {
          args: ["plugin", "remove", "writer@market"],
          timeout: 60_000,
          stdout: "Removed plugin writer@market",
        },
        {
          args: ["plugin", "list", "--json"],
          timeout: 60_000,
          stdout: installedJson([]),
        },
      ],
    },
  ])("posts ack before any exec for $op", async ({ op, payload, steps }) => {
    const ctx = setup(steps);

    await ctx.handler(frame(op, payload));

    expect(ctx.events[0]).toBe("ack");
    expect(ctx.events.findIndex((event) => event.startsWith("exec:"))).toBeGreaterThan(0);
    expect(ctx.steps).toHaveLength(0);
  });

  it("maps installed plugin JSON to the wire skills shape", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([
          {
            pluginId: "writer@official",
            name: "Writer",
            marketplaceName: "official",
            version: "1.2.3",
            interface: { description: "Writes polished copy" },
            installed: true,
          },
        ]),
      },
    ]);

    await ctx.handler(frame("list_installed"));

    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-list_installed", {
      ok: true,
      payload: {
        skills: [
          {
            identifier: "writer@official",
            name: "Writer",
            description: "Writes polished copy",
            provenance: "plugin",
            removable: true,
            source: "writer@official",
            publisher: "official",
            version: "1.2.3",
          },
        ],
      },
    });
  });

  it("uses interface descriptions and caps child-derived wire strings", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([
          {
            pluginId: "writer@official",
            name: "n".repeat(350),
            marketplaceName: "p".repeat(350),
            version: "v".repeat(350),
            description: "wrong top-level description",
            interface: { description: "d".repeat(350) },
          },
        ]),
      },
    ]);

    await ctx.handler(frame("list_installed"));

    const result = ctx.api.skillsRpcResult.mock.calls[0]?.[1];
    const skills = result?.payload?.skills as Array<Record<string, unknown>>;
    expect(skills[0]).toMatchObject({
      identifier: "writer@official",
      name: "n".repeat(300),
      description: "d".repeat(300),
      source: "writer@official",
      publisher: "p".repeat(300),
      version: "v".repeat(300),
    });
  });

  it("maps, filters, and paginates a 35 plugin catalog", async () => {
    const plugins = Array.from({ length: 35 }, (_, index) => ({
      pluginId: `plugin-${index + 1}@market`,
      name: `Plugin ${index + 1}`,
      marketplaceName: "market",
      interface: { description: `PLUGIN helper ${index + 1}` },
      installed: index === 0,
    }));
    const ctx = setup([
      {
        args: ["plugin", "list", "--available", "--json"],
        timeout: 60_000,
        stdout: JSON.stringify({
          installed: plugins,
        }),
      },
    ]);

    await ctx.handler(frame("catalog", { query: "pLuGiN", page: 2 }));

    const result = ctx.api.skillsRpcResult.mock.calls[0]?.[1];
    expect(result).toMatchObject({
      ok: true,
      payload: { page: 2, totalPages: 2, total: 35 },
    });
    const items = result?.payload?.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({
      identifier: "plugin-31@market",
      name: "Plugin 31",
      description: "PLUGIN helper 31",
      source: "market",
      installed: false,
    });

    const firstPageCtx = setup([
      {
        args: ["plugin", "list", "--available", "--json"],
        timeout: 60_000,
        stdout: JSON.stringify({ installed: plugins }),
      },
    ]);
    await firstPageCtx.handler(frame("catalog", { page: 1 }));
    const firstPageResult = firstPageCtx.api.skillsRpcResult.mock.calls[0]?.[1];
    const firstPageItems = firstPageResult?.payload?.items as Array<
      Record<string, unknown>
    >;
    expect(firstPageItems[0]?.installed).toBe(true);
  });

  it("enriches catalog and installed items from a cached local manifest", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "skills-manifest-"));
    const pluginDir = join(fixtureRoot, "writer");
    mkdirSync(join(pluginDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        description: "d".repeat(350),
        author: { name: "Fixture Author" },
        interface: {
          developerName: "Fixture Publisher",
          category: "Writing",
        },
      }),
    );
    const source = { source: "local", path: pluginDir };
    const ctx = setup([
      {
        args: ["plugin", "list", "--available", "--json"],
        timeout: 60_000,
        stdout: JSON.stringify({
          installed: [],
          available: [
            {
              pluginId: "writer@market",
              name: "Writer",
              marketplaceName: "market",
              source,
            },
            {
              pluginId: "editor@market",
              name: "Editor",
              marketplaceName: "market",
              source,
            },
          ],
        }),
      },
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([
          {
            pluginId: "writer@market",
            name: "Writer",
            marketplaceName: "market",
            source,
          },
        ]),
      },
    ]);

    try {
      await ctx.handler(frame("catalog"));

      const catalogResult = ctx.api.skillsRpcResult.mock.calls[0]?.[1];
      const items = catalogResult?.payload?.items as Array<
        Record<string, unknown>
      >;
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item).toMatchObject({
          description: "d".repeat(300),
          publisher: "Fixture Publisher",
          category: "Writing",
        });
      }
      expect(ctx.readFileImpl).toHaveBeenCalledTimes(1);

      await ctx.handler(
        frame("list_installed", {}, "rpc-installed-manifest"),
      );

      const installedResult = ctx.api.skillsRpcResult.mock.calls[1]?.[1];
      const skills = installedResult?.payload?.skills as Array<
        Record<string, unknown>
      >;
      expect(skills[0]).toMatchObject({
        identifier: "writer@market",
        description: "d".repeat(300),
        publisher: "Fixture Publisher",
        category: "Writing",
      });
      expect(ctx.readFileImpl).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("ignores an invalid local plugin manifest", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "skills-manifest-"));
    const pluginDir = join(fixtureRoot, "broken");
    mkdirSync(join(pluginDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".codex-plugin", "plugin.json"),
      "not json",
    );
    const ctx = setup([
      {
        args: ["plugin", "list", "--available", "--json"],
        timeout: 60_000,
        stdout: JSON.stringify({
          installed: [],
          available: [
            {
              pluginId: "broken@market",
              name: "Broken",
              marketplaceName: "market",
              source: { source: "local", path: pluginDir },
            },
          ],
        }),
      },
    ]);

    try {
      await ctx.handler(frame("catalog"));

      const result = ctx.api.skillsRpcResult.mock.calls[0]?.[1];
      expect(result?.payload?.items).toEqual([
        {
          identifier: "broken@market",
          name: "Broken",
          description: "",
          source: "market",
          installed: false,
        },
      ]);
      expect(ctx.readFileImpl).toHaveBeenCalledOnce();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("installs with ordered progress, verification, and a host-global note", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
        event: "exec:precheck",
      },
      {
        args: ["plugin", "add", "writer@market", "--json"],
        timeout: 120_000,
        stdout: JSON.stringify({
          pluginId: "writer@market",
          name: "Writer",
        }),
        event: "exec:add",
      },
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([
          { pluginId: "writer@market", name: "Writer" },
        ]),
        event: "exec:verify",
      },
    ]);

    await ctx.handler(frame("install", { identifier: "writer@market" }));

    expect(ctx.events).toEqual([
      "ack",
      "progress:starting",
      "exec:precheck",
      "progress:installing",
      "exec:add",
      "progress:verifying",
      "exec:verify",
      "result",
    ]);
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-install", {
      ok: true,
      payload: {
        name: "Writer",
        note: "Installed for every Codex session on this computer",
      },
    });
  });

  it("continues an install when progress posts fail", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
      },
      {
        args: ["plugin", "add", "writer@market", "--json"],
        timeout: 120_000,
        stdout: JSON.stringify({
          pluginId: "writer@market",
          name: "Writer",
        }),
      },
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([
          { pluginId: "writer@market", name: "Writer" },
        ]),
      },
    ]);
    ctx.api.skillsRpcProgress.mockRejectedValue(
      new Error("progress unavailable"),
    );

    await ctx.handler(frame("install", { identifier: "writer@market" }));

    expect(ctx.execFileMock).toHaveBeenCalledTimes(3);
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-install", {
      ok: true,
      payload: {
        name: "Writer",
        note: "Installed for every Codex session on this computer",
      },
    });
    expect(ctx.log).toHaveBeenCalledTimes(3);
  });

  it("rejects an unsafe install identifier without spawning a process", async () => {
    const ctx = setup();

    await expect(
      ctx.handler(frame("install", { identifier: "bad id; rm -rf" })),
    ).resolves.toBeUndefined();

    expect(ctx.execFileMock).not.toHaveBeenCalled();
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-install", {
      ok: false,
      error: { code: "install_failed", message: "invalid identifier" },
    });
  });

  it("returns already_installed without calling plugin add", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([
          { pluginId: "writer@market", name: "Writer" },
        ]),
      },
    ]);

    await ctx.handler(frame("install", { identifier: "writer@market" }));

    expect(ctx.execFileMock).toHaveBeenCalledTimes(1);
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-install", {
      ok: false,
      error: {
        code: "already_installed",
        message: "plugin is already installed",
      },
    });
  });

  it("maps not found install stderr to not_found", async () => {
    const addError = Object.assign(new Error("exit 1"), {
      code: 1,
    }) as ExecFileException;
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
      },
      {
        args: ["plugin", "add", "missing@market", "--json"],
        timeout: 120_000,
        error: addError,
        stderr: "plugin not found in marketplace",
      },
    ]);

    await ctx.handler(frame("install", { identifier: "missing@market" }));

    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-install", {
      ok: false,
      error: {
        code: "not_found",
        message: "plugin not found in marketplace",
      },
    });
  });

  it("maps other install stderr to a truncated install_failed error", async () => {
    const stderr = `install exploded: ${"x".repeat(400)}`;
    const addError = Object.assign(new Error("exit 1"), {
      code: 1,
    }) as ExecFileException;
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
      },
      {
        args: ["plugin", "add", "writer@market", "--json"],
        timeout: 120_000,
        error: addError,
        stderr,
      },
    ]);

    await ctx.handler(frame("install", { identifier: "writer@market" }));

    const result = ctx.api.skillsRpcResult.mock.calls[0]?.[1];
    expect(result).toEqual({
      ok: false,
      error: {
        code: "install_failed",
        message: stderr.slice(0, 300),
      },
    });
    expect(result?.error?.message).toHaveLength(300);
  });

  it("detects not found text after the forwarded stderr limit", async () => {
    const stderr = `${"x".repeat(320)} plugin not found in marketplace`;
    const addError = Object.assign(new Error("exit 1"), {
      code: 1,
    }) as ExecFileException;
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
      },
      {
        args: ["plugin", "add", "missing@market", "--json"],
        timeout: 120_000,
        error: addError,
        stderr,
      },
    ]);

    await ctx.handler(frame("install", { identifier: "missing@market" }));

    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-install", {
      ok: false,
      error: { code: "not_found", message: stderr.slice(0, 300) },
    });
  });

  it("settles an unknown op as unsupported", async () => {
    const ctx = setup();

    await ctx.handler(frame("future_op"));

    expect(ctx.execFileMock).not.toHaveBeenCalled();
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-future_op", {
      ok: false,
      error: { code: "install_failed", message: "unsupported op" },
    });
  });

  it("deduplicates rpcIds before posting a second ack", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
      },
    ]);
    const request = frame("list_installed", {}, "rpc-duplicate");

    await ctx.handler(request);
    await ctx.handler(request);

    expect(ctx.api.skillsRpcAck).toHaveBeenCalledTimes(1);
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledTimes(1);
    expect(ctx.execFileMock).toHaveBeenCalledTimes(1);
  });

  it("prefers a canonical remove identifier and verifies absence", async () => {
    const ctx = setup([
      {
        args: ["plugin", "remove", "name@marketplace"],
        timeout: 60_000,
        stdout: "Removed plugin name@marketplace",
      },
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
      },
    ]);

    await ctx.handler(
      frame("remove", {
        identifier: "name@marketplace",
        name: "Display Name",
      }),
    );

    expect(ctx.execFileMock.mock.calls[0]?.[1]).toEqual([
      "plugin",
      "remove",
      "name@marketplace",
    ]);
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-remove", {
      ok: true,
      payload: {},
    });
  });

  it("resolves a display name to its installed plugin identifier", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([
          { pluginId: "writer@official", name: "Writer" },
        ]),
      },
      {
        args: ["plugin", "remove", "writer@official"],
        timeout: 60_000,
        stdout: "Removed plugin writer@official",
      },
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
      },
    ]);

    await ctx.handler(frame("remove", { name: "Writer" }));

    expect(ctx.execFileMock.mock.calls.map((call) => call[1])).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "remove", "writer@official"],
      ["plugin", "list", "--json"],
    ]);
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-remove", {
      ok: true,
      payload: {},
    });
  });

  it("resolves the same fallback name published for a nameless plugin", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([{ pluginId: "writer@official" }]),
      },
      {
        args: ["plugin", "remove", "writer@official"],
        timeout: 60_000,
        stdout: "Removed plugin writer@official",
      },
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([]),
      },
    ]);

    await ctx.handler(frame("remove", { name: "writer@official" }));

    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-remove", {
      ok: true,
      payload: {},
    });
  });

  it("rejects an ambiguous display name without removing a plugin", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: installedJson([
          { pluginId: "writer@official", name: "Writer" },
          { pluginId: "writer@community", name: "Writer" },
        ]),
      },
    ]);

    await ctx.handler(frame("remove", { name: "Writer" }));

    expect(ctx.execFileMock).toHaveBeenCalledTimes(1);
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-remove", {
      ok: false,
      error: {
        code: "install_failed",
        message: "installed plugin name did not resolve to one identifier",
      },
    });
  });

  it("rejects an unsafe remove identifier without spawning a process", async () => {
    const ctx = setup();

    await ctx.handler(
      frame("remove", { identifier: "bad name; rm -rf" }),
    );

    expect(ctx.execFileMock).not.toHaveBeenCalled();
    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-remove", {
      ok: false,
      error: { code: "install_failed", message: "invalid identifier" },
    });
  });

  it("does not treat malformed list JSON as successful remove verification", async () => {
    const ctx = setup([
      {
        args: ["plugin", "remove", "name@marketplace"],
        timeout: 60_000,
        stdout: "Removed plugin name@marketplace",
      },
      {
        args: ["plugin", "list", "--json"],
        timeout: 60_000,
        stdout: JSON.stringify({}),
      },
    ]);

    await ctx.handler(
      frame("remove", { identifier: "name@marketplace" }),
    );

    expect(ctx.api.skillsRpcResult).toHaveBeenCalledWith("rpc-remove", {
      ok: false,
      error: {
        code: "install_failed",
        message: "invalid Codex plugin list response",
      },
    });
  });

  it("never rejects when ack and result delivery both fail", async () => {
    const ctx = setup();
    ctx.api.skillsRpcAck.mockRejectedValueOnce(new Error("ack unavailable"));
    ctx.api.skillsRpcResult.mockRejectedValue(
      new Error("result unavailable"),
    );

    await expect(ctx.handler(frame("future_op"))).resolves.toBeUndefined();
  });

  it("retries a transient result failure and delivers once", async () => {
    const ctx = setup();
    let deliveries = 0;
    ctx.api.skillsRpcResult
      .mockRejectedValueOnce(new Error("result unavailable"))
      .mockImplementationOnce(async () => {
        deliveries += 1;
        return {};
      });

    await ctx.handler(frame("future_op"));

    expect(ctx.api.skillsRpcResult).toHaveBeenCalledTimes(2);
    expect(ctx.api.skillsRpcResult.mock.calls[1]).toEqual(
      ctx.api.skillsRpcResult.mock.calls[0],
    );
    expect(ctx.api.skillsRpcResult.mock.calls[1]?.[1]).toBe(
      ctx.api.skillsRpcResult.mock.calls[0]?.[1],
    );
    expect(ctx.sleepImpl).toHaveBeenCalledWith(2_000);
    expect(deliveries).toBe(1);
  });

  it("stops bounded result retries after four failed attempts", async () => {
    const ctx = setup();
    ctx.api.skillsRpcResult.mockRejectedValue(
      new Error("result unavailable"),
    );

    await ctx.handler(frame("future_op"));

    expect(ctx.api.skillsRpcResult).toHaveBeenCalledTimes(4);
    const bodies = ctx.api.skillsRpcResult.mock.calls.map((call) => call[1]);
    expect(bodies.every((body) => body === bodies[0])).toBe(true);
    expect(ctx.sleepImpl.mock.calls).toEqual([
      [2_000],
      [3_000],
      [5_000],
    ]);
    expect(ctx.log).toHaveBeenCalledOnce();
    expect(ctx.log).toHaveBeenCalledWith(
      "skills_rpc result failed: result unavailable",
    );
  });

  it("skips retries that cannot finish before the broker deadline", async () => {
    const ctx = setup([
      {
        args: ["plugin", "list", "--available", "--json"],
        timeout: 60_000,
        stdout: JSON.stringify({ installed: [], available: [] }),
      },
    ]);
    ctx.api.skillsRpcAck.mockImplementationOnce(async () => {
      ctx.advanceTime(18_000);
      return {};
    });
    ctx.api.skillsRpcResult.mockRejectedValue(
      new Error("result unavailable"),
    );

    await ctx.handler(frame("catalog"));

    expect(ctx.api.skillsRpcResult).toHaveBeenCalledOnce();
    expect(ctx.sleepImpl).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(
      "skills_rpc result failed: result unavailable",
    );
  });
});

describe("normalizeSkillsRpc", () => {
  it("coerces assistantId and defaults a non-object payload", () => {
    expect(
      normalizeSkillsRpc({
        rpcId: "rpc-1",
        op: "catalog",
        assistantId: 42,
        payload: null,
      }),
    ).toEqual({
      rpcId: "rpc-1",
      op: "catalog",
      assistantId: "42",
      payload: {},
    });
  });

  it("drops malformed frames but passes unknown string ops", () => {
    expect(normalizeSkillsRpc(null)).toBeNull();
    expect(normalizeSkillsRpc({ rpcId: "", op: "catalog" })).toBeNull();
    expect(normalizeSkillsRpc({ rpcId: "rpc-1", op: 42 })).toBeNull();
    expect(
      normalizeSkillsRpc({
        rpcId: "rpc-2",
        op: "future_op",
        assistantId: "7",
        payload: {},
      }),
    ).toMatchObject({ op: "future_op" });
  });
});

describe("resolveCodexBin", () => {
  const original = process.env.CODEX_BGOS_CODEX_BIN;

  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_BGOS_CODEX_BIN;
    else process.env.CODEX_BGOS_CODEX_BIN = original;
  });

  it("honors CODEX_BGOS_CODEX_BIN", () => {
    process.env.CODEX_BGOS_CODEX_BIN = " /custom/codex ";
    expect(resolveCodexBin()).toBe("/custom/codex");
  });

  it("resolves the native Codex CLI from the installed SDK dependency tree", () => {
    delete process.env.CODEX_BGOS_CODEX_BIN;

    const bin = resolveCodexBin();

    expect(bin).not.toBe("codex");
    expect(statSync(bin).isFile()).toBe(true);
    expect(basename(bin)).toBe(
      process.platform === "win32" ? "codex.exe" : "codex",
    );
  });
});
