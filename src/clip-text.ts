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
 * A length in characters (code points), the way the app (Array.from) and the
 * backend's validator count the Sessions limits. String.length counts UTF-16
 * units, so every emoji would count twice and a name both of them accept
 * would be refused here.
 */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/**
 * At most `max` characters (code points), for the Sessions rows the backend
 * reads in characters. Never splits a surrogate pair.
 */
export function clipCharacters(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}
