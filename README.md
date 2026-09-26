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
| Changes panel | Answers the owner's Changes panel (`changes_rpc`, op `diff`, scope `uncommitted`) with read only Git in the working folder; declares `changes_rpc` |

Receiving an audio/video file does not imply transcription or video understanding. Codex can inspect file paths with its available tools. Meeting turn-refresh is not advertised. Codex consults return directly through the host; they do not expose Claude's cooperative `voice_consult_reply` tool. Outbound caps: images 10 MB, videos 100 MB, other files 25 MB.

A tool row carries what the step actually did. A shell row carries what the command printed, taken from the completed item as the last 2,048 characters and at most 200 lines, with known secret shapes masked on this computer before anything leaves it and a private key block removed body and all; one card carries at most 8,192 characters of output in total, spent on the newest rows first. The row also carries the exit code, kept only inside the range the platform accepts, so an unusual Windows status costs the row its code and never the card. A running row carries neither, because the protocol leaves both empty until the command ends.

An edit row carries the lines it added and the lines it removed, counted here from the completed change's own unified diff, because the protocol sends no counts. The counts come from a change that landed: a patch the owner declined, or one that failed to apply, leaves the row in its error colour with no counts at all. The row never carries the diff body itself. The card also carries the turn's own start and finish, as the runtime reported them, on the final update of the turn.

The owner's Changes panel is the one place a diff body leaves this computer, and only when the owner asks for it: the backend sends a `changes_rpc` frame only while the owner has the panel switched on for that agent, and only to a daemon that declares `changes_rpc`. The daemon runs seven read only Git commands in the working folder with `GIT_OPTIONAL_LOCKS=0` (never `git add`, never `git status`, nothing that writes the index or the files), passes `-c diff.autoRefreshIndex=false` to both diffs because a plain `git diff` rewrites the index on its own when a file's timestamp moved but its content did not, turns off any fsmonitor program the repository's own config names (`-c core.fsmonitor=false` on every command, since Git runs that program whenever it reads the index), pins the `a/` and `b/` prefixes and the short submodule format whatever the host's Git config says, reads at most 20 new text files of up to 64 KB each, and sends the raw output cut at the frame's byte caps within a 10 second budget. It never fetches: every read runs with `GIT_NO_LAZY_FETCH=1`, so in a partial clone a change whose old contents were never downloaded is a failed read, not a download from the promisor remote, which would run the programs the repository names for that remote. It needs Git 2.36 or later, because an older Git reads `core.fsmonitor=false` as the name of a program to run: the daemon reads `git version` once for each Git it finds, and below 2.36, or when the version cannot be read, it answers "Git 2.36 or later is needed to read changes safely" and runs nothing else; a refused Git is asked again at the next read, so an update needs no restart. It stays inside the agent's folder: the repository's top level must be the working folder or a folder above it, compared with links resolved, so a `core.worktree` that names another folder is a failed read and nothing there is read. Git runs by the absolute path found on PATH's absolute entries, looked up on each read, never as a bare `git` that a `git.exe` left in the working folder could answer. Git's environment drops the variables that would point it at another repository or index (`GIT_DIR`, `GIT_INDEX_FILE` and six more, in any spelling on Windows, which reads environment names case blind), so a daemon started from a Git hook or with `GIT_DIR` exported still reads its own working folder; a working folder that is gone is a failed read, never "Git missing". Each new file is read through one handle, at most 64 KB and one byte, and only while it is still the regular file first checked: the open handle is checked before a single byte is read, so a name swapped for a link, another file or a device is never read. An answer is kept for a re sent frame only through the backend's 20 second wait, and at most the newest eight. A clean filter the repository names still runs, and this is an accepted limit: `filter.<name>.clean` in the repository's own config, with a matching attribute, runs on the two diffs (so, by the same route in Git, would its long running `filter.<name>.process` form, which was not measured). It needs the repository's local config, which no clone carries, and the daemon runs as the same user with the same reach as the agent; unlike the fsmonitor there is no single switch for it, since a filter's name is the repository's own choice, and reading attributes from an empty tree needs Git 2.40 and does not cover `.git/info/attributes`. The native `/diff` follows the same rules: Git by its absolute path, the same environment, lazy fetching off, the fsmonitor off, no index refresh, the same Git 2.36 floor and the same top level check. It does not mask: the backend masks secrets and cuts each file before any client sees the answer, and stores none of it. Every agent this daemon runs works in the one folder, so each one's panel shows that folder. A frame for an agent this daemon does not run gets no answer at all.

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
