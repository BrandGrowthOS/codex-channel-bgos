/**
 * One clip for every field this plugin puts on the wire.
 *
 * A plain `slice(0, max)` counts UTF-16 code units, so a cut that lands
 * between the two halves of a surrogate pair (every emoji, every astral
 * character) leaves a LONE HIGH SURROGATE at the end of the string. Postgres
 * refuses a lone surrogate inside JSONB, so the row, the card or the whole
 * message is rejected by the backend rather than drawn short. The Claude
 * plugin already learned this in `lib/missions.ts`; this is the same guard,
 * in one place, for the Codex side.
 *
 * The helper only ever REMOVES that dangling half, so a clipped string is
 * never longer than `max` and never shorter than `max - 1`.
 */
export function clipText(raw: unknown, max: number): string {
  const text = typeof raw === "string" ? raw : "";
  if (max <= 0 || text.length <= max) return max <= 0 ? "" : text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Clip to `max` UTF-16 units with the ellipsis INSIDE the cap.
 *
 * Inside, twice over. The backend's DTO REFUSES a string past its length
 * rather than clipping it, so one unit over costs the owner the whole card;
 * and a silent prefix renders as a complete, shorter command, so an owner
 * could approve an action whose tail they never saw. `clipText` above carries
 * the surrogate guard, so the result is at most `max` units and never ends on
 * half a character (Postgres refuses a lone surrogate inside JSONB).
 *
 * It lives here rather than beside its callers because this file is the one
 * clip for every field this plugin puts on the wire, and because the name
 * `clipToCap` is already taken inside `tool-progress.ts` by a helper that
 * drops chat ROWS: two unrelated meanings under one name is how the wrong one
 * gets called.
 */
export function clipWithEllipsis(text: string, max: number): string {
  return text.length > max ? `${clipText(text, max - 1)}\u2026` : text;
}
