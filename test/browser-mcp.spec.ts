import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { browserMcpConfigOverrides, resolveBrowserShim, HOAI_BROWSER_SERVER } from "../src/browser-mcp.js";

const home = join(sep, "home", "kc");
const installed = join(home, ".hoai", "bin", "hoai-browser-mcp.mjs");
const bundled = join(sep, "pkg", "vendor", "hoai-browser-mcp.mjs");

describe("resolveBrowserShim", () => {
  it("prefers the app-installed shim under ~/.hoai/bin", () => {
    expect(resolveBrowserShim({ home, exists: (p) => p === installed, bundled })).toBe(installed);
  });
  it("falls back to the bundled copy, then to null", () => {
    expect(resolveBrowserShim({ home, exists: (p) => p === bundled, bundled })).toBe(bundled);
    expect(resolveBrowserShim({ home, exists: () => false, bundled })).toBeNull();
  });
});

describe("browserMcpConfigOverrides", () => {
  it("emits dotted mcp_servers overrides for the shim and nothing without one", () => {
    expect(browserMcpConfigOverrides(null)).toEqual({});
    const o = browserMcpConfigOverrides(installed, "/usr/bin/node");
    expect(o[`mcp_servers.${HOAI_BROWSER_SERVER}.command`]).toBe("/usr/bin/node");
    expect(o[`mcp_servers.${HOAI_BROWSER_SERVER}.args`]).toEqual([installed]);
    expect(o[`mcp_servers.${HOAI_BROWSER_SERVER}.startup_timeout_sec`]).toBe(20);
  });
});
