/**
 * HOAI Agent Browser registration for the Codex app-server.
 *
 * The Home of Agents desktop app hosts a browser pane agents drive and serves
 * it as a local MCP endpoint (BGOS `frontend/electron-app/agent-browser/`).
 * A zero-dependency stdio shim proxies to it; the app installs the shim at
 * ~/.hoai/bin/hoai-browser-mcp.mjs and this package carries a copy in vendor/.
 * We register the shim as the `hoai_browser` MCP server through per-thread
 * config overrides, so the user's ~/.codex/config.toml is never edited and the
 * browser appears in Codex's tool list whenever the app is running. Offline,
 * the shim serves one honest `hoai_browser_status` tool.
 *
 * When the agent runs on a different machine than the owner's desktop app, the
 * same shim reaches that app through the HOAI backend instead: we hand it this
 * daemon's own pairing credentials plus the assistant id as
 * `mcp_servers.hoai_browser.env`, and it relays every MCP message through the
 * owner's account as that agent (BGOS
 * `docs/superpowers/plans/2026-09-12-agent-browser-relay.md`). The shim never
 * reads our secrets file; the values only ever travel as that env, and they are
 * never logged.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HOAI_BROWSER_SERVER = "hoai_browser";

/** The app-installed shim first (tracks the app version), then the bundled copy. */
export function resolveBrowserShim(opts: { home?: string; exists?: (p: string) => boolean; bundled?: string } = {}): string | null {
  const home = opts.home ?? (process.env.HOAI_HOME ?? homedir());
  const exists = opts.exists ?? existsSync;
  const installed = join(home, ".hoai", "bin", "hoai-browser-mcp.mjs");
  if (exists(installed)) return installed;
  const bundled = opts.bundled ?? bundledShimPath();
  return bundled && exists(bundled) ? bundled : null;
}

export function bundledShimPath(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "..", "vendor", "hoai-browser-mcp.mjs");
}

/**
 * The relay credentials the shim needs to reach the owner's desktop app from
 * another machine: this daemon's HOAI base URL, its pairing token, and the
 * assistant the call is made as.
 *
 * The assistant id is not optional. The backend's `RelayMcpDto` requires it on
 * BOTH lanes (a pairing can back several assistants, and the owner's rail shows
 * the name of the agent that is browsing), so a relayed `initialize` without it
 * is answered 400, the shim reads that as a relay error and falls back to
 * offline, and the agent silently gets the single status tool instead of a
 * browser. That is the whole cross-machine feature, so we would rather send no
 * relay env at all than send an unauthenticable one.
 */
export interface BrowserRelayCredentials {
  backendUrl: string;
  pairingToken: string;
  assistantId: number;
}

/**
 * The `HOAI_RELAY_*` env the shim reads, or `{}` when any of the three parts is
 * missing (the shim then stays local-or-offline, which is the honest answer:
 * an incomplete relay lane is a silent 400, not a browser). The token appears
 * under exactly one key and is never logged.
 *
 * These are the only variables the shim reads: everything else it needs comes
 * from `os.homedir()`, which resolves from the OS user record when HOME and
 * USERPROFILE are absent. So whether Codex merges this map into the child's
 * environment or hands it over as the whole environment, the local door (the
 * discovery file under ~/.hoai) keeps working.
 */
export function browserRelayEnv(relay?: BrowserRelayCredentials | null): Record<string, string> {
  const backendUrl = String(relay?.backendUrl ?? "").trim().replace(/\/+$/, "");
  const pairingToken = String(relay?.pairingToken ?? "").trim();
  const assistantId = Number(relay?.assistantId ?? 0);
  if (!backendUrl || !pairingToken) return {};
  if (!Number.isSafeInteger(assistantId) || assistantId <= 0) return {};
  return {
    HOAI_RELAY_BACKEND_URL: backendUrl,
    HOAI_RELAY_PAIRING_TOKEN: pairingToken,
    HOAI_RELAY_ASSISTANT_ID: String(assistantId),
  };
}

/** Dotted config overrides for thread/start and thread/fork (same shape as -c). */
export function browserMcpConfigOverrides(
  shimPath: string | null,
  nodeBinary = process.execPath,
  relay?: BrowserRelayCredentials | null,
): Record<string, unknown> {
  if (!shimPath) return {};
  const env = browserRelayEnv(relay);
  return {
    [`mcp_servers.${HOAI_BROWSER_SERVER}.command`]: nodeBinary,
    [`mcp_servers.${HOAI_BROWSER_SERVER}.args`]: [shimPath],
    [`mcp_servers.${HOAI_BROWSER_SERVER}.startup_timeout_sec`]: 20,
    ...(Object.keys(env).length > 0 ? { [`mcp_servers.${HOAI_BROWSER_SERVER}.env`]: env } : {}),
  };
}
