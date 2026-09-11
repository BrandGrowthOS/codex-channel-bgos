// Adapted from BrandGrowthOS/bgos-claude-plugin, Apache-2.0, commit 3ecbb58679febcc243f671e05788b521b065546e.
/**
 * Pure, side-effect-free builders for the `create_mission` / `tick_mini_goal`
 * / `complete_mission` MCP tools (BGOS capability #20, Missions).
 *
 * Like ./lib/schedule.ts, everything here is deterministic and import-safe
 * (no env reads, no network, no clock, no process exit), so it can be unit
 * and eval tested directly. server.ts imports these for the CallTool
 * handlers; the eval suite (test/missions.test.ts) imports them too.
 *
 * Wire contract (user-scoped routes; the plugin authenticates with X-API-Key
 * and its assistants have pairingId = null, so the /integrations twins used
 * by pairing-managed plugins do not apply here):
 *
 *   POST  assistants/:assistantId/missions                      create
 *   GET   assistants/:assistantId/missions/active               { mission | null }
 *   PATCH assistants/:assistantId/missions/:missionId/tick      { goalId, evidence? }
 *   PATCH assistants/:assistantId/missions/:missionId/complete  { summary? }
 *
 * Create body: { title, miniGoals: [{ name, doneWhen }] }.
 * Complete body: { summary? }, where summary is at most 500 chars. The backend
 * accepts 2..12 goals (the trained flow targets 4 to 10), assigns goal ids
 * 1..n, enforces ONE active mission per assistant (creating a new one
 * abandons the previous active mission), auto-completes on the last tick,
 * and treats a tick of an already-done goal as an idempotent no-op. All
 * write responses embed the full mission snapshot as { ok, mission }; the
 * active read returns { mission | null }.
 *
 * Validation failures return { ok: false, error } rather than throwing, so
 * the thin server wiring can relay a clear, actionable message to the agent
 * as the tool result.
 */

export const MISSION_MIN_GOALS = 2
export const MISSION_MAX_GOALS = 12
export const MISSION_TITLE_MAX = 200
export const MISSION_GOAL_NAME_MAX = 120
export const MISSION_DONE_WHEN_MAX = 200
export const MISSION_EVIDENCE_MAX = 200
export const MISSION_SUMMARY_MAX = 500

/** What the trained flow should aim for (the hard caps are 2..12). */
export const MISSION_TARGET_RANGE = '4 to 10'

export interface MissionGoalBody {
  name: string
  doneWhen: string
}

export interface MissionCreateBody {
  title: string
  miniGoals: MissionGoalBody[]
}

export interface MissionTickBody {
  goalId: number
  evidence?: string
}

export interface MissionCompleteBody {
  summary?: string
}

/** The mission snapshot shape the backend returns (subset the tools read). */
export interface MissionSnapshot {
  id: number
  title: string
  status: 'active' | 'completed' | 'abandoned'
  miniGoals: Array<{
    id: number
    name: string
    doneWhen: string
    done: boolean
    doneAt: string | null
    evidence: string | null
  }>
}

export type MissionBuildResult<T> = { ok: true; body: T } | { ok: false; error: string }
export type MissionPathResult = { ok: true; path: string } | { ok: false; error: string }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const GOALS_HELP =
  `mini_goals must be an array of ${MISSION_MIN_GOALS}..${MISSION_MAX_GOALS} binary goals ` +
  `(aim for ${MISSION_TARGET_RANGE}), each { name, done_when } where done_when states the ` +
  'observable check that proves the goal, e.g. "the URL returns 200".'

/** Build the POST assistants/:id/missions body from snake_case tool args. */
export function buildMissionCreateBody(input: {
  title?: unknown
  mini_goals?: unknown
}): MissionBuildResult<MissionCreateBody> {
  const { title, mini_goals } = input

  if (typeof title !== 'string' || !title.trim()) {
    return { ok: false, error: 'title is required: a short mission headline the user will see on the card.' }
  }
  const trimmedTitle = title.trim()
  if (trimmedTitle.length > MISSION_TITLE_MAX) {
    return {
      ok: false,
      error: `title is too long (${trimmedTitle.length} chars, max ${MISSION_TITLE_MAX}).`,
    }
  }

  if (!Array.isArray(mini_goals)) {
    return { ok: false, error: GOALS_HELP }
  }
  if (mini_goals.length < MISSION_MIN_GOALS || mini_goals.length > MISSION_MAX_GOALS) {
    return {
      ok: false,
      error:
        `A mission needs ${MISSION_MIN_GOALS} to ${MISSION_MAX_GOALS} mini-goals, got ` +
        `${mini_goals.length}. Aim for ${MISSION_TARGET_RANGE}: decompose the request into ` +
        'binary outcomes, not keystrokes.',
    }
  }

  const miniGoals: MissionGoalBody[] = []
  for (let i = 0; i < mini_goals.length; i++) {
    const raw = mini_goals[i]
    if (!isPlainObject(raw)) {
      return { ok: false, error: `Mini-goal ${i + 1} is not an object. ${GOALS_HELP}` }
    }
    const name = raw.name
    // done_when is the documented tool key; doneWhen is accepted as an alias
    // so an agent echoing the wire shape back is not punished for it.
    const doneWhenRaw = raw.done_when !== undefined ? raw.done_when : raw.doneWhen
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: `Mini-goal ${i + 1} needs a non-empty name.` }
    }
    if (typeof doneWhenRaw !== 'string' || !doneWhenRaw.trim()) {
      return {
        ok: false,
        error:
          `Mini-goal ${i + 1} ("${name.trim().slice(0, 40)}") needs a done_when line: the ` +
          'observable check that proves it, e.g. "the URL returns 200".',
      }
    }
    const trimmedName = name.trim()
    const trimmedDoneWhen = doneWhenRaw.trim()
    if (trimmedName.length > MISSION_GOAL_NAME_MAX) {
      return {
        ok: false,
        error: `Mini-goal ${i + 1} name is too long (${trimmedName.length} chars, max ${MISSION_GOAL_NAME_MAX}).`,
      }
    }
    if (trimmedDoneWhen.length > MISSION_DONE_WHEN_MAX) {
      return {
        ok: false,
        error:
          `Mini-goal ${i + 1} done_when is too long (${trimmedDoneWhen.length} chars, ` +
          `max ${MISSION_DONE_WHEN_MAX}).`,
      }
    }
    miniGoals.push({ name: trimmedName, doneWhen: trimmedDoneWhen })
  }

  return { ok: true, body: { title: trimmedTitle, miniGoals } }
}

/** Build the PATCH .../tick body from snake_case tool args. */
export function buildMissionTickBody(input: {
  goal_id?: unknown
  evidence?: unknown
}): MissionBuildResult<MissionTickBody> {
  const { goal_id, evidence } = input

  if (typeof goal_id !== 'number' || !Number.isInteger(goal_id) || goal_id < 1) {
    return {
      ok: false,
      error:
        `goal_id must be a positive integer (got ${JSON.stringify(goal_id)}). Use the ids ` +
        'from the create_mission result or from get-active.',
    }
  }

  const body: MissionTickBody = { goalId: goal_id }
  if (evidence != null && evidence !== '') {
    if (typeof evidence !== 'string') {
      return { ok: false, error: 'evidence must be a short string (what proved the done_when check).' }
    }
    const trimmed = evidence.trim()
    if (trimmed.length > MISSION_EVIDENCE_MAX) {
      return {
        ok: false,
        error: `evidence is too long (${trimmed.length} chars, max ${MISSION_EVIDENCE_MAX}).`,
      }
    }
    if (trimmed) body.evidence = trimmed
  }
  return { ok: true, body }
}

/** Build the PATCH .../complete body from snake_case tool args. */
export function buildMissionCompleteBody(
  { summary }: { summary?: unknown } = {},
): MissionBuildResult<MissionCompleteBody> {
  const body: MissionCompleteBody = {}
  if (summary != null && typeof summary !== 'string') {
    return { ok: false, error: 'summary must be a string' }
  }
  if (typeof summary === 'string') {
    let trimmed = summary.trim().slice(0, MISSION_SUMMARY_MAX)
    const last = trimmed.charCodeAt(trimmed.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) trimmed = trimmed.slice(0, -1)
    if (trimmed) body.summary = trimmed
  }
  return { ok: true, body }
}

const isPositiveIntLike = (v: unknown): boolean => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n > 0
}

const BAD_ASSISTANT = 'assistant id is not configured (BGOS_ASSISTANT_ID); cannot build a mission route.'

export function buildMissionCreatePath(assistantId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  return { ok: true, path: `assistants/${assistantId}/missions` }
}

export function buildMissionActivePath(assistantId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  return { ok: true, path: `assistants/${assistantId}/missions/active` }
}

export function buildMissionTickPath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `assistants/${assistantId}/missions/${missionId}/tick` }
}

export function buildMissionCompletePath(assistantId: unknown, missionId: unknown): MissionPathResult {
  if (!isPositiveIntLike(assistantId)) return { ok: false, error: BAD_ASSISTANT }
  if (!isPositiveIntLike(missionId)) {
    return { ok: false, error: `mission id must be a positive integer (got ${JSON.stringify(missionId)}).` }
  }
  return { ok: true, path: `assistants/${assistantId}/missions/${missionId}/complete` }
}

/**
 * Compact, agent-facing mission summary for tool results: progress count, a
 * checkbox ledger with the goal ids the agent needs for tick_mini_goal, and
 * the next open goal. Pure formatting, no I/O.
 */
export function formatMissionSummary(mission: MissionSnapshot): string {
  const total = mission.miniGoals.length
  const done = mission.miniGoals.filter((g) => g.done).length
  const lines: string[] = [
    `Mission #${mission.id}: "${mission.title}" (${mission.status}), ${done} of ${total} mini-goals done.`,
  ]
  for (const g of mission.miniGoals) {
    lines.push(`  [${g.done ? 'x' : ' '}] ${g.id}. ${g.name} (done when ${g.doneWhen})`)
  }
  if (mission.status === 'active') {
    const next = mission.miniGoals.find((g) => !g.done)
    if (next) lines.push(`Next: ${next.id}. ${next.name}`)
  }
  return lines.join('\n')
}
