# ADR-0073: Email sent from a record, and the log of it

- **Status:** Accepted (plan approved by the owner, PR 1a built)
- **Date:** 2026-10-30
- **Related:** `docs/plans/email-send-log.md` (the plan this builds), ADR-0005 (polymorphic links), ADR-0006
  (outbox), ADR-0009/0048 (provider interfaces), ADR-0024 (rich text), ADR-0025 (scheduling through the outbox),
  ADR-0047 (entitlements), ADR-0053 (rate limits), ADR-0060 (idempotency), ADR-0064 (merge), ADR-0071 (quiet history)

## Context

A rep at a small business wants to write to a contact, a lead or a deal's contact from the CRM, and wants the
whole team to see what was sent and whether it went. Until now the product sent only system mail. The plan
(`docs/plans/email-send-log.md`) set the shape; this records what was built in PR 1a (the server) and where it
differs from the plan.

## Decision

1. **Four tables (migration 0032).** `email_messages` (the log), `email_message_links` (what each email is about, the
   same `(object_type, record_id)` shape as `activity_links`), `email_sender_config` (one row per workspace) and
   `email_daily_counts` (the caps). All tenant-owned with row-level security.
2. **The application role can INSERT and SELECT a message and cannot UPDATE it.** Only the worker, with a
   column-limited grant, changes a status. No bug in the API can mark an email "sent". A retry is a **new row**
   (`retry_of`, unique per original) instead of an edit; this is a change from the plan, which said "same row".
3. **The send is outside every transaction and happens at most once.** Claim (`queued` to `sending`, one statement
   only one delivery can win), send, finish. A crash in between is reported as `outcome_unknown` for the person to
   judge, never guessed at. A temporary provider failure is requeued and retried by the relay; anything else is final.
4. **A watchdog per message, scheduled through the outbox** (ten minutes after queueing, ADR-0025), replaces the
   "sweep job" the plan described. The relay does not re-claim an event a crashed worker left in `processing`; the
   watchdog is a separate, dated event, so nothing polls and nothing scans every workspace. Finding: that gap in the
   relay affects every handler and is reported separately.
5. **The recipient is never the client's.** `to` is read from the record through the record module's own service, as
   the caller, so record scope, the 404 and field-level rules are the record's own. A hidden address and an empty one
   give the same answer (`NO_EMAIL_ADDRESS`). A deal's recipient must be one of the deal's contacts.
6. **Permissions:** a new administrative object type `email_message` (`create` sends, `read` reads), always paired with
   the ordinary read check on the record. Owner, Admin, Manager and Sales Rep; Read-only none. A message is visible
   to anyone who can read any record it is linked to. The sender's name, reply address and footer are
   `tenant_settings` (read to look, update to change). Feature `email` (entitlement) can switch a workspace off.
7. **Plain text only.** Subject and body are text; the HTML part is built at send time by escaping it. Nothing is
   stored as markup, so there is nothing to sanitize and no stored-XSS surface.
8. **Sender identity.** Only the display name is per message; the address is the one the provider was built with
   (`EMAIL_OUTREACH_FROM`, falling back to `EMAIL_FROM`), so no caller can send as another domain. Each adapter
   re-validates name, reply address and message id and refuses line breaks. The reply address defaults to the
   sender's own sign-in address; a company may set one (not verified).
9. **Limits** are constants in `@crm/core`, counted in the database under a lock per workspace and day, in the
   workspace's time zone: 100 a person and 500 a company a day, 20 and 100 for a workspace under 14 days old, and ten
   sends a minute a person.
10. **Consent.** A `withdrawn` status on `contacts.consent.email` refuses the send (`CONSENT_WITHDRAWN`). No record at
    all is allowed and shown as a notice. Nothing in the CRM writes that status yet; the legal position is pending
    review (see the plan, section 7).
11. **Other lists that point at a contact** were extended: merge moves the links, erasure scrubs the address, subject
    and body (the row stays, with `erased_at`), the tenant and per-person exports include the tables, and a purge
    removes a message whose every link is gone.
12. **Events carry ids and codes only** (`emailId`, `failureCode`). The timeline copies a payload whole and an erasure
    does not reach it.

## Consequences and limits

- `sent` means the mail service accepted the message, not that it arrived. Delivered, bounced and complained are
  allowed by the database and written by nothing until PR 3.
- Which of the adapters carry our `Message-ID` through to the recipient is **unverified**: SMTP passes it to the
  library; Resend and SES are sent the display name and reply address only. A real send through the owner's chosen
  provider is the first manual check, and PR 4 (inbound replies) must settle matching.
- The relay's retry window is about four minutes, which is short for a provider outage, so Retry is the real recovery.
- A lead's emails stay on the lead after conversion (PR 2 links them to the new contact).
- No read of an email is audited, as for any record.

## Alternatives considered

- **Edit the same row on retry.** Needed an UPDATE grant for the app role, which is the thing the design removes.
- **A sweep job.** Needs a cross-workspace scan and a timer; the outbox already does dated work.
- **Sending inside the relay's transaction.** Duplicates a customer's email whenever a commit fails after a send.
- **Rich text, templates, attachments and tracking in the first slice.** Each widens the attack surface; none is needed
  to prove the feature.
