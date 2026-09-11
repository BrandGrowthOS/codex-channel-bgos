// Shared HOAI contract implementation from bgos-claude-plugin, Apache-2.0, commit 3ecbb58679febcc243f671e05788b521b065546e.
/**
 * Pure, side-effect-free body-builder for the `call_owner` MCP tool.
 *
 * Like ./lib/message-text.ts, everything here is deterministic and import-safe
 * (no env reads, no network, no process exit), so it can be unit/eval tested
 * directly. server.ts imports `buildCallOwnerBody` for the CallTool handler; the
 * eval suite (test/call-owner.test.ts) imports it too.
 *
 * The backend contract for POST /api/v1/voice/outbound-call is:
 *   { assistantId: number, chatId?: number, reason?: string }
 * This helper shapes exactly that body: it always carries assistantId, includes
 * chatId only when it is a finite number, and normalizes the ring reason to the
 * ring-screen rule (Kc, 2026-09-03): one or two plain sentences, at most 140
 * characters, no markdown or line breaks, cut at a word boundary, never an
 * added ellipsis. A reason that is empty after normalization is dropped rather
 * than sent as "". The backend applies the same rule on its side
 * (BGOS backend/src/voice/call-reason.ts) and still accepts up to 200
 * characters, so this pre-cap can never cause a 400; it exists so the wire
 * body already matches what the phone shows.
 */

/** Character cap for the human-readable ring reason, cut at a word boundary. */
export const CALL_OWNER_REASON_MAX = 140

/** Sentences kept, split on . ! ? followed by whitespace. */
export const CALL_OWNER_REASON_MAX_SENTENCES = 2

/**
 * Leading markers a markdown line can carry: list bullets (-, *, +), ordered
 * markers (1. / 1)), heading hashes, blockquote chevrons. Stripped per line.
 */
const LEADING_MARKERS = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*)+/

/** A sentence end candidate: . ! ? immediately followed by whitespace. */
const SENTENCE_END = /[.!?](?=\s)/g

/**
 * Words whose trailing period is an abbreviation, not a sentence end
 * (lowercased, no period). Single-letter words are handled by length, which
 * covers initials ("J. K."), "e.g.", "i.e.", "a.m.", "p.m." and "U.S.".
 * Kept short on purpose: a missed abbreviation costs one early cut, a listed
 * word that really ended a sentence only keeps one more sentence, and the
 * character cap bounds both. Mirrors BGOS backend/src/voice/call-reason.ts.
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'no',
  'vs',
  'approx',
  'dept',
  'est',
  'fig',
  'ref',
  'vol',
])

/** The run of Latin letters right before a period, if any. */
const WORD_BEFORE = /[A-Za-z\u00C0-\u024F]+$/

/**
 * A "." followed by whitespace ends a sentence unless the word before it is a
 * known abbreviation or a single letter. "!" and "?" always end one.
 */
function endsSentence(text: string, index: number): boolean {
  if (text[index] !== '.') return true
  const word = WORD_BEFORE.exec(text.slice(0, index))?.[0]
  if (!word) return true
  if (word.length === 1) return false
  return !ABBREVIATIONS.has(word.toLowerCase())
}

/**
 * Collapse a free-form reason into at most two plain sentences of at most
 * 140 characters. Returns null when nothing readable is left (empty input,
 * whitespace only, markup only) or when the input is not a string at all.
 * Pure: no I/O, no clock.
 */
export function normalizeCallOwnerReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null

  const lines = raw.split(/\r?\n/).map((line) => line.replace(LEADING_MARKERS, ''))

  let text = lines
    .join(' ')
    // Code ticks and emphasis runs: `code`, **bold**, *em*, ~~strike~~.
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/~~/g, '')
    // Underscore emphasis only at word edges, so snake_case survives.
    .replace(/(^|[\s(])_+/g, '$1')
    .replace(/_+(?=[\s).,!?:;]|$)/g, '')
    // Whitespace and newlines collapse to single spaces.
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return null

  // Keep the first CALL_OWNER_REASON_MAX_SENTENCES sentences.
  SENTENCE_END.lastIndex = 0
  let boundaries = 0
  let match: RegExpExecArray | null
  while ((match = SENTENCE_END.exec(text)) !== null) {
    if (!endsSentence(text, match.index)) continue
    boundaries += 1
    if (boundaries === CALL_OWNER_REASON_MAX_SENTENCES) {
      text = text.slice(0, match.index + 1)
      break
    }
  }

  // Cap at CALL_OWNER_REASON_MAX, cutting at a word boundary: no trailing
  // partial word and no added ellipsis. A single unbroken token longer than
  // the cap is hard-cut, the only case with no boundary to fall back to; that
  // cut never lands between the two halves of a surrogate pair (an emoji), so
  // the wire text is always valid UTF-16 and never renders a U+FFFD tail.
  if (text.length > CALL_OWNER_REASON_MAX) {
    const head = text.slice(0, CALL_OWNER_REASON_MAX + 1)
    const cut = head.lastIndexOf(' ')
    if (cut > 0) {
      text = head.slice(0, cut).trimEnd()
    } else {
      let end = CALL_OWNER_REASON_MAX
      const last = text.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end -= 1
      text = text.slice(0, end).trimEnd()
    }
  }

  return text || null
}

export interface CallOwnerBodyInput {
  /** This assistant's numeric id (always sent). */
  assistantId: number
  /** Chat to bind the call to. Omitted from the body when undefined/null/NaN. */
  chatId?: number | null
  /** Short reason shown on the ring; normalized by normalizeCallOwnerReason. */
  context?: string | null
  openingMessage?: string | null
  reason?: string | null
}

export interface CallOwnerBody {
  assistantId: number
  chatId?: number
  context?: string
  openingMessage?: string
  reason?: string
}

/**
 * Build the POST body for the outbound-call endpoint. Pure: no I/O, no clock.
 *
 * - `assistantId` is always included (required by the backend).
 * - `chatId` is included only when it is a finite number.
 * - `reason` is normalized (two sentences, 140 chars at a word boundary, no
 *   markdown or line breaks); a reason that is empty afterwards is omitted
 *   rather than sent as "".
 */
export function buildCallOwnerBody({
  assistantId,
  chatId,
  reason,
  context,
  openingMessage,
}: CallOwnerBodyInput): CallOwnerBody {
  const body: CallOwnerBody = { assistantId }

  if (typeof chatId === 'number' && Number.isFinite(chatId)) {
    body.chatId = chatId
  }

  const normalized = normalizeCallOwnerReason(reason)
  if (normalized) body.reason = normalized

  for (const [key, value, limit] of [['context', context, 4000], ['openingMessage', openingMessage, 400]] as const) {
    if (value == null) continue
    if (typeof value !== 'string' || [...value].length > limit) throw new Error(`${key} must be a string of at most ${limit} characters`)
    if (value.trim()) body[key] = value.trim()
  }
  return body
}
