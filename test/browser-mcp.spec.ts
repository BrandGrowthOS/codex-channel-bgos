import { describe, expect, it } from "vitest";

import { browserMcpConfigOverrides, resolveBrowserShim, HOAI_BROWSER_SERVER } from "../src/browser-mcp.js";

describe("resolveBrowserShim", () => {
  it("prefers the app-installed shim under ~/.hoai/bin", () => {
    const exists = (p: string) => p.endsWith("/.hoai/bin/hoai-browser-mcp.mjs");
    expect(resolveBrowserShim({ home: "/home/kc", exists, bundled: "/pkg/vendor/hoai-browser-mcp.mjs" })).toBe("/home/kc/.hoai/bin/hoai-browser-mcp.mjs");
  });
  it("falls back to the bundled copy, then to null", () => {
    expect(resolveBrowserShim({ home: "/home/kc", exists: (p) => p === "/pkg/vendor/hoai-browser-mcp.mjs", bundled: "/pkg/vendor/hoai-browser-mcp.mjs" })).toBe("/pkg/vendor/hoai-browser-mcp.mjs");
    expect(resolveBrowserShim({ home: "/home/kc", exists: () => false, bundled: "/pkg/vendor/hoai-browser-mcp.mjs" })).toBeNull();
  });
});

describe("browserMcpConfigOverrides", () => {
  it("emits dotted mcp_servers overrides for the shim and nothing without one", () => {
    expect(browserMcpConfigOverrides(null)).toEqual({});
    const o = browserMcpConfigOverrides("/home/kc/.hoai/bin/hoai-browser-mcp.mjs", "/usr/bin/node");
    expect(o[`mcp_servers.${HOAI_BROWSER_SERVER}.command`]).toBe("/usr/bin/node");
    expect(o[`mcp_servers.${HOAI_BROWSER_SERVER}.args`]).toEqual(["/home/kc/.hoai/bin/hoai-browser-mcp.mjs"]);
  });
});
