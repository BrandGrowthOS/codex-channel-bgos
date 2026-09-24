# P5 stage 4 (C-21): red proofs

**Date:** 2026-09-24 (Asia/Dubai), branch `feat/p5-image-posts`, stacked on `feat/p2-file-diffs` (a6a5c3a, 0.12.0).
**Rule followed:** every new test was written and run RED before the code it covers. A test that cannot be red
before the code (a "nothing happens" guard) carries a mutation proof instead, listed below.
**Runner:** vitest through `_tools-p5/suite.sh`, always `--minWorkers=1 --maxWorkers=4`, one suite at a time.
Raw logs (ANSI stripped copies beside them) live in `E:\bgos-worktrees\_tools-p5\logs\s4-*.log`.

## Fixtures, and what is not real

The live probe could not make a picture (this machine's Codex is not logged in, see `probe.md`), so no
`imageGeneration` item was ever seen on the wire. `test/fixtures/image-generation.ts` therefore uses:

- REAL envelopes: `item/started {item, threadId, turnId, startedAtMs}` and `item/completed {item, threadId,
  turnId, completedAtMs}`, copied from the probe's `raw.jsonl`, ids included.
- The REAL failed turn: the probe's own `turn/completed` (status `failed`, the 401 `error` object, the clock),
  with only the request id and cf-ray shortened.
- The SCHEMA item: the seven fields the 0.154.0 binary serialises for `ImageGenerationItem`, in its order (id,
  status, revisedPrompt, result, transparentBackground, failure, savedPath) plus the `type` tag, with a real
  64 by 64 PNG as `result`. Status strings are guesses the code does not read; ids come in both `ig_` and
  `exec-` styles.

## Round 1: every new test file, before any code (`s4-red-1.log`)

`test/generated-images.spec.ts test/codex-host.spec.ts test/activity-markers.spec.ts test/outbound-media.spec.ts
test/adapter-image-posts.spec.ts test/capabilities.spec.ts`

```
 FAIL  test/generated-images.spec.ts [ test/generated-images.spec.ts ]
Error: Failed to load url ../src/generated-images.js ... Does the file exist?
 Test Files  6 failed (6)
      Tests  31 failed | 149 passed (180)
```

The 31 red (reason in brackets):

- host, `pictures a turn made` (7): keeps a finished picture once [Target cannot be null or undefined]; carries a
  refused picture with its failure [undefined is not iterable]; keeps two pictures in order [reading 'map' of
  undefined]; still draws the image row on both phases, named from savedPath [the completed row had no path and
  the refused row read done]; hands the watchdog's result the pictures [Target cannot be null]; carries a picture
  through the probe's 401 turn [Target cannot be null]; hands an adopted turn's pictures to the owner turn
  [expected undefined to deeply equal [ 'ig_01a0d1ba2874' ]].
- mapper (3): the fixed single image path fixture [expected undefined to be 'out.png']; reads savedPath, never
  the base64 [expected undefined to be '~\.codex\generated_images\t1\ig_1.png']; a refused picture in its error
  colour [expected 'done' to be 'error'].
- adapter (11): THE DECISION GUARD [expected [ 'turn resolved', ...(2) ] to deeply equal [ 'turn resolved',
  ...(3) ]: no picture was posted at all]; every picture in order with its own prompt; before an ask; before
  buttons; no fallback when a picture posted [spy called 0 times]; the fallback when every picture failed [spy
  called 0 times]; one plain line for a refused picture; drops a MEDIA: line naming the posted picture; posts on
  the error early return [expected [ 'finalize', 'error' ]]; posts before a Stop [expected [ 'finalize' ]]; the
  adopted deliver path.
- outbound (9): publishMediaBuffer x3 [publishMediaBuffer is not a function]; sendImageBytes x5
  [out.sendImageBytes is not a function]; the reply handle's peer route [handle.sendImageBytes is not a function].
- hint (1): the sentence word for word [expected '# BGOS Channel, Agent Capabilities ##...' to contain 'A picture
  you make with image generat...'].

## Round 2: the pure module against a do nothing stub (`s4-red-2.log`)

Round 1 could only show `generated-images.spec.ts` failing to LOAD, which says nothing per test. So a stub
exporting every name and doing nothing (null, undefined, empty string, zero caps) was put in place and the spec
run again:

```
 Test Files  1 failed (1)
      Tests  17 failed | 7 passed (24)
```

Red (17): decodes bare base64; accepts a data: URI; trusts the bytes over a data: label; the cap case [expected
+0 to be 10485760]; keeps bytes, prompt and saved path; carries a refusal; keeps a picture whose save failed;
exec- ids; the five caption cases (Prompt:, dashes to commas, no dangling comma, word boundary clip, one line);
the four failure line cases.

The 7 that passed against the stub are the "nothing happens" guards (null for an empty string, for no string,
for bytes that are not a picture, for a non base64 data: URI; nothing from an item with no id; no caption without
a prompt; no dash in any line). Each has a mutation proof below.

After round 2 two cases were SHARPENED, because a mutation showed they could not fail: the cap case used a run of
"A"s, which decodes to zeros that are not a picture, so it stayed green with the cap removed; it now puts a real
PNG header in front of 10 MB of padding, plus a picture under the cap that must decode. The non base64 data: URI
case used "hello"; it now carries a real PNG's base64, so only the `;base64` check can refuse it.

## Green (`s4-green-1.log`, then the whole suite)

```
target files (8): Test Files  8 passed (8)   Tests  248 passed (248)
whole plugin suite (s4-full-suite.log): Test Files  77 passed (77)   Tests  1070 passed | 1 skipped (1071)
tsc --noEmit -p tsconfig.json (s4-tsc-final.log): exit 0, no output
```

Baseline before the stage (`s4-baseline.log`, the 7 files it touches): 193 passed.

## Mutation proofs (`s4-mutations.txt`, one log per mutation `s4-mut-<name>.log`)

Each mutation was applied by a script, the named spec run, and the source restored from a copy and compared
byte identical (`filecmp`, shallow off) before the next one. M1 was applied and restored by hand, compared with
`cmp`.

| # | Mutation | Red case(s) |
|---|---|---|
| M1 | THE SUPERSEDED PLAN: post each picture from an `onImage` callback inside the turn, and not at the end | the decision guard: `"image:Prompt: ..."` lands BEFORE `"turn resolved"` |
| M2 | post the pictures AFTER the text | the decision guard, every picture in order, before an ask, before buttons, no fallback when a picture posted, one line for a refusal, the adopted path (7) |
| M3 | count ATTEMPTED posts, not landed ones | the fallback when every picture failed to post |
| M4 | remember a picture's saved path before knowing it landed | keeps the MEDIA: line when the picture could not be posted |
| M5 | no post in the error early return | still posts the picture when the turn then failed with no text |
| M6 | no post in the Stop branch | posts the pictures that finished before a Stop |
| M7 | post a picture with no bytes | posts nothing for a picture with no usable bytes |
| M8 | no dedupe of refusal lines | one plain line for a refused picture |
| M9 | the Stop branch posts refusal lines too | posts the pictures that finished before a Stop, and nothing else |
| M10 | keep a MEDIA: line naming the posted picture | drops a MEDIA: line naming the picture it already posted |
| M11 | the adopted deliver drops `images` | an adopted goal turn posts its pictures |
| H1 | collect on `item/started` too | adds nothing on item/started alone; once however often it completes |
| H2 | `return` after collecting, like the plan branch | still draws the image row on both phases |
| H3 | no seed of the adopted turn's pictures in `execute()` | hands the pictures an adopted turn finished to the owner turn |
| H4 | `result()` leaves `images` out | 6 of 8 host cases (every one that reads the result) |
| H5 | key each completion separately (no dedupe) | keeps a finished picture once, however often it completes |
| P1 | decode with the 100 MB attachment cap instead of the 10 MB image cap | refuses a real picture over the 10 MB image cap |
| P2 | drop the `;base64` check | returns null for a data: URI that is not base64 |
| P3 | default an unknown picture to image/png | returns null for bytes that are not a picture |
| P4 | collect an item with no id | collects nothing from an item with no id |
| P5 | a caption without a prompt | has no caption without a revised prompt |
| P6 | an em dash in a failure line | an unknown failure kind; no em dash and no en dash in any line |
| P7 | keep the model's dashes | dashes to commas; no dangling comma |
| P8 | cut mid word | clips on a word boundary |
| A1 | read `savedPath` for `imageView` too | still reads an imageView row's own path, plus two older table cases |
| A2 | `failed()` ignores `failure` | draws a refused picture in its error colour |
| A3 | read `path` for `imageGeneration` again (the old defect) | the fixed fixture; reads savedPath, never its base64 |
| C1 | change one word of the hint sentence | the sentence word for word |

27 scripted mutations plus M1, every one red on its named case, every one restored.

## Not proven here

- No live picture: the real `imageGeneration` item, its status strings, whether `result` is bare base64 or a
  `data:` URI, and whether `revisedPrompt` comes back were NOT observed (see `probe.md`). The code reads none of
  the status strings, decodes both result forms and captions nothing without a prompt.
- No app side check: the app already renders an agent image in the chat, the viewer, the gallery and Artifacts;
  that is the next lane's visual pass, once one live Codex image turn is possible on a logged in machine.

## Round 3: the review fixes (2026-09-24, after the 12 findings)

The review (`_tools-p5/s4-findings.json`) found 10 real findings; #10 (the caption as markdown) and #11 (first
wins dedupe) were refuted and are not touched. Every fix below was written test first. Logs are
`_tools-p5/logs/s4-fix-*.log`; the mutation runner restores each file from a copy and compares it byte identical
before the next mutation (`s4-fix-mutate.py`, `s4-fix-mutate2.py`).

| Finding | Fix | Red before the code | Proof for a guard that could not be red |
| --- | --- | --- | --- |
| 1 version | 0.14.0, still stacked on #15 (P2 stage 5 holds 0.13.0 and is not pushed) | `publish-workflow.spec.ts`: "0.14.0 belongs in HELD-FROM-LATEST" (`s4-fix-red-version.log`) | none needed |
| 4 past turns | `excludeTurns: true` on both resumes and the fork; the legacy upgrade pages `thread/turns/list` (summary, newest first, 4 a page) instead of `thread/read {includeTurns:true}` | 6 red: fork, both resumes, paging, budget (`s4-fix-red-history.log`) | H6 (a metadata read with turns), H7 (a page failure that throws), H8 (no budget stop): all red |
| 8 queued | `deliver()` rejects a spooled send with `OutboundSpooledError`; a queued picture counts as posted | 1 red plus the adapter case | F8b (every failure called spooled), F8a (queued counted as lost): red |
| 2 cards | pictures post above the fallback plan card; a card raised mid turn (ordinary and adopted) posts the pictures finished so far first (`PlanProposalSignal.images`), and the end of the turn skips them | 4 red (fallback, mid turn, adopted, the host's signal) | F2a, F2b, F2c: red |
| 3 not shown | one plain line, once a turn: "A picture was made, but it could not be shown here." for no bytes or a failed upload; quiet on Stop | 2 red (the two old cases rewritten) | F3a, F3b: red |
| 6 Stop | mission, steps and card close first; pictures post in the background after the stop line (held by /stop, /new and the voice stop_turn); the next turn starts at once and its posts wait for them | 3 red (the rewritten Stop case, the stop line, the next message) | F6a, F6b, F6c: red |
| 7 lost plan | guard `(planCardFailed \|\| pictures.posted === 0)` | 2 red | F7: red |
| 9 copies | a MEDIA: line is dropped by real path or by sha256 of the bytes (read only through the media guard, pictures only, 10 MB cap) | 2 red (a copy, a respelled path) | F9a, F9b, and F9c for the control that passed before the code |
| 5 hint | the sentence is scoped to the chat turn, says what a meeting or a voice task does, and that a picture that cannot be shown is reported | 2 red (`s4-fix-red-hint.log`) | none needed |
| 12 evidence | the gate page and its frames are committed with this report | not a test | not a test |

Totals: 25 tests red before their code, 17 mutations red on their named case (H6 to H8, F2a to F9c), every file
restored.

```
whole plugin suite (s4-fix-full-suite.log): Test Files  77 passed (77)   Tests  1092 passed | 1 skipped (1093)
tsc --noEmit -p tsconfig.json (s4-fix-tsc.log): exit 0, no output
```

The hint sentence as it now reads (src/agent-hints.ts; the BGOS PR's served canon copies it):

> In a chat turn, a picture you make with image generation posts itself to the chat when the turn finishes, with its
> prompt as the caption; do not send it again with MEDIA: or the reply tool. If it cannot be shown, the chat says so
> in one plain line. In a meeting or a voice task nothing posts it: a meeting takes text only, so describe the
> picture there, and in a voice task copy it into the workspace and send it with the reply tool.

### The 0.154.0 schema and one more probe, for finding 4

`codex app-server generate-ts --experimental` on the vendored binary (output under
`_tools-p5/probes/s4/schema-0.154`, not committed): `ThreadResumeParams.excludeTurns` and
`ThreadForkParams.excludeTurns` return "only thread metadata ... without populating `thread.turns`";
`ThreadReadParams.includeTurns` says full hydration "is deprecated for paginated threads; prefer a metadata-only
read and page with `thread/turns/list`"; `ThreadTurnsListParams` takes `cursor`, `limit`, `sortDirection`
(default descending) and `itemsView` (default summary).

A zero cost probe (`_tools-p5/probes/s4-turns/probe-turns.js` and `run.out`, not committed) ran the vendored app
server against an isolated `CODEX_HOME` holding copies of this stage's own two stub probe rollouts (no owner
content, no auth file, no model call; the folder was deleted afterwards). Once the thread was loaded, a summary
turn carried its `userMessage` and `agentMessage`, `nextCursor` and `backwardsCursor` behaved as the schema says,
and `thread/resume {excludeTurns:true}` answered 1,983 characters with no turns. A thread the fresh index had not
seen answered every paged read, and the old full read, with no turns at all; the upgrade then starts the new
thread without the old text, as it did before.

### The gate page and its frames

`before-after.html` and `shots/` (before, after, the fixture banner and the artifacts count probe) are the approved
look for this stage, made by the frames lane before the review. They are committed as approved and not edited, so
three things on the page predate the fixes above: it names 0.13.0 (now 0.14.0), it says a picture that could not
be uploaded "falls back to today's behaviour" (it now posts the one plain line), and it quotes the earlier, unscoped
hint sentence (now the one above). The raw probe files stay under `_tools-p5` and are not copied here.
