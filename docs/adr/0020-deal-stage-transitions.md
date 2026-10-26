# ADR-0020: The stage decides whether a deal is closed

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

A deal carries three columns that describe how it ended — `closed_at`,
`probability` and `lost_reason` — and one that says where it is, `stage_id`.
MVP_SPEC M5 states two rules about how they relate: moving a deal to a **won**
stage sets `closed_at` and probability 100, and moving one to a **lost** stage
requires a reason.

The obvious implementation lets the client send all four and validates the
combination. That has three failures, in order of how hard they are to notice:

- **A deal can be won without a move.** Sending `closedAt` with no stage change
  closes a deal that is still sitting in "Negotiation". Reports that count
  closed deals and reports that count deals in won stages then disagree, and
  nobody can say which is right.
- **The rule lives in one code path.** An import, a seed, a future automation
  or a bulk edit that sets `stage_id` alone produces a won deal that is open.
  The acceptance criterion would be a property of the PATCH handler rather than
  of the data.
- **Closing is not obviously reversible.** What happens to `closed_at` and the
  reason when somebody drags a lost deal back to "Qualified"?

There is also a second, quieter question: whether a stage's _type_ may change
while it holds deals, because every deal already in it was checked against the
old type.

## Decision

### 1. The stage decides; the client never sends the closed state

`closedAt` is not in the create or update contract. The API accepts `stageId`
(and `lostReason` where one is needed) and derives the rest, in one pure
function, `resolveStageState` in `packages/core/src/deals`:

| Stage type | `closed_at`            | `probability`                                   | `lost_reason`          |
| ---------- | ---------------------- | ----------------------------------------------- | ---------------------- |
| `won`      | the moment of the move | 100                                             | none (refused if sent) |
| `lost`     | the moment of the move | 0                                               | **required**           |
| `open`     | cleared                | the caller's, else the stage default on arrival | none (refused if sent) |

Details that were decided rather than assumed:

- **`closed_at` survives an edit that leaves the stage alone.** Renaming a won
  deal does not re-close it. Moving between two closed stages does.
- **A probability sent for a closed stage is refused unless it already agrees**
  (100 for won, 0 for lost). Silently overriding it would tell the user their
  edit saved when it did not.
- **Re-opening forgets the closure.** Dragging a closed deal into an open stage
  clears `closed_at` and `lost_reason`. The history is in the audit log and the
  timeline, which is where history belongs; a column that remembered it would
  be a second source of truth.
- **A lost reason already on file stays valid while the deal stays lost**, and a
  new one replaces it. Moving _into_ lost has nothing on file, so it is asked
  for — the web app asks before sending the drag, so a drop onto "Lost"
  completes rather than failing.
- **Changing the pipeline requires naming a stage of the new pipeline.** A stage
  from another pipeline sent alone is refused, not treated as an implicit
  pipeline change, because moving a deal between pipelines is a larger edit
  than a drag and should be asked for by name.

### 2. The database restates the rule

The function is the part that produces a sentence a person can act on. The
guarantee is underneath it, in `0008_deals_module.sql`:

- `deals_assert_stage_state()` is a `BEFORE INSERT OR UPDATE` trigger that reads
  the stage's type and raises `check_violation` (constraint
  `deals_stage_state`) when the row disagrees with it. Not a `CHECK`, because
  the stage type is in another table.
- A composite foreign key `(tenant_id, stage_id, pipeline_id)` onto
  `pipeline_stages` makes "the stage belongs to the deal's pipeline" and "the
  stage is in this tenant" structural.
- `pipeline_stages_assert_type_stable()` refuses to change a stage's type while
  any deal references it. Retyping an open stage to won would leave every deal
  in it open inside a won stage, and the first rule only checks a deal when the
  deal is written. Moving the deals out first is the deliberate way to retype.
- Table checks cover the rest: amount and currency are both set or both null,
  amount is non-negative, probability is 0–100, a stage's probability is 100 if
  won and 0 if lost.

The service maps a `deals_stage_state` violation to a 422, so the day a rule is
changed in one place and not the other the caller gets an answer rather than a 500.

### 3. A move is one event

A drag changes the stage and, with it, three other columns. It is announced as
a single `deal.stage_changed.v1` event carrying both stage names, which the
worker's timeline projection words as "Moved from Qualified to Proposal". A
`deal.updated.v1` is published only when something _else_ changed in the same
request, listing only those fields. The audit row is one `update` entry whose
diff contains the stage and the derived columns.

## Consequences

- The only way to win a deal through the API is to move it to a won stage. A
  client that wants to "mark won" moves the card.
- Anything that writes `deals` outside the API — import, seed, a future
  automation — is held to the same rule by the trigger, and finds out at write
  time rather than in a report.
- Retyping a stage that holds deals is a two-step operation (move the deals,
  then retype). That is the intended friction; the stage editor (M9) should say
  so rather than surface a constraint name.
- Probability on an open deal is free text between 0 and 100, not derived. A
  forecast that weights by probability reads the column; one that wants "what
  the stage implies" reads the stage. Both are available and they are allowed
  to differ — a rep's judgement is the point of editing it.

## Alternatives considered

- **Accept `closedAt` from the client and validate.** Rejected for the three
  reasons above.
- **Only a service-level rule.** Rejected: the second reason. The accounts
  module already made this choice for hierarchy (ADR-0018) and the argument is
  the same.
- **Derive `closed_at` in a trigger and omit it from the service.** Considered.
  It would make the column correct without any application code, but the
  service still has to produce the lost-reason sentence, the probability
  default and the event payload, so the rule would exist twice either way. The
  trigger stays as a check rather than as the source.
- **Keep the closure on re-open (a `reopened_at`).** Deferred: nothing in P0
  reads it, and the audit log has it.
