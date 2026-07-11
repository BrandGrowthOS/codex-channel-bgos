# codex-channel-bgos

Chat with your OpenAI Codex agents inside BGOS (Home of Agents).

`codex-channel-bgos` is a small daemon that runs on your machine, pairs with your
BGOS account, and hosts OpenAI Codex through the official
[`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk). Every BGOS
chat maps to one persistent Codex thread, so your agent keeps context; tool runs
show up live as a tool-progress card; and `/new` starts fresh.

It is a sibling of `gobot-channel-bgos`, `openclaw-channel-bgos`, and
`hermes-channel-bgos` and reuses their proven transport, dedupe, cursor, and
outbound machinery.

## Quick start (one paste)

1. In the BGOS app, tap **Add an agent** and pick **Codex**. Copy the pair code.
2. On the computer where Codex runs, paste:

```bash
npx codex-channel-bgos connect BGOS-XXXX-XX
```

That pairs and starts the daemon in one step. Your Codex agent appears in BGOS,
ready to chat.

The `codex` runtime ships with the npm package, so you do not need a separate
install. You do need to be signed in (see Auth).

## Auth

The daemon prefers an existing `codex login` (your ChatGPT plan, no extra cost),
and falls back to an OpenAI API key.

- If you have run `codex login`, it is used automatically.
- Otherwise set `OPENAI_API_KEY` (for example in `~/.env`).
- With neither, the daemon refuses to start and tells you how to fix it.

Override the choice with `CODEX_BGOS_AUTH_MODE`:

| Value | Behavior |
|---|---|
| `auto` (default) | Prefer the codex login, else `OPENAI_API_KEY` |
| `chatgpt` | Require the codex login |
| `apikey` | Require `OPENAI_API_KEY` (metered billing) |

The active mode is printed at startup and reported in the heartbeat.

## Commands

```bash
codex-channel-bgos connect <CODE>   # pair with a BGOS code, then start
codex-channel-bgos start            # start from the stored pairing token
codex-channel-bgos install-service  # install launchd/systemd persistence
codex-channel-bgos --help
```

## Keep it running

```bash
npm i -g codex-channel-bgos
codex-channel-bgos connect BGOS-XXXX-XX   # once, to pair
codex-channel-bgos install-service        # launchd (macOS) or systemd user unit (Linux)
```

On Linux, to keep the service alive after logout: `loginctl enable-linger "$USER"`.

## What your Codex agent can do

The agent talks back with plain text plus a few markers (documented for the agent
in `AGENTS.md`, which the daemon writes into the workspace):

- Files and media: put `MEDIA:/absolute/path` on its own line.
- Inline buttons (up to 6): a `[[BGOS_BUTTONS]] ... [[/BGOS_BUTTONS]]` block.
- Blocking questions (1 to 4): a `[[BGOS_ASK]] ... [[/BGOS_ASK]]` block.
- Status line: `STATUS: <text>`.
- Tool progress: automatic. Codex's shell, file, MCP, and web-search activity is
  streamed to a live card; the agent does not self-report.
- Inbound images are passed to Codex natively; other files are downloaded and
  their path is given to the agent.

Slash commands `/new` (reset the thread), `/retry`, and `/status` are handled by
the daemon. Dangerous-command approval cards are not surfaced in this version (the
SDK exposes only a fixed approval policy; the daemon runs in a workspace-write
sandbox). See the capability canon in `hermes-channel-bgos/docs/bgos-agent-capabilities.md`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | (none) | API-key auth (fallback to codex login) |
| `CODEX_BGOS_AUTH_MODE` | `auto` | `auto` / `chatgpt` / `apikey` |
| `CODEX_BGOS_HOME` | `~/.codex-bgos` | Data dir (secrets, threads, workspace, logs) |
| `CODEX_BGOS_MODEL` | (SDK default) | Codex model override |
| `CODEX_BGOS_POLL_INTERVAL` | `5` | Inbound poll seconds (0 disables) |
| `CODEX_BGOS_HEARTBEAT_INTERVAL` | `60` | Heartbeat seconds (0 disables network) |
| `BGOS_BASE_URL` | `https://api.brandgrowthos.ai` | Backend base URL |

Data lives under `~/.codex-bgos/` (kept separate from OpenAI Codex's own
`~/.codex/`): `secrets/bgos.json` (0600), `threads.json` (chat to thread map),
`workspace/` (Codex working dir + AGENTS.md), plus cursor/outbox/heartbeat files.

## Develop

```bash
npm install
npm test        # vitest
npm run build   # tsc + shebang finalize
npm run lint    # tsc --noEmit
```

## License

MIT
