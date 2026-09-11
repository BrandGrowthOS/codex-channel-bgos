// Adapted from BrandGrowthOS/bgos-claude-plugin, Apache-2.0, commit 3ecbb58679febcc243f671e05788b521b065546e.
/**
 * voice_rpc frame handler — the Codex plugin side of BGOS's native
 * in-app WebRTC voice control plane.
 *
 * The BGOS backend pushes `voice_rpc {rpcId, op, assistantId, agentRoute,
 * chatId, payload}` frames to the `assistant:<id>` room this plugin's
 * socket already joined (the pairingless lane — pairing daemons like
 * OpenClaw get the same frames on `pairing:<id>`). We ACK immediately
 * (suppresses the backend's 1.5 s retry-emit), run the op, and POST the
 * outcome back with our X-API-Key:
 *
 *   POST /api/v1/integrations/voice-rpc/:rpcId/result
 *     {ok:true, payload} | {ok:false, error:{code, message}}
 *
 * Ops:
 *   mint    → POST https://api.openai.com/v1/realtime/client_secrets
 *             directly with the CALLER's own per-user OpenAI key from the mint
 *             frame (payload.openaiApiKey); there is NO host-env fallback, so
 *             no user can spend the owner's key. We own
 *             the mint, so the agent persona + recent chat context are baked
 *             into the session `instructions` → contextInjected:true (the
 *             app then skips client-side injection). 8 s inner cap, under
 *             the backend's 10 s mint deadline so our descriptive error
 *             always beats the generic timeout. The session bakes EXACTLY
 *             the codex_agent_consult tool — the app only registers its
 *             client-side dispatch/roundtable tools when the mint returned
 *             ≥1 baked tool (verified frontend gotcha).
 *   consult → push a [voice_consult] channel notification into the live
 *             Codex session and wait for the voice_consult_reply MCP
 *             tool to resolve it. 38 s inner cap < the backend's 45 s. A
 *             busy session (mid-turn) usually blows the budget — that is
 *             expected and degrades to a graceful spoken "still working"
 *             line app-side; a late voice_consult_reply is told to send the
 *             answer as a normal chat reply instead.
 *   dispatch → NOT expected on this lane (the backend delivers dispatches
 *             to pairingless agents as `voice_task_dispatch` events, plugin
 *             v0.13.0). Answered with a descriptive error, never silence —
 *             the G2 silent-drop lesson: every wire shape gets an explicit
 *             outcome.
 *   stop_turn → the user pressed Stop for ONE chat (session controls).
 *             Cooperative cancel: deliver a channel notification telling
 *             the live agent to stop working on that chatId now, post a
 *             short plain confirmation into the chat, then result
 *             {stopped:true, mode:'cooperative'}. When the frame carries
 *             no chatId or the live session is unreachable, result
 *             {stopped:false, supported:false}. Never kills the daemon,
 *             never touches other chats.
 *
 * Deadline discipline (ported from openclaw-channel-bgos/voice-rpc-handler):
 * the daemon's inner cap must stay UNDER the backend's, because the backend
 * drops results that arrive after its own timeout — a descriptive error that
 * arrives in time always beats a better answer that arrives late.
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export type VoiceRpcOp = 'mint' | 'consult' | 'dispatch' | 'stop_turn'

export interface VoiceRpcFrame {
  rpcId: string
  op: VoiceRpcOp
  assistantId: string | number
  agentRoute: string
  chatId: string | number | null
  payload: Record<string, unknown>
}

export interface VoiceRpcResultBody {
  ok: boolean
  payload?: Record<string, unknown>
  error?: { code: string; message: string }
}

/**
 * Validate a voice_rpc control frame. Backend emits camelCase:
 * {rpcId, op, assistantId, agentRoute, chatId, payload}. Ops are
 * WHITELISTED — anything else is dropped here (the backend's own timeout
 * surfaces the failure to the app, so silence for a malformed frame is
 * safe; a well-formed frame with an op we don't serve gets a descriptive
 * error in VoiceRpcHandler.handle instead). Port of the OpenClaw
 * bgos-ws.ts normalizer.
 */
export function normalizeVoiceRpc(raw: unknown): VoiceRpcFrame | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const rpcId = typeof r.rpcId === 'string' ? r.rpcId : ''
  const op =
    r.op === 'mint' ||
    r.op === 'consult' ||
    r.op === 'dispatch' ||
    r.op === 'stop_turn'
      ? r.op
      : null
  if (!rpcId || !op) return null
  return {
    rpcId,
    op,
    assistantId:
      typeof r.assistantId === 'number' || typeof r.assistantId === 'string'
        ? r.assistantId
        : '',
    agentRoute: typeof r.agentRoute === 'string' ? r.agentRoute : '',
    chatId:
      typeof r.chatId === 'number' || typeof r.chatId === 'string'
        ? r.chatId
        : null,
    payload:
      r.payload && typeof r.payload === 'object'
        ? (r.payload as Record<string, unknown>)
        : {},
  }
}

/** The SDP-exchange endpoint for a direct-OpenAI mint (wire contract). */
export const OFFER_URL = 'https://api.openai.com/v1/realtime/calls'
export const CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/client_secrets'
/** Must not collide with the app's client-registered tool names
 *  (agent_dispatch / get_task_status / check_agent_status / roundtable_*):
 *  the app's tool router relays every OTHER name to the consult endpoint. */
export const CONSULT_TOOL_NAME = 'codex_agent_consult'

export interface AgentIdentity {
  name: string
  subtitle: string
}

/**
 * Per-assistant voice settings from the app (BGOS assistant voice menu),
 * riding the mint frame as payload.voiceConfig. Everything optional — the
 * host env config (BGOS_VOICE_VOICE / BGOS_VOICE_PERSONA) is the fallback
 * ONLY. Bounds mirror the backend coercion (services/voice-settings.ts) and
 * OpenAI's GA limits: speed 0.25–1.5 (session.audio.output.speed).
 */
export interface MintVoiceConfig {
  voice?: string
  speed?: number
  instructions?: string
  /** The agent owner's realtime model pin, only when this daemon knows it. */
  model?: string
  /** Confirm gate (Iris G5): the backend sets this when the assistant's
   *  owner enabled ask-before-dispatch; the mint instructions then carry
   *  the propose-first contract. */
  requireDispatchConfirm?: true
}

export const VOICE_SPEED_MIN = 0.25
export const VOICE_SPEED_MAX = 1.5
export const VOICE_INSTRUCTIONS_MAX = 2000
const VOICE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** Realtime models this daemon is willing to mint. The APP stores the owner's
 *  pick permissively (a model id newer than the deployed backend must survive
 *  a save), so the closed allowlist lives HERE, at the only place that spends
 *  money: an unrecognised id keeps the host default rather than billing
 *  against a model nobody quoted a price for. Adding one is a one-line change
 *  plus a price check. */
export const REALTIME_MODELS = [
  'gpt-realtime-2.1',
  'gpt-realtime-2.1-mini',
] as const

/** ONE shared total-instructions budget (Iris G4): persona + recent context +
 *  the owner memory head must fit in ~14k chars. When over, memory is trimmed
 *  FIRST (then recent context); the fixed voice contract is never trimmed. The
 *  aggregate trim only applies when a memory head is actually present, so an
 *  agent with NO memory files mints byte-identically to the pre-feature path. */
export const AGGREGATE_INSTRUCTIONS_BUDGET = 14_000
/** Per-source cap on the owner memory head before the aggregate trim. */
export const VOICE_MEMORY_MAX = 8_000

/** Keep the first `n` UTF-16 units, dropping a trailing lone high surrogate so
 *  the cut never leaves a broken astral character. */
function sliceHead(s: string, n: number): string {
  if (s.length <= n) return s
  let out = s.slice(0, n)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/** Keep the LAST `n` UTF-16 units (the most recent text), dropping a leading
 *  lone low surrogate so the cut never leaves a broken astral character. */
function sliceTail(s: string, n: number): string {
  if (s.length <= n) return s
  let out = s.slice(s.length - n)
  const first = out.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1)
  return out
}

/** The agent-home memory files read into the voice memory head, in order,
 *  relative to the plugin cwd (the agent's project dir). Best-effort. */
const VOICE_MEMORY_CANDIDATES = [
  'USER.md',
  'MEMORY.md',
  'memory/MEMORY.md',
  '.codex/memory/MEMORY.md',
]

/**
 * Owner memory head (Iris G4): read the agent's home memory files (or the
 * explicit BGOS_VOICE_MEMORY_FILE) into a single capped string. Owner-only by
 * construction (the backend refuses non-owner mints, and the plugin mints
 * with the caller's own OpenAI key). Best-effort: a missing/unreadable file
 * contributes nothing, so an agent with no memory files is byte-identical to
 * the pre-feature mint. Set BGOS_VOICE_MEMORY=off to disable entirely. The
 * file reader is injectable for tests.
 */
export function loadVoiceMemory(
  opts: {
    cwd?: string
    env?: Record<string, string | undefined>
    readFile?: (path: string) => string | null
  } = {},
): string {
  const env = opts.env ?? process.env
  if ((env.BGOS_VOICE_MEMORY ?? '').trim().toLowerCase() === 'off') return ''
  const cwd = opts.cwd ?? process.env.CODEX_BGOS_WORKDIR ?? process.cwd()
  const read =
    opts.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return null
      }
    })
  const explicit = (env.BGOS_VOICE_MEMORY_FILE ?? '').trim()
  const candidates = explicit ? [explicit] : VOICE_MEMORY_CANDIDATES
  const chunks: string[] = []
  for (const rel of candidates) {
    const path = isAbsolute(rel) ? rel : join(cwd, rel)
    const body = read(path)
    if (body && body.trim()) chunks.push(body.trim())
    if (chunks.join('\n\n').length >= VOICE_MEMORY_MAX) break
  }
  return chunks.join('\n\n').slice(0, VOICE_MEMORY_MAX)
}

/**
 * Sanitize payload.voiceConfig from the wire. Defensive twin of the
 * backend's buildMintVoiceConfig — the backend already coerces, but the
 * daemon must never trust the wire (junk voice → dropped, out-of-range
 * speed → clamped, oversized instructions → capped). Returns {} when
 * nothing usable is present so callers can spread it safely.
 */
export function normalizeVoiceConfig(raw: unknown): MintVoiceConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: MintVoiceConfig = {}
  if (typeof r.voice === 'string' && VOICE_ID_RE.test(r.voice.trim())) {
    out.voice = r.voice.trim().toLowerCase()
  }
  const speed = typeof r.speed === 'string' ? Number(r.speed) : r.speed
  if (typeof speed === 'number' && Number.isFinite(speed)) {
    out.speed =
      Math.round(
        Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, speed)) * 100,
      ) / 100
  }
  if (typeof r.instructions === 'string' && r.instructions.trim()) {
    out.instructions = r.instructions.trim().slice(0, VOICE_INSTRUCTIONS_MAX)
  }
  if (typeof r.model === 'string') {
    const model = r.model.trim().toLowerCase()
    if ((REALTIME_MODELS as readonly string[]).includes(model)) {
      out.model = model
    }
  }
  // Coerce defensively (never trust the wire): boolean true or string 'true'.
  if (r.requireDispatchConfirm === true || r.requireDispatchConfirm === 'true') {
    out.requireDispatchConfirm = true
  }
  return out
}

export interface VoiceRpcTiming {
  /** Whole-mint wall clock (identity fetch + OpenAI call). < backend 10 s. */
  mintTimeoutMs: number
  /** Whole-consult wall clock (notification → tool reply). < backend 45 s. */
  consultTimeoutMs: number
  /** Slice of the mint budget spent on the best-effort identity fetch. */
  identityTimeoutMs: number
  /** How long a timed-out consult id is remembered to answer a LATE
   *  voice_consult_reply with "send it to the chat instead". */
  expiredConsultTtlMs: number
}

export const DEFAULT_TIMING: VoiceRpcTiming = {
  mintTimeoutMs: 8_000,
  consultTimeoutMs: 38_000,
  identityTimeoutMs: 2_500,
  expiredConsultTtlMs: 10 * 60_000,
}

export interface VoiceRpcConfig {
  /**
   * Host env OpenAI key (BGOS_OPENAI_API_KEY / OPENAI_API_KEY). The mint no
   * longer spends this: it uses the CALLER's own per-user key from the mint
   * frame (payload.openaiApiKey) with no host-env fallback, so no user drains
   * the owner's key. Retained for wiring/back-compat.
   */
  openaiApiKey: string
  model: string
  voice: string
  /** Optional extra persona text (BGOS_VOICE_PERSONA). */
  persona: string
  assistantId: string
  chatIdFallback?: string | null
}

export interface VoiceRpcDeps {
  config: VoiceRpcConfig
  /** POST integrations/voice-rpc/:rpcId/ack (X-API-Key). */
  postAck(rpcId: string): Promise<unknown>
  /** POST integrations/voice-rpc/:rpcId/result (X-API-Key). */
  postResult(rpcId: string, body: VoiceRpcResultBody): Promise<unknown>
  /** Push a channel notification into the live Codex session. */
  notify(content: string, meta: Record<string, unknown>): Promise<unknown>
  /** Best-effort agent identity for the voice persona (caller caches). */
  getIdentity(timeoutMs: number): Promise<AgentIdentity | null>
  /** Plain outbound chat message via the normal send path (POST
   *  send-message). Used by stop_turn for its short confirmation line.
   *  Optional and best-effort: a failure never fails the op. */
  sendChatMessage?(chatId: string, text: string): Promise<unknown>
  log(msg: string): void
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  timing?: Partial<VoiceRpcTiming>
}

class VoiceRpcError extends Error {
  // No TS parameter properties: node --test runs these files in strip-only
  // mode, which rejects them (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Clamp a step's timeout so it can never overshoot the op deadline
 *  (inner < outer discipline; see the OpenClaw reference). */
function capToDeadline(timeoutMs: number, deadline: number): number {
  return Math.max(1, Math.min(timeoutMs, deadline - Date.now()))
}

/** The backend stores `new Date(Number(expiresAt) * 1000)` — the wire unit
 *  is epoch SECONDS. OpenAI's client_secrets returns seconds today, but
 *  normalize defensively (the OpenClaw lesson: providers have emitted both
 *  units historically). */
export function normalizeExpiresAtSeconds(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  // ~2286-11-20 in epoch seconds; anything bigger is epoch milliseconds.
  return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n)
}

/** Continuation brief (Iris 514): consult/dispatch turns land in the agent's
 *  OWN session, which may already hold earlier voice-run results. Telling the
 *  brain so makes repeat asks dramatically faster (reuse, don't redo). */
const CONTINUATION_BRIEF =
  'This session may contain your earlier runs of similar work from this ' +
  'call. Reuse those results where they still apply and re-check only ' +
  'what changed instead of starting over.'

/** Realtime session instructions: persona + the dumb-mouth contract with a
 *  Claude-specific dispatch bias (Claude turns can take 10-60 s+, so consult
 *  is reserved for quick questions; real work goes through agent_dispatch,
 *  which is async by design). Exported for unit tests. */
export function buildMintInstructions(args: {
  identity: AgentIdentity | null
  persona: string
  recentContext: string
  /** Confirm gate (Iris G5): bake the propose-first contract. */
  requireDispatchConfirm?: boolean
  /** Owner memory head (Iris G4): the owner's profile / active projects /
   *  shorthand, read from the agent's home memory files. Owner-only by
   *  construction (the backend refuses non-owner mints). */
  memory?: string
}): string {
  const name = args.identity?.name?.trim() || 'the agent'
  const subtitle = args.identity?.subtitle?.trim() ?? ''
  const parts: string[] = []
  parts.push(
    `You are ${name}, speaking with your user on a live voice call.` +
      (subtitle ? ` ${subtitle}.` : ''),
  )
  if (args.persona.trim()) parts.push(args.persona.trim())
  parts.push(
    'Personality: warm, capable, concise. Answer in one to three short ' +
      'sentences unless asked for more. Never mention being an AI model or ' +
      `a "realtime voice"; you ARE ${name}.`,
  )
  parts.push(
    'Welcome-back ceremony: open your FIRST greeting this call with a warm, ' +
      'brief welcome (greet the user by name if the recent conversation ' +
      'below reveals it), never a robotic identical hello. If the recent ' +
      'conversation shows you are resuming an earlier thread, skip the ' +
      'greeting ceremony and pick up naturally where you left off. Do not ' +
      'invent status you do not actually have.',
  )
  parts.push(
    'You are the VOICE of the agent, not its brain. The real agent — a ' +
      "Codex session with the user's files, tools, and memory — is " +
      'reachable through your tools:\n' +
      '- Handle greetings, chit-chat, and anything answerable from this ' +
      'conversation DIRECTLY. No tools for small talk.\n' +
      '- Your brain is a coding/ops agent whose turns can take a while. For ' +
      'anything multi-step, anything needing real work (files, code, ' +
      'research, messages), or anything that changes state, PREFER ' +
      'agent_dispatch: verbally acknowledge what you are kicking off, ' +
      'dispatch it, and the result is announced when ready.\n' +
      `- Use ${CONSULT_TOOL_NAME} ONLY for quick factual questions the real ` +
      'agent can answer in a sentence or two. Verbally acknowledge before ' +
      'consulting (it takes a few seconds). If a consult fails or times ' +
      'out, say the agent is still working on it and will follow up in the ' +
      'chat — never leave silence.\n' +
      '- Speak results naturally; keep technical detail light unless asked.',
  )
  parts.push(
    'Truthfulness contract: NEVER invent, guess, or embellish the results ' +
      'of the agent\'s work. Only report an outcome you actually received ' +
      'from a tool result or an announcement on this call. If you do not ' +
      'have the result yet, say the work is still in progress and check ' +
      'its status before speaking about it.',
  )
  parts.push(
    "When you consult or dispatch, phrase the brief as the user's intent " +
      'and desired outcome, in their own words. Never include mechanics ' +
      'from earlier runs (tool names, file paths, step-by-step how-to); ' +
      'the agent owns its tools and stale mechanics mislead it.',
  )
  if (args.requireDispatchConfirm) {
    parts.push(
      'Dispatch confirmation is ON for this agent: agent_dispatch STAGES a ' +
        'proposal instead of starting work. Read the staged brief back to ' +
        'the user in one short sentence and ask for their go-ahead. Only ' +
        'after the user clearly confirms on their next turn, call ' +
        'confirm_dispatch with the task id from the ack. If they decline, ' +
        'call confirm_dispatch with approve:false. Never invent a ' +
        'confirmation the user did not give.',
    )
  }
  const core = parts.join('\n\n')
  const memLabel = 'Owner memory (profile, active projects, shorthand):\n'
  const ctxLabel = 'Recent conversation with your user (for continuity):\n'
  const SEP = '\n\n'
  let memory = sliceHead((args.memory ?? '').trim(), VOICE_MEMORY_MAX)
  // recentContext is built most-recent-LAST, so keep its TAIL when trimming.
  let context = sliceTail(args.recentContext.trim(), 20_000)

  // Safe default: with NO memory head, leave recent context at its pre-feature
  // 20k slice and skip the aggregate trim entirely, so a memory-less agent
  // mints byte-identically to before this feature.
  if (memory) {
    // Owner memory present: the shared ~14k aggregate now applies. Preserve
    // the most recent conversation; trim memory FIRST, then context (tail).
    const coreCost = core.length
    const ctxBlockCost = context
      ? SEP.length + ctxLabel.length + context.length
      : 0
    if (coreCost + ctxBlockCost > AGGREGATE_INSTRUCTIONS_BUDGET) {
      memory = ''
      if (context) {
        const room =
          AGGREGATE_INSTRUCTIONS_BUDGET - coreCost - SEP.length - ctxLabel.length
        context = room > 0 ? sliceTail(context, room) : ''
      }
    } else {
      const memRoom =
        AGGREGATE_INSTRUCTIONS_BUDGET -
        coreCost -
        ctxBlockCost -
        SEP.length -
        memLabel.length
      memory = memRoom > 0 ? sliceHead(memory, memRoom) : ''
    }
  }

  const out = [core]
  if (memory) out.push(memLabel + memory)
  if (context) out.push(ctxLabel + context)
  return out.join(SEP)
}

/** The consult tool definition baked into the realtime session at mint.
 *  Mirrors the backend's VoiceToolCallDto args shape. */
export function buildConsultToolDefinition(): Record<string, unknown> {
  return {
    type: 'function',
    name: CONSULT_TOOL_NAME,
    description:
      "Ask the agent's real brain (the live Codex session) a QUICK " +
      'question it can answer in a sentence or two. Takes several seconds; ' +
      'verbally acknowledge first. For real/multi-step work use ' +
      'agent_dispatch instead.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question, self-contained and specific.',
        },
        context: {
          type: 'string',
          description: 'Optional call context that helps answer.',
        },
        responseStyle: {
          type: 'string',
          description: 'Optional style hint, e.g. "one sentence".',
        },
      },
      required: ['question'],
    },
  }
}

/** The [voice_consult] channel-notification text. Exported for tests. */
export function buildConsultNotification(args: {
  consultId: string
  question: string
  context: string
  responseStyle: string
  budgetSeconds: number
}): string {
  return (
    `[voice_consult] Your user is asking you LIVE on a voice call ` +
    `(consult_id="${args.consultId}"):\n\n${args.question}` +
    (args.context ? `\n\nCall context: ${args.context}` : '') +
    (args.responseStyle ? `\n\nAnswer style: ${args.responseStyle}` : '') +
    `\n\n${CONTINUATION_BRIEF}` +
    `\n\nYou have ~${args.budgetSeconds} seconds. Call the ` +
    `voice_consult_reply tool FIRST — before any other tool — with ` +
    `consult_id="${args.consultId}" and a short, SPEAKABLE answer (1-3 ` +
    `sentences). Do NOT run other tools unless the question strictly ` +
    `requires it. If you cannot answer fully in time, reply with what you ` +
    `know and say the rest is coming — you can follow up in the chat.`
  )
}

/** The [voice_dispatch] channel-notification text for a voice_task_dispatch
 *  WS event (the pairingless dispatch lane server.ts listens on). Extracted
 *  from server.ts so the copy is unit-testable. Exported for tests. */
export function buildVoiceTaskDispatchText(args: {
  taskId: string
  question: string
  context: string
}): string {
  return (
    `[voice_dispatch] Your user is on a live voice call and dispatched ` +
    `background task #${args.taskId} to you:\n\n${args.question}` +
    (args.context ? `\n\nExtra context: ${args.context}` : '') +
    `\n\n${CONTINUATION_BRIEF}` +
    `\n\nDo this work NOW in this session. When finished, call the ` +
    `complete_voice_task tool with task_id="${args.taskId}" and a concise, ` +
    `SPEAKABLE result (it is announced aloud in their call). If you ` +
    `cannot do it, call complete_voice_task with failed=true and the reason.`
  )
}

/**
 * Parse + gate a voice_task_dispatch WS payload (Iris G5). The backend now
 * sends confirmed:true on every dispatch it forwards (standing consent or a
 * user-confirmed proposal); with requireConfirmed on (the
 * BGOS_REQUIRE_CONFIRMED_DISPATCH belt, default off) anything else is
 * rejected so a compromised or buggy sender cannot start unconfirmed work.
 * Coerces defensively per the never-trust-the-wire doctrine (boolean true or
 * string 'true'). Exported for tests.
 */
export function normalizeVoiceTaskDispatch(
  payload: unknown,
  opts: { requireConfirmed: boolean },
):
  | {
      ok: true
      task: { taskId: string; question: string; context: string; chatId: string }
    }
  | { ok: false; reason: string } {
  const p = (payload ?? {}) as Record<string, unknown>
  const taskId = String(p.task_id ?? '')
  if (!taskId) return { ok: false, reason: 'missing task_id' }
  const confirmed = p.confirmed === true || p.confirmed === 'true'
  if (opts.requireConfirmed && !confirmed) {
    return {
      ok: false,
      reason:
        `unconfirmed dispatch rejected (task=${taskId}): ` +
        'BGOS_REQUIRE_CONFIRMED_DISPATCH is on and the payload lacks confirmed:true',
    }
  }
  return {
    ok: true,
    task: {
      taskId,
      question: String(p.question ?? ''),
      context: p.context ? String(p.context) : '',
      chatId: String(p.chat_id ?? ''),
    },
  }
}

/** Confirmation line posted to the chat after a delivered stop request. */
export const STOP_TURN_CONFIRMATION = 'Run stopped at your request.'

/** The [stop_turn] channel-notification text (session controls). Honest
 *  cooperative semantics: this plugin cannot kill an in-flight model turn,
 *  so it tells the live agent, in plain words, to stand down on that ONE
 *  chat immediately. Exported for tests. */
export function buildStopTurnNotification(args: { chatId: string }): string {
  return (
    `[stop_turn] Your user pressed STOP for chat ${args.chatId}. ` +
    `Stop working on that chat NOW: do not start any new tool calls for ` +
    `it and abandon its remaining steps. Send ONE short reply line to ` +
    `that chat acknowledging where you stopped. Keep any partial results ` +
    `you already sent. Work for other chats is unaffected.`
  )
}

export type ConsultReplyStatus = 'resolved' | 'late' | 'unknown'

interface PendingConsult {
  settle: (text: string) => void
  fail: (err: VoiceRpcError) => void
}

export class VoiceRpcHandler {
  private readonly deps: VoiceRpcDeps
  private readonly timing: VoiceRpcTiming
  /** Duplicate-frame guard: the backend re-emits once when its ACK doesn't
   *  land within 1.5 s; a consult dispatched twice would run two turns. */
  private readonly inFlight = new Set<string>()
  private readonly pendingConsults = new Map<string, PendingConsult>()
  /** consultId → expiry ts, so a LATE voice_consult_reply gets "send it to
   *  the chat instead" rather than "unknown id". Bounded + TTL'd. */
  private readonly expiredConsults = new Map<string, number>()

  constructor(deps: VoiceRpcDeps) {
    this.deps = deps
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
  }

  async handle(frame: VoiceRpcFrame): Promise<void> {
    if (!frame?.rpcId) return
    if (this.inFlight.has(frame.rpcId)) {
      this.deps.log(`voice_rpc duplicate frame ignored (rpc=${frame.rpcId})`)
      return
    }
    this.inFlight.add(frame.rpcId)
    try {
      // ACK is best-effort: a failed ACK only costs one retry-emit (which
      // the inFlight guard absorbs); it must not abort the op itself.
      try {
        await this.deps.postAck(frame.rpcId)
      } catch (err) {
        this.deps.log(
          `voice_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      let payload: Record<string, unknown>
      if (frame.op === 'mint') {
        payload = await this.mint(frame)
      } else if (frame.op === 'consult') {
        payload = await this.consult(frame)
      } else if (frame.op === 'stop_turn') {
        payload = await this.stopTurn(frame)
      } else {
        // The backend delivers dispatches to pairingless agents as
        // voice_task_dispatch events, not voice_rpc frames — answer
        // loudly so a future backend change fails fast, never silently.
        throw new VoiceRpcError(
          'UNSUPPORTED_OP',
          `unsupported voice_rpc op for the Codex channel: ${String(
            frame.op,
          )} (dispatch arrives as voice_task_dispatch)`,
        )
      }
      await this.postResult(frame.rpcId, { ok: true, payload })
    } catch (err) {
      const code = err instanceof VoiceRpcError ? err.code : 'PLUGIN_ERROR'
      await this.postResult(frame.rpcId, {
        ok: false,
        error: {
          code,
          message: err instanceof Error ? err.message : String(err),
        },
      })
    } finally {
      this.inFlight.delete(frame.rpcId)
    }
  }

  // ── mint ──────────────────────────────────────────────────────────────────

  private async mint(frame: VoiceRpcFrame): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.timing.mintTimeoutMs
    const { config } = this.deps
    // Per-user key (BILLING/SECURITY): the Home of Agents backend rides the
    // CALLER's own OpenAI key on the mint frame (payload.openaiApiKey) so the
    // realtime session spends THEIR OpenAI credits, never this agent host's
    // owner key (BGOS_OPENAI_API_KEY / OPENAI_API_KEY). This plugin is ALWAYS
    // backend-driven (voice_rpc frames only ever arrive from the Home of
    // Agents backend over the authed assistant:<id> room), so unlike the
    // standalone-capable gobot/hermes daemons, there is NO owner-env fallback:
    // a frame that carries no user key is refused (the backend already blocks
    // keyless callers before emitting a frame; this is defense in depth). Trim
    // first so a whitespace-only key counts as unset. The raw key stays
    // server-side (it arrived over the authed WS room), is sent ONLY to
    // OpenAI's client_secrets endpoint, and is never logged nor returned to the
    // app.
    const userOpenaiApiKey =
      typeof frame.payload?.openaiApiKey === 'string'
        ? frame.payload.openaiApiKey.trim()
        : ''
    if (!userOpenaiApiKey) {
      throw new VoiceRpcError(
        'VOICE_NOT_CONFIGURED',
        'voice is not configured: the caller has not set an OpenAI API key ' +
          'in their Home of Agents settings',
      )
    }
    const identity = await this.deps
      .getIdentity(capToDeadline(this.timing.identityTimeoutMs, deadline))
      .catch(() => null)
    const recentContext =
      typeof frame.payload?.recentContext === 'string'
        ? frame.payload.recentContext
        : ''
    // Per-assistant voice settings from the app (v0.15.0): voice + speed +
    // persona instructions override the host env config; env vars are the
    // fallback ONLY when the app sent nothing.
    const voiceConfig = normalizeVoiceConfig(frame.payload?.voiceConfig)
    const voice = voiceConfig.voice ?? config.voice
    const persona = voiceConfig.instructions ?? config.persona
    // The owner's model pin wins over BGOS_VOICE_MODEL. normalizeVoiceConfig
    // already dropped anything off REALTIME_MODELS, so an unknown pin lands on
    // the host default instead of failing the call.
    const model = voiceConfig.model ?? config.model
    const instructions = buildMintInstructions({
      identity,
      persona,
      recentContext,
      requireDispatchConfirm: voiceConfig.requireDispatchConfirm === true,
      // Owner memory head (G4): read the agent's home memory files. Owner-only
      // by construction (backend refuses non-owner mints).
      memory: loadVoiceMemory(),
    })
    const body = {
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model,
        instructions,
        tools: [buildConsultToolDefinition()],
        audio: {
          // Input transcription is REQUIRED: the app builds the call
          // transcript (posted back into the chat) from realtime
          // transcription events. Server VAD gives natural turn-taking.
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: { type: 'server_vad' },
          },
          output: {
            voice,
            // Only sent when the app configured it — omitting preserves the
            // exact pre-feature request shape (OpenAI default 1.0).
            ...(voiceConfig.speed != null ? { speed: voiceConfig.speed } : {}),
          },
        },
      },
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const ac = new AbortController()
    const timer = setTimeout(
      () => ac.abort(),
      capToDeadline(this.timing.mintTimeoutMs, deadline),
    )
    let res: Response
    try {
      res = await fetchImpl(CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${userOpenaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
    } catch (err) {
      const aborted =
        (err as { name?: string })?.name === 'AbortError' || ac.signal.aborted
      throw new VoiceRpcError(
        'MINT_FAILED',
        aborted
          ? 'OpenAI mint timed out'
          : `OpenAI mint failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new VoiceRpcError(
        'MINT_FAILED',
        `OpenAI client_secrets ${res.status}: ${text.slice(0, 200)}`,
      )
    }
    const data = (await res.json()) as {
      value?: unknown
      expires_at?: unknown
    }
    const clientSecret = typeof data?.value === 'string' ? data.value : ''
    if (!clientSecret) {
      throw new VoiceRpcError(
        'MINT_FAILED',
        'OpenAI client_secrets returned no secret value',
      )
    }
    return {
      provider: 'openai',
      transport: 'webrtc',
      clientSecret,
      offerUrl: OFFER_URL,
      // Echo what was APPLIED, so the app knows which model ran the call.
      model,
      // Echo what was APPLIED (app settings win over env) — the app's
      // in-call gear shows this as the active voice.
      voice,
      ...(voiceConfig.speed != null ? { speed: voiceConfig.speed } : {}),
      expiresAt:
        normalizeExpiresAtSeconds(data?.expires_at) ??
        Math.floor(Date.now() / 1000) + 600,
      // Context + persona ride the session instructions above — the app
      // must NOT inject recentContext again client-side.
      contextInjected: true,
    }
  }

  // ── stop_turn (session controls, cooperative) ─────────────────────────────

  /**
   * The user pressed Stop for ONE chat. This daemon has no process-level
   * handle on an in-flight Codex turn, so the cancel is COOPERATIVE:
   * push a channel notification that tells the live agent to stand down on
   * that chatId immediately (no new tool calls, one short acknowledgement,
   * keep partial results). Scope is strictly the frame's chatId; nothing is
   * killed and no other chat is touched. Outcomes (wire contract):
   *   {stopped:true, mode:'cooperative'}  the stop request reached the
   *                                       live session
   *   {stopped:false, supported:false}    no chatId on the frame, or the
   *                                       live session is unreachable
   */
  private async stopTurn(
    frame: VoiceRpcFrame,
  ): Promise<Record<string, unknown>> {
    const chatId = frame.chatId != null ? String(frame.chatId) : ''
    if (!chatId) {
      this.deps.log(
        `stop_turn without a chatId cannot be scoped, answering unsupported ` +
          `(rpc=${frame.rpcId})`,
      )
      return { stopped: false, supported: false }
    }
    try {
      // Channel meta MUST be all-string valued (the harness silently drops
      // cards with non-string meta; see the consult path above).
      await this.deps.notify(buildStopTurnNotification({ chatId }), {
        event_type: 'stop_turn',
        chat_id: chatId,
        assistant_id: String(this.deps.config.assistantId),
        requested_by: 'user',
        transport: 'ws',
      })
    } catch (err) {
      // The live session is unreachable, so a cooperative stop can never
      // land. Be honest: this daemon cannot cancel right now.
      this.deps.log(
        `stop_turn delivery failed (rpc=${frame.rpcId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return { stopped: false, supported: false }
    }
    // Short plain confirmation into the chat via the normal outbound send
    // path. Best-effort: the stop already reached the agent, so a failed
    // confirmation must not flip the result.
    try {
      await this.deps.sendChatMessage?.(chatId, STOP_TURN_CONFIRMATION)
    } catch (err) {
      this.deps.log(
        `stop_turn confirmation send failed (chat=${chatId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    return { stopped: true, mode: 'cooperative' }
  }

  // ── consult ───────────────────────────────────────────────────────────────

  private async consult(
    frame: VoiceRpcFrame,
  ): Promise<Record<string, unknown>> {
    const { callId, name, args } = frame.payload as {
      callId?: string
      name?: string
      args?: Record<string, unknown>
    }
    if (!callId || !name) {
      throw new VoiceRpcError(
        'BAD_CONSULT',
        'consult payload missing callId/name',
      )
    }
    const question =
      typeof args?.question === 'string' ? args.question.trim() : ''
    if (!question) {
      throw new VoiceRpcError('BAD_CONSULT', 'consult args missing question')
    }
    const context = typeof args?.context === 'string' ? args.context.trim() : ''
    const responseStyle =
      typeof args?.responseStyle === 'string' ? args.responseStyle.trim() : ''
    const consultId = frame.rpcId
    const content = buildConsultNotification({
      consultId,
      question,
      context,
      responseStyle,
      // Advertise a bit less than the real cap so the agent aims inside it.
      budgetSeconds: Math.max(
        5,
        Math.floor((this.timing.consultTimeoutMs - 8_000) / 1000),
      ),
    })

    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConsults.delete(consultId)
        this.rememberExpired(consultId)
        reject(
          new VoiceRpcError(
            'CONSULT_TIMEOUT',
            'The agent is still working on it — it will follow up in the chat.',
          ),
        )
      }, this.timing.consultTimeoutMs)
      this.pendingConsults.set(consultId, {
        settle: (answer) => {
          clearTimeout(timer)
          this.pendingConsults.delete(consultId)
          resolve(answer)
        },
        fail: (err) => {
          clearTimeout(timer)
          this.pendingConsults.delete(consultId)
          reject(err)
        },
      })
      // Channel `meta` MUST be all-string valued: the Codex harness
      // silently drops any notifications/claude/channel card whose meta
      // carries a non-string value (regression: plugin PR #19 — a null in
      // the WS inbound meta made every live card vanish). Guarded by
      // test/voice-rpc.test.ts "consult meta is all-string valued".
      this.deps
        .notify(content, {
          event_type: 'voice_consult',
          consult_id: String(consultId),
          call_id: String(callId),
          chat_id:
            frame.chatId != null
              ? String(frame.chatId)
              : String(this.deps.config.chatIdFallback ?? ''),
          assistant_id: String(this.deps.config.assistantId),
          transport: 'ws',
        })
        .catch((err) => {
          // If the live session is unreachable the consult can never
          // resolve — fail fast with a descriptive error instead of
          // burning the whole budget.
          this.pendingConsults
            .get(consultId)
            ?.fail(
              new VoiceRpcError(
                'CONSULT_DELIVERY_FAILED',
                `could not reach the live Codex session: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            )
        })
    })
    return { text }
  }

  /**
   * Called by the voice_consult_reply MCP tool. Returns how the reply was
   * received so the tool result can steer the agent:
   *   resolved — delivered to the live call
   *   late     — consult already timed out; send the answer as a chat reply
   *   unknown  — no such consult id (typo, or a restart dropped it)
   */
  resolveConsult(consultId: string, answer: string): ConsultReplyStatus {
    const pending = this.pendingConsults.get(consultId)
    if (pending) {
      pending.settle(answer)
      return 'resolved'
    }
    this.pruneExpired()
    if (this.expiredConsults.has(consultId)) return 'late'
    return 'unknown'
  }

  /** Number of consults currently awaiting a voice_consult_reply. */
  get pendingConsultCount(): number {
    return this.pendingConsults.size
  }

  private rememberExpired(consultId: string): void {
    this.pruneExpired()
    this.expiredConsults.set(
      consultId,
      Date.now() + this.timing.expiredConsultTtlMs,
    )
    // Hard bound so a pathological caller can't grow the map forever.
    if (this.expiredConsults.size > 200) {
      const first = this.expiredConsults.keys().next().value
      if (first !== undefined) this.expiredConsults.delete(first)
    }
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [id, expiry] of this.expiredConsults) {
      if (expiry <= now) this.expiredConsults.delete(id)
    }
  }

  private async postResult(
    rpcId: string,
    body: VoiceRpcResultBody,
  ): Promise<void> {
    try {
      await this.deps.postResult(rpcId, body)
    } catch (err) {
      // Nothing else we can do — the backend's own timeout surfaces the
      // failure to the app.
      this.deps.log(
        `voice_rpc result post failed (rpc=${rpcId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
