# Terms of Service

> ## ⚠️ DRAFT — NOT LEGAL ADVICE, NOT FOR PUBLICATION
>
> This is an **unreviewed draft prepared by the engineering team** for review by
> qualified Indian counsel. It is **not legal advice**. Nobody who wrote it is a
> lawyer.
>
> **Do not publish this, link to it, or present it to a pilot customer until a
> lawyer has reviewed and approved it.** `docs/MVP_SPEC.md` §14 records a lawyer
> review of the Terms of Service, Privacy Policy and DPA as **blocking before
> pilots**.
>
> Commercial terms — fees, liability caps, service levels, governing law — are
> business decisions and are left as `[TO BE CONFIRMED: ...]` rather than
> guessed. They are collected in [README.md](README.md).
>
> Draft date: 2026-10-23 · Written against commit `2acab50` · Status:
> **unreviewed**

---

## 1. Who these terms are between

These Terms of Service (the "**Terms**") are an agreement between
**Birab Trading LLP**, **[TO BE CONFIRMED: LLPIN and registered address]**
("**we**", "**us**", "**our**") and the business that creates a workspace in
**[TO BE CONFIRMED: product name — the codebase calls it "CRM", which is a
placeholder, not a brand]** (the "**Service**") ("**you**", "**Customer**").

By creating a workspace, accepting an invitation to one, or using the Service,
you agree to these Terms. If you are agreeing on behalf of a business, you
confirm you have authority to bind it.

The [Privacy Policy](PRIVACY_POLICY.md) and the
[Data Processing Agreement](DPA.md) form part of these Terms.

---

## 2. These are pilot terms for pre-release software

**The Service is pre-release software.** At the date of this draft it has been
built to a specified MVP scope, it has an extensive automated test suite
including a required tenant-isolation and permissions suite, and it has **never
been run in production and has never had a paying customer**. It has had no
third-party security assessment.

Accordingly:

- The Service is provided for pilot use on the basis set out in clause 11
  (warranties) and clause 12 (liability).
- Features may change, be added or be withdrawn.
- **[TO BE CONFIRMED: whether this is a free pilot, a paid pilot, or a paid
  subscription; and whether a separate pilot agreement should sit above these
  Terms. Counsel's view is likely to be that a short pilot agreement with a
  defined term, a defined scope and an explicit exit is better than a general
  SaaS contract for the first three to five customers.]**

---

## 3. What the Service is

The Service is a multi-tenant, web-based customer relationship management
platform. As built, it provides:

- **Workspaces** with named users, invitations, roles and teams;
- **Accounts, Contacts, Leads and Deals**, with list views, filters, saved
  views, a record page, duplicate detection and lead conversion;
- **Pipelines and a Kanban board** for deals, with multiple pipelines and
  configurable stages;
- **Activities** — tasks, calls, meetings and notes — with a "My Day" view,
  reminders and an email digest;
- **Attachments** on records;
- **Global search** and a command palette;
- **Import and export** of records as CSV or XLSX;
- **Customisation**: custom fields on standard objects, defined per workspace;
- **A dashboard** of basic figures;
- **Administration**: users, roles, per-object and per-field permissions, record
  scopes, and an access explainer;
- **Governance**: an audit log viewer, a Recycle Bin with a 30-day restore
  window, a whole-workspace archive, a per-person archive, and an erasure
  facility for contacts and leads.

**What the Service does not include.** There is no billing or payments module,
no WhatsApp or SMS integration, no marketing automation or campaign sending, no
public developer API beyond the versioned REST API the web application itself
uses, no mobile application, no custom objects beyond custom fields on the
standard ones, and no consent-management functionality. **The Service never
sends email to your contacts or leads.**

---

## 4. Your account and your users

### 4.1 Registration and verification

You must give accurate registration information and verify your email address.
You are responsible for everything done under your workspace's accounts.

### 4.2 Security of credentials

You are responsible for keeping credentials secure. The Service supports
time-based one-time-password multi-factor authentication, which can be enforced
for a whole workspace; we recommend you enforce it. Changing a password revokes
every existing session for that user.

### 4.3 Roles and permissions are yours to configure

The Service enforces object permissions, record scopes (`own`, `team`, `all`)
and field-level permissions. **Configuring them correctly for your business is
your responsibility.** We provide the mechanism; you decide who sees what.

### 4.4 Removing people

An administrator can **suspend** a member, which removes their access
immediately. **There is no facility to delete a user account or a membership
row.** A suspended member's user record, their entries in the audit log and
their name on records they own all remain. See clause 10.3.

---

## 5. Your data

### 5.1 You own it

As between you and us, you own all data you or your users put into or generate
in the Service ("**Customer Data**"). We claim no ownership of it.

### 5.2 The licence you give us

You grant us a worldwide, non-exclusive, royalty-free licence to host, store,
transmit, display, index and otherwise process Customer Data **solely to provide
and support the Service** to you, and as the [DPA](DPA.md) permits. That licence
ends when the data is deleted.

We will not sell your data, use it for our own marketing, or use it to train any
machine-learning model.

### 5.3 Personal data

Where Customer Data includes personal data, you are the **Data Fiduciary** under
India's Digital Personal Data Protection Act, 2023, and we are your **Data
Processor**. The [DPA](DPA.md) governs that processing and you should read it
before loading real data. In particular, it records:

- that the Service has **no consent-management functionality**;
- that erasure facilities cover **contacts and leads only**, and reach a person's
  own record rather than every record mentioning them;
- that the audit log is **append-only** and its metadata survives erasure
  permanently.

### 5.4 Your responsibilities for the data you load

You warrant that you have a lawful purpose for the personal data you put into
the Service, that you have given the notice the DPDP Act requires to the people
it concerns, and that you will not load the personal data of anyone under 18
without verifiable parental consent as DPDP §9 requires.

---

## 6. Acceptable use

You will not, and will not permit anyone to:

1. use the Service in breach of any applicable law, including the DPDP Act;
2. upload malware, or content that is unlawful, defamatory or infringing;
3. attempt to access another customer's workspace or data, probe or circumvent
   the Service's access controls, or test its security without our prior written
   consent;
4. reverse engineer, decompile or attempt to derive the source code of the
   Service, except to the extent that restriction is unenforceable by law;
5. resell, sublicense or provide the Service to a third party as a service,
   except to your own users;
6. impose an unreasonable load on the Service, circumvent its rate limits, or use
   automated means to extract data at scale beyond the export facilities
   provided;
7. use the Service to send unsolicited communications. (The Service has no
   capability to send messages to your contacts, so this is directed at misuse of
   exported data.)

**[TO BE CONFIRMED: whether a responsible-disclosure exception to clause 6(3) is
offered, and to what address. The engineering team recommends one.]**

### 6.1 Suspension

We may suspend access immediately where necessary to protect the Service, other
customers, or to comply with law — in particular on evidence of a security
compromise. We will tell you as soon as we reasonably can and restore access as
soon as the cause is resolved.

---

## 7. Fees

**[TO BE CONFIRMED: the entire commercial arrangement — whether pilots are free;
if paid, the fee, the billing period, the currency, taxes including GST, payment
terms, late payment, price changes and notice of them, and what happens on
non-payment. Note that the Service has no billing module and no payment
processor is integrated, so any invoicing would be done outside the Service.]**

---

## 8. Service availability and support

**[TO BE CONFIRMED: whether any availability commitment is given. For a pilot
the honest answer is probably none, expressed as reasonable endeavours.]**

What can truthfully be said today:

- The Service has **not** been run in production.
- A load test at one million records has been performed, and the measured
  figures are in `docs/PERF.md`. One API process was measured to fail past
  roughly 65 requests per second of mixed traffic.
- **Backups are restore-tested**: a scripted drill dumps a database, restores it
  into a fresh one and verifies the data, the tenant-isolation policies and
  grants, the schema version, and that the real application boots on the restored
  database. **[TO BE CONFIRMED: backup frequency, retention, and committed
  recovery point and recovery time objectives. The drill measures how long a
  restore takes at the size it is run against; it does not by itself constitute a
  commitment.]**
- **[TO BE CONFIRMED: support channel, hours and response targets.]**

---

## 9. Intellectual property

We own the Service, its software, design and documentation, and all intellectual
property rights in them. These Terms grant you a non-exclusive, non-transferable
right to use the Service during the term, and nothing more.

If you give us feedback or suggestions, we may use them without obligation to
you. **[TO BE CONFIRMED: counsel to confirm the usual feedback clause is
wanted.]**

---

## 10. Term, termination and what happens to your data

### 10.1 Term

These Terms apply from when you first use the Service until terminated.
**[TO BE CONFIRMED: pilot term and renewal, if any.]**

### 10.2 Termination

- **By you**: **[TO BE CONFIRMED: notice period, and how notice is given — note
  that there is no "close my account" control in the Service, so this has to be
  by email to a named address.]**
- **By us**: on **[TO BE CONFIRMED: notice period]**, or immediately for material
  breach that is not remedied within **[TO BE CONFIRMED: cure period]**, or
  immediately where required by law.

### 10.3 Your data on termination

**Export before you leave.** While your workspace is active, an administrator
with the workspace-export capability can export the entire workspace as a JSON
archive through the Service. **Exported files expire 24 hours after they are
generated**, so download them promptly.

**Deletion after you leave.** We will delete Customer Data within **[TO BE
CONFIRMED: period]** of termination, except where retention is required by law.

**Stated plainly, because it matters**: there is **no endpoint in the Service
that deletes a workspace, a user account or a membership**. Deletion on
termination is a manual operation our operators perform directly against the
database. Data will also persist in backups until they expire in the ordinary
cycle — **[TO BE CONFIRMED: backup retention period]**.

### 10.4 What survives

Clauses 5.1 (your ownership), 9 (intellectual property), 11 (warranties), 12
(liability), 13 (confidentiality), 15 (governing law) and this clause survive
termination.

---

## 11. Warranties and disclaimers

We warrant that we will provide the Service with reasonable skill and care.

**Otherwise, and to the fullest extent permitted by law, the Service is provided
"as is".** We do not warrant that it will be uninterrupted or error-free, that
defects will be corrected, or that it will meet your requirements.

**You should read this alongside clause 2 and the known gaps recorded in the
Privacy Policy §9.2 and the DPA Annex 2 Part B.** Those documents state, among
other things, that there has been no third-party penetration test, that we hold
no security certification, that rate-limit counters are per process, that at-rest
encryption is the hosting provider's rather than ours, and that we operate no
intrusion detection or anomalous-access alerting. We would rather you knew that
before signing than discovered it afterwards.

**[TO BE CONFIRMED: counsel to review against the Indian Contract Act, 1872, the
Consumer Protection Act, 2019 (to the extent a small-business customer could be
a consumer), and the Information Technology Act, 2000. Blanket "as is"
disclaimers are not always fully effective.]**

---

## 12. Limitation of liability

**[TO BE CONFIRMED: the whole of this clause. Counsel to settle: the cap (a
multiple of fees paid is the market norm, but during a free pilot there are no
fees, so a fixed rupee cap is needed); whether data-protection and
confidentiality claims are carved out of or subject to the cap; exclusion of
indirect and consequential loss; and the mandatory exclusions — death or
personal injury caused by negligence, fraud, and anything else that cannot be
limited under Indian law.]**

**Note for the business, not for the contract**: a pilot customer's own DPDP
exposure for a breach of its contacts' data can reach the figures in the Act's
Schedule, which run to hundreds of crores at the top end. Pilot customers'
counsel will press on this clause, and a cap set at zero or near zero may be the
reason a pilot does not sign. This is a commercial decision that should be made
deliberately rather than by default.

---

## 13. Confidentiality

Each party will keep the other's confidential information confidential, use it
only for the purposes of these Terms, and protect it with at least reasonable
care. This does not apply to information that is public through no fault of the
receiving party, was already known to it, or is independently developed, and does
not prevent disclosure required by law.

Customer Data is your confidential information.

---

## 14. Changes

### 14.1 To the Service

We may change the Service. We will not make a change that materially reduces
core functionality without **[TO BE CONFIRMED: notice period]**.

### 14.2 To these Terms

We may update these Terms. **[TO BE CONFIRMED: how notice is given, what notice
period applies, and whether continued use constitutes acceptance. A material
change for an existing pilot customer probably needs positive consent rather
than notice.]**

---

## 15. General

- **Governing law and jurisdiction**: **[TO BE CONFIRMED: governing law, and
  whether disputes go to the courts of a named city or to arbitration — and if
  arbitration, the seat, rules and number of arbitrators. These Terms and the
  DPA must match.]**
- **Notices**: **[TO BE CONFIRMED: our address for notices, and whether email to
  a named address is sufficient.]**
- **Grievances**: under the DPDP Act our Grievance Officer is **[TO BE
  CONFIRMED: name and contact details]**, and the [Privacy Policy](PRIVACY_POLICY.md)
  explains how to raise a grievance.
- **Assignment**: you may not assign these Terms without our consent; we may
  assign them to a successor in a merger or sale of substantially all assets.
- **Entire agreement**: these Terms, the Privacy Policy and the DPA are the whole
  agreement on their subject matter.
- **Severability**: if a provision is unenforceable, the rest stands.
- **No waiver**: failure to enforce a provision is not a waiver of it.
- **Force majeure**: neither party is liable for failure caused by events beyond
  its reasonable control. **[TO BE CONFIRMED: whether this clause is wanted and
  how it is drafted.]**

---

## 16. Contact

**[TO BE CONFIRMED: support email, legal notices address, and registered office
address.]**

---

**End of draft. Not for publication.**
