/**
 * The command line as src/cli.ts reads it. `--version` is answered FIRST,
 * before any settings are read: the supervisor probes a staged update with
 * exactly that (self-update.ts), in its own environment, which names the
 * agent's home. An agent.json the new version cannot read must not fail the
 * probe of a CLI that only has to say its version.
 */
import { describe, expect, it, vi } from "vitest";

import { parseCli } from "../src/cli-args.js";
import type { AgentSettings } from "../src/setup/settings.js";

const HOME = "/Users/kc/.codex-bgos/agents/9";
const SETTINGS: AgentSettings = {
  assistantId: 9,
  name: "Codex",
  route: "codex-9",
  workdir: "/Users/kc/work",
  baseUrl: "https://api.brandgrowthos.ai",
  model: "gpt-5.5",
};

function deps(readSettings: (home: string) => AgentSettings | null = () => SETTINGS) {
  return {
    readSettings: vi.fn(readSettings),
    agentHome: vi.fn((id: number) => `/Users/kc/.codex-bgos/agents/${id}`),
  };
}

describe("parseCli: --version comes before everything", () => {
  for (const argv of [["--version"], ["-v"], ["--version", "--home", HOME]])
    it(`${argv.join(" ")}: answered without reading settings, whatever the home holds`, () => {
      const d = deps(() => {
        throw new Error("agent.json: unknown field");
      });
      const env: Record<string, string | undefined> = { CODEX_BGOS_HOME: HOME };
      expect(parseCli(argv, env, d)).toEqual({ kind: "version" });
      expect(d.readSettings).not.toHaveBeenCalled();
      expect(env).toEqual({ CODEX_BGOS_HOME: HOME });
    });
});

describe("parseCli: every other command", () => {
  it("connect --keep-alive --assistant-id: the flag taken, the agent's home chosen, its settings applied", () => {
    const d = deps();
    const env: Record<string, string | undefined> = {};
    expect(
      parseCli(["connect", "BGOS-AB12-CD", "--keep-alive", "--assistant-id", "9"], env, d),
    ).toEqual({
      kind: "command",
      verb: "connect",
      argv: ["connect", "BGOS-AB12-CD"],
      assistantId: 9,
      keepAlive: true,
    });
    expect(d.readSettings).toHaveBeenCalledWith(HOME);
    expect(env).toMatchObject({
      CODEX_BGOS_HOME: HOME,
      CODEX_BGOS_WORKDIR: "/Users/kc/work",
      CODEX_BGOS_MEDIA_ROOT: "/Users/kc/work",
      CODEX_BGOS_MODEL: "gpt-5.5",
    });
  });

  it("supervise --home: the home given wins", () => {
    const env: Record<string, string | undefined> = { CODEX_BGOS_HOME: "/elsewhere" };
    expect(parseCli(["supervise", "--home", HOME], env, deps())).toMatchObject({
      kind: "command",
      verb: "supervise",
      keepAlive: false,
    });
    expect(env.CODEX_BGOS_HOME).toBe(HOME);
  });

  it("refuses a relative --home and a non numeric --assistant-id", () => {
    expect(() => parseCli(["start", "--home", "agents/9"], {}, deps())).toThrow("absolute");
    expect(() => parseCli(["connect", "--assistant-id", "nine"], {}, deps())).toThrow("positive integer");
  });

  it("no home: no settings are read", () => {
    const d = deps();
    expect(parseCli([], {}, d)).toEqual({
      kind: "command",
      verb: undefined,
      argv: [],
      keepAlive: false,
    });
    expect(d.readSettings).not.toHaveBeenCalled();
  });
});
