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

## Round 4: the re-review's items (2026-09-24)

The re-review (`_tools-p5/s4-fix-result.json`, `result.rr.defects`) raised seven items and the orchestrator decided
each one. Item 5 is the BGOS PR's (its own red proofs, Round 4) and item 7 (the ledger) is the orchestrator's. Every
change below was written test first. Logs are `_tools-p5/logs/s4-fix2-*.log`. Commits: `5ec35c5` (items 2, 3 and 4),
`e49c6c5` (item 6), `acefd7d` (item 1), and this report.

| Item | What changed | Red before the code | Proof for a guard that could not be red |
| --- | --- | --- | --- |
| 1 hold | `publish.yml`, the `interactions.ts` marker paragraph and the README (paragraph and promote comment) keep "adds no hold of its own" and add: promoted only after one logged in live image turn confirms the real item (result bytes and their form, revisedPrompt, savedPath, the failure shape; probe.md, decision 7) | 1: `publish-workflow.spec.ts` "holds 0.14.0 for the live image turn in all three texts a release reads" | none needed |
| 2 not shown | `imageNotShownLine` in `generated-images.ts` replaces the single line. A saved copy: "Codex made a picture, but it could not be shown here. It is saved at <path>." with the path shortened by the existing `shortenPath` (`activity-markers.ts`, the one every row uses: `~` under the home directory, else the file and its folder). Bytes but no saved copy (an upload lost, the tool's own save failed): "Codex made a picture, but it could not be shown here." Neither: "Codex tried to make a picture, but it could not be shown here." Dedupe by line text and the silence after a Stop are kept | 9: five pure cases in `generated-images.spec.ts`, four in `adapter-image-posts.spec.ts` (the saved line on a failed upload, the made line with no saved copy, the tried line with no `made`, the saved only item) | S1 below, for the Stop case, which now also carries a saved only item and an empty one |
| 3 requests | `executeAndReply` passes `onRequest: async (...) => { await earlier; return this.tools.handleRequest(...) }`, so an approval card or an ask from the turn after a Stop lands after the stopped turn's pictures | 1: "holds the next turn's approval card until the stopped picture has posted" | none needed |
| 4 handover | `ActiveTurn.handedOff` (required, set in both constructors): the ids handed to `onPlanProposal` are recorded when the plan item arrives (and only when a callback is there to take them), and `execute` skips them when it copies an adopted turn's pictures. The signal's pictures are now taken at the plan item itself rather than a microtask later | 1: `codex-host.spec.ts` "does not hand an owner turn a picture the adopted turn already handed to its plan card" (a picture after the card still carries across) | none needed |
| 6 voice | Decision: keep the hint only scope. The dispatch path posts no standard message into the target chat: its result goes to `POST /integrations/voice-tasks/:taskId/result`, which settles the voice task row, the Work Stream, the delegated task card and, after a call only, a ring back or a result card; the consult returns its text to the call. The voice clause now names the consult, which has no HOAI tools and is told to send nothing: it says the picture is saved on this machine and describes it. "In the workspace" would be false there: the runtime saves to `$CODEX_HOME/generated_images` (probe.md). A voice task keeps the reply tool, which its tool context really has | 2 in `capabilities.spec.ts`: word for word, and the consult case | none needed |

Totals: **14 tests red before their code** (`s4-fix2-red-plugin.log`: `Tests 14 failed | 166 passed (180)`), each
for its named reason (a missing function, the old line, the approval before the picture, the handed off picture in
the owner's result, the old sentence, the missing hold clause).

**Mutation S1** (`s4-fix2-mut-S1-stop-lines.log`): dropping `opts.picturesOnly ||` from the line guard in
`postGeneratedImages` turns "posts the pictures that finished before a Stop, and nothing else" red (1 failed, 26
passed); `src/adapter.ts` was restored and its sha256 checked identical.

```
the five changed files (s4-fix2-green-plugin.log): Test Files  5 passed (5)   Tests  180 passed (180)
whole plugin suite (s4-fix2-full-suite.log):      Test Files  77 passed (77)  Tests  1103 passed | 1 skipped (1104)
tsc --noEmit -p tsconfig.json (s4-fix2-tsc.log):  exit 0, no output
```

The hint sentence as it now reads (src/agent-hints.ts, pinned word for word as `SERVED_TRUTH` in
test/capabilities.spec.ts):

> In a chat turn, a picture you make with image generation posts itself to the chat when the turn finishes, with its
> prompt as the caption; do not send it again with MEDIA: or the reply tool. If it cannot be shown, the chat says so
> in one plain line. In a meeting, a voice task or a consult nothing posts it: a meeting takes text only, so describe
> the picture there; in a voice task copy it into the workspace and send it with the reply tool; and a consult sends
> nothing, so say the picture is saved on this machine and describe it.

**Byte identity with the BGOS canon.** sha256 of the sentence, UTF-8, 530 bytes:
`fe528db206e5ac09a296e624695e368f87bfb9fe904111305b0a889da436db98`, the same for the flattened text in
`src/agent-hints.ts`, `SERVED_TRUTH`, the BGOS `CODEX_GENERATED_IMAGES_SENTENCE` (after its `- `), the BGOS spec's
`SENTENCE` and the BGOS mirror line. The second sentence did not quote the old line ("the chat says so in one plain
line"), so it stays as it was and stays true.

**Known limits, named.** A picture that finishes after a plan item still posts after that card (Round 3). An adopted
goal turn's requests do not wait for a stopped chat turn's pictures, because only an ordinary turn reads
`pictureTails`. And the live image turn has still not run here: Codex is not logged in on this machine, which is
exactly why item 1 holds 0.14.0 for it.

## Round 5: the warning a held release prints, and made versus tried (2026-09-24)

Two items, each written test first. Logs are `_tools-p5/logs/s4-fix3-*.log`. Commits: `0dce17b` (item 2), `23110ed`
(item 1), and this report.

| Item | What changed | Red before the code | Proof for a guard that could not be red |
| --- | --- | --- | --- |
| 1 warning | The `Held from latest` step in `publish.yml` printed one version's reason (the backend that clamps 0.10.1's approval hold) for every held version, then the promote command, so for 0.14.0, which needs no backend, it read as "promote now". Its `::warning::` now says to promote only when the reason the version is held is met, written beside it in the `HELD_FROM_LATEST` comment and in the README promote block. For 0.14.0 a second `::warning::` names its own condition: with 0.13.0 or after it, never before, and only after one logged in live image turn confirms the real item (result bytes and their form, revisedPrompt, savedPath, the failure shape; probe.md, decision 7). The command is printed last | 1: `publish-workflow.spec.ts` "never hands anyone a bare promote command when a held version lands on next", which reads what the step PRINTS (its `echo` lines and the version branch each sits in), not its comments | W1 to W3 below |
| 2 made | `collectGeneratedImage` records `returnedOutput: true` when the item carried a non empty `result` string, BEFORE decoding, so the fact survives a result that is not a picture or is over the image cap; the string itself is never kept. `imageNotShownLine` says the "made" line when bytes decoded OR something came back, and "tried" only for an empty or absent result with no `savedPath`. A failure item is unchanged | 7: in `generated-images.spec.ts`, three collection cases (not a picture, over the cap, a picture that decoded) and three line cases (the pure made case, then not a picture and over the cap through the real collector, both with no `savedPath`: "made", never "tried"); in `adapter-image-posts.spec.ts`, both items in one turn post the one made line and no "tried" | G1 to G3 below; the "records nothing returned" cases (empty, blank, absent, not a string) and "still says only tried" pin the other side and were green before and after |

Totals: **8 tests red before their code** (`s4-fix3-red-plugin.log`: `Tests 8 failed | 67 passed (75)`), each for
its named reason: the general warning line missing (`expected -1 to be greater than or equal to 0`),
`returnedOutput` undefined, and "Codex tried to make a picture" where "Codex made a picture" was expected, in the pure
line and in the adapter's posted lines. Reproduced after the fact against the HEAD `09ca106` versions of the four
changed source files with the new tests (`s4-fix3-red5-rerun.log`, same 8 failed, 67 passed, files restored and
their sha256 checked identical).

**Mutations**, each applied to the fixed tree, run against the three changed spec files, then restored with its
sha256 checked identical (`s4-fix3-mut5-<name>.log`, the same results as the first run in `s4-fix3-mut-<name>.log`):

| Mutation | What it does | Result |
| --- | --- | --- |
| W1 command first | prints `npm dist-tag add ...` before the warning | 1 red: "the promote command is printed before the condition that gates it" |
| W2 no 0.14.0 warning | drops `::warning::` from 0.14.0's own line | 1 red: "the warning does not name 0.14.0's condition" |
| W3 one reason for all | prints "once the BGOS backend that clamps the approval hold is deployed" for every version | 1 red: "a line printed for every held version names one version's backend" |
| G1 line ignores it | `imageNotShownLine` reads only the bytes again | 4 red (three line cases, the adapter case) |
| G2 no trim | a blank `result` counts as returned | 1 red: "records nothing returned for a result of only spaces" |
| G3 only when decoded | `returnedOutput` set only when the result decodes | 5 red (two collection cases, two line cases, the adapter case) |

```
the three changed spec files (s4-fix3-green-plugin.log): Test Files  3 passed (3)   Tests  75 passed (75)
whole plugin suite (s4-fix3-full-suite.log):             Test Files  77 passed (77)  Tests  1116 passed | 1 skipped (1117)
tsc --noEmit -p tsconfig.json (s4-fix3-tsc.log):          exit 0, no output
```

The two lines the step now prints before the command, as a run summary shows them for 0.14.0:

> 0.14.0 was published under the npm dist tag next, not latest, so nothing installs it by default. Promote it only
> when the reason it is held is met: that reason is written beside 0.14.0 in the HELD_FROM_LATEST comment in this
> workflow and in the promote block of the README.

> 0.14.0 needs no backend of its own. It is promoted only with 0.13.0 or after it, never before, and only after one
> logged in live image turn confirms the real item (result bytes and their form, revisedPrompt, savedPath, the failure
> shape; probe.md, decision 7).

**Known limit, named.** `returnedOutput` is evidence the runtime handed something over, not that it was a picture: a
non empty result that is not an image still reads "made". That is the truthful reading of an item the runtime marked
finished with output, and the live image turn that holds 0.14.0 is what confirms the real result's form.

## Round 6: the premium review's owner facing items (2026-09-24)

The premium pass (`_tools-p5/s4-premium.md`) ranked six items; the orchestrator took all six. This round carries items
1, 2, 3, 5 and 6, each written test first; item 4 (the AFTER frames and the gate page) is evidence, not code, and is
not in this round. Logs are `_tools-p5/logs/s4-close-*.log`. Commit: `748ec4e`, and this report.

| Item | What changed | Red before the code | Proof for a guard that could not be red |
| --- | --- | --- | --- |
| 1 reset | `imageFailureLine` says "Codex has used up its picture limit for now. It resets in about 2 hours.", relative to the moment it posts, never a clock time: the plugin cannot know the viewer's zone and this host's zone need not be the owner's; the bubble's timestamp anchors the phrase. Buckets: `in a moment` under a minute, `in about N minutes` under an hour, `in about N hours` under two days, else `in about N days`, each count rounded and the bucket chosen by the ROUNDED count. A reset already past, exactly now, or none, not finite, zero or negative: the line ends after `for now.`. Seconds and milliseconds both still read. The adapter measures from one clock reading per turn (`TurnPictures.clockMs`), so two pictures refused by the same limit stay one line | 22 in `generated-images.spec.ts` (the headline line, ten buckets, milliseconds, past and exactly now, six missing or bad resets, the real clock, "no clock time, date or zone"); 3 in `adapter-image-posts.spec.ts` (the limit line, the lost plan card beside a refusal, and the clock case on its wording) | C1, C2, C5 below |
| 2 name | `imageFileName` keeps the last 8 safe characters of the id: `codex-image-d1ba2874.png` for `ig_01a0d1ba2874`, `codex-image-7c0d9f13.png` for `exec-8c1f3a52-5b7e-4d19-9a60-2e4b7c0d9f13`, 24 characters at most. The adapter fixtures now carry the real name | 2: the `ig_` and `exec-` cases | the short id (`codex-image-ig_1.png`) and the all unsafe id (`codex-image-1.png`) pin the other side, green before and after |
| 3 tried | `IMAGE_TRIED_NOT_SHOWN_LINE` is "Codex tried to make a picture, but nothing came back." ("could not be shown" implied a picture existed) | 3: the two pure cases and the adapter's tried case | none needed |
| 5 range | `withoutDashes` first turns an en dash closed up between two digits into " to " (`2024 to 2026`, `3 to 4 people`, `1 to 2 to 3`), then every other dash into a comma. A spaced en dash is the parenthetical dash, even between numbers, so it stays a comma | 2: the ranges, and a range beside an em dash | C3, C4 below; "keeps a spaced en dash between numbers a pause" was green before and pins the scope |
| 6 cap | `IMAGE_CAPTION_PROMPT_MAX` is 200 (two or three lines on a phone; 280 was about nine) | 1: the pin, and a 239 character prompt clipped on a word to between 181 and 200 | none needed |

Totals: **33 tests red before their code** (`s4-close-red-plugin.clean.log`: `Tests 33 failed | 63 passed (96)`),
each for its named reason: the 40 character names, `2024, 2026` where `2024 to 2026` was expected, `280` where `200`
was, the old "could not make a picture because the image generation limit is used up ... UTC" line where the
relative one was, a UTC time where none may be, and "but it could not be shown here" where "but nothing came back"
was.

**Mutations**, each applied to the fixed tree by `_tools-p5/s4-close-mutate.py`, run against the two changed spec
files, then restored with its sha256 checked identical (`s4-close-mut-<name>.log`):

| Mutation | What it does | Result |
| --- | --- | --- |
| C1 clock per line | the adapter passes `Date.now()` to every line instead of the turn's one reading | 1 red: "reads the clock once a turn, so one limit stays one line while the clock moves" (a clock that jumps a day per read splits the limit into two lines) |
| C2 unrounded bucket | the minutes bucket is chosen by the raw time left, not the rounded count | 1 red: "59 minutes 40 seconds (never 60 minutes)" |
| C3 spaced range | the range rule also takes a spaced en dash | 1 red: "keeps a spaced en dash between numbers a pause" |
| C4 range after comma | the comma pass runs before the range pass | 2 red: both range cases |
| C5 past kept | a reset already past is not dropped | 2 red: "already past" and "exactly now" |

```
the two changed spec files (s4-close-green-plugin.log): Test Files  2 passed (2)    Tests  96 passed (96)
whole plugin suite (s4-close-full-suite.log):           Test Files  77 passed (77)  Tests  1144 passed | 1 skipped (1145)
tsc --noEmit -p tsconfig.json (s4-close-tsc.log):        exit 0, no output
```

**The served sentence is untouched.** sha256 of the hint sentence, UTF-8, 530 bytes, after this round:
`fe528db206e5ac09a296e624695e368f87bfb9fe904111305b0a889da436db98` in `src/agent-hints.ts`, `SERVED_TRUTH`, the BGOS
`CODEX_GENERATED_IMAGES_SENTENCE`, the BGOS spec's `SENTENCE` and the BGOS mirror line. The BGOS mirror paragraph
quotes none of the changed strings (it says only that the plugin "posts one plain line when a picture cannot be
shown"), and no other file on the BGOS branch does, so the BGOS worktree is unchanged by this round.

What the owner now reads:

> Prompt: A plain gold circle centred on a dark charcoal background

> Codex made a picture, but it could not be shown here. It is saved at ~\.codex\generated_images\thread-1\ig_1.png.

> Codex made a picture, but it could not be shown here.

> Codex tried to make a picture, but nothing came back.

> Codex has used up its picture limit for now. It resets in about 2 hours.

and the picture's file name, in the viewer strip, the photos card, the Artifacts card and the saved file:
`codex-image-7c0d9f13.png`.

**Left for item 4's lane, named.** The gate page (`before-after.html`) still shows the old limit line twice in
section 05 (the two kit drawn bubbles, "It resets 2026-09-24 08:53 UTC.") and its section text says "naming the reset
time"; the AFTER frames that show a file name show `exec-8c1f3a52-5b7e-4d19-9a60-2e4b7c0d9f13.png`, where the plugin
posts `codex-image-7c0d9f13.png` for that id.
