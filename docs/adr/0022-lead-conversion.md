# ADR-0022: A lead converts once, in one transaction, onto records it names

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

MVP_SPEC M4 says converting a lead "creates/links Contact + Account (+ optional
Deal), copies mapped fields, keeps history, marks lead converted". That is five
promises, and each has a cheap implementation that breaks it:

- **"Creates … and marks converted" as separate calls.** The contact is
  created, the account insert fails, and the lead is left half-converted — or
  worse, converted with nothing to show for it. A half-converted lead is worse
  than a failed conversion, because the failure is invisible and the person
  has already been told it worked.
- **"Copies mapped fields" as "copies the fields".** Copying a value is a write
  to another record and a read of this one. A rep who may not see a lead's
  phone, or may not set a contact's, must not be able to move the value
  across by pressing Convert.
- **"Keeps history" as a status column.** `status = 'converted'` says nothing
  about _which_ contact. And if the status can be changed back, the history is
  whatever the last edit said it was.
- **"Links" as "any id the client sends".** Adopting a contact as the person
  this lead became is a statement about a record the caller should be able to
  see.

The reversible parts (which button says what) are not recorded here. These are.

## Decision

### 1. One transaction, through the other modules' own write paths

`LeadsService.convert` runs in a single `runInTenant`. The contact, account and
deal are created by `ContactsService.createInTx`, `AccountsService.createInTx`
and `DealsService.createInTx`: the same method each module's `create` calls,
taking the caller's transaction. Nothing in conversion reimplements what
creating a record involves, so a conversion-created contact gets the same
authorization, field-permission check, custom-field validation, audit entry and
`*.created.v1` outbox event as one created by hand. `create` was refactored
into `create` + `createInTx` rather than duplicated, so the two cannot drift.

The lead is updated **last**, by a statement that matches only
`version = $read AND status <> 'converted'`. If it matches nothing — someone
else edited the lead, or two conversions raced — it throws, and the
transaction rolls back the contact, the account, the deal and their audit rows
and events. This is tested three ways: a deal that fails after the contact and
account were created, a role that may not create deals, and two simultaneous
conversions of one lead (exactly one 200, one 409, one contact).

### 2. A conversion is permanent

Once converted, a lead cannot be edited, re-converted or re-pointed:

- the service answers `409 CONFLICT` to a second `convert` or to any `PATCH`;
- `status` cannot be set to `converted` by `PATCH` or `POST` — it is not in the
  write contract's enum — so there is no way to claim a conversion without
  making one;
- `0009_leads_module.sql` enforces it for every other writer. A `CHECK` ties
  `status = 'converted'` to `converted_at IS NOT NULL` and forbids conversion
  links on an unconverted lead; a `BEFORE UPDATE` trigger refuses to change
  `status`, `converted_at` or a link that is already set.

One thing is deliberately allowed: a link may become `NULL`. The foreign keys
are `ON DELETE SET NULL`, so hard-deleting a converted contact (the Recycle Bin
purge) leaves the lead converted with the pointer gone, instead of failing the
delete or resurrecting the lead.

The alternative — letting a converted lead be reopened — was rejected for the
same reason ADR-0020 rejects re-opening as a column: the audit log and the
timeline are where history lives, and a column that can be rewritten is a
second source of truth that disagrees with them.

### 3. What is copied, exactly

To the **contact** — the five mappings in `LEAD_TO_CONTACT_FIELDS`
(`packages/core/src/leads`):

| Lead         | Contact       |
| ------------ | ------------- |
| `first_name` | `first_name`  |
| `last_name`  | `last_name`   |
| `email`      | `email`       |
| `phone`      | `phone`       |
| `source`     | `lead_source` |

plus **custom fields** present on both objects with the **same key and the same
type**. A same-key field of a different type is not copied; a key that exists
on only one side is not copied. Both are quiet because neither is a permission
question: nothing was withheld, there is simply nowhere for it to go.

To the **account** — `company` becomes the `name`, and the email's domain
becomes the `domain`, unless it is a free-mail domain (`gmail.com`,
`rediffmail.com`, …) which identifies a provider rather than a company. The
lead's phone is the _person's_ and is not copied to the company.

To the **deal** — a name (default `<company or surname> — opportunity`), the
pipeline and stage (default: the tenant's), an optional amount and close date,
with the new account and contact attached as `account_id` and
`primary_contact_id`.

A field is copied only if the actor may **read it on the lead and write it on
the target**. One that fails either test is left behind and reported in
`skippedFields` — "contact.phone" — rather than dropped silently or failing the
whole conversion. The surname is the exception: a contact cannot exist without
one, so if the actor cannot carry it across, the conversion is a 422 rather
than inventing a name.

Only lead values the actor may read are used for anything — to look for
duplicates, to name an account — for the reason in ADR-0023.

### 4. Create, link, or none — and what "link" requires

The caller chooses per record: contact `create | link`, account
`create | link | none`. Defaults: create a contact; create an account when the
lead has a company and none when it does not. Linking requires the target to be
**in the actor's record scope** (`assertReadableForLinking`), not merely in the
tenant. This is narrower than the deal module's link check on purpose: a deal
pointing at a colleague's account reveals nothing, whereas converting a lead
_onto_ a contact adopts it as that person. Another tenant's id, a deleted
record, an out-of-scope one and a nonexistent one all produce the same 422.

Linking changes nothing on the linked record. It publishes
`contact.linked_from_lead.v1` (or the account equivalent) so that record's
timeline says a lead was converted onto it; a created record has its own
`created` event.

A conversion with no company cannot create an account (422) — the alternative
is inventing a name.

### 5. Ownership

New records are owned by the **lead's owner** where the actor could have
assigned them themselves (the actor is the owner, or has `all` scope on that
object), and by the actor otherwise. A manager converting a rep's lead with
`team` scope therefore ends up owning the contact, because `team` scope cannot
reassign (CLAUDE.md §5.2). That is a known wart, not an oversight; the fix is a
bulk reassignment, not letting conversion launder a reassignment.

### 6. Events and audit

Every created record has its own audit entry and outbox event (via
`createInTx`). The lead has an `update` audit entry whose diff includes
`status`, `convertedAt` and the three links, and one `lead.converted.v1` event
carrying the ids and whether each record was created or linked. The worker
words it on the lead's timeline: "Converted: created contact, account, deal".

## Consequences

- A failed conversion leaves no trace, including no audit rows or events for
  records that were never committed. The converse also holds: a committed
  conversion's audit trail is complete without any reconciliation.
- Converting needs `update` on leads, and `create` on each object it makes (and
  `read` on any it links). A role with the first and not the second gets a 403
  and a clean rollback, which is the intended behaviour and is tested.
- Two concurrent conversions serialise on the lead row. The loser waits for the
  winner's commit, re-evaluates `version = $read`, matches nothing and rolls
  back. There is no retry; the caller sees a 409 and reloads.
- `skippedFields` makes a permissions mismatch visible to the person who hit it
  and, through them, to whoever configures roles. The alternative — failing —
  would make conversion unusable for any role with a narrowed field.
- A converted lead's `converted_*_id` may be `NULL` after a hard delete. The
  record page shows the links that remain.
- Lead scoring (P2) and merge (P1) are not touched. Merge, when built, will
  need to decide what happens to a lead converted onto the losing record; the
  `converted_contact_id` index exists to answer that.

## Alternatives considered

- **Convert in the web app by calling `POST /contacts`, `/accounts`, `/deals`
  and then `PATCH /leads`.** Rejected: four requests are not a transaction, and
  the failure window is the whole problem this ADR exists to close.
- **A database function that does the conversion.** Rejected: it would have to
  re-implement authorization, field permissions and custom-field validation
  that live in the services (ADR-0008), or skip them.
- **A `converted` status settable by PATCH, with the links optional.**
  Rejected: it permits a "converted" lead that became nothing.
- **Fail when a field cannot be copied.** Rejected for the reason in §3.
- **Offer conversion onto any contact in the tenant.** Rejected for the reason
  in §4.
