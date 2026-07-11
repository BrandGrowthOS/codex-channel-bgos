/**
 * Bounded FIFO cache of processed message IDs. Used to dedup inbound_message
 * events that may arrive twice via independent paths:
 *
 *   - Live WS push receives msg N
 *   - WS reconnect / poll triggerBackfill() refetches inbound since the disk
 *     cursor, re-emitting msg N if the cursor lagged behind the live emit
 *   - Two integration sockets briefly subscribed to assistant:<id> during a
 *     disconnect/reconnect race, both delivering the same payload
 *   - Backend transport-level retry
 *
 * Without dedup, the daemon dispatches each duplicate to Codex and posts the
 * reply again. Ported from codex-channel-bgos/src/processed-ids.ts (originally
 * openclaw-channel-bgos; observed in prod 2026-05-10: chat 917 had four
 * assistant replies for two user questions, including identical-text pairs 1.3s
 * apart). The Set is bounded by `capacity` (FIFO eviction by insertion order) so
 * memory does not grow unbounded for long-running daemons.
 */
export class ProcessedIdsCache {
  private readonly seen: Set<number>;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    this.seen = new Set<number>();
  }

  /**
   * Returns true if this is the FIRST time we have seen this id (caller
   * should proceed to dispatch). Returns false if it is a duplicate (caller
   * should silently skip).
   *
   * Note: re-marking an already-cached id does NOT promote it. Eviction
   * order is strict insertion order, which is fine for our sliding-window
   * use case: we do not care about LRU semantics, only "did we see this
   * recently."
   */
  markIfFirstTime(messageId: number): boolean {
    if (this.seen.has(messageId)) {
      return false;
    }
    this.seen.add(messageId);
    if (this.seen.size > this.capacity) {
      // Set iteration is insertion order in JS: the first value is the
      // oldest entry. Drop it.
      const oldest = this.seen.values().next().value as number | undefined;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return true;
  }

  size(): number {
    return this.seen.size;
  }
}
