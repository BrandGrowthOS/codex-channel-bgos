/**
 * The Codex capability tokens the BGOS capability canon gates on.
 *
 * A Codex daemon DECLARES a token (on its heartbeat and on the capabilities
 * fetch at connect), and the BGOS backend tells that daemon's agent the
 * matching canon sentence only when the token is declared, whatever the
 * daemon's version. So the spelling of each token is a contract between two
 * repos, and a drift on either side is silent: the agent is never told what
 * its host does for it, or is told something its host does not do.
 *
 * THIS FILE IS COPIED BYTE FOR BYTE between
 *   github.com/BrandGrowthOS/BGOS
 *     backend/src/integrations/codex-capability-tokens.ts
 *   github.com/BrandGrowthOS/codex-channel-bgos
 *     src/codex-capability-tokens.ts
 * and each repo pins the sha256 of its own copy, as a literal, in a test
 * (BGOS: backend/src/integrations/codex-capability-tokens.pin.spec.ts;
 * codex-channel-bgos: test/codex-capability-tokens.pin.spec.ts). The two
 * literals are the same digest. Changing this file means changing BOTH
 * copies and BOTH pinned digests in one pair of PRs; a change that lands in
 * one repo only turns that repo's pin red, and that is the point.
 *
 * No imports, LF line endings, and the BGOS backend's prettier style, so both
 * toolchains read the same bytes unchanged.
 *
 * request_reason: the daemon fills approval_meta.reason from the model's own
 *   exec_command justification and approval_meta.rule_text from the exec
 *   policy amendment, so its agent is told to write the justification for
 *   the owner rather than put it in the card's text.
 *
 * Why a token and not a version: codex-channel-bgos PR #16 (P5 image posts)
 * is numbered 0.14.0 on the same base as this stage and without its code,
 * and nothing can reserve a release number, so a floor of 0.13.0 would tell
 * a 0.14.0 daemon built from #16 that its host fills two fields it never
 * sends. The token ships in the same release as the code that keeps it.
 *
 * The Codex floors of P2 stages 1 to 4 (the approval wait, the plan card,
 * the file change diff) are still VERSION floors in the canon. That is lower
 * risk than this one: every Codex PR in flight sits on the one chain #12,
 * #14, #15 that carries them, so any release numbered at or above those
 * floors has their code.
 */
export const REQUEST_REASON = 'request_reason';

/** Every token this file names, in the order above. */
export const CODEX_CAPABILITY_TOKENS: readonly string[] = Object.freeze([
  REQUEST_REASON,
]);
