# Privacy Policy

> ## ⚠️ DRAFT — NOT LEGAL ADVICE, NOT FOR PUBLICATION
>
> This is an **unreviewed draft prepared by the engineering team** for review by
> qualified Indian counsel. It is **not legal advice**. Nobody who wrote it is a
> lawyer.
>
> **Do not publish this, link to it, or show it to a pilot customer, a prospect,
> an investor or a regulator until a lawyer has reviewed and approved it.**
> `docs/MVP_SPEC.md` §14 records a lawyer review of the Terms of Service,
> Privacy Policy and DPA as **blocking before pilots**.
>
> Every `[TO BE CONFIRMED: ...]` marker is a business fact that could not be
> derived from the code. They are collected in [README.md](README.md).
>
> Draft date: 2026-10-23 · Written against commit `2acab50` · Status:
> **unreviewed**

---

## 0. How this draft was written

Every factual statement below about what the software stores, sends, retains or
deletes was read out of the codebase rather than taken from a template, and the
file it came from is named. Where the product does **less** than a policy of
this kind normally promises, the gap is stated rather than smoothed over — a
privacy notice that describes handling the software does not perform is a
misrepresentation to customers and to the Data Protection Board, and is worse
than no notice at all.

Section 12 lists, plainly, what this product **cannot** do.

---

## 1. Who we are

**[TO BE CONFIRMED: full legal entity name, CIN/LLPIN, registered address]**
("we", "us", "our") operates **[TO BE CONFIRMED: product name — the codebase
calls it "CRM", which is a placeholder, not a brand]** (the "Service"), a
web-based customer relationship management platform.

- Grievance Officer: **[TO BE CONFIRMED: name, designation, email, postal
  address, telephone]**
- Data protection contact: **[TO BE CONFIRMED: whether this is the same person.
  The DPDP Act requires a Data Protection Officer only for a Significant Data
  Fiduciary, but §8(9) requires published contact details of the person who can
  answer questions about processing.]**

This policy is published under India's **Digital Personal Data Protection Act,
2023** (the "DPDP Act"). Where we serve customers or data principals outside
India, additional law may apply; section 16 and Annex B set out where the GDPR
imposes stricter duties.

**[TO BE CONFIRMED: whether the DPDP Rules have been notified and are in force
at the date of publication, and what the applicable commencement and transition
dates are. The Act was enacted in August 2023 and draft Rules were published for
consultation in January 2025. Several obligations below — in particular the
mechanics and deadlines of breach reporting, the prescribed form of a consent
notice, and Consent Manager registration — depend on the Rules as finally
notified. Counsel must confirm the position as at the publication date and
re-check this draft against it.]**

---

## 2. The two capacities this policy covers

The Service holds personal data in two very different roles, and they must not
be confused.

|                                 | **Part A — our own users**                                                       | **Part B — our customers' CRM records**                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Whose data                      | People who sign up for or are invited into a workspace: our customer's own staff | People our customer records in the CRM: their contacts, leads, and the individuals at their account companies |
| Our role under the DPDP Act     | **Data Fiduciary**                                                               | **Data Processor**                                                                                            |
| Our role under the GDPR         | Controller                                                                       | Processor                                                                                                     |
| Who decides why it is processed | We do                                                                            | The customer does                                                                                             |
| Governed by                     | This policy                                                                      | This policy for transparency, and the [Data Processing Agreement](DPA.md) contractually                       |

**For Part B we do not decide what is collected, why, or on what lawful basis.**
The customer who operates the workspace is the Data Fiduciary for those records.
If you are a contact, lead or other individual whose details appear in a
customer's CRM and you want to exercise your rights, your request goes to **that
business**, not to us; see section 11.4. We will, however, help our customer
answer it, as the DPA requires.

---

## 3. Part A — personal data we hold about our own users

This is what the software actually stores. The table names are real; the field
lists come from `packages/db/src/schema/`.

### 3.1 Your identity and profile — `users`

Full name, email address (stored as `citext`, i.e. compared case-insensitively),
whether and when the address was verified, profile image URL if set, locale
(default `en-IN`), time zone (default `Asia/Kolkata`), whether multi-factor
authentication is enabled, and created and updated timestamps.

The `users` table is **global**, not per-workspace: one person has one row
however many workspaces they belong to, because consultants and agencies
legitimately work across several businesses (ADR-0014). Which workspaces you
belong to is recorded separately in `memberships`, with your role, your status
(`invited` / `active` / `suspended`), who invited you, and when you joined.

### 3.2 Credentials and authentication — `auth_accounts`, `mfa_factors`, `verifications`, `sessions`

- **Password**: stored only as an **Argon2id hash**. We never store, log or can
  recover your password.
- **Multi-factor authentication**: the TOTP secret and the backup codes are
  stored **encrypted at the application layer**; backup codes are held as
  SHA-256 hashes of the codes.
- **Sessions**: we store the **SHA-256 digest** of the session token, never the
  token itself, together with its expiry, the IP address and user agent of the
  device, the workspace the session is acting in, the last-seen time and a
  revocation epoch. A stolen database backup therefore yields no usable
  sessions.
- **Email verification, password reset and MFA challenge tokens**: the SHA-256
  digest only, with the address, the purpose, an expiry and a single-use marker.
- **Social sign-in**: if Google sign-in is enabled, the provider account
  identifier and OAuth tokens. See section 7.4 — **it is not enabled today**.

### 3.3 Authentication events — `auth_events`

Every sign-in attempt and its outcome: the email address that was tried (kept
even when it matches no account, so that probing is visible), the user id if
known, the event type, the IP address, the user agent, the request id, success
or failure, and the time. This drives brute-force protection and is append-only.

### 3.4 The audit log — `audit_logs`

The Service records an audit entry for each material action: record creation,
update and deletion; restores, purges, erasures and audit redactions; exports
and imports; sign-in and sign-out; and permission and role changes
(`apps/api/src/platform/audit.service.ts`).

Each entry holds who acted, what they did, to which object and record, **a diff
of the field values that changed (old and new)**, the IP address, the user agent
and the request id.

**The audit log is append-only by database privilege, not by convention.** The
application's database role is granted `INSERT` and `SELECT` and is deliberately
not granted `UPDATE` or `DELETE`, so the application physically cannot rewrite
history. This has a direct consequence for erasure, set out in section 10.3.

### 3.5 Product activity

- **Notifications** addressed to you (`notifications`), and whether an email
  digest has already included them.
- **Recently viewed records** (`record_views`): which records you opened and
  when, one row per person per record.
- **Invitations** you sent or received (`invitations`): the invited address, the
  role offered, a SHA-256 digest of the invitation token, the expiry, and
  whether it was accepted, revoked or superseded. Spent invitations are kept
  indefinitely as the record of who invited whom; see section 10.

### 3.6 Logs

The API and the worker write structured JSON logs (`pino`) carrying a request
id, tenant id and user id. A redaction list keeps secrets out of them, and the
rule in CLAUDE.md §5.8 is that tokens, passwords, one-time codes and full
personal data are never logged. **[TO BE CONFIRMED: where application logs are
stored, by which provider, and for how long. This is a deployment decision and
nothing in the repository fixes it.]**

### 3.7 Billing data

**None today.** The Service has no billing, payment or subscription module —
there is no payment code in the repository and no payment processor is
integrated. **[TO BE CONFIRMED: whether pilots are free of charge. If any fee is
taken, a payment processor becomes a recipient and this section and section 7
must be rewritten.]**

---

## 4. Part B — personal data our customers put into the Service

We process the following **on our customers' instructions**, as their Data
Processor. We do not choose it, and we do not use it for our own purposes.

### 4.1 Contacts — `contacts`

First name, last name, email address (`citext`), phone number (E.164), WhatsApp
number, job title, postal address (a JSON object), lead source, the owning user,
and the account the contact belongs to.

### 4.2 Leads — `leads`

First name, last name, company, email address (`citext`), phone number (E.164),
source, status, and — after conversion — which contact, account and deal the
lead became.

### 4.3 Accounts (companies) — `accounts`

Company name, domain, industry, phone, email, website, **GSTIN** (Indian GST
identification number), billing and shipping addresses (JSON objects), annual
revenue, employee count, and the parent company. A company record is not itself
personal data, but its phone, email and addresses frequently identify a person.

### 4.4 Deals — `deals`

Deal name, the linked account and primary contact, additional linked contacts
and their role on the deal, amount and currency, stage, probability, expected
close date, close date and lost reason.

### 4.5 Activities — `activities`

Tasks, calls, meetings and notes: subject line, a rich-text body (sanitised
HTML, ADR-0024), the assignee, due date, completion, priority and status. An
activity is linked to records through a polymorphic link table, so one meeting
can be attached to a contact and a deal at once.

**The body of a note is free text.** It frequently contains more personal data
than any structured field — what somebody said, their circumstances, their
health, their family. Section 12.3 explains why this matters for erasure.

### 4.6 Attachments — `attachments`

Files attached to any record. The database row holds the file name, the MIME
type (chosen by the server from an allow-listed extension, never by the client),
the size, a random 256-bit storage key and the verification status. **The bytes
never pass through the API**: they are written to and read from S3-compatible
object storage directly by the browser, through presigned URLs valid for five or
ten minutes. File type is verified against magic bytes as well as against the
claimed type.

### 4.7 Custom fields — `custom_fields` on every record type

Every record type carries a `custom_fields` JSON column holding whatever fields
the customer has defined for their workspace (ADR-0004). **We cannot know what
is in it.** A customer can define a field for anything, including data they or
their regulator would treat as more sensitive. The customer is responsible for
what they define and collect there, and for the lawful purpose and notice behind
it.

### 4.8 Tags, timeline and search index

Tags attached polymorphically to records; a per-record timeline projected from
domain events (`timeline_events`), where **the summary text of an event may name
a person**; and a search index (`search_documents`) holding searchable text
derived from records.

### 4.9 Consent records — present in the schema, **not implemented**

The `contacts` table has a `consent` JSON column intended to hold per-channel
consent (channel, status, source, timestamp), and `docs/MVP_SPEC.md` M11 lists
"contact consent tracking" as in scope.

**It is not built.** No API contract exposes it, no screen writes it, and no code
reads it. The column exists and is always `{}`. See section 12.1 — this is the
single largest gap between what a privacy policy of this kind would normally
promise and what the Service does.

---

## 5. Why we process personal data, and on what basis

### 5.1 Part A — our own users

| Purpose                       | What it covers                                                                                           | Lawful basis under the DPDP Act                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providing the Service         | Creating and running your account, authenticating you, keeping you signed in, showing you your workspace | **[TO BE CONFIRMED: whether counsel prefers consent under §6 or a "certain legitimate use" under §7(a) — voluntary provision of data for a specified purpose]** |
| Security and abuse prevention | Brute-force protection, rate limiting, session revocation, the audit log                                 | **[TO BE CONFIRMED: §7 legitimate use or legal obligation — counsel to settle]**                                                                                |
| Operational email             | Address verification, password reset, workspace invitations, the activity digest                         | As above                                                                                                                                                        |
| Support                       | Answering your questions                                                                                 | As above                                                                                                                                                        |
| Legal and regulatory          | Responding to lawful requests; keeping the audit record                                                  | Compliance with law                                                                                                                                             |

We do **not** use your data for advertising, profiling, behavioural tracking, or
to train any machine-learning model. There is no analytics, advertising or
tracking code anywhere in the product (section 6).

### 5.2 Part B — customers' CRM records

The **customer** determines the purpose and the lawful basis, and is responsible
for giving the notice the DPDP Act §5 requires to the people whose details they
record. We process those records **only** to provide the Service to that
customer and on their documented instructions, as set out in the
[DPA](DPA.md).

---

## 6. Cookies, local storage and tracking

The Service sets **one cookie**:

| Cookie                                             | Purpose             | Attributes                                                          | Lifetime                                            |
| -------------------------------------------------- | ------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Session cookie (name set by `SESSION_COOKIE_NAME`) | Keeps you signed in | `httpOnly`, `SameSite=Lax`, `Secure` in production, set server-side | `SESSION_TTL_DAYS`, default **14 days**, maximum 90 |

It is strictly necessary. Page scripts cannot read it — an end-to-end test
asserts that the token appears in neither `document.cookie` nor either web
storage.

**Browser local storage** holds two per-device interface preferences and nothing
else: whether the sidebar is collapsed, and whether the keyboard-shortcut hint
has been dismissed. Neither ever leaves your browser.

**There is no tracking of any kind.** The product contains no analytics, no
advertising pixels, no session replay, no error-tracking vendor and no
third-party scripts or fonts. The Content Security Policy sets `font-src 'self'`
and limits `connect-src` to the application's own origin and the object store,
so the browser is not permitted to contact any other host.

For completeness: CLAUDE.md lists OpenTelemetry and Sentry in the intended
stack. **Neither is wired up** — no such dependency exists in the repository. If
either is added, this section and section 7 must change before it ships.

---

## 7. Who else sees the data (recipients and sub-processors)

This list is derived from the provider adapters in the code. Nothing else sends
personal data anywhere.

### 7.1 Email — Resend

The only email provider this build can send with in production is **Resend**
(`packages/outbound/src/resend.ts`; the alternatives print to a log or discard
the message, and both are refused in production). The adapter posts to
`api.resend.com` over HTTPS on port 443, pinned so that the API key cannot be
sent anywhere else, and it never logs the message, the recipient or the key.

Resend receives:

- **Your name and email address**, for account verification, password reset and
  workspace invitation messages;
- **The subject lines of your due and assigned tasks**, in the activity digest
  email. Task subjects are free text typed by your colleagues and **may name a
  contact** ("Call Priya about the renewal"), so Part B data can reach Resend
  this way.

We do **not** send marketing email, and the Service does **not** send email to
the contacts or leads in a customer's CRM at all.

**[TO BE CONFIRMED: Resend's contracting entity, the processing region of our
Resend account, the data-processing terms we sign with them, and whether counsel
is satisfied with them as a transfer recipient under DPDP §16.]**

### 7.2 Object storage (S3-compatible)

Attachments, generated exports and import files are stored in an S3-compatible
bucket — AWS S3, Cloudflare R2 or compatible (`packages/storage/src/s3.ts`).
Objects are stored under random keys and are reachable only through short-lived
presigned URLs.

**[TO BE CONFIRMED: which provider, which bucket region, and the contractual
terms. The code is provider-agnostic and the region is a configuration value.]**

### 7.3 Hosting and database

**[TO BE CONFIRMED: the hosting provider and region for the web application, the
API and the worker; the managed PostgreSQL provider and the region the database
physically sits in; and the backup location. This is the most important
unresolved fact in this document — see section 8.]**

Two facts a reviewer should have:

- The repository ships a **Docker Compose + Caddy** production example
  (`deploy/`), which is a self-hosted shape. The stated intention is to deploy on
  **Vercel**. These are different arrangements with different recipients, and the
  discrepancy is unresolved.
- `tenants.region` defaults to `ap-south-1`. That is **a label recorded against
  each workspace for future routing (ADR-0013), not evidence of where any data
  sits.** There is one region today and the router always returns the single
  default connection. The default must not be read as a residency commitment.

### 7.4 Google — only if social sign-in is enabled

Google sign-in is implemented but **disabled**: with `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` unset the endpoints return 404, which is the state in
development and in CI, and it has never been run against Google. If it is turned
on, Google becomes a recipient of sign-in data and this section must be updated
first.

### 7.5 Not used

For the avoidance of doubt, and contrary to what the intended stack in CLAUDE.md
might suggest: there is **no** analytics provider, **no** error-tracking
provider, **no** advertising network, **no** AI or machine-learning provider, and
**no** Redis service holding personal data (no Redis client is installed;
`REDIS_URL` is read into configuration but nothing connects to it).

### 7.6 Other disclosures

We may disclose personal data where required by law, to enforce our terms, or in
connection with a merger or acquisition — in the last case subject to **[TO BE
CONFIRMED: what notice we commit to giving customers]**.

---

## 8. Where the data is processed, and cross-border transfer

**[TO BE CONFIRMED: the hosting region.]** Until this is settled, no claim about
data residency should be made to anyone.

Under **DPDP §16**, personal data may be transferred outside India except to a
country the Central Government notifies as restricted, and sector regulators may
impose stricter rules that prevail. This is a _restriction-by-notification_
approach, materially different from the GDPR's adequacy-and-safeguards model: a
transfer is not unlawful merely because the destination lacks an adequacy
finding.

What is true today regardless of where we host:

- **Resend** is a non-Indian service, so operational email — your address, your
  name and your task subject lines — leaves India when a message is sent.
- Object storage and the database may be inside or outside India depending on
  the configuration chosen.

**[TO BE CONFIRMED: whether any pilot customer is in a regulated sector (banking,
insurance, payments, healthcare) whose regulator — for example the RBI's data
localisation direction for payment system data — imposes storage-in-India
requirements that override the DPDP default.]**

---

## 9. Security

### 9.1 What we can truthfully say we do

These are implemented and covered by automated tests, and are described in
`docs/SECURITY_REVIEW.md`:

- **Tenant isolation enforced by the database.** Every workspace-owned table has
  a `tenant_id` and a PostgreSQL row-level security policy that is both
  `ENABLE`d and `FORCE`d. Every request runs inside a transaction that sets the
  tenant and the user for that transaction. The application's database role does
  **not** have `BYPASSRLS` and does not own the tables. A test fails the build if
  any table with a `tenant_id` is missing the policy.
- **Separate database roles with least privilege**: `crm_app` (the API),
  `crm_worker` (background jobs), `crm_auth` (identity), `crm_migrator` (schema
  changes) and `crm_erasure` (see 10.3). They hold different grants and none of
  them is a superuser.
- **A single central authorisation engine.** Every endpoint is authorised through
  one `can(actor, action, resource)` function with a default of _deny_; a lint
  rule rejects inline role comparisons. Identity, workspace, role and ownership
  are always derived from the session on the server, never taken from the
  request.
- **Field-level permissions.** A field hidden from a role is removed from API
  responses, cannot be written, cannot be sorted or filtered on, is not matched
  by search, and is stripped out of audit diffs — on screen and in exported
  files, through one shared function.
- **No insecure direct object references.** A record outside your scope returns a
  404 byte-identical to the 404 for a record that does not exist.
- **Input validation** on every endpoint against strict schemas that reject
  unknown keys; rich text sanitised against an allow-list on write _and_ on read.
- **No SQL built by string concatenation**; sort and filter fields are
  whitelisted against field metadata.
- **Authentication hardening**: Argon2id password hashing; session tokens stored
  only as SHA-256 digests; TOTP multi-factor authentication with backup codes and
  workspace-level enforcement; CSRF origin checks on cookie-authenticated routes;
  progressive delay plus a per-IP ceiling on sign-in; and revocation of every
  existing session when a password changes.
- **Rate limiting** per user, per IP and per workspace.
- **File handling**: type verified by magic bytes _and_ against the claimed type;
  the maximum size signed into the presigned upload URL; random storage keys;
  short-lived presigned URLs; and the API process never touching the bytes.
- **CSV formula-injection escaping** on every cell of every file the product
  writes, decided on the first non-whitespace character.
- **HTTPS enforced by configuration validation**: the API and the worker refuse
  to start in production with a non-HTTPS public URL, a wildcard CORS origin, a
  placeholder session secret, a superuser database connection string, or an email
  or storage provider that would silently discard data.
- **Browser hardening**: a Content Security Policy restricting scripts, fonts and
  connections to the application's own origin and the object store.
- **Backups are restore-tested.** `deploy/backup-drill.sh` dumps a database,
  restores it into a fresh one, and then checks row counts and checksums, that
  row-level security is still enabled _and forced_ with identical policies and
  grants, that no role has `BYPASSRLS`, that the schema version matches, and that
  the real API boots on the restored database and still returns 404 for another
  workspace's record.

### 9.2 What we must not claim — known gaps

Stated here because `docs/SECURITY_REVIEW.md` records them as open, and
asserting a control we do not have would be exactly the misrepresentation this
document exists to avoid.

- **Encryption at rest is a property of the hosting provider, not of this
  application.** The application encrypts MFA secrets at the application layer
  and stores passwords and tokens only as hashes, but it does not itself encrypt
  the database or the object store. **[TO BE CONFIRMED: what at-rest encryption
  the chosen database and storage providers give us, so that a truthful statement
  can be made here.]**
- **TLS to the database is not enforced by the application's own configuration
  check.** The production validator rejects superusers, development passwords and
  localhost, but does not require `sslmode=require`. **[TO BE CONFIRMED: that the
  deployment enforces TLS to the database. This should also become a check in the
  code.]**
- **Rate-limit counters are per process.** With `REDIS_URL` unset — which is a
  production _warning_, not a refusal — each API instance counts separately, so a
  limit is weaker across several instances.
- **No breached-password checking.** Password policy enforces length and a
  character mix only.
- **No independent security assessment.** There has been no third-party
  penetration test, and we hold no SOC 2, ISO 27001 or equivalent certification.
  The security review in the repository is a **self**-review.
- **Google sign-in has never been exercised against Google.**
- **No person has reviewed the product for accessibility or security** beyond
  automated checks, and the Resend adapter has never sent a real message.

---

## 10. How long we keep personal data

These are what the code actually does. Where a period is a business choice
rather than something the code fixes, it is marked.

| Data                                                          | What happens                                                                                                                                                                                                | Period                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A deleted CRM record (account, contact, lead, deal, activity) | Soft-deleted: hidden from lists and search, restorable from the Recycle Bin, then hard-deleted by a background job together with its tags, links, timeline rows and recently-viewed entries                 | **30 days** (`RECYCLE_BIN_RETENTION_DAYS`, a constant in the code, not configurable per workspace) |
| A deleted attachment's bytes                                  | Kept so that an undelete could restore the file, then purged by the worker                                                                                                                                  | **30 days** (`ATTACHMENT_LIMITS.purgeAfterDays`)                                                   |
| A generated export or archive file in object storage          | Expires and stops being downloadable                                                                                                                                                                        | **24 hours** (`GENERATED_FILE_RETENTION_HOURS`)                                                    |
| A rejected upload                                             | Bytes deleted immediately; the row kept with the reason so the uploader is told why. Never listed, never downloadable                                                                                       | Row kept indefinitely                                                                              |
| Sessions                                                      | Expire; revoked on password change                                                                                                                                                                          | `SESSION_TTL_DAYS`, default **14 days**. Expired rows are not swept                                |
| Audit log entries                                             | **Never deleted.** See 10.3                                                                                                                                                                                 | Indefinite                                                                                         |
| Authentication events (`auth_events`)                         | **Never deleted.** No cleanup job exists                                                                                                                                                                    | Indefinite                                                                                         |
| Spent invitations (accepted, revoked, expired)                | **Deliberately kept** as the record of who invited whom; the security review records that no retention job exists for them                                                                                  | Indefinite                                                                                         |
| Your account after you stop using it                          | Nothing happens automatically                                                                                                                                                                               | Indefinite — see 10.2                                                                              |
| An erased person's record                                     | Personal columns cleared or replaced with `[erased]`, custom fields emptied, then soft-deleted into the Recycle Bin and purged with everything else after 30 days                                           | See 10.3                                                                                           |
| Backups                                                       | **[TO BE CONFIRMED: backup retention period, and the point at which a deleted record genuinely leaves the backups. Nothing in the repository sets this; it is a property of the managed database chosen.]** | **[TO BE CONFIRMED]**                                                                              |
| Application logs                                              | **[TO BE CONFIRMED]**                                                                                                                                                                                       | **[TO BE CONFIRMED]**                                                                              |

**[TO BE CONFIRMED: the retention periods the business wants for the audit log,
authentication events and spent invitations. Today each is "forever", because no
code deletes them. DPDP §8(7) requires erasure once the purpose is served and
retention is no longer required by law, so "forever" needs either a
justification counsel is comfortable with or a retention job in the product.]**

### 10.1 Deleting a workspace

**There is no self-service way to delete a workspace or close an account.** No
endpoint deletes a tenant, a user or a membership. An administrator can
_suspend_ a member, which removes their access but keeps their user record,
their audit history, and their name on the records they own.

Closing an account or deleting a workspace is therefore a **manual operation we
perform against the database** on request. **[TO BE CONFIRMED: the committed
turnaround for such a request, and the period before the data is
irrecoverable.]**

### 10.2 Your own account

You cannot delete your own account from the product. To ask us to, contact the
Grievance Officer (section 1); we will carry it out manually. Your entries in
the audit log will persist — see 10.3.

### 10.3 Erasure and the audit log — read this carefully

This is the point where the law, the product's integrity guarantees and the
ordinary wording of a privacy policy genuinely pull against each other. We would
rather state it than paper over it.

**The audit log is append-only by database privilege.** The application role has
no `UPDATE` and no `DELETE` on it. That is deliberate: an audit log the
application can rewrite is not an audit log.

**DPDP §12 and GDPR Article 17 nonetheless require personal values to stop being
readable on a valid erasure request.** The product resolves this (ADR-0032) with
a fifth database role, `crm_erasure`, whose credentials the API does not hold.
It has a single column-level `UPDATE` grant on the diff column alone, no
`INSERT` and no `DELETE`, and a policy that admits it to a row **only** while an
erasure request for that exact person is in progress. Outside that window it
sees nothing.

So, when a person is erased:

- **What is erased.** In the record: first name, email, phone, WhatsApp number,
  job title, postal address and the consent object are cleared; the surname is
  replaced by `[erased]` because it cannot be null; all custom fields are
  emptied. For a lead, the company is cleared too. In the audit log: the
  **values** in that person's own audit diffs are replaced by `[erased]`.
- **What survives, permanently.** _Who_ performed each action, _what_ action,
  _which_ record, _when_, and _from which IP address_. The column grant puts
  these beyond the reach of the erasure role by design. The erasure's own audit
  entry records counts, not values, so that it does not itself become the last
  place the erased data lives.
- **Why pseudonymisation rather than deletion for the surname.** Both the DPDP
  Act and the GDPR accept pseudonymisation where a record must remain for an
  independent reason — here, that the deal it is attached to is the business's
  own commercial record.

**This means we cannot promise complete deletion of a person's traces.** We
promise what the system does: personal values cease to be readable, and an
immutable record that somebody did something to some record at some time
remains. Section 12 lists the further limits.

---

## 11. Your rights under the DPDP Act

### 11.1 Right to access information about processing (DPDP §11)

A summary of the personal data being processed, the processing activities, and
the identities of other fiduciaries and processors with whom it has been shared.

**What the product does**: an authorised administrator can generate a
**per-person archive** — a JSON file containing the record, the activities linked
to it, its timeline, its tags, and up to **1,000** of its most recent audit
entries. The file is written to object storage and downloaded through a
short-lived link; it expires after 24 hours. An administrator can also export
the **whole workspace** as JSON.

**Limits, stated plainly**: the per-person archive does **not** include
attachments; the audit history in it is capped at 1,000 entries and is filtered
by the requesting administrator's own field permissions, so a field hidden from
that administrator is absent from the history (the record's own fields are
exported in full). Both archives are JSON only — CSV is refused with a clear
error rather than producing a file that silently loses the structure.

### 11.2 Right to correction, completion, updating and erasure (DPDP §12)

**What the product does**: records can be edited through the normal interface.
For erasure, an authorised administrator raises an erasure request, which the
background worker carries out as described in section 10.3.

**Limits**: erasure is implemented for **contacts and leads only**. See section
12.2.

### 11.3 Right of grievance redressal (DPDP §13)

Contact the Grievance Officer in section 1. **[TO BE CONFIRMED: the committed
response time. The DPDP Rules as finally notified may prescribe one; counsel to
confirm.]** The DPDP Act requires you to exhaust this route before approaching
the Data Protection Board of India.

### 11.4 If you are a contact, lead or other person in a customer's CRM

Your request goes to **the business whose workspace holds your details** — they
are the Data Fiduciary and they decide. If you contact us, we will tell you so,
pass the request to that customer promptly where we can identify them, and
assist them in answering it as our [DPA](DPA.md) requires. We will not access,
correct or delete a customer's records on your instruction alone.

### 11.5 Right to nominate (DPDP §14)

You may nominate another individual to exercise your rights in the event of your
death or incapacity. **The product has no feature for this.** A nomination would
be handled manually through the Grievance Officer. **[TO BE CONFIRMED: the
process the business will operate.]**

### 11.6 Withdrawing consent (DPDP §6(4)–(6))

Where our processing of _your_ data rests on consent, you may withdraw it at any
time, as easily as you gave it, and we will stop processing within a reasonable
time. In practice, withdrawal in respect of the Service means closing your
account (section 10.2), because the Service cannot be provided without
processing your identity and session data. **[TO BE CONFIRMED: once counsel
settles the lawful basis in section 5.1, this paragraph must be rewritten to
match it.]**

### 11.7 Your duties (DPDP §15)

The Act places duties on data principals too: not to impersonate another person
when providing data, not to suppress material information, and not to raise
false or frivolous grievances.

---

## 12. What this product cannot do

This section exists because the gap between a standard privacy policy and this
software is the thing most likely to turn into a misrepresentation. Every item
was verified in the code.

### 12.1 There is no consent management

The `contacts.consent` column exists and `docs/MVP_SPEC.md` M11 lists consent
tracking as in scope, but **nothing writes it, nothing reads it, and no screen or
API field exposes it**. The Service therefore:

- does not record when, how or on what basis a contact consented;
- does not record withdrawal of consent;
- does not check consent before anything, because the Service sends nothing to
  contacts;
- cannot evidence consent to a regulator.

A customer whose DPDP compliance depends on recording consent in the CRM must
know this before they load data. **We must not publish a policy, or let a
customer sign a DPA, implying otherwise.**

**The DPDP Act's "Consent Manager" is a separate concept**: an entity registered
with the Data Protection Board through which a data principal can give, manage,
review and withdraw consent. We are not a Consent Manager, we are not registered
as one, and we do not integrate with one.

### 12.2 Erasure covers contacts and leads only

`ERASABLE_OBJECT_TYPES` is exactly `['contact', 'lead']`. There is **no erasure
path** for:

- **accounts** — which hold a phone number, an email address and billing and
  shipping addresses that frequently identify a person;
- **activities** — whose free-text body is where the most sensitive notes live;
- **attachments** — a scanned document naming a person is not reached by an
  erasure of that person;
- **deals**;
- **our own users** (account holders) — see section 10.2.

### 12.3 Erasure reaches a person's own record, not records _about_ them

Audit redaction covers the subject's **own** audit rows. Deliberately out of
scope (ADR-0032, and stated in the security review):

- a task or note whose subject or body names the person;
- a deal named after them;
- timeline entries whose summary text names them — and note that an erased
  record's timeline rows survive in the Recycle Bin for the **30 days** before
  the purge sweep removes them;
- an attachment containing their details.

An erasure request is therefore **not** a guarantee that the person's name has
left the workspace.

### 12.4 No self-service portal for data principals

There is no interface through which a contact or lead can see, correct or delete
their own details. Every right in section 11 is exercised by an administrator of
the customer's workspace, on that person's behalf.

### 12.5 No age verification

The product asks for nobody's age and has no mechanism to identify a child
(under 18 under the DPDP Act) or to obtain verifiable parental consent as DPDP §9
requires. See section 13.

### 12.6 Limited breach-detection capability

We have structured application logs and an append-only audit log. We do **not**
have an error-tracking service, a security information and event management
system, intrusion detection, or alerting on anomalous access. Our ability to
_detect_ a breach is correspondingly limited, which bears directly on how quickly
we could meet the notification duties in section 14.

### 12.7 Portability

The DPDP Act contains no data-portability right (the GDPR's Article 20 does). In
practice the workspace archive gives a machine-readable JSON export, but we do
not hold it out as a portability mechanism.

---

## 13. Children's data

Under **DPDP §9**, processing a child's personal data (under 18 in India)
requires **verifiable consent of a parent or lawful guardian**, and tracking,
behavioural monitoring and advertising directed at children are prohibited
outright.

- The Service is a business tool and is **not directed at children**. We do not
  knowingly process children's personal data as a Data Fiduciary.
- We have **no age verification, no parental-consent mechanism and no way to
  identify a child's record** (section 12.5).
- Accordingly a customer **must not** load children's personal data into the
  Service unless they have themselves obtained verifiable parental consent as §9
  requires. This obligation is placed on them in the [DPA](DPA.md).

Penalties for breaches involving children's data are among the highest in the
Act's Schedule, which is why this is stated as a prohibition rather than a
caution. **[TO BE CONFIRMED: whether any intended pilot customer's business
involves individuals under 18 — education, coaching, paediatric healthcare and
youth services are the obvious cases. If so, counsel must be told before that
pilot starts.]**

---

## 14. Personal data breaches

Under **DPDP §8(6)**, a Data Fiduciary must give intimation of a personal data
breach to the **Data Protection Board of India** and to each **affected data
principal**.

- **For our own users (Part A)** we are the Fiduciary and the duty is ours.
- **For a customer's CRM records (Part B)** the **customer** is the Fiduciary and
  the duty is theirs. Our obligation is to notify them without undue delay so
  they can discharge it; this is set out in the [DPA](DPA.md).

**[TO BE CONFIRMED: the form and deadline for breach intimation under the DPDP
Rules as finally notified. The draft Rules proposed intimation to affected
principals without delay, and an initial report to the Board without delay
followed by a detailed report within 72 hours. Counsel must confirm the position
in force, and we must then put an incident runbook behind it.]**

**[TO BE CONFIRMED: whether the CERT-In Directions of 28 April 2022 apply to us.
They require specified cyber incidents to be reported to CERT-In within 6 hours
of noticing them, and are a separate obligation from the DPDP Act. If they apply,
an incident process that meets DPDP timing may still miss CERT-In's.]**

See section 12.6 on the limits of our detection capability. Operational incident
response lives in `docs/RUNBOOK.md`; **[TO BE CONFIRMED: that it is extended to
cover regulatory notification — who makes the call, and who signs the notice.]**

---

## 15. Significant Data Fiduciary status

Under **DPDP §10**, the Central Government may notify a Data Fiduciary, or a
class of them, as a **Significant Data Fiduciary**, having regard to the volume
and sensitivity of the data processed, risk to data principals, risk to the
sovereignty and integrity of India, electoral democracy, security of the State
and public order. A Significant Data Fiduciary must appoint a **Data Protection
Officer based in India** who reports to its board, appoint an **independent data
auditor**, and carry out **periodic Data Protection Impact Assessments** and
audits.

We have **not** been notified as a Significant Data Fiduciary, and at the
intended scale — a handful of pilot customers — we do not expect to be. **[TO BE
CONFIRMED: counsel to confirm the assessment. The business should also
understand that being notified later triggers obligations that need budget and a
hire: a DPO in India and an independent auditor are not a documentation
exercise.]**

---

## 16. If you are outside India

The DPDP Act governs this policy. If a customer or data principal is in the EU or
UK, the GDPR or UK GDPR may also apply and imposes **stricter** duties in several
places. Annex B summarises where.

**[TO BE CONFIRMED: whether the business intends to serve customers outside India
during the pilot. If the answer is yes for the EU or UK, this policy needs a
GDPR-specific part, an Article 30 record of processing, an Article 28-compliant
DPA (the current draft is written to be close, but counsel must verify), probably
an Article 27 representative in the EU, and transfer safeguards. If the answer is
no, say so explicitly and keep it that way until it is resourced.]**

---

## 17. Changes to this policy

We will update this policy when the product changes. **The rule the engineering
team holds itself to is that a change to what the product stores, sends, retains
or deletes is not finished until this document is updated** — see
[README.md](README.md).

**[TO BE CONFIRMED: how changes are notified to customers and users, and what
notice period applies.]**

---

## 18. Contact

**[TO BE CONFIRMED: Grievance Officer name, email, postal address and telephone,
and the business's registered address.]**

---

## Annex A — where to check these claims in the code

A reviewer who wants to check this policy against the schema should read
`packages/db/src/schema/` — `crm.ts` (accounts, contacts, leads, deals,
activities, tags, timeline), `identity.ts` (users, memberships, invitations),
`auth.ts` (sessions, credentials, MFA, verification tokens, auth events),
`platform.ts` (audit log, outbox, notifications, record views), `attachments.ts`,
`data-rights.ts` (export jobs, erasure requests) and `tenants.ts`.

The data-rights behaviour is in `apps/api/src/modules/data-rights/`,
`apps/worker/src/data-rights/`, `apps/worker/src/handlers/recycle-bin.ts` and
`packages/db/src/data-rights/`. The policy on what counts as personal data for
erasure is `PII_COLUMNS` in `packages/core/src/data-rights/index.ts`. Retention
constants are in `packages/core/src/data-rights/index.ts`,
`packages/core/src/files/attachments.ts` and
`packages/core/src/import-export/limits.ts`.

---

## Annex B — where the GDPR is stricter than the DPDP Act

Relevant only if we serve EU or UK customers or data principals. Not exhaustive;
for counsel's orientation.

| Topic                        | DPDP Act 2023                                                                   | GDPR — additional or stricter                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Lawful basis                 | Consent, or a listed "certain legitimate use" (§7)                              | Six bases including legitimate interests, requiring a balancing test and a record of it             |
| Notice                       | §5 itemised notice; language choice under the Eighth Schedule                   | Articles 13–14, a longer prescribed list including retention periods and the basis for each purpose |
| Records of processing        | No general requirement                                                          | Article 30 record of processing activities                                                          |
| Impact assessment            | Only for Significant Data Fiduciaries (§10)                                     | Article 35, whenever processing is high risk                                                        |
| Data Protection Officer      | Only for Significant Data Fiduciaries                                           | Article 37, where the criteria are met                                                              |
| Processor terms              | §8(2)–(3): a valid contract; content not prescribed in the Act                  | Article 28(3) prescribes the contract's content in detail                                           |
| Breach notification          | §8(6) to the Board and affected principals; timing in the Rules                 | Article 33: 72 hours to the supervisory authority; Article 34 to individuals where high risk        |
| Portability                  | No equivalent right                                                             | Article 20                                                                                          |
| Object / restrict processing | No equivalent                                                                   | Articles 18 and 21                                                                                  |
| Automated decisions          | No equivalent                                                                   | Article 22                                                                                          |
| Cross-border transfer        | §16 restriction-by-notification                                                 | Chapter V: adequacy, standard contractual clauses or other safeguards required                      |
| Children                     | Under 18; verifiable parental consent; no tracking or targeted advertising (§9) | Under 16, or 13–16 per member state, for information-society services                               |
| Representative               | Not applicable                                                                  | Article 27 representative in the EU for non-EU controllers                                          |

Where both apply, the stricter requirement governs in practice. **DPDP remains
the governing frame for this product.**
