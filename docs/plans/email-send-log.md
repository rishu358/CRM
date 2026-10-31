# Email send and log: plan

Written 2026-10-30 for the owner. **Plan only: no code, no migration and no dependency is added by this pull request.**
Nothing here is built until you approve it.

A user opens a contact, a lead or a deal, writes an email, and sends it from the CRM. The email goes out, and
the whole team sees it on that record, with its status. This is the "send and log" half of Zoho's email feature
(gap analysis, `docs/research/zoho-gap-analysis.md`, section 6, item 5: "send and log first, two-way sync later").

## 1. The short version

1. **Send from the CRM, log on the record, one recipient, plain text.** The recipient is always read from the record,
   never typed in, so the CRM cannot be used as an open relay.
2. **Mail goes out from one address your platform owns**, with the company's name as the display name and a
   `Reply-To` that points at the rep. That passes SPF, DKIM and DMARC without the customer touching DNS.
   A company's own sending domain comes later.
3. **Replies are not captured in version 1.** They land in the rep's own inbox. Capturing them is a separate,
   later step (section 8). I recommend a forwarding address, not a mailbox connection.
4. **"Sent" will mean "the provider accepted it", not "it arrived".** Delivered and bounced need provider
   callbacks, which is a later step. The screen says so in plain words.
5. **Two pull requests for the first slice**: server first, then screens. Four more after that (section 11).
6. **Legal review is still pending.** The consent and unsubscribe rules below are a technical proposal, not
   legal advice (section 7).

## 2. What I read, and what I found (not assumed)

Read in full or in the relevant part: `CLAUDE.md` (all), `docs/MVP_SPEC.md` (email lines), the gap analysis,
ADR-0005/0006/0009/0024/0044/0047/0048/0053/0060/0064/0071, `packages/outbound` (the adapters),
`packages/core/src/email`, `apps/api/src/platform/email`, `apps/worker` (relay, timeline, notifications),
the activities and timeline schema, `packages/env/src/registry.ts`, the permission catalogue and default roles.
I did not run anything. "Exists" below means "I read the code".

| Finding                                                                                                                                                                                                                                                                                                     | Why it matters                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EmailProvider.send(message)` takes `{ to, subject, text, html? }` and returns nothing. The sender address is fixed when the provider is built (`EMAIL_FROM`). Resend, SES and SMTP adapters exist, all behind `createRemoteEmailProvider`. `console` and `memory` exist per process and refuse production. | Enough for system mail. Not enough for this feature: no per-message display name, no `Reply-To`, no `Message-ID`, and no provider message id back. The interface needs a small, additive change (section 4).                                                                           |
| The interface is declared **twice**: in `@crm/core` (`packages/core/src/email`) and again in `apps/api/src/platform/email/email.provider.ts`. They are identical today.                                                                                                                                     | They will drift the first time one is edited (the core file's own comment says so). PR 1a removes the API copy.                                                                                                                                                                        |
| **No API endpoint and no screen reads `timeline_events`.** The worker writes it; the record pages show the Activities card, which is `activities` rows.                                                                                                                                                     | "Logged on the timeline" cannot mean "write a timeline row" alone, or nobody sees it. v1 adds an Emails card beside the Activities card and also writes the timeline row, so a merged timeline later has the data. A merged timeline is its own feature (notes and calls want it too). |
| `contacts.consent` (jsonb, per channel) exists, and its comment says "checked before any outbound send". **Nothing checks it.** The shape is `{ email: { status, source, at } }` by the comment; I did not find the allowed `status` values written down.                                                   | The plan has to define the rule (section 7) and confirm the values in code at build time.                                                                                                                                                                                              |
| The outbox relay claims `pending` events, marks them `processing`, and runs the handlers inside one tenant transaction. I found **no code that re-claims an event left in `processing` by a worker crash.**                                                                                                 | For most handlers that is a lost side effect. For email it would be a message that stays "queued" for ever. The plan adds its own sweep (section 3) and reports this to the orchestrator as a platform finding.                                                                        |
| A handler that sends mail inside the relay's transaction (the digest does) can send and then fail to commit, and the retry sends again.                                                                                                                                                                     | Acceptable for a digest, not for a message to a customer. Section 3 sends outside the transaction.                                                                                                                                                                                     |
| Migrations run to `0031_import_deals.sql`. `0028` is `lead_assignment_rules`. No branch on the remote carries a `0032` or higher.                                                                                                                                                                           | **Next free number: 0032** (re-checked at push, as earlier plans did). ADR: next free is 0073.                                                                                                                                                                                         |
| Object types are a closed list; `LINK_TARGET_TYPES` is `account, contact, lead, deal`. `FEATURES` is `imports, exports, web_forms`. Actions are `read, create, update, delete, export, import`.                                                                                                             | New object type `email_message` and new feature `email` (section 5).                                                                                                                                                                                                                   |
| GitHub's default branch is `main`, 133 commits behind `master`. This PR targets `master` as asked.                                                                                                                                                                                                          | Only a note. Nothing to do.                                                                                                                                                                                                                                                            |

## 3. Data model and the send path

### 3.1 Tables (migration `0032_email_send_log.sql`)

All four are tenant-owned: `id` is UUIDv7, `tenant_id uuid NOT NULL` with a composite unique `(tenant_id, id)`,
the usual audit columns, RLS on, `FORCE`d the way the lead-form tables are. Created empty, so no lock worth naming.

| Table                 | Purpose                                                                                          | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_messages`      | One row per email (the log).                                                                     | `direction` (`outbound`; `inbound` is allowed by the CHECK but unused until PR 4), `status` (`queued`, `sending`, `sent`, `failed`; the CHECK also allows `delivered`, `bounced`, `complained` for PR 3), `from_name`, `from_address`, `reply_to`, `to_address` (citext, lowercased), `subject`, `body_text`, `message_id` (our own, unique per tenant), `provider_message_id`, `failure_code`, `attempts`, `queued_at`, `sent_at`, `failed_at`, `erased_at`. |
| `email_message_links` | What the email is about: `(object_type, record_id)`, like `activity_links` (ADR-0005).           | Unique `(tenant_id, email_message_id, object_type, record_id)`; index `(tenant_id, object_type, record_id, email_message_id)`; CHECK on `object_type` against `LINK_TARGET_TYPES`. Real composite FK to the message, no FK to the target (polymorphic).                                                                                                                                                                                                       |
| `email_sender_config` | One row per tenant: the company's sender identity (section 4.2).                                 | `from_name`, `reply_to` (nullable), `footer_text` (nullable), `version`. Unique on `tenant_id`.                                                                                                                                                                                                                                                                                                                                                               |
| `email_daily_counts`  | The send caps, counted in the database so they hold without Redis (same idea as lead-form caps). | `(tenant_id, day, user_id, sent)`, unique on the first three. The day is the tenant's own time zone day (`Asia/Kolkata` by default), so a cap does not reset at 05:30.                                                                                                                                                                                                                                                                                        |

Decisions inside that:

- **Body: plain text only, stored as `body_text` (max 10,000 characters). No stored HTML.** The server builds the
  HTML part at send time by escaping the text and turning blank lines into paragraphs. The screen shows the body as
  text, never with `dangerouslySetInnerHTML`. So there is **nothing to sanitize and no stored-XSS surface** in v1.
  If rich text is wanted later it goes through `sanitizeRichText` on write and read (ADR-0024), exactly like notes.
- **The subject** is plain text, 1 to 200 characters, no line breaks (refused, not stripped).
- **`from_address` is stored** so the log shows what was really used even if configuration changes later.
- **Soft delete and versions.** Convention says mutable business records get `deleted_at` and `version`. A sent email
  is a record of what happened, not something users edit: no edit, no user delete, no `version`, and the only
  mutations are the worker's status changes. That is a stated exception, the same as `timeline_events`. The message
  disappears from view when every record it is linked to is gone from view; it is **purged** when all its links are
  gone (a worker step like `pruneActivityLinks`; I will read how that one treats a soft-deleted record before copying it).
- **Retention.** Kept as long as a linked record exists. No separate expiry in v1; the business history is the point.
  Erasure of a person (data rights) **scrubs** `to_address`, `subject`, `body_text`, `reply_to` and sets `erased_at`;
  the row stays so counts and the audit trail stay true. Provider-side logs are the provider's own and need a line
  in the privacy documents (section 7).
- **Search:** email bodies are not added to global search in v1 (volume and personal data).
- **Privileges are the safety net.** The app role (`crm_app`) may `SELECT` and `INSERT` on `email_messages`, and
  **cannot `UPDATE` it**. Only the worker role changes status, with a column-level grant. So no bug or crafted request
  in the API can mark a message "sent". A migration test asserts this (section 10).

### 3.2 Everything that lists "places that point at a contact"

New tables must join every list that already enumerates record references, or history silently goes missing. This is
the same trap ADR-0064 documents, so it is part of PR 1a, with a test each:

| List                                                  | What changes                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Record merge (`packages/db/src/merge`)                | `email_message_links` move to the surviving record; unique pairs are de-duplicated.                |
| Erasure (`data-rights`, `PII_COLUMNS`)                | Scrub as above. Also the lead-form style "submission rows" precedent for a worker-only delete.     |
| Tenant export (`TENANT_ARCHIVE_TABLES`)               | Add `email_messages` and `email_message_links`; a DPDP access export must include a person's mail. |
| Recycle bin purge and `pruneActivityLinks` equivalent | Prune links of purged records; purge messages with no links left.                                  |
| Lead conversion                                       | **Known gap in v1:** a lead's emails stay on the lead. Linking them to the new contact is PR 2.    |
| Bulk actions, saved views, search, dashboards         | Not touched. Said here so nobody looks for them.                                                   |

### 3.3 The send path

```
POST /api/v1/emails            (Idempotency-Key required, ADR-0060)  → 202, row in "queued"
  one transaction:
    load the record under RLS (404 if not visible)            can(<object>:read, record)
    can(email_message:create)                                  can(): section 5
    derive "to" from the record's email field (field rules apply; hidden = "no email address")
    refuse if consent.email is withdrawn, or the email entitlement is off
    spend one send from the daily caps (atomic upsert; over the cap = 429 + Retry-After)
    insert email_messages (queued) + email_message_links, audit row, outbox event email.queued.v1
worker: email.queued.v1 (relay.on, so imported history never triggers it, ADR-0071)
  1. own short transaction: UPDATE ... SET status='sending', attempts=attempts+1 WHERE id=$1 AND status='queued'
     zero rows = another delivery already took it: stop (this is the idempotency of the send)
  2. NO transaction open: provider.send(...)
  3. own short transaction: status='sent' (+ provider_message_id), or 'failed' (+ failure_code); outbox email.sent.v1 / email.failed.v1
```

- **At most once, on purpose.** A crash between steps 2 and 3 leaves `sending`. A customer getting the same email
  twice is worse than a rep seeing "outcome unknown, check your sent folder and retry if needed".
- **Retries.** A retryable provider error (`EmailSendError.retryable`: timeout, 429, 5xx) puts the row back to
  `queued` and throws, so the relay retries with its own backoff (2^n seconds, capped at 10 minutes, 8 attempts, about
  four minutes in all). A non-retryable error (the provider refused the address or the message) goes straight to
  `failed` and does not throw. When the relay gives up, an `onExhausted` handler sets `failed`
  (the hook exists for this, ADR-0029). Four minutes is short for a provider outage, so the Retry button is the
  real recovery.
- **Failure codes are a closed list, never provider text** (provider errors can repeat the address):
  `rejected`, `invalid_recipient`, `provider_unavailable`, `timeout`, `outcome_unknown`, `not_configured`.
  The screen turns each into one plain sentence.
- **The sweep (the part the relay does not do).** A small worker job, armed the way the recycle-bin sweep re-arms
  itself, every 5 minutes: `sending` older than 10 minutes becomes `failed / outcome_unknown`; `queued` older than
  10 minutes gets a fresh `email.queued.v1`. Without it a crashed worker means a message stuck for ever.
- **Retry button:** `POST /api/v1/emails/:id/retry` re-queues a `failed` message (same row, same links). It spends
  one send from the caps and writes an audit row. For `outcome_unknown` the dialog says it may already have arrived.
- **Event payloads carry ids and codes only** (`emailId`, `objectType`, `recordId`, `status`, `failureCode`). The
  timeline copies the whole payload into `timeline_events.detail`, and erasure does not reach that column, so an
  address, a subject or a body must never be in an event.
- **Timeline:** `projectTimeline` gets `email.sent.v1` ("Email sent") and `email.failed.v1` ("Email failed") summaries.

## 4. Sender identity, provider and configuration

### 4.1 The provider seam (additive change to `EmailProvider`)

`EmailMessage` gains optional `fromName`, `replyTo` and `messageId`; `send` returns `{ providerMessageId?: string }`
instead of nothing. Every current caller ignores the result and passes none of the new fields, so system mail is
unchanged. The adapters (Resend, SES, SMTP) build the `From` header as `"fromName" <configured address>`:

- **Code can never choose the From address.** Only the display name is per message. The address is the one the
  provider instance was built with. So a bug or a malicious tenant cannot send as another domain.
- `fromName` and `replyTo` are validated at the API **and again in the adapter**: no CR, LF, NUL, `<`, `>` or `"` in
  the name; `replyTo` must be one plain address. The existing SMTP adapter already refuses line breaks in recipient
  and subject; the same test pattern is extended.
- No new dependency. SMTP stays on `nodemailer`, Resend and SES on the guarded client.
- **Unverified until PR 1a is built:** exactly how each provider treats a display name, `Reply-To` and a custom
  `Message-ID`, and whether each returns a message id. Each adapter gets a spec against its fake. **SES has never
  been run against a live account** (ADR-0048), and the SMTP TLS success path is also not covered by tests.
  A real send through the owner's chosen provider is the first manual check.
- A second provider instance is built for this stream: the same adapter, but with the address from
  `EMAIL_OUTREACH_FROM`. Invitation and password-reset mail keep `EMAIL_FROM`, so a spam complaint about a rep's email
  cannot damage the sender reputation of sign-in mail.

### 4.2 Sender identity (tenant settings, nothing hardcoded)

- **From address:** one address on a domain the platform operator has verified with the provider (SPF and DKIM
  published; this is already what `EMAIL_FROM` requires). Never an address a company types in.
- **From name:** per company, default the company's name from tenant settings. Shown to the recipient as
  `Sharma Traders <mail@send.example.com>`. Edited in Settings > Email by whoever holds `tenant_settings:update`
  (the same grant tags use). Risk: a company can name itself after a bank. Mitigation: the visible domain is always the
  platform's, the name is limited to 80 characters of letters, digits and basic punctuation, and a tenant can be
  switched off by turning the `email` feature off (section 5).
- **Reply-To:** by default the sending user's own sign-in address, so a reply goes to the rep. A company may set one
  fixed address (for example a shared sales inbox). **The fixed address is not verified in v1** (nobody confirms they own
  it). A later step can send a confirmation link to it.
- **Footer text:** optional, plain text, up to 500 characters, appended below every email (a company name and
  postal address line, or an opt-out sentence). Nothing is added by us, no platform branding.
- **Minimum for a first version:** the shared verified domain above. **Not in v1:** a company's own domain
  (`mail.theircompany.in`). When wanted, the honest first cut is manual: the operator adds the domain in the provider's
  dashboard, pastes the DNS records the provider shows into the CRM screen for the company's admin to publish, and ticks
  "verified" after checking the provider says so. Automating it needs each provider's domain API, which I have **not
  checked**. DMARC alignment holds for the shared domain only because the From domain is the verified one.

### 4.3 Provider choice and the local adapter

Only through `EMAIL_PROVIDER` and the existing adapters. No vendor SDK outside an adapter, no host name in
application code (CLAUDE.md section 13.5). For tests and CI: `memory` (refuses production) gets two test hooks, "fail the
next send" (retryable or not) and "never answer" (to test the sweep). Local development: `smtp` into Mailpit, already
in `docker-compose.yml`. `console` stays. **No real mail is ever sent by a test.**

### 4.4 Configuration (registry)

One new variable, nothing else for v1:

| Variable              | Scopes      | Secret | Default      | Meaning                                                                                                                                           |
| --------------------- | ----------- | ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_OUTREACH_FROM` | api, worker | no     | `EMAIL_FROM` | The address CRM emails to customers are sent from, on a domain verified with the provider. Optional; unset means the same address as system mail. |

It goes into `packages/env/src/registry.ts` with a note that it must be on a verified domain, then **`pnpm config:docs`
must be run** and the regenerated `.env.example`, staging/production templates and `docs/CONFIGURATION.md` committed
(`pnpm config:check` fails CI otherwise). Never in the `web` scope. Send caps are named constants in `@crm/core`
(like the retire cap in the pipeline editor), not variables. Later steps add more: a webhook signing secret (PR 3),
an inbound domain (PR 4); each is its own registry entry then.

## 5. Permissions, audit, limits and abuse

- **New object type `email_message`** (administrative kind, scope `all`; actions `read` and `create`, where `create`
  means "send"). Default grants: Owner and Admin, and also Manager and Sales Rep. **Read-only gets none**: an email body is
  a conversation, not a field, and a viewer who cannot export should not read what colleagues wrote to customers.
  Migration 0032 backfills the grants for existing tenants (like 0028). The role matrix, access explorer labels, grant
  catalogue and parity specs are updated (they enumerate `OBJECT_TYPES`).
- **The rule that matters: a user may only email, and only read the emails of, records they can see.** Sending calls
  `can(email_message, create)` **and** `can(<contact|lead|deal>, read, record)` at the user's own scope. Reading
  the list calls `can(email_message, read)` and the record's own visibility; one message is visible if any record it
  is linked to is visible to the caller. Anything outside is a **404, not 403**. So a rep with `own` scope can send to
  their own contacts and cannot see a colleague's email on someone else's contact, while a manager sees the team's, and an
  email sent from a deal shows on the deal and the contact, for everyone who can see either.
- **Field-level:** the recipient is read through the serializer's field rules. If the `email` field is hidden from the
  caller, the answer is the same as "no email address" (422 `NO_EMAIL_ADDRESS`), never "hidden". A client cannot send
  `to`, `from`, `replyTo` or a link target other than the record: the schema is `.strict()` and unknown keys are 422.
  (Merge fields, PR 2, read only fields the sender may read.)
- **Audit:** `email.queued` (actor, record, message id, no body), `email.retried`, `email_sender_config.updated`
  (before and after). Status changes by the worker are outbox events, projected to the timeline. Reading is not audited
  (same as reading a contact).
- **Entitlement:** new feature `email` (checked with `entitlements.has`, never a plan name). On for every plan now;
  it exists so one abusive tenant can be switched off without a deploy (ADR-0047 overrides).
- **Rate limits:** the existing per-user and per-tenant request limits already apply (ADR-0053). On top: a burst limit of
  10 sends a minute per user, and daily caps per user and per tenant counted in `email_daily_counts`. **Proposed numbers,
  yours to change:** 100 a day per user, 500 a day per tenant, and for a tenant younger than 14 days 20 and 100.
  For scale, Zoho's cheapest paid plan allows 250 a day of mass email (gap analysis; Zoho's one-to-one limit I did not check).
- **Abuse and spam risks, and what answers each:**
  open relay (recipient comes from the record only); header injection (validated twice, tests with `\r\n`);
  phishing from our domain (display-name limits, caps, the new-tenant ramp, the `email` switch);
  one tenant ruins the shared sending reputation (the separate outreach address, caps, and PR 3's complaint and bounce
  handling, which should be done **before** any tenant sends in volume);
  stuffed or hostile bodies (plain text only, length limits, no links rewritten, no tracking pixel, no attachments);
  a rep emailing a list by looping (burst limit and cap, and bulk mail is deliberately not in this plan).

## 6. Templates and merge fields

**Deferred to PR 2.** Version 1 is compose-only, so the first slice can be proven first. PR 2 adds `email_templates`
(name, subject, plain-text body, `version`, soft delete; same RLS and tests) and a **closed list** of merge fields, filled
server-side at queue time:

`{{contact.first_name}}`, `{{contact.last_name}}`, `{{account.name}}`, `{{deal.name}}`, `{{sender.name}}`, `{{company.name}}`.

An unknown name is refused when the template is saved, not left as literal text. A field the sender cannot read
renders empty and the dialog says so. Values are inserted as text, so there is nothing to escape into the plain-text part, and the
HTML part escapes them. No scripting, no conditionals.

## 7. Consent, unsubscribe and Indian rules

**I am not a lawyer and none of this has been reviewed. Legal review is still pending** (`docs/legal/*` are drafts
with open items). What I can say from the repository and general knowledge, marked as such:

- **TRAI's commercial-communication rules (DLT registration, templates) govern SMS and voice, not email.** I do not
  know of an Indian email-specific marketing statute equivalent to the US CAN-SPAM Act; **unverified, ask counsel.**
- **The DPDP Act 2023 applies to the personal data in these emails** (address, name, content). Notice and consent, the
  right to withdraw, and erasure are the parts that touch this feature. Our own DPA draft says the service **has no
  consent-management functionality** today, and that is still true: `contacts.consent` is stored and not enforced.
  Customers are the data fiduciary, we are the processor.
- If a customer has EU contacts, GDPR rules on direct marketing also apply; out of scope here.
- **Technical rule proposed for v1** (one-to-one business email, not marketing blasts):
  1. if `consent.email.status` is an explicit **withdrawal**, sending is refused (422 `CONSENT_WITHDRAWN`), with no override;
  2. if there is no consent record at all, sending is allowed and the dialog shows a visible "no email consent recorded"
     notice, so the rep knows;
  3. the footer is the company's own text; I recommend an opt-out sentence there.
- **Unsubscribe link:** a one-to-one email does not carry a one-click link in v1. PR 3 adds a signed link and
  `List-Unsubscribe` header that sets `consent.email.status` to withdrawn and logs it, because a public link is a new door onto the
  internet and deserves its own security review (the lead form's was 52 KB of plan). **Bulk or marketing mail needs the
  link and recorded opt-in, and is not planned here.**
- **Privacy documents need three lines** (not drafted by me): emails are stored in the CRM; the provider is a sub-processor
  for these messages; erasure scrubs the stored copy but not the provider's own logs.

## 8. Inbound replies

**Version 1 does not include inbound.** Replies go to the rep's own inbox through `Reply-To`, so conversations keep
working. They are not logged.

| Option                                                                                                                                                                                                         | Needs                                                                                                                                                                                                                                                                                | Effort and risk                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forwarding address** (recommended): each company gets a hard-to-guess address on a platform domain; reps BCC it or forward to it. A per-message `Reply-To` of the same kind would capture replies by itself. | An inbound domain with MX records; an inbound provider or route (none of ours does this today, and I have not checked what each offers); MIME parsing (probably a dependency, which I would ask about); matching by our stored `message_id` and `In-Reply-To`, or by sender address. | Medium. No customer mailbox credentials ever. The risks are spoofed senders and mail bombs: authenticate by the secret address, cap size and rate, quarantine what does not match, never trust a "From". |
| **Connect the mailbox** (Gmail, Outlook): OAuth, then sync.                                                                                                                                                    | OAuth apps and provider review (Google restricts mailbox-read access and may require a security assessment: **unverified**); token storage; sync jobs.                                                                                                                               | Large. Stores the keys to a person's whole mailbox. This is what Zoho's "connect your email" is. Phase 3.                                                                                                |

Recommended: **forwarding address first (PR 4), mailbox connection later or never.** It captures what a small
business needs (the customer's answer on the record) without holding anyone's mailbox.

## 9. Screens

All strings through `t()` (keys under `email.*`), dates through the shared formatters, components from `@crm/ui`, tokens
for light and dark, keyboard reachable with visible focus, labels on every input, AA contrast.

1. **Send email dialog** (contact, lead and deal pages; a "Send email" button on each). From a deal the recipient is
   chosen among the deal's contacts the user can read. Fields: To (read-only, from the record), Subject, Body, a line showing
   "Sent as {from name}, replies go to {reply-to}". `Ctrl+Enter` sends.
   - _Loading:_ skeleton while the record and the sender settings load.
   - _Empty:_ the record has no email address: no form, a message and a button to edit the record's email.
   - _Error:_ a send that fails shows the reason in words; the text typed is kept.
   - _No permission:_ no `email_message:create` or a hidden address: the button is disabled with the reason. This is cosmetic; the API is the gate.
   - _Limit reached:_ "You have reached today's limit of N emails. It resets at midnight."
2. **Emails card** beside the Activities card on the four record pages (accounts are not in v1). Newest first, cursor-paged,
   each row: subject, to, who sent it, time, status badge (Queued, Sending, Sent, Failed), click to read the body as text.
   Failed rows show the reason and **Retry**. A "Sent" tooltip says "accepted by the mail service".
   - _Loading:_ skeleton rows. _Empty:_ "No emails yet" with a Send email action. _Error:_ message and Try again.
   - _No permission (403):_ "You don't have access to email history."
3. **Settings > Email** (from name, reply-to, footer; shows the sending address read-only, today's usage and the limits).
   Loading, error, and no-permission states; saving uses `version` and shows a conflict if two admins collide.
4. **Setup checklist:** one extra optional step "set your email sender" (Zoho's checklist has "connect your email").

Statuses refresh by polling the list every few seconds while any row is queued or sending, then stop.

## 10. Tests (CLAUDE.md section 10, the mandatory set)

| Mandatory item                          | Cases                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Tenant A cannot touch Tenant B      | List, read and send against B's contact id: 404, nothing queued. Settings per tenant. RLS on all four tables, including with a forged `app.tenant_id` of the other tenant. The worker handler run under tenant A cannot read B's row.                                                                                                                                                                                |
| (b) `own` scope                         | A rep cannot send to, list or read the emails of a colleague's contact (404). A manager sees the team's. An email on a deal and a contact is visible to someone who can see only the contact. Read-only has no access.                                                                                                                                                                                               |
| (c) Hidden fields                       | Hidden `email` field: `NO_EMAIL_ADDRESS`, identical to an empty field. A client-supplied `to`, `from`, `replyTo`, `status`, `objectType` other than the record: 422 (`.strict()`).                                                                                                                                                                                                                                   |
| (d) 401                                 | Every new route unauthenticated.                                                                                                                                                                                                                                                                                                                                                                                     |
| Send path                               | Same `Idempotency-Key` twice: one row, one provider call. Event delivered twice: one provider call (the claim). Retryable then success; non-retryable straight to failed; exhaustion marks failed; a stuck `sending` and a stuck `queued` are fixed by the sweep. Cap: two concurrent sends at cap minus one produce exactly one; per tenant and per user; reset at the tenant's midnight. Consent withdrawn blocks. |
| Privilege and payload                   | The app role cannot `UPDATE` `email_messages` (migration spec). Event payloads and `timeline_events.detail` contain no address, subject or body. Header injection: `\r\n` in subject, from name and reply-to is refused at the API and in each adapter.                                                                                                                                                              |
| Integration with older features         | Merge moves the links. Erasure scrubs and keeps the row. Tenant export includes both tables. Purge removes orphans. Parity specs for the new object type and the new feature. OpenAPI regenerated (`docs/openapi.json`).                                                                                                                                                                                             |
| Adapters                                | Resend, SES, SMTP specs against their fakes: From header, Reply-To, Message-ID, returned id, refusal paths. The boundary test that only `smtp.ts` imports `nodemailer` keeps passing.                                                                                                                                                                                                                                |
| **E2E (Playwright), one critical flow** | A rep opens a contact with an address, sends an email, the Emails card goes from Queued to Sent; a manager opens the same contact and sees it; a read-only user has no button and the API refuses. Uses whatever provider the E2E stack already uses for invitations (to be confirmed in PR 1b); a failure path is covered in integration, not E2E.                                                                  |

**CI-first, because the laptop is memory-tight.** The Testcontainers suites, the security suite and Playwright run on CI
only: push a draft early and read the checks per job. Locally, one at a time and only for the packages touched:
prettier, lint, typecheck, and the light unit specs (`packages/core`, `packages/outbound`). No local web build,
no local Playwright, no local full database run unless you ask for a slot.

## 11. Phases (each a PR you approve; nothing merges without you)

| PR     | What                                                                                                                                                                                                                                                                                                                                                                                         | Why it stands alone                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **1a** | **Server only.** Migration 0032, `EmailProvider` extension and adapters (and removal of the API's duplicate interface), `emails` and `email-settings` API modules, contracts, `email_message` permission and `email` feature with backfill, caps, worker handler and sweep, timeline summaries, merge, erasure, export and purge integration, registry variable, ADR-0073, all server tests. | Invisible to users, so safe to merge; verifiable entirely on CI. |
| **1b** | **Screens.** Send dialog, Emails card, Settings > Email, i18n, checklist step, Playwright flow, `docs/MVP_SPEC.md` ticks.                                                                                                                                                                                                                                                                    | The smallest thing a user can actually use.                      |
| 2      | Templates, merge fields, linking a lead's emails to the contact on conversion, a signature per user.                                                                                                                                                                                                                                                                                         | Needs 1a and 1b in real use first.                               |
| 3      | Delivery status from the provider (delivered, bounced, complained) through a signed webhook; automatic stop for addresses that hard-bounce; one-click unsubscribe. **Do this before anyone sends in volume.**                                                                                                                                                                                | Public endpoint and sender reputation: its own security review.  |
| 4      | Inbound replies by forwarding address (section 8).                                                                                                                                                                                                                                                                                                                                           | Needs the owner's inbound-provider decision.                     |
| 5      | Optional: a company's own sending domain, rich text, attachments (through the existing file service), scheduled send. Mass email is a separate plan and needs legal review first.                                                                                                                                                                                                            | Each is a decision of its own.                                   |

## 12. Questions for you, with my recommended answer

1. **Send from one shared platform address, with the company's name and the rep's reply address, until companies ask
   for their own domain?** _Recommend yes._ It works on day one with no DNS work for the customer.
2. **Which provider do you want mail to go out through first (Resend, Amazon SES, or an SMTP server you already have)?**
   _Recommend: the one you already hold an account with._ If you want mail processed in India, ADR-0048 says the SES
   region decides where; the Mumbai region would fit. Either way a real send needs a verified domain and (for SES) leaving
   the sandbox, and I will not claim it works until you try it.
3. **Do you want replies logged in the first release?** _Recommend no._ Replies reach the rep's inbox. Add the
   forwarding address in PR 4 after PR 3.
4. **Who may send and read?** _Recommend: Owner, Admin, Manager and Sales Rep; Read-only cannot._ A rep can only email
   records they can see.
5. **What should happen when a person has opted out?** _Recommend: block the send when they have explicitly withdrawn;
   only warn when no consent is recorded._ Please have counsel confirm before real customers use it.
6. **Daily limits?** _Recommend 100 per person and 500 per company a day, and 20 and 100 for the first 14 days._ Easy to change.
7. **Plain text only in the first release?** _Recommend yes._ No formatting, no pictures, and no risk of hostile
   markup. Rich text can come after real use.
8. **Keep every email for as long as the record exists, with no delete button?** _Recommend yes._ It is the company's
   history. A person's erasure request scrubs their emails.
9. **Contacts, leads and deals only (not accounts) in the first release?** _Recommend yes._ Accounts have an email
   field but people are who you write to.
10. **Should reps see "Sent" as the final word?** _Recommend yes for now, labelled "accepted by the mail service"._
    "Delivered" and "bounced" arrive with PR 3.
11. **Two pull requests for the first slice (server, then screens)?** _Recommend yes._ The server can be fully checked
    on CI before any screen exists.
12. **Who reviews the privacy wording (section 7)?** _Recommend: before the first real customer sends an email, not
    before the build._ I have not drafted legal text.

## 13. Risks and honest limits

- Nothing in this plan was run. Provider behaviour for display name, `Reply-To`, `Message-ID` and returned ids is
  unverified until the adapter specs and a real send exist.
- "At most once" means a rare "outcome unknown" instead of a rare duplicate. If you prefer the opposite, say so.
- The relay's lack of recovery for events stuck in `processing` is a platform-wide finding. This feature works around
  it with its own sweep; the general fix is a separate decision.
- The digest handler marks notifications as sent and sends mail in one transaction, then (by its own comment) relies on the
  mark surviving a failed send. A failed send rolls the mark back, so a retry would send again. Worth a look; **not**
  part of this plan.
- Shared sending reputation is the largest commercial risk. Caps, the separate outreach address and PR 3 are the answers; a
  company's own domain (PR 5) is the real fix.
- Heavy runs are CI only. Each later PR is cut from `master` and re-checks the migration number at push.
