# ADR-0023: What "duplicate" means, and who is allowed to be told

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

MVP_SPEC M4: "duplicate detection on create/import: email, phone, account
domain/name (fuzzy via pg_trgm)", and an acceptance criterion that converting a
lead whose email matches an existing contact "offers link to existing instead
of creating a duplicate".

Three things in that sentence are decisions rather than implementation:

- **What counts as a match** — fuzzy matching has a threshold, and a threshold
  is a product decision with a false-positive and a false-negative price.
- **What happens on a match.** The task is explicit that matches are _surfaced,
  not blocking_. But "offered" can still mean "silently ignored by any client
  that does not render the offer".
- **Who learns what.** A duplicate check takes a value the caller typed and
  answers "a record with that value exists". That is a read of every record in
  the tenant, performed with whatever permissions the endpoint forgot to apply.
  Of everything in the leads module it is the likeliest place for a tenant
  boundary or a field permission to leak, because it is a query across
  _other people's_ records by design.

## Decision

### 1. What matches

| Compared                     | Rule                                                                  | Reason shown |
| ---------------------------- | --------------------------------------------------------------------- | ------------ |
| Email, on leads and contacts | Exact. Lowercased by the contract and by the `citext` column          | `email`      |
| Phone, on leads and contacts | Exact E.164. Already normalised by the contract and a `CHECK`         | `phone`      |
| Domain, on accounts          | Exact, case-insensitive, against the domain of the lead's email       | `domain`     |
| Company name, on accounts    | `pg_trgm` `similarity(name, company) >= 0.5`, `%` as the index filter | `name`       |

A free-mail domain (`gmail.com`, `yahoo.com`, `rediffmail.com`, …) never
produces a domain match: it identifies a provider, and matching on it would
tell a rep that every Gmail lead belongs to whichever account first typed one.
The list is in `packages/core/src/leads` and is not exhaustive; a provider
missing from it produces a spurious _prompt_, never a wrong merge, because a
match is only ever offered.

**The 0.5 threshold was measured, not chosen.** Against `similarity()`:

| Pair                                            | Score |
| ----------------------------------------------- | ----- |
| Rajesh Gold House / Rajesh Gold House Pvt Ltd   | 0.69  |
| Lotus Design Studio / Lotus Design Studios      | 0.86  |
| Acme Trading / ACME trading co                  | 0.81  |
| Acme Trading / Acme Traders                     | 0.53  |
| Tata Steel Ltd / Tata Steel Limited             | 0.55  |
| Acme Trading / Zenith Trading (one shared word) | 0.40  |
| Acme / Acme Trading                             | 0.39  |

Everything a person would call "the same company" is above 0.5 and the shared
word is below it. The last row is the known miss: a short name that is a prefix
of a longer one. `word_similarity` would catch it (1.0) but also flags every
"Gold" against every "Rajesh Gold House", which is the false positive that
trains people to click through. The line leans towards asking — a false
positive costs a click; a false negative is a duplicate customer — and stops
there.

`%` (default 0.3, GIN-assisted by `accounts_name_trgm_idx` from 0002) is the
index prefilter; the explicit `similarity() >= 0.5` is the cut. The threshold
therefore lives in one named constant (`COMPANY_NAME_SIMILARITY_THRESHOLD`),
not in a session setting that a pooled connection could carry between tenants.

People are matched only on exact email and phone, not on fuzzy name. Two
contacts called "Anil Shah" are usually two people, and a name is not an
identifier. `contacts_last_name_trgm_idx` was added in 0009 against the day that
changes, and is unused today; it is recorded here so it is not mistaken for a
feature.

Converted leads are included in matches on purpose. "This person already
became a customer" is the most useful thing a prompt can say.

### 2. Offered, never imposed — and never silent

- **Create a lead.** Always succeeds. The web app asks first
  (`POST /leads/duplicate-check`) so the prompt appears before the save, with
  "open it", "back to edit" and "save anyway". The create response also carries
  `meta.duplicates`, so an API client, a website form or a future import gets the
  same information after the fact. The check is a separate call from the save: if
  it fails, the save still happens.
- **Convert a lead.** The dialog asks what conversion would duplicate
  (`GET /leads/:id/conversion-matches`) and **pre-selects "link to existing"**
  when there is a match, so a person who clicks Convert attaches the lead to the
  contact they have rather than minting a second one. Choosing "create" with a
  match on screen is a deliberate act and the dialog says what it means.
- **The API does not trust the dialog.** A conversion that would _create_ a
  contact or account with a match is refused with `409 DUPLICATE_RECORDS`, listing
  every match for both at once, unless the request says
  `acknowledgeDuplicates: true`. This is the criterion's "rather than silently":
  any client — not only the one that renders the prompt — has to say it has
  seen the matches. Linking to an existing record is never refused; that is the
  answer, not the problem.

`DUPLICATE_RECORDS` is a new stable error code, distinct from `CONFLICT`:
nothing is wrong with the request, and the client reacts by showing the matches.

There is deliberately no uniqueness constraint. Two reps entering the same
lead in the same second will both succeed, and a person who really does have two
leads at one company must be able to. Detection is a courtesy to people, not an
integrity rule; the integrity rules in ADR-0022 are the ones that cannot be
bypassed.

### 3. Who is allowed to be told

A match is a statement that a record exists, so it is held to the rules for
_reading_ that record, applied **inside each owning module**, in SQL, before any
row is fetched:

1. **Tenant.** RLS, as for every query. A lead, contact and account in another
   tenant with identical details are never matched, named, counted or hinted at.
2. **Record scope.** The reader's constraint (`own`/`team`/`all`) is a `WHERE`
   clause, not a post-filter. An `own` rep typing a colleague's email gets the
   same answer as typing an email nobody has — byte for byte, which is tested.
3. **Field permission, on the match key.** A caller who cannot read
   `contact.phone` is not matched on phone, and a lead value they cannot read is
   not used to look. Otherwise the check is an oracle for a hidden field: type
   guesses, see which ones hit.
4. **Field permission, on the label.** A match carries an id, a label and the
   reasons. The label is built from fields the caller may read, falling back to
   "Contact" / "Account" / "Lead".
5. **Object permission.** No `read` grant on contacts is an _empty answer_, not
   an error: a person creating a lead is not owed the news that they cannot read
   contacts. The check itself requires `create` on leads (conversion matches:
   `update` on the lead), so a role with no business creating leads cannot use
   it to browse.

The matching code lives in `ContactsService.findDuplicates` and
`AccountsService.findDuplicates`, called by `LeadsService`, because only the
owning module may query its table (ADR-0001) and because the scope and field
rules are that module's to apply. The leads module concatenates answers; it
cannot widen them.

The check is a `POST` with a body, not a `GET` with query parameters, because
the question contains an email address and a phone number, and URLs are
logged by every proxy between the browser and us (CLAUDE.md §5.8).

## Consequences

- A caller cannot learn that a colleague's or another tenant's record exists
  through this feature. The tests assert that on every match field, for leads,
  contacts and accounts, and that the response bytes match those for a value no
  one holds.
- **A real duplicate can be invisible to the person who creates it** — a rep
  with `own` scope will not be warned that a colleague already has this
  contact. That is the price of rule 2, and it is the right trade: the
  alternative is a rep-visible directory of the whole tenant. The remedy is a
  manager-run duplicate report and merge (P1), both of which read with `all`
  scope.
- Matching on a hidden field is impossible by construction, so a role that
  hides `email` gets no email-based prompts at all. Visible as a gap to whoever
  configured the role.
- Email variants (`a.b@gmail.com` vs `ab@gmail.com`, plus-addressing) and
  phone numbers entered in a non-E.164 shape are not matched. The contracts
  normalise case and require E.164, so the second is closed at write; the
  first is a known false negative.
- **Import (M4/M8) is not built**, so "on create/import" is satisfied for
  create only. The import module should call the same
  `LeadsService.checkDuplicates` per row and expose the `skip / update / create`
  choice the spec describes; it does not need new matching logic.
- Merge is P1 and absent. Matches link to the existing record; there is
  no "merge these two" action.

## Alternatives considered

- **Block the save on a match.** Rejected by the task and by experience: a
  prompt that cannot be dismissed is a prompt people work around by mistyping
  the email.
- **A unique index on `(tenant_id, email)`.** Rejected: legitimate duplicates
  exist, and it would make "a lead and the contact it became" impossible, since
  both hold the same email.
- **Match across the whole tenant for completeness and strip results
  afterwards.** Rejected: it is the leak, with a filter in front of it. The
  count, the timing and the next developer's `console.log` all see the
  unfiltered rows.
- **`word_similarity` instead of `similarity`.** Rejected for the false
  positives in §1.
- **Fuzzy match on person names.** Rejected for the reason in §1.

## Amendment (2026-10-26): contacts and accounts entered by hand

The first version of this decision checked a lead being created and a lead being converted, and nothing else.
A contact or an account typed in by hand was saved with no check at all (pilot finding F4: 25 of 25 second
contacts with the same e-mail address went in without a word), although the import has had its own
skip-or-update choice since it was built.

Contacts and accounts now follow the lead rule in section 2, unchanged: `POST /contacts/duplicate-check` and
`POST /accounts/duplicate-check` (a body, not a URL; they need `create` on that object), and a create answers
201 whatever it matches, with the matches in `meta.duplicates`. The matches are the same as in section 1 for
that object (contacts: exact e-mail and exact phone; accounts: same domain, or a name above the 0.5
similarity), and the five rules of section 3 apply as they do for leads, tested in
`contacts.duplicates.security.spec.ts` and `accounts.duplicates.security.spec.ts`. The matches are looked up
before the insert in the same transaction, so the new record never matches itself. The "New contact" and "New
account" dialogs ask first and offer "open it", "back to edit" and "save anyway".

What did not change, and is worth knowing: a Sales Rep on `own` scope is still not told about a colleague's
contact (section 3, rule 2), so in a team where reps each hold their own customers a duplicate across two
reps stays invisible to them. A manager or an administrator, whose scope reaches both, sees it. Whether a
small team should be given wider reading for this purpose is a product decision for the owner, not a
default to loosen quietly.
