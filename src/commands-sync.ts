import type { BgosApi } from "./bgos-api.js";
import type { CommandManifestEntry } from "./types.js";

/**
 * Per-assistant command manifest sync. Debounces rapid changes into at
 * most one PUT every DEBOUNCE_MS. Analogous to Telegram plugin's
 * setMyCommands flow (see bot-native-commands.ts in OpenClaw's telegram
 * extension).
 */
export class CommandsSync {
  private static readonly DEBOUNCE_MS = 2000;

  private readonly pending = new Map<number, CommandManifestEntry[]>();
  private timers = new Map<number, NodeJS.Timeout>();

  constructor(private readonly api: BgosApi) {}

  /**
   * Queue a replacement manifest for an assistant. Coalesces multiple
   * calls within DEBOUNCE_MS into a single PUT.
   */
  schedule(assistantId: number, commands: CommandManifestEntry[]): void {
    this.pending.set(assistantId, commands);
    const existing = this.timers.get(assistantId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      void this.flush(assistantId);
    }, CommandsSync.DEBOUNCE_MS);
    this.timers.set(assistantId, t);
  }

  /** Force-sync all pending - useful on graceful shutdown or pair-ready. */
  async flushAll(): Promise<void> {
    const ids = [...this.pending.keys()];
    await Promise.all(ids.map((id) => this.flush(id)));
  }

  private async flush(assistantId: number): Promise<void> {
    const commands = this.pending.get(assistantId);
    this.pending.delete(assistantId);
    this.timers.delete(assistantId);
    if (!commands) return;
    await this.api.putCommands(assistantId, commands);
  }
}
