#!/usr/bin/env node
import { hostname } from "node:os";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BgosApi } from "./bgos-api.js";
import { getPackageVersion } from "./version.js";
import {
  PairingRevokedError,
  type AgentCatalogEntry,
  type PairExchangeResponse,
} from "./types.js";

/**
 * CLI entry point for `codex-pair-bgos`.
 *
 * Two modes:
 *   - Pair-code mode: `codex-pair-bgos <CODE>`, POST /integrations/pair-exchange
 *     with the code, a device label, the daemon version, and the local agent
 *     catalog, then persist the returned token.
 *   - Token mode: `codex-pair-bgos --token -` (reads the token from stdin) or
 *     `--token <value>` (scripting; shell-history caveat documented). Validates
 *     via GET /integrations/me (learns pairing_id/user_id), then persists.
 *
 * The secrets file is written ATOMICALLY (tmp + rename, 0600) in both modes.
 *
 * Exit codes:
 *   0 success
 *   1 network error
 *   2 invalid/consumed/expired code, or invalid token (401)
 */

export interface PairResult {
  pairing: PairExchangeResponse;
  tokenFile: string;
}

export interface PairCliOptions {
  baseUrl: string;
  code: string;
  deviceLabel?: string;
  agentCatalog?: AgentCatalogEntry[];
  secretsDir?: string;
  assistantId?: number;
}

function defaultSecretsDir(): string {
  // Respect CODEX_BGOS_HOME so pairing writes the token where `start` reads it
  // (every other module resolves the home the same way). Falls back to
  // ~/.codex-bgos when the override is unset.
  const override = process.env.CODEX_BGOS_HOME?.trim();
  if (override) {
    const root = override.startsWith("~")
      ? join(process.env.HOME ?? ".", override.slice(1))
      : override;
    return join(root, "secrets");
  }
  return join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".codex-bgos",
    "secrets",
  );
}

/** Atomically persist the secrets file (tmp + rename, 0600). */
async function writeSecretsAtomic(
  secretsDir: string,
  payload: Record<string, unknown>,
): Promise<string> {
  await mkdir(secretsDir, { recursive: true });
  const tokenFile = join(secretsDir, "bgos.json");
  const tmp = `${tokenFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await rename(tmp, tokenFile);
  return tokenFile;
}

export async function pairBgos(opts: PairCliOptions): Promise<PairResult> {
  const label = opts.deviceLabel ?? `${hostname()} (Codex)`;
  const res = await BgosApi.pairExchange(opts.baseUrl, {
    code: opts.code,
    deviceLabel: label,
    agentCatalog: opts.agentCatalog,
    // Tag the pairing so it lands under the Codex card (assistants get
    // created with code='codex'). Without this the backend defaults to
    // 'openclaw' and the pairing surfaces in the wrong card.
    integration: "codex",
    daemonVersion: getPackageVersion(),
    ...(opts.assistantId != null
      ? { intended_assistant_id: opts.assistantId }
      : {}),
  });

  const secretsDir = opts.secretsDir ?? defaultSecretsDir();
  const tokenFile = await writeSecretsAtomic(secretsDir, {
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    pairingToken: res.pairing_token,
    pairingId: res.pairing_id,
    userId: res.user_id,
    pairedAt: new Date().toISOString(),
  });
  return { pairing: res, tokenFile };
}

export interface PairWithTokenOptions {
  baseUrl: string;
  token: string;
  secretsDir?: string;
}

/**
 * Token mode: validate an existing pairing token via GET /integrations/me
 * (learns pairing_id/user_id), then persist the secrets file atomically.
 * Throws PairingRevokedError (mapped from 401) for an invalid token.
 */
export async function pairBgosWithToken(
  opts: PairWithTokenOptions,
): Promise<PairResult> {
  const api = new BgosApi({
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    pairingToken: opts.token,
    reconnect: { initialDelayMs: 1000, maxDelayMs: 30000 },
  });
  const me = await api.whoami();
  const secretsDir = opts.secretsDir ?? defaultSecretsDir();
  const tokenFile = await writeSecretsAtomic(secretsDir, {
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    pairingToken: opts.token,
    pairingId: me.pairing_id,
    userId: me.user_id,
    pairedAt: new Date().toISOString(),
  });
  return {
    pairing: {
      pairing_token: opts.token,
      pairing_id: me.pairing_id,
      user_id: me.user_id,
    },
    tokenFile,
  };
}

const DEFAULT_BASE_URL = "https://api.brandgrowthos.ai";

function parseAgentCatalog(
  raw: string | undefined,
): AgentCatalogEntry[] | undefined {
  if (!raw) return undefined;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [route, name] = entry.split(":").map((p) => p.trim());
      if (!route) return null;
      return { agent_route: route, name: name || route };
    })
    .filter((a): a is AgentCatalogEntry => a !== null);
  return entries.length ? entries : undefined;
}

function takeFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const val = argv[idx + 1];
  argv.splice(idx, 2);
  return val;
}

/** Read a single line/blob from stdin (used for `--token -`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const deviceLabel = takeFlag(argv, "--device-label");
  const baseUrl =
    takeFlag(argv, "--base-url") ??
    process.env.BGOS_BASE_URL ??
    DEFAULT_BASE_URL;
  const tokenFlag = takeFlag(argv, "--token");

  // ---- Token mode ---------------------------------------------------
  if (tokenFlag !== undefined) {
    try {
      let token = tokenFlag;
      if (token === "-") {
        token = await readStdin();
      }
      if (!token) {
        process.stderr.write("No token provided on stdin.\n");
        process.exit(2);
      }
      const { pairing, tokenFile } = await pairBgosWithToken({
        baseUrl,
        token,
      });
      process.stdout.write(`Token accepted. Secret written to ${tokenFile}\n`);
      process.stdout.write(
        `pairing_id=${pairing.pairing_id} user_id=${pairing.user_id}\n`,
      );
      process.exit(0);
    } catch (err: unknown) {
      const e = err as { response?: { status?: number }; message?: string };
      if (err instanceof PairingRevokedError || e?.response?.status === 401) {
        process.stderr.write("Token rejected (401): invalid or revoked.\n");
        process.exit(2);
      }
      process.stderr.write(
        `Token validation failed: ${e?.message ?? String(err)}\n`,
      );
      process.exit(1);
    }
  }

  // ---- Pair-code mode -----------------------------------------------
  const code = argv.find((a) => !a.startsWith("--"));
  if (!code) {
    process.stderr.write(
      "usage: codex-pair-bgos <CODE> [--device-label NAME] [--base-url URL]\n" +
        "       codex-pair-bgos --token -   (reads a pairing token from stdin)\n",
    );
    process.exit(2);
  }

  try {
    const { pairing, tokenFile } = await pairBgos({
      baseUrl,
      code,
      deviceLabel,
      agentCatalog: parseAgentCatalog(process.env.CODEX_BGOS_AGENTS),
    });
    process.stdout.write(`Paired. Secret written to ${tokenFile}\n`);
    process.stdout.write(
      `pairing_id=${pairing.pairing_id} user_id=${pairing.user_id}\n`,
    );
    process.exit(0);
  } catch (err: unknown) {
    const e = err as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    const status = e?.response?.status;
    if (status === 400 || status === 404 || status === 410) {
      process.stderr.write(
        `Pair code rejected (${status}): ${JSON.stringify(e.response?.data ?? "expired or consumed")}\n`,
      );
      process.exit(2);
    }
    process.stderr.write(`Pair failed: ${e?.message ?? String(err)}\n`);
    process.exit(1);
  }
}

// Run when invoked as a CLI (not when imported as a library).
const invokedAsCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /pair-cli(?:\.[mc]?[jt]s)?$/.test(process.argv[1] ?? "");
if (invokedAsCli) {
  void main();
}
