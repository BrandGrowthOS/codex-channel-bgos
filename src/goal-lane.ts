/**
 * GoalLane (mission program stage 6).
 *
 * The owner's "Keep working until it is done", carried out by the runtime's
 * own goal loop rather than by anything this daemon invents. One goal per
 * chat, one mission behind it, and a small set of facts reported back.
 *
 * Four rules bind every line here.
 *
 *  1. ARM BEFORE SET. `thread/goal/set` starts a turn at once: the gate
 *     watched the set return and a `turn/started` arrive eleven milliseconds
 *     later with nobody having asked for a turn. So the lane attaches the
 *     mission and takes the chat BEFORE it asks the host to set the goal.
 *     Set first and the whole of the goal's own first turn arrives for a chat
 *     nothing is watching, and the host drops it.
 *  2. ONLY WHAT THE RUNTIME COUNTED. The protocol has no turn counter at all,
 *     so this daemon counts the continuation turns it adopted and says so;
 *     elapsed working time is the runtime's own `timeUsedSeconds` and nothing
 *     here ever subtracts two timestamps to make one. A count nobody counted
 *     is not sent, and no count means no line on the card.
 *  3. NO CHECKER ON THIS CHANNEL. Codex has no separate judge and never will,
 *     so this lane never writes a `checked` feed entry, never sends a verdict
 *     block, and never lets a card say a goal was verified. Its Done reads as
 *     the agent's own word, which is the truth.
 *  4. A STOP IS NOT A FAILURE. At the owner's turn cap, and when the runtime
 *     reports its own three turns with the same obstacle, the lane reports a
 *     stop and leaves the mission OPEN. The owner then has something to
 *     decide, which is Needs you. A fail would read as Did not finish and
 *     close a mission nobody gave up on.
 *  5. THE GOAL OUTLIVES THIS LANE. A native goal lives in the runtime's own
 *     store and survives a daemon restart; these two maps do not. So every
 *     frame driven control takes the mission's frame as well as its id and
 *     acts on the chat it names when the lane is watching nothing, and it
 *     asks the host whether that chat has a thread first, because a goal
 *     lives ON a thread and a goal call would otherwise create one.
 */
import type {
  BgosApi,
  MissionRunReportInput,
  PatchMissionProgressInput,
} from "./bgos-api.js";
import type { ThreadGoal, ThreadGoalStatus } from "./goal-protocol.js";
import { StopDiscards } from "./stop-discards.js";

const LOG = "[codex-channel-bgos]";

/**
 * The cap used when the owner started the goal from the chat rather than from
 * the Start form, which is the one door that carries no limit of its own. It
 * is the same twenty the app offers, so the two doors behave alike.
 */
export const GOAL_DEFAULT_TURN_CAP = 20;

/**
 * Two hundred characters, which is the backend's own limit on a mission's
 * Done when and the length a feed line can show. The objective and the worked
 * line are both clipped to it here rather than at the far end, so a long
 * condition is shortened once and the mission and the native goal carry the
 * same words.
 */
const TEXT_MAX = 200;

/** The host calls this lane needs. Functions only, so the lane stays testable. */
export interface GoalLaneHost {
  setGoal(
    chatId: number,
    objective: string | null,
    opts?: { status?: ThreadGoalStatus; tokenBudget?: number | null },
  ): Promise<ThreadGoal | null>;
  clearGoal(chatId: number): Promise<boolean>;
  /**
   * Does this chat have a thread at all. A goal lives on one, so a chat with
   * no thread holds no goal, and every goal call would CREATE the thread it
   * was only meant to act on. Asked before every frame driven fallback.
   */
  hasThread(chatId: number): boolean;
}

/**
 * The chats whose goal an owner Stop found NOT running (D36), kept where a
 * restart cannot reach them (review F1). The lane's own state ends with the
 * process and the runtime's goal does not, so without this a restart between
 * the Stop and the owner's next message let the mission_resumed echo take a
 * held goal back from its frame and start it. Keyed by chat, because every
 * control that ends the record (the owner's `/goal resume`, a new goal, a
 * clear) names the chat, and some of them name nothing else.
 */
export interface GoalKeptStore {
  has(chatId: number): boolean;
  add(chatId: number): void;
  delete(chatId: number): void;
}

export interface GoalLaneDeps {
  api: Pick<
    BgosApi,
    | "createMission"
    | "patchMissionProgress"
    | "completeMission"
    | "postMissionStopped"
  >;
  host: GoalLaneHost;
  /**
   * Called just BEFORE this lane closes a mission itself, the rule the plan
   * lane already follows: the gateway emits the frame from inside the request
   * that closes the mission, so a stamp taken afterwards loses the race and
   * the daemon's own completion is narrated back to the model as the owner
   * marking the mission done.
   */
  onSelfWrite?: (missionId: number) => void;
  /** Kept in memory only when absent, which is what the tests default to. */
  keptByStop?: GoalKeptStore;
  log?: (message: string) => void;
}

interface GoalState {
  assistantId: number;
  chatId: number;
  missionId: number;
  /** The condition, as the owner wrote it. Kept so a resume can restate it. */
  objective: string;
  /** The owner's limit on continuation turns. */
  turnCap: number;
  /** Continuation turns this daemon adopted for this goal. */
  turnsUsed: number;
  /** Elapsed goal time the RUNTIME counted, in seconds. Never derived. */
  timeUsedSeconds: number;
  /** One stop per arming, so a later turn cannot report the same stop twice. */
  stopped: boolean;
  /**
   * The owner held this goal themselves with `/goal pause`. Anything that
   * starts it again clears it. An owner Stop reads it (D36).
   */
  ownerHeld: boolean;
  /**
   * An owner Stop found this goal NOT running (P6 stage 3, D36): held at its
   * cap, stopped for lack of progress, or held by the owner. The mission
   * resume that follows the Stop then leaves it held, through both of its
   * doors (the mission lane's give back and the mission_resumed echo),
   * because a Resume continues what was stopped and never starts what had
   * already ended. Only the owner starting the goal again clears it: more
   * turns, or `/goal resume`. Mirrored to the kept store, so it outlives a
   * restart (review F1).
   */
  keptByStop: boolean;
}

/**
 * Who holds a goal. Only the owner's own `/goal pause` is remembered as the
 * owner holding the loop; the lane's holds (the mission's Pause, the cap,
 * an owner Stop) name themselves so they are never mistaken for it.
 */
export type GoalHold = "owner" | "mission" | "cap" | "stop";

export interface ArmGoalInput {
  assistantId: number;
  chatId: number;
  missionId: number;
  objective: string;
  turnCap: number | null;
}

export interface SetGoalFromChatInput {
  assistantId: number;
  chatId: number;
  objective: string;
}

export interface GoalUpdateInput {
  missionId: number;
  keepWorking?: boolean;
  turnCap?: number | null;
}

/**
 * What a mission frame knows about the goal behind it.
 *
 * This lane's state is in memory and a native goal is not: the goal lives in
 * the runtime's own store and outlives this daemon, so after a restart the
 * lane holds nothing while the goal is still there. Every frame carries the
 * chat, the condition and the cap, which is everything a control needs, so
 * the frame is passed in and used when the lane has no state of its own.
 */
export interface GoalFrameContext {
  assistantId: number;
  chatId: number;
  /** The owner's condition: their Done when, or the title when they wrote none. */
  objective: string;
  turnCap: number | null;
  /** The owner's own switch. A mission with it off is not a goal to act on. */
  keepWorking: boolean;
}

export class GoalLane {
  private readonly deps: GoalLaneDeps;
  private readonly byChat = new Map<number, GoalState>();
  private readonly chatByMission = new Map<number, number>();
  private readonly kept: GoalKeptStore;

  constructor(deps: GoalLaneDeps) {
    this.deps = deps;
    this.kept = deps.keptByStop ?? new StopDiscards(null);
  }

  /**
   * Is this chat's work a native goal this lane armed.
   *
   * Two things read it and both fail closed on a no: the plan lane stands
   * down only for a chat this answers yes for, and the host adopts a turn
   * nobody asked for only for a chat this answers yes for. A goal the owner
   * set in their own terminal is therefore left exactly as it is today,
   * which is honest: this daemon did not arm it and has no mission for it.
   */
  owns(chatId: number): boolean {
    return this.byChat.has(chatId);
  }

  /** The mission behind this chat's goal, or null. */
  missionFor(chatId: number): number | null {
    return this.byChat.get(chatId)?.missionId ?? null;
  }

  /**
   * The owner started a mission with Keep working on. The mission already
   * exists, so this arms and sets, in that order.
   */
  async armFromMission(input: ArmGoalInput): Promise<void> {
    const objective = clip(input.objective, TEXT_MAX);
    if (!objective) return;
    this.attach({
      assistantId: input.assistantId,
      chatId: input.chatId,
      missionId: input.missionId,
      objective,
      turnCap: capOrDefault(input.turnCap),
      turnsUsed: 0,
      timeUsedSeconds: 0,
      stopped: false,
      ownerHeld: false,
      keptByStop: false,
    });
    await this.setObjective(input.chatId, objective);
  }

  /**
   * The owner typed `/goal <condition>` in the chat. The mission is created
   * first, because a goal with no card behind it is work the owner cannot
   * see, and only then is the goal armed and set.
   */
  async setFromChat(input: SetGoalFromChatInput): Promise<number | null> {
    const objective = clip(input.objective, TEXT_MAX);
    if (!objective) return null;
    const created = await this.deps.api.createMission(input.assistantId, {
      title: objective,
      doneWhen: objective,
      chatId: input.chatId,
      origin: "derived",
      firstFeedText: "Working toward this until it holds",
      // The loop IS running from the moment the goal is set, with this cap.
      // A create that said neither left the owner's card drawing the Keep
      // working switch OFF, and naming no limit, for work already under way.
      keepWorking: true,
      turnCap: GOAL_DEFAULT_TURN_CAP,
    });
    const missionId = Number(created?.id);
    if (!Number.isInteger(missionId) || missionId <= 0) {
      throw new Error("The mission for this goal could not be created.");
    }
    this.attach({
      assistantId: input.assistantId,
      chatId: input.chatId,
      missionId,
      objective,
      turnCap: capOrDefault(created.turnCap ?? null),
      turnsUsed: 0,
      timeUsedSeconds: 0,
      stopped: false,
      ownerHeld: false,
      keptByStop: false,
    });
    await this.setObjective(input.chatId, objective);
    return missionId;
  }

  /** One continuation turn opened for this chat. */
  noteTurnStarted(chatId: number): void {
    const state = this.byChat.get(chatId);
    if (!state) return;
    state.turnsUsed += 1;
  }

  /**
   * One continuation turn finished. This is the only place a run report is
   * written, and the only place the turn cap can be reached, because a cap
   * counted in turns can only be true at the end of one.
   */
  async noteTurnFinished(
    chatId: number,
    result: { text?: string; error?: string | null },
  ): Promise<void> {
    const state = this.byChat.get(chatId);
    if (!state) return;
    const worked = result.error ? "" : clip(result.text ?? "", TEXT_MAX);
    const body: PatchMissionProgressInput = {
      runReport: this.runReport(state),
      ...(worked ? { feedEntry: { kind: "worked" as const, text: worked } } : {}),
    };
    await this.write(state, "progress", () =>
      this.deps.api.patchMissionProgress(state.assistantId, state.missionId, body),
    );
    if (state.turnsUsed < state.turnCap || state.stopped) return;
    // The cap PAUSES the goal rather than clearing it, so the objective
    // survives untouched and "Give it 10 more turns" has something to start
    // again. A clear here would mean the owner's condition had to be
    // remembered and retyped by someone.
    state.stopped = true;
    await this.holdGoal(state);
    await this.write(state, "stopped", () =>
      this.deps.api.postMissionStopped(state.assistantId, state.missionId, {
        kind: "turn_cap",
        text: `Paused at ${state.turnCap} turns. The goal is kept, so more turns start it again.`,
      }),
    );
  }

  /** One `thread/goal/updated` or `thread/goal/cleared`, resolved to a chat. */
  async handleGoalUpdate(
    chatId: number,
    goal: ThreadGoal | null,
  ): Promise<void> {
    const state = this.byChat.get(chatId);
    if (!state) return;
    if (goal === null) {
      // Forget it, and abandon NOTHING. A clear the owner started in the app
      // is already answered by the mission frame that caused it, and a clear
      // the agent started is not the owner deciding the mission is over.
      this.detach(state);
      return;
    }
    if (goal.timeUsedSeconds > state.timeUsedSeconds) {
      state.timeUsedSeconds = goal.timeUsedSeconds;
    }
    if (goal.objective) state.objective = goal.objective;
    if (goal.status === "complete") {
      this.deps.onSelfWrite?.(state.missionId);
      const assistantId = state.assistantId;
      const missionId = state.missionId;
      const runReport = this.runReport(state);
      this.detach(state);
      await this.write({ ...state }, "complete", () =>
        this.deps.api.completeMission(assistantId, missionId, { runReport }),
      );
      return;
    }
    if (goal.status === "blocked" && !state.stopped) {
      // The runtime's own rule: the same obstacle for three consecutive goal
      // turns. It is reported as a stop and NEVER as a failure, because the
      // owner has something to decide and a failed mission asks them nothing.
      state.stopped = true;
      await this.write(state, "stopped", () =>
        this.deps.api.postMissionStopped(state.assistantId, state.missionId, {
          kind: "no_progress",
          text: "Stopped after three turns in a row that hit the same obstacle.",
        }),
      );
      return;
    }
    // `usageLimited` is stage 5's usage source, which already turns the card
    // amber off the agent's own activity, so there is nothing new to say.
    // `budgetLimited` cannot happen at all: this daemon never sets a token
    // budget. Neither is a failure, so neither closes anything.
  }

  /**
   * The owner's Pause, which really does suspend the loop on this channel.
   *
   * The frame is the fallback for a goal this lane holds no state for, which
   * after a daemon restart is EVERY goal: the runtime kept it and this lane
   * did not, and a Pause that quietly returned would be this channel claiming
   * a control it was not using.
   */
  async notePaused(
    missionId: number,
    frame?: GoalFrameContext | null,
  ): Promise<void> {
    const chatId = this.chatForControl(missionId, frame);
    if (!chatId) return;
    try {
      await this.pauseForChat(chatId, "mission");
    } catch (err) {
      this.log(`goal pause failed chat=${chatId} err=${errorText(err)}`);
    }
  }

  /**
   * The owner's Resume. Setting the status back to active starts a turn.
   *
   * With no state of its own the lane takes the goal back from the frame
   * FIRST and starts it after, the arm before set rule: a resumed goal runs a
   * turn at once, and a turn on a chat this lane does not own is dropped, so
   * the owner would see a loop that burns turns and says nothing.
   */
  async noteResumed(
    missionId: number,
    frame?: GoalFrameContext | null,
  ): Promise<void> {
    const held = this.stateForMission(missionId);
    // An owner Stop found this goal already stood down (D36): the resume
    // that follows it, the mission lane's or its echo, continues the mission
    // and leaves the goal where it was. Starting it here would run the loop
    // past its own cap, or over the owner's /goal pause. With no state, a
    // restart came in between, and the record on disk says it (review F1):
    // the goal is left held in the runtime and not taken back.
    if (held ? held.keptByStop : frame != null && this.kept.has(frame.chatId)) {
      return;
    }
    const state = held ?? this.adoptFromFrame(missionId, frame);
    if (!state) return;
    if (!(await this.resumeGoal(state)) && !held) {
      // The runtime no longer holds that goal. Give the chat back rather than
      // keep a claim on it, which would stand the plan lane down for ever.
      this.detach(state);
    }
  }

  /**
   * Hold this chat's goal, whoever armed it.
   *
   * A frame driven pause swallows its own failure; these two do NOT, because
   * the owner typed `/goal pause` and is owed the reason. They also work on a
   * goal this lane never armed, which is the one the owner set in their own
   * terminal: the control is about the thread, not about the card.
   *
   * `by` says whose hold it is. The default is the owner's own `/goal pause`,
   * the one caller outside this lane, and it is remembered once the runtime
   * has taken it, so an owner Stop later knows the goal was not running
   * (D36). The lane's own holds name themselves.
   */
  async pauseForChat(
    chatId: number,
    by: GoalHold = "owner",
  ): Promise<ThreadGoal | null> {
    const goal = await this.deps.host.setGoal(chatId, null, { status: "paused" });
    const state = this.byChat.get(chatId);
    if (state && by === "owner") state.ownerHeld = true;
    return goal;
  }

  /**
   * An owner Stop holds this chat's goal (P6 stage 3, D35), and says whether
   * the goal was RUNNING when the Stop came (D36).
   *
   * Running means this lane armed it and nothing had stood it down: not the
   * turn cap, not the runtime's own no progress rule, not the owner's
   * `/goal pause`. A goal that was not running is marked here, BEFORE the
   * hold, so the resume that follows the Stop leaves it held (noteResumed).
   * The Stop's own hold is not the owner's, so a second Stop before the
   * resume still finds a running goal running. Throws when the host does,
   * as pauseForChat does.
   */
  async holdForStop(chatId: number): Promise<boolean> {
    const state = this.byChat.get(chatId);
    const running = state !== undefined && !state.stopped && !state.ownerHeld;
    if (state) this.keepThroughResume(state, !running);
    await this.pauseForChat(chatId, "stop");
    return running;
  }

  /** Start it again. Setting the status back to active starts a turn at once. */
  async resumeForChat(chatId: number): Promise<ThreadGoal | null> {
    const state = this.byChat.get(chatId);
    if (state) {
      // Whatever held it, it is running from here: the owner's own restart,
      // or a resume this lane was right to give.
      state.stopped = false;
      state.ownerHeld = false;
      state.keptByStop = false;
    }
    // By chat, with or without state: after a restart the owner's
    // `/goal resume` is the one door that knows nothing but the chat.
    this.kept.delete(chatId);
    return this.deps.host.setGoal(chatId, null, { status: "active" });
  }

  /**
   * The mission closed in the app (Mark done, Set aside, or a failure). The
   * native goal goes with it: leaving it armed would have the runtime keep
   * working toward a card that is gone.
   */
  async noteClosed(
    missionId: number,
    frame?: GoalFrameContext | null,
  ): Promise<void> {
    const state = this.stateForMission(missionId);
    if (state) this.detach(state);
    // The mission is over, and so is any Stop's record for its chat, even
    // when this process never held the goal (review F1).
    else if (frame) this.kept.delete(frame.chatId);
    const chatId = state ? state.chatId : this.chatForControl(missionId, frame);
    if (!chatId) return;
    await this.clearGoal(chatId);
  }

  /**
   * The owner answered a stop with "Give it 10 more turns", which arrives as
   * a mission_updated carrying Keep working and the raised cap. A cap that is
   * not higher than the one in hand changes nothing, because an edit that
   * touched something else must not silently restart a goal the owner paused.
   */
  async noteUpdated(
    input: GoalUpdateInput,
    frame?: GoalFrameContext | null,
  ): Promise<void> {
    if (input.keepWorking !== true) return;
    const held = this.stateForMission(input.missionId);
    if (!held) {
      // After a restart there is no cap in hand to compare against, so Keep
      // working IS the instruction: take the goal the runtime still holds and
      // start it again, with the cap the owner just named.
      const adopted = this.adoptFromFrame(input.missionId, frame);
      if (!adopted) return;
      if (!(await this.resumeGoal(adopted))) this.detach(adopted);
      return;
    }
    const cap = typeof input.turnCap === "number" ? input.turnCap : 0;
    if (!Number.isInteger(cap) || cap <= held.turnCap) return;
    held.turnCap = cap;
    held.stopped = false;
    await this.resumeGoal(held);
  }

  /**
   * `/goal clear`. True when there was one to clear.
   *
   * The mission is left exactly where it is: the owner stopped the loop, not
   * the work, and closing their card for them would be this daemon deciding
   * something nobody asked it to decide.
   */
  async clearForChat(chatId: number): Promise<boolean> {
    const state = this.byChat.get(chatId);
    if (state) this.detach(state);
    this.kept.delete(chatId);
    return this.deps.host.clearGoal(chatId);
  }

  /**
   * Forget every goal, and close NOTHING.
   *
   * Unlike the plan lane, this one does not fail its missions on shutdown: a
   * thread goal lives in the runtime's own store and keeps going without this
   * daemon, so the mission is still true when the daemon comes back. Failing
   * it here would tell the owner their agent gave up when it did not.
   */
  dispose(): void {
    this.byChat.clear();
    this.chatByMission.clear();
  }

  private attach(state: GoalState): void {
    const existing = this.byChat.get(state.chatId);
    if (existing) this.chatByMission.delete(existing.missionId);
    this.byChat.set(state.chatId, state);
    this.chatByMission.set(state.missionId, state.chatId);
    // A goal armed or taken back here starts as the one this lane holds now,
    // so an older Stop's record for the chat no longer describes it.
    this.kept.delete(state.chatId);
  }

  private detach(state: GoalState): void {
    if (this.byChat.get(state.chatId) === state) {
      this.byChat.delete(state.chatId);
      this.kept.delete(state.chatId);
    }
    this.chatByMission.delete(state.missionId);
  }

  /**
   * Whether the resume that follows an owner Stop leaves this goal held
   * (D36), in memory and on disk, so a restart in between reads the same
   * answer (review F1).
   */
  private keepThroughResume(state: GoalState, keep: boolean): void {
    state.keptByStop = keep;
    if (keep) this.kept.add(state.chatId);
    else this.kept.delete(state.chatId);
  }

  private stateForMission(missionId: number): GoalState | null {
    const chatId = this.chatByMission.get(missionId);
    if (chatId === undefined) return null;
    return this.byChat.get(chatId) ?? null;
  }

  /**
   * The chat a frame driven control acts on: the one this lane is watching,
   * or the one the frame names when it is watching nothing.
   *
   * Two things the fallback will not do. It will not act on a mission whose
   * Keep working the owner turned off, because that is not a goal. And it
   * will not touch a chat with no thread, because a goal lives ON a thread
   * and every goal call would otherwise create one.
   */
  private chatForControl(
    missionId: number,
    frame?: GoalFrameContext | null,
  ): number | null {
    const state = this.stateForMission(missionId);
    if (state) return state.chatId;
    if (!frame || frame.keepWorking !== true) return null;
    if (!Number.isSafeInteger(frame.chatId) || frame.chatId <= 0) return null;
    if (!this.deps.host.hasThread(frame.chatId)) return null;
    return frame.chatId;
  }

  /**
   * Take a goal the runtime still holds back into this lane, from the frame
   * alone. Attached BEFORE anything starts it, because a started goal runs a
   * turn at once and a turn on an unowned chat is dropped on the floor.
   */
  private adoptFromFrame(
    missionId: number,
    frame?: GoalFrameContext | null,
  ): GoalState | null {
    const chatId = this.chatForControl(missionId, frame);
    if (!chatId || !frame) return null;
    const objective = clip(frame.objective, TEXT_MAX);
    if (!objective) return null;
    const state: GoalState = {
      assistantId: frame.assistantId,
      chatId,
      missionId,
      objective,
      turnCap: capOrDefault(frame.turnCap),
      // The turns this daemon adopted are the only ones it can honestly
      // count, and it adopted none before it started. The runtime's own
      // elapsed time comes back on the next goal update.
      turnsUsed: 0,
      timeUsedSeconds: 0,
      stopped: false,
      ownerHeld: false,
      keptByStop: false,
    };
    this.attach(state);
    return state;
  }

  /**
   * What the runtime counted. `workingMs` is left out entirely until the
   * runtime has counted some, because a zero is a number nobody measured and
   * the card would print a working time of none.
   */
  private runReport(state: GoalState): MissionRunReportInput {
    return {
      turnsUsed: state.turnsUsed,
      turnCap: state.turnCap,
      ...(state.timeUsedSeconds > 0
        ? { workingMs: Math.round(state.timeUsedSeconds * 1000) }
        : {}),
    };
  }

  private async setObjective(chatId: number, objective: string): Promise<void> {
    try {
      await this.deps.host.setGoal(chatId, objective);
    } catch (err) {
      // The chat keeps its mission: the owner asked for this work and the
      // card is the honest record of it. Only the native loop is missing,
      // and the reason reaches the owner through the caller.
      this.log(`goal set failed chat=${chatId} err=${errorText(err)}`);
      throw err;
    }
  }

  /** The cap and the frame paths: a failure here is logged, never thrown. */
  private async holdGoal(state: GoalState): Promise<void> {
    try {
      await this.pauseForChat(state.chatId, "cap");
    } catch (err) {
      this.log(`goal pause failed chat=${state.chatId} err=${errorText(err)}`);
    }
  }

  /** True when the runtime took it. False is a goal it no longer holds. */
  private async resumeGoal(state: GoalState): Promise<boolean> {
    try {
      await this.resumeForChat(state.chatId);
      return true;
    } catch (err) {
      this.log(`goal resume failed chat=${state.chatId} err=${errorText(err)}`);
      return false;
    }
  }

  private async clearGoal(chatId: number): Promise<boolean> {
    try {
      return await this.deps.host.clearGoal(chatId);
    } catch (err) {
      this.log(`goal clear failed chat=${chatId} err=${errorText(err)}`);
      return false;
    }
  }

  /**
   * One write to the card. Every failure is a missing line and never a broken
   * turn, which is the rule every other lane here follows; a mission the
   * backend no longer has is forgotten rather than written to for ever.
   */
  private async write(
    state: GoalState,
    what: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (isNotFound(err)) {
        const live = this.stateForMission(state.missionId);
        if (live) this.detach(live);
      }
      this.log(
        `mission ${what} failed chat=${state.chatId} mission=${state.missionId} err=${errorText(err)}`,
      );
    }
  }

  private log(message: string): void {
    if (this.deps.log) {
      this.deps.log(message);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`${LOG} ${message}`);
  }
}

/** The runtime's own display word for a goal state. */
export function goalStatusWord(status: ThreadGoalStatus): string {
  switch (status) {
    case "blocked":
      return "stalled";
    case "usageLimited":
      return "usage limited";
    case "budgetLimited":
      return "limited by budget";
    default:
      // A state a newer runtime invents is printed as it arrived rather than
      // hidden: the owner reading an unfamiliar word is better served than
      // the owner reading nothing.
      return String(status);
  }
}

/** Elapsed goal time in words, or null when nothing has been counted. */
export function formatGoalSeconds(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function capOrDefault(cap: number | null | undefined): number {
  return typeof cap === "number" && Number.isInteger(cap) && cap > 0
    ? cap
    : GOAL_DEFAULT_TURN_CAP;
}

function clip(text: string, max: number): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 404
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
