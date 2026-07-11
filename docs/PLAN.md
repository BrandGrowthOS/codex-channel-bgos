# codex-channel-bgos Implementation Plan

> Executed inline in this session (single context holds the whole new repo).
> TDD for pure-logic modules; ported modules are copy-and-adapt from
> gobot-channel-bgos with their specs.

**Goal:** A daemon that makes OpenAI Codex agents first-class BGOS agents via
`@openai/codex-sdk`.

**Architecture:** Port Gobot's BGOS-facing transport/dedupe/outbound/heartbeat/
service layer near-verbatim; swap the brain for a Codex SDK host that maps one
BGOS chat to one persistent Codex thread and streams run() events to
tool_progress. See `docs/DESIGN.md`.

**Tech Stack:** Node >=20, TypeScript ESM, tsc build, vitest, axios,
socket.io-client, zod, qrcode, @openai/codex-sdk.

## Global Constraints (verbatim)

- NO em dashes or en dashes anywhere (copy, docs, code, UI). Use comma/colon.
- `engines.node >= 20`; ESM (`"type": "module"`); MIT license; `files: ["dist","README.md"]`.
- Relative imports use `.js` extension (ESM/tsc requirement).
- Never log tokens or keys.
- Home dir `~/.codex-bgos/` (NEVER `~/.codex/`). Override `CODEX_BGOS_HOME`.
- `integration: "codex"` on pair-exchange (load-bearing).
- Backend base default `https://api.brandgrowthos.ai`; REST at base + `/api/v1`;
  WS at bare base with `pairingToken` query.
- Auth header `X-BGOS-Pairing: <token>`.
- Secrets file `~/.codex-bgos/secrets/bgos.json` mode 0600, atomic tmp+rename.

## File structure

Ported from gobot (rename gobot->codex, GOBOT_->CODEX_BGOS_, ~/.gobot->~/.codex-bgos):
`bgos-api.ts`, `bgos-ws.ts`, `processed-ids.ts`, `last-id-store.ts`,
`pending-unknown-store.ts`, `outbox.ts`, `outbound-retry.ts`, `outbound.ts`,
`media-classify.ts`, `attachment-bridge.ts`, `heartbeat.ts`, `catalog-sync.ts`,
`commands-sync.ts`, `default-commands.ts`, `version.ts`, `config.ts`,
`load-config.ts`, `pair-cli.ts`, `pair-arg.ts`, `pair-daemon-first.ts`,
`pair-daemon-first-logic.ts`, `types.ts`, `setup/supervisor.ts`,
`scripts/finalize-daemon.mjs`, `test/mocks/mock-bgos-server.ts`.

New Codex-specific (TDD):
`auth-mode.ts`, `thread-map.ts`, `event-mapper.ts`, `reply-markers.ts`,
`inbound-input.ts`, `codex-host.ts`, `agent-hints.ts`, `adapter.ts`, `cli.ts`,
`index.ts`.

## Task order

1. Scaffold: package.json, tsconfig, vitest, .gitignore, finalize-daemon.mjs, CI,
   LICENSE, README skeleton, `dev-install` of @openai/codex-sdk.
2. Port foundational pure modules + specs: processed-ids, last-id-store,
   pending-unknown-store, outbox, media-classify, version, config, load-config.
3. Port BGOS wire: types, bgos-api (+ mock server), bgos-ws, outbound,
   outbound-retry, attachment-bridge, catalog-sync, commands-sync,
   default-commands, heartbeat.
4. Port pairing: pair-arg, pair-cli, pair-daemon-first(+logic).
5. New TDD: auth-mode, thread-map, reply-markers, inbound-input, event-mapper.
6. New: codex-host (SDK wrapper using thread-map + event-mapper), agent-hints.
7. Wire adapter.ts (inbound -> codex-host -> outbound; typing; tool_progress;
   slash /new,/retry,/status; catalog + heartbeat).
8. cli.ts (connect/start/install-service) + setup/supervisor.ts + index.ts.
9. Capability doc + canon sync + runbook skill (parallel agent).
10. Frontend PR (parallel agent).
11. Build, unit tests green, live E2E, publish, report.

## TDD contracts for the new pure modules

- `auth-mode.ts`: `resolveAuthMode({ authJsonExists, openaiKey, forced }) ->
  { mode: "chatgpt"|"apikey"; apiKey?: string; error?: string }`. chatgpt when
  authJsonExists and forced!=="apikey"; apikey when openaiKey and (forced==="apikey"
  or !authJsonExists); error (human text) when neither.
- `thread-map.ts`: `loadThreadMap(dir)`, `getThreadId(map, chatId)`,
  `setThreadId(map, chatId, threadId)` (persist), `resetChat(map, chatId)`.
  JSON `{ [chatId]: threadId }` at `<home>/threads.json`, atomic write.
- `reply-markers.ts`: `parseReply(text) -> { cleanText, media: string[],
  buttons: {question,options[]}|null, ask: {...}|null, status: {text,emoji?}|null }`.
  Strips `MEDIA:`, `[[BGOS_BUTTONS]]..[[/]]`, `[[BGOS_ASK]]..[[/]]`, `STATUS:`.
- `inbound-input.ts`: `buildCodexInput({ text, files, localPaths }) -> Input`
  (string when no files; else UserInput[] with local_image + text lines).
- `event-mapper.ts`: a reducer `stepEvent(state, event) -> { state, effects }`
  producing tool cards (from command_execution/file_change/mcp_tool_call/web_search
  item events) and accumulating agent_message text; final `replyText` + `usage`.

## Definition of done

See docs/DESIGN.md. Live E2E, tests green, publish, frontend PR (no merge),
0 em/en dashes.
