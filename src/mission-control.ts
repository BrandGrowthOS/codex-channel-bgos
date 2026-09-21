/**
 * MissionControlLane (mission program stage 5).
 *
 * The owner's Mark done, Set aside, Pause and Resume reach the agent here.
 * One frame in, and at most two things out: the mission lane is told to stop
 * writing to a mission that is closed or paused, and the model is told in one
 * plain sentence on its next turn, with a steer for the two owner authored
 * STOP events so a turn already running does not keep chasing a dead mission.
 *
 * Deliberate narrowness:
 *  - mission_ticked is NEVER narrated. The owner cannot tick, so every tick is
 *    the agent's own and it already has the tool result.
 *  - mission_updated is not narrated in this stage: an edit changes the card
 *    the model re reads on its next mission call.
 *  - mission_failed is always the agent's own write, so it only makes the lane
 *    forget the mission.
 *  - a mission_abandoned whose clear reason is `replaced` is never narrated:
 *    the mission_created that follows carries the whole news, which is that a
 *    new mission replaced the open one.
 *  - only mission_completed and mission_abandoned steer. Yanking a model mid
 *    thought for news that can wait is an interruption nobody asked for.
 */
import type { Input } from "@openai/codex-sdk";

import {
  missionDoneText,
  missionPausedText,
  missionResumedText,
  missionSetAsideText,
  missionStartedText,
  prefixInput,
  renderBulletin,
  type MissionBulletin,
} from "./mission-bulletin.js";
import type { MissionEventFrame } from "./mission-events.js";

/** A note older than this is stale news: the standing state arrives anyway. */
export const MISSION_NOTE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A daemon offline for an hour must not paste twelve notes into one turn. */
export const MISSION_NOTES_PER_CHAT = 4;
const SELF_WRITE_MAX = 200;
/**
 * How long a self write stamp may answer for a frame.
 *
 * A stamp is set just before the write goes out and the frame that write
 * emits arrives within seconds, so anything older is an orphan: a write that
 * emitted no frame this stamp was waiting for. Left forever, that orphan
 * would be eaten by the OWNER's next decision on the same mission and the
 * model would never be told its mission ended, which is the opposite of what
 * this lane is for.
 */
export const SELF_WRITE_TTL_MS = 30_000;
/** The frames a self write stamp is allowed to answer for. */
const CONSUMES_SELF_WRITE: readonly string[] = [
  "mission_created",
  "mission_paused",
  "mission_resumed",
  "mission_completed",
  "mission_abandoned",
  "mission_failed",
];

export interface MissionControlDeps {
  /** Only `steer` is used, and only for the two owner authored STOP events. */
  host: { steer(chatId: number, text: string): Promise<void> };
  /** The derived plan lane, told to stand down on a mission it may be writing. */
  missionLane: {
    notePaused(missionId: number): void;
    noteResumed(missionId: number): void;
    noteClosed(missionId: number): void;
  };
  /** Every chat of this assistant this process has actually served. */
  chatsForAssistant(assistantId: number): number[];
  /** Does this daemon own the assistant, with the cold scope exception. */
  isOwned(assistantId: number): boolean;
  now?: () => number;
  log?: (message: string) => void;
}

export class MissionControlLane {
  private readonly deps: MissionControlDeps;
  private readonly now: () => number;
  private readonly queues = new Map<number, MissionBulletin[]>();
  /**
   * Mission ids this daemon wrote itself, with the moment each was stamped.
   * One stamp is consumed per frame and a stamp older than SELF_WRITE_TTL_MS
   * answers for nothing. It only matters against a backend older than stage
   * 5, which sends no `cleared_by`: without the stamp, the daemon's own turn
   * end completion would come back and be read as the owner marking the
   * mission done.
   */
  private readonly selfWrites = new Map<number, number>();

  constructor(deps: MissionControlDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Remember that the daemon itself just wrote this mission. */
  noteSelfWrite(missionId: number): void {
    if (!Number.isSafeInteger(missionId) || missionId <= 0) return;
    this.sweepSelfWrites();
    this.selfWrites.set(missionId, this.now());
    if (this.selfWrites.size > SELF_WRITE_MAX) {
      this.selfWrites.delete(this.selfWrites.keys().next().value!);
    }
  }

  /**
   * That write landed and closed nothing, so its stamp has nothing left to
   * answer for. A tick of a goal that is not the last one is the everyday
   * case: no completion follows it, and the stamp would otherwise sit there
   * until it expired and eat the owner's next Set aside.
   */
  dropSelfWrite(missionId: number): void {
    this.selfWrites.delete(missionId);
  }

  /** Consume one mission frame. Never throws. */
  async handle(frame: MissionEventFrame): Promise<void> {
    try {
      if (!this.deps.isOwned(frame.assistantId)) return;
      const missionId = frame.mission.id;
      const selfWritten = this.consumeSelfWrite(missionId, frame);

      switch (frame.eventType) {
        case "mission_paused":
          this.deps.missionLane.notePaused(missionId);
          if (this.ownerAuthored(frame, selfWritten)) {
            this.queue(frame, missionPausedText({
              title: frame.mission.title,
              reason: frame.mission.pausedReason ?? null,
            }));
          }
          return;
        case "mission_resumed":
          this.deps.missionLane.noteResumed(missionId);
          if (this.ownerAuthored(frame, selfWritten)) {
            this.queue(frame, missionResumedText({ title: frame.mission.title }));
          }
          return;
        case "mission_completed":
          this.deps.missionLane.noteClosed(missionId);
          if (!this.ownerAuthored(frame, selfWritten)) return;
          await this.tellAndSteer(frame, missionDoneText({ title: frame.mission.title }));
          return;
        case "mission_abandoned":
          this.deps.missionLane.noteClosed(missionId);
          // A replace is not a Set aside. The mission_created that follows it
          // already tells the model a new mission replaced the open one, so
          // saying "it no longer exists, wait for a new instruction" here
          // would stop an agent the owner just handed fresh work to.
          if (frame.clearReason === "replaced") return;
          if (!this.ownerAuthored(frame, selfWritten)) return;
          await this.tellAndSteer(frame, missionSetAsideText({ title: frame.mission.title }));
          return;
        case "mission_failed":
          // Always the agent's own write. Forget it and say nothing.
          this.deps.missionLane.noteClosed(missionId);
          return;
        case "mission_created":
          if (frame.mission.createdByAssistant === true) return;
          if (selfWritten) return;
          this.queue(frame, missionStartedText({
            title: frame.mission.title,
            doneWhen: frame.mission.doneWhen ?? null,
          }));
          return;
        case "mission_ticked":
        case "mission_updated":
        default:
          return;
      }
    } catch (err) {
      this.deps.log?.(
        `mission event ${frame.eventType} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Prefix this chat's queued notes onto the turn input.
   *
   * Called in executeAndReply AFTER missionLane.beginTurn, never at compose
   * time: beginTurn's prompt feeds titleFromPrompt, which takes the first
   * line, and a note baked into the composed input would also replay on every
   * /retry. Returns the input UNCHANGED BY IDENTITY when nothing is queued.
   */
  applyBulletin(chatId: number, input: Input): Input {
    const block = this.drain(chatId);
    if (block.length === 0) return input;
    return prefixInput(input, block);
  }

  /** Forget every queued note. */
  dispose(): void {
    this.queues.clear();
    this.selfWrites.clear();
  }

  private ownerAuthored(frame: MissionEventFrame, selfWritten: boolean): boolean {
    if (frame.clearedBy === "owner") return true;
    if (frame.clearedBy === "agent") return false;
    // An older backend sends no cleared_by. A frame whose mission this daemon
    // just wrote is ours; anything else errs toward telling the model once too
    // often rather than never.
    return !selfWritten;
  }

  private consumeSelfWrite(missionId: number, frame: MissionEventFrame): boolean {
    if (frame.clearedBy !== undefined) return false;
    // Only a frame that could be narrated may consume the stamp. The stamp is
    // set BEFORE the write goes out, so a tick or an edit can land in between,
    // and letting one of those eat it would leave the frame it was set for
    // looking like the owner's own doing.
    if (!CONSUMES_SELF_WRITE.includes(frame.eventType)) return false;
    const stampedAt = this.selfWrites.get(missionId);
    if (stampedAt === undefined) return false;
    this.selfWrites.delete(missionId);
    // An orphan that outlived its own write answers for nothing: this frame
    // is the owner's, and the model is told.
    return this.now() - stampedAt <= SELF_WRITE_TTL_MS;
  }

  /** Forget stamps too old to answer for any frame still in flight. */
  private sweepSelfWrites(): void {
    const cutoff = this.now() - SELF_WRITE_TTL_MS;
    for (const [id, at] of this.selfWrites) {
      if (at < cutoff) this.selfWrites.delete(id);
    }
  }

  private async tellAndSteer(frame: MissionEventFrame, text: string): Promise<void> {
    const chats = this.queue(frame, text);
    for (const chatId of chats) {
      try {
        await this.deps.host.steer(chatId, text);
        this.forget(chatId, text);
      } catch {
        // No live turn to correct. The queued note covers the next one.
      }
    }
  }

  /** Queue one note for every chat this frame reaches. Returns those chats. */
  private queue(frame: MissionEventFrame, text: string): number[] {
    const chats = this.chatsFor(frame);
    const at = this.now();
    for (const chatId of chats) {
      const notes = this.queues.get(chatId) ?? [];
      notes.push({ at, text });
      while (notes.length > MISSION_NOTES_PER_CHAT) notes.shift();
      this.queues.set(chatId, notes);
    }
    return chats;
  }

  private forget(chatId: number, text: string): void {
    const notes = this.queues.get(chatId);
    if (!notes) return;
    const index = notes.findIndex((note) => note.text === text);
    if (index >= 0) notes.splice(index, 1);
    if (notes.length === 0) this.queues.delete(chatId);
  }

  /**
   * The chats one frame reaches: its own chat once the backend ships per chat
   * scope, otherwise every chat of that assistant this process has served.
   * A daemon that has served none invents no chat.
   */
  private chatsFor(frame: MissionEventFrame): number[] {
    if (frame.chatId) return [frame.chatId];
    return this.deps
      .chatsForAssistant(frame.assistantId)
      .filter((chatId) => Number.isSafeInteger(chatId) && chatId > 0);
  }

  private drain(chatId: number): string {
    const notes = this.queues.get(chatId);
    if (!notes || notes.length === 0) return "";
    this.queues.delete(chatId);
    const cutoff = this.now() - MISSION_NOTE_MAX_AGE_MS;
    const fresh = notes.filter((note) => note.at >= cutoff);
    return renderBulletin(fresh);
  }
}
