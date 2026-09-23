# "Change the plan" never arrives as `plan:change`

**Date:** 2026-09-23

**Context:** P2 stage 3 (the plan card, C-12 and C-13), lane A5, the Codex
daemon's click intake. The plan card ships three coded chips, `plan:go`,
`plan:change` and `plan:no`, and the daemon routed a click into the plan path
by parsing that code. Two of the three arrive that way. The middle one never
does, and the review that caught it is the only reason it was not shipped: every
change test called `handlePlanClick` or `PlanLane.answer` directly with a hand
written `callbackData: "plan:change"`, a shape the wire does not produce, so the
whole suite was green against a message that never exists.

## Gotcha / Pattern

**A chip whose press ARMS the composer answers with the custom sentinel, not
with its own code.** Pressing "Change the plan" (and a step's "Comment") does
not post the option at all. `MessageBubble` returns early into `armPlanAnswer`,
the composer is prefilled, and Send posts
`POST /messages/:id/callback { sentinel: "custom", customText }`. The backend's
callback route then sets `callbackData = "__custom__"` UNCONDITIONALLY for that
sentinel: it never looks at which option the owner pressed, because for a custom
reply there is no option id to look at. So the daemon receives

```
{ callbackData: "__custom__", customText: "<what the owner typed>", messageId: <the card> }
```

and `plan:change` is a code the daemon SENDS and never one it receives.

What that cost, before the fix: the click fell through to the generic "an
ordinary typed reply" path, which started a plain coding turn on the owner's
words. The revision prompt never ran, so the model was never told to propose a
REVISED plan with `supersedes`; the "Waiting for your go ahead" status line was
never cleared and sat for its full 1440 minute TTL; and the session mode was
never reported.

**The only thing that tells a plan revision from an ordinary custom reply is the
MESSAGE ID.** `__custom__` is the sentinel for every free text answer in the
app, so the daemon cannot route on the code: it has to ask whether this click
answers the card this chat is waiting on. That makes the lane's open plan map
load bearing for routing and not only for wording, which is why the predicate
(`PlanLane.isChangeClick`) is synchronous and exported rather than buried in
`answer()`.

**And the paired defect: the open plan must survive a `change`.** The lane
forgot the card on every answer, so the revised card that came back had a fresh
`plan_id`, `revision: 1`, the kicker `Plan` instead of `Plan · revised`, and no
supersede PATCH on the row it replaced. Only the first defect hid the second:
while `__custom__` fell through, nothing ever called `answer()` for a change, so
the map happened to still hold the card when the revision arrived. Fixing one
without the other would have turned an accidental pass into a real regression.
A second tap while the card is still open is harmless, because the backend
forwards only the first accepted answer of a message (the single announce
contract in `message.service.ts`).

## How to apply next time

When a chip's press arms the composer anywhere in BGOS, write down what the WIRE
carries, not what the button says, and test the intake with that shape. The
rule of thumb: any answer that carries the owner's own words arrives as
`__custom__` plus `customText` against the message id, whatever the option's
`callbackData` was.

**Regression guard:** `test/plan-card-wiring.spec.ts` ("reads the armed
composer's custom click on the card as Change the plan", plus the negative
"leaves a custom reply on some OTHER message on the generic path") drives
`handleInboundClick` with the real wire shape; `test/plan-lane.spec.ts` ("keeps
the card open on Change, so the revision that follows IS a revision") pins the
revision identity and the single supersede PATCH.
