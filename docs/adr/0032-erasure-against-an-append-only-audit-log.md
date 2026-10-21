# ADR-0032: Erasure against an append-only audit log — a fifth database role, one column wide

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

Two requirements, both binding, and they contradict each other.

**CLAUDE.md §5.10:** _"Audit log is append-only."_ Migration 0004 enforces that
by **withholding** `UPDATE` and `DELETE` from `crm_app` rather than by writing a
policy — deliberately, and the file says why: a policy can be dropped by a future
migration without anything looking unusual, whereas a missing grant makes the
attempt fail. The application physically cannot rewrite its own history.

**DPDP §12 and GDPR Art. 17:** on request, a person's personal data must stop
being readable. MVP_SPEC M11 states the resolution the product wants:

> erase a person → PII fields deleted/pseudonymized **and audit diffs redacted
> (audit row kept, personal values replaced with `[erased]`)**

Replacing a value in `audit_logs.changes` is an `UPDATE`. So something in this
system must be able to perform one, on a table whose entire integrity story is
that nothing can.

This is not a case where one requirement is soft. An audit log that the
application can edit is not an audit log; an erasure obligation that cannot be
met is a legal exposure and, for an Indian SMB product under DPDP, a
product-blocking one.

### What was considered and rejected

**Grant `crm_app` `UPDATE (changes)` on `audit_logs`, restricted by policy.**
Rejected. This puts the capability on the connection every HTTP request uses. A
flaw anywhere in the request path — one injection, one mis-scoped service
method — becomes the ability to rewrite history, which is the one thing history
exists to prevent. The restriction would be a policy, exactly the mechanism 0004
chose _not_ to rely on.

**Delete the audit rows instead of redacting them.** Rejected: it does not
satisfy the spec (which says the row is kept), and it is worse for the data
subject as well as for us — the record that somebody changed their address on a
given day is the evidence that the erasure itself was carried out properly.

**A `SECURITY DEFINER` function owned by `crm_migrator`.** Rejected after
looking at it closely. Every tenant table has `FORCE ROW LEVEL SECURITY`, so the
owner is subject to policies too and has none — the function would see nothing
unless policies naming `crm_migrator` were added to `audit_logs` _and_ to
`erasure_requests`. That spreads owner-level policies across the schema for a
mechanism whose whole point is narrowness, and `EXECUTE` on it would still have
to be granted to a role the API holds, putting us back at option one.

**Refuse erasure and tell customers it is not supported.** Rejected: unlawful
for a product sold in India and the EU, and dishonest about what "DPDP-ready"
means.

## Decision

**Erasure gets its own database role, `crm_erasure`, and it can do exactly one
thing: rewrite the `changes` column of audit rows belonging to a subject whose
erasure request is in flight.**

The honest framing: erasure _does_ need a separate privileged path. Rather than
widening the application role, the path is built narrowly and every limit on it
is enforced by Postgres rather than by our code.

### a. A column grant, so history's structure is immutable

```sql
GRANT SELECT ON audit_logs TO crm_erasure;
GRANT UPDATE (changes) ON audit_logs TO crm_erasure;
```

No `INSERT`, so it cannot fabricate history. No `DELETE`, so it cannot remove a
row. `UPDATE` on one column, so `action`, `actor_id`, `occurred_at`,
`object_type`, `record_id`, `ip_address`, `user_agent` and `request_id` are
beyond its reach: **who did what, to which record, when, and from where survives
any erasure.** Only the values inside the diff can change, which is exactly the
obligation and nothing more.

It is granted nothing at all on `contacts`, `leads`, `deals`, `users` or any
other table. It cannot read a contact.

### b. A policy, so the capability has an open and closed state

```sql
CREATE POLICY audit_logs_erasure_redact ON audit_logs
  FOR UPDATE TO crm_erasure
  USING (tenant_id = current_tenant_id() AND EXISTS (
    SELECT 1 FROM erasure_requests r
    WHERE r.tenant_id = audit_logs.tenant_id
      AND r.subject_object_type = audit_logs.object_type
      AND r.subject_record_id = audit_logs.record_id
      AND r.status = 'processing'))
  WITH CHECK (…the same…);
```

A row is reachable only while an `erasure_requests` row for that exact subject
says `processing`. Outside that window the role reads nothing and writes
nothing — not "is refused", but sees zero rows, which the security suite asserts
directly. `erasure_requests` itself gets a matching `SELECT` policy for the role,
scoped to the processing row, because the policy expression is evaluated under
that role's own row security.

The request row is therefore two things at once: the compliance record, and the
authorization token for the redaction. A partial unique index keeps it to one
in-flight request per subject, which is a correctness rule and not tidiness —
"there is a processing request" has to mean exactly one.

### c. The API does not hold the credentials

`DATABASE_ERASURE_URL` is read only by the worker, and only by the erasure
handler. It is **optional**: a deployment that has not provisioned the role
cannot erase, and the job fails the request loudly saying so rather than erasing
the record and silently leaving its history readable — a compliance failure
reported as a success is worse than a refusal.

### d. Two events, because the window must be committed to be usable

`crm_erasure` is a separate session, so it cannot see an uncommitted
`processing` row. The claim and the redaction therefore cannot share a
transaction. Rather than invent a commit boundary inside a relay handler, the
claim _publishes the next step_ — which is what the transactional outbox is for
(ADR-0006):

1. `erasure.requested.v1` → claim the request, move it to `processing`, re-check
   that the requester still holds `data_subject:delete`, and queue
   `erasure.claimed.v1` **in the same transaction**. The window and the
   instruction to use it commit together.
2. `erasure.claimed.v1` → redact the diffs on the `crm_erasure` connection, then
   erase the record's personal columns, record the counts, write the audit entry
   and set the request `completed`, which **closes the window**.

The diffs are redacted **before** the record is erased: a failure in between
leaves a record that is still readable, rather than history that still holds
values for a record nobody can see. Every step is guarded on the request's
status, so a crash between them is picked up and finished by the next delivery,
and an exhausted event closes the window with a failure recorded.

### e. Which values count as personal is a table, not a heuristic

`PII_COLUMNS` in `@crm/core` names each column and what happens to it: `clear`
(null), `redact` (`[erased]`, for `NOT NULL` columns and for the name, because a
record with no name at all is an unreadable hole in every list the person appears
in), or `empty` (`{}` for jsonb). `custom_fields` is emptied wholesale: a tenant
puts what it likes in there and we cannot know which of it is personal, so the
safe direction is the one the data subject asked for.

A rule like "anything that looks like an email" would have silently missed
`whatsapp` the day it was added. A new personal column has to be added to that
table, and the erasure test asserts the shape of what is left so an omission
shows up as a failure rather than as residual data.

`owner_id` is deliberately **not** personal data about the subject: which rep
holds a record is the company's own information about its own staffing, and
erasing it would destroy the audit trail's account of who was responsible.

### f. The erasure's own audit entry carries counts, not values

Recording what was erased would make that row the last place the erased data
lives, defeating the redaction it is reporting. The entry records how many
records were erased and how many audit rows redacted, and the reason the
administrator gave.

## Who can invoke it

- The HTTP request needs `delete` on the `data_subject` object type, which only
  the seeded **Owner** role holds. An Admin can answer a subject access request
  (`data_subject:export`) and cannot erase.
- The subject must be a record the caller could have read: `own` scope still
  applies, and another tenant's id is a 404.
- The redaction itself is performed only by the worker's erasure handler, on the
  `crm_erasure` connection, inside the window.
- Every step is audited: the request, the completion with counts, and the record
  change that follows.

## Residual risk, stated plainly

A compromised **worker process**, during an erasure it also controls, could
blank the `changes` of that one subject's rows in that one tenant. It cannot
touch any other subject, any other tenant, any other column, or any other table;
it cannot insert or delete rows; and the structure of the history — who, what,
when, from where — survives.

That is the price of being able to erase at all, and it is a far smaller surface
than the alternative of giving the request path `UPDATE` on `audit_logs`. It is
recorded here rather than left for somebody to discover.

## Consequences

- Deployments must create `crm_erasure` (it is in
  `packages/db/sql/bootstrap/01-extensions-and-roles.sql`, which is idempotent
  and safe to re-apply) and set `DATABASE_ERASURE_URL` on the worker. Until then
  erasure requests fail with "not configured", which is visible in the UI.
- Five roles now, not four. The README and the bootstrap file say what each is
  for; a sixth should be as hard to justify as this one was.
- The redaction reaches a subject's **own** audit rows: rows for
  `(object_type, record_id)` of the subject. Audit rows for _related_ records —
  an activity whose subject line mentions the person, a deal named after them —
  are out of scope and stay as they are. Widening that is a real decision with a
  cost (it would mean scanning diffs for values rather than matching a record id)
  and belongs in its own ADR if a regulator or a customer asks for it.
- `packages/db/src/erasure.security.spec.ts` asserts every limit above against a
  real Postgres. If one of those tests starts failing, the correct response is to
  stop and rethink the design, not to adjust the test.
