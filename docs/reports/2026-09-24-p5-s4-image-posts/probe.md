# P5 stage 4 (C-21): the live image generation probe

**Date:** 2026-09-24, 08:40 to 08:44 (Asia/Dubai)
**Runtime probed:** the plugin's own bundled `codex.exe` 0.154.0
(`node_modules/@openai/codex-win32-x64/.../bin/codex.exe`), the binary the daemon spawns. The global npm CLI
(`codex.cmd`) is 0.118.0, so it was not used: its wire could differ from what the plugin receives.
**Script:** `E:\bgos-worktrees\_tools-p5\probes\s4\probe-image.js` (zero dependencies, outside the repo).
**Raw logs (not committed, base64 replaced by its length and first 16 characters):**
`_tools-p5\probes\s4\raw.jsonl` (live), `raw-stub.jsonl` and `raw-stub-known.jsonl` (stub runs).

## The answer, first

**No image was generated. This machine's Codex is not logged in**, so the live turn failed on a 401 before the
model was ever reached. The ledger's premise ("this machine's logged in Codex CLI", Stage 4 decision 7) does not
hold today. P2's probes recorded the same thing on 2026-09-23 ("this box has no `codex login`, account/read ->
null"). So the real `imageGeneration` item shape, its status strings, `result` size and `savedPath` were NOT
observed on the wire. Zero spend on Kc's account.

What the probe did establish, from two zero cost stub runs and from the 0.154.0 binary itself:

1. **Image generation in 0.154.0 is not the Responses API's built in `image_generation` tool any more.** It is an
   extension tool, `image_gen.imagegen` (Rust crate `codex_image_generation_extension`, `ext\image-generation`),
   that makes its own HTTP call to an images endpoint (`images/generations`, or `images/edits` for an edit; which base URL it uses was not determinable offline) with headers
   `x-codex-imagegen-request-id` and `x-codex-image-turn-id`, decodes `data[].b64_json`, saves the file under
   `$CODEX_HOME/generated_images`, and emits `ImageGenerationBegin` / `ImageGenerationEnd`, which the app server
   turns into the `imageGeneration` thread item.
2. **A legacy `image_generation_call` output item is silently dropped.** The stub answered the probe turn with a
   well formed `image_generation_call` (status `completed`, `revised_prompt`, a real 64x64 PNG as `result`). The
   runtime wrote it to the rollout file as a `response_item`, then emitted NO `item/started` and NO
   `item/completed` for it, no warning, nothing on stderr, and saved no file. Only the `agentMessage` reached the
   client. So the plugin cannot learn the shape by faking the upstream item; only a real login can.
3. **The image tool is not offered without a ChatGPT login.** The probe turn's tool list (logged by the stub) had
   no `image_gen` entry, both with an unknown model (`stub-model`) and with a known one (`gpt-5.5`), although
   `codex features list` reports `image_generation  stable  true`. Tools seen with `gpt-5.5`: `exec_command`,
   `write_stdin`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, `request_user_input`,
   `apply_patch`, `view_image`, `mcp__cua_repl` (namespace), `get_goal`, `create_goal`, `update_goal`,
   `tool_search`, `web_search`. The bundled image skill text says the built in tool "does not require
   `OPENAI_API_KEY`", which fits a ChatGPT auth gate.

## Commands

```
# auth mode only (auth.json was never read; it does not exist in %USERPROFILE%\.codex)
codex.exe login status                       -> "Not logged in" (exit 1)

# the live probe, run once
cmd.exe /c "cd /d E:\bgos-worktrees\_tools-p5\probes\s4 && node probe-image.js"

# two zero cost stub runs (executive decision, see below)
cmd.exe /c "cd /d E:\bgos-worktrees\_tools-p5\probes\s4 && node probe-image.js --mode=stub"
cmd.exe /c "cd /d E:\bgos-worktrees\_tools-p5\probes\s4 && node probe-image.js --mode=stub --model=gpt-5.5 --tag=known"
```

The script copies the plugin's calls exactly (`src/app-server.ts`, `src/codex-host.ts` at a6a5c3a):
`initialize {clientInfo:{name:"hoai_codex",title:"Home of Agents",version:"0.3.0"},capabilities:{experimentalApi:true}}`,
`initialized {}`, `account/read`, `thread/start {cwd, approvalPolicy:"on-request", sandbox:"workspace-write",
developerInstructions}`, `turn/start {threadId, input:[{type:"text", text, text_elements:[]}]}`. The thread cwd is
the fresh empty folder `_tools-p5\probes\s4\cwd`. Server requests get the plugin's no owner answers
(`currentTime/read` answered, every `*/requestApproval` declined). Prompt: "Generate one small, simple image: a
plain gold circle on a dark background. Do not write any files." Turn cap 180 s.

## Run 1, live (the real provider), verbatim

`initialize` answered `codexHome: C:\Users\karim\.codex`. The thread started on `modelProvider: "openai"`,
`model: "gpt-6-astra"` (from `config.toml`), `reasoningEffort: "high"`.

```
{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}
```

Event order: `thread/started`, `mcpServer/startupStatus/updated` x4, the `turn/start` response
(`status:"inProgress"`), `thread/status/changed` active, `turn/started`, `item/started` + `item/completed`
`userMessage`, then `error` x5 with `willRetry:true` over WebSocket, one `warning`, `error` x5 with
`willRetry:true` over HTTPS, `thread/status/changed` `systemError`, a final `error` with `willRetry:false`, and
`turn/completed`. 14.9 s from start to end.

```
{"method":"warning","params":{"threadId":"01a0d1b7-8827-74c2-8882-b5d8555d38e5","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a3ff1d729d1ba6ab-DXB"},"emittedAtMs":1790224868352}
{"method":"error","params":{"error":{"message":"Reconnecting... 1/5","codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}},"additionalDetails":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a3ff1d72db0ead41-DXB, request id: req_7a588c496341488585817b80417cb86f","misalignment":null},"willRetry":true,"threadId":"01a0d1b7-8827-74c2-8882-b5d8555d38e5","turnId":"01a0d1b7-88b9-7411-a15b-26c69d8782f0"},"emittedAtMs":1790224868633}
{"method":"thread/status/changed","params":{"threadId":"01a0d1b7-8827-74c2-8882-b5d8555d38e5","status":{"type":"systemError"}},"emittedAtMs":1790224876311}
{"method":"error","params":{"error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a3ff1da2bcb28a0d-DXB, request id: req_a6a0d0d67a18453bba24203ed3b82151","codexErrorInfo":"other","additionalDetails":null,"misalignment":null},"willRetry":false,"threadId":"01a0d1b7-8827-74c2-8882-b5d8555d38e5","turnId":"01a0d1b7-88b9-7411-a15b-26c69d8782f0"},"emittedAtMs":1790224876311}
{"method":"turn/completed","params":{"threadId":"01a0d1b7-8827-74c2-8882-b5d8555d38e5","turn":{"id":"01a0d1b7-88b9-7411-a15b-26c69d8782f0","items":[],"itemsView":"notLoaded","status":"failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a3ff1da2bcb28a0d-DXB, request id: req_a6a0d0d67a18453bba24203ed3b82151","codexErrorInfo":"other","additionalDetails":null,"misalignment":null},"startedAt":1790224861,"completedAt":1790224876,"durationMs":14853}},"emittedAtMs":1790224876315}
```

The app server exited cleanly (code 0) when its stdin closed; no kill was needed.

## Runs 2 and 3, stub provider (executive decision, zero spend)

With the live run blocked, two runs against a local Responses stub on `127.0.0.1:8819` (P5's port range) were
added to learn what the runtime does with an image item it did not ask for. "Run it once" was about spend on
Kc's account; these cost nothing. They answer the mapping question only; any status string in them is the
stub's, not OpenAI's. Both runs: `image_gen` tool not advertised, so the stub fell back to emitting a legacy
`image_generation_call`; the runtime recorded it in the rollout and surfaced nothing
(`eventOrder: ... item/completed:userMessage, item/started:agentMessage, item/completed:agentMessage,
thread/status/changed, turn/completed`, `images: []`). No `generated_images\<threadId>` folder was created.

## The questions, answered as far as this machine allows

| Question | Answer |
| --- | --- |
| `item/started` / `item/completed` shapes for `imageGeneration` | Not observed (no login). From the 0.154.0 binary: `ImageGenerationItem` is a struct of 7 fields, `id`, `status`, `revisedPrompt`, `result`, `transparentBackground`, `failure`, `savedPath` (serde strings `idstatusrevisedPromptresulttransparentBackgroundfailuresavedPath`), plus the `type: "imageGeneration"` tag, matching the v2 schema in map part 09. `failure` is an internally tagged enum with one variant, `usageLimitExceeded {limitId, resetsAt}`. |
| Status strings | Not observed. The schema types `status` as a free string. |
| `result` present, size | Not observed. The extension decodes `b64_json` from the images endpoint; the binary also carries `[generated image]` next to `data:image/png;base64,`, which is most likely the tool output handed back to the model. Whether `item.result` is bare base64 or a `data:` URI is unknown: accept both. |
| `savedPath` set, where | Not observed on the wire. The extension saves to `$CODEX_HOME/generated_images` (here `C:\Users\karim\.codex\generated_images`) and its errors include `failed to save generated image`, `generated image exceeds the executor file size limit`, `generated image directory is not a real directory` and `generated image destination already exists`, so a `result` with no usable `savedPath` is a real case. Existing files on this machine from the Codex desktop app (Sep 6 to 12, 30 PNGs in 7 folders) are laid out `generated_images\<threadId>\exec-<uuid>.png`, which answers CODEMAP question 28 for that build: one folder per thread, one file per call id. |
| `revisedPrompt` | Not observed. The field exists; the new endpoint may or may not return one. The caption must cope with it being absent. |
| A failure field | Only the `usageLimitExceeded` variant exists. A 401, as in this run, never reaches an image item: it fails the whole turn (`turn/completed` `status:"failed"` with `error`, preceded by `error` `willRetry:false`). That is the plugin's error early return, where stage 4 also posts finished pictures. |
| Order relative to `agentMessage` and `turn/completed` | Not observed for an image. For the stub's legacy item: nothing emitted at all. |

## Surprising, and worth carrying into the stage 4 code

- **The tool tells the model the picture is already on screen.** Its output text reads: "Generated images are
  saved to <dir> by default. If you need to use a generated image at another path, copy it and leave the original
  in place unless the user explicitly asks you to delete it. The generated image is already displayed to the
  user. There is no need to render it in the final response as a Markdown image or file link." In a HOAI chat
  that is only true once the plugin posts it, which is C-21. It also means the model will usually NOT write a
  `MEDIA:` line, so the auto post is the only way the owner sees it. This matches the canon sentence.
- **Most models on this account are `tool_mode: "code_mode_only"`** (`gpt-6-astra`, the configured default, and
  every `gpt-5.6-*` in `models_cache.json`; `gpt-5.5` is not). The tool text says: "In code-mode, use the first-line
  @exec directive ... Once it finishes, return the image with generatedImage(result)." The saved file names above
  are `exec-<uuid>`, the same prefix as `commandExecution` item ids in rollouts. So under code mode the image may
  arrive from inside an `exec` cell, possibly carrying an `exec-` id. Dedupe by `item.id` still holds (every file
  had its own id), but the stage 4 tests should not assume an `ig_` style id.
- **The image path does not use the Responses stream at all** (it is a separate HTTP call), so there is no
  image progress on the Responses wire; the only signals are the `imageGeneration` item's start and completion.

## Side effects, all checked

- No image file written anywhere; `probes\s4\cwd` is still empty.
- The app server wrote one rollout per thread to `C:\Users\karim\.codex\sessions\2026\09\24\`
  (`...01a0d1b7-8827-...`, `...01a0d1b8-219b-...`, `...01a0d1ba-2781-...`). Left in place: Codex indexes them in its
  own state database, so deleting the files would leave dangling rows.
- No process left behind (every probe app server exited with code 0; a process listing filtered on the probe's
  paths found nothing).
- No credential read. `auth.json` does not exist in `C:\Users\karim\.codex`; only the account type (`null`) was logged.

## To finish the live half

Kc runs `codex login` (ChatGPT) on this machine, then `node probe-image.js` once more: one small image on his
account. Until then, suggested for stage 4 (the lead decides): write against the schema with `result` first
(decision 3 stands, and is the stronger choice now that a save is known to be able to fail), tolerate a `data:`
prefix, and treat `savedPath`, `revisedPrompt` and the exact `status` strings as unknown.
