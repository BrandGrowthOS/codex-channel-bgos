/**
 * The command line as `main` (src/cli.ts) reads it, with the environment it
 * prepares: the flags taken out, the agent's home chosen, that home's
 * settings applied. Effects injected, so the order is tested
 * (test/cli-args.spec.ts).
 */
import { isAbsolute } from "node:path";

import { KEEP_ALIVE_FLAG, takeFlag } from "./keep-alive.js";
import type { AgentSettings } from "./setup/settings.js";

export type CliInvocation =
  | { kind: "version" }
  | {
      kind: "command";
      verb: string | undefined;
      /** What is left once the flags below are taken out; argv[0] is the verb. */
      argv: string[];
      assistantId?: number;
      keepAlive: boolean;
    };

export function parseCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: {
    readSettings: (home: string) => AgentSettings | null;
    agentHome: (assistantId: number) => string;
  },
): CliInvocation {
  // First, before any settings are read: the supervisor probes a staged
  // update with exactly this, in its own environment (which names the
  // agent's home), and exits on its own (self-update.ts). An agent.json the
  // new version cannot read must not fail a probe that only asks the version.
  if (argv[0] === "--version" || argv[0] === "-v") return { kind: "version" };
  const args = [...argv];
  const keepAlive = takeFlag(args, KEEP_ALIVE_FLAG);
  const pinIndex = args.indexOf("--assistant-id");
  let assistantId: number | undefined;
  if (pinIndex >= 0) {
    assistantId = Number(args[pinIndex + 1]);
    if (!Number.isSafeInteger(assistantId) || assistantId < 1)
      throw new Error("--assistant-id needs a positive integer.");
    args.splice(pinIndex, 2);
    env.CODEX_BGOS_HOME ??= deps.agentHome(assistantId);
  }
  const homeIndex = args.indexOf("--home");
  if (homeIndex >= 0) {
    if (!args[homeIndex + 1] || !isAbsolute(args[homeIndex + 1]))
      throw new Error("--home needs an absolute path");
    env.CODEX_BGOS_HOME = args[homeIndex + 1];
    args.splice(homeIndex, 2);
  }
  const settings = env.CODEX_BGOS_HOME
    ? deps.readSettings(env.CODEX_BGOS_HOME)
    : null;
  if (settings) {
    env.CODEX_BGOS_WORKDIR = settings.workdir;
    env.CODEX_BGOS_MEDIA_ROOT ??= settings.workdir;
    if (settings.model) env.CODEX_BGOS_MODEL = settings.model;
    if (settings.executable) env.CODEX_BGOS_EXECUTABLE = settings.executable;
  }
  return {
    kind: "command",
    verb: args[0],
    argv: args,
    ...(assistantId !== undefined ? { assistantId } : {}),
    keepAlive,
  };
}
