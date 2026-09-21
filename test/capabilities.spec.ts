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

/**
 * Stage 5: the bundled hint and the served Codex sentence must tell ONE truth,
 * and the truth is the host's. A Codex agent has no chat id input on
 * create_mission and no active mission read tool of its own, so any wording
 * that tells it to send or to ask for a chat id is an instruction it cannot
 * follow. These assertions pin the bundled fallback against the served text.
 */
describe("BUNDLED_CAPABILITIES mission paragraph", () => {
  // The served Codex delta's mission sentence, word for word. The leading
  // bullet marker and the hint file's line wrapping are the only differences.
  const SERVED_TRUTH = [
    "Missions belong to a chat now: the host stamps the chat of the turn on every mission you create and reads that chat's own mission for you, so you never send and never ask for a chat id.",
    "When your owner sets your mission aside or marks it done you receive a plain in band note before your next turn telling you to stop; treat it as an instruction and stop working on that mission at once.",
    "Told it is paused, stop working on it until you are told it resumed.",
  ];
  const flat = BUNDLED_CAPABILITIES.replace(/\s+/g, " ");

  it.each(SERVED_TRUTH)("says, word for word: %s", (sentence) => {
    expect(flat).toContain(sentence);
  });

  it("never tells the agent that it carries the chat itself", () => {
    expect(flat).not.toContain("the host sends that chat for you");
    expect(flat).not.toContain("which chat a mission is in");
  });

  it("does not describe the steer mechanism to the model", () => {
    expect(flat).not.toContain("interrupt a turn");
  });

  it("no longer says this channel has no pause control, because now it has one", () => {
    // Stage 6. The bundled text is appended AFTER the served canon on every
    // connect, so leaving this sentence in place would ship the model a flat
    // contradiction of the canon it just read, and of what the daemon now
    // does: the owner's Pause really holds the native goal.
    expect(flat).not.toContain("This channel has no pause control of its own yet");
    expect(flat).toContain("Their Pause really stops the work on this channel");
  });

  it("carries no em dash and no en dash", () => {
    expect(BUNDLED_CAPABILITIES).not.toMatch(/[\u2013\u2014]/);
  });
});

/**
 * Stage 6: the goal lane paragraph, word for word against the served canon.
 *
 * The bundled hints are appended AFTER the served canon on every connect
 * (adapter.ts), so the two texts are read together by every agent and any
 * drift between them is a contradiction the model has to resolve on its own.
 * The sentences below are copied from CODEX_GOAL_LANE_SENTENCE in
 * backend/src/integrations/capability-canon.ts.
 */
describe("BUNDLED_CAPABILITIES goal lane paragraph", () => {
  const SERVED_TRUTH = [
    "Your owner's Keep working arms a native Codex goal on this chat's thread: the host calls thread/goal/set from the mission and adopts the continuation turns the app server starts by itself, so your work reaches your owner between messages exactly as it does inside a turn they asked for.",
    "You can set one yourself with /goal <condition>, read it with /goal, and stop or hold it with /goal clear, /goal pause and /goal resume.",
    "The host counts the turns and pauses the goal at your owner's cap, and it reports the working time your runtime counted; there is no separate judge on this channel, so never claim a check ran, never write a checked feed entry and never say a goal was verified.",
    "When the host tells you the goal stopped, say in one short line where you got to.",
  ];
  const flat = BUNDLED_CAPABILITIES.replace(/\s+/g, " ");

  it.each(SERVED_TRUTH)("says, word for word: %s", (sentence) => {
    expect(flat).toContain(sentence);
  });

  it("no longer claims autonomous Codex goals are not implemented here", () => {
    expect(flat).not.toContain("autonomous Codex goals are not implemented");
  });

  it("lists /goal in the control list itself, not only in the paragraph", () => {
    expect(flat).toContain("/ps, /steer, /goal and /help are native bridge controls");
  });
});

/**
 * Stage 7: the turn summary paragraph, word for word against the served
 * canon's CODEX_TURN_SUMMARY_SENTENCE.
 *
 * The bundled hints are appended AFTER the served canon on every connect, so
 * an agent reads both texts together. A canon edit alone would ship the model
 * a contradiction, which is why this file pins the two together.
 *
 * MUTATION PROOF: change one word of the paragraph in src/agent-hints.ts and
 * the matching sentence below goes red.
 */
describe("BUNDLED_CAPABILITIES turn summary paragraph", () => {
  const SERVED_TRUTH = [
    "Tool rows also carry what a command printed and its exit code, and an edit row carries the lines it added and removed: the host reads all of it off the completed commandExecution and fileChange items, masks secrets, caps the output and counts the diff for you, and it reports this turn's own start and finish from turn/completed.",
    "You fill none of these fields.",
    "Do not paste command output into your answer, do not restate an exit code or a line count in prose, and do not end a turn with a summary of the work, because the folded card already carries one.",
  ];
  const flat = BUNDLED_CAPABILITIES.replace(/\s+/g, " ");

  it.each(SERVED_TRUTH)("says, word for word: %s", (sentence) => {
    expect(flat).toContain(sentence);
  });

  it("carries no em dash and no en dash", () => {
    expect(BUNDLED_CAPABILITIES).not.toMatch(/[\u2013\u2014]/);
  });
});
