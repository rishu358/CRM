# ADR-0039: Customization — a definition changes the shape of every record, so what it may never do is enforced twice

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

MVP_SPEC M9 asks for custom fields on Account, Contact, Lead and Deal that an
administrator can add, edit, reorder and deactivate; picklists with editable
values; required fields; layout sections; and "deactivating a field hides it but
keeps data (no destructive deletes)".

The engine behind it already existed (ADR-0004): a `field_definitions` table,
`buildCustomFieldsSchema` validating every write against it, import, export and
the access explainer reading it. What did not exist was any way for a person to
use it. There was no API for definitions, and the web app rendered no custom field
anywhere — a company that had them could not see them. So M9 is the administration
of that table, the read API every form is drawn from, and the screens that draw it.

A definition is not a record. It has no owner and so no `own` scope. But it decides
what every record in the company looks like, which makes the dangerous operations
the ones that cannot be put right afterwards:

- **Changing a key or a type** leaves records holding values under something the
  field no longer is.
- **Removing a picklist option** leaves records holding a value the field does not
  offer, and the next edit of any of them is refused for a reason nobody can see.
- **Deleting a definition** destroys the spec's one promise about data.
- **A pattern** is a program the server runs on every write. `(a+)+$` holds a
  request thread for as long as the input is long.

## Decision

### 1. What can never happen, stated in the database as well as the service

Migration 0019:

- `DELETE` is withdrawn from the application and worker roles. `UPDATE` is narrowed
  for the application role to the columns an administrator edits (`label`,
  `required`, `options`, `validation`, `position`, `is_active`, `section`,
  `help_text`, `version` and the audit columns); the worker keeps only `SELECT`.
  `key`, `type`, `object_type`, `is_system` and `tenant_id` cannot be written by a
  request path at all, whatever bug is in it. This is the move ADR-0037 made for
  `tenants`.
- A trigger refuses an update that leaves out a picklist `value` the row had.
  Retiring an option is `isActive: false`.
- A trigger refuses the 61st custom field of one object in one company, taken under
  an advisory lock so that two administrators adding the last slot cannot both
  succeed. System fields are neither counted nor refused.
- `section`, `help_text`, `label` and the number of options are bounded by CHECK.

The service enforces the same rules and says so in words an administrator can act on;
the triggers are for the path that is not the service.

### 2. Keys are made, types are fixed, nothing is deleted

The administrator types a **name**. The server makes the key from it (`slugify`,
accents folded, never empty, never starting with a digit, at most 40 characters so a
collision suffix fits), unique against every key of that object including built-in
and switched-off ones. The key never changes, including when the name does. A
picklist option's `value` is made the same way, and the administrator never types one,
so a typo cannot create two values for one idea.

There is no delete endpoint, and the screen has no delete control. Switching a field
off says, before it does, that nothing is lost.

### 3. The list a form draws from is filtered by field permission

`GET /fields?objectType=` requires `read` on the object and returns the active
definitions **the caller may read**. A field hidden from a role is absent from its
list, so a form cannot render a box for it and no label names it (CLAUDE.md §5.4). A
write to it is refused exactly as a write to a field that does not exist, so the answer
does not say that it does.

The management view (`includeInactive=true`) requires `read` on `tenant_settings` as
well and is not filtered, because it describes the company's configuration and not its
data. Everything that changes anything requires `update` on `tenant_settings`, the
grant that already means "may change company-wide settings"; there is no separate
`customization` object, because a second grant would be a second opinion about the same
question.

### 4. What an administrator can set, and what they cannot

- Types: every engine type except `user_lookup`, which waits for a member picker that
  people who are not administrators can use (`GET /members` is administrator-only).
- Limits: lengths for text, bounds for numbers and percentages, allowed currencies.
  **Never `pattern`**, for the reason above; the engine can still apply a pattern that
  is already stored, and the API does not show it. A time-bounded regular-expression
  engine is the prerequisite for offering one.
- **Not `unique`.** Enforcing it needs an index per company and field, which is DDL the
  application role must not run.
- Required: allowed at any time. It applies to new records; existing ones that lack the
  value stay valid and editable. An inactive required field is not required.
- Built-in fields are **listed, not editable**. The screens that draw them have their own
  labels, so a relabel would be invisible where it matters. (The spec allows relabel and
  reorder of system fields; it is deferred until those screens read their labels from
  metadata.)

### 5. Concurrency and the record of it

Edits carry `version`; a stale one is a 409 and nothing is changed. Ordering names every
custom field of the object exactly once, inactive included, or is refused, and applies
in one transaction. Creating and editing write an audit row with what changed (an edit
that changes nothing writes none) and an outbox event. Search is unaffected by a
definition changing: `search_documents` are built from standard columns, not from custom
fields, so a switched-off field's data is not findable through it.

### 6. Where fields show up

- **Record pages** show custom fields in a card, grouped by `section`, each editable in
  place. A retired picklist option a record holds is shown as what it is
  ("Region (no longer offered)") rather than blanked, so saving does not change it.
- **New-record dialogs** show the same boxes; a required one that is empty, or one that
  cannot be read as its type, stops the save with the reason beside it.
- **List tables** can show custom fields as extra columns through the column chooser.
  None are shown until someone chooses, so a company with forty fields does not get a
  forty-column table. The choice is per visit; saved views will remember it (M4).
- `/settings/fields` is the administrator's screen: one tab per object, add and edit
  dialogs, reorder, switch off and on.

## Consequences

- A field a company stops using is never gone, which is the point and also a cost: the 60
  cap counts switched-off fields. An administrator who reaches it has to reuse one. A
  purge-after-retention path is possible later and would need its own decision.
- An option can be switched off and never removed, so a picklist only grows. The 100-option
  cap is the bound.
- A custom role that should see the whole screen needs `tenant_settings:read` and `update`
  and `read` on the object.
- List columns, filters and sort by custom field are partly unbuilt: the API already
  filters and sorts by an active custom field (ADR-0004); the filter and sort UI waits for
  saved views.

## Alternatives considered

- **Let the administrator choose the key.** It would give a stable, readable API name, and
  a typo or a collision becomes a permanent mistake the administrator has to live with,
  since keys never change. A made key can be shown back and is never wrong.
- **Allow `pattern` with a length limit.** Length does not bound `(a+)+$`. A safe subset
  (no nested quantifiers) is a regex parser we would have to own.
- **Hard delete after a warning.** Contradicts the spec, and a warning is not a recovery.
- **A `customization` object in the permission catalogue.** A second grant for what
  `tenant_settings:update` already says.
