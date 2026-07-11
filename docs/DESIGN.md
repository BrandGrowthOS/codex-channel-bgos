# codex-channel-bgos: design and build spec

Status: approved under autonomous goal mode (OCB build item 5). Date: 2026-07-11.

## Goal

Make OpenAI Codex agents first-class BGOS agents. A long-running daemon on the
user's machine pairs with BGOS (pair-exchange), receives chat messages over
WebSocket + REST backfill, drives Codex through the official `@openai/codex-sdk`,
and posts replies plus live tool-progress back to the app. One BGOS chat maps to
one persistent Codex thread; `/new` resets it.

This mirrors the proven sibling adapters `gobot-channel-bgos` and
`openclaw-channel-bgos`. The BGOS-facing transport, dedupe, cursor, outbound,
heartbeat, and slash-command machinery are ported near-verbatim from Gobot (the
most complete sibling); only the "brain" is swapped for the Codex SDK.

## Verified SDK facts (re-verified live, 2026-07-11)

Source: the actual published `@openai/codex-sdk@0.144.1` tarball + `.d.ts`, cross
checked against learn.chatgpt.com/docs/codex-sdk and the GitHub TS SDK README.

- Package `@openai/codex-sdk` v0.144.1, ESM, `engines.node >=18`. It depends on
  `@openai/codex` (the CLI) which delivers the native binary via platform
  optionalDependencies. `npm install @openai/codex-sdk` brings a runnable binary;
  no separate global `codex` install is required. The SDK spawns the binary and
  exchanges JSONL over stdio.
- `new Codex(options?: CodexOptions)` where
  `CodexOptions = { codexPathOverride?, baseUrl?, apiKey?, config?, env? }`.
- `startThread(options?: ThreadOptions): Thread` and
  `resumeThread(id: string, options?: ThreadOptions): Thread` are BOTH synchronous
  (they return `Thread`, not a promise). Threads persist under `~/.codex/sessions`.
- `Thread.run(input, turnOptions?): Promise<Turn>` where
  `Turn = { items: ThreadItem[]; finalResponse: string; usage: Usage | null }`.
- `Thread.runStreamed(input, turnOptions?): Promise<StreamedTurn>` where
  `StreamedTurn = { events: AsyncGenerator<ThreadEvent> }`. Iterate `result.events`.
  runStreamed() IS real (v0.144.1). We use it so tool-progress is live.
- `Thread.id: string | null` (populated after the first turn starts).
- `Input = string | UserInput[]`,
  `UserInput = { type: "text"; text } | { type: "local_image"; path }`. Inbound
  images map to `local_image`; other files are downloaded and referenced in text.
- `ThreadEvent` union: `thread.started {thread_id}`, `turn.started`,
  `turn.completed {usage}`, `turn.failed {error}`, `item.started {item}`,
  `item.updated {item}`, `item.completed {item}`, `error {message}`.
- `ThreadItem` union: `agent_message {text}`, `reasoning {text}`,
  `command_execution {command, aggregated_output, exit_code?, status}`,
  `file_change {changes, status}`,
  `mcp_tool_call {server, tool, arguments, result?, error?, status}`,
  `web_search {query}`, `todo_list {items}`, `error {message}`.
- `ThreadOptions`: `model?`, `sandboxMode?` (read-only | workspace-write |
  danger-full-access), `workingDirectory?`, `skipGitRepoCheck?`,
  `modelReasoningEffort?`, `approvalPolicy?` (never | on-request | on-failure |
  untrusted), `additionalDirectories?`, and network/web-search flags.
- Auth: by default the SDK forwards the whole `process.env` to the subprocess. The
  CLI honors `OPENAI_API_KEY` AND `CODEX_API_KEY` (the constructor `apiKey` option
  is injected as `CODEX_API_KEY`) AND `~/.codex/auth.json` (a prior `codex login`).
  If you pass `CodexOptions.env`, `process.env` is NOT inherited: you must include
  what the CLI needs (HOME, PATH, and CODEX_HOME if set).

Correction to the goal's premise: the review that flagged `runStreamed()` and
`CODEX_API_KEY` as fabrications was mistaken; both are real in v0.144.1. We use
`runStreamed()` for live events and drive auth through the `apiKey` option
(CODEX_API_KEY) or by controlling the child env to prefer the codex login.

## Auth (Decision D7): prefer existing codex login, OPENAI_API_KEY as fallback

Resolved once at startup into an explicit `authMode`:

1. If `~/.codex/auth.json` exists (a real login) and mode is not forced to
   `apikey`, `authMode = "chatgpt"`. Construct the Codex client with a child env
   that has OPENAI_API_KEY and CODEX_API_KEY removed, so the CLI falls back to the
   login. Zero marginal cost; plan rate limits apply.
2. Else if `OPENAI_API_KEY` is available (env or ~/.env), `authMode = "apikey"`.
   Construct `new Codex({ apiKey })` (becomes CODEX_API_KEY). Metered API billing.
3. Else refuse to start with a plain-language error naming both remedies.

Override: `CODEX_BGOS_AUTH_MODE = auto | chatgpt | apikey` (default `auto` = prefer
login). The active mode is printed in the startup banner and included in the
heartbeat payload and local heartbeat file.

## Capability parity (per hermes-channel-bgos/docs/bgos-agent-capabilities.md)

Codex emits a single text stream, so the agent-facing surface uses the marker
idiom (like OpenClaw), authored in `src/agent-hints.ts` and written to
`<workdir>/AGENTS.md` (Codex reads AGENTS.md natively) so every turn sees it.

| Capability | v1 support |
|---|---|
| Text / markdown (no tables, no `![]()`) | Yes: post `finalResponse` as `standard`. |
| Outbound media | Yes: `MEDIA:/abs/path` markers -> `files[]` (base64 <500KB / presigned S3). |
| Inline buttons (<=6) | Yes: `[[BGOS_BUTTONS]]` marker -> `options[]`. |
| ask_user_input (1-4, blocking) | Yes: `[[BGOS_ASK]]` marker; adapter fans out rows, blocks, feeds answers into the next turn. |
| tool_progress | Yes, host-driven from runStreamed() item events (Codex's advantage over OpenClaw's self-report). |
| typing | Yes: WS `typing` while a run is in flight. |
| status (statusText/emoji/detail) | Yes: `STATUS:` marker -> PATCH /integrations/assistants/:id/status. |
| Inbound text / event / system / peer | Yes: forward canonical `text` (markers preserved) to run(). |
| Inbound files/media | Yes: images -> `local_image`; other files downloaded, path injected, dir added to additionalDirectories. |
| Slash commands | Yes: `/new` (rotate thread), `/retry`, `/status` bridge-local; catalog registered via PUT. |
| Approvals (4-button) | NOT surfaced in v1. Documented honestly: run()/runStreamed() expose only a fixed `approvalPolicy`, not an interactive approval hook (that needs the app-server protocol). v1 runs `sandboxMode: workspace-write`, `approvalPolicy: never`. |
| Voice / meetings / federation / call-owner | Deferred (parity with Hermes/OpenClaw/Gobot). |

## Architecture

Home dir: `~/.codex-bgos/` (NEVER `~/.codex/`, which is OpenAI Codex's own home).
Override via `CODEX_BGOS_HOME`. Files under it: `secrets/bgos.json` (0600),
`bgos_last_id`, `bgos_pending_unknown.json`, `bgos_outbox.jsonl`,
`bgos_heartbeat.json`, `threads.json` (chat->threadId map), `workspace/`
(Codex working dir + AGENTS.md), `logs/`.

### BGOS-facing modules (ported from gobot-channel-bgos, renamed)

- `bgos-api.ts` REST client, `X-BGOS-Pairing` header, 401 -> PairingRevokedError.
  Endpoints: pair-exchange, whoami (`GET /integrations/me`), inbound backfill
  (`GET /integrations/inbound?since_message_id`), `POST /messages`,
  `POST /send-message` (peer), `PATCH /messages/:id`, catalog push, heartbeat,
  `PUT /integrations/assistants/:id/commands`,
  `PATCH /integrations/assistants/:id/status`, `POST /files/upload-url`.
- `bgos-ws.ts` Socket.IO client (bare base URL, `pairingToken` query, websocket
  transport, infinite reconnect). Backfill single-flight + cold-start seed + storm
  guard. Inbound normalize + dedupe gate + cursor advance.
- `processed-ids.ts` 500-entry FIFO dedupe.
- `last-id-store.ts` + `pending-unknown-store.ts` durable cursor + clamp.
- `outbox.ts` + `outbound-retry.ts` durable safe-retry spool.
- `outbound.ts` all message types (text/buttons/approval/ask/media/tool_progress/
  agent_error/typing/status), branded target authority.
- `media-classify.ts` + `attachment-bridge.ts` inbound/outbound file bytes.
- `heartbeat.ts` network (`POST /integrations/heartbeat`, 60s) + local file (30s);
  DTO `{ daemonVersion, uptimeS, wsConnected, lastError, authMode }`.
- `catalog-sync.ts`, `commands-sync.ts`, `default-commands.ts`, `version.ts`,
  `config.ts`, `load-config.ts`.
- `pair-cli.ts` / `pair-daemon-first.ts` pair-exchange (app-first + daemon-first).
- `setup/supervisor.ts` launchd `ai.brandgrowthos.codex` + systemd
  `codex-bgos.service`.

### Codex-specific modules (new, TDD)

- `codex-host.ts` wraps the SDK: keeps a `Codex` client, per-chat thread via
  `thread-map`, runs `runStreamed()`, maps events, returns reply text.
- `thread-map.ts` (pure + disk) chatId -> Codex threadId persistence; `reset(chatId)`.
- `event-mapper.ts` (pure) ThreadEvent stream -> { typing, toolCards[], replyText,
  error } incremental reducer. Unit-tested against synthetic event sequences.
- `auth-mode.ts` (pure) resolve authMode from { authJsonExists, openaiKeyPresent,
  forced } -> { mode, codexOptions-shape, humanError? }.
- `reply-markers.ts` (pure) parse `MEDIA:`, `[[BGOS_BUTTONS]]`, `[[BGOS_ASK]]`,
  `STATUS:`, `[[BGOS_TOOL_PROGRESS]]` from a reply; strip markers from user text.
- `inbound-input.ts` (pure) BGOS inbound (text + files) -> Codex `Input`
  (`local_image` for images, text lines for other files).
- `agent-hints.ts` `BGOS_AGENT_HINTS` string + AGENTS.md writer.

### CLI (`src/cli.ts`, bin `codex-channel-bgos`)

- `codex-channel-bgos connect <CODE>`  pair (app-first) then start.
- `codex-channel-bgos connect`         daemon-first pair (mint code + QR) then start.
- `codex-channel-bgos start` (default)  start from the stored token.
- `codex-channel-bgos install-service`  install launchd/systemd persistence.
- `codex-channel-bgos --help`.

`connect` = pair-then-start in one process (openclaw shape): pair writes the token,
control falls through to `start`. `integration: "codex"` is passed on pair-exchange.

## Testing

vitest. Pure logic (`event-mapper`, `thread-map`, `auth-mode`, `reply-markers`,
`inbound-input`, `processed-ids`, cursor/clamp, outbound-retry) is unit-tested. A
`MockBgosServer` (ported) exercises `bgos-api`/pairing without a real backend.

## Definition of done

Live E2E on this machine: real pair code, BGOS->Codex message, reply in the app,
tool_progress visible during a run, `/new` resets context. Auth via OPENAI_API_KEY
from ~/.env and codex-login detection. Unit tests green. npm publish after
verification. Frontend PR flips the codex tile on (do not merge) with a What's New
entry. No em/en dashes anywhere.
