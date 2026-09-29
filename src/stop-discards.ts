/**
 * The Stop pauses an owner discarded (P6 stage 3, C-32, review F4).
 *
 * An owner Stop pauses the chat's open mission with STOP_PAUSE_REASON, and
 * the owner's next turn resumes it (D11), after a restart too: the first
 * owner turn in a chat reads the server once and resumes a pause with that
 * exact reason (D12). /new and a Sessions resume leave the context that
 * Stop paused, and no later owner turn may resume the mission from it (spec
 * 4.2, D25). This process's memory of that ends with it, so the mission ids
 * are kept on disk, and the restart's read skips them.
 *
 * Small and bounded: an id is added only by /new or a Sessions resume in a
 * chat that had a Stop pause, and a fresh Stop pause of the same mission
 * takes it out again. Never throws: a file that cannot be read is empty, and
 * a write that fails is logged while the id is still held for this process.
 *
 * The goal lane keeps a second file of the same shape, of CHAT ids: the
 * chats whose goal an owner Stop found held (D36), so a restart before the
 * owner's next message cannot start it again (review F1).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOG = "[codex-channel-bgos]";
const DEFAULT_CAPACITY = 200;

/** What the mission lane needs of the store. */
export interface StopDiscardStore {
  has(missionId: number): boolean;
  add(missionId: number): void;
  delete(missionId: number): void;
}

export class StopDiscards implements StopDiscardStore {
  private ids: number[] | null = null;

  /** `path` null keeps the ids in memory only (the lane's default). */
  constructor(
    private readonly path: string | null,
    private readonly capacity = DEFAULT_CAPACITY,
  ) {}

  has(missionId: number): boolean {
    return this.load().includes(missionId);
  }

  add(missionId: number): void {
    if (!isMissionId(missionId)) return;
    const ids = this.load();
    if (ids.includes(missionId)) return;
    ids.push(missionId);
    // The oldest go first: a discard that old is from a context nobody will
    // come back to, and the file must not grow for ever.
    while (ids.length > Math.max(1, this.capacity)) ids.shift();
    this.save(ids);
  }

  delete(missionId: number): void {
    const ids = this.load();
    const at = ids.indexOf(missionId);
    if (at < 0) return;
    ids.splice(at, 1);
    this.save(ids);
  }

  private load(): number[] {
    if (this.ids) return this.ids;
    this.ids = [];
    if (!this.path) return this.ids;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const raw =
        data && typeof data === "object" && Array.isArray((data as { ids?: unknown }).ids)
          ? (data as { ids: unknown[] }).ids
          : [];
      this.ids = raw.filter(isMissionId).slice(-Math.max(1, this.capacity));
    } catch {
      // Missing or unreadable: nothing was discarded that this can know of.
    }
    return this.ids;
  }

  private save(ids: number[]): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ ids }), { mode: 0o600 });
      renameSync(temp, this.path);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `${LOG} ${this.path} not saved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function isMissionId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
