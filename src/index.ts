/**
 * codex-channel-bgos: make OpenAI Codex agents first-class BGOS agents.
 *
 * The daemon is normally run via the CLI (`codex-channel-bgos connect <code>`).
 * These exports let the pieces be embedded or tested programmatically.
 */
export { CodexAdapter } from "./adapter.js";
export type { CodexAdapterOptions, FatalInfo } from "./adapter.js";
export { CodexHost } from "./codex-host.js";
export type {
  CodexHostOptions,
  RunTurnCallbacks,
  RunTurnResult,
} from "./codex-host.js";
export { resolveAuthMode } from "./auth-mode.js";
export type { AuthForce, AuthResolution } from "./auth-mode.js";
export { parseReply } from "./reply-markers.js";
export type { ParsedReply } from "./reply-markers.js";
export { buildCodexInput } from "./inbound-input.js";
export type { InboundFileForCodex } from "./inbound-input.js";
export { RunAccumulator, toolCardFromItem } from "./event-mapper.js";
export type { ToolCard } from "./event-mapper.js";
export { BGOS_AGENT_HINTS } from "./agent-hints.js";
export { pairBgos } from "./pair-cli.js";
export { loadConfig } from "./load-config.js";
export { getPackageVersion } from "./version.js";
