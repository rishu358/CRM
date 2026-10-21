# ADR-0037: Company setup and sample data — a registry, a keep-what-was-used rule, and a narrower grant

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

MVP_SPEC M2 asks for a new company to be seeded with "default pipeline, roles
and sample data (removable in one click)", a setup checklist, and company
details (name, currency, time zone, industry). Its acceptance criterion for the
sample data is: _"Remove sample data deletes only seeded records."_

Three things about the codebase made that harder than it reads.

**Nothing marked a record as sample data**, and nothing let an administrator
edit the company at all. There was no `PATCH /tenant`, no `industry` column, and
no way to tell a seeded contact from one somebody typed.

**Removing records is more dangerous here than it looks.** Nearly every
reference to accounts, contacts, leads and deals is `ON DELETE SET NULL` or
`CASCADE` (migrations 0002, 0007–0009), and the references from activities, tags
and attachments are polymorphic and have no foreign key at all (ADR-0005). So a
reference a removal fails to notice does not make it fail, which would be loud
and safe. It quietly nulls a column on a deal somebody owns, or drops a
contact's link row. "Only seeded records" cannot be checked by the delete
succeeding.

**The application's database role could already rewrite its own tenant row.**
Migration 0004 granted `crm_app` and `crm_worker` table-wide `UPDATE` on
`tenants`. RLS confines them to their own row but not to any column, so a bug
anywhere in a request path could have set `plan`, `status`, `slug` or `region`.
Nothing did, because no endpoint wrote the table. Company setup is the first
thing that does, which is the moment that grant stops being harmless.

## Decision

### 1. The app role loses its blanket UPDATE on `tenants`

`UPDATE` is revoked from `crm_app` and `crm_worker` and re-granted to `crm_app`
on `name`, `default_currency`, `timezone`, `locale`, `fiscal_year_start_month`,
`industry`, `setup_completed_at` and `updated_at` — exactly what a company
profile screen edits. The worker keeps `SELECT` and loses `UPDATE`; nothing in it
writes the table. It is a **grant, not a policy**, for the reason 0004 gave about
the audit log: a policy can be dropped by a later migration without anything
looking unusual, whereas a missing grant makes the attempt fail.

`onboarding.security.spec.ts` proves it from the database up, and was checked the
other way: with the revoke withdrawn, exactly the seven tests about `plan`,
`status`, `slug`, `region`, `settings`, `created_at` and the worker fail.

### 2. A registry, not a flag

`sample_records (tenant_id, object_type, record_id)` says which records began as
sample data. A flag column on five of the largest tables would put an `ALTER` on
them (CLAUDE.md section 7) for a feature that touches a few dozen rows once per
company, and every new object type would have to remember its own. The registry
is the polymorphic shape ADR-0005 already chose, so custom objects plug in later
without a migration. A row records how something began and is never updated; the
application is given no `UPDATE` on it. The Recycle Bin's retention sweep deletes
a purged record's registration with its other polymorphic references.

### 3. Sample records say so in their names

Every sample record's primary text ends in `(sample)`. That is deliberately
blunt: it is visible in every list, on the board, in search and on a timeline
without a single serializer learning about the registry. The cost is that the
mark is English, in data, and not routed through the i18n layer; a record the
user edits keeps it until they rename it, which is the correct nudge.

### 4. Loading is one transaction, written in `@crm/db`

Creating thirty records through each module's service would be thirty
transactions, and a crash in the middle would leave half a demo company with
some of it unregistered and therefore never removable. So `loadSampleData` writes
every row, every registration and every trace in **one** transaction, and an
advisory lock keyed by tenant stops two loads (or a load and a removal) from
interleaving. This is the same arrangement as `provisionTenantDefaults`, which
the API calls from inside a tenant transaction, and as the import pipeline, which
writes accounts, contacts and leads from the worker through shared descriptors.
It is a bounded exception to "modules talk only through services" (CLAUDE.md
section 3), taken for atomicity.

What a service gives for free is paid for explicitly: every record gets the audit
row and `<object>.created.v1` event a real creation writes, which is what puts it
in the search index and on a timeline. Tasks are deliberately given no reminder
and no `activity.assigned.v1`, so loading sample data never notifies anybody about
a task nobody wrote. "Due yesterday" is computed from the database's clock
(ADR-0036).

Sample data is loaded by an explicit step in the setup screen, not at sign-up.
Doing it at sign-up would have changed every test and every code path that
assumes a new company is empty.

### 5. Removal keeps whatever has been used

A sample record is **kept** when:

1. it was edited (its `version` moved on from 1); or
2. something that is not sample data refers to it — a deal, contact, account or
   lead somebody created, or a task, tag or file somebody attached; or
3. a record being kept refers to it. A kept deal keeps its account and contacts, a
   kept task keeps what it is about, a kept child account keeps its parent.

Rule 3 makes this a closure, computed to a fixpoint. A kept record is released
from the registry: it is the company's now. A sample record the user already
deleted is in the Recycle Bin, which owns it from there; it is left alone,
released, and treated like a kept record when deciding what it holds on to.

Because a missed reference is silent, **every edge has its own test**: eleven cases
each build one non-sample thing that points at one sample record and assert both
that the target survived and that the referrer's pointer is still there. The
removal rules were also mutation-tested: each rule and each reference check was
disabled in turn and the suite had to fail.

### 6. Removal runs in the worker, as mark-then-purge

The cleanup removes search and timeline rows as well as the records, and `crm_app`
cannot write those projections by design (migration 0011), so it cannot run in a
request. The request records that removal was asked for (an outbox event) and
returns `202`; the worker does the work and the screen watches
`sampleData.removing` until it clears. "Removing" is derived from the pending
event, not stored, so there is nothing to forget to clear if the job fails or is
retried. The worker re-checks the requester's permission when it runs.

`hardDelete` refuses a row that is not already soft-deleted, so that a bug cannot
turn the purge into a way to delete live data. That guard stays. These records are
live, so they are first marked deleted — `... and version = 1 and deleted_at is
null` — and the existing purge is handed exactly the ids that were marked. The
version condition closes a race without holding row locks: a record edited between
the decision and the mark no longer matches, is not marked, and so is not deleted;
and the cleanup of what points at a record runs only for marked ids, so an edited
record never has its links removed from under it.

### 7. `tenant_settings` is a new object type

Read and update, `all` scope only, granted to Owner and Admin by `provisioning` and
backfilled by migration 0017 for existing tenants. It is separate from
`tenant_data` (exporting a company's contents): renaming the company is a far
milder grant than taking a copy of everything, and one type would make the mild
one carry the dangerous one. It is in the grant catalogue, because the role editor
renders that catalogue and nothing else.

### 8. The checklist is derived, never stored

Each item is a question about what exists: has anybody been invited or joined, has
an import completed, does a deal exist that is not sample data. A stored tick can
disagree with the data; a derived one cannot. The third item deliberately ignores
sample deals, so removing the sample data does not leave a company looking as if it
had "added its first deal".

## Consequences

- A company can be set up, and its sample data removed, without a migration per
  object type, and with a database that no longer lets the application rewrite its
  own plan.
- `removeSampleData` is the one place that must know every reference to the five
  record types. Adding a sixth sample object type, or a new table that points at
  them, means adding an edge **and a test**; the existing Recycle Bin guard
  (`POLYMORPHIC_REFERENCE_TABLE_LIST`) catches a new polymorphic table, but a new
  real foreign key has no equivalent guard.
- Loading and removal are serialised per tenant by an advisory lock, so a person
  double-clicking cannot produce a doubled or half-removed company.
- Removal is eventually consistent: for a moment after the request the screen shows
  "removing".

## Known limits

- **"Customize pipeline" is not on the checklist.** MVP_SPEC M2 lists it, but the
  customization UI (M9) is not built, so no real action could complete it. It is
  added when M9 lands.
- **Edit detection is `version > 1`.** An edit that does not bump `version` would
  be treated as untouched. Writes through the API bump it; that is the path this
  was built and tested against.
- **Sample data is one set, in the default pipeline.** It is not tailored to the
  company's industry.
- **No phone numbers.** Sample contacts carry email addresses on reserved
  `.example` domains only: a plausible number is a real person's.
- **The first-deal usability criterion** ("≤ 10 minutes for three non-technical
  users") needs people. The click path is measured in the end-to-end suite; the
  criterion itself is not verified.
