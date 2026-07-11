/**
 * Decision D7: prefer an existing `codex login` (ChatGPT plan, zero marginal
 * cost), fall back to OPENAI_API_KEY (metered), refuse to start with neither.
 *
 * Pure resolver: the daemon feeds it the observable facts (does ~/.codex/auth.json
 * exist, is OPENAI_API_KEY set, was a mode forced) and gets back the active mode,
 * a human label to print at startup, and, for apikey mode, the key to hand the
 * Codex SDK (which injects it as CODEX_API_KEY). See codex-host for how chatgpt
 * mode strips the key from the child env so the CLI uses the login instead.
 */

export type AuthForce = "auto" | "chatgpt" | "apikey";

export interface AuthResolutionOk {
  ok: true;
  mode: "chatgpt" | "apikey";
  /** Present only in apikey mode: the key to pass to the Codex SDK. */
  apiKey?: string;
  /** One-line human summary for the startup banner and heartbeat. */
  label: string;
}

export interface AuthResolutionErr {
  ok: false;
  error: string;
}

export type AuthResolution = AuthResolutionOk | AuthResolutionErr;

export interface AuthInput {
  /** Whether ~/.codex/auth.json (a prior `codex login`) exists. */
  authJsonExists: boolean;
  /** OPENAI_API_KEY value, if any (env or ~/.env). */
  openaiKey?: string | null;
  /** CODEX_BGOS_AUTH_MODE override; default "auto" prefers the login. */
  forced?: AuthForce;
}

const NEITHER_ERROR =
  "No Codex credentials found. Sign in with `codex login`, or set OPENAI_API_KEY " +
  "(for example in ~/.env), then run the command again.";

const NO_KEY_ERROR =
  "CODEX_BGOS_AUTH_MODE=apikey was requested but OPENAI_API_KEY is not set. " +
  "Set OPENAI_API_KEY (for example in ~/.env), then run the command again.";

const NO_LOGIN_ERROR =
  "CODEX_BGOS_AUTH_MODE=chatgpt was requested but no `codex login` was found " +
  "(~/.codex/auth.json is missing). Run `codex login` first, then run the command again.";

function cleanKey(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveAuthMode(input: AuthInput): AuthResolution {
  const forced: AuthForce = input.forced ?? "auto";
  const key = cleanKey(input.openaiKey);
  const hasLogin = input.authJsonExists === true;

  if (forced === "chatgpt") {
    if (hasLogin) {
      return { ok: true, mode: "chatgpt", label: "codex login (ChatGPT plan)" };
    }
    return { ok: false, error: NO_LOGIN_ERROR };
  }

  if (forced === "apikey") {
    if (key) {
      return { ok: true, mode: "apikey", apiKey: key, label: "OPENAI_API_KEY" };
    }
    return { ok: false, error: NO_KEY_ERROR };
  }

  // auto: prefer the login, then the key, then refuse.
  if (hasLogin) {
    return { ok: true, mode: "chatgpt", label: "codex login (ChatGPT plan)" };
  }
  if (key) {
    return { ok: true, mode: "apikey", apiKey: key, label: "OPENAI_API_KEY" };
  }
  return { ok: false, error: NEITHER_ERROR };
}
