/**
 * Pure mapping from Codex app server events to the rows and markers BGOS
 * draws. No I/O and no protocol client: the host hands an item in, this hands
 * a row or a marker back, so the whole table is testable without an AppServer
 * fake and lives outside the 30 KB host.
 *
 * Three rules this module lives under:
 *
 *  1. The plugin always sends. Nothing here reads the owner's per agent
 *     "Show technical details" switch, and no row is ever suppressed to save
 *     bandwidth: the backend derives the agent's live working status from the
 *     rows arriving, so a silent plugin looks like an idle agent. The app
 *     decides what to draw.
 *  2. A diff body leaves the machine in exactly one case: on a file change
 *     approval card, masked by the redactor, cut to 400 lines a file and
 *     64 KB in all, and never on an activity row. `fileChange` carries a full
 *     patch body in `changes[].diff` (required and unbounded by the
 *     protocol); on a ROW the path, the change word and two line counts are
 *     copied out and the patch text itself never is, which is what the guard
 *     in test/activity-markers.spec.ts asserts and why that guard is left
 *     exactly as it is. The one case is `file-change-wire.ts`, reached only
 *     from `interactions.approve` on `item/fileChange/requestApproval`: the
 *     card is the surface where the owner is asked to AUTHORIZE the change,
 *     and a person cannot answer a question that does not say what it asks.
 *  3. `FileUpdateChange.kind` is an OBJECT in the app server v2 protocol
 *     (`{type:"update", move_path?}`) and a plain string in the older SDK
 *     shape. Both are read here, so a template literal can never ship
 *     "[object Object]" to an owner.
 *
 * Command output and the exit code DO leave the machine, since stage 7, and
 * only from a COMPLETED `commandExecution` item: the output is masked by
 * `redact-output.ts` and cut to its tail by `output-tail.ts` before it is
 * copied, and the exit code is carried only inside the range the wire
 * accepts. A running row carries neither, because the protocol leaves both
 * null while a command runs and an empty block is a worse row than one with
 * nothing to open. Codex gives ONE merged string (`aggregatedOutput` is
 * documented as stdout and stderr together), so there is no second field and
 * no `stderr:` line to insert on this channel.
 */
import { homedir } from "node:os";

import { buildComponentEventMessage } from "./hoai-shared/renderables.js";
import { clipText } from "./clip-text.js";
import { buildOutputTail } from "./output-tail.js";
import { redactOutput } from "./redact-output.js";
import { isoInstant, lineCountForWire } from "./tool-progress.js";
import type { ToolCard } from "./event-mapper.js";
import type { OutboundMessagePayload } from "./types.js";

type Rec = Record<string, any>;

/** A tool_progress row, with the stage 4 and stage 7 optional fields. */
export interface ActivityCard extends ToolCard {
  kind?: "tool" | "subagent";
  path?: string;
  pathCount?: number;
  detail?: string;
  durationMs?: number;
  /** The masked tail of what a command printed. Absent when it printed nothing. */
  output?: string;
  /** The process exit code. Zero is legal and meaningful. */
  exitCode?: number;
  /** Lines this edit added. Absent when nothing was measured. */
  linesAdded?: number;
  /** Lines this edit removed. Absent when nothing was measured. */
  linesRemoved?: number;
  /**
   * Stage 8 row fields, every one optional and every one drawn only where
   * the runtime reported it.
   *
   * `id` is this sender's stable identity for the row, which the app uses as
   * the row's key and as the key of its own open state. On a child agent row
   * it is the child's THREAD id, which is also the id the card merges the row
   * by, so the two can never disagree.
   *
   * `startedAt` is ISO 8601 and is THIS ROW's own start, not half of a pair:
   * a finished row reports `durationMs` instead, and this field never goes
   * near the card's own clock, which is both ends or neither.
   *
   * `result` is what a child agent finally said, one short line, masked over
   * the whole string and only then cut to its FIRST 240 characters. It is
   * never command output, which is `output` and which a child row never has.
   */
  id?: string;
  startedAt?: string;
  result?: string;
}

export interface ActivityRow {
  card: ActivityCard;
  /** The id the card is merged in place by. A worker thread for a subagent. */
  itemId: string;
}

export type MarkerKind = "context_compacted" | "turn_continues";

/** A quiet line in the chat, posted as an ordinary `event` message. */
export interface ActivityMarker {
  kind: MarkerKind;
  /** Renderable fields beside the kind. Short, and never free text. */
  payload: Record<string, string>;
  /** Card header, and the fallback an app that lacks the kind still shows. */
  title: string;
  text: string;
}

export interface MarkerSignal {
  marker: ActivityMarker;
  /** One marker per turn, however many notifications announce it. */
  dedupeKey: string;
}

export type ItemPhase = "started" | "completed";

const ARGS_MAX = 120;
const PATH_MAX = 200;
const DETAIL_MAX = 120;
const NAME_MAX = 64;
const WHAT_MAX = 80;
/** Characters of a child's last message one row carries. The platform caps it too. */
const RESULT_MAX = 240;
/** Characters of a row id the wire accepts. A thread id is far inside it. */
const ID_MAX = 64;
/** Characters of a row start the wire accepts. An ISO instant is 24. */
const START_MAX = 40;

const TOOL_ICON: Record<string, string> = {
  commandExecution: "⚡",
  fileChange: "✏️",
  webSearch: "🔎",
  mcpToolCall: "🔌",
  dynamicToolCall: "🔧",
  imageGeneration: "🖼️",
  imageView: "🖼️",
};
const SUBAGENT_ICON = "👥";

/** Worker states, worst first, with the word the owner reads. */
const WORKER_WORDS: Array<[string, string]> = [
  ["running", "running"],
  ["pendingInit", "starting"],
  ["interrupted", "stopped"],
  ["errored", "error"],
  ["completed", "done"],
  ["shutdown", "closed"],
  ["notFound", "gone"],
];
const LIVE_WORKER_STATES = new Set(["running", "pendingInit"]);

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(raw: unknown, max: number): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  // clipText, never a bare slice: a cut through a surrogate pair puts a lone
  // surrogate into JSONB and the backend refuses the whole row.
  return clipText(text, max);
}

/**
 * What the mapper knows about the notification an item arrived on, beyond the
 * item itself. Every field is optional: an older Codex, a replayed item or a
 * test that hands in a bare item still maps.
 */
export interface ItemContext {
  /** The thread's last known working directory, for shortening paths. */
  cwd?: string;
  /** The owner's home directory. Defaults to this machine's. */
  home?: string;
  /** `ItemStartedNotification.startedAtMs` for this item id. */
  startedAtMs?: number;
  /** `ItemCompletedNotification.completedAtMs` for this item id. */
  completedAtMs?: number;
}

/** Leading `/`, a UNC `\\server`, or a `C:` drive. */
function isAbsolutePath(text: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(text);
}

/** The path split on either separator, empty segments dropped. */
function segmentsOf(text: string): string[] {
  return text.split(/[\\/]+/).filter(Boolean);
}

/**
 * `text` with `prefix` removed when it sits under it, else null. Compared
 * segment by segment, so `/a/bc` is not "under" `/a/b`, and on a Windows
 * shaped path case insensitively, because a drive letter arrives in either
 * case. A wrong match there costs a prettier string, never a wrong file.
 */
function under(
  text: string,
  prefix: string | undefined,
  sep: string,
): string | null {
  if (!prefix) return null;
  const head = segmentsOf(prefix);
  const full = segmentsOf(text);
  if (head.length === 0 || head.length > full.length) return null;
  const windows = sep === "\\" || /^[a-zA-Z]:/.test(text);
  for (let i = 0; i < head.length; i += 1) {
    const a = full[i]!;
    const b = head[i]!;
    if (a !== b && !(windows && a.toLowerCase() === b.toLowerCase()))
      return null;
  }
  return full.slice(head.length).join(sep);
}

/**
 * The owner reads a chat, not a filesystem. An absolute path is a long,
 * identifying string (it carries the account name on every desktop), so it is
 * shortened BEFORE it reaches the wire, in this order:
 *
 *  1. relative to the thread's own working directory when it sits inside it,
 *  2. else a home directory prefix becomes `~`,
 *  3. else the basename with one parent segment, so the row still says where.
 *
 * A path that is already relative is left alone (it is already short and
 * already relative to the same cwd), and the 200 char clip is applied last.
 */
export function shortenPath(raw: unknown, ctx: ItemContext = {}): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  if (!isAbsolutePath(text)) return clipText(text, PATH_MAX);
  const sep = text.includes("\\") ? "\\" : "/";

  const inCwd = under(text, ctx.cwd, sep);
  if (inCwd) return clipText(inCwd, PATH_MAX);

  const home = ctx.home ?? defaultHome();
  const inHome = under(text, home, sep);
  if (inHome !== null) return clipText(inHome ? `~${sep}${inHome}` : "~", PATH_MAX);

  const tail = segmentsOf(text).slice(-2).join(sep);
  return clipText(tail || text, PATH_MAX);
}

/**
 * The machine's home directory. `homedir()` is a process query rather than
 * I/O, and every test that cares passes `home` in explicitly.
 */
function defaultHome(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "";
  }
}

/** The word behind a change kind, in either protocol shape. */
export function changeKindWord(kind: unknown): string {
  if (typeof kind === "string") return clip(kind, DETAIL_MAX);
  if (isRecord(kind)) return clip(kind.type, DETAIL_MAX);
  return "";
}

function failed(item: Rec): boolean {
  return (
    item.status === "failed" ||
    item.status === "declined" ||
    item.status === "interrupted" ||
    item.success === false ||
    Boolean(item.error) ||
    (typeof item.exitCode === "number" && item.exitCode !== 0)
  );
}

function toolStatus(item: Rec, phase: ItemPhase): ActivityCard["status"] {
  if (phase === "started") return "running";
  if (failed(item)) return "error";
  if (item.status === "inProgress") return "running";
  return "done";
}

/**
 * A row's duration, from the item when it reports one (`commandExecution`
 * does) and otherwise from the notification envelope, which carries
 * `startedAtMs` on `item/started` and `completedAtMs` on `item/completed` for
 * EVERY item type. A zero span is dropped rather than drawn: it is an item
 * that opened and closed in the same millisecond, and "0s" on a row says
 * nothing the row does not already say.
 */
function withDuration(
  card: ActivityCard,
  item: Rec,
  ctx?: ItemContext,
): ActivityCard {
  const ms = item.durationMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
    card.durationMs = Math.round(ms);
    return card;
  }
  const span = envelopeSpan(ctx);
  if (span !== null) card.durationMs = span;
  return card;
}

function envelopeSpan(ctx?: ItemContext): number | null {
  const started = ctx?.startedAtMs;
  const completed = ctx?.completedAtMs;
  if (typeof started !== "number" || typeof completed !== "number") return null;
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  const span = Math.round(completed - started);
  return span > 0 ? span : null;
}

/**
 * How many lines a unified diff puts in and takes out.
 *
 * The protocol carries no counts at all: `FileUpdateChange` is
 * `{ path, kind, diff }` and the item itself is `{ id, changes, status }`, so
 * the plugin counts or nobody does. The rule is defensive about the file
 * headers, because the binary writes a standard unified diff and a naive
 * count would be off by one per file in each direction when it does, and the
 * skip is POSITIONAL and not a prefix test:
 *
 *  - a `+++` or `---` line BEFORE the first `@@` is a file header and is
 *    skipped. After the first `@@` every `+` and `-` line is content: a diff
 *    prepends ONE character to a source line, so a dropped SQL comment
 *    arrives as `--- comment` and a `++i;` as `+++i;`, and skipping those
 *    undercounts ordinary source files
 *  - added when a line starts with `+`, removed when it starts with `-`
 *  - a line starting with `@@` or with a backslash (the "No newline at end of
 *    file" note) is skipped and is never either
 *
 * One change carries ONE file's diff, which is why the first `@@` is enough
 * to say the headers are behind us.
 *
 * Only the two integers ever leave the machine. The diff body does not.
 */
export function countDiffLines(diff: unknown): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  if (typeof diff !== "string" || diff.length === 0) return { added, removed };
  let inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/** The counts across EVERY change, not only the one the row names in `path`. */
function changeLineCounts(changes: unknown): { added: number; removed: number } {
  const list = Array.isArray(changes) ? (changes as Rec[]) : [];
  let added = 0;
  let removed = 0;
  for (const change of list) {
    if (!isRecord(change)) continue;
    const counts = countDiffLines(change.diff);
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed };
}

/**
 * The exit code, or null when the wire cannot carry the one the item reports.
 *
 * The platform accepts an integer from minus one (killed by a signal with no
 * code of its own) to 255, and refuses the whole PATCH for anything else, so
 * a Windows style 32 bit status costs the row its chip and never the card.
 * `typeof`, never a falsy check: zero is the commonest code there is.
 */
function exitCodeOf(item: Rec): number | null {
  const code = item.exitCode;
  if (typeof code !== "number" || !Number.isFinite(code)) return null;
  if (!Number.isInteger(code)) return null;
  if (code < -1 || code > 255) return null;
  return code;
}

/**
 * The first real path of a change list, plus how many of the changes actually
 * NAME a path. A change without one is still a change, but it is not a file
 * the count can honestly claim, and `+N` beside a filename reads as N more
 * files.
 */
function pathsOf(
  item: Rec,
  ctx?: ItemContext,
): { path: string; count: number; word: string } {
  const changes = Array.isArray(item.changes) ? (item.changes as Rec[]) : [];
  const withPath = changes.filter(
    (c) => isRecord(c) && typeof c.path === "string" && c.path.length > 0,
  );
  const first = withPath[0];
  return {
    path: first ? shortenPath(first.path, ctx) : "",
    count: withPath.length,
    word: first ? changeKindWord(first.kind) : "",
  };
}

/**
 * An edit row. `countLines` is true only for a COMPLETED item whose change
 * LANDED, and both halves of that matter. A live patch update carries the
 * same `changes[]` and the same diffs, and a number that ticks up mid flight
 * and then changes is a number the owner learns to distrust; a declined,
 * failed or interrupted item carries the diffs it proposed, and counting
 * those tells the owner an edit happened that they refused. The folded head
 * sums the counted rows, so a count here becomes "1 file changed +38 -6" on
 * a card whose row is red.
 *
 * A count past what the wire accepts costs BOTH counts (see `LINE_COUNT_MAX`).
 */
function editCard(
  item: Rec,
  status: ActivityCard["status"],
  ctx: ItemContext | undefined,
  countLines: boolean,
): ActivityCard {
  const { path, count, word } = pathsOf(item, ctx);
  const card: ActivityCard = {
    icon: TOOL_ICON.fileChange!,
    name: "edit",
    status,
    kind: "tool",
  };
  if (path) {
    const extra = count > 1 ? ` +${count - 1}` : "";
    card.args = clip(path, ARGS_MAX - extra.length) + extra;
    card.path = path;
    // Only when there is more than one. `pathCount: 1` says nothing the single
    // path does not already say, and the app draws "+N files" from it.
    if (count > 1) card.pathCount = count;
  }
  if (word) card.detail = word;
  if (countLines) {
    const { added, removed } = changeLineCounts(item.changes);
    // Each count only where it was measured. A pair of zeroes reads as a
    // measured result rather than an unmeasured one, so neither is sent. A
    // count the wire refuses costs both, so the pair the card draws is never
    // half a measurement.
    if (lineCountForWire(added) !== null && lineCountForWire(removed) !== null) {
      if (added > 0) card.linesAdded = added;
      if (removed > 0) card.linesRemoved = removed;
    }
  }
  return card;
}

/**
 * The one word the owner reads for one worker state, or "" for a state this
 * plugin has never heard of.
 *
 * One table, read twice: the folded header counts these words and a child's
 * own row falls back to its word when the runtime gave it no message. Two
 * tables would drift the first time a status was added to the protocol, and
 * the card would then say "1 starting" in its header above a row that said
 * something else.
 */
export function workerWord(status: unknown): string {
  const wanted = String(status ?? "");
  for (const [state, word] of WORKER_WORDS) if (state === wanted) return word;
  return "";
}

/** Human summary of the live worker states, worst first ("1 running, 1 done"). */
export function summarizeWorkerStates(states: unknown): string {
  if (!isRecord(states)) return "";
  const counts = new Map<string, number>();
  for (const value of Object.values(states)) {
    const status = isRecord(value) ? String(value.status ?? "") : "";
    if (!status) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [status] of WORKER_WORDS) {
    const n = counts.get(status);
    if (n) parts.push(`${n} ${workerWord(status)}`);
  }
  return clip(parts.join(", "), DETAIL_MAX);
}

function liveWorkers(states: unknown): number {
  if (!isRecord(states)) return 0;
  let live = 0;
  for (const value of Object.values(states)) {
    const status = isRecord(value) ? String(value.status ?? "") : "";
    if (LIVE_WORKER_STATES.has(status)) live += 1;
  }
  return live;
}

/** A child agent's own state, as the row's three words read it. */
const CHILD_STATUS: Record<string, ActivityCard["status"]> = {
  pendingInit: "running",
  running: "running",
  completed: "done",
  interrupted: "error",
  errored: "error",
  shutdown: "error",
  notFound: "error",
};

/**
 * This notification's own receipt, in epoch milliseconds, or null.
 *
 * `item/started` carries `startedAtMs` and `item/completed` carries
 * `completedAtMs`, and the host remembers the first so a completion arrives
 * holding both. The receipt of THIS notification is therefore the completion
 * stamp on a completion and the start stamp otherwise. Never `Date.now()`:
 * a child's elapsed must be measured against what the runtime reported, not
 * against whenever this process got round to mapping the item.
 */
function receiptMs(ctx: ItemContext | undefined, phase: ItemPhase): number | null {
  const raw =
    phase === "completed"
      ? (ctx?.completedAtMs ?? ctx?.startedAtMs)
      : ctx?.startedAtMs;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
}

/** The first line of a multi line string, clipped. Empty for nothing. */
function firstLine(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return clip(raw.split(/\r?\n/, 1)[0] ?? "", max);
}

/**
 * One row per CHILD AGENT named by a `collabAgentToolCall`.
 *
 * `entryFromItem` keeps its single row contract and keeps drawing the collab
 * call itself; this draws the children underneath it, because a function that
 * sometimes returns one row and sometimes seven is a function every one of
 * its thirty callers and tests has to re read.
 *
 * Four rules, and each one is a defect that passes a shallow reading:
 *
 *  1. The row is keyed on the CHILD's THREAD id, which is what the
 *     `subAgentActivity` branch keys on too, so the two sources merge into
 *     one row per child. The collab item's own id is not the key: the spawn
 *     call, the wait call and the close call are three items about one child.
 *  2. The status is the CHILD's, from its entry in `agentsStates`, and
 *     never the item's own, which is the status of the spawn CALL and
 *     completes in milliseconds while the child runs for minutes.
 *  3. The start is this plugin's first sight of that child, kept in the
 *     caller's map keyed on the child thread, so a later item about the same
 *     child does not reset it and the elapsed never jumps backwards.
 *  4. The message is masked over the WHOLE string before any cut, once,
 *     and the cut keeps the FIRST 240 characters: a child answers at the
 *     start of its last message, so a tail would show an end with no
 *     beginning. Masking after a cut hands the rules half a token.
 *
 * `names` is the child's readable name (its nickname, else its role) as the
 * host read it off the child's own thread; there is no name anywhere on the
 * parent's item. A child nobody has named yet says `helper` and no more.
 * Because the card merges a row by writing the new row over the old one, a
 * host that wants an earlier name to survive must keep that name in this map.
 *
 * A child row carries no `output`, no path and no counts: it is not a command
 * row, and the app draws it with no chevron and nothing to open.
 */
export function childRowsFromCollabItem(
  item: Rec,
  phase: ItemPhase,
  ctx?: ItemContext,
  names?: ReadonlyMap<string, string>,
  firstSeen?: Map<string, number>,
): ActivityRow[] {
  if (!isRecord(item)) return [];
  if (String(item.type ?? "") !== "collabAgentToolCall") return [];
  const states = item.agentsStates;
  if (!isRecord(states)) return [];

  const receipt = receiptMs(ctx, phase);
  const args = firstLine(item.prompt, ARGS_MAX);
  const rows: ActivityRow[] = [];

  for (const [child, value] of Object.entries(states)) {
    if (!child || !isRecord(value)) continue;
    const state = String(value.status ?? "");
    // A status this plugin has never heard of reads as running: the entry
    // exists, so the child exists, and nothing in it says the child ended.
    const status = CHILD_STATUS[state] ?? "running";

    if (receipt !== null && firstSeen && !firstSeen.has(child))
      firstSeen.set(child, receipt);
    const began = firstSeen?.get(child) ?? null;

    const card: ActivityCard = {
      icon: SUBAGENT_ICON,
      name: clip(names?.get(child), NAME_MAX) || "helper",
      status,
      kind: "subagent",
    };
    // Only when it is the SAME string the row is keyed by: an id the wire
    // would refuse is no identity at all, and a clipped one could collide.
    if (child.length <= ID_MAX) card.id = child;
    if (args) card.args = args;
    const startedAt = began === null ? null : isoInstant(began);
    if (startedAt !== null && startedAt.length <= START_MAX)
      card.startedAt = startedAt;

    // ONE mask, over the whole message, before either cut. Both cuts read the
    // same masked string, so there is no second masking path to forget.
    const masked =
      typeof value.message === "string" && value.message.length > 0
        ? redactOutput(value.message)
        : "";
    if (status === "running") {
      // The honest qualifier this protocol can give: the child's own status
      // line, and its state word when it gave no line at all.
      const qualifier = clip(masked, DETAIL_MAX) || workerWord(state);
      if (qualifier) card.detail = qualifier;
    } else {
      const result = clip(masked, RESULT_MAX);
      if (result) card.result = result;
      if (began !== null && receipt !== null) {
        const span = Math.round(receipt - began);
        if (span > 0) card.durationMs = span;
      }
    }

    rows.push({ card, itemId: child });
  }
  return rows;
}

/**
 * One app server ThreadItem to one card, or null when the item is not work
 * the owner should see (reasoning, plain messages, anything unknown).
 *
 * `phase` is the notification the item arrived on: `item/started` opens a row
 * running, `item/completed` closes it from the item's own status. `ctx` is
 * what the envelope around that notification carried: the thread's working
 * directory (so a path is shortened against it) and the two timestamps (so
 * any row, not only a shell row, can carry a duration).
 */
export function entryFromItem(
  item: Rec,
  phase: ItemPhase,
  ctx?: ItemContext,
): ActivityRow | null {
  if (!isRecord(item)) return null;
  const type = String(item.type ?? "");
  const id = typeof item.id === "string" ? item.id : "";
  const status = toolStatus(item, phase);

  if (type === "subAgentActivity") {
    const worker =
      typeof item.agentThreadId === "string" && item.agentThreadId.length > 0
        ? item.agentThreadId
        : id;
    if (!worker) return null;
    const name = clip(String(item.agentPath ?? "").split(/[\\/]/).pop(), NAME_MAX);
    const kind = String(item.kind ?? "");
    const card: ActivityCard = {
      icon: SUBAGENT_ICON,
      name: name || "subagent",
      status:
        kind === "interrupted"
          ? "error"
          : kind === "completed"
            ? "done"
            : "running",
      kind: "subagent",
    };
    if (kind) card.detail = clip(kind, DETAIL_MAX);
    // Keyed on the worker's own thread, not the item id, so started,
    // interacted and completed collapse into ONE row per worker.
    return { card: withDuration(card, item, ctx), itemId: worker };
  }

  if (!id) return null;

  // The delegate call is a TOOL the agent called, and never a helper. The
  // children have their own rows now, keyed on their own threads, and the
  // app builds the helpers block out of every row whose kind is subagent:
  // sent as a helper, this row was counted as one, so a turn with a single
  // child read "2 helpers", and because the spawn CALL settles in
  // milliseconds while its child works for minutes, it read "2 helpers,
  // 1 done" over one running child. A spawn, a wait and a close about the
  // same child are three items, which read "4 helpers, 3 done".
  if (type === "collabAgentToolCall") {
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.length
      : 0;
    const card: ActivityCard = {
      icon: SUBAGENT_ICON,
      name: clip(item.tool, NAME_MAX) || "delegate",
      status,
    };
    // What was delegated, in the words the agent used. The worker count is
    // the fallback, because a wait and a close carry no prompt.
    const args =
      firstLine(item.prompt, ARGS_MAX) ||
      (receivers > 0
        ? `${receivers} ${receivers === 1 ? "worker" : "workers"}`
        : "");
    if (args) card.args = args;
    const summary = summarizeWorkerStates(item.agentsStates);
    if (summary) card.detail = summary;
    return { card: withDuration(card, item, ctx), itemId: id };
  }

  if (type === "fileChange")
    return {
      card: withDuration(
        // Completed, AND it landed: a declined or failed patch carries the
        // diffs it proposed and none of them reached a file.
        editCard(item, status, ctx, phase === "completed" && !failed(item)),
        item,
        ctx,
      ),
      itemId: id,
    };

  if (type === "commandExecution") {
    const card: ActivityCard = {
      icon: TOOL_ICON.commandExecution!,
      name: "shell",
      status,
      kind: "tool",
      ...argsField(clip(item.command, ARGS_MAX)),
    };
    if (phase === "completed") {
      // `aggregatedOutput`, the app server v2 name. The snake case
      // `aggregated_output` is the old SDK dialect and reading it produces a
      // card with no output, forever, with no error. NOT through `clip()`:
      // that helper collapses every newline into a space, which turns a
      // stack trace into one long line.
      const output = buildOutputTail(item.aggregatedOutput);
      if (output.length > 0) card.output = output;
      const code = exitCodeOf(item);
      if (code !== null) card.exitCode = code;
    }
    return { card: withDuration(card, item, ctx), itemId: id };
  }

  if (type === "webSearch")
    return {
      card: withDuration(
        {
          icon: TOOL_ICON.webSearch!,
          name: "web_search",
          status,
          kind: "tool",
          ...argsField(clip(item.query, ARGS_MAX)),
        },
        item,
        ctx,
      ),
      itemId: id,
    };

  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const tool = clip(item.tool, NAME_MAX);
    const server = clip(item.server, NAME_MAX);
    const args =
      type === "mcpToolCall" && server && tool
        ? `${server}.${tool}`
        : clip(safeJson(item.arguments), ARGS_MAX);
    return {
      card: withDuration(
        {
          icon: TOOL_ICON[type]!,
          name: tool || (type === "mcpToolCall" ? "mcp" : "tool"),
          status,
          kind: "tool",
          ...argsField(args),
        },
        item,
        ctx,
      ),
      itemId: id,
    };
  }

  if (type === "imageGeneration" || type === "imageView") {
    const path = shortenPath(item.path, ctx);
    const card: ActivityCard = {
      icon: TOOL_ICON[type]!,
      name: type === "imageView" ? "view_image" : "image_generation",
      status,
      kind: "tool",
    };
    if (path) {
      card.args = clip(path, ARGS_MAX);
      card.path = path;
      // One path, so no count: `pathCount` exists to say "+N more files".
    }
    return { card: withDuration(card, item, ctx), itemId: id };
  }

  return null;
}

function argsField(args: string): { args?: string } {
  return args ? { args } : {};
}

/** A row as the card already holds it: what a refinement may not overwrite. */
export interface KnownRow {
  name: string;
  icon: string;
  /** The row's current state. A settled row is never re opened. */
  status?: ActivityCard["status"];
}

/**
 * The two notifications that refine a row already on the card: a live patch
 * body and an mcp server's progress line. `known` is the row's identity as
 * the card already has it, because the merge overwrites name and icon; with
 * no identity the mcp update is dropped rather than drawn as a phantom row.
 *
 * BOTH refinements say `running`, because that is what they mean while the
 * item is live. A late one arriving AFTER the item completed (an mcp server
 * that emits one last progress line, a patch update that crosses
 * `item/completed` on the wire) would re open a settled row as running, and
 * nothing would ever close it again: the item's completion has already been
 * spent. So a row the card has already settled is left exactly as it is.
 */
export function rowFromProgressNotification(
  method: string,
  params: Rec,
  known?: KnownRow,
  ctx?: ItemContext,
): ActivityRow | null {
  const itemId = typeof params?.itemId === "string" ? params.itemId : "";
  if (!itemId) return null;
  if (known && known.status && known.status !== "running") return null;

  // No line counts on a live patch update: they come from the completed item.
  if (method === "item/fileChange/patchUpdated")
    return { card: editCard(params, "running", ctx, false), itemId };

  if (method === "item/mcpToolCall/progress") {
    if (!known) return null;
    const message = clip(params.message, DETAIL_MAX);
    const card: ActivityCard = {
      icon: known.icon,
      name: known.name,
      status: "running",
      kind: "tool",
    };
    if (message) card.detail = message;
    return { card, itemId };
  }

  return null;
}

function contextCompactedMarker(): ActivityMarker {
  return {
    kind: "context_compacted",
    payload: {},
    title: "Context compacted",
    text: "Context compacted: older conversation was summarized to make room.",
  };
}

/**
 * A compaction marker from either source: the `contextCompaction` item (the
 * current signal) or the deprecated but still stable `thread/compacted`
 * notification. Both carry the turn, so one dedupe key covers both and the
 * owner sees one line however many announcements arrive.
 */
export function markerFromNotification(
  method: string,
  params: Rec,
): MarkerSignal | null {
  if (!isRecord(params)) return null;
  const isCompaction =
    method === "thread/compacted" ||
    ((method === "item/started" || method === "item/completed") &&
      isRecord(params.item) &&
      params.item.type === "contextCompaction");
  if (!isCompaction) return null;
  const threadId = String(params.threadId ?? "");
  const turnId = String(params.turnId ?? "");
  return {
    marker: contextCompactedMarker(),
    dedupeKey: `context_compacted:${threadId}:${turnId}`,
  };
}

/**
 * The only honest "the reply is in but work carries on" signal Codex has: a
 * delegated worker that is still running (or still starting) when the turn
 * completes. There is no `turn/backgrounded` notification and none is
 * invented here.
 */
export function turnContinuesAtEnd(states: unknown): ActivityMarker | null {
  const live = liveWorkers(states);
  if (live <= 0) return null;
  const what =
    live === 1
      ? "1 subagent is still working"
      : `${live} subagents are still working`;
  return {
    kind: "turn_continues",
    payload: { what: clip(what, WHAT_MAX) },
    title: "Work continues",
    text: `Work continues: ${what}.`,
  };
}

/**
 * The outbound body for a marker: an ordinary `event` message through the
 * plugin's existing renderable builder, so an app that does not know the kind
 * still shows a titled card. No new MessageType, and `classifyAssistantReply`
 * moves no status for an event, which is exactly right for a marker.
 */
export function markerEventBody(
  marker: ActivityMarker,
  target: { assistantId: number; chatId: number },
): OutboundMessagePayload | null {
  const built = buildComponentEventMessage({
    kind: marker.kind,
    payload: marker.payload,
    chatId: target.chatId,
    assistantId: target.assistantId,
    description: marker.title,
  });
  if (!built.ok) return null;
  return { ...built.body, text: marker.text };
}
