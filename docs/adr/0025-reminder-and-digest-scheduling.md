# ADR-0025: Reminders and digests are scheduled by the outbox

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

M6 needs two things to happen _later_: a reminder when a task falls due, and
an email digest a short while after somebody is notified. Both are per-user,
per-tenant and must survive a restart.

The obvious mechanisms each have a problem here:

- **A polling sweeper** ("every minute, find tasks due now") has to read
  across tenants. The worker connects as `crm_worker`, whose only cross-tenant
  policy is on `outbox_events` (ADR-0002, ADR-0006); widening that to
  `activities` would hand the worker every tenant's business data to solve a
  scheduling problem.
- **BullMQ delayed jobs** add a second durable store beside Postgres. A job
  scheduled in Redis and a row committed in Postgres is the two-writes problem
  the outbox exists to avoid, and a task whose due date moves leaves a job
  behind that has to be found and cancelled.
- **A cron row per reminder** is a sweeper with extra steps.

## Decision

**The outbox is the scheduler.** `outbox_events.available_at` already exists
and the relay already refuses to claim a row before it
(`where status = 'pending' and available_at <= now()`).

- When an activity is written with a due date, the service publishes
  `activity.reminder_due.v1` **dated to the reminder instant**, in the same
  transaction as the activity (ADR-0006). No timer, no cron, no cross-tenant
  read, and it survives a restart because it is a committed row.
- When the worker writes a notification, it publishes
  `notification.digest_due.v1` dated `now + DIGEST_WINDOW_MINUTES` for that
  user. The first one to fire sends everything accumulated and marks it
  `digested_at`; the ones behind it find nothing and do nothing.

**Cancellation is a check at delivery, not a deletion.** A reminder whose
activity was completed, reassigned, rescheduled or deleted still has its row
sitting in the outbox. The handler re-reads the activity when the event fires
and does nothing unless the activity is still open and its `reminder_at` still
equals the instant in the payload. Reaching into the queue to delete a pending
row would mean a service knowing the relay's storage, and it would still miss
the rows written by an import or a hand-edit.

`digested_at` is separate from `read_at`: a digest must not re-send what it
already sent, but it must not pretend the person has seen it either — the bell
keeps showing it as unread.

## Consequences

- Scheduling costs one row and no infrastructure. The same mechanism serves
  every "do this later" the product needs next — escalations, follow-up
  nudges, Phase 2 automations with a delay step.
- Reminder precision is the relay's poll interval (1s by default), which is
  far finer than a reminder needs.
- Stale rows accumulate for reminders that were moved or cancelled. They are
  cheap, they are claimed once and discarded, and the outbox already needs
  periodic archival of relayed rows (ADR-0006).
- A long-dated reminder sits `pending` for as long as the due date is away, so
  "pending outbox rows" is no longer a useful alarm on its own; the alarm is
  pending rows **whose `available_at` has passed**.
- One digest email per window per person, not per notification. A burst of
  assignments is one email.
- The digest marks rows digested _before_ sending, inside the transaction. If
  the provider then fails, the relay retries the event and the retry finds
  nothing — so a flaky provider costs one lost digest rather than a loop of
  duplicates into a real inbox. Losing a digest is recoverable: the
  notifications are still in the bell.

## Alternatives considered

- **Cross-tenant sweeper over `activities`.** Rejected: it buys scheduling at
  the price of the isolation boundary.
- **BullMQ delayed jobs.** Rejected for now: two durable stores, and
  rescheduling means finding and cancelling jobs. Redis and BullMQ remain in
  the stack for throughput work (imports, bulk actions) where the outbox's
  one-row-at-a-time relay is the wrong shape.
- **Deleting the pending event when a reminder changes.** Rejected: couples
  the service to the relay's table, and still cannot cover writes that did not
  come through the service.
