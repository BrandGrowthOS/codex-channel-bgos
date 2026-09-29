# An answer is an UPDATE, and nothing replays an update

**Date:** 2026-09-23

**Context:** P2 stage 3 (the plan card, C-12 and C-13), the Codex daemon's plan
lane, found by the plugins review. `PlanLane.open` was an in memory Map with no
disk store and no boot sweep, and a plan answer reaches this plugin on exactly
one wire: the WS `inbound_click` event.

## Gotcha / Pattern

**A reconnect backfill replays ROWS, not FIELDS.** `BgosWs.triggerBackfill`
asks `GET integrations/inbound?since_message_id=<cursor>`, which is a query for
messages newer than a cursor. An owner answering a card does not create a
message: it stamps `answered_at` and `answer_payload` on a row that already
existed and is already behind the cursor. So there is no arrangement of the
backfill that can ever carry an answer. If the socket was down at the moment of
the tap, the daemon does not hear it late; it does not hear it at all.

That is tolerable for a wait measured in seconds. It is not tolerable for one
measured in a DAY, which is what the plan card is by design: the status line's
TTL is 1440 minutes precisely so an owner can answer tomorrow. A wait that long
makes "the daemon restarted in the middle" the ordinary case rather than an
edge, so the missing half was not a corner, it was the commonest way a plan
wait ends in silence.

**And the cost was larger than the missed turn**, because `/plan` couples the
chat's read only sandbox to its mode (`src/plan-mode.ts`) and both halves are
persisted. The chat came back read only. The owner's Go ahead never arrived, so
nothing ever restored the permission, and the agent could not do the work it
had just been approved for until somebody hand typed `/code`.

**The asymmetry was inside one tree, which is the part worth remembering.** The
approval lane in this same plugin already had both halves for the same restart:
`pending-approvals-store.ts` and `retireOrphanedApprovals`. The sibling Claude
plugin had `announceMissedPlanAnswers` for this exact case. Two working
precedents and the third lane still shipped without one, because each lane was
reviewed on its own.

## How to apply next time

When a lane parks on an owner's answer, ask the two questions together:

1. **What wire carries the answer, and is there a second one?** If the answer
   is "one event and nothing replays it", the lane needs a durable record, full
   stop. Do not reason about how likely a restart is.
2. **What does the wait HOLD while it waits?** A wait that only costs a turn can
   be lost. A wait that holds a permission, a mode or a lock cannot, because
   losing it strands the state as well as the turn.

The shape that answers both: persist the id at the moment the card is posted
(before the status line, which is the thing that says "waiting"), read each
recorded card back at connect, and make the read back do BOTH jobs. An answered
card is delivered once, with the chips stripped FIRST so a failed delivery costs
one retry and a failed strip can never mean a double delivery. An UNANSWERED
card is adopted back into the lane, which is the half that is easy to forget and
is what lets a later tap resolve against the card at all.

**Regression guard:** `test/plan-lane.spec.ts` ("a plan answered while this
daemon was DOWN") covers the record, the single delivery, the strip-then-forget
order, the adopt, the two failures that keep the entry and the day long expiry;
`test/adapter-plan-sweep-wiring.spec.ts` pins that `start()` actually calls it,
which is the line whose deletion left every other file green when the approval
lane hit the same hole; `test/pending-plans-store.spec.ts` covers the file.
