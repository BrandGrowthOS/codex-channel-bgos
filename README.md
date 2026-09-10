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
| Tools and context | Live tool cards, context usage, scoped stop, `/new`, `/retry`, `/status`, `/stop`, `/compact` |
| Boards | All 12 shared `boards_*` tools, including real permission checks and refusal responses |
| Peers and side chats | Peer discovery, sending, status, completing threads; caller identity comes from the bound event |
| Meetings | Server floor and membership checked before a turn; text/yield uses the guarded meeting reply endpoint; durable reconnect deduplication |
| Schedules | Create, list and cancel scheduled wakes/calls; owner call requests |
| Missions | Explicit mission tools and automatic native plans; derived plans cannot overwrite a self-reported mission |
| Components and trackers | Manifest-validated rich components, health event tools and tracker cards |
| Voice control | Caller-credential mint, invisible read-only consult/compose, confirmed detached tasks, per-chat stop/cancel, durable task claims |

Receiving an audio/video file does not imply transcription or video understanding. Codex can inspect file paths with its available tools. Meeting turn-refresh is not advertised. Codex consults return directly through the host; they do not expose Claude's cooperative `voice_consult_reply` tool. Outbound caps: images 10 MB, videos 100 MB, other files 25 MB.

The backend capability canon is requested with `channel=codex&daemonVersion=0.3.0`. Older daemons continue receiving their old syntax. Tool declarations and pure request builders are adapted from the Claude Code plugin at the revision recorded in `NOTICE`.

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
