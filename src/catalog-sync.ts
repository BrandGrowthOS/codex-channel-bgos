import type { BgosApi } from "./bgos-api.js";
import type { AgentCatalogEntry } from "./types.js";

/**
 * Push the agent catalog to BGOS so the Integrations card's checklist
 * populates with the available-to-bind agents.
 *
 * Fail-open: catalog push is non-fatal. If it errors we log + return so
 * the daemon stays connected. The user can either retry by reloading the
 * Integrations card (which calls `/integrations/me`) or restart the
 * daemon.
 *
 * Caller is responsible for resolving `pairing_id` (typically by
 * `BgosApi.whoami()` on connect) and providing the agent list.
 */

export interface CatalogAgent {
  /** Stable identifier the host uses to dispatch (e.g. `"general"`,
   *  `"critic"`, etc.). Becomes the assistant's `agent_route` in BGOS. */
  route: string;
  /** Display name shown on the Integrations checklist. */
  name: string;
  /** Optional one-line description for the checklist row. */
  description?: string;
  /** Optional avatar URL for the checklist row. */
  avatarUrl?: string;
}

export async function syncCatalog(
  api: BgosApi,
  pairingId: number,
  agents: CatalogAgent[],
): Promise<void> {
  if (!agents.length) {
    // eslint-disable-next-line no-console
    console.warn(
      "[codex-channel-bgos] syncCatalog called with empty agent list - skipping",
    );
    return;
  }
  const entries: AgentCatalogEntry[] = agents.map((a) => ({
    agent_route: a.route,
    name: a.name,
    description: a.description,
    avatar_url: a.avatarUrl,
  }));
  try {
    await api.pushAgentCatalog(pairingId, entries);
  } catch (err) {
    // Fail-open. Surface the message so logs are useful but never
    // throw - `BGOSAdapter.start()` calls this path and a 5xx in
    // catalog push must NOT take down the adapter.
    // eslint-disable-next-line no-console
    console.warn(
      "[codex-channel-bgos] agent catalog push failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}
