/**
 * The standing lines a Codex turn carries above the owner's words.
 *
 * There are two framings in the adapter, not one: an ordinary inbound message
 * builds its own, and a NATIVE SLASH COMMAND with a task builds a shorter one.
 * They were written apart and drifted apart: the share guardrail reached both,
 * the owner's plan level reached only the first, so `/plan <task>` and
 * `/code <task>` were the turns that never heard what the plan policy is,
 * which is precisely where it matters most.
 *
 * This is the shared pure model that removes the chance to add a third line to
 * one framing and forget the other. It is a string builder and nothing else:
 * every fact comes from the inbound envelope, the daemon never reads the
 * assistant row.
 */
import { planPolicySentence } from "./plan-card.js";

export interface TurnDirectiveFacts {
  /** The share guardrail, as the server worded it. */
  senderGuardrail?: string;
  /** The owner's per agent plan level, as the server worded it. */
  planPolicy?: string;
}

/**
 * The directive block, newline terminated, or "" when there is nothing to say.
 *
 * Each line ends in its own newline so a caller can drop it straight into a
 * template; an absent or blank fact contributes nothing at all, because a
 * blank line where a directive should be reads to the model as a missing
 * instruction rather than an omitted one.
 */
export function turnDirectiveLines(facts: TurnDirectiveFacts): string {
  return [facts.senderGuardrail, planPolicySentence(facts.planPolicy)]
    .filter(
      (line): line is string =>
        typeof line === "string" && line.trim().length > 0,
    )
    .map((line) => `${line}\n`)
    .join("");
}
