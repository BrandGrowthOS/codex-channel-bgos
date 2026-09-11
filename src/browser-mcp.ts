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

/** Dotted config overrides for thread/start and thread/fork (same shape as -c). */
export function browserMcpConfigOverrides(shimPath: string | null, nodeBinary = process.execPath): Record<string, unknown> {
  if (!shimPath) return {};
  return {
    [`mcp_servers.${HOAI_BROWSER_SERVER}.command`]: nodeBinary,
    [`mcp_servers.${HOAI_BROWSER_SERVER}.args`]: [shimPath],
    [`mcp_servers.${HOAI_BROWSER_SERVER}.startup_timeout_sec`]: 20,
  };
}
