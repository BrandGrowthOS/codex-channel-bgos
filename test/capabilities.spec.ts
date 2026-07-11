/**
 * Capability bootstrap: the pure validate-and-choose logic + the BgosApi GET.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BgosApi } from "../src/bgos-api.js";
import {
  BUNDLED_CAPABILITIES,
  MAX_CANON_BYTES,
  hasCanonMarkers,
  pickCapabilitiesText,
  type ServedCapabilities,
} from "../src/capabilities.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

function served(text: string, version = "2026.07.11"): ServedCapabilities {
  return { channel: "codex", version, text, core: "", channelSyntax: "" };
}

describe("hasCanonMarkers", () => {
  it("accepts the served canon form (no comma)", () => {
    expect(hasCanonMarkers("# BGOS Channel Agent Capabilities\n...")).toBe(true);
  });

  it("accepts the bundled fallback form (with comma)", () => {
    expect(hasCanonMarkers(BUNDLED_CAPABILITIES)).toBe(true);
  });

  it("rejects empty, whitespace, and unrelated text", () => {
    expect(hasCanonMarkers("")).toBe(false);
    expect(hasCanonMarkers("   ")).toBe(false);
    expect(hasCanonMarkers("some other document")).toBe(false);
    expect(hasCanonMarkers("BGOS Channel only, no second marker")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(hasCanonMarkers(null)).toBe(false);
    expect(hasCanonMarkers(undefined)).toBe(false);
  });
});

describe("pickCapabilitiesText", () => {
  it("uses the served text when it is well-formed", () => {
    const text = "# BGOS Channel Agent Capabilities\n(channel: codex)\n...";
    const picked = pickCapabilitiesText(served(text));
    expect(picked.source).toBe("backend");
    expect(picked.text).toBe(text);
  });

  it("falls back to bundled on a null / undefined fetch", () => {
    expect(pickCapabilitiesText(null).source).toBe("bundled");
    expect(pickCapabilitiesText(null).text).toBe(BUNDLED_CAPABILITIES);
    expect(pickCapabilitiesText(undefined).source).toBe("bundled");
  });

  it("falls back to bundled on an empty or malformed served body", () => {
    expect(pickCapabilitiesText(served("")).source).toBe("bundled");
    expect(pickCapabilitiesText(served("   ")).source).toBe("bundled");
    expect(pickCapabilitiesText(served("garbage without markers")).source).toBe(
      "bundled",
    );
  });

  it("falls back to bundled when the served canon exceeds the size cap (DoS/injection guard)", () => {
    const marker = "# BGOS Channel Agent Capabilities\n";
    const oversized = marker + "x".repeat(MAX_CANON_BYTES + 1);
    expect(pickCapabilitiesText(served(oversized)).source).toBe("bundled");
    const atCap = marker + "y".repeat(MAX_CANON_BYTES - marker.length);
    expect(pickCapabilitiesText(served(atCap)).source).toBe("backend");
  });

  it("never throws and always returns a non-empty text", () => {
    for (const input of [null, undefined, served(""), served("x")]) {
      const picked = pickCapabilitiesText(input);
      expect(picked.text.length).toBeGreaterThan(0);
    }
  });
});

describe("BgosApi.getCapabilities", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  function makeApi(url: string) {
    return new BgosApi({
      baseUrl: url,
      pairingToken: "pair_" + "x".repeat(30),
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
  }

  it("GETs /integrations/capabilities with the channel param and returns the payload", async () => {
    const payload = {
      channel: "codex",
      version: "2026.07.11",
      text: "# BGOS Channel Agent Capabilities\n(channel: codex)\nbody",
      core: "core",
      channelSyntax: "codex delta",
    };
    server.stage("GET", "/api/v1/integrations/capabilities", 200, payload);

    const out = await makeApi(baseUrl).getCapabilities("codex");
    expect(out).toMatchObject(payload);

    const req = server.requests.at(-1)!;
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/integrations/capabilities");
    expect(req.url).toContain("channel=codex");
    // Never send anything but the pairing header; the token must not leak.
    expect(req.headers["x-bgos-pairing"]).toBeTruthy();
  });

  it("defaults the channel to codex", async () => {
    server.stage("GET", "/api/v1/integrations/capabilities", 200, {
      channel: "codex",
      version: "v",
      text: "# BGOS Channel Agent Capabilities",
      core: "",
      channelSyntax: "",
    });
    await makeApi(baseUrl).getCapabilities();
    expect(server.requests.at(-1)!.url).toContain("channel=codex");
  });

  it("rejects when the endpoint 404s (old backend) so the caller keeps the fallback", async () => {
    // No stage -> mock returns 404; getCapabilities must reject (caught upstream).
    await expect(makeApi(baseUrl).getCapabilities("codex")).rejects.toBeTruthy();
  });
});
