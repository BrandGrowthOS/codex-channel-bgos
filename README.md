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
| Tools and context | Native running/completed/failed tool cards, context usage, scoped stop, 22 session commands, context-preserving model changes |
| Boards | All 12 shared `boards_*` tools, including real permission checks and refusal responses |
| Peers and side chats | Peer discovery, sending, status, completing threads; caller identity comes from the bound event |
| Meetings | Server floor and membership checked before a turn; text/yield uses the guarded meeting reply endpoint; durable reconnect deduplication |
| Schedules | Create, list and cancel scheduled wakes/calls; owner call requests |
| Missions | Explicit mission tools and automatic native plans; derived plans cannot overwrite a self-reported mission |
| Components and trackers | Manifest-validated rich components, health event tools and tracker cards |
| Voice control | Caller-credential mint, invisible read-only consult/compose, confirmed detached tasks, per-chat stop/cancel, durable task claims |
| Stop and resume | An owner Stop (the app's Stop button or `/stop`) cancels the turn, posts "Stopped." and pauses the chat's open mission with the reason "Stopped by you" instead of failing it; the owner's next message in that chat, the app's Resume included, resumes it. In a Keep working chat the Stop also holds the goal, during a continuation turn the runtime started on its own too, and that message gives it back if the goal was running when the Stop came; a goal already held at its turn cap, stopped for lack of progress, or paused with `/goal pause` stays held, a daemon restart before that message included, and the message runs as an ordinary turn. `/new`, a daemon shutdown and a revoked pairing still end the mission. Declared as `stop_pauses_mission` |
| Sessions | The app's Sessions sheet lists this chat's own Codex conversations (the set `/resume` offers: the latest 30, searchable by title and first message), renames one through Codex's own thread name, and resumes one into the chat with `/resume`'s line. Declared as `sessions_library`; rename turns itself off on a Codex runtime without it |

Receiving an audio/video file does not imply transcription or video understanding. Codex can inspect file paths with its available tools. Meeting turn-refresh is not advertised. Codex consults return directly through the host; they do not expose Claude's cooperative `voice_consult_reply` tool. Outbound caps: images 10 MB, videos 100 MB, other files 25 MB.

A tool row carries what the step actually did. A shell row carries what the command printed, taken from the completed item as the last 2,048 characters and at most 200 lines, with known secret shapes masked on this computer before anything leaves it and a private key block removed body and all; one card carries at most 8,192 characters of output in total, spent on the newest rows first. The row also carries the exit code, kept only inside the range the platform accepts, so an unusual Windows status costs the row its code and never the card. A running row carries neither, because the protocol leaves both empty until the command ends.

An edit row carries the lines it added and the lines it removed, counted here from the completed change's own unified diff, because the protocol sends no counts. The counts come from a change that landed: a patch the owner declined, or one that failed to apply, leaves the row in its error colour with no counts at all. The diff body itself never leaves the computer. The card also carries the turn's own start and finish, as the runtime reported them, on the final update of the turn.

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

## License

Original code: MIT. Adapted `src/hoai-shared` code: Apache-2.0. See `LICENSE`, `NOTICE`, and `LICENSES/Apache-2.0.txt`.

### OpenAI native call context

With the updated HOAI app/backend and GPT-Live selected, native `call_owner` accepts optional `context` (4000 characters) and `opening_message` (400 characters). HOAI always includes the last 12 usable authorized chat messages, or all available if fewer. The opening suggests the first sentence after the owner answers. Keep private details in `context`, not the public `reason`. Long text is bounded to the voice budget. ElevenLabs keeps its existing settings and behavior.
