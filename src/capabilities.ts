/**
 * Capability bootstrap (fetch-on-connect).
 *
 * The BGOS backend owns the machine-readable capability canon and serves it per
 * channel at `GET /api/v1/integrations/capabilities?channel=codex`. The daemon
 * fetches it once at connect and writes the returned `text` to the Codex agent's
 * AGENTS.md (see CodexHost.applyAgentHints), so a connected agent always sees the
 * current canon without a daemon release. When the endpoint is unreachable (old
 * backend, network, revoked token, malformed body) the daemon keeps the frozen
 * `BGOS_AGENT_HINTS` copy it shipped with. A fetch failure NEVER hard-fails the
 * daemon.
 *
 * This module holds only PURE helpers (no I/O), so the validate-and-choose logic
 * is unit-tested; the fetch + AGENTS.md write live in bgos-api.ts / codex-host.ts.
 */
import { BGOS_AGENT_HINTS } from "./agent-hints.js";

/** The bundled, offline fallback shipped with the daemon. */
export const BUNDLED_CAPABILITIES = BGOS_AGENT_HINTS;

/** Shape of GET /integrations/capabilities?channel=codex. */
export interface ServedCapabilities {
  channel: string;
  version: string;
  text: string;
  core: string;
  channelSyntax: string;
}

/**
 * Whether a payload looks like a real BGOS capability canon. The served text
 * opens with "# BGOS Channel Agent Capabilities" and the bundled copy with
 * "# BGOS Channel, Agent Capabilities"; both carry the two dash-free markers, so
 * matching on both rejects an empty or garbage body while accepting either form.
 */
export function hasCanonMarkers(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  return text.includes("BGOS Channel") && text.includes("Agent Capabilities");
}

export interface PickedCapabilities {
  text: string;
  source: "backend" | "bundled";
}

/**
 * Choose the agent-hints text to inject: the served canon when it is present and
 * well-formed, else the bundled fallback. Pure and total (never throws), so the
 * connect path can call it on any input, including a failed fetch (pass null).
 */
export function pickCapabilitiesText(
  fetched: ServedCapabilities | null | undefined,
  bundled: string = BUNDLED_CAPABILITIES,
): PickedCapabilities {
  const served = fetched?.text;
  if (
    typeof served === "string" &&
    served.trim().length > 0 &&
    hasCanonMarkers(served)
  ) {
    return { text: served, source: "backend" };
  }
  return { text: bundled, source: "bundled" };
}
