/**
 * The mission bulletin (mission program stage 5).
 *
 * Codex has no notification channel, so the only way to tell a running model
 * that the owner changed a mission is the turn input it already receives.
 * This module is the words and the folding; nothing here does I/O, reads a
 * clock or touches a socket, so every line of copy is unit testable.
 *
 * The wording is the approved wording. Keep it short and imperative, in the
 * register the rest of the agent hints use, and with no dash of any kind: the
 * served canon refuses one and this text ends up in a prompt beside it.
 */
import type { Input, UserInput } from "@openai/codex-sdk";

/** One queued note for one chat. */
export interface MissionBulletin {
  /** Epoch ms the note was queued, used for ordering and staleness. */
  at: number;
  text: string;
}

/** The whole folded block is clipped to this, oldest notes dropped first. */
export const MISSION_BULLETIN_MAX_CHARS = 1200;

const TITLE_MAX = 200;

/**
 * One line, whitespace collapsed, clipped. A mission title is owner written
 * and can be 200 characters of anything, so it is never interpolated raw: a
 * newline in it would otherwise let it forge a second bulletin line.
 */
function safeTitle(title: string | null | undefined): string {
  const plain = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
  return plain.length > 0 ? plain : "this mission";
}

function safeClause(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
}

export function missionDoneText(m: { title: string | null }): string {
  return (
    `HOAI mission update: the owner marked the mission "${safeTitle(m.title)}" as done. ` +
    "It is closed. Do not keep working on it, do not report progress on it, and do not " +
    "mention it as active. If you were mid way through it, say plainly what you had finished."
  );
}

export function missionSetAsideText(m: { title: string | null }): string {
  return (
    `HOAI mission update: the owner set the mission "${safeTitle(m.title)}" aside. ` +
    "It no longer exists. Drop it and wait for a new instruction."
  );
}

export function missionPausedText(m: {
  title: string | null;
  reason?: string | null;
}): string {
  const reason = safeClause(m.reason);
  const because = reason.length > 0 ? `, reason: ${reason}` : "";
  return (
    `HOAI mission update: the owner paused the mission "${safeTitle(m.title)}"${because}. ` +
    "Stop working on it until it is resumed. You may still answer questions in this chat."
  );
}

export function missionResumedText(m: { title: string | null }): string {
  return (
    `HOAI mission update: the owner resumed the mission "${safeTitle(m.title)}". ` +
    "You may continue it."
  );
}

export function missionStartedText(m: {
  title: string | null;
  doneWhen?: string | null;
}): string {
  const doneWhen = safeClause(m.doneWhen);
  const check = doneWhen.length > 0 ? ` Done when: ${doneWhen}.` : "";
  return (
    `HOAI mission update: the owner started the mission "${safeTitle(m.title)}".${check} ` +
    "Treat it as the standing goal for this chat."
  );
}

/**
 * Fold a chat's queued notes into ONE block, newest LAST so the model reads
 * them in the order they happened, and clipped by dropping the oldest first.
 */
export function renderBulletin(notes: readonly MissionBulletin[]): string {
  const ordered = [...notes].sort((a, b) => a.at - b.at);
  while (ordered.length > 1) {
    const size = ordered.reduce((n, note) => n + note.text.length + 1, -1);
    if (size <= MISSION_BULLETIN_MAX_CHARS) break;
    ordered.shift();
  }
  const block = ordered.map((note) => note.text).join("\n");
  return block.length > MISSION_BULLETIN_MAX_CHARS
    ? block.slice(0, MISSION_BULLETIN_MAX_CHARS)
    : block;
}

/**
 * Prepend a block to a Codex Input without breaking the image parts.
 *
 * A UserInput[] gets a NEW leading text part rather than an edit of the first
 * one, because an images only message has no text part at all (see
 * inbound-input.ts). Images are never reordered and the caller's array is
 * never mutated.
 */
export function prefixInput(input: Input, block: string): Input {
  if (block.trim().length === 0) return input;
  if (typeof input === "string") return `${block}\n\n${input}`;
  const head: UserInput = { type: "text", text: block };
  return [head, ...input];
}
