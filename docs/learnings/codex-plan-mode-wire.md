# Codex plan mode on the wire: the plan is an item, and the mode is not a lock

**Date:** 2026-09-23

**Context:** P2 stage 3 (the plan card, C-12 and C-13), lane A5. The stage 3
freshness pass (map part 18, sections 6 and 11) could not settle three things
from source, and priced the whole Codex arm of the spec on them: whether the app
server emits a `plan` item or an `item/plan/delta` family, whether
`turn/plan/updated` carries an `explanation` beside `plan`, and what the final
`agentMessage` holds when a plan is proposed. The repo greps zero for
`explanation`, has no `plan` item branch, and `result()` takes `texts.at(-1)`,
so a plan that did not arrive in the last agent message would be dropped on the
floor with no log line.

The probe is `_tools-p2/probes/codex-plan-probe.js`, copied from
`codex-held-ask.js` and given a `--mode=plan` path. It drives the VENDORED
`codex.exe` (`@openai/codex-win32-x64`, app server `0.154.0`) over NDJSON stdio
exactly as `src/app-server.ts` does, points the thread at a local
OpenAI-compatible stub because this box has no `codex login`, and counts every
server to client method and every `item.type` it sees. Logs: `plan2.log` (plan
mode, no proposed block), `plan3.log` (plan mode, the model emits a
`<proposed_plan>` block), `plan4.log` (the same, streamed), `code1.log` and
`code2.log` (the default mode controls).

## Gotcha / Pattern

**1. `collaborationMode` is accepted on both hops, and `developer_instructions:
null` is not a hole.** `thread/settings/update { threadId, collaborationMode: {
mode: "plan", settings: { model, reasoning_effort: null, developer_instructions:
null } } }` returns `{}` and the runtime answers with `thread/settings/updated`
carrying its OWN 9,284 character "Plan Mode (Conversational)" text in that
field. So `nativeSettings()` sending `null` means "use Codex's built in plan
prompt", and a per agent line written there REPLACES it rather than adding to
it. `turn/start` takes the same `collaborationMode` spread, which is what
`run()` already does.

**2. The plan arrives as its own item. There IS a `plan` item and there IS an
`item/plan/delta`.** The runtime's own instructions tell the model to wrap the
final plan in a `<proposed_plan>` block, and the app server parses that block
out and re-emits it as an item:

```
item/started   { item: { type: "plan", id: "<turnId>-plan", text: "" }, threadId, turnId, startedAtMs }
item/plan/delta{ threadId, turnId, itemId: "<turnId>-plan", delta: "## Add retry with ba" }   (x9 while streaming)
item/completed { item: { type: "plan", id: "<turnId>-plan", text: "<the whole plan markdown>" }, threadId, turnId, completedAtMs }
```

`item/plan/delta` only appears when the model streams (the stub had to emit
`response.output_text.delta` to provoke it); a non streaming answer goes
straight from `item/started` with an empty text to `item/completed` with the
whole body. So the ONLY capture a daemon needs is `item/completed` with
`item.type === "plan"`, and the deltas are a live typing signal we do not need.

**3. The `<proposed_plan>` block is STRIPPED from the agentMessage, so HOAI
loses the plan today.** With the block present, the final `agentMessage` text
was `"I explored the uploader. Here is the plan.\n\n"` and nothing else. The app
server removes the block from the message and moves it to the `plan` item.
`codex-host.ts` has no branch for a `plan` item, `entryFromItem` returns null
for it, and `result()` takes the last agent message: **every Codex user in plan
mode today gets the sentence before the plan and never the plan.** That is a
live bug, not a stage 3 feature, and the capture fixes it.

**4. `turn/plan/updated` is the WRONG lane for a plan card, and plan mode turns
it off.** The runtime's plan mode instructions say in as many words: "`update_plan`
is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode ... If
you try to use `update_plan` in Plan mode, it will return an error." The probe
never saw a `turn/plan/updated` in either mode, because `update_plan` was not
advertised to a stub model at all (14 tools were: `exec_command`, `write_stdin`,
the three MCP resource tools, `read_mcp_resource`, `request_user_input`,
`view_image`, `multi_agent_v1`, two repl MCP servers, the three goal tools and
`web_search`), and `include_plan_tool: true` in the thread config did not change
that. So whether `params.explanation` exists on `turn/plan/updated` is STILL
unsettled on the wire, and it no longer matters for the card: the plan card is
built from the `plan` item, and the Steps lane keeps reading
`turn/plan/updated` exactly as it does now. One practical consequence worth
knowing: the Steps strip stays EMPTY for the whole planning turn, because the
tool that fills it is refused in plan mode.

**5. Plan mode does not lock anything. It is a prompt, not a sandbox.** This is
the finding that contradicts the feasibility note. With
`collaborationMode: plan` live on the thread and on the turn, the stub called
`exec_command` with `echo touched > must-not-change.txt` inside the workspace.
It ran. Exit code 0, the file changed on disk, and NO `requestApproval` was
raised at any point. `thread/settings/updated` shows why: `sandboxPolicy` stayed
`{ type: "workspaceWrite" }` and `approvalPolicy` stayed `on-request`.
`collaborationMode` changes `developer_instructions` and nothing else. The mode
text is strict ("You must not perform mutating actions", with an allowed and a
not allowed list), and the runtime does refuse `update_plan` in it, so it is a
STRONGER convention than Claude Code's, which has no mode at all. It is still a
convention. The only real lock available to this daemon is the one it already
owns: `permission: "read-only"`, which is the only thing that makes
`nativeSettings` emit `sandboxPolicy: { type: "readOnly" }`.

## How to apply next time

- Capture a Codex plan on `item/completed` where `item.type === "plan"`, before
  `entryFromItem` (which returns null for it). Take `item.text` whole; it is
  already markdown and already the finalized plan.
- Keep a narrow fallback for a runtime that does NOT strip the block: if no plan
  item arrived and the final agent message contains `<proposed_plan>` ...
  `</proposed_plan>`, the block body is the plan. Do NOT fall back to "the whole
  final message in plan mode": phases 1 and 2 of plan mode are ordinary chat and
  would post a plan card for every question the agent asks.
- Do not build a plan card on `turn/plan/updated`. That notification is the
  `update_plan` checklist, it is disabled inside plan mode, and it is the Steps
  lane's, not the card's.
- When the copy says what a mode guarantees, check the SANDBOX, not the mode
  name. `collaborationMode` and `sandboxPolicy` are independent knobs and only
  the second one refuses anything.

**Regression guard:** `test/plan-card.spec.ts` pins the capture on an
`item/completed` `plan` item and pins the `<proposed_plan>` fallback (including
that a plan mode message WITHOUT the block yields no card);
`test/codex-host.spec.ts` keeps `propose_plan` out of `OWNER_BLOCKING_TOOLS`,
which is the shape finding 5 forces (nothing blocks, so nothing parks). Findings
1 and 5 are prose only, because they are facts about a vendored binary and no
test of ours can hold the runtime to them: re-run
`_tools-p2/probes/codex-plan-probe.js --mode=plan` after a `@openai/codex` bump
instead.
