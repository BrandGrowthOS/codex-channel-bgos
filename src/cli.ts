#!/usr/bin/env node
/**
 * codex-channel-bgos daemon CLI.
 *
 *   codex-channel-bgos connect <CODE>   pair with a BGOS code, then start
 *   codex-channel-bgos start            start from the stored pairing token
 *   codex-channel-bgos install-service  install launchd/systemd persistence
 *   codex-channel-bgos --help
 *
 * `connect` is pair-then-start in one process (the OpenClaw one-paste shape):
 * pairing writes ~/.codex-bgos/secrets/bgos.json, then control falls through to
 * start, which reads that same file.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { pairBgos } from "./pair-cli.js";
import { loadConfig } from "./load-config.js";
import {
  resolveAuthMode,
  type AuthForce,
  type AuthResolution,
} from "./auth-mode.js";
import { CodexAdapter } from "./adapter.js";
import { getPackageVersion } from "./version.js";
import { installService } from "./install-service.js";
import {
  readSettings,
  agentHome,
  saveSettings,
  validateSettings,
} from "./setup/settings.js";
import { BgosApi } from "./bgos-api.js";
import { AppServer, codexEnvironment } from "./app-server.js";
import { setupAgent, progress } from "./setup/setup-agent.js";
import {
  supervise,
  pauseBackgroundService,
} from "./setup/background-service.js";

const DEFAULT_BASE_URL = "https://api.brandgrowthos.ai";
const LOG = "[codex-channel-bgos]";

/** Path to OpenAI Codex's own auth.json (a prior `codex login`). */
function codexAuthJsonPath(): string {
  const home = process.env.CODEX_HOME?.trim();
  const root = home && home.length > 0 ? home : join(homedir(), ".codex");
  return join(root, "auth.json");
}

async function resolveAuth(): Promise<AuthResolution> {
  const raw = (process.env.CODEX_BGOS_AUTH_MODE ?? "auto").trim().toLowerCase();
  const forced: AuthForce =
    raw === "chatgpt" || raw === "apikey" ? raw : "auto";
  let hasLogin = existsSync(codexAuthJsonPath());
  // macOS may keep Codex's sign-in in Keychain. Ask Codex; never read/copy
  // its token to HOAI or force a redundant login because auth.json is absent.
  if (!hasLogin && forced !== "apikey") {
    const server = new AppServer({
      cwd: process.env.CODEX_BGOS_WORKDIR ?? process.cwd(),
      env: codexEnvironment(),
      command: process.env.CODEX_BGOS_EXECUTABLE,
    });
    try {
      await server.start();
      hasLogin = Boolean(
        (await server.request("account/read", { refreshToken: true })).account,
      );
    } catch {
    } finally {
      server.close();
    }
  }
  return resolveAuthMode({
    authJsonExists: hasLogin,
    openaiKey: process.env.OPENAI_API_KEY,
    forced,
  });
}

function printPreflight(): void {
  // The codex binary ships with @openai/codex-sdk (a dependency), so "installed"
  // is always true for a working install; report auth as the meaningful gate.
  process.stdout.write(`${LOG} preflight: codex runtime bundled (ok)\n`);
}

function usage(): void {
  process.stdout.write(
    `codex-channel-bgos v${getPackageVersion()}\n\n` +
      `Usage:\n` +
      `  codex-channel-bgos connect <CODE>   Pair with a BGOS code, then start the daemon\n` +
      `  codex-channel-bgos start            Start from the stored pairing token\n` +
      `  codex-channel-bgos install-service  Install launchd/systemd persistence\n` +
      `  codex-channel-bgos --help\n\n` +
      `Auth (D7): prefers an existing 'codex login', else OPENAI_API_KEY.\n` +
      `Override with CODEX_BGOS_AUTH_MODE=auto|chatgpt|apikey.\n`,
  );
}

async function runStart(): Promise<void> {
  const auth = await resolveAuth();
  if (!auth.ok) {
    process.stderr.write(`${LOG} cannot start: ${auth.error}\n`);
    process.exit(1);
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    process.stderr.write(
      `${LOG} not paired yet. Get a code from the BGOS app, then run:\n` +
        `  npx codex-channel-bgos connect BGOS-XXXX-XX\n`,
    );
    process.exit(1);
    return;
  }

  process.stdout.write(`${LOG} starting v${getPackageVersion()}\n`);
  process.stdout.write(`${LOG} auth: ${auth.label} (${auth.mode})\n`);

  const settings = process.env.CODEX_BGOS_HOME
    ? readSettings(process.env.CODEX_BGOS_HOME)
    : null;
  const adapter = new CodexAdapter(cfg, auth, {
    model: process.env.CODEX_BGOS_MODEL,
    ...(settings
      ? {
          agents: [
            {
              route: settings.route ?? `codex-${settings.assistantId}`,
              name: settings.name,
            },
          ],
        }
      : {}),
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${LOG} shutting down...\n`);
    void adapter.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await adapter.start();
  process.stdout.write(`${LOG} ready, waiting for BGOS messages\n`);
}

async function runConnect(
  code: string | undefined,
  assistantId?: number,
): Promise<void> {
  const auth = await resolveAuth();
  if (!auth.ok) {
    process.stderr.write(`${LOG} ${auth.error}\n`);
    process.exit(1);
  }
  printPreflight();
  process.stdout.write(
    `${LOG} auth: ${auth.ok ? auth.label : "unresolved"} (${auth.ok ? auth.mode : "none"})\n`,
  );

  const baseUrl = process.env.BGOS_BASE_URL ?? DEFAULT_BASE_URL;

  if (!code) {
    process.stderr.write(
      `${LOG} no pair code given. Get one from the BGOS app (Add an agent -> Codex) and run:\n` +
        `  npx codex-channel-bgos connect BGOS-XXXX-XX\n`,
    );
    process.exit(2);
    return;
  }

  try {
    const { pairing, tokenFile } = await pairBgos({
      baseUrl,
      code,
      assistantId,
      ...(assistantId
        ? {
            agentCatalog: [
              { agent_route: `codex-${assistantId}`, name: "Codex" },
            ],
          }
        : {}),
    });
    if (assistantId) {
      const api = new BgosApi({
        baseUrl,
        pairingToken: pairing.pairing_token,
        reconnect: { initialDelayMs: 1000, maxDelayMs: 30000 },
      });
      const me = await api.whoami();
      if (
        me.assistants?.length !== 1 ||
        me.assistants[0].assistant_id !== assistantId
      )
        throw new Error(
          "Pairing returned a different agent. The daemon was not started.",
        );
      const home = process.env.CODEX_BGOS_HOME!;
      saveSettings(
        home,
        validateSettings({
          ...readSettings(home),
          assistantId,
          name: me.assistants[0].name || "Codex",
          route: me.assistants[0].agent_route || `codex-${assistantId}`,
          workdir: process.env.CODEX_BGOS_WORKDIR || process.cwd(),
          baseUrl,
        }),
      );
    }
    process.stdout.write(
      `${LOG} paired (pairing_id=${pairing.pairing_id}). Token stored at ${tokenFile}. Starting...\n`,
    );
  } catch (err: unknown) {
    const e = err as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    const status = e?.response?.status;
    if (status === 400 || status === 404 || status === 410) {
      process.stderr.write(
        `${LOG} pair code rejected (${status}): expired or already used. Get a fresh code and try again.\n`,
      );
      process.exit(2);
      return;
    }
    process.stderr.write(
      `${LOG} pairing failed: ${e?.message ?? String(err)}\n`,
    );
    process.exit(1);
    return;
  }

  await runStart();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const pinIndex = argv.indexOf("--assistant-id");
  let assistantId: number | undefined;
  if (pinIndex >= 0) {
    assistantId = Number(argv[pinIndex + 1]);
    if (!Number.isSafeInteger(assistantId) || assistantId < 1)
      throw new Error("--assistant-id needs a positive integer.");
    argv.splice(pinIndex, 2);
    process.env.CODEX_BGOS_HOME ??= agentHome(assistantId);
  }
  const homeIndex = argv.indexOf("--home");
  if (homeIndex >= 0) {
    if (!argv[homeIndex + 1] || !isAbsolute(argv[homeIndex + 1]))
      throw new Error("--home needs an absolute path");
    process.env.CODEX_BGOS_HOME = argv[homeIndex + 1];
    argv.splice(homeIndex, 2);
  }
  const settings = process.env.CODEX_BGOS_HOME
    ? readSettings(process.env.CODEX_BGOS_HOME)
    : null;
  if (settings) {
    process.env.CODEX_BGOS_WORKDIR = settings.workdir;
    process.env.CODEX_BGOS_MEDIA_ROOT ??= settings.workdir;
    if (settings.model) process.env.CODEX_BGOS_MODEL = settings.model;
    if (settings.executable)
      process.env.CODEX_BGOS_EXECUTABLE = settings.executable;
  }
  const verb = argv[0];

  if (verb === "setup") {
    try {
      await setupAgent();
    } catch (error) {
      progress("failed", {
        message: error instanceof Error ? error.message : "Setup failed.",
      });
      process.exitCode = 1;
    }
    return;
  }
  if (verb === "supervise") {
    if (!process.env.CODEX_BGOS_HOME)
      throw new Error("A background agent needs its own home.");
    await supervise(process.env.CODEX_BGOS_HOME);
    return;
  }
  if (verb === "pause-service") {
    if (!process.env.CODEX_BGOS_HOME)
      throw new Error("Select an agent home before pausing it.");
    await pauseBackgroundService(process.env.CODEX_BGOS_HOME);
    return;
  }

  if (verb === "--help" || verb === "-h" || verb === "help") {
    usage();
    return;
  }
  if (verb === "install-service") {
    const r = installService();
    process.stdout.write(`${LOG} ${r.message}\n`);
    process.exit(r.ok ? 0 : 1);
    return;
  }
  if (verb === "connect") {
    const code = argv.slice(1).find((a) => !a.startsWith("-"));
    await runConnect(code, assistantId);
    return;
  }
  if (verb === "start" || verb === undefined) {
    await runStart();
    return;
  }
  process.stderr.write(`${LOG} unknown command: ${verb}\n`);
  usage();
  process.exit(2);
}

void main().catch((err) => {
  process.stderr.write(
    `${LOG} fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
