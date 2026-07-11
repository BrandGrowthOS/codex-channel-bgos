import type { CommandManifestEntry } from "./types.js";

/**
 * The Codex adapter's built-in user-invocable slash commands.
 *
 * These pre-populate BGOS's slash picker for a freshly bound assistant. They are
 * bridge-local: the daemon handles them and Codex never sees them (see
 * inbound/adapter). Names match `^[a-z0-9_]{1,32}$`, descriptions <=100 chars.
 * Order is the picker order.
 */
const _DEFAULT_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: "new", description: "Start a fresh conversation (resets the Codex thread)" },
  { name: "retry", description: "Re-run your last message" },
  { name: "status", description: "Show the Codex daemon health and auth mode" },
] as const;

/**
 * Manifest entries ready to PUT to `/api/v1/integrations/assistants/:id/commands`.
 * `order_index` preserves the order above on the picker.
 */
export const DEFAULT_COMMANDS: ReadonlyArray<CommandManifestEntry> =
  _DEFAULT_COMMANDS.map((c, i) => ({
    command: c.name,
    description: c.description,
    order_index: i,
  }));

/**
 * Seed-mode controls how aggressively the adapter reseeds the default manifest:
 *   - auto   seed only when command_count === 0 (safe default; undefined -> skip)
 *   - safe   like auto but also seeds when command_count is undefined
 *   - always seed unconditionally (idempotent)
 *   - never  never auto-seed
 * Configure via CODEX_BGOS_RESEED_COMMANDS or the commandSeedMode config.
 */
export type CommandSeedMode = "auto" | "safe" | "always" | "never";

const VALID_MODES: ReadonlyArray<CommandSeedMode> = [
  "auto",
  "safe",
  "always",
  "never",
];

/** Read CODEX_BGOS_RESEED_COMMANDS -> normalized mode. Empty/invalid -> "auto". */
export function resolveCommandSeedMode(): CommandSeedMode {
  const raw = (process.env.CODEX_BGOS_RESEED_COMMANDS ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return "auto";
  if ((VALID_MODES as readonly string[]).includes(raw)) {
    return raw as CommandSeedMode;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[codex-channel-bgos] CODEX_BGOS_RESEED_COMMANDS=${JSON.stringify(raw)} ` +
      `is not recognized (expected one of ${VALID_MODES.join(", ")}). ` +
      `Falling back to "auto".`,
  );
  return "auto";
}

/**
 * Decide whether to seed defaults for an assistant given the command_count from
 * whoami and the seed mode.
 *   auto:   count===0 -> seed (undefined -> skip)
 *   safe:   count===0 -> seed (undefined -> seed)
 *   always: seed
 *   never:  skip
 */
export function shouldSeedDefaults(
  commandCount: number | undefined,
  mode: CommandSeedMode = "auto",
): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  if (commandCount === 0) return true;
  if (mode === "safe" && commandCount === undefined) return true;
  return false;
}
