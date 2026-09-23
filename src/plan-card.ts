/**
 * The plan card: what a proposed plan looks like on the BGOS wire, and how a
 * Codex plan becomes one.
 *
 * A plan is NOT a new message type. It is a `messageType: "event"` row whose
 * `eventMeta.payload.kind` is the renderable kind `plan_card`, carrying the
 * three chips as ordinary inline options. A client that does not know the kind
 * still draws the quiet event row with the chips under it, so the card is the
 * premium path and the chips are the contract (spec section 4).
 *
 * Everything here is pure. The adapter owns the posting, the retiring and the
 * status line; this file owns the shapes, the caps and the markdown reading,
 * because those are the parts a test can hold still.
 *
 * WHERE THE PLAN COMES FROM ON CODEX, settled by a live probe on 2026-09-23
 * (docs/learnings/codex-plan-mode-wire.md, `_tools-p2/probes/codex-plan-probe.js`):
 * the app server parses the model's `<proposed_plan>` block out of the message
 * and re-emits it as its own item, `item/completed` with `item.type === "plan"`
 * and the whole plan markdown in `item.text`. It REMOVES the block from the
 * agent message, so a daemon that only reads the last message gets the sentence
 * before the plan and never the plan. `parseProposedPlan` below is the narrow
 * fallback for a runtime that does not strip it, never a general "treat the
 * final message as a plan": phases 1 and 2 of plan mode are ordinary chat.
 */
import type { MessageOption, OutboundMessagePayload } from "./types.js";

export const PLAN_CARD_KIND = "plan_card";
export const PLAN_CARD_VERSION = 1;

/** How this plan reached the owner. */
export type PlanDoor = "typed" | "decided" | "mode";
export type PlanStepTag = "unchanged" | "changed" | "dropped";
export type PlanCardState = "proposed" | "superseded";

/**
 * Caps from spec section 4 and the renderables manifest. Clipped here, never
 * refused for length.
 *
 * `check` and `stepCheck` ARE TWO DIFFERENT CAPS and the manifest is where
 * that is decided: the card's own check line is 300, a per STEP check is 200,
 * the same 200 every other string on a step gets. This file clipped a step's
 * check at 300 for both, which is not a crash and not visible on screen; it
 * is a payload the served schema (GET /api/v1/renderables) says is invalid,
 * so the one reader that does validate would refuse a card no test here
 * would have rejected.
 */
export const PLAN_CAPS = {
  title: 120,
  summary: 500,
  steps: 30,
  stepText: 200,
  files: 30,
  filePath: 200,
  check: 300,
  stepCheck: 200,
  note: 300,
} as const;

export interface PlanStepInput {
  text: string;
  file?: string;
  check?: string;
  tag?: PlanStepTag;
}
export interface PlanCardInput {
  title: string;
  summary?: string;
  steps: PlanStepInput[];
  files?: string[];
  check?: string;
  door: PlanDoor;
  /** True only where something other than the agent's goodwill holds the wait. */
  enforced: boolean;
  planId: string;
  revision: number;
  supersedes?: number;
  note?: string;
  state?: PlanCardState;
}

export interface PlanCardStep {
  text: string;
  file?: string;
  check?: string;
  tag?: PlanStepTag;
}
export interface PlanCardPayload extends Record<string, unknown> {
  kind: typeof PLAN_CARD_KIND;
  v: number;
  title: string;
  summary?: string;
  steps: PlanCardStep[];
  files?: string[];
  check?: string;
  door: PlanDoor;
  enforced: boolean;
  plan_id: string;
  revision: number;
  supersedes?: number;
  state?: PlanCardState;
  note?: string;
}

/**
 * The three chip CODES. The app relabels a chip by its code exactly as it
 * relabels an `ea:` code, so the words below are a fallback for a client that
 * does not, and Arabic is the app's job and never the daemon's.
 */
/**
 * WHERE `enforced` COMES FROM, NOW THAT IT IS NOT A CONSTANT HERE.
 *
 * This file used to export `CODEX_PLAN_MODE_ENFORCED = false`, because the
 * live probe of 2026-09-23 ran a workspace write while
 * `collaborationMode: { mode: "plan" }` was set on both the thread and the
 * turn: the command executed, exit code 0, the file changed, and no approval
 * was raised. Plan mode fills `developer_instructions` with a strict 9 KB
 * "Plan Mode (Conversational)" prompt and leaves `sandboxPolicy` and
 * `approvalPolicy` exactly as they were.
 *
 * `/plan` now turns the chat's read only sandbox on WITH the mode, and that
 * sandbox is refused by the runtime, so the answer became per chat rather than
 * per channel: true for a chat holding the pair, false for a chat where the
 * model decided to propose a plan inside an ordinary coding session, and false
 * again if the runtime would not take the setting. It lives in
 * `src/plan-mode.ts` (`planWaitEnforced`), is read through
 * `CodexHost.planWaitEnforcedIn` and reaches a card through
 * `PlanLane.enforcedIn`. See docs/learnings/codex-plan-mode-wire.md for both
 * probe runs.
 */

/**
 * What the wire carries when the owner answers through the ARMED composer.
 *
 * "Change the plan" and a step's "Comment" do not post their option: the app
 * arms the composer and Send posts the custom sentinel with the typed words,
 * which the backend stamps as this code whatever the option's own
 * `callbackData` said. So `plan:change` is a code the daemon SENDS and never a
 * code it receives, and the plan path has to recognise this one too.
 */
export const PLAN_CUSTOM_SENTINEL = "__custom__";

export const PLAN_CHIP_GO = "plan:go";
export const PLAN_CHIP_CHANGE = "plan:change";
export const PLAN_CHIP_NO = "plan:no";

export type PlanAnswer = "go" | "change" | "no";

/** The chip a callback code names, or null when it is not a plan chip. */
export function parsePlanChip(callbackData: string | undefined): PlanAnswer | null {
  const code = (callbackData ?? "").trim();
  if (code === PLAN_CHIP_GO) return "go";
  if (code === PLAN_CHIP_CHANGE) return "change";
  if (code === PLAN_CHIP_NO) return "no";
  return null;
}

export function planCardOptions(): MessageOption[] {
  return [
    { text: "Go ahead", callbackData: PLAN_CHIP_GO, style: "success" },
    { text: "Change the plan", callbackData: PLAN_CHIP_CHANGE, style: "default" },
    { text: "Don't do this", callbackData: PLAN_CHIP_NO, style: "danger" },
  ];
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

/** Validate and clip an input into the payload that rides `eventMeta`. */
export function planCardPayload(input: PlanCardInput): PlanCardPayload {
  const title = clip(input.title, PLAN_CAPS.title);
  if (!title) throw new Error("A plan needs a title.");
  const steps = (input.steps ?? [])
    .map((step) => {
      const text = clip(step.text, PLAN_CAPS.stepText);
      if (!text) return null;
      const out: PlanCardStep = { text };
      const file = clip(step.file, PLAN_CAPS.filePath);
      if (file) out.file = file;
      const check = clip(step.check, PLAN_CAPS.stepCheck);
      if (check) out.check = check;
      if (step.tag) out.tag = step.tag;
      return out;
    })
    .filter((step): step is PlanCardStep => step !== null)
    .slice(0, PLAN_CAPS.steps);
  if (!steps.length) throw new Error("A plan needs at least one step.");
  const payload: PlanCardPayload = {
    kind: PLAN_CARD_KIND,
    v: PLAN_CARD_VERSION,
    title,
    steps,
    door: input.door,
    enforced: input.enforced === true,
    plan_id: String(input.planId),
    revision: Number.isFinite(input.revision) ? Math.max(1, Math.trunc(input.revision)) : 1,
  };
  const summary = clip(input.summary, PLAN_CAPS.summary);
  if (summary) payload.summary = summary;
  const files = [
    ...new Set(
      (input.files ?? [])
        .map((file) => clip(file, PLAN_CAPS.filePath))
        .filter(Boolean),
    ),
  ].slice(0, PLAN_CAPS.files);
  if (files.length) payload.files = files;
  const check = clip(input.check, PLAN_CAPS.check);
  if (check) payload.check = check;
  const note = clip(input.note, PLAN_CAPS.note);
  if (note) payload.note = note;
  if (typeof input.supersedes === "number" && input.supersedes > 0)
    payload.supersedes = Math.trunc(input.supersedes);
  if (input.state) payload.state = input.state;
  return payload;
}

/**
 * The plain text under the card.
 *
 * It is what a client that does not know `plan_card` shows, and what a channel
 * with no renderables at all would show, so it has to read as the whole plan
 * and not as a stub. The chips sit under it either way.
 */
export function planCardText(payload: PlanCardPayload): string {
  const lines: string[] = [`**${payload.title}**`];
  if (payload.summary) lines.push("", payload.summary);
  lines.push("");
  payload.steps.forEach((step, at) => {
    const tag = step.tag ? ` _(${step.tag})_` : "";
    lines.push(`${at + 1}. ${step.text}${tag}`);
    if (step.file) lines.push(`   \`${step.file}\``);
    if (step.check) lines.push(`   Check. ${step.check}`);
  });
  if (payload.check) lines.push("", `Check. ${payload.check}`);
  if (payload.note) lines.push("", payload.note);
  lines.push("", "Nothing changes until you answer.");
  return lines.join("\n");
}

/** The whole `POST /messages` body for a plan card. */
export function buildPlanCardMessage(
  payload: PlanCardPayload,
  route: { assistantId: number; chatId: number },
): OutboundMessagePayload {
  return {
    assistantId: route.assistantId,
    chatId: route.chatId,
    sender: "assistant",
    messageType: "event",
    text: planCardText(payload),
    options: planCardOptions(),
    renderMode: "inline",
    eventMeta: {
      source: "agent",
      title: payload.revision > 1 ? "Plan · revised" : "Plan",
      peek: payload.title,
      payload,
    },
  };
}

/**
 * The PATCH that supersedes an earlier card: the chips go, the payload stays
 * so the owner keeps the steps they already read, and `state` tells the card to
 * dim itself. The app applies both live off `edited_message`.
 */
export function supersedePlanCardPatch(payload: PlanCardPayload): {
  options: MessageOption[];
  eventMeta: OutboundMessagePayload["eventMeta"];
} {
  const superseded: PlanCardPayload = { ...payload, state: "superseded" };
  return {
    options: [],
    eventMeta: {
      source: "agent",
      title: superseded.revision > 1 ? "Plan · revised" : "Plan",
      peek: superseded.title,
      payload: superseded,
    },
  };
}

const PROPOSED_OPEN = "<proposed_plan>";
const PROPOSED_CLOSE = "</proposed_plan>";

/**
 * Pull a `<proposed_plan>` block out of an agent message.
 *
 * Only the FALLBACK path uses this, for a runtime that leaves the block in the
 * message instead of re-emitting it as a `plan` item. `rest` is what should be
 * said in chat once the plan has become a card; when it is empty the daemon
 * says nothing and lets the card speak.
 */
export function parseProposedPlan(
  text: string | null | undefined,
): { plan: string; rest: string } | null {
  const body = String(text ?? "");
  const open = body.indexOf(PROPOSED_OPEN);
  if (open < 0) return null;
  const close = body.indexOf(PROPOSED_CLOSE, open + PROPOSED_OPEN.length);
  if (close < 0) return null;
  const plan = body.slice(open + PROPOSED_OPEN.length, close).trim();
  if (!plan) return null;
  const rest = (
    body.slice(0, open) + body.slice(close + PROPOSED_CLOSE.length)
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { plan, rest };
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/;
const NUMBERED = /^\s{0,6}(\d{1,2})[.)]\s+(.*\S)\s*$/;
const BULLET = /^\s{0,6}[-*+]\s+(.*\S)\s*$/;
const SUMMARY_HEADING = /^(summary|overview|goal|context|why)\b/i;
const CHECK_HEADING = /^(test plan|tests?|checks?|verification|how .*verif)/i;
const PATH_TOKEN = /`([^`\s]{3,200})`/g;
const LOOKS_LIKE_PATH = /^(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+$|^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/;

function firstPathIn(line: string): string | null {
  PATH_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_TOKEN.exec(line)) !== null)
    if (LOOKS_LIKE_PATH.test(match[1]!)) return match[1]!;
  return null;
}

/**
 * Read the runtime's plan markdown into the card's fields.
 *
 * Deliberately forgiving and deliberately dumb. The runtime's own plan mode
 * instructions ask for a title, a Summary section, grouped change bullets and a
 * Test plan section, so those are what this looks for; anything it cannot
 * recognise still becomes a step, because a plan that renders as one long step
 * is worse than a plan that renders as nothing only if it loses text, and this
 * never does.
 */
export function planFromMarkdown(markdown: string): {
  title: string;
  summary?: string;
  steps: PlanStepInput[];
  files: string[];
  check?: string;
} {
  const lines = String(markdown ?? "").split(/\r?\n/);
  let title = "";
  let section: "none" | "summary" | "check" | "other" = "none";
  const summary: string[] = [];
  const check: string[] = [];
  const steps: PlanStepInput[] = [];
  const bullets: PlanStepInput[] = [];
  const loose: string[] = [];
  const files = new Set<string>();

  const addStep = (into: PlanStepInput[], text: string): void => {
    const path = firstPathIn(text);
    let body = text;
    if (path) {
      files.add(path);
      const without = text.replace(`\`${path}\``, " ").replace(/\s+/g, " ").trim();
      // Only drop the path from the sentence when a sentence is left. A step
      // that IS a path keeps it, or the row would render empty.
      if (without.replace(/[^\w]/g, "").length >= 12) body = without;
    }
    into.push(path ? { text: body, file: path } : { text: body });
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const label = heading[1]!.trim();
      if (!title) {
        title = label;
        section = "none";
        continue;
      }
      section = SUMMARY_HEADING.test(label)
        ? "summary"
        : CHECK_HEADING.test(label)
          ? "check"
          : "other";
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      addStep(steps, numbered[2]!);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      if (section === "check") check.push(bullet[1]!);
      else addStep(bullets, bullet[1]!);
      continue;
    }
    const text = line.trim();
    for (const path of text.matchAll(PATH_TOKEN))
      if (LOOKS_LIKE_PATH.test(path[1]!)) files.add(path[1]!);
    if (section === "summary") summary.push(text);
    else if (section === "check") check.push(text);
    else if (!title) title = text.replace(/^[#\s]+/, "");
    else loose.push(text);
  }

  // Numbered steps win; bullets are the fallback; a plan with neither becomes
  // one step holding its first paragraph, so nothing is ever lost.
  let chosen = steps.length ? steps : bullets;
  const looseIsTheStep = !chosen.length && loose.length > 0;
  if (looseIsTheStep) chosen = [{ text: loose[0]! }];
  if (!chosen.length && summary.length) chosen = [{ text: summary[0]! }];
  const spare = looseIsTheStep ? loose.slice(1) : loose;
  const summaryText =
    (summary.length ? summary.join(" ") : spare.join(" ")) || undefined;
  return {
    title: title || "Plan",
    ...(summaryText ? { summary: summaryText } : {}),
    steps: chosen,
    files: [...files],
    ...(check.length ? { check: check.join(" ") } : {}),
  };
}

/**
 * A plan item's markdown to a card input.
 *
 * `plan_id` and `revision` are NOT here on purpose: a revision has to keep the
 * identity of the plan it replaces, and only the lane knows which card the chat
 * already has open.
 */
export function planCardFromMarkdown(
  markdown: string,
  rest: {
    door: PlanDoor;
    enforced: boolean;
    supersedes?: number;
    note?: string;
  },
): Omit<PlanCardInput, "planId" | "revision"> {
  const read = planFromMarkdown(markdown);
  return {
    title: read.title,
    ...(read.summary ? { summary: read.summary } : {}),
    steps: read.steps,
    ...(read.files.length ? { files: read.files } : {}),
    ...(read.check ? { check: read.check } : {}),
    ...rest,
  };
}

/** The prefix this daemon puts in front of the server's own sentence. */
export const PLAN_POLICY_PREFIX = "Plan policy:";

/** The tail that names the tool, because the server's sentence cannot. */
export const PLAN_POLICY_TOOL_TAIL =
  "Call propose_plan when it applies, and change nothing until the owner answers.";

/**
 * The owner's per agent plan level, as a sentence for the turn framing.
 *
 * IT IS A PASS THROUGH, and that is the whole correction. `planPolicy` on the
 * inbound envelope is NOT the bare enum: the backend ships the LABELLED
 * SENTENCE (backend/src/services/plan-policy.ts, buildPlanPolicyField), which
 * is the prefix "Your owner's setting for when you show a plan ..." followed
 * by the level's own words, and it OMITS the key entirely at the default
 * level. This function used to switch on `only_when_asked` / `risky_jobs` /
 * `always`, three values the wire never carries, so every real envelope fell
 * through to `undefined` and the owner's level reached no Codex turn at all.
 * Nothing was red: the unit tests fed it the enum, which is the shape it was
 * written against rather than the shape it is sent.
 *
 * So the server's words are used as sent, with the tool named after them
 * because the canon's sentence is framework neutral and cannot say
 * `propose_plan`. The three bare enum values are still mapped, as a courtesy
 * to any caller that has one in hand; they are not what the wire delivers.
 *
 * The daemon never reads the assistant row: the server decides, the daemon
 * repeats. An EMPTY value is omitted rather than guessed.
 */
export function planPolicySentence(policy: string | undefined): string | undefined {
  const value = (policy ?? "").trim();
  if (value === "") return undefined;
  switch (value) {
    case "only_when_asked":
      return `${PLAN_POLICY_PREFIX} only when the owner asks. Do not propose a plan unless they type /plan.`;
    case "risky_jobs":
      return `${PLAN_POLICY_PREFIX} bigger or risky jobs. Call propose_plan before you start when the job touches several files or would be hard to undo, and change nothing until they answer.`;
    case "always":
      return `${PLAN_POLICY_PREFIX} always first. Call propose_plan and wait for Go ahead before you change a single file.`;
    default:
      return `${PLAN_POLICY_PREFIX} ${value} ${PLAN_POLICY_TOOL_TAIL}`;
  }
}
