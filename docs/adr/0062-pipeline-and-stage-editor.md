# ADR-0062: The pipeline and stage editor: ordering, retiring and moving deals

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

Until now a company's pipeline was written once, by provisioning, and read ever after. The pilot simulation
reported that a company cannot change it. A coaching institute wants a short pipeline and a trader a long one.
MVP_SPEC M5 and M9 call for custom stages with a probability and a won or lost type; every Zoho paid plan has
the editor (docs/research/zoho-gap-analysis.md).

Facts that shape the design, found in the code rather than assumed:

- Deals point at a stage through a composite foreign key, and a database trigger ties a deal's `closed_at`,
  `probability` and `lost_reason` to its stage's type (ADR-0020). A lost deal must carry a reason. Another trigger
  already freezes a stage's type while any deal (live or in the Recycle Bin) is in it.
- Stages had no version, no way to be retired, and positions that were only sorted (the seed spaces them by ten).
- The dashboard's "won this month" is the deals in won stages with `closed_at` inside the month; "open pipeline" is
  the open stages. A timeline entry names the stages from the event payload, not from the stage row.
- Bulk edit deliberately excludes stage changes (ADR-0056); imports and saved views refer to a stage only by id.

## Decision

1. **Stages are retired, never deleted.** `archived_at` (and who) marks a stage out of use. Deals, history, exports
   and old events keep pointing at a real row, a retired stage can be restored, and a won deal stays won whatever
   became of its stage. A retired stage gives up its name and its position (partial unique indexes), so a new stage
   may reuse the name.

2. **Order is a dense integer, rewritten whole, under a lock.** Positions of the stages in use are 0, 1, 2 ... A
   reorder names every stage in use, once, and the pipeline's `version`. It runs in one transaction that first takes
   the pipeline row `FOR UPDATE`, so two edits to one pipeline happen one after the other. The rewrite is two steps
   (stages already placed go to negative numbers, then each takes its final position) so a unique index on
   `(tenant, pipeline, position) WHERE archived_at IS NULL` can stay on as the backstop rather than being dropped
   for the move. Two reorders sent at once: the first applies, the second carries a stale version and gets 409. A
   list that omits, repeats or invents a stage is refused whole; nothing is "fixed up", because that is where a
   duplicated position would come from. Fractional or gapped positions were rejected: they need periodic
   renumbering and give no benefit at 20 stages.

3. **A pipeline always has one open, one won and one lost stage in use, open stages first, at most 20.** The
   constants and the checks are in `@crm/core` (`pipelines`), used by the API and mirrored in the screen. Open
   first keeps the board reading left to right as "in progress, then finished". The cap is a constant, not a plan
   limit.

4. **Two versions.** A stage has a `version` for rename, probability and type; the pipeline has one that moves
   whenever the set or order of its stages does. A stale editor gets 409, never an overwrite.

5. **A stage's type can change only when no deal is in it.** The database trigger already says so; the service
   checks first and answers with a sentence. Won is always 100 and lost always 0 (a CHECK says so too).

6. **Retiring a stage that holds deals names a target, and the deals move in the same transaction.**
   - The target is in use, in the same pipeline, and **of the same type**: open to open, won to won, lost to lost.
     Moving open deals into a won stage would win every one of them in one click; into a lost stage it would need a
     reason per deal. Both are refused; winning and losing stay a per-deal act on the board. (This narrows the
     original brief, which asked to test moving "into won and lost": that is tested as won to won, lost to lost, and
     the refusal of the rest.)
   - Each deal goes through `resolveStageState`, the version guard and the database trigger, as a drag does, and
     gets its own audit entry and `deal.stage_changed.v1` event (marked `reason: stage_retired`), so the timeline
     reads "Moved from X to Y". One difference, explicit and tested: **a won or lost deal keeps the date it closed
     and its lost reason** (`keepClosedState`). Tidying a pipeline is not a deal being won again, and re-stamping
     `closed_at` would move "won this month".
   - Deals in the Recycle Bin move too; otherwise a restore would put a deal in a retired stage. A database trigger
     refuses both retiring a stage that still holds a deal and placing a deal in a retired stage, so an import or a
     script cannot do either.
   - It is authorized by `pipeline:delete`, not limited by the caller's deal record scope (it is configuration), but
     it also requires `update` on deals at `all` scope, so a role that sees only its own deals cannot reassign
     everyone's.
   - At most 2000 deals per retirement, because each gets an audit row and an event inside one transaction. Above
     that the request is refused with the number and asks for some to be moved first. A background job is the
     follow-up if a company outgrows this.

7. **Placement races are closed with row locks.** Putting a deal in a stage takes the stage row `FOR SHARE`; the
   retirement takes it `FOR UPDATE` before it moves anything. A deal being placed and a stage being retired
   therefore serialize, and the one that waits re-reads the row.

8. **A new object type, `pipeline`** (read, create, update, delete; `all` scope only), granted to Owner and Admin by
   provisioning and backfilled for existing companies by migration 0024, as `tenant_settings` was in 0017. `deal`
   grants never imply it. `GET /pipelines` (the board's list of stages in use) stays on `deal:read`;
   `GET /pipelines/manage` (retired stages, deal counts) needs `pipeline:read`.

9. **Its own module.** `pipeline-editor` composes `PipelinesService` (edits) and `DealsService` (counts, moves).
   Putting it in either would make `pipelines` and `deals` depend on each other. Neither repository is reached
   from outside its module.

10. **Creating, renaming or deleting whole pipelines is not part of this decision.** MVP_SPEC M5 says "multiple
    pipelines", but how many a plan allows is an open owner question (gap analysis, question 8). The editor edits
    the stages of the pipelines that exist.

## Consequences

- A company can reshape its pipeline without a deploy, and nothing a deal or a report depends on moves under it.
- The board, the dashboard and the deals list read only the stages in use; reports that classify by stage type
  (won this month) read every stage, retired ones included.
- The count of deals in each stage is a grouped scan of the company's deals. It is fine at the sizes the product
  targets; a `(tenant_id, stage_id)` index built concurrently would help at millions of rows and is not in this
  migration, which runs in a transaction.
- Retiring is forward-only in effect: the deals' old stage is remembered only in the audit log and the timeline,
  which is where history belongs.
- Drag-and-drop reordering is not built; Move up and Move down are the keyboard and touch path.
