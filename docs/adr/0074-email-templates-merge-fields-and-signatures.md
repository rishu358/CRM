# ADR-0074: Email templates, merge fields and signatures

- **Status:** Accepted (PR 2 of the email plan, built after the owner released it)
- **Date:** 2026-10-31
- **Related:** ADR-0073 (email send and log), `docs/plans/email-send-log.md` section 6, ADR-0071 (quiet history),
  CLAUDE.md sections 5 and 13

## Context

PR 1a and 1b let a person write one plain-text email from a record and log it. The plan's next step is what a
salesperson at a small business does all day: start from wording that was written once, have the person's name
filled in, and end with a signature. It also listed one gap from the first slice: a lead's emails stayed on
the lead after it became a contact.

## Decision

1. **Company-wide templates, plain text.** `email_templates` (migration 0033): name (unique among the ones in use,
   ignoring case), subject, message, `version`, soft delete. At most 100 per company. Anyone who may send reads them
   (`email_message:create`, which the Send dialog needs); changing or removing one needs `tenant_settings:update`,
   the grant that already guards the sender settings, so there is no new permission and no backfill. **Per-person
   templates and sharing are not built**: they need an owner and a visibility rule, and nobody has asked.
2. **Merge fields are a closed list**: `{{contact.first_name}}`, `{{contact.last_name}}`, `{{account.name}}`,
   `{{deal.name}}`, `{{sender.name}}`, `{{company.name}}`. A name between double braces that is not on the list
   (including a misspelt or spaced one) cannot be saved in a template and cannot be sent: it is a 422, never sent as
   typed. No scripting, no conditions, no default values.
3. **Filled by the server when the email is queued, from records the sender may read.** Each value comes through the
   record's own module as the caller, so record scope and field-level rules are theirs. A value the caller may not
   read, or the record does not have, is an empty string: the same answer, so a hidden field cannot be told apart from
   an empty one. A lead's `{{account.name}}` is the lead's company. Values go in as text, once, on one line: braces
   inside a value are not looked at again, and a line break in a name cannot add a header or a paragraph.
4. **The dialog previews without a second rule.** The context answer carries each field's value for this person, and
   the dialog warns which fields in the text have nothing, using the same function the server uses. The server still
   renders and validates on its own, including the length of the subject and message once filled.
5. **Signatures are one person's own.** `email_signatures` (one row per person per company). The person is taken
   from the session, never from the request, so nobody can read or write another's. It is appended below the message when
   the email is queued, so the log shows exactly what was sent. A **retry sends the stored words as they were**: nothing
   is filled or added twice. The audit entry says a signature changed, never what it says (it may hold a phone number).
   It is edited from the Send dialog, because the person sending is not always somebody who can open Settings.
6. **A lead's emails follow it on conversion.** The worker handles `lead.converted.v1` and adds links from each of the
   lead's emails to the new contact and deal. It needed `INSERT` on `email_message_links` and nothing more: it still
   cannot change what a message says. The handler is idempotent (a unique index) and, like every handler registered
   with `on`, is quiet for imported history. The lead keeps its own links.
7. **A new checklist step**, "Set your email sender", is derived from whether the company has saved its sender
   settings, like the other three. It changes the onboarding contract, so the dashboard card shows again for a company
   that had finished the other three, until it saves the sender.

## Consequences and limits

- A template or signature is not personal data of a customer, so erasure does not touch them. They are in the tenant
  export. Removing a template never changes an email already sent from it.
- Fields are filled once at send time. A retry after the record changed re-reads the recipient but not the wording.
- A template that names a field cannot know whether a given recipient has it; the dialog warns, and a field with no
  value is sent blank. If the subject would be empty, the send is refused.
- Only the six fields exist. Adding one is a change to the list in `@crm/core`, its value in `EmailsService`, its label
  in the web strings and a test, and needs no migration.

## Alternatives considered

- **Merge fields rendered in the browser.** The browser cannot be trusted with what a person may read.
- **Custom fields as merge fields.** Wanted, but each needs its permission and its null handling decided; deferred.
- **Rich text templates.** Out for the same reason rich text is out of email in ADR-0073.
- **A signature stored on the user.** Users are global across companies (ADR-0014); a signature belongs to a person in
  one company.
