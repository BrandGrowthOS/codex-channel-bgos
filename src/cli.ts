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
import { join } from "node:path";

import { pairBgos } from "./pair-cli.js";
import { loadConfig } from "./load-config.js";
import { resolveAuthMode, type AuthForce, type AuthResolution } from "./auth-mode.js";
import { CodexAdapter } from "./adapter.js";
import { getPackageVersion } from "./version.js";
import { installService } from "./install-service.js";

const DEFAULT_BASE_URL = "https://api.brandgrowthos.ai";
const LOG = "[codex-channel-bgos]";

/** Path to OpenAI Codex's own auth.json (a prior `codex login`). */
function codexAuthJsonPath(): string {
  const home = process.env.CODEX_HOME?.trim();
  const root = home && home.length > 0 ? home : join(homedir(), ".codex");
  return join(root, "auth.json");
}

function resolveAuth(): AuthResolution {
  const raw = (process.env.CODEX_BGOS_AUTH_MODE ?? "auto").trim().toLowerCase();
  const forced: AuthForce =
    raw === "chatgpt" || raw === "apikey" ? raw : "auto";
  return resolveAuthMode({
    authJsonExists: existsSync(codexAuthJsonPath()),
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
  const auth = resolveAuth();
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

  const adapter = new CodexAdapter(cfg, auth, {
    model: process.env.CODEX_BGOS_MODEL,
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

async function runConnect(code: string | undefined): Promise<void> {
  const auth = resolveAuth();
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
    const { pairing, tokenFile } = await pairBgos({ baseUrl, code });
    process.stdout.write(
      `${LOG} paired (pairing_id=${pairing.pairing_id}). Token stored at ${tokenFile}. Starting...\n`,
    );
  } catch (err: unknown) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    const status = e?.response?.status;
    if (status === 400 || status === 404 || status === 410) {
      process.stderr.write(
        `${LOG} pair code rejected (${status}): expired or already used. Get a fresh code and try again.\n`,
      );
      process.exit(2);
      return;
    }
    process.stderr.write(`${LOG} pairing failed: ${e?.message ?? String(err)}\n`);
    process.exit(1);
    return;
  }

  await runStart();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verb = argv[0];

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
    await runConnect(code);
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
  process.stderr.write(`${LOG} fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
