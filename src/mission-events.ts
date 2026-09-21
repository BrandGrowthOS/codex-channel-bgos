/**
 * Mission events on the wire (mission program stage 5).
 *
 * Pure and import safe: no I/O, no clock, no env read. The socket handler in
 * bgos-ws.ts stays two lines and everything that can be reasoned about lives
 * here, the same split voice-rpc.ts and skills-handler.ts already use.
 *
 * The envelope the gateway builds is snake_case and the mission snapshot
 * inside it is camelCase, so every envelope field is read in both shapes, the
 * way normalizeInbound already does. Two rules matter more than the rest:
 *
 *  1. An UNKNOWN `status` is accepted. The backend can add a mission status
 *     before this daemon knows the word, and a hard reject would silence the
 *     whole family rather than one field.
 *  2. The gateway builds ONE event object and emits it to an ARRAY of rooms.
 *     A daemon sits in both `pairing:<id>` and `assistant:<id>`, so the copy
 *     that arrives through either room carries the identical `timestamp`.
 *     That is what makes missionEventKey an exact dedupe key.
 */
import type { MissionSnapshot, MissionOrigin, MissionStatus } from "./bgos-api.js";

export const MISSION_EVENT_TYPES = [
  "mission_created",
  "mission_ticked",
  "mission_completed",
  "mission_abandoned",
  "mission_paused",
  "mission_resumed",
  "mission_failed",
  "mission_updated",
] as const;

export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

/** Who closed the mission. Absent on a backend older than stage 5. */
export type MissionClearedBy = "owner" | "agent";

/** Why it closed. Absent on a backend older than stage 5. */
export type MissionClearReason =
  | "set_aside"
  | "marked_done"
  | "replaced"
  | "failed";

export interface MissionEventFrame {
  eventType: MissionEventType;
  userId: string;
  assistantId: number;
  /** The mission's chat. Present only once the backend ships per chat scope. */
  chatId?: number;
  mission: MissionSnapshot;
  /** mission_ticked only. */
  tickedGoalId?: number;
  clearedBy?: MissionClearedBy;
  clearReason?: MissionClearReason;
  /** The envelope's own stamp, empty when the backend sent none. */
  timestamp: string;
}

const CLEARED_BY: readonly string[] = ["owner", "agent"];
const CLEAR_REASONS: readonly string[] = [
  "set_aside",
  "marked_done",
  "replaced",
  "failed",
];

function isMissionEventType(type: string): type is MissionEventType {
  return (MISSION_EVENT_TYPES as readonly string[]).includes(type);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A positive integer, from a number or a digit string. 0 means "not one". */
function positiveInt(v: unknown): number {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function normalizeMiniGoals(v: unknown): MissionSnapshot["miniGoals"] {
  if (!Array.isArray(v)) return undefined;
  const goals: NonNullable<MissionSnapshot["miniGoals"]> = [];
  for (const raw of v) {
    if (!isPlainObject(raw)) continue;
    goals.push({
      id: positiveInt(raw.id),
      name: typeof raw.name === "string" ? raw.name : "",
      doneWhen:
        typeof (raw.doneWhen ?? raw.done_when) === "string"
          ? String(raw.doneWhen ?? raw.done_when)
          : "",
      done: (raw.done ?? false) === true,
      doneAt: optionalString(raw.doneAt ?? raw.done_at) ?? null,
      evidence: optionalString(raw.evidence) ?? null,
    });
  }
  return goals;
}

function normalizeMission(raw: unknown): MissionSnapshot | null {
  if (!isPlainObject(raw)) return null;
  const id = positiveInt(raw.id);
  if (!id) return null;
  const chatIdRaw = raw.chatId ?? raw.chat_id;
  const chatId = positiveInt(chatIdRaw);
  const progress = isPlainObject(raw.progress)
    ? {
        current: Number(raw.progress.current ?? 0),
        total: Number(raw.progress.total ?? 0),
        ...(typeof raw.progress.label === "string"
          ? { label: raw.progress.label }
          : {}),
      }
    : null;
  const createdByAssistant = raw.createdByAssistant ?? raw.created_by_assistant;
  const pausedReason = raw.pausedReason ?? raw.paused_reason;
  const doneWhen = raw.doneWhen ?? raw.done_when;
  const updatedAt = raw.updatedAt ?? raw.updated_at;
  const miniGoals = normalizeMiniGoals(raw.miniGoals ?? raw.mini_goals);
  return {
    id,
    assistantId: positiveInt(raw.assistantId ?? raw.assistant_id),
    title: typeof raw.title === "string" ? raw.title : "",
    // Cast, not validate: an unknown status from a newer backend must reach
    // the lane intact rather than take the family down with it.
    status: String(raw.status ?? "") as MissionStatus,
    origin: String(raw.origin ?? "") as MissionOrigin,
    progress,
    ...(chatIdRaw === undefined || chatIdRaw === null
      ? {}
      : { chatId: chatId || null }),
    ...(doneWhen === undefined ? {} : { doneWhen: optionalString(doneWhen) ?? null }),
    ...(pausedReason === undefined
      ? {}
      : { pausedReason: optionalString(pausedReason) ?? null }),
    ...(typeof createdByAssistant === "boolean" ? { createdByAssistant } : {}),
    ...(miniGoals === undefined ? {} : { miniGoals }),
    ...(typeof updatedAt === "string" ? { updatedAt } : {}),
  };
}

/**
 * Turn one raw socket payload into a frame, or null when it is not one.
 * Never throws: a malformed frame is dropped, never dispatched.
 */
export function normalizeMissionEvent(
  type: string,
  raw: unknown,
): MissionEventFrame | null {
  try {
    if (!isMissionEventType(type)) return null;
    if (!isPlainObject(raw)) return null;
    const assistantId = positiveInt(raw.assistantId ?? raw.assistant_id);
    if (!assistantId) return null;
    const mission = normalizeMission(raw.mission);
    if (!mission) return null;
    const chatId =
      positiveInt(raw.chatId ?? raw.chat_id) || positiveInt(mission.chatId);
    const tickedGoalId = positiveInt(raw.tickedGoalId ?? raw.ticked_goal_id);
    const clearedBy = String(raw.clearedBy ?? raw.cleared_by ?? "");
    const clearReason = String(raw.clearReason ?? raw.clear_reason ?? "");
    return {
      eventType: type,
      userId: String(raw.userId ?? raw.user_id ?? ""),
      assistantId,
      ...(chatId ? { chatId } : {}),
      mission,
      ...(tickedGoalId ? { tickedGoalId } : {}),
      ...(CLEARED_BY.includes(clearedBy)
        ? { clearedBy: clearedBy as MissionClearedBy }
        : {}),
      ...(CLEAR_REASONS.includes(clearReason)
        ? { clearReason: clearReason as MissionClearReason }
        : {}),
      timestamp: optionalString(raw.timestamp) ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * The dedupe key for one logical event. Identical across every room copy
 * because the gateway stamps the envelope once; `mission.updatedAt` is the
 * fallback for a backend that sends no envelope timestamp.
 */
export function missionEventKey(frame: MissionEventFrame): string {
  const stamp = frame.timestamp || frame.mission.updatedAt || "";
  return `${frame.eventType}|${frame.mission.id}|${stamp}`;
}
