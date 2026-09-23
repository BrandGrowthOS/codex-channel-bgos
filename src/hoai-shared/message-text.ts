// Shared HOAI contract implementation from bgos-claude-plugin, Apache-2.0, commit 3ecbb58679febcc243f671e05788b521b065546e.
// Later additions carried across from the same file in that plugin, byte for
// byte, because the contract is one contract: REPLY_BUTTON_STYLES and
// normalizeButtonStyle (0.45.0, the reply button tier).
/**
 * Pure, side-effect-free message-text helpers for the BGOS Claude Code plugin.
 *
 * Everything in this module is deterministic and import-safe (no env reads, no
 * network, no process exit), so it can be unit/eval tested directly. server.ts
 * imports from here; the eval suite imports from here.
 *
 * The headline concern here is BACKSLASH / MARKDOWN round-tripping. The wire
 * (JSON over fetch, JSON-RPC over stdio) preserves backslashes perfectly. The
 * lossy step is markdown RENDERING on the BGOS frontend
 * (react-native-markdown-display, i.e. markdown-it in CommonMark mode): a
 * backslash that precedes an ASCII-punctuation character is consumed as an
 * escape, so an agent that writes `a\*b` or a Windows path or a regex in PROSE
 * loses the backslash on screen. `protectBackslashesForMarkdown` is the precise
 * inverse of that rule, applied ONLY outside code spans/fences (where markdown
 * already preserves backslashes verbatim).
 */

// ── File-type helpers ────────────────────────────────────────────────────────

// Outbound (agent to user) extension-to-MIME map. Mirrors the backend send
// path allowlist (BGOS backend src/common/file-validation.utils.ts, widened by
// backend PR #783 to archives, markdown, and common text formats). Discipline:
// every value is a CONCRETE type/subtype the backend allowlists, never a
// wildcard; archives are opaque blobs (the plugin never extracts them).
export const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.ogg': 'video/ogg', '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/m4a', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.json': 'application/json',
  '.yaml': 'application/yaml', '.yml': 'application/yaml',
  // Markdown
  '.md': 'text/markdown', '.markdown': 'text/markdown',
  // Archives (opaque blobs; stored and forwarded, never extracted)
  '.zip': 'application/zip', '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar',
  '.gz': 'application/gzip', '.tgz': 'application/gzip',
  // Structured / rich-text documents
  '.xml': 'application/xml', '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  // Plain-text code/config (inert text to BGOS)
  '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.toml': 'application/toml', '.log': 'text/plain',
}

// Full mirror of the backend's ALLOWED_MIMES.document list (all accepted
// spellings), so an agent that passes an explicit mime_type in any
// backend-accepted spelling is not rejected plugin-side.
export const DOC_MIMES = new Set([
  'application/pdf', 'text/plain', 'text/csv', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/json',
  'application/zip', 'application/x-zip-compressed',
  'application/vnd.rar', 'application/x-rar-compressed', 'application/x-rar',
  'application/x-7z-compressed', 'application/x-tar',
  'application/gzip', 'application/x-gzip',
  'text/yaml', 'application/x-yaml', 'application/yaml', 'text/x-yaml',
  'text/markdown', 'text/x-markdown',
  'application/xml', 'text/xml',
  'application/rtf', 'text/rtf',
  'application/epub+zip',
  'text/javascript', 'application/javascript',
  'text/typescript', 'application/typescript',
  'text/x-python', 'text/x-python-script',
  'text/html', 'text/css',
  'application/toml', 'text/toml',
])

/** Short human-readable summary of what an agent may attach outbound. */
export const ALLOWED_FILE_SUMMARY =
  'images (jpg, png, gif, webp, svg, bmp, tiff), ' +
  'video (mp4, webm, mov, avi, mkv, ogg, mpeg, 3gp), ' +
  'audio (mp3, wav, m4a, aac, flac), ' +
  'documents (pdf, txt, md, csv, doc, docx, xls, xlsx, ppt, pptx, rtf, epub, ' +
  'json, xml, yaml, toml, html, css, js, ts, py, log), ' +
  'and archives (zip, rar, 7z, tar, gz, tgz)'

/**
 * Honest rejection copy for an outbound attachment the plugin cannot send:
 * names the offending extension (or the bare file name when it has none), the
 * reported MIME when one was given, and the allowed set briefly.
 */
export function unsupportedFileMessage(
  fileName: string,
  mime?: string | null,
): string {
  const ext = extLower(fileName)
  const what = ext ? `"${ext}"` : `"${fileName}"`
  const mimePart = mime ? ` (reported type "${mime}")` : ''
  return (
    `File type ${what} is not supported${mimePart}. ` +
    `Allowed: ${ALLOWED_FILE_SUMMARY}.`
  )
}

/** Lowercased file extension including the leading dot, or '' when none. */
export function extLower(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

export function guessMimeType(filePath: string): string | null {
  return MIME_MAP[extLower(filePath)] ?? null
}

/**
 * Resolve the MIME for an outbound attachment: an explicit mime_type wins,
 * then the on-disk path's extension, then the display file_name's extension.
 * The file_name fallback matters for download-style temp paths (a real
 * "/tmp/download.tmp" carrying file_name "notes.md"): without it the plugin
 * would reject a supported type, and worse, name the SUPPORTED extension in
 * the rejection message.
 */
export function guessOutboundMime(
  filePath: string,
  fileName: string,
  explicitMime?: string | null,
): string | null {
  return explicitMime ?? guessMimeType(filePath) ?? guessMimeType(fileName)
}

export function getFileCategory(mime: string): string | null {
  const m = mime.trim().toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (DOC_MIMES.has(m)) return 'document'
  return null
}

// ── Button-value namespace isolation ─────────────────────────────────────────

export const AGENT_VALUE_PREFIX = 'u:'
export const RESERVED_VALUE_SENTINELS = new Set(['__skip__', '__custom__'])
export const RESERVED_VALUE_PREFIXES = ['perm:', 'sc:', 'ea:', 'u:']

export function escapeAgentButtonValue(value: string): string {
  return `${AGENT_VALUE_PREFIX}${value}`
}

export function unescapeAgentButtonValue(callbackData: string): string {
  return callbackData.startsWith(AGENT_VALUE_PREFIX)
    ? callbackData.slice(AGENT_VALUE_PREFIX.length)
    : callbackData
}

export function collidesWithReserved(value: string): boolean {
  if (RESERVED_VALUE_SENTINELS.has(value)) return true
  return RESERVED_VALUE_PREFIXES.some((p) => value.startsWith(p))
}

// ── Backslash / markdown protection ──────────────────────────────────────────

// ASCII punctuation that CommonMark treats as escapable. A backslash before any
// of these is consumed by the renderer (the punctuation char becomes literal and
// the backslash disappears). Mirrors the CommonMark spec list.
const CM_ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[]\\^_`{|}~'
const CM_ESCAPABLE_SET = new Set(CM_ESCAPABLE.split(''))

/**
 * Split text into alternating non-code and code segments. Code segments are
 * fenced blocks (``` ... ``` or ~~~ ... ~~~) and inline code spans (backtick
 * runs). Inside code, markdown preserves backslashes verbatim, so we must NOT
 * touch those segments. Returns segments in order with an `isCode` flag.
 *
 * This is a pragmatic tokenizer, not a full CommonMark parser: it recognises
 * fenced blocks first (line-anchored), then inline backtick spans, which covers
 * every way an agent realistically emits code in a chat reply.
 */
export function splitCodeSegments(
  text: string,
): Array<{ text: string; isCode: boolean }> {
  const out: Array<{ text: string; isCode: boolean }> = []
  // First, peel off fenced code blocks line-by-line so a stray backtick inside
  // prose can never swallow a real fence.
  const fenceRe = /^( {0,3})(`{3,}|~{3,})/
  const lines = text.split('\n')
  let i = 0
  let proseBuf: string[] = []
  const flushProse = () => {
    if (proseBuf.length) {
      // Re-run inline-code splitting on the accumulated prose.
      for (const seg of splitInlineCode(proseBuf.join('\n'))) out.push(seg)
      proseBuf = []
    }
  }
  while (i < lines.length) {
    const line = lines[i]!
    const m = fenceRe.exec(line)
    if (m) {
      flushProse()
      const fenceChar = m[2]![0]!
      const fenceLen = m[2]!.length
      const block: string[] = [line]
      i++
      const closeRe = new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`)
      while (i < lines.length) {
        block.push(lines[i]!)
        if (closeRe.test(lines[i]!)) { i++; break }
        i++
      }
      out.push({ text: block.join('\n'), isCode: true })
      continue
    }
    proseBuf.push(line)
    i++
  }
  flushProse()
  // Preserve trailing/leading newline structure: join semantics above keep
  // newlines because we split on '\n' and inline splitter rejoins prose whole.
  return out.length ? out : [{ text, isCode: false }]
}

/** Split a single prose line/run into alternating text and inline-code spans. */
function splitInlineCode(text: string): Array<{ text: string; isCode: boolean }> {
  const out: Array<{ text: string; isCode: boolean }> = []
  let i = 0
  let buf = ''
  while (i < text.length) {
    if (text[i] === '`') {
      // Measure the backtick run length; a matching run of the same length closes.
      let run = 0
      while (text[i + run] === '`') run++
      const open = '`'.repeat(run)
      const closeIdx = text.indexOf(open, i + run)
      if (closeIdx !== -1) {
        if (buf) { out.push({ text: buf, isCode: false }); buf = '' }
        out.push({ text: text.slice(i, closeIdx + run), isCode: true })
        i = closeIdx + run
        continue
      }
    }
    buf += text[i]
    i++
  }
  if (buf) out.push({ text: buf, isCode: false })
  return out.length ? out : [{ text, isCode: false }]
}

/**
 * Within a NON-code run, rewrite backslashes so each one the agent typed renders
 * as exactly one literal backslash under CommonMark, WITHOUT disturbing the
 * agent's intended markdown (a standalone `*`, `_`, `[` etc. is left alone).
 *
 * The invariant: every backslash the agent wrote must survive rendering. Cases:
 *   1. `\` + escapable punctuation (the agent wrote `\*`, `\_`, `\[`, or even a
 *      second `\`): the agent means a literal backslash AND a literal punctuation
 *      char. Emit `\\` (so one backslash survives) PLUS `\<punct>` (so the punct
 *      is escaped and stays literal instead of acting as markdown). Net: three
 *      backslashes then the punct; CommonMark renders it back to `\<punct>`.
 *   2. `\` + non-escapable char or end of run (e.g. `\d`, `\w`, `\U`, trailing
 *      `\`): CommonMark already keeps that backslash literally, but a bare doubled
 *      form is still correct and robust after segment rejoin, so emit `\\`.
 * Non-backslash characters are emitted verbatim, preserving intended markdown.
 */
function protectRun(run: string): string {
  let out = ''
  for (let i = 0; i < run.length; i++) {
    const ch = run[i]!
    if (ch === '\\') {
      const next = run[i + 1]
      if (next !== undefined && CM_ESCAPABLE_SET.has(next)) {
        // Preserve the backslash (\\) AND escape the following punctuation (\next).
        out += '\\\\\\' + next
        i++ // `next` is already emitted
        continue
      }
      // Lone backslash (before a non-escapable char or end): double it so it is
      // unambiguous and survives any later rejoin.
      out += '\\\\'
      continue
    }
    out += ch
  }
  return out
}

/**
 * Make backslashes in an agent's markdown reply render correctly on the BGOS
 * frontend (CommonMark) WITHOUT disturbing code spans/fences or intended
 * markdown structure. Idempotency note: this is NOT idempotent for the `\\` ->
 * `\\\\` case (each pass adds escaping); callers MUST apply it exactly once, at
 * send time, to raw agent text.
 */
export function protectBackslashesForMarkdown(text: string): string {
  if (!text.includes('\\')) return text
  return splitCodeSegments(text)
    .map((seg) => (seg.isCode ? seg.text : protectRun(seg.text)))
    .join('')
}

// ── Inbound content building ─────────────────────────────────────────────────

export interface InboundFileLike {
  isImage?: boolean | null
  isVideo?: boolean | null
  isAudio?: boolean | null
  fileName?: string | null
  fileData?: string | null
  filename?: string | null
  mime?: string | null
  url?: string | null
  dataUri?: string | null
}

/**
 * Build the channel-notification `content` string the agent sees for an inbound
 * user message: the (untouched) user text followed by one bracketed line per
 * attachment. User text is forwarded VERBATIM, backslashes, code fences, quotes
 * and newlines are preserved so the agent sees precisely what was typed. Returns
 * '' when there is nothing to forward.
 */
export function buildInboundContent(
  text: string,
  files: InboundFileLike[] = [],
  opts: { backlogPrefix?: string } = {},
): string {
  const parts: string[] = []
  if (opts.backlogPrefix) parts.push(opts.backlogPrefix)
  if (text.trim()) parts.push(text)
  for (const f of files) {
    let type: string
    let name: string
    let ref: string
    if (f.mime !== undefined || f.filename !== undefined || f.url !== undefined || f.dataUri !== undefined) {
      // WS payload shape: { filename, mime, url?, dataUri? }
      type = getFileCategory(String(f.mime ?? '')) ?? 'document'
      name = String(f.filename ?? 'file')
      ref = String(f.url ?? f.dataUri ?? '')
      if (!ref) continue
    } else {
      // Poll payload shape: { isImage/isVideo/isAudio, fileName, fileData }
      type = f.isImage ? 'image' : f.isVideo ? 'video' : f.isAudio ? 'audio' : 'document'
      name = String(f.fileName ?? 'file')
      ref = String(f.fileData ?? '')
    }
    parts.push(`[Attached ${type}: ${name} - ${ref}]`)
  }
  return parts.join('\n')
}

// ── Machine-event meta (capability #12) ──────────────────────────────────────

/** The raw event envelope shape as it arrives on a BGOS message (poll or WS). */
export interface RawEventMeta {
  source?: string | null
  title?: string | null
  peek?: string | null
  payload?: unknown
}

/** The flat meta fragment surfaced to the agent's channel notification.
 *
 * EVERY value here MUST be a string: the Claude Code harness silently drops
 * any notifications/claude/channel card whose meta carries a non-string value
 * (null, undefined, boolean, number, object). A raw `event_payload` object
 * killed every meeting-summary / rich-event card (e.g. msgs 23050/23080 to
 * Mark), the agent saw only the all-string reply-overdue nudge. Same bug
 * class as the consult-card fix (b735914) and the WS Block-A fix (#17). */
export interface EventMetaFragment {
  event_type: 'event'
  event_source: string
  event_title?: string
  event_peek?: string
  /** The event payload as a JSON string (or the raw string if it was one). */
  event_payload?: string
}

/**
 * Build the channel-notification meta fragment for a machine-delivered event
 * message (capability #12). Returns `null` when the message is NOT a machine
 * event (i.e. its `messageType` is not "event" AND it carries no `eventMeta`).
 *
 * The `text` body of an event is always canonical (forwarded verbatim by
 * `buildInboundContent`), so this fragment is pure enrichment: it lets a plugin
 * tag the inbound so the agent can tell "data delivered to me" (a dashboard
 * dispatch, reply-watcher push, sweep, voice transcript, n8n notification)
 * apart from "my user is speaking". Empty/whitespace-only string fields are
 * dropped; `source` defaults to "unknown" so the agent always knows it is a
 * machine event even when the sender omitted the source.
 */
export function buildEventMeta(
  messageType: string | null | undefined,
  eventMeta: RawEventMeta | null | undefined,
): EventMetaFragment | null {
  const isEvent = messageType === 'event' || (eventMeta != null && typeof eventMeta === 'object')
  if (!isEvent) return null
  const src = (eventMeta?.source ?? '').toString().trim()
  const out: EventMetaFragment = {
    event_type: 'event',
    event_source: src || 'unknown',
  }
  const title = (eventMeta?.title ?? '').toString().trim()
  if (title) out.event_title = title
  const peek = (eventMeta?.peek ?? '').toString().trim()
  if (peek) out.event_peek = peek
  if (eventMeta?.payload !== undefined && eventMeta?.payload !== null) {
    // Serialize to a STRING: a raw object/boolean/number in meta makes the
    // harness drop the whole card (see EventMetaFragment doc). Strings pass
    // through verbatim; everything else becomes compact JSON the agent can
    // parse back.
    out.event_payload =
      typeof eventMeta.payload === 'string'
        ? eventMeta.payload
        : JSON.stringify(eventMeta.payload)
  }
  return out
}

// ── Reply button tiers ───────────────────────────────────────────────────────

/**
 * The four tiers the BGOS backend's `CreateMessageOptionDto` accepts, spelled
 * exactly as its `@IsIn` spells them
 * (backend/src/dto/create-chat-history.dto.ts).
 */
export const REPLY_BUTTON_STYLES: readonly string[] = [
  'default',
  'primary',
  'success',
  'danger',
]

/**
 * The tier an agent asked for, or null.
 *
 * An unknown value is DROPPED, never refused. The dynamic tool declaration
 * carries an enum, but a tool declaration is ADVISORY: nothing at runtime
 * refuses a model that answers "blue", "warning" or "Success", and the value
 * used to be spread straight onto the option. The backend's DTO then 400s the
 * WHOLE reply over one bad enum, so the text, the files and every other chip
 * are lost with it, and losing a message because a chip wanted a colour that
 * does not exist is the wrong trade. Neutral is what every app rendered before
 * the tier existed.
 */
export function normalizeButtonStyle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return REPLY_BUTTON_STYLES.includes(value) ? value : null
}
