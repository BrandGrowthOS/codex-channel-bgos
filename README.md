# HOAI for OpenAI Codex

Run Codex agents on your computer and use them from Home of Agents. Version 0.3 uses the official Codex **app-server** protocol for conversations, tools, questions and approvals. It preserves existing project `AGENTS.md` files.

## Desktop setup

In HOAI, choose **New agent → Codex**, name the agent, select **On this computer**, and choose its working folder. HOAI installs the dependencies without opening a terminal. If Node/npm is missing, it downloads a private Node LTS runtime and verifies the archive checksum. Bun and Git are not required.

Existing Codex sign-in is reused, including Keychain-backed sign-in on macOS. Otherwise, use the **Sign in to Codex** button. HOAI never asks for your OpenAI password. The installer checks the configured model with one short, read-only response, then creates a fresh pairing code, pins the connection to the selected agent, and verifies the background daemon's live heartbeat before showing Ready. This setup check uses the signed-in account's Codex allowance.

The Windows startup entry runs invisibly at user login; macOS uses a per-agent LaunchAgent. Linux uses a systemd user service. These are user services: logging out of the computer may stop them. HOAI itself can be closed while an installed agent continues running.

Use the agent's **Settings → Connection** to reconnect or repair it. Keep the same folder to retain project context. Each agent has separate settings, pairing credentials, logs and HOAI-to-Codex thread mappings under `~/.codex-bgos/agents/<assistant-id>/`. Workspaces and the user's files are retained on retry.

## Remote/manual setup

The desktop wizard is the recommended dependency-installing path. On another computer with Node 20+ and Codex sign-in already available, use the exact command shown by HOAI. It is one plain invocation, usable in PowerShell and POSIX shells:

```text
npx --yes codex-channel-bgos@0.3.0 connect BGOS-XXXX-XX --assistant-id 123
```

Replace the placeholders with the real command from your app. The agent ID pins the pairing to the agent you named. Manual `connect` runs in the foreground; closing that terminal stops this manual process. For managed background startup, use the desktop installer on that computer.

```text
codex-channel-bgos start --home /absolute/path/to/agent-home
codex-channel-bgos --help
```

Do not run two foreground daemons for the same home. Managed services use a renewable filesystem lease and an authenticated local shutdown endpoint to serialize restarts.

## Available capabilities

| Capability | Implementation |
|---|---|
| Chat and formatting | Persistent Codex thread per HOAI chat, ordinary Markdown, literal backslashes, final text delivery |
| Files | Native image input; bounded download and local paths for documents/audio/video; typed `reply` uploads for workspace files or public URLs |
| Questions and buttons | Blocking `ask_user_input`, 1–4 questions, optional free text/skip; asynchronous inline reply buttons |
| Execution approval | Native command, file-change and permission requests use HOAI approval cards; denial, timeout, cancellation and missing handlers fail closed |
| Generated images | In a chat turn, a picture Codex makes with its image generation tool posts itself as an ordinary image when the turn finishes, first in the reply (ahead of any card, question or buttons), with `Prompt: <revised prompt>` as its caption, so it also shows in the gallery. Posted from the decoded bytes, never from a file, and never mid turn (a post mid turn would mark the agent done for the rest of it), except just before a plan card the turn raises. A picture refused by the image limit posts one plain line saying the limit is used up for now and roughly when it resets ("in about 2 hours", never a clock time); one that could not be shown says so in one plain line, naming where Codex saved it when it did, and saying Codex only tried when neither the picture nor a saved copy came back. After a Stop the finished pictures still post, after the stop line, without holding anything up, and the next turn's posts and requests wait for them; a turn a goal runs by itself follows the same rules. A meeting, a voice task or a consult does not post pictures; the agent is told what to do in each |
| Tools and context | Native running/completed/failed tool cards, context usage, scoped stop, 22 session commands, context-preserving model changes |
| Boards | All 12 shared `boards_*` tools, including real permission checks and refusal responses |
| Peers and side chats | Peer discovery, sending, status, completing threads; caller identity comes from the bound event |
| Meetings | Server floor and membership checked before a turn; text/yield uses the guarded meeting reply endpoint; durable reconnect deduplication |
| Schedules | Create, list and cancel scheduled wakes/calls; owner call requests |
| Missions | Explicit mission tools and automatic native plans; derived plans cannot overwrite a self-reported mission |
| Components and trackers | Manifest-validated rich components, health event tools and tracker cards |
| Voice control | Caller-credential mint, invisible read-only consult/compose, confirmed detached tasks, per-chat stop/cancel, durable task claims |
| Stop and resume | An owner Stop (the app's Stop button or `/stop`) cancels the turn, posts "Stopped." and pauses the chat's open mission with the reason "Stopped by you" instead of failing it; the owner's next message in that chat, the app's Resume included, resumes it. `/new`, `/resume` and a Sessions resume leave the context the Stop paused, so that mission stays paused for the Mission view instead. In a Keep working chat the Stop also holds the goal before its interrupt goes out, whether the turn it stops is the owner's own or a continuation turn the runtime started on its own, and that message gives it back only if the goal was running when the Stop came; a goal held at its turn cap, stopped for lack of progress, or paused with `/goal pause`, before the Stop or between the Stop and that message, stays held, a daemon restart before that message included, and the message runs as an ordinary turn. `/new`, a daemon shutdown and a revoked pairing still end the mission. Declared as `stop_pauses_mission` |
| Sessions | The app's Sessions sheet lists this chat's own Codex conversations (the set `/resume` offers: the latest 30, searchable by title and first message), renames one through Codex's own thread name, and resumes one into the chat with `/resume`'s line. Declared as `sessions_library`; rename turns itself off on a Codex runtime without it |
| Changes panel | Answers the owner's Changes panel (`changes_rpc`, op `diff`, scope `uncommitted`) with read only Git in the working folder; declares `changes_rpc` |

Receiving an audio/video file does not imply transcription or video understanding. Codex can inspect file paths with its available tools. Meeting turn-refresh is not advertised. Codex consults return directly through the host; they do not expose Claude's cooperative `voice_consult_reply` tool. Outbound caps: images 10 MB, videos 100 MB, other files 25 MB.

A tool row carries what the step actually did. A shell row carries what the command printed, taken from the completed item as the last 2,048 characters and at most 200 lines, with known secret shapes masked on this computer before anything leaves it and a private key block removed body and all; one card carries at most 8,192 characters of output in total, spent on the newest rows first. The row also carries the exit code, kept only inside the range the platform accepts, so an unusual Windows status costs the row its code and never the card. A running row carries neither, because the protocol leaves both empty until the command ends.

An edit row carries the lines it added and the lines it removed, counted here from the completed change's own unified diff, because the protocol sends no counts. The counts come from a change that landed: a patch the owner declined, or one that failed to apply, leaves the row in its error colour with no counts at all. The row never carries the diff body itself. The card also carries the turn's own start and finish, as the runtime reported them, on the final update of the turn.

The owner's Changes panel is the one place a diff body leaves this computer, and only when the owner asks for it: the backend sends a `changes_rpc` frame only while the owner has the panel switched on for that agent, and only to a daemon that declares `changes_rpc`. The daemon runs seven read only Git commands in the working folder with `GIT_OPTIONAL_LOCKS=0` (never `git add`, never `git status`, nothing that writes the index or the files), passes `-c diff.autoRefreshIndex=false` to both diffs because a plain `git diff` rewrites the index on its own when a file's timestamp moved but its content did not, turns off any fsmonitor program the repository's own config names (`-c core.fsmonitor=false` on every command, since Git runs that program whenever it reads the index), pins the `a/` and `b/` prefixes and the short submodule format whatever the host's Git config says, reads at most 20 new text files of up to 64 KB each, and sends the raw output cut at the frame's byte caps within a 10 second budget. Lazy fetching is off on a Git that knows `GIT_NO_LAZY_FETCH`: every read runs with it set to 1, so in a partial clone a change whose old contents were never downloaded is a failed read, not a download from the promisor remote, which would run the programs the repository names for that remote. Git's own release notes first name the switch in 2.45.0 (`git --no-lazy-fetch`, the same as the variable), and Ubuntu's build of 2.43.0 honours the variable too (measured, as was Git 2.55); a Git from 2.36 that does not know the variable can still fetch lazily in a partial clone, a documented gap. It needs Git 2.36 or later, because an older Git reads `core.fsmonitor=false` as the name of a program to run: the daemon reads `git version` once for each Git it finds, and below 2.36, or when the version cannot be read, it answers "Git 2.36 or later is needed to read changes safely" and runs nothing else; a refused Git is asked again at the next read, so an update needs no restart. The repository's top level must be the working folder or a folder above it, compared with links resolved, so a `core.worktree` that names another folder is a failed read and nothing there is read; this checks the top level only, not the Git directory (see below). Git runs by the absolute path found on PATH's absolute entries, looked up on each read, never as a bare `git` that a `git.exe` left in the working folder could answer. Git's environment drops the variables that would point it at another repository or index (`GIT_DIR`, `GIT_INDEX_FILE` and six more, in any spelling on Windows, which reads environment names case blind), so a daemon started from a Git hook or with `GIT_DIR` exported still reads its own working folder; a working folder that is gone is a failed read, never "Git missing". Each new file is read through one handle, at most 64 KB and one byte, and only while it is still the regular file first checked: the open handle is checked before a single byte is read, so a name swapped for a link, another file or a device is never read. An answer is kept for a re sent frame only through the backend's 20 second wait, and at most the newest eight. A clean filter the repository names still runs, and this is an accepted limit: `filter.<name>.clean` in the repository's own config, with a matching attribute, runs on the two diffs (so, by the same route in Git, would its long running `filter.<name>.process` form, which was not measured). It needs the repository's local config, which no clone carries, and the daemon runs as the same user with the same reach as the agent; unlike the fsmonitor there is no single switch for it, since a filter's name is the repository's own choice, and reading attributes from another tree needs `--attr-source` (Git 2.41.0) or `attr.tree` (Git 2.43.0), and neither covers `.git/info/attributes`. The native `/diff` follows the same rules: Git by its absolute path, the same environment, lazy fetching off on a Git that knows the variable, the fsmonitor off, no index refresh, the same Git 2.36 floor and the same top level check. It does not mask: the backend masks secrets and cuts each file before any client sees the answer, and stores none of it. Every agent this daemon runs works in the one folder, so each one's panel shows that folder. A frame for an agent this daemon does not run gets no answer at all.

What the Changes read defends, and what it does not. It protects the owner from untrusted repository content, meaning what a clone carries (a `git` binary planted in the folder, attributes, files), and from Git writing the repository (the index refresh, locks). It does not protect against the agent itself: the agent runs as the same user on the same machine, can already run any program and read any file there, and the answer goes only to the owner of that machine. Settings only the agent's own local config or its `.git` file can make (`core.worktree`, a `.git` file whose `gitdir` points elsewhere, a clean filter, a promisor remote's programs; a `GIT_DIR` the daemon inherited is dropped, as above) can mislead its own panel. The top level check, `GIT_NO_LAZY_FETCH` and the Git 2.36 floor are defence in depth for those, each covering only what is said above. The Git directory and common directory are not checked, on purpose: agents that run in Git worktrees keep their common directory outside their folder. The floor stays at 2.36 because 2.45 would refuse Ubuntu 24.04's Git 2.43, which honours `GIT_NO_LAZY_FETCH` (measured).

The backend capability canon is requested with `channel=codex&daemonVersion=0.3.0`. Older daemons continue receiving their old syntax. Tool declarations and pure request builders are adapted from the Claude Code plugin at the revision recorded in `NOTICE`.

## Native chat controls

Both `/model` and `\model` work. A leading slash/backslash is recognized only as a command token; ordinary Windows, UNC and POSIX paths remain text. Arguments retain their backslashes. Commands appear as selectable command chips in HOAI immediately and after history reload.

| Controls | Native behavior |
|---|---|
| `model`, `effort`, `personality`, `fast` | Current account model catalog and supported settings; model switches preserve the current conversation. Fast is never enabled automatically. |
| `plan`, `code`, `permissions` | Per-chat planning/coding and local-file access. Connected HOAI tools retain their own permission checks. |
| `new`, `retry`, `stop`, `compact`, `steer`, `ps`, `status` | New context, repeat the last request, interrupt, compact, correct the running turn, and inspect actual state. |
| `resume`, `fork` | Select only conversations recorded for this HOAI chat or fork its native conversation. |
| `skills`, `mcp`, `review`, `diff`, `usage`, `help` | Native skills and MCP status, inline review, local Git diff, account/context limits, and command help. |

`/steer <text>` adds a correction to the response Codex is writing in this chat, and posts no reply: your own message is the receipt, and the response itself answers it (a reply would read as Codex being done while it is still working). When there is nothing to steer (no response running yet, one that ended as the correction went out, or a review or compaction, which Codex does not steer), the text runs once as a normal message in this chat's queue instead of an error. A correction Codex never answers within 30 seconds may still have landed, so it is not sent a second time; one line says so. HOAI's follow ups tray sends its Send now for a Codex agent as this command, to 0.15.0 or later only.

**The model and effort row.** From 0.18.0 this daemon reports the model and reasoning effort each chat is really running, so the HOAI app can show them in a quiet row under a Codex chat's message box. It reports when a settings change lands (`/model`, `/effort`, `/fast`, `/personality`, `/permissions` or plan mode), when the runtime announces a thread's new settings (`thread/settings/updated`) or reroutes a turn to another model (`model/rerouted`, reported flagged and cleared only when a later turn completes with no reroute of its own), when a chat's thread is started or resumed, and at connect for every chat whose settings it stores (built from the store as it is when that chat's turn in the sweep comes, skipping a chat already reported live in this process, and naming each chat's agent from `chat-assistants.json` in `CODEX_BGOS_HOME` on a daemon that serves several agents). A settings change that fails after the runtime applied it reports the value restored; one the runtime refused outright reports nothing, so a rerouted chat keeps its flag. A chat with a stored model reports the stored pair, which is what every turn runs on; a chat with nothing stored reports what the runtime itself says, never a guess from the model list. Each report is `PATCH /api/v1/integrations/assistants/:assistantId/chats/:chatId/session-settings` with `{ model, effort, serviceTier, rerouted, reportedAt }`: a report, never a command. A report with `model: null` is a retraction: the daemon sends one on `/new` with nothing stored and on the first message in a chat it holds nothing for (no stored settings, no thread), and the backend clears the stored value, so a value another machine reported is not shown as what this one runs. An unchanged value is not sent again, two reports for one chat leave in order, a failed report is retried per chat with a doubling backoff that holds only the chat's latest value, read when the retry's turn comes so an older value never lands after a newer one (never after a 4xx refusal, so an older backend's 404 is ignored, and never after a revoked pairing), after an in process re-pair every stored chat is reported again, and the `/model` question's "current" is the same value the report names, never a guess from the model list. The daemon declares `session_model_control` on its heartbeat, which is what lets the owner turn on Show model and effort for the agent (off by default). The daemon never reads that switch: it always reports, and the app decides whether to draw the row. Tapping the row sends the ordinary `/model`, so the list is the account's own models and then that model's own efforts, and a change applies between turns. The route, the body's fields, the value patterns and the token are pinned against the HOAI backend by one sha256 (`SESSION_SETTINGS_RAIL_SHA256` in `src/session-report.ts`, rebuilt in `test/session-rail-contract.spec.ts`).

Examples: `/model` opens the model and reasoning pickers; `/model model-id high` chooses directly; `/plan outline the migration` starts a planning turn; `/skills skill-name your task` passes a native skill input. `clear` aliases `new`; `approvals` aliases `permissions`.

Settings persist across daemon restarts without modifying the user's shared Codex configuration. The owner controls native session settings. New controls are appended once to an existing catalog without replacing customized descriptions/order; deleting one afterward keeps it deleted on restart. This upgrade requires the companion backend's pairing-scoped `commands/merge` endpoint.

Native MCP forms reuse identity-bound question cards with typed values, format validation, and paginated multiple-choice selection. Secret entry and URL verification stay with the provider. Unsupported form schemas cancel instead of fabricating success. Tool status uses actual native item completion events, including failed commands.

HOAI supplies its own theme, profile, navigation and integrations UI. Terminal-only appearance/account controls do not modify it; the bridge explains the appropriate surface. Codex `/import` is unavailable through local app-server. Autonomous native `/goal` continuation and experimental terminal controls are not implemented. These are explicit compatibility limits, not commands forwarded to the model as pretend actions. See the companion PR's capability matrix for live versus automated verification coverage.

## Upgrading existing conversations

An old Codex native thread cannot gain new dynamic tools on resume. On the first turn after a tool-schema upgrade, the host leaves the old native transcript intact, records its ID in `previous-threads.json`, and starts a thread with the current tools. It carries up to 60,000 characters of recent, attributed user/assistant text. Older text and tool outputs may be omitted; the model is told this explicitly. HOAI chat history is unchanged. New 0.3 threads resume normally while their tool schema remains compatible.

## Authentication and configuration

The daemon prefers Codex sign-in and otherwise supports an explicitly configured `OPENAI_API_KEY`. ChatGPT/Codex usage remains subject to the account's plan and limits; API-key use is billed under that API account. HOAI pairing secrets and ambient API keys are removed from the model subprocess environment. Explicit API-key mode passes only its selected key.

| Variable | Purpose |
|---|---|
| `CODEX_BGOS_HOME` | Per-agent settings, pairing, cursors, outbox and thread data |
| `CODEX_BGOS_WORKDIR` | Absolute project/workspace folder |
| `CODEX_BGOS_MODEL` | Optional model override; otherwise Codex configuration applies |
| `CODEX_BGOS_EXECUTABLE` | Optional absolute native Codex executable override |
| `CODEX_BGOS_AUTH_MODE` | `auto`, `chatgpt`, or `apikey` |
| `OPENAI_API_KEY` | Explicit API-key fallback |
| `BGOS_BASE_URL` | Backend root; defaults to `https://api.brandgrowthos.ai` |
| `CODEX_BGOS_MEDIA_ROOT` | Allowed outbound file root; defaults to the workspace |

Private Codex auth, HOAI pairing files, `.env` secrets and symlink escapes are excluded from outbound publishing. Backend authorization remains authoritative for all writes. A timed-out write may have succeeded: inspect its state before retrying.

## Development and release

```text
npm ci
npm run lint
npm test
npm run build
```

The CI matrix runs on Windows, macOS and Linux. Windows tests launch a real hidden script with Unicode/space-containing arguments; macOS validates the LaunchAgent plist with `plutil`. Real model/HOAI acceptance tests require an isolated signed-in test environment and are documented with the companion HOAI PR.

Release order: publish this connector version first, verify the npm package, then ship the companion HOAI app/backend changes that install and advertise it. A merge to this repository's `main` with a package version change triggers the existing npm publication workflow.

SEVEN releases are HELD BACK from `latest`, which inverts that order for 0.10.1, 0.11.0, 0.12.0, 0.13.0, 0.14.0, 0.15.0 and 0.18.0 (0.13.0 is P2 stage 5's request card release; the merge order was #12, #14, #15, P2 stage 5 (0.13.0), then 0.14.0, then 0.15.0, then 0.18.0, and the 0.14.0 merge, the second of 0.13.0 and 0.14.0, resolved the text conflicts here, in `src/interactions.ts`, in the publish workflow and in the package files by keeping both sides). 0.10.1 offers a thirty minute approval hold and relies on the BGOS backend clamping that offer to the owner's per agent choice (see the RELEASE ORDER comment above `APPROVAL_HOLD_SECONDS` in `src/interactions.ts`). 0.11.0 inherits that hold and adds one of its own: its plan card is a `plan_card` renderable the app has to know, its three chips are codes the app has to relabel, and its plan mode chip reads a chat column that ships with the stage 3 backend. 0.12.0 inherits both and adds a third: its file change card sends `approvalMeta.change_summary` and `approvalMeta.diff`, and the backend's `ApprovalMetaDto` strips a field it does not declare, silently, with a 201, so against a backend without the stage 4 DTO the daemon masks and caps a patch for nothing and the card still reads "Apply file changes". 0.13.0 inherits all three and its own reason is worse than theirs: its request card sends `approvalMeta.reason`, the model's own words for why it is asking, and `approvalMeta.rule_text`, the sentence saying that an Always answer writes a permanent line into the owner's global Codex rules file, and a backend whose DTO declares neither strips both with a 201 and no error. That is not a card that merely stays as it was. On 0.12.0 the model's justification WAS the card's title; here the title becomes `Run <command>` and the justification moves into the stripped `reason`, so against a pre stage 5 backend this release says LESS than the one before it: the sentence the owner used to read is gone, nothing replaces it, and the permanent global rule is still unsaid. 0.14.0 adds no hold of its own (a picture Codex makes posts itself as an ordinary image message, which every backend already accepts) and is held only because it carries the holds of the releases before it, so it is promoted only after 0.13.0 is on latest, never before or in the same step (`npm dist-tag add` points latest at whichever version ran last, so promoting an older version after 0.14.0 moves latest back to that older version), and only after one logged in live image turn confirms the real item (result bytes and their form, the result size (under 12 MiB, the line cap), revisedPrompt, savedPath, the failure shape; probe.md, decision 7), because the offline probe (`docs/reports/2026-09-24-p5-s4-image-posts/probe.md`) never saw a real item and a shape the code does not read turns every picture into a "could not be shown" line (a picture over the line cap never posts either, only that line does). 0.15.0 adds no hold of its own either (a steer with nothing to steer runs as an ordinary message and a landed steer posts no reply, which every backend already accepts) and is held only because it carries the holds of the releases before it, 0.14.0's included, so it is promoted only after 0.14.0 is on latest, never before or in the same step (promoting an older version after 0.15.0 moves latest back to that older version); the HOAI app steers only daemons at 0.15.0 or later, so until it is promoted Send now on a Codex agent is a plain send. 0.18.0 adds no hold of its own either (it reports each chat's model and effort to HOAI and declares `session_model_control`; an older backend answers the new report route with a 404 the daemon ignores and stores the token without reading it; 0.16.0 and 0.17.0 are P6's and P7's releases, #20 and #21, which merged ahead of it) and is held only because it carries the holds of the releases before it, 0.14.0's and 0.15.0's included, so it is promoted only after 0.15.0 is on latest, never before or in the same step (promoting an older version after 0.18.0 moves latest back to that older version); the HOAI app offers the model and effort row only to a daemon that declares `session_model_control`, so until it is promoted no Codex agent shows it. So the publish workflow sends any of those versions to npm under the dist tag `next`, named in `HELD_FROM_LATEST` in `.github/workflows/publish.yml`, and nothing installs them by default. The hold is written in two machine readable places that a test keeps in agreement (`test/publish-workflow.spec.ts`): that list, and the seven `HELD-FROM-LATEST:` lines in the RELEASE ORDER comment in `src/interactions.ts`. Retire them one at a time, each once ITS backend and migration are deployed, dropping the version from both places:

```text
# stage 1 backend live (the per agent wait column and its clamp):
npm dist-tag add codex-channel-bgos@0.10.1 latest
# stage 3 backend live (the plan card renderable and chats.session_mode):
npm dist-tag add codex-channel-bgos@0.11.0 latest
# stage 4 backend live (ApprovalMetaDto's change_summary and diff):
npm dist-tag add codex-channel-bgos@0.12.0 latest
# stage 5 backend live (ApprovalMetaDto's reason and rule_text):
npm dist-tag add codex-channel-bgos@0.13.0 latest
# only after 0.13.0 is on latest, never before or in the same step (0.14.0
# needs no backend of its own), and only after one logged in live image turn
# confirms the real item (result bytes and their form, the result size (under
# 12 MiB, the line cap), revisedPrompt, savedPath, the failure shape; probe.md,
# decision 7). Promoting an older version after 0.14.0 moves latest back to
# that older version:
npm dist-tag add codex-channel-bgos@0.14.0 latest
# only after 0.14.0 is on latest, never before or in the same step (0.15.0
# needs no backend of its own). Promoting an older version after 0.15.0 moves
# latest back to that older version:
npm dist-tag add codex-channel-bgos@0.15.0 latest
# only after 0.15.0 is on latest, never before or in the same step (0.18.0
# needs no backend of its own). Promoting an older version after 0.18.0 moves
# latest back to that older version:
npm dist-tag add codex-channel-bgos@0.18.0 latest
```

## License

Original code: MIT. Adapted `src/hoai-shared` code: Apache-2.0. See `LICENSE`, `NOTICE`, and `LICENSES/Apache-2.0.txt`.

### OpenAI native call context

With the updated HOAI app/backend and GPT-Live selected, native `call_owner` accepts optional `context` (4000 characters) and `opening_message` (400 characters). HOAI always includes the last 12 usable authorized chat messages, or all available if fewer. The opening suggests the first sentence after the owner answers. Keep private details in `context`, not the public `reason`. Long text is bounded to the voice budget. ElevenLabs keeps its existing settings and behavior.
