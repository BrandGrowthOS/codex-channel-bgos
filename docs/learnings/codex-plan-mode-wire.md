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

**6. COUPLE THE READ ONLY SANDBOX AND THE WAIT IS REAL. Re-probed the same
day, with `--sandbox=readonly`.** Finding 5 is the reason lane A5b exists, and
the answer it points at had to be measured too rather than assumed. The probe
grew a `--sandbox=readonly` path that sends what `nativeSettings({ mode:
"plan", permission: "read-only" })` emits, VERBATIM, on both hops:

```
thread/start            { sandbox: "read-only", approvalPolicy: "on-request", ... }
thread/settings/update  { collaborationMode: { mode: "plan", ... },
                          approvalPolicy: "on-request",
                          sandboxPolicy: { type: "readOnly" } }
turn/start              the same spread
```

`thread/settings/updated` echoes `sandboxPolicy: { type: "readOnly",
networkAccess: false }` BESIDE the 9 KB plan prompt, so the two knobs are
genuinely independent and genuinely both on. The stub then called
`exec_command` with the same `echo touched > must-not-change.txt`, and this
time:

```
commandOutputs[0] = { status: "failed", exitCode: 1,
  output: "out-file : Access to the path '...\must-not-change.txt' is denied." }
guardFileContent  = "original"     guardFileChanged = false
sawPlanItem       = true           lastAgentMessage = "I explored the uploader. Here is the plan.\n\n"
```

Two things worth having in writing. **The sandbox DENIES, it does not
escalate.** `approvalPolicy: "on-request"` was live and `requestMethods` is
still empty: a write under `readOnly` comes back as a failed command with an
OS level access error, never as a `requestApproval` the owner could wave
through. So "the agent asks you instead" is not what happens, and copy that
promises it would be wrong. **Planning still works under the lock**: the `plan`
item arrived exactly as in the unlocked run, so nothing about the read only
sandbox interferes with the thing plan mode is for.

Logs: `plan5-readonly.log` (coupled, the write denied) and `plan6-control.log`
(the same app server, mode alone, the write succeeds with exit code 0). The
control was re-run because the vendored binary had been reinstalled between
the two sessions; `wire_api = "chat"` is no longer accepted by app server
0.154.0 (`failed to load configuration: wire_api = "chat" is no longer
supported`), so both runs now pass `--wire=responses`.

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
- Move them TOGETHER, and remember what you took. `/plan` sets `mode: "plan"`
  and `permission: "read-only"` and stores the chat's previous permission in
  `permissionBeforePlan`; `/code`, Go ahead and Don't do this restore it;
  Change the plan keeps both, because the revision is explored under the same
  lock. Restoring a hardcoded `workspace` instead would silently WIDEN a chat
  the owner had narrowed by hand, and the memory is on disk because a daemon
  that restarts mid plan otherwise has no way back: the only permission it can
  see is the one plan mode itself wrote.
- Report `enforced` from what was SAVED, never from the intent.
  `updateSettings` rolls the whole patch back and throws if the runtime refuses
  it, so `setPlanMode` retries as the mode alone and comes back with
  `enforced: false`. A plan mode with no lock is fine; claiming a lock it does
  not have is not, because the app words the chip off that bit.
- The two knobs can come apart BY HAND, so watch every door that moves one of
  them. `/permissions` inside plan mode changes the sandbox and leaves the mode
  alone, so nothing on the mode path reports it and the chip goes on reading
  `read only until you answer` over a chat whose files have just been handed
  back. It reports separately (`onPlanEnforcement`), and deliberately NOT
  through the mode callback, which would clear the typed door a `/plan <task>`
  left behind. The same command also spends the remembered permission, because
  a level the owner chose by hand must outlive the restore.
- Re-run the CONTROL when you re-run the probe. The vendored binary moves under
  you, and a coupled run that refuses a write proves nothing without a same
  day run on the same binary that allows one.

**Regression guard:** `test/plan-card.spec.ts` pins the capture on an
`item/completed` `plan` item and pins the `<proposed_plan>` fallback (including
that a plan mode message WITHOUT the block yields no card);
`test/codex-host.spec.ts` keeps `propose_plan` out of `OWNER_BLOCKING_TOOLS`,
which is the shape finding 5 forces (nothing blocks, so nothing parks). Finding
6 has real guards on OUR half of it: `test/plan-mode.spec.ts` pins the pair and
the remembered permission, `test/session-settings.spec.ts` drives
`setPlanMode` through the real host (the sandbox goes on with the mode, the
access comes back, the memory survives a restart, a refused sandbox leaves plan
mode on and reports `enforced: false`), and `test/plan-card-wiring.spec.ts`
pins that every card and every session mode report carries the lock the host
measured rather than a constant. Findings 1 and 5 stay prose only, because they
are facts about a vendored binary and no test of ours can hold the runtime to
them: re-run BOTH
`_tools-p2/probes/codex-plan-probe.js --mode=plan --wire=responses` and the
same command with `--sandbox=readonly` after a `@openai/codex` bump, and expect
the first to write the guard file and the second to be denied.
