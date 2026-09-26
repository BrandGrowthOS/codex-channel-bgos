/**
 * THE MODEL AND EFFORT REPORT (P5 stage 7, C-26, the Codex slice).
 *
 * What this daemon tells HOAI a chat is REALLY running, so the app can draw a
 * quiet row under the message box: the model and the reasoning effort, as
 * the runtime names them. A report, never a command: the owner changes the
 * pair with the ordinary `/model` and `/effort`, and the row moves only when
 * one of these reports lands.
 *
 * Pure, so every rule below is tested on recorded wire shapes
 * (test/session-report.spec.ts). The host fires the reports and the adapter
 * sends them; neither decides WHAT a report says. That is here.
 *
 * THE TWO SPELLINGS. The `thread/settings/updated` notification says
 * `effort`; the `thread/start`, `thread/resume` and `thread/read` responses
 * say `reasoningEffort`. The runtime says `serviceTier: "default"` where the
 * plugin's own store says `null` for the standard tier (S13), and a report
 * maps one onto the other, so the store's value and the runtime's echo of it
 * 12 ms later are the SAME report and never cost a second write.
 *
 * THE PATTERNS are the store's own `clean()` (session-settings.ts) and the
 * backend's report DTO, so a value the daemon stores is always a value the
 * route accepts (S3). A value from the RUNTIME never went through `clean()`,
 * so it is checked here: a model that fails sends NOTHING (never a truncated
 * or rewritten id), an effort or tier that fails is sent as null.
 *
 * The service tier is CARRIED and never drawn: fast mode was not probed in
 * the stage 7 gate, so the app claims nothing about it (the spec's L7).
 */
import type { SessionSettings } from "./session-settings.js";

/** One report, exactly the body the rail stores (all five keys, always). */
export interface SessionReport {
  model: string;
  effort: string | null;
  serviceTier: string | null;
  rerouted: boolean;
  reportedAt: string;
}

/**
 * The body's fields in the rail's canonical order. The backend's
 * ReportSessionSettingsDto declares them in this order and the cross repo pin
 * (SESSION_SETTINGS_RAIL_SHA256 below) hashes them in this order.
 */
export const SESSION_REPORT_FIELDS = Object.freeze([
  "model",
  "effort",
  "serviceTier",
  "rerouted",
  "reportedAt",
] as const);

/**
 * THE CROSS REPO PIN (P5 stage 7, spec section 6; Ares, 15:10). The sha256 of
 * the rail's canonical shape
 *
 *   session_model_control;PATCH;integrations/assistants/{assistantId}/chats/{chatId}/session-settings;model,effort,serviceTier,rerouted,reportedAt
 *
 * the capability token this daemon declares, the method and path
 * `BgosApi.reportSessionSettings` sends, and the keys of the body the adapter
 * sends, in order. BGOS carries the SAME constant
 * (`backend/src/session-settings/session-settings-rail.ts`); each side
 * rebuilds the string from its OWN source values in a test
 * (test/session-rail-contract.spec.ts here) and compares the hash, so a one
 * sided change that also updates its own word for word pin turns the hash
 * red. Move it only with the other repo's PR.
 */
export const SESSION_SETTINGS_RAIL_SHA256 =
  "d0976f00e57f0d5d051cf5ce92e4d1b140cad9f1c86becda0a4fbcb37f4a2a30";

const MODEL = /^[\w./:-]{1,160}$/;
const EFFORT = /^[a-z]{1,20}$/;
const TIER = /^[\w-]{1,50}$/;

type Wire = Record<string, unknown>;

function isObject(value: unknown): value is Wire {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelOf(value: unknown): string | null {
  return typeof value === "string" && MODEL.test(value) ? value : null;
}

function effortOf(value: unknown): string | null {
  return typeof value === "string" && EFFORT.test(value) ? value : null;
}

/**
 * The runtime's `"default"` is the store's `null` (S13). Anything that fails
 * the route's pattern is null too, never a rewritten tier.
 */
export function normalizeTier(value: unknown): string | null {
  if (typeof value !== "string" || value === "default") return null;
  return TIER.test(value) ? value : null;
}

function report(
  model: string | null,
  effort: string | null,
  serviceTier: string | null,
  rerouted: boolean,
  at: Date,
): SessionReport | null {
  if (!model) return null;
  return { model, effort, serviceTier, rerouted, reportedAt: at.toISOString() };
}

/**
 * The chat's STORED pair (S12: store first). The plugin re-asserts the store
 * as `turn/start` overrides on every turn, so a stored model IS what the next
 * turn runs. Null when nothing is stored: the plugin's own guess (the
 * catalog's default) is never reported, because the runtime's default comes
 * from config.toml and can differ.
 */
export function reportFromStored(
  settings: SessionSettings,
  at: Date = new Date(),
): SessionReport | null {
  return report(
    modelOf(settings.model),
    effortOf(settings.effort),
    normalizeTier(settings.serviceTier),
    false,
    at,
  );
}

/**
 * `thread/settings/updated {threadId, threadSettings}`: the runtime announcing
 * the settings a thread now runs on. Its effort field is `effort`.
 */
export function reportFromThreadSettings(
  threadSettings: unknown,
  at: Date = new Date(),
): SessionReport | null {
  if (!isObject(threadSettings)) return null;
  return report(
    modelOf(threadSettings.model),
    effortOf(threadSettings.effort),
    normalizeTier(threadSettings.serviceTier),
    false,
    at,
  );
}

/**
 * A `thread/start`, `thread/resume` or `thread/read` result. The start and
 * resume responses carry `model`, `reasoningEffort` and `serviceTier` at the
 * top level AND the pair again on `result.thread`; a read carries it on
 * `result.thread` only. So each field is read at the top level first and on
 * the thread second (a top level string wins even when it fails the pattern:
 * the runtime said it, and a failed value is not replaced by a guess). The
 * tier exists at the top level only.
 */
export function reportFromThreadResponse(
  result: unknown,
  at: Date = new Date(),
): SessionReport | null {
  if (!isObject(result)) return null;
  const thread = isObject(result.thread) ? result.thread : {};
  const pick = (key: string): unknown =>
    typeof result[key] === "string" ? result[key] : thread[key];
  return report(
    modelOf(pick("model")),
    effortOf(pick("reasoningEffort")),
    normalizeTier(result.serviceTier),
    false,
    at,
  );
}

/**
 * `model/rerouted {threadId, turnId, fromModel, toModel, reason}` (S14): the
 * runtime ran this turn on another model. Reported as the model that RAN,
 * flagged, with the effort and tier last reported for the chat (the
 * notification names neither). The host reports the chat again, unflagged,
 * at its next `turn/started`.
 */
export function reportFromReroute(
  params: unknown,
  last: SessionReport | null,
  at: Date = new Date(),
): SessionReport | null {
  if (!isObject(params)) return null;
  return report(
    modelOf(params.toModel),
    last?.effort ?? null,
    last?.serviceTier ?? null,
    true,
    at,
  );
}

/**
 * The value without its timestamp: what makes two reports "the same" for the
 * adapter's dedupe (S15) and for the backend's no op (S5).
 */
export function reportKey(value: SessionReport): string {
  return JSON.stringify([
    value.model,
    value.effort,
    value.serviceTier,
    value.rerouted,
  ]);
}

/**
 * The PATCH body: all five fields, in SESSION_REPORT_FIELDS order, built from
 * the named fields only (never a spread of whatever the report object holds).
 */
export function reportBody(value: SessionReport): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of SESSION_REPORT_FIELDS) body[field] = value[field];
  return body;
}
