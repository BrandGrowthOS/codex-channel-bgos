import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfigFromEnv, loadConfigFromPluginCfg } from "./config.js";
import type { CatalogAgent } from "./catalog-sync.js";
import type { PluginConfig } from "./types.js";

export interface LoadedConfig extends PluginConfig {
  agents?: CatalogAgent[];
}

interface SecretsFile {
  baseUrl?: string;
  pairingToken?: string;
}

function resolveCodexBgosHome(): string {
  const fromEnv = process.env.CODEX_BGOS_HOME?.trim();
  if (fromEnv) {
    if (fromEnv.startsWith("~")) {
      return join(homedir(), fromEnv.slice(1));
    }
    return fromEnv;
  }
  return join(homedir(), ".codex-bgos");
}

function readSecrets(): SecretsFile | null {
  const path = join(resolveCodexBgosHome(), "secrets", "bgos.json");
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SecretsFile;
    if (parsed?.pairingToken && parsed.pairingToken.length >= 20) {
      return parsed;
    }
  } catch {
    // file missing / unreadable - fall through to env
  }
  return null;
}

/**
 * Synchronous, never-throwing read of the pairing secrets written by
 * `codex-pair-bgos` (`~/.codex-bgos/secrets/bgos.json`). Returns `null` when the
 * file is missing, unreadable, malformed, or the token is too short.
 *
 * Intended for constructors that cannot `await` (e.g. `BgosProactiveClient`),
 * so the SEPARATE proactive check-in/briefing processes - which do not inherit
 * the adapter's `CODEX_BGOS_PAIRING_TOKEN` env - can still authenticate off the same
 * secrets file the long-running adapter uses. Safe to call unconditionally; a
 * missing file simply yields `null`.
 */
export function readSecretsSafe(): {
  pairingToken?: string;
  baseUrl?: string;
} | null {
  try {
    return readSecrets();
  } catch {
    return null;
  }
}

function parseAgents(raw: string | undefined): CatalogAgent[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [route, name] = entry.split(":").map((p) => p.trim());
      if (!route) return null;
      return { route, name: name || route } as CatalogAgent;
    })
    .filter((a): a is CatalogAgent => a !== null);
}

/**
 * Load BGOS plugin config from (in order of precedence):
 *   1. `~/.codex-bgos/secrets/bgos.json` (written by `codex-pair-bgos`)
 *   2. `BGOS_PAIRING_TOKEN` env var
 * Plus optional agent catalog from `CODEX_BGOS_AGENTS=route:Name,route:Name,...`.
 *
 * Throws if neither secrets file nor env var supplies a valid pairing token.
 */
export function loadConfig(): LoadedConfig {
  const secrets = readSecrets();
  let base: PluginConfig;
  if (secrets?.pairingToken) {
    base = loadConfigFromPluginCfg({
      pairingToken: secrets.pairingToken,
      baseUrl: secrets.baseUrl,
    });
  } else {
    base = loadConfigFromEnv();
  }
  const agents = parseAgents(process.env.CODEX_BGOS_AGENTS);
  return { ...base, agents };
}
