/**
 * Capability bootstrap: the pure validate-and-choose logic + the BgosApi GET.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BGOS_AGENT_HINTS } from "../src/agent-hints.js";
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

/**
 * Stage 8: the helper row paragraph, word for word against the served
 * canon's CODEX_HELPERS_SENTENCE.
 *
 * Same reason as every describe above it: the bundled text is appended AFTER
 * the served canon on every connect, so an agent reads both together and any
 * drift between them is a contradiction it has to resolve by itself. Until
 * this stage the bundled hints said nothing at all about child agents, so an
 * agent falling back to them had no idea this host draws them.
 *
 * MUTATION PROOF: change one word of the paragraph in src/agent-hints.ts and
 * the matching sentence below goes red.
 */
describe("BUNDLED_CAPABILITIES helper rows paragraph", () => {
  const SERVED_TRUTH = [
    "When you spawn a collab agent, this host draws each child as its own row on your tool card, keyed on the child's own thread, and fills that row from the collab item and the agent states it carries: the child's nickname or role as the name, the child's own status as the state, its elapsed time from this host's first sight of it, and its status message as the qualifier while it runs and as the result when it ends.",
    "This protocol never tells the host which tool a child is using, so the row shows that status line instead of a tool name, and it carries no token count and no way to stop one child.",
    "Do not narrate your helpers' progress in prose and do not repeat a helper's message in your answer, because the card already carries it.",
  ];
  const flat = BUNDLED_CAPABILITIES.replace(/\s+/g, " ");

  it.each(SERVED_TRUTH)("says, word for word: %s", (sentence) => {
    expect(flat).toContain(sentence);
  });

  it("promises no token count and no per child stop anywhere", () => {
    // Both are things this protocol cannot give, and a hint that hinted at
    // either would have the agent look for a control that is not there.
    expect(flat).not.toContain("stop one helper");
    expect(flat).not.toContain("tokens a helper used");
  });

  it("carries no em dash and no en dash", () => {
    expect(BUNDLED_CAPABILITIES).not.toMatch(/[\u2013\u2014]/);
  });
});

/**
 * Stage 4 (C-21): the generated picture sentence, word for word.
 *
 * The host now posts a picture the runtime's image generation tool made, with
 * its revised prompt as the caption, when the turn finishes (never mid turn,
 * see gap 04). A model that ALSO sends it with MEDIA: or the reply tool would
 * post it twice, and a model that never heard of the post would describe a
 * picture the owner has not seen yet as missing. The served canon's Codex
 * sentence (stage 4's BGOS PR) is copied from THIS text. This describe only
 * compares the plugin with itself; the cross repo pin below is what holds the
 * two repos together.
 *
 * MUTATION PROOF: change one word of the sentence in src/agent-hints.ts and
 * this goes red; put an em dash back in and the dash case goes red.
 */
describe("BUNDLED_CAPABILITIES generated picture sentence", () => {
  /**
   * Review findings 3 and 5. The picture posts itself from a CHAT turn only:
   * a meeting takes text only (meeting_reply and the meeting reply tool
   * refuse files), and a voice task runs detached and its result goes to
   * the call, so neither posts one. The first sentence therefore names the
   * chat turn, and the last says what to do in the others, because an
   * unscoped promise told a model in a meeting that the room could see a
   * picture it could not, and told a model in a voice task not to use the one
   * tool that would deliver it. The middle sentence keeps the model's view
   * honest when a picture cannot be shown: the chat says so.
   *
   * Re-review item 6: a voice CONSULT is a third place. It runs with no HOAI
   * tools at all and is told to send nothing, so "send it with the reply
   * tool" was an instruction it could not follow. A consult is told the
   * picture stays saved on this machine (the runtime's own copy, under the
   * Codex home, never in the workspace) and to describe it. A voice task
   * (a dispatch) keeps the reply tool, which its tool context really has.
   */
  const SERVED_TRUTH =
    "In a chat turn, a picture you make with image generation posts itself to the chat when the turn finishes, with its prompt as the caption; do not send it again with MEDIA: or the reply tool. If it cannot be shown, the chat says so in one plain line. In a meeting, a voice task or a consult nothing posts it: a meeting takes text only, so describe the picture there; in a voice task copy it into the workspace and send it with the reply tool; and a consult sends nothing, so say the picture is saved on this machine and describe it.";
  const flat = BUNDLED_CAPABILITIES.replace(/\s+/g, " ");

  it("says, word for word, the sentences the served canon copies", () => {
    expect(flat).toContain(SERVED_TRUTH);
  });

  it("never promises the post outside a chat turn", () => {
    expect(flat).not.toMatch(
      /(^|[.;:] )A picture you make with image generation posts itself/,
    );
  });

  it("never tells a consult to use a tool it does not have, or that the picture is in the workspace", () => {
    const consult = SERVED_TRUTH.slice(SERVED_TRUTH.indexOf("a consult sends"));
    expect(consult).not.toContain("reply tool");
    expect(consult).not.toContain("workspace");
    expect(flat).toContain("a consult sends nothing");
  });

  it("says when the turn finishes, never the instant the picture is made", () => {
    expect(flat).not.toMatch(/the instant (the|a|your) (tool call|picture|image)/i);
  });

  it("carries no em dash and no en dash", () => {
    expect(SERVED_TRUTH).not.toMatch(/[\u2013\u2014]/);
    expect(BUNDLED_CAPABILITIES).not.toMatch(/[\u2013\u2014]/);
  });
});

/**
 * Cross repo pin: the generated picture sentence, by sha256, from BOTH sides.
 *
 * The BGOS served canon carries this sentence as CODEX_GENERATED_IMAGES_SENTENCE
 * (backend/src/integrations/capability-canon.ts) and its markdown mirror
 * carries it again. Every agent reads the served canon first and this bundled
 * text after it, so the two must say the same thing. The word for word case
 * above compares this repo only with itself: change the hint and SERVED_TRUTH
 * together and it stays green while the canon says something else. So the
 * sentence is also pinned by ONE sha256, the same hex string in both repos.
 *
 * THE TWIN TEST. BrandGrowthOS/BGOS,
 * backend/src/integrations/capability-canon.codex-images.spec.ts, describe
 * "the generated picture sentence, pinned across repos", pins the same
 * GENERATED_PICTURE_SENTENCE_SHA256 against CODEX_GENERATED_IMAGES_SENTENCE
 * (after its "- ") and the mirror's line. Either repo drifting turns its own
 * test red.
 *
 * THE RULE. Change this sentence on this side only together with the BGOS PR
 * that changes the canon constant and the mirror to the same words, and
 * update the pinned hash in BOTH tests, in those two PRs. A red here is that
 * reminder: never make it green by moving one side's hash alone.
 *
 * WHAT IS HASHED. The paragraph exactly as src/agent-hints.ts exports it in
 * BGOS_AGENT_HINTS: from the line that opens "In a chat turn, a picture" up to
 * the line that opens "ask_user_input asks", with each line break turned into
 * one space, because the hint file wraps the paragraph over seven lines and
 * the canon holds it on one. That is the only normalisation. Spaces are not
 * collapsed, so a doubled space is a change too. UTF-8, 530 bytes.
 */
describe("the generated picture sentence, pinned across repos", () => {
  /** The same hex string as the BGOS twin test. Update both or neither. */
  const GENERATED_PICTURE_SENTENCE_SHA256 =
    "fe528db206e5ac09a296e624695e368f87bfb9fe904111305b0a889da436db98";

  function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  /** The paragraph as the hint file holds it, with its line wrapping undone. */
  function heldSentence(hints: string): string {
    const opens = hints.indexOf("\nIn a chat turn, a picture ");
    expect(
      opens,
      'src/agent-hints.ts has no line opening "In a chat turn, a picture "',
    ).toBeGreaterThanOrEqual(0);
    const next = hints.indexOf("\nask_user_input asks ", opens + 1);
    expect(
      next,
      'src/agent-hints.ts has no "ask_user_input asks" line after the picture paragraph',
    ).toBeGreaterThan(opens);
    return hints.slice(opens + 1, next).replace(/\n/g, " ");
  }

  it("hashes to the sha256 the BGOS canon pins too", () => {
    const held = heldSentence(BGOS_AGENT_HINTS);
    expect(
      sha256(held),
      "The generated picture sentence in src/agent-hints.ts no longer matches the sha256 " +
        "BrandGrowthOS/BGOS pins for CODEX_GENERATED_IMAGES_SENTENCE. Change it only together " +
        "with the BGOS PR that moves the canon and its mirror to the same words, and update " +
        "GENERATED_PICTURE_SENTENCE_SHA256 in both repos. The hashed text was: " +
        held,
    ).toBe(GENERATED_PICTURE_SENTENCE_SHA256);
  });

  it("is not vacuous: one changed character changes the hash", () => {
    const held = heldSentence(BGOS_AGENT_HINTS);
    const drifted = held.replace("chat turn,", "chat turn;");
    expect(drifted).not.toBe(held);
    expect(sha256(drifted)).not.toBe(GENERATED_PICTURE_SENTENCE_SHA256);
  });
});
