/**
 * Inline-agent identity sanitizer.
 *
 * SECURITY: `FromAgentInput.name` (and `avatarUrl`/`color`) is free-form,
 * agent-supplied text. The BGOS backend now binds `fromAgent` identity to
 * the calling assistant and gates inline identities behind a per-user
 * toggle (default off), so a plugin-forwarded display name is untrusted
 * spoofable input - an agent could label its bubble as anyone.
 *
 * By default this plugin therefore strips the free-form display fields and
 * forwards only the resolvable handles (`peerId`/`assistantId`/
 * `externalId`/`type`), letting the backend resolve the real identity.
 * Hosts that genuinely need inline names (e.g. Codex `/board` with the
 * matching backend toggle on) opt in via `CODEX_BGOS_ALLOW_INLINE_AGENT_NAME`.
 *
 * Lives in its own module (rather than inside outbound.ts) so the direct
 * proactive sender can apply the same policy without an import cycle.
 */
import type { FromAgentInput } from "./types.js";

/**
 * Whether the agent is allowed to set a free-form inline display name /
 * avatar / color on `fromAgent`. Default OFF. Resolved on every call so
 * the host can flip it without a restart.
 */
export function inlineAgentNameAllowed(): boolean {
  const raw = (process.env.CODEX_BGOS_ALLOW_INLINE_AGENT_NAME ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Sanitize an agent-supplied `fromAgent` identity for the wire.
 *
 * Always passes through the resolvable handles (`peerId`/`assistantId`/
 * `externalId`/`type`). Drops the free-form `name`/`avatarUrl`/`color`
 * unless `CODEX_BGOS_ALLOW_INLINE_AGENT_NAME` is enabled. Returns `undefined`
 * when nothing meaningful remains, so callers don't stamp an empty
 * `fromAgent` onto the payload.
 */
export function sanitizeFromAgent(
  from: FromAgentInput | undefined,
): FromAgentInput | undefined {
  if (!from) return undefined;
  if (inlineAgentNameAllowed()) return from;
  const safe: FromAgentInput = {};
  if (from.peerId !== undefined) safe.peerId = from.peerId;
  if (from.assistantId !== undefined) safe.assistantId = from.assistantId;
  if (from.externalId !== undefined) safe.externalId = from.externalId;
  if (from.type !== undefined) safe.type = from.type;
  // Drop name / avatarUrl / color - the backend resolves the identity.
  const hasAny =
    safe.peerId !== undefined ||
    safe.assistantId !== undefined ||
    safe.externalId !== undefined ||
    safe.type !== undefined;
  return hasAny ? safe : undefined;
}
