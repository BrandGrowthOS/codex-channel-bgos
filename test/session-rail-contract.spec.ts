/**
 * THE CROSS REPO PIN for the model and effort report rail (P5 stage 7, C-26,
 * spec section 6, Ares 15:10), from the PLUGIN's side.
 *
 * The rail's shape is true only because of the other repo: the route and the
 * body this daemon sends must be the route and the DTO the BGOS backend
 * declares, and the token this daemon declares must be the token the backend
 * reads. So it is pinned by ONE hash in both repos:
 *
 *   sha256("session_model_control;PATCH;integrations/assistants/{assistantId}/chats/{chatId}/session-settings;model,effort,serviceTier,rerouted,reportedAt;model=<pattern>,effort=<pattern>,serviceTier=<pattern>")
 *     = SESSION_SETTINGS_RAIL_SHA256 (src/session-report.ts here, and
 *       backend/src/session-settings/session-settings-rail.ts in
 *       BrandGrowthOS/BGOS, whose session-settings-rail.contract.spec.ts
 *       rebuilds the string from the controller's Nest metadata and the
 *       report DTO's class-validator metadata).
 *
 * Each side REBUILDS the string from its OWN source values, never from a copy
 * of it. Here, all three parts come out of ONE real report: a runtime
 * `thread/settings/updated` goes into a REAL adapter and a REAL host, and the
 * token is the one DECLARED_CAPABILITIES carries, the method and path are what
 * the fake HTTP client recorded when the real `BgosApi.reportSessionSettings`
 * sent it (the two ids written back as `{assistantId}` and `{chatId}`), and
 * the fields are the keys of the body it sent, in order, and (P5 stage 7,
 * Phase B, decision 9) the value patterns are the `.source` of the regular
 * expressions the report builders really test a value against
 * (SESSION_REPORT_PATTERNS), because a backend that tightened its pattern
 * would 400 every report this daemon sends and nothing on either side would
 * go red. A one sided edit that
 * also updates its own word for word pin (a field renamed here and in the
 * literal below, say) leaves the word for word case green and turns ONLY the
 * hash case red. Change the rail only with the other repo's PR, and move the
 * hash in both.
 *
 * Held by convention, not by this hash: what the token PROMISES (that the
 * reported value is what the runtime really runs) is held by this repo's own
 * tests (session-report.spec.ts, session-report-host.spec.ts), because a hash
 * pins a string, not a behaviour. And a change made to BOTH of BGOS's
 * constants in one BGOS PR (its canonical string and its hash, say a route
 * segment renamed on both) keeps BGOS green and this repo green while every
 * report 404s: that pairing of two PRs is held by convention, beyond the pin.
 *
 * Mutations recorded in BGOS's docs/reports/2026-09-26-p5-s7-model-row/
 * red-proofs.md, under "Plugin · PL5". No em or en dashes anywhere in this file.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CodexAdapter } from "../src/adapter.js";
import {
  DECLARED_CAPABILITIES,
  SESSION_MODEL_CONTROL,
} from "../src/declared-capabilities.js";
import {
  SESSION_REPORT_FIELDS,
  SESSION_REPORT_PATTERNS,
  SESSION_SETTINGS_RAIL_SHA256,
} from "../src/session-report.js";

const CANONICAL = String.raw`session_model_control;PATCH;integrations/assistants/{assistantId}/chats/{chatId}/session-settings;model,effort,serviceTier,rerouted,reportedAt;model=^[\w./:-]{1,160}$,effort=^[a-z]{1,20}$,serviceTier=^[\w-]{1,50}$`;
const ASSISTANT = 111;
const CHAT = 222;

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/session-report-wire.json", import.meta.url),
    "utf8",
  ),
);

let home: string;
const envBefore = process.env.CODEX_BGOS_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-session-rail-"));
  process.env.CODEX_BGOS_HOME = home;
});
afterEach(() => {
  if (envBefore === undefined) delete process.env.CODEX_BGOS_HOME;
  else process.env.CODEX_BGOS_HOME = envBefore;
  rmSync(home, { recursive: true, force: true });
});

/**
 * One real report, end to end: the recorded runtime notification into a real
 * adapter and host, out through the real BgosApi into a fake HTTP client.
 */
async function sentReport(): Promise<{
  method: string;
  url: string;
  data: Record<string, unknown>;
}> {
  writeFileSync(
    join(home, "threads.json"),
    JSON.stringify({ [CHAT]: "thread-rail" }),
  );
  const adapter = new CodexAdapter(
    {
      baseUrl: "http://127.0.0.1:9",
      pairingToken: "t".repeat(32),
      reconnect: { initialDelayMs: 1, maxDelayMs: 2 },
    } as any,
    { ok: true, mode: "chatgpt", label: "codex login (test)" },
  ) as any;
  try {
    adapter.assistantToRoute.set(ASSISTANT, "codex");
    adapter.identityReady = true;
    const request = vi.fn(async () => ({ data: { ok: true, applied: true } }));
    adapter.api.http = { request };
    adapter.host.notification("thread/settings/updated", {
      ...structuredClone(wire.threadSettingsUpdated),
      threadId: "thread-rail",
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    return (request.mock.calls[0] as any[])[0];
  } finally {
    adapter.host.close();
  }
}

/** The canonical string, rebuilt from what this daemon declares and sends. */
async function rebuilt(): Promise<string> {
  const call = await sentReport();
  const token = DECLARED_CAPABILITIES.find((t) => t === SESSION_MODEL_CONTROL);
  expect(token, "the token is not declared").toBeDefined();
  const path = call.url
    .replace(`assistants/${ASSISTANT}/`, "assistants/{assistantId}/")
    .replace(`chats/${CHAT}/`, "chats/{chatId}/");
  // The patterns the builders test a value against, in the rail's order.
  const patterns = Object.entries(SESSION_REPORT_PATTERNS)
    .map(([field, pattern]) => `${field}=${pattern.source}`)
    .join(",");
  return [
    token,
    call.method,
    path,
    Object.keys(call.data).join(","),
    patterns,
  ].join(";");
}

describe("the model and effort report rail, pinned from the plugin's side", () => {
  it("word for word: the token, the method and path, the fields, the patterns", async () => {
    expect(SESSION_MODEL_CONTROL).toBe("session_model_control");
    expect([...SESSION_REPORT_FIELDS]).toEqual([
      "model",
      "effort",
      "serviceTier",
      "rerouted",
      "reportedAt",
    ]);
    expect(await rebuilt()).toBe(CANONICAL);
  });

  it("the hash of what this daemon really sends matches the constant BGOS carries", async () => {
    expect(sha256(await rebuilt())).toBe(SESSION_SETTINGS_RAIL_SHA256);
  });

  it("the constant is a real sha256 hex digest, not a placeholder", () => {
    expect(SESSION_SETTINGS_RAIL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(SESSION_SETTINGS_RAIL_SHA256).not.toMatch(/^(.)\1{63}$/);
  });

  it("is not vacuous: one changed character anywhere changes the hash", () => {
    // No variant touches `effort`: the PL5 mutation renames exactly that
    // field in CANONICAL, and a variant that then replaced nothing would go
    // red for the wrong reason.
    const base = sha256(CANONICAL);
    for (const variant of [
      CANONICAL.replace("session_model_control", "session_model_contro1"),
      CANONICAL.replace(";PATCH;", ";POST;"),
      CANONICAL.replace("chats/{chatId}", "chat/{chatId}"),
      CANONICAL.replace(",rerouted,", ",reRouted,"),
      CANONICAL.replace(";model,", ";modelId,"),
      CANONICAL.replace("{1,160}", "{1,100}"),
      CANONICAL.replace("serviceTier=^[\\w-]{1,50}$", "serviceTier=^[\\w-]{1,49}$"),
      `${CANONICAL} `,
    ]) {
      expect(variant).not.toBe(CANONICAL);
      expect(sha256(variant)).not.toBe(base);
    }
  });

  it("the body the adapter sent carries the recorded runtime values", async () => {
    const call = await sentReport();
    expect(call.data).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "medium",
      serviceTier: null,
      rerouted: false,
    });
    expect(typeof call.data.reportedAt).toBe("string");
  });
});
