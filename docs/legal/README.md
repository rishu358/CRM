# Legal documents — status, and what must happen before pilots

> ## ⚠️ EVERYTHING IN THIS FOLDER IS AN UNREVIEWED DRAFT
>
> These documents were written by the engineering team, from the code. **They
> are not legal advice and no lawyer has seen them.**
>
> **Do not publish them, link to them, attach them to a proposal, or show them
> to a pilot customer, a prospect, an investor or a regulator until qualified
> Indian counsel has reviewed and approved them.**
>
> `docs/MVP_SPEC.md` §14 already records this: _"Legal: Terms of Service,
> Privacy Policy, DPA (DPDP Act) — get a lawyer review"_, owner **Legal**,
> blocking **before pilots**. These drafts do not discharge that; they are the
> input to it.
>
> Draft date: **2026-10-23** · Written against commit `2acab50`

---

## What is here

| File                                       | What it is                                                                                       | Who it is for                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md) | The contract for using the Service                                                               | The customer business                                      |
| [PRIVACY_POLICY.md](PRIVACY_POLICY.md)     | What personal data we hold, why, who sees it, how long, and what rights people have              | Everyone — our users and the people in our customers' CRMs |
| [DPA.md](DPA.md)                           | The data-processing agreement: we process our customers' CRM records as their Data Processor     | The customer business, as Data Fiduciary                   |
| This file                                  | Status, the checklist of facts the business must supply, and the mismatches counsel needs to see | The founder and counsel                                    |

The governing frame is **India's Digital Personal Data Protection Act, 2023**.
The GDPR is referenced only where it is stricter and only if we serve EU or UK
customers; see the Privacy Policy Annex B and DPA Annex 4.

---

## How these were written, and why that matters

Every factual claim about what the software stores, sends, retains or deletes
was **read out of the codebase**, not taken from a template. The files are named
in each document so a reviewer can check them.

This was the point of the exercise. A privacy policy that describes data
handling the software does not perform is not a harmless formality — it is a
false representation to customers and to the Data Protection Board, and it is
worse than publishing nothing. So where the product does **less** than a
document of this kind normally promises, the documents say so, in the body
rather than in a footnote.

The three most important places where that happens are in the next section.
**If counsel reads only one part of this folder, it should be that section.**

---

## ⚠️ Where the product and a normal privacy promise do not line up

These are the findings most likely to change a commercial or legal decision.
Each was verified in the code.

### 1. There is no consent management, at all

`docs/MVP_SPEC.md` M11 lists _"Contact consent tracking (channel, status,
source, timestamp)"_ as in scope, and `contacts.consent` exists as a `jsonb`
column with a comment saying it is _"required by DPDP/GDPR … and checked before
any outbound send"_.

**None of that is true in the code.** No API contract exposes the field, no
screen writes it, and no code reads it. The column is always `{}`. There is no
check before any send, because the Service sends nothing to contacts.

Consequences:

- The Service **cannot record** when, how or on what basis a contact consented,
  and cannot record withdrawal.
- A customer whose DPDP compliance rests on recording consent in their CRM will
  not get it here, and **must be told before they load data**.
- Neither the Privacy Policy nor the DPA may imply otherwise, and neither does.
- The DPDP Act's **Consent Manager** is a separate, registered-entity concept.
  We are not one and do not integrate with one.

**Decision needed**: ship the consent feature before pilots, or tell every pilot
customer plainly in writing that it does not exist. The second is cheaper and is
what the drafts assume.

### 2. Erasure is narrower than the word "erasure" implies

`ERASABLE_OBJECT_TYPES` is exactly `['contact', 'lead']`. An erasure request:

- **does not exist** for accounts (which hold a phone, an email and billing and
  shipping addresses), activities, attachments, deals, or **our own account
  holders**;
- reaches the person's **own** record and their **own** audit rows, not records
  _about_ them — a note whose body names them, a deal named after them, a
  timeline summary naming them, a scanned attachment;
- leaves an erased record's timeline rows alive for the **30 days** before the
  Recycle Bin purge sweep removes them.

So an erasure request **does not** guarantee the person's name has left the
workspace. Both the Privacy Policy (§12.2, §12.3) and the DPA (clause 9.3) say
so in a table. **[TO BE CONFIRMED: that counsel is comfortable defending this to
a data principal, and whether erasure for accounts and for free-text search is
required before pilots.]**

### 3. Audit metadata survives erasure permanently, by design

The audit log is append-only by **withheld database privilege** — the
application role has no `UPDATE` or `DELETE` on the table. Redaction is done by
a separate role with a single column-level grant, admitted only during an
in-flight erasure (ADR-0032).

The result is that an erasure replaces the **values** in a person's audit diffs
with `[erased]`, and the **facts** — who acted, what action, which record, when,
and **from which IP address** — survive forever and cannot be removed by any
code path in the system.

This is a good security property and a hard thing to say in a privacy policy.
The drafts say it in full rather than writing "we will delete your data".
**[TO BE CONFIRMED: that counsel agrees this satisfies DPDP §12, and the exact
wording.]**

### 4. There is no way to delete a workspace or close an account

No endpoint deletes a tenant, a user or a membership. An administrator can
_suspend_ a member — access goes, the user row, the audit history and their name
on records stay.

Deletion on termination is therefore a **manual operation performed directly
against the database**, and its completeness depends on an operator rather than
on tested software. The DPA (clause 10.2) says this.

**Engineering's recommendation**: build a scripted, tested workspace-deletion
path before pilots. "We will delete your data within 30 days" is a contractual
promise currently backed by somebody remembering to write the right `DELETE`
statements.

### 5. Nothing in the system ever deletes audit entries, auth events or spent invitations

There is no retention job for `audit_logs`, none for `auth_events` (which hold
the email address tried, the IP and the user agent of every sign-in attempt,
successful or not), and none for spent invitations — the last of which the
security review records as deliberate.

Today the honest retention period for all three is **"forever"**. DPDP §8(7)
requires erasure once the purpose is served and retention is no longer required
by law, so "forever" needs either a justification counsel accepts or a retention
job in the product. The Privacy Policy §10 states the position and flags it.

### 6. The stated hosting plan and the repository's deployment artefacts disagree

The repository ships a **Docker Compose + Caddy** production example in
`deploy/`, which is a self-hosted shape. The stated intention is **Vercel**.
These are different arrangements, with different sub-processors, different
regions and different at-rest encryption stories.

**Related, and more important: `tenants.region` defaults to `ap-south-1`.** That
is a label recorded for future routing (ADR-0013), **not** evidence of where any
data sits. There is one region today and the router always returns the single
default connection. Nobody should read the default as a residency commitment,
and the drafts explicitly say not to.

Where the database physically lives is an open **DPDP data-residency question**
and is left as a placeholder everywhere it appears.

### 7. Contact personal data can reach the email provider through task subject lines

The Service never emails contacts. But the **activity digest** sent to a user
lists the subject lines of their due and assigned tasks, and those are free text
typed by colleagues — "Call Priya about the renewal". Those subject lines go to
Resend.

So Part B (processor) data does leave through the Part A (fiduciary) email path.
Both the Privacy Policy (§7.1) and the DPA (Annex 3) say so. It also means
**email leaves India regardless of where the database is hosted**, because
Resend is a non-Indian service.

### 8. Several things in the stated technology stack are not actually used

`CLAUDE.md` lists Redis, BullMQ, OpenTelemetry and Sentry. **None of them is
wired up**: there is no Redis client installed, no BullMQ (the queue is a
PostgreSQL transactional outbox), and no telemetry or error-tracking dependency
anywhere.

This is _good news_ for the documents — it makes the sub-processor list short
and truthful — but anyone drafting from the stack table rather than from the
code would have listed four sub-processors that do not exist. If any of them is
added later, the Privacy Policy §6 and §7 and the DPA Annex 3 must be updated
**before** it ships.

### 9. Smaller mismatches worth knowing

- **The per-person archive omits attachments** and caps audit history at 1,000
  entries. A subject access request answered with that file is incomplete if the
  person's details are in an uploaded document.
- **Generated archives expire after 24 hours.** A customer who requests their
  whole-workspace export and does not download it promptly must request it
  again.
- **The Recycle Bin's 30 days is a constant in the code**, identical for every
  workspace and not configurable. A customer who wants 7 days or 90 cannot have
  it.
- **A rejected upload keeps its database row** (with the reason) indefinitely,
  though the bytes are deleted immediately.
- **Support impersonation is specified in MVP_SPEC M3 but not built**, so there
  is no audited support-access path — and conversely no impersonation risk.
- **Google sign-in is built but disabled and has never run against Google.** If
  it is enabled, Google becomes a recipient and the Privacy Policy must change
  first.
- **The product has no name.** "CRM" is a placeholder throughout. Every document
  carries a `[TO BE CONFIRMED]` for it.

---

## Checklist: every `[TO BE CONFIRMED]` item

The business must supply these before counsel can finish. They are grouped by
who can answer them. **None of them was guessed.**

### A. The legal entity and the people

| #   | Item                                                                                                                                           | Appears in                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A1  | LLPIN and registered address of Birab Trading LLP (the entity name was confirmed by the owner on 2026-10-25)                                   | All three                              |
| A2  | Product name and brand (currently the placeholder "CRM")                                                                                       | All three                              |
| A3  | Grievance Officer: name, designation, email, postal address, telephone                                                                         | Privacy Policy §1, §11.3, §18; ToS §15 |
| A4  | Whether the data-protection contact under DPDP §8(9) is the same person                                                                        | Privacy Policy §1                      |
| A5  | Support email and legal-notices address                                                                                                        | ToS §8, §15, §16                       |
| A6  | How many people hold production database access, whether they have signed confidentiality undertakings, and whether background checks are done | DPA 5.2                                |

### B. Hosting, residency and sub-processors

| #   | Item                                                                                                                 | Appears in                                      |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| B1  | **Hosting provider and region** for web, API and worker — Vercel, or the Docker/Caddy shape in `deploy/`?            | Privacy Policy §7.3, §8; DPA Annex 3            |
| B2  | **Managed PostgreSQL provider and the region the database physically sits in** — the central DPDP residency question | Privacy Policy §7.3, §8; DPA Annex 3, clause 12 |
| B3  | Object-storage provider and bucket region                                                                            | Privacy Policy §7.2; DPA Annex 3                |
| B4  | Backup location and **backup retention period**                                                                      | Privacy Policy §10; DPA 10.3; ToS §10.3         |
| B5  | Where application logs are stored, by whom, for how long                                                             | Privacy Policy §3.6, §10; DPA Annex 3           |
| B6  | Resend's contracting entity, our account's region, and the terms we sign                                             | Privacy Policy §7.1; DPA Annex 3                |
| B7  | What at-rest encryption the chosen database and storage providers give us                                            | Privacy Policy §9.2; DPA Annex 2 Part B         |
| B8  | Confirmation that the deployment enforces TLS to the database (and whether to add it as a code check)                | Privacy Policy §9.2; DPA Annex 2 Part B         |
| B9  | Sub-processor change notice period (30 days is the norm) and how notice is given                                     | DPA 6.3                                         |

### C. Retention periods the business must choose

| #   | Item                                                                            | Today                           |
| --- | ------------------------------------------------------------------------------- | ------------------------------- |
| C1  | Audit log retention                                                             | Forever — no job deletes it     |
| C2  | `auth_events` retention (email tried, IP, user agent of every sign-in attempt)  | Forever                         |
| C3  | Spent-invitation retention                                                      | Forever, deliberately           |
| C4  | Deletion period after termination                                               | Undecided (30 days is the norm) |
| C5  | Turnaround committed for a manual workspace-deletion or account-closure request | Undecided                       |

### D. Commercial terms (Terms of Service)

| #   | Item                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Free pilot, paid pilot or paid subscription; and whether a separate short pilot agreement should sit above these Terms                                                                                        |
| D2  | Fees, billing period, currency, GST, payment terms, late payment, price-change notice                                                                                                                         |
| D3  | Availability commitment, if any; recovery point and recovery time objectives; backup frequency                                                                                                                |
| D4  | Support channel, hours and response targets                                                                                                                                                                   |
| D5  | **Limitation of liability**: the cap (a fee multiple does not work during a free pilot, so a rupee figure is needed), carve-outs for data-protection and confidentiality claims, and the mandatory exclusions |
| D6  | Term, renewal, notice periods for termination by either side, and cure period for material breach                                                                                                             |
| D7  | Notice periods for changes to the Service and to the Terms, and whether material changes need positive consent                                                                                                |
| D8  | Whether a responsible-disclosure exception to the no-security-testing clause is offered, and to what address                                                                                                  |
| D9  | Whether a feedback licence and a force-majeure clause are wanted                                                                                                                                              |
| D10 | How changes to the Privacy Policy are notified to customers and users, and what notice period applies                                                                                                         |

### E. Jurisdiction and dispute resolution

| #   | Item                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------ |
| E1  | **Governing law**                                                                                      |
| E2  | Courts of a named city, or arbitration — and if arbitration, the seat, rules and number of arbitrators |
| E3  | That the Terms and the DPA match on E1 and E2                                                          |

### F. Questions only counsel can answer

| #   | Item                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Whether the DPDP Rules are notified and in force at the publication date**, and the applicable commencement and transition dates — several obligations in the drafts depend on it |
| F2  | The **lawful basis** for our own processing of account-holder data: consent under §6, or a certain legitimate use under §7(a)? This changes the withdrawal clause                   |
| F3  | The form and deadline for **breach intimation** under the Rules as notified                                                                                                         |
| F4  | Whether the **CERT-In Directions of 28 April 2022** (6-hour incident reporting) apply to us — a separate obligation from the DPDP Act                                               |
| F5  | Whether the **erasure-with-audit-metadata-retained** treatment satisfies DPDP §12 (and GDPR Art. 17(3) if relevant), and the exact wording                                          |
| F6  | Confirmation that we are not and are unlikely to be notified as a **Significant Data Fiduciary** under §10                                                                          |
| F7  | Committed response time for grievance redressal under §13                                                                                                                           |
| F8  | Whether the "as is" disclaimer and liability limits are effective under the Indian Contract Act 1872, the Consumer Protection Act 2019 and the IT Act 2000                          |
| F9  | Whether this DPA should be incorporated by reference or signed separately, and the precedence order                                                                                 |
| F10 | Whether liability under the DPA is subject to the Terms' cap or carries its own                                                                                                     |
| F11 | Whether an audit right is granted, at whose cost, how often, on what notice                                                                                                         |

### G. Business decisions with a legal edge

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **Whether we will serve customers outside India during the pilot.** If yes for the EU or UK: a GDPR part to the Privacy Policy, an Art. 30 record, an Art. 28-compliant DPA, probably an Art. 27 EU representative, and Chapter V transfer safeguards. The engineering view is that an EU pilot before that is done is the largest legal exposure available to this product. **If the answer is no, write it down and keep it that way.** |
| G2  | Whether any pilot customer is in a **regulated sector** (banking, insurance, payments, healthcare) whose regulator imposes storage-in-India requirements that override the DPDP default                                                                                                                                                                                                                                                   |
| G3  | Whether any pilot customer's business involves **individuals under 18** (education, coaching, paediatric healthcare, youth services) — DPDP §9 penalties are among the highest in the Act, and the product has no age verification                                                                                                                                                                                                        |
| G4  | Whether basic **breach-detection alerting** is a prerequisite for pilots, given that clause 8.1 of the DPA promises a notification deadline we currently have limited means of meeting                                                                                                                                                                                                                                                    |
| G5  | Whether **consent management** ships before pilots, or every pilot customer is told in writing that it does not exist                                                                                                                                                                                                                                                                                                                     |
| G6  | Whether a **tested workspace-deletion path** ships before pilots (engineering recommends yes)                                                                                                                                                                                                                                                                                                                                             |
| G7  | Whether to commit to written confirmation of deletion on termination                                                                                                                                                                                                                                                                                                                                                                      |
| G8  | Whether we commit to accessing customer data only on request or consent except in an emergency, and how such access is logged — **direct database access is not captured in the Service's own audit log**                                                                                                                                                                                                                                 |
| G9  | Notice commitment to customers on a merger or acquisition                                                                                                                                                                                                                                                                                                                                                                                 |
| G10 | The manual process for a DPDP §14 **nomination** (the product has no feature for it)                                                                                                                                                                                                                                                                                                                                                      |
| G11 | Extending `docs/RUNBOOK.md` to cover **regulatory notification** on a breach: who decides, who signs the notice to the Board, and who contacts affected data principals                                                                                                                                                                                                                                                                   |

---

## What must happen before pilots

1. **The business answers sections A–E and G** of the checklist above. Most of it
   is a founder's afternoon; B1 and B2 (hosting and database region) may not be.
2. **Counsel reviews all three documents** against the answers, and settles
   section F.
3. **Decide the three product questions** that change what the documents can
   say: consent management (G5), a tested deletion path (G6), and breach-
   detection alerting (G4).
4. **Fix every `[TO BE CONFIRMED]`** — the documents should contain none when
   they are published. A grep for the marker is the completeness check:

   ```bash
   grep -rn "TO BE CONFIRMED" docs/legal/
   ```

5. **Then, and only then**, publish and share with pilot customers.

Until step 5, these files live in the repository and nowhere else.

---

## Keeping them true

The reason these documents are worth anything is that they describe the software
as it is. That decays the moment the software changes.

**The rule: a change to what the product stores, sends, retains or deletes is
not finished until the documents in this folder are updated.** Concretely, a
pull request that touches any of the following should touch `docs/legal/` too:

- a new column holding personal data, or a new table;
- a new outbound integration, provider adapter or recipient of any kind;
- a change to a retention period or to the Recycle Bin, purge or expiry jobs;
- a change to erasure — what it covers, what it reaches, what survives;
- anything that changes what the audit log records or who can read it;
- adding analytics, error tracking, telemetry or an AI provider;
- enabling Google sign-in;
- a billing or payments module.

`docs/SECURITY_REVIEW.md` is the companion document for the security claims:
nothing in the Privacy Policy §9.1 or the DPA Annex 2 Part A should assert a
control that review does not record as met, and anything it lists as a gap
belongs in §9.2 or Annex 2 Part B.

---

## Source references

For a reviewer checking the claims:

| Claim area                               | Where to look                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| What personal data is stored             | `packages/db/src/schema/` — `crm.ts`, `identity.ts`, `auth.ts`, `platform.ts`, `attachments.ts`, `data-rights.ts`, `tenants.ts`                       |
| What counts as personal data for erasure | `PII_COLUMNS` and `ERASABLE_OBJECT_TYPES` in `packages/core/src/data-rights/index.ts`                                                                 |
| How erasure works                        | `apps/worker/src/data-rights/erasure-handler.ts`, `packages/db/src/data-rights/index.ts`, `docs/adr/0032-erasure-against-an-append-only-audit-log.md` |
| Archives (access requests)               | `apps/worker/src/data-rights/archive-handler.ts`, `apps/api/src/modules/data-rights/`                                                                 |
| Recycle Bin and purge                    | `apps/worker/src/handlers/recycle-bin.ts`, `docs/adr/0034-audit-viewer-and-recycle-bin-retention.md`                                                  |
| Retention constants                      | `packages/core/src/data-rights/index.ts`, `packages/core/src/files/attachments.ts`, `packages/core/src/import-export/limits.ts`                       |
| Audit log                                | `packages/db/src/schema/platform.ts`, `apps/api/src/platform/audit.service.ts`                                                                        |
| Email provider                           | `packages/outbound/src/resend.ts`, `apps/worker/src/email/provider.ts`, `apps/worker/src/handlers/notifications.ts`                                   |
| Object storage                           | `packages/storage/src/`                                                                                                                               |
| Data region                              | `docs/adr/0013-data-region-on-tenant.md`, `tenants.region`                                                                                            |
| Security claims and known gaps           | `docs/SECURITY_REVIEW.md`                                                                                                                             |
| Production configuration refusals        | `packages/core/src/config/production.ts`                                                                                                              |
| Deployment shape                         | `deploy/`                                                                                                                                             |
