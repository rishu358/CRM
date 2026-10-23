# Data Processing Agreement

> ## ⚠️ DRAFT — NOT LEGAL ADVICE, NOT FOR SIGNATURE
>
> This is an **unreviewed draft prepared by the engineering team** for review by
> qualified Indian counsel. It is **not legal advice**. Nobody who wrote it is a
> lawyer.
>
> **Do not sign this, offer it to a pilot customer, or attach it to a proposal
> until a lawyer has reviewed and approved it.** `docs/MVP_SPEC.md` §14 records a
> lawyer review of the Terms of Service, Privacy Policy and DPA as **blocking
> before pilots**.
>
> This draft is deliberately conservative: Annex 2 names the controls that exist
> _and_ the ones that do not, and clause 9 states what the product cannot do for
> data-principal requests. A DPA that promises assistance the software cannot
> give is a contractual breach waiting on the first request.
>
> Draft date: 2026-10-23 · Written against commit `2acab50` · Status:
> **unreviewed**

---

## 1. Parties and scope

This Data Processing Agreement (this "**DPA**") forms part of the
[Terms of Service](TERMS_OF_SERVICE.md) (the "**Agreement**") between:

- **[TO BE CONFIRMED: full legal entity name, CIN/LLPIN, registered address]**
  ("**Provider**", "we", "us"), and
- the customer identified in the Agreement ("**Customer**", "you").

It applies to Provider's processing of Personal Data on Customer's behalf in
connection with **[TO BE CONFIRMED: product name — the codebase calls it "CRM",
which is a placeholder, not a brand]** (the "**Service**").

### 1.1 Order of precedence

In the event of conflict, the order is: (a) this DPA; (b) the Agreement; (c) any
other document. **[TO BE CONFIRMED: counsel to settle precedence, and whether
this DPA is incorporated by reference or signed separately.]**

---

## 2. Definitions

The DPDP Act's terms govern. GDPR equivalents are given because several pilot
conversations are likely to use them.

| Term                     | Meaning                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DPDP Act**             | India's Digital Personal Data Protection Act, 2023, and the Rules made under it as in force from time to time                                                                                                                    |
| **Personal Data**        | Data about an individual who is identifiable by or in relation to such data (DPDP §2(t))                                                                                                                                         |
| **Data Principal**       | The individual to whom the Personal Data relates (DPDP §2(j)); the GDPR's "data subject"                                                                                                                                         |
| **Data Fiduciary**       | The person who alone or with others determines the purpose and means of processing (DPDP §2(i)); the GDPR's "controller"                                                                                                         |
| **Data Processor**       | A person who processes Personal Data on behalf of a Data Fiduciary (DPDP §2(k)); the GDPR's "processor"                                                                                                                          |
| **Board**                | The Data Protection Board of India                                                                                                                                                                                               |
| **Customer Data**        | All data Customer or its users submit to or generate in the Service, including Personal Data                                                                                                                                     |
| **Sub-processor**        | A third party engaged by Provider that processes Customer Personal Data                                                                                                                                                          |
| **Personal Data Breach** | Any unauthorised processing of Personal Data, or accidental disclosure, acquisition, sharing, use, alteration, destruction or loss of access to it, that compromises its confidentiality, integrity or availability (DPDP §2(u)) |

---

## 3. Roles of the parties

### 3.1 Customer is the Data Fiduciary

For all Personal Data in Customer's workspace — contacts, leads, the individuals
at account companies, deal participants, activity notes, attachments and custom
fields — **Customer is the Data Fiduciary** and Provider is the **Data
Processor**.

Customer alone determines what Personal Data is collected, from whom, for what
purpose, and on what lawful basis.

### 3.2 Provider is the Data Fiduciary for its own account holders

Provider is the Data Fiduciary for Personal Data about the individuals who hold
accounts in the Service — Customer's own staff — in respect of authentication,
security, service delivery and operational email. That processing is governed by
the [Privacy Policy](PRIVACY_POLICY.md), Part A, and **not** by this DPA.

The distinction matters: the same person may be both a Data Principal of
Provider (as a named user) and the author of records for which Customer is the
Fiduciary.

### 3.3 Provider is not a joint fiduciary and not a Consent Manager

Provider does not determine the purposes of processing Customer Data. Provider
is **not** registered with the Board as a Consent Manager under DPDP §6(7)–(9),
does not act as one, and does not integrate with one.

---

## 4. Customer's obligations as Data Fiduciary

Customer warrants that, in respect of all Personal Data it puts into the
Service, it will:

1. have a **lawful purpose** under DPDP §4, resting on valid consent under §6 or
   a certain legitimate use under §7;
2. give each Data Principal the **notice** DPDP §5 requires — an itemised
   description of the Personal Data, the purpose, how rights may be exercised,
   and how to complain to the Board — **before or at the time** of collection,
   and in a language the Act permits;
3. respond to Data Principal requests under DPDP §§11–14 as the Fiduciary, using
   the facilities in clause 9;
4. maintain **accuracy and completeness** of the Personal Data (DPDP §8(3)), in
   particular where it is used to make a decision affecting the Data Principal;
5. **not** put into the Service the Personal Data of a child (an individual under 18) without verifiable consent of a parent or lawful guardian as DPDP §9
   requires — see clause 11;
6. not instruct Provider to process Personal Data in a way that would breach the
   DPDP Act or any other applicable law;
7. keep its own users' credentials secure, and configure roles, record scopes and
   field permissions in the Service so that only the people who need access to
   Personal Data have it.

### 4.1 Customer acknowledges what the Service does not do

Customer acknowledges, having been told before entering into this DPA, that:

- **the Service has no consent-management functionality.** There is no facility
  to record consent, its source, its timestamp or its withdrawal against a
  contact, and no facility to evidence consent to the Board. (A `consent` field
  exists in the data model but is not implemented or exposed; see the Privacy
  Policy §12.1.) **If Customer's DPDP compliance depends on recording consent in
  its CRM, this Service does not provide it, and Customer must keep that record
  elsewhere.**
- **erasure facilities cover contacts and leads only**, and reach a person's own
  record and their own audit entries — not records _about_ them. Clause 9.3 sets
  this out in full.
- **the audit log is append-only and its metadata survives erasure
  permanently.** Clause 9.4.
- **the Service has no self-service portal for Data Principals.** Every right is
  exercised by Customer's administrators on a Data Principal's behalf.

---

## 5. Provider's processing

### 5.1 On documented instructions only

Provider will process Customer Personal Data only (a) to provide, maintain,
secure and support the Service in accordance with the Agreement, (b) on
Customer's documented instructions, including instructions given through the
Service's own functionality, and (c) where required by law, in which case
Provider will inform Customer first unless the law forbids it.

Provider will **not** sell Customer Personal Data, use it for its own marketing,
use it to train any machine-learning model, or disclose it except as this DPA
permits.

### 5.2 Confidentiality of personnel

Provider will ensure that persons authorised to process Customer Personal Data
are bound by confidentiality obligations and are granted access only as needed.
**[TO BE CONFIRMED: how many people have production access, whether they have
signed confidentiality undertakings, and whether background checks are
performed. At the current scale the honest answer may be "one person"; that
should be stated rather than dressed up.]**

### 5.3 Provider's administrative access to Customer Data

The Service enforces tenant isolation in the database (Annex 2), and no feature
of the Service lets Provider read Customer Data through the application.
However, Provider's operators hold database credentials and can read the
database directly for support, incident response and the manual operations in
clause 10. **[TO BE CONFIRMED: whether Provider commits to accessing Customer
Data only with Customer's prior request or consent except in an emergency, and
how such access is logged. Direct database access is **not** captured in the
Service's own audit log.]**

Note that a **support impersonation** feature is contemplated in
`docs/MVP_SPEC.md` M3 (time-limited, banner shown, fully audited) but **is not
built**. There is no impersonation capability in the Service today.

---

## 6. Sub-processors

### 6.1 Authorisation

Customer gives Provider general authorisation to engage the Sub-processors
listed in **Annex 3**, and to engage others subject to clause 6.3.

### 6.2 Provider remains responsible

Provider will impose data-protection obligations on each Sub-processor no less
protective than those in this DPA, and remains liable for each Sub-processor's
acts and omissions as for its own.

### 6.3 Changes

Provider will give Customer **[TO BE CONFIRMED: notice period — 30 days is the
usual market term]** written notice before engaging a new Sub-processor.
Customer may object on reasonable data-protection grounds; if the parties cannot
resolve the objection, Customer may terminate the affected Service without
penalty. **[TO BE CONFIRMED: how notice is given — email, a public page, or
both.]**

---

## 7. Security

### 7.1 Provider's obligation

Provider will implement and maintain appropriate technical and organisational
measures to protect Customer Personal Data, as **DPDP §8(5)** requires of
reasonable security safeguards. The measures in force are described in
**Annex 2**.

### 7.2 Annex 2 states gaps as well as controls

Annex 2 names controls that are implemented and tested, and — deliberately —
controls that a customer might expect and that **do not exist**. Customer is
entering into this DPA on the basis of both lists.

### 7.3 Changes

Provider may update the measures in Annex 2 provided the overall level of
security is not reduced.

---

## 8. Personal Data Breach

### 8.1 Notification to Customer

Provider will notify Customer **without undue delay** after becoming aware of a
Personal Data Breach affecting Customer Personal Data, and in any event within
**[TO BE CONFIRMED: hours — this must be short enough for Customer to meet its
own duty to the Board, and must take account of the CERT-In 6-hour reporting
direction if it applies to either party]** of becoming aware.

The notification will describe, so far as then known: the nature of the breach,
the categories and approximate number of Data Principals and records affected,
the likely consequences, and the measures taken or proposed.

### 8.2 Customer notifies the Board and the Data Principals

Because Customer is the Data Fiduciary for Customer Personal Data, **the duty
under DPDP §8(6) to give intimation to the Board and to each affected Data
Principal is Customer's**, not Provider's. Provider will provide reasonable
assistance.

### 8.3 Honest statement of detection capability

Customer acknowledges that Provider's ability to **detect** a breach rests on
structured application logs and the Service's append-only audit log. Provider
does **not** operate intrusion detection, a security information and event
management system, anomalous-access alerting, or an error-tracking service.
**[TO BE CONFIRMED: whether this is acceptable to the business for pilots, or
whether basic alerting is a prerequisite. A notification deadline Provider has
no means of meeting is a contractual trap.]**

---

## 9. Assistance with Data Principal rights

Provider will give Customer reasonable assistance in meeting its obligations
under DPDP §§11–14. What follows is what the Service actually does.

### 9.1 Access (DPDP §11)

An administrator with the `data_subject` capability can generate a **per-person
archive**: a JSON file containing the record, the activities linked to it, its
timeline, its tags, and up to **1,000** of the person's most recent audit
entries. It is written to object storage and downloaded through a link valid for
a short period; the file expires after **24 hours**.

An administrator with the `tenant_data` capability can export the **whole
workspace** as JSON.

**Limits**: the per-person archive **does not include attachments**; the audit
history in it is capped at 1,000 entries and is filtered by the requesting
administrator's own field permissions, so a field hidden from that administrator
is absent from the history (the record's own fields are exported in full); and
both archives are JSON only — CSV is refused rather than producing a file that
silently loses the structure.

### 9.2 Correction, completion and updating (DPDP §12)

Through the Service's ordinary editing interface, under Customer's control.

### 9.3 Erasure (DPDP §12) — what it does and does not reach

An administrator with the `data_subject` delete capability can raise an erasure
request, which a background job carries out.

**What it does.** For the person's own record: first name, email, phone,
WhatsApp number, job title, postal address and the consent object are cleared;
the surname is replaced by `[erased]` (the column cannot be null); all custom
fields are emptied. The record is then soft-deleted into the Recycle Bin and
hard-deleted by the retention job after **30 days**. In the audit log, the
**values** in that person's own audit diffs are replaced by `[erased]` while the
rows themselves are kept.

**What it does not reach**, which Customer must understand before relying on it:

| Not reached                                           | Consequence                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Any object type other than contact and lead**       | An account's phone, email and billing address; a deal; an activity; an attachment — none has an erasure path |
| **Activity subjects and bodies that name the person** | A note saying what somebody told you about that person survives the erasure                                  |
| **Timeline summaries that name the person**           | Survive in the Recycle Bin for the 30 days before the purge sweep removes them                               |
| **Attachments containing the person's details**       | A scanned document is not scanned for names                                                                  |
| **Audit entries about _related_ records**             | Only the subject's own rows are redacted (ADR-0032)                                                          |
| **Audit metadata on the subject's own rows**          | Who, what, which record, when and from which IP survive permanently — clause 9.4                             |
| **Backups**                                           | Until the backup retention period expires — **[TO BE CONFIRMED]**                                            |

**Provider does not represent that an erasure request removes every trace of a
person from Customer's workspace.** Customer remains responsible, as Data
Fiduciary, for identifying and dealing with Personal Data held in free-text
fields, attachments and other object types.

### 9.4 Why audit metadata survives erasure

The Service's audit log is append-only by **database privilege**: the
application's role holds no `UPDATE` or `DELETE` on the table. Redaction is
performed by a separate database role with a single column-level grant on the
diff column, admitted by policy only while an erasure request for that exact
person is in progress (ADR-0032). The design makes it impossible for the
application — or for an attacker who compromises it — to rewrite who did what,
to which record, when and from which IP address.

The result is that erasure replaces personal **values** and keeps the
**fact** of each change. Both the DPDP Act and the GDPR accept pseudonymisation
where a record must remain for an independent reason; **[TO BE CONFIRMED:
counsel to confirm that this treatment satisfies DPDP §12 and, where relevant,
GDPR Article 17(3)(b)/(e), and to approve the wording of this clause.]**

### 9.5 Grievance redressal (DPDP §13) and nomination (DPDP §14)

Grievances from Customer's Data Principals go to **Customer**, as the Data
Fiduciary. Provider will assist on request.

The Service has **no nomination feature**. Any nomination would be handled by
Customer outside the Service.

### 9.6 Requests received by Provider directly

If Provider receives a request from one of Customer's Data Principals, Provider
will not respond to it on the merits, will tell the Data Principal that Customer
is the Data Fiduciary, and will forward the request to Customer promptly where
Customer can be identified.

---

## 10. Deletion and return on termination

### 10.1 Export before termination

At any time during the term, an administrator with the `tenant_data` capability
can export the whole workspace as JSON through the Service. Customer is
responsible for taking that export before the Agreement ends.

### 10.2 Deletion after termination

Within **[TO BE CONFIRMED: period — 30 days is the usual market term]** of
termination, Provider will delete Customer Data, unless retention is required by
law.

**Stated honestly: workspace deletion is a manual operation.** There is no
endpoint in the Service that deletes a workspace, a user or a membership. The
deletion in this clause is performed by Provider's operators directly against
the database, and its completeness depends on them rather than on tested
software. **[TO BE CONFIRMED: whether Provider commits to a written confirmation
of deletion, and whether a scripted, tested deletion path should be built before
pilots — the engineering team's view is that it should.]**

### 10.3 Backups

Customer Data will persist in backups until they expire in the ordinary cycle.
**[TO BE CONFIRMED: backup retention period.]** Provider will not restore
Customer Data from a backup after deletion except as required by law.

---

## 11. Children's data

Customer will **not** put the Personal Data of a child (an individual under 18)
into the Service unless Customer has obtained verifiable consent of a parent or
lawful guardian as DPDP §9 requires, and will not use the Service to track or
behaviourally monitor a child or to direct advertising at a child.

Customer acknowledges that **the Service has no age-verification and no
parental-consent mechanism**, and cannot identify a child's record. Provider has
no means of detecting or preventing a breach of this clause.

---

## 12. Cross-border transfer

Provider may process Customer Personal Data in the locations identified in
**Annex 3**, subject to **DPDP §16**, under which transfer outside India is
permitted except to a country the Central Government notifies as restricted, and
subject to any stricter sectoral requirement that applies to Customer.

**[TO BE CONFIRMED: the hosting region for the application, the database and
object storage; and whether Customer is in a sector whose regulator requires
storage in India.]**

Customer acknowledges that operational email is sent through a non-Indian
provider (Annex 3), so email addresses, names and task subject lines leave India
when a message is sent, irrespective of where the database sits.

**[TO BE CONFIRMED: whether any Customer or Data Principal is in the EU or UK.
If so, GDPR Chapter V transfer safeguards — standard contractual clauses or
equivalent — are required and this clause is insufficient.]**

---

## 13. Audits and evidence

Provider will make available to Customer the information reasonably necessary to
demonstrate compliance with this DPA.

**Stated honestly:**

- Provider holds **no** SOC 2, ISO 27001 or equivalent certification, and
  **no third-party penetration test has been performed**.
- The security documentation Provider can provide is its own internal security
  self-review (`docs/SECURITY_REVIEW.md`), its architecture decision records,
  and the automated test suite that enforces tenant isolation and permissions.

**[TO BE CONFIRMED: whether Provider will accept an on-site or remote audit
right, at whose cost, how often, and on what notice. At this stage of the
business, a right that cannot be honoured should not be granted.]**

---

## 14. Liability and term

**[TO BE CONFIRMED: whether liability under this DPA is subject to the
Agreement's limitation of liability, and whether data-protection claims carry a
different (usually higher) cap. This is a commercial decision and a point
pilot customers' counsel will press on.]**

This DPA takes effect on the effective date of the Agreement and continues for
as long as Provider processes Customer Personal Data.

---

## 15. Governing law

**[TO BE CONFIRMED: governing law and jurisdiction. The Terms of Service and
this DPA should match.]**

---

# Annex 1 — Details of processing

| Item                             | Detail                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Subject matter**               | Provision of a multi-tenant customer relationship management service                                                                                                                                                                                                                                                                                                                                                                 |
| **Duration**                     | The term of the Agreement, plus the deletion period in clause 10.2                                                                                                                                                                                                                                                                                                                                                                   |
| **Nature and purpose**           | Storing, organising, indexing, retrieving, displaying, exporting and deleting Customer Data so that Customer's users can manage their customer relationships; sending operational email to Customer's users; producing archives and carrying out erasures at Customer's instruction                                                                                                                                                  |
| **Categories of Data Principal** | Customer's contacts; its leads; individuals at its account companies; individuals named in deals, activity notes and attachments; and Customer's own staff in their capacity as record owners, assignees and audit actors                                                                                                                                                                                                            |
| **Types of Personal Data**       | Names; email addresses; telephone and WhatsApp numbers (E.164); job titles; postal, billing and shipping addresses; company identifiers including GSTIN; lead source and status; deal participation and value; task and meeting subjects and free-text notes; file attachments and their names; tags; timeline entries; **and any data Customer chooses to place in custom fields, whose content Provider cannot know or constrain** |
| **Sensitive categories**         | The DPDP Act does not define a separate "sensitive personal data" category as the GDPR does. Customer should note that free-text notes, attachments and custom fields can hold data that is sensitive in fact — health, financial or family circumstances — and that Provider applies no special handling to it                                                                                                                      |
| **Frequency**                    | Continuous, for the term                                                                                                                                                                                                                                                                                                                                                                                                             |

---

# Annex 2 — Technical and organisational measures

Part A lists measures that are implemented and covered by automated tests. Part B
lists measures a customer might expect that **do not exist**. Both are part of
this Annex.

## Part A — implemented

### Tenant isolation

- Every workspace-owned table carries a `tenant_id` and a PostgreSQL row-level
  security policy that is both `ENABLE`d and `FORCE`d. A test fails the build if
  any such table lacks one.
- Every request runs inside a transaction that sets the workspace and user for
  the life of that transaction. The application's database role has **no
  `BYPASSRLS`** and does not own the tables.
- Five separate database roles with different grants: the API, the background
  worker, identity, schema migration, and a narrow erasure role.
- A test suite (`pnpm test:security`) asserts, per module, that one workspace
  cannot list, read, update or delete another's records, runs against a real
  PostgreSQL with row-level security enabled, and is a required gate.

### Access control

- One central authorisation function with a default of **deny**, applied to every
  endpoint. A lint rule rejects inline role comparisons.
- Record scopes (`own` / `team` / `all`) and **field-level permissions**: a field
  hidden from a role is removed from API responses, rejected on write, not
  sortable or filterable, not matched by search, and stripped from audit diffs —
  on screen and in exported files, through a single shared function.
- Workspace, user, role and ownership are always derived from the server session,
  never taken from the request body.
- A record outside the caller's scope returns a 404 byte-identical to the 404 for
  a record that does not exist.

### Authentication

- Argon2id password hashing; session tokens stored only as SHA-256 digests;
  one-time tokens (verification, reset, MFA) stored only as digests with a
  purpose and a single-use marker.
- TOTP multi-factor authentication with backup codes; the TOTP secret encrypted
  at the application layer; workspace-level enforcement.
- `httpOnly`, `SameSite=Lax`, production-`Secure` session cookie set server-side
  and unreadable by page script; CSRF origin checks on cookie-authenticated
  routes.
- Progressive delay and a per-IP ceiling on sign-in attempts; no response reveals
  whether an address has an account.
- A password change revokes every existing session.

### Input, output and file handling

- Every request body validated against a strict schema that rejects unknown keys;
  rich text sanitised against an allow-list on write and again on read.
- No SQL built by string concatenation; client-supplied sort and filter fields
  resolved against field metadata.
- Uploaded files checked by **magic bytes** and against the claimed type; maximum
  size signed into the presigned upload URL; random 256-bit storage keys;
  presigned URLs valid for five or ten minutes; the API process never reads or
  writes the bytes.
- Every cell of every CSV or XLSX the product writes is escaped against formula
  injection, decided on the first non-whitespace character.
- Server-initiated HTTP goes through one guarded client that blocks private
  address ranges; the email adapter is pinned to a single host and port and will
  not carry its credential across a redirect.

### Logging and audit

- Append-only audit log by withheld database privilege, recording creation,
  update, deletion, restore, purge, erasure, redaction, export, import, sign-in,
  sign-out and permission change, with actor, action, object, record, field diff,
  IP address, user agent and request id.
- Structured JSON logs with a request id, workspace id and user id, and a
  redaction list; tokens, passwords, one-time codes and full personal data are
  not logged.

### Transport and configuration

- The API and the worker refuse to start in production with a non-HTTPS public
  URL, a wildcard CORS origin, a placeholder or short session secret, a superuser
  or development-password database connection string, or an email or storage
  provider that would discard data. 43 tests cover these rules.
- A Content Security Policy restricting scripts, fonts and connections to the
  application's own origin and the object store.

### Resilience

- **Backups are restore-tested** by a scripted drill that dumps a database,
  restores it into a fresh one, and verifies row counts and checksums, that
  row-level security is enabled _and forced_ with identical policies and grants,
  that no role has `BYPASSRLS`, that the schema version matches, and that the
  real API boots on the restored database and still returns 404 for another
  workspace's record.

## Part B — measures that do **not** exist

- **No at-rest encryption performed by the application.** Database and object
  store encryption is whatever the hosting provider gives.
  **[TO BE CONFIRMED]**
- **TLS to the database is not enforced by the application's configuration
  check.** **[TO BE CONFIRMED that the deployment enforces it.]**
- **Rate-limit counters are per process**, so limits are weaker across multiple
  API instances until a shared counter is configured.
- **No breached-password checking.**
- **No intrusion detection, SIEM, anomalous-access alerting or error-tracking
  service** — see clause 8.3.
- **No third-party penetration test and no security certification.**
- **No audit of direct database access by Provider's operators**; the Service's
  audit log covers application actions only.
- **No data-loss prevention, no customer-managed encryption keys, no
  customer-configurable retention periods.** The 30-day Recycle Bin window is a
  constant in the code and is the same for every workspace.
- **No support impersonation feature** (so no audited support access path).
- **No consent management** — see clause 4.1.

---

# Annex 3 — Sub-processors

As at the draft date. Derived from the provider adapters in the code; nothing
else in the Service transmits Personal Data to a third party.

| Sub-processor                                                  | Purpose                                                                                 | Personal Data it receives                                                                                                     | Location                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Resend** (email delivery)                                    | Account verification, password reset, workspace invitation and activity digest messages | Recipient name and email address; **the subject lines of due and assigned tasks**, which are free text and may name a contact | **[TO BE CONFIRMED: account region and contracting entity]** |
| **[TO BE CONFIRMED: object storage provider]** (S3-compatible) | Storing record attachments, generated exports and import files                          | Any Personal Data contained in an uploaded file or a generated export                                                         | **[TO BE CONFIRMED: bucket region]**                         |
| **[TO BE CONFIRMED: managed PostgreSQL provider]**             | The database of record                                                                  | All Customer Data                                                                                                             | **[TO BE CONFIRMED: region]**                                |
| **[TO BE CONFIRMED: application hosting provider]**            | Running the web application, API and worker                                             | All Customer Data in transit and in process memory                                                                            | **[TO BE CONFIRMED: region]**                                |
| **[TO BE CONFIRMED: log storage, if separate]**                | Application logs                                                                        | Request, workspace and user identifiers; no record values                                                                     | **[TO BE CONFIRMED]**                                        |

**Not sub-processors, despite what the intended technology stack might suggest:**
there is no analytics provider, no error-tracking provider, no advertising
network, no AI or machine-learning provider, and no Redis service holding
Personal Data (no Redis client is installed). **Google** is a recipient only if
Google sign-in is enabled, which it is not today and which has never been run
against Google.

**[TO BE CONFIRMED: the hosting arrangement. The repository ships a Docker
Compose + Caddy production example, which implies self-hosting on a provider of
Provider's choosing; the stated intention is Vercel. These are different
arrangements with different sub-processors, and the table above cannot be
completed until it is settled.]**

---

# Annex 4 — GDPR addendum

**Applies only if Customer or any Data Principal is in the EU or UK.**

If it applies, counsel must verify this DPA against **GDPR Article 28(3)**,
which prescribes the content of a processor contract in detail, and add:

- Article 28(3)(a)–(h) terms in the exact form required, including the
  obligation to inform the controller if an instruction infringes the GDPR;
- Article 32 security measures mapped to Annex 2;
- Article 33(2): processor notification to the controller **without undue
  delay** — note this is a stricter formulation than clause 8.1's negotiated
  period;
- Articles 35–36 assistance with data protection impact assessments and prior
  consultation;
- **Chapter V transfer safeguards**: standard contractual clauses or an
  equivalent mechanism. DPDP §16's restriction-by-notification approach is **not**
  a substitute;
- an **Article 27** representative in the EU, if Provider has no EU
  establishment;
- Article 30(2) records of processing maintained by the processor.

**[TO BE CONFIRMED: whether the business intends to serve EU or UK customers at
all during the pilot. If not, say so and keep it that way until the above is
resourced. The engineering team's view is that taking an EU pilot before this
annex is executed would be the single largest legal exposure available to this
product.]**

---

**End of draft. Not for signature.**
