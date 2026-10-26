# Pilot simulation

Before real pilot businesses use the product, three made-up businesses ran it for six simulated weeks. Every
click-level action went through the real API, as the real roles: owner, manager, sales reps, a read-only
accountant. This document says what was simulated, how to run it again, what the numbers were, and what broke.

Everything here is made-up data. No real person or business is in it. Section 3 says how that is guaranteed.

> **How to read this.** "Verified" means the simulation or a hand test showed it against the running product.
> "Unverified" means it is an inference or a guess, and says so. Severity is: **high** (a promise of the product
> is broken, or data could leak), **medium** (a user will hit it and lose time or trust), **low** (rough edge).

## 1. The short version

**What ran.** 3 businesses (each its own company/tenant), 15 people, about 28,000 API requests over 6 simulated
weeks (30 working days), in 18 minutes of real time. The last full run was on 26 October 2026.

**What held.**

- **Zero server errors** (no 500s) in about 28,000 requests.
- **No data leaked between people or companies.** Reps saw only their own records, managers only their team's,
  the owner of one company got 404 for every record, edit, delete, list, search and member of the other two.
  A field hidden from a role stayed hidden in lists, single reads, writes and exports. Every probe passed.
- **Numbers agreed with each other.** The dashboard's open-pipeline and won-this-month figures equalled the sums of
  the same person's deal lists 168 times. The owner's counts equalled team plus own. Paging never repeated a row.
- **Speed was good at this size.** Median 67 ms, 95% of requests under 155 ms, 99% under 334 ms, with about 1,000
  records per company. (The earlier load test at 1,000,000 records is in [PERF.md](PERF.md); this run is not a
  replacement for it.)

**What broke or hurt, in order of importance** (full list in section 6):

| #   | Severity | In one line                                                                                                                  |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| F1  | high     | Two-factor sign-in cannot be set up by typing the key the page shows: the codes it gives are always refused.                 |
| F2  | high     | A Manager cannot reassign work (answer 422), although the role description and the spec say they can.                        |
| F3  | high     | A Manager can delete a team member's record, see it in the Recycle Bin, but "Restore" answers 404 and it stays deleted.      |
| F4  | medium   | A second contact with the same e-mail address is created without any warning (25 of 25 tries); reps cannot delete it.        |
| F5  | medium   | Every phone number in an exported file starts with an apostrophe (198 of 198), so it is wrong in a spreadsheet.              |
| F6  | medium   | `POST /accounts` ignores the `Idempotency-Key` header: sending it twice makes two accounts.                                  |
| F7  | medium   | A business cannot bring its history over: no original dates, no deals import, contact import cannot link to an account.      |
| F8  | medium   | Fifty sign-ins from one address in 15 minutes lock everyone at that address out for about 7 minutes (successful ones count). |
| F9  | medium   | A few requests were very slow (12 over 5 s, the worst about 12 s) in an otherwise fast run. Cause not found. Unverified.     |

**What the findings suggest for Phase 2** is in section 8. In short: fix F1 to F6 first (two of them are the manager role; they are small,
and they touch trust), finish the saved views and bulk actions the spec already promises, make moving a business
in possible (import deals, dates), and let a company edit its pipeline. Which new feature comes next (quotes with GST,
automation, a WhatsApp button) is a judgement the run cannot settle: the mix of work in it was chosen by the
script's author.

## 2. What was simulated

### The three businesses

All names are invented, and "Pilot" is in each company name on purpose.

| Business                                   | Trade                                                                                                                 | People                                                                                                                | Records at the start (accounts / contacts / leads / deals) |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Vasundhara Pilotmart Wholesale LLP**     | Wholesale dry fruits, spices and staples to shops, caterers, hotels (GST accounts, repeat)                            | Owner, Manager (signs in with a one-time code), 2 Sales Reps, 1 restricted rep ("Junior Rep"), 1 Read-only accountant | 220 / 319 / 90 / 120                                       |
| **Sarvatra Pilot Repairs and AMC Pvt Ltd** | Repair, installation and yearly maintenance contracts for offices, clinics, shops (many small deals, many follow-ups) | Owner (one-time code), Manager, 2 Sales Reps                                                                          | 260 / 330 / 139 / 200                                      |
| **Gyanankur Pilot Coaching Institute**     | Coaching for school foundation, board exams and entrance tests (many leads, short pipeline, enrolments)               | Owner, Manager, 3 counsellors as Sales Reps (one with a one-time code)                                                | 180 / 400 / 330 / 129                                      |

Each company has its own custom fields, made by its owner through the customisation API: for example credit days
and credit limit for the wholesaler, AMC status and device type for the repair company, student class and target
exam for the institute. Roles are the product's own: Owner, Manager (team scope), Sales Rep (own scope),
Read-only (all scope, no export), and one custom role built from Sales Rep that hides credit limit and company
turnover. A "Sales team" was created in each company and the manager and reps were put in it.

### How the people were created

The three workspaces and their owners were made with the repository's own `pnpm tenant:create` command (as the
operator would). Every other person was **invited by the owner through the API, and accepted the invitation** by
opening the link the API printed to its log (the console mail provider), choosing a name and password, as a
real invitee does. Nothing was written to the database except through the API and that one command. The
database is a separate throwaway one, `crm_pilot`.

### What a day looks like

Per person, per working day, in a seeded random order (the same seed gives the same choices): open My Day, glance
at the dashboard, check notifications, capture new leads (some after a duplicate check), work leads
(new, contacted, qualified or unqualified, each with a logged call), convert qualified leads (link to an existing
contact or account when the API finds one), add customers, open deals, move deals through the stages and win or
lose them (with a lost reason), schedule follow-up tasks, complete tasks due today, write notes, search, edit
records in place, browse lists with sort, filter and the list search box. Several times a week: attach a small
file, export a list as CSV, delete and restore a record. Managers also imported a 38-row contact spreadsheet
(twice), tried to reassign deals, assigned tasks to reps and edited the same deal as a rep at the same moment.
The owner looked at the audit log and, in the last week, exported the whole company.

Deliberate mistakes, a few a day: saving with an old version number, bad e-mail, phone not in `+91...` form, an
unknown field, a second contact with the same e-mail, a deal marked lost without a reason, a blank company name, a
malformed record id, a note over the size limit.

Security probes at the end (section 7): own scope, team scope, other company, hidden fields, read-only role,
administrator routes, signed-out and made-up sessions, sign-out, wrong password, one-time codes.

### What the simulation could not do (and what it did instead)

- **Time.** Six weeks ran in 18 minutes, so "dates" are simulated: due dates and expected close dates are set
  relative to a simulated calendar starting Monday 26 October 2026, and My Day was asked for that simulated
  date. **Creation and closing times are the real clock**, because the API cannot backdate a record (finding F7).
  So reports by month, "won this month", and ageing are not exercised over weeks.
- **People are faster than people.** A person here made about 8 requests a second at peak, not a few a minute.
- **Screens.** The simulation talks to the API. It does not click through the web app, so screen problems (layout,
  wording, how many steps a task takes) are not covered. See "What the screens showed" in section 6.

### Records after six weeks

| Business  | Accounts   | Contacts   | Leads      | Deals      |
| --------- | ---------- | ---------- | ---------- | ---------- |
| wholesale | 220 to 291 | 319 to 497 | 90 to 233  | 120 to 332 |
| repairs   | 260 to 344 | 330 to 546 | 139 to 360 | 200 to 539 |
| coaching  | 180 to 241 | 400 to 726 | 330 to 931 | 129 to 364 |

## 3. The data is made up: how that is guaranteed

- **Names.** First names and surnames come from hand-written lists of common Indian names
  (`scripts/pilot/data/names.mjs`) and are combined at random. A combination can coincide with a real person by
  chance; that is why nothing else about them is real.
- **Companies.** Customer company names are invented words made from syllables plus a trade word ("Ndasa Tiffin
  Services"). The three pilot companies carry "Pilot" in their names. A customer name could coincide with a
  real small shop by chance; there is no way to rule that out for a name, so no other identifier is real.
- **E-mail.** Every address is at an `.example` domain, a name reserved so that it can never be registered or
  receive mail (CLAUDE.md section 13.1). A unit test checks it.
- **Phone numbers.** Format `+91` then a **zero** then nine digits (for example `+910` followed by nine digits).
  In India the leading 0 is the prefix for calls inside the country, not part of a number, so no subscriber's
  number can be `+910...` in international form. The API checks only the general international shape
  (`+` and up to 15 digits), so these pass its validation. **Unverified:** I did not find an official reserved
  "fiction" range for Indian numbers (a web search found none), so the choice rests on the reasoning above, not on
  a regulator's list. Unit test: 500 generated numbers all match the shape.
- **GSTINs.** Right shape (15 characters), a real state code (the state of the made-up city), a made-up PAN part,
  and a **check character that is wrong on purpose**, so none can be a live registration. The product checks the
  shape only (it accepted every one), which is itself a small finding (F12). Unit tests check the shape and that
  the check character is never the correct one.
- **Addresses.** City, state and the first three digits of the postal code are real in the sense that they are
  consistent; the street line is made up.
- **Passwords.** Everyone's password in these companies is one fake local value, `pilot-password-not-for-production`,
  like the repository's own demo seed. These companies exist only on a laptop database.
- **Realism sources.** Section 9 lists the public pages used and when. No page was stored; only the facts used
  were kept. No name, phone, e-mail or other identifier of a real person or business was collected.

## 4. How to run it again

Needs: the repository built (`pnpm install --frozen-lockfile` then `pnpm build`), Docker with the compose
Postgres, Redis and MinIO containers up (`pnpm infra:up`), Node 24. It uses about 600 MB of memory for the API and
worker, so close other heavy things. Run the steps one at a time.

1. **Make an env file outside the repository.** Copy `scripts/pilot/pilot.env.example`, set `AUTH_SECRET` (for
   example `openssl rand -base64 48`). It points every database setting at `crm_pilot` and raises the rate
   limits. The commands below refuse to run if any database URL does not end in `/crm_pilot`.
2. **Create the database** (this only ever touches `crm_pilot`; add `--reset` to drop and rebuild it, with the API
   and worker stopped):

   ```bash
   bash scripts/pilot/prepare-db.sh /path/to/pilot.env
   ```

3. **Start the API and the worker** with that env file, keeping the API log, because invitation links are read
   from it:

   ```bash
   node --env-file=/path/to/pilot.env apps/api/dist/main.js > /path/to/api.log 2>&1 &
   node --env-file=/path/to/pilot.env apps/worker/dist/main.js > /path/to/worker.log 2>&1 &
   ```

4. **Build the three businesses** (about 6 minutes; safe to run again, it skips a business that has data):

   ```bash
   pnpm pilot:seed --env-file /path/to/pilot.env --mail-log /path/to/api.log
   ```

5. **Run six simulated weeks** (about 18 minutes, 28,000 requests):

   ```bash
   pnpm pilot:run --env-file /path/to/pilot.env
   ```

   Results go to `.pilot/run-results.json` (git-ignored). `--weeks 2` for a shorter run, `--only repairs` for one
   business. Print the numbers as tables with `node scripts/pilot/tables.mjs`.

6. **What happens with the default rate limits** (optional): start a second API without the raised limits on another
   port and its own Redis database number, then `node scripts/pilot/rate-limits.mjs --api-url http://localhost:3012`.
7. **Stop** both processes. Nothing here changes any machine setting.

**Same seed, same data.** `--seed pilot-1` is the default. A re-run on a fresh database creates the same
companies, people, customers and payloads. Timings, and which of two people's edits comes first, vary.
`pnpm test:scripts` runs the unit tests of this tooling (random numbers, data shape, one-time codes, CSV).

**Look at the data in the browser.** After the run, build and start the web app against the same env file. The build must
run with `NODE_ENV=production` (an env file saying `development` makes it fail), and the web app must be run with
`next start`, never `next dev`:

```bash
NODE_ENV=production pnpm exec turbo run build --filter=@crm/web   # with the env file's variables loaded
cd apps/web && NODE_ENV=production APP_ENV=local node --env-file=/path/to/pilot.env node_modules/next/dist/bin/next start --port 3010
```

Then sign in at `http://localhost:3010/sign-in`. Sign-in addresses are
`firstname.lastname@<company domain>.example` and are printed at the end of `pnpm pilot:seed`:

| Company   | Owner                                                   | Manager                                             |
| --------- | ------------------------------------------------------- | --------------------------------------------------- |
| wholesale | `ramesh.vora@vasundhara-pilotmart.example`              | `kavita.shenoy@vasundhara-pilotmart.example` (code) |
| repairs   | `anita.deshpande@sarvatra-pilot-repairs.example` (code) | `rohit.bhandari@sarvatra-pilot-repairs.example`     |
| coaching  | `vikram.rathore@gyanankur-pilot-coaching.example`       | `neelam.joshi@gyanankur-pilot-coaching.example`     |

Password for everyone: `pilot-password-not-for-production`. "(code)" means the account uses a one-time code; the
secret to generate it is in `.pilot/state.json` (field `totpSecret`).

## 5. The numbers

All from the final full run. Raised rate limits (otherwise the run would just measure the limiter); see 5.4.

### 5.1 Overall

| Measure                                           | Value             |
| ------------------------------------------------- | ----------------- |
| Simulated weeks / working days                    | 6 / 30            |
| Real time of the run                              | 18 minutes        |
| Requests to the API (three businesses, 15 people) | 27,995            |
| Median (p50) / p95 / p99 latency                  | 67 / 155 / 334 ms |
| Requests slower than 1 s / 5 s                    | 54 / 12           |
| Server errors (5xx or no answer)                  | **0**             |
| 429 Too Many Requests (limits were raised)        | 0                 |

The machine was a laptop shared with other work, one API process, one worker, one Postgres. The three companies
ran in parallel.

### 5.2 Answers that were not 2xx

Most are the point of the test (mistakes, probes, or two people on one record). None is a 5xx.

| Answer                 | Count | What most of them were                                                                  |
| ---------------------- | ----- | --------------------------------------------------------------------------------------- |
| 409 VERSION_CONFLICT   | 213   | Stale-version edits made on purpose, and two people editing one deal.                   |
| 404 NOT_FOUND          | 198   | Probes (other company, other rep), deleted records, records reassigned away.            |
| 422 VALIDATION_FAILED  | 175   | Deliberate bad input and probes. (The API says 422, not 400, for bad input.)            |
| 403 FORBIDDEN          | 132   | Reps trying to delete, administrator routes, read-only user writing.                    |
| 409 CONFLICT           | 75    | 41 are the deliberate second conversion of a lead; the rest are two people on one lead. |
| 401 (3 kinds)          | 18    | Not signed in, wrong password, wrong one-time code (all on purpose).                    |
| 400 INVALID_TOKEN      | 3     | Re-sending an invitation (an older link stops working).                                 |
| 403 FIELD_NOT_WRITABLE | 2     | The restricted rep trying to write a field hidden from them.                            |

### 5.3 How fast, by action

p50 / p95 / p99 in milliseconds, with about 1,000 records per company. Calls is how many were made in the run.

| Action                                  | Calls | p50 | p95 | p99  |
| --------------------------------------- | ----- | --- | --- | ---- |
| Open a lead                             | 2,359 | 52  | 110 | 225  |
| Open a contact                          | 1,873 | 51  | 110 | 213  |
| Open an account                         | 1,021 | 52  | 107 | 180  |
| Open a deal                             | 547   | 55  | 114 | 257  |
| Accounts list, page of 50               | 226   | 56  | 99  | 201  |
| Contacts list, page of 50               | 196   | 57  | 98  | 205  |
| Leads list, page of 50                  | 218   | 56  | 107 | 242  |
| Deals list, page of 50                  | 199   | 63  | 134 | 6932 |
| Global search                           | 1,540 | 80  | 173 | 277  |
| Create a lead                           | 962   | 79  | 181 | 465  |
| Create a deal                           | 567   | 79  | 193 | 786  |
| Create a contact                        | 201   | 64  | 135 | 1047 |
| Create an account                       | 157   | 67  | 172 | 1044 |
| Move a deal to another stage            | 1,260 | 76  | 165 | 364  |
| Convert a lead (contact, account, deal) | 330   | 120 | 265 | 693  |
| Create a task or call                   | 3,117 | 76  | 154 | 286  |
| Complete a task                         | 1,407 | 79  | 148 | 257  |
| Create a note                           | 750   | 73  | 149 | 209  |
| **My Day** (the home screen)            | 450   | 118 | 269 | 684  |
| Dashboard: pipeline                     | 296   | 63  | 139 | 638  |
| Dashboard: won this month               | 84    | 72  | 560 | 6849 |
| Sign in (password hashing)              | 24    | 198 | 292 | 328  |
| Export a list: ask for it               | 55    | 77  | 178 | 279  |

The few very large p99 values (deals list, dashboard, create) come from single slow requests; see F9.

**The slowest common action is My Day**, the screen people open first (median 118 ms, 5 per cent over 269 ms).
Search is quick, and a new record could be found by search 410 to 730 ms after saving it (three samples per
company, see section 5.5).

### 5.4 What the default rate limits do

Measured against a second API instance with the default limits (verified): one signed-in person asking for My
Day as fast as the laptop could answer got **429 on request 300, after 36 seconds**, with `Retry-After: 25` and the
message "You are sending requests too quickly. Try again shortly." Sign-ins from one address got **429 on the 50th
sign-in** (correct passwords all), with `Retry-After: 449` seconds and "Too many attempts. Try again in a few
minutes."

How many 429s the simulation itself would have hit with the default limits: **not measured as a count**, because
the simulation works about 100 times faster than a person, so it would hit them all day, which says nothing about
real use. For a person at a screen: the default per-user limit is 300 requests a minute. Whether a real session stays
under it depends on how many API calls a web page makes, which was not measured (the screens were not exercised; see
section 6). **Unverified** for a full working day. The sign-in limit is the one a real team can meet (F8).

### 5.5 Everyone at once, and search lag

One burst: all 15 people sent 30 reads each at the same moment (450 requests in 11.7 s), against one API process.

| Action        | p50    | p95     |
| ------------- | ------ | ------- |
| My Day        | 502 ms | 1090 ms |
| Accounts list | 371 ms | 676 ms  |
| Deals list    | 297 ms | 450 ms  |
| Search        | 310 ms | 580 ms  |
| Dashboard     | 229 ms | 401 ms  |

Everything is over the 200 ms p95 budget in [MVP_SPEC.md](MVP_SPEC.md) section 9 in this burst. 15 people sending
2 requests per second each at the same instant is a harsh test on a shared laptop, so this shows the shape (My Day is
worst), not a capacity figure. [PERF.md](PERF.md) has the proper load test.

Time from saving a new account until search found it: wholesale 726, 444, 498 ms; repairs 552, 471, 565 ms;
coaching 451, 413, 462 ms.

### 5.6 How much was done

| Business  | Leads made | Leads converted | Deals made | Deal moves | Won / Lost | Tasks made | Tasks done | Notes | Searches | Exports |
| --------- | ---------- | --------------- | ---------- | ---------- | ---------- | ---------- | ---------- | ----- | -------- | ------- |
| wholesale | 142        | 50              | 177        | 335        | 41 / 28    | 360        | 357        | 239   | 450      | 18      |
| repairs   | 220        | 87              | 270        | 494        | 48 / 77    | 450        | 450        | 270   | 478      | 17      |
| coaching  | 600        | 177             | 120        | 335        | 27 / 49    | 719        | 600        | 240   | 600      | 20      |

Tasks and calls created: 1,529 in six weeks. The daily mix was chosen by the script's author, so these counts show
what the script did, not what real teams do.

## 6. Findings

Each has an id, how to see it, and what it means. "Verified" findings were seen in the run or by hand on the
running product. The reproduction uses the public API; the data was from this run.

### High

**F1. Two-factor setup: the key the page shows does not work (high, verified).**
Settings, Security shows a text "setup key" and no QR code (the component says why, in
`apps/web/src/components/security-settings.tsx`). Typing that key into an authenticator app gives six-digit codes
that the server **always refuses** (401 `MFA_INVALID`). Reproduce: sign in as any user, `POST /auth/mfa/enroll`;
compute a standard one-time code (RFC 6238, SHA-1, 6 digits, 30 s) from the returned `secret` read as base32, and
call `POST /auth/mfa/activate` with it: refused. Compute the code from the `secret` parameter inside the returned
`otpauthUrl` instead, and it is accepted (204). The server uses the text of the base32 string as the key, so only the
QR/link version, which base32-encodes that text again, matches what an app computes. In this simulation the
one-time-code users were enrolled with the `otpauthUrl` secret. The web page shows no `otpauthUrl` or QR, so as
the page stands **a person cannot turn on two-factor sign-in through the web app**. (Unverified in a real
authenticator app: I used a standards-conformant code generator that passes the RFC test vectors, see the unit
test, not a phone.) Why it matters: two-factor is a selling point, and an owner who tries it will conclude it is broken.

**F2. A Manager cannot reassign work (high, verified, 12 of 12 attempts across all three companies).**
`POST /ownership/preview` as the default Manager answers 422 "You cannot assign records to another user". The code
(`ownership.service.ts`, `actorRefusal`) requires `all` scope on update; the default Manager role has `team` scope.
The role's own description says "can reassign work", and [MVP_SPEC.md](MVP_SPEC.md) section 4 says the Manager persona
needs to "reassign work". Only an owner or admin can. In the run the owner did it instead. A manager can still assign
a **task** to a rep (that worked, and the rep was notified within 2 s, 15 of 15).

**F3. A Manager cannot restore a team member's record from the Recycle Bin (high, verified; 3 times in the run, 5 by hand).**
A Manager (team scope) deletes a record owned by a rep. It appears in the Recycle Bin (list answers correctly, with a
30-day purge date). `POST /recycle-bin/{type}/{id}/restore` with the version from the list answers **404 NOT_FOUND**
("contact not found") and the record stays deleted. Same for accounts, deals, leads and contacts. Restoring one's
own record works, and the owner can restore anyone's. So a manager's accidental delete of a rep's deal cannot be
undone by the manager. Likely cause: the restore re-checks team scope against a row that is already soft-deleted
(unverified, from the symptom).

### Medium

**F4. Duplicate contacts are created silently (medium, verified, 25 of 25 attempts).**
`POST /contacts` with an e-mail address already on another contact (in different capitals) answers 201 with no
warning. A duplicate check exists, but only for leads (`POST /leads/duplicate-check`; it found the match every
time). The import has a duplicate setting (skip or update) and it worked (6 matching rows skipped or updated in
each company), so hand entry is the only gap. A rep cannot delete the duplicate (F11) and there is no merge yet.
In a company where reps add contacts all day, duplicates will pile up.

**F5. Phone numbers in exports start with an apostrophe (medium, verified, 198 of 198 phone cells in one export;
the same in the import error file).**
The guard against spreadsheet formulas (CLAUDE.md section 5, rule 11) puts `'` in front of any cell starting with
`+`, and every phone number is `+91...`. Opened in a spreadsheet the apostrophe shows or the number is text, and
importing the file again would carry the apostrophe in. The guard is right; it should skip cells that are
plain phone numbers.

**F6. `Idempotency-Key` is ignored when creating an account (medium, verified in all three companies).**
CLAUDE.md section 6 says POSTs that create records accept the header. `POST /accounts` twice with the same key
and body made two accounts. (Imports and exports do honour it.) A flaky connection that retries a save will create
duplicates. Not checked for the other record types.

**F7. A business cannot bring its history over (medium, verified).** Three gaps for anyone arriving from another system or
a spreadsheet: (a) there is no way to set a creation date (a request with `createdAt` is refused as an unknown field);
(b) the import handles accounts, contacts and leads only, **not deals**; (c) a contact import can fill name, e-mail,
phone, WhatsApp, title, lead source and custom fields, but **cannot link the contact to an account or set the owner**,
and can only match existing rows on e-mail or phone. The first two weeks of a real pilot will mostly be spent here.

**F8. Sign-in limit counts every sign-in from an address (medium, verified).** Default limit: 50 per 15 minutes per
address. The 50th **successful** sign-in got 429 with "try again in a few minutes" and `Retry-After: 449` s. A
50-person company on one office connection, or several people on one mobile-carrier address, can lock themselves
out on a Monday morning. Counting failed attempts, or giving a successful sign-in a lighter weight, would avoid it.

**F9. A tail of very slow requests (medium, unverified cause).** 12 of 27,995 requests took over 5 seconds (worst
about 12 s: a lead conversion, an account creation, a task creation) and 54 took over 1 s, among ordinary actions
whose median is under 100 ms. They did not return errors. The cause was not found. Likely suspects are the shared
laptop (other programs, memory pressure) and one API process, one worker and the database all doing exports and
imports at once, but **none is verified**. It should be re-run on a quiet machine before being believed or dismissed.
Related: My Day is the slowest everyday call (median 118 ms), and the burst test (section 5.5).

**F10. A rep can link a deal to an account they cannot see (medium, verified in all three companies).**
`POST /deals` with the id of another rep's account, from a rep with own scope, answers 201. The deal is the
rep's, but points at an account they cannot open (so the deal list shows an account name they have no access to,
or nothing). The same probe on a task (`links`) was refused correctly ("That record does not exist"). Unverified what
the deal's account name shows on the screen.

### Low and friction

**F11. A Sales Rep cannot delete anything they created (low, verified, by design).** The default Sales Rep has no
delete permission, so a rep who adds a duplicate or a typo record has to ask a manager. With F4 and no merge it is a
real annoyance.

**F12. Phone numbers must be typed as `+91...` (low, verified).** `98765 43210`, `09876543210` and
`+91-98765-43210` are refused with "Phone must be in E.164 format". That is what the spec asks for; a sales rep
typing a number from a business card will see it often (18 deliberate tries, all refused). The form could accept
local formats and convert them. The same strictness is only about shape: **the API accepts `+910...` numbers that
cannot exist, and GSTINs with a wrong check character** (100 per cent of generated ones were accepted), so a typo in
a GSTIN is not caught.

**F13. Money is written two ways (low, verified).** A deal amount is `{ "amountMinor": "2500000", "currency": "INR" }`;
a currency custom field is `{ "amount_minor": "2500000", "currency": "INR" }`. Anyone building a client or an
integration will trip on it.

**F14. Two different 409 answers (low).** A stale edit is `409 VERSION_CONFLICT` ("changed by someone else. Reload and
try again"); changing a lead that someone has already converted is `409 CONFLICT` ("already been converted and can no
longer be changed"). Both messages are clear. A client has to handle both. 34 of the second kind happened in normal work (the other 41 of the 75 were the deliberate
second conversion), because a manager and the rep who owns a lead both worked it.

**F15. When someone takes your record you get a bare 404 (low, verified).** After a deal is reassigned or deleted by
someone else, the previous owner's next action on it answers "deal not found" (or "That record does not exist" on
a note's link). That is correct security behaviour; the screen should say "this record was moved or deleted".

**F16. The API itself accepts a write that claims a foreign `Origin` (low, verified, impact unverified).**
`POST /leads` with a session cookie and `Origin: https://evil.example` answered 201. The security review says the
protection is the `SameSite=Lax` cookie plus the web app's checks; I did not test a real cross-site browser request. If
the API is ever called straight from a browser (the planned mobile app and public API will not use cookies) this
needs a second look.

**F17. Reassigning a deal tells nobody (low, verified, gap).** Notifications exist only for assigned and due tasks
(`activity.assigned`, `activity.due`). A rep who is handed five deals is not told.

**F18. Limits seen but not a problem.** Free text longer than 32,000 characters, unknown fields and malformed ids are
all refused with a clear 422. A one-time code can be used twice inside its 30-second window (it is refused later);
RFC 6238 advises refusing a reuse (low, verified).

### What is not there (information, not defects)

Asked for by their obvious address and answered 404 (route missing), so these are not built on `master` at the time
of this run: **saved views**, **bulk edit / assign / delete from a list** (the only bulk action is the owner's
reassign), **tags**, **editing pipelines and stages** (every company gets the same six-stage pipeline: the coaching
institute's "short pipeline" and the repair company's "service stages" had to use it as it is), and the Phase 2
candidates: **products and price books, quotes, a report builder, automations, webhooks and API keys**. Saved views and bulk
actions are being built in other sessions.

### What the screens showed

**Nothing was clicked through.** The web app was built and started against this data (production build,
`next start`, sign-in page answered 200), but the in-app browser could not be used: its actions were refused by an
automatic safety check in the session that ran this, so no screen was opened, no page-load request count was taken
and no screenshot exists. Everything about screens is therefore **unverified**: list screens with 300 to 900 rows,
the deal board with 300 to 500 deals, the lead conversion dialog, the import mapping step, the Recycle Bin, and
the sign-in with a one-time code. One thing was read from the source instead: the Security screen shows the
two-factor setup key as text only (F1). The first thing to do with this data is to sign in as one rep from each company
and click through those screens; the sign-in details are in section 4.

### Things my script flagged that were not product problems

Listed so nobody wastes time on them: the API answers bad input with 422 (my first checks expected 400); a rep's
stale-version delete is refused with 403 because the rep may not delete (my check expected 409); the
"already converted" collision and "record gone" cases are ordinary two-person collisions, now counted not reported;
the custom-currency "mismatch" was only a different order of the same two keys; my reminder test task was completed
by the simulated person before it fell due; searching a family's surname found many families (not distinctive). The
final results file still shows 18 "lead.update 409" entries that are the same two-person case.

## 7. What was tried and held

Probes (each one tried to do something that must not work):

- **Own scope.** In all three companies, each rep listed, opened, edited, deleted, searched and exported against the
  other rep's records: every list had only their own rows (48 checks per record type), every foreign id answered 404,
  search and export never included the other rep's accounts.
- **Team scope.** The manager's lists had only team members' records (18 checks per type); the owner's total always
  equalled the manager's team total plus the owner's own (18 checks per type); the Read-only user saw exactly what
  the owner saw (6 checks per type).
- **Other company.** Each owner tried the other two companies' accounts, contacts, leads, deals and activities by id
  (read, edit, delete), lists, search, a member id and the access explainer, and the `X-Tenant-Id` header trick:
  404 or nothing every time (6 company pairs).
- **Hidden fields.** The restricted rep never saw credit limit or company turnover in lists, single reads or
  exports, and writing them was refused (403 `FIELD_NOT_WRITABLE`); the owner could see both.
- **Roles.** Reps and managers were refused on members, roles, audit log, invitations, erasure requests, teams and
  company profile. The Read-only user could read and not create or edit.
- **Sessions.** Requests without a session, or with a made-up one, got 401. After sign-out the old token stopped
  working. A wrong password and an unknown e-mail got the same answer. A wrong one-time code was refused.
- **Files.** A `.exe` was refused by name, and a file named `.pdf` that was not a PDF ended as "rejected" (3 of 3).
- **Spreadsheet formulas.** Cells starting with `=`, `@`, `-` were escaped in every export (the cost is F5).

Business logic checks that never failed (count of times each held): a saved lead / deal / account came back as sent
(962 / 567 / 148); amounts came back to the paisa (567); a deal moved to Won got a closing time and probability 100
(116 times), to Lost got a reason and probability 0 (154); a lead conversion made the contact and, when asked, the
account and deal (314), and converting twice was refused (41); a stale-version edit or delete was refused with 409
(33 and 33); a deal opened by a manager and a rep at once told the second person (15 of 15); deleting then restoring
as the owner worked (6); an import counted created, updated, skipped and failed rows that added up to the file (6 of 6),
and its error file named the bad rows (6 of 6); the whole-company export finished (3 of 3, 4.9 to 8.1 MB); an
attachment went up, scanned, listed and came back byte for byte (34 of 34); a task assigned to a rep reached their
notifications (15 of 15); a due-time reminder arrived (2 of 2 not completed first); the audit log was never empty,
filtered correctly and every entry had who, what and when (36 of 36).

**Good to say plainly:** a pilot business would not have met a crash, a leak, a wrong total or a lost record in
these six weeks. The things above are about management roles, data entry, and moving in.

## 8. What this suggests for Phase 2

**Read this first.** The daily mix of work in the simulation (how many leads, tasks, searches a person does) was chosen
by whoever wrote the script, so it **cannot show what real teams do most**. What the run can show is the state of the
product: what is broken, what the spec promises and is missing, and what a new business hits on day one. The
priorities below are ordered by that evidence first, and the feature candidates last, as judgement that a real pilot
should confirm or overturn.

Evidence from the run:

1. **Fix F1 to F6** (F2 and F3 are the manager role). They are small, they are about trust (two-factor, undo, no silent
   duplicates, a clean export, safe retries), and a real owner will meet each in the first week. None needs a new
   feature.
2. **Finish saved views and bulk actions**, which [MVP_SPEC.md](MVP_SPEC.md) section 7 (M4) already promises and which are
   not on `master`. Reps cannot delete (F11), duplicates are easy to make (F4) and there is no merge: bulk assign,
   bulk delete and merge are what a manager would need first. (Being built in other sessions at the time of the run.)
3. **Make moving in possible (F7):** an import for deals, link-to-account and owner columns in the contact import,
   and a way to carry original dates. Without it each pilot starts with a week of manual work.
4. **Let a company edit its pipeline and stages.** All three got the same six stages because there is no way to change
   them. The institute and the repair company both described a different shape of work.
5. **Make "lost reason" a list, not free text,** before any report depends on it (it cannot be counted today).

Judgement, **unverified** until real pilots say so (the evidence for each is the product's present state, not demand):

6. **Quotes with GST and PDF.** A deal holds one amount and no line items, the account's GSTIN is stored and used
   nowhere, and two of the three trades quote on every deal. The institute would more likely need a fee receipt with
   instalments (it made a "Fee instalments" field for itself).
7. **Follow-up automation, small first**, such as "when a lead is created, make a call task for tomorrow". Creating and
   completing tasks is two calls each today; the activities and the outbox events it would build on already exist.
8. **A plain WhatsApp chat button.** Every contact already has a WhatsApp number field; a link next to it costs little
   and needs no provider. The API-based WhatsApp work can wait.
9. **A report builder and email sync came out lowest.** The two dashboard figures that could be compared with the
   lists agreed every time (168 checks); email was not exercised at all (the console provider only), so the run has no
   evidence about it either way.

## 9. What was not verified, and the sources

**Not verified**

- Anything on the screens (section 6), anything in a real browser's cross-site behaviour
  (F16), a real authenticator app (F1), email (the console provider only: no real mail was sent and the digest
  email was not exercised).
- Behaviour at real volume. About 1,000 records per company; [PERF.md](PERF.md) covers a million.
- Real time passing: reminders were tested for a 90-second task only; recycle-bin purge after 30 days, session
  idle time-outs, monthly figures over weeks, and the weekly digest were not.
- The cause of the slow tail (F9). The laptop was also running other work.
- Deal sizes, fees, credit terms and prices in the data are plausible numbers, not market data (see the sources).
- That a random company name does not match a real small business.
- Robots.txt and terms of the public sites below were not read by me one by one; the pages are ordinary public
  pages fetched with Claude Code's web fetch tool, and four were only seen as search-result summaries.

**Public pages used for realism** (read 26 October 2026; nothing stored except the facts named; no person or
business details taken):

- GST state codes (kept: the two-digit codes and names, and the GSTIN layout of state code, PAN, entity number, `Z`,
  check character): https://www.godrejcapital.com/media-blog/knowledge-centre/gst-state-code-list (page fetched).
- Coaching fees (kept: a Class 9 and 10 foundation programme is about 35,000 to 1,00,000 rupees; used 35,000 to
  1,50,000 for enrolment deals): Vedantu city fee pages, for example https://www.vedantu.com/blog/vedantu-jee-neet-coaching-fees-chennai
  (search-result summary only; one company's own pages, so not a market survey).
- Annual maintenance contract prices (kept: nothing numeric; confirms AMCs are priced per unit by size or as one lump
  sum; I used 8,000 to 1,20,000 rupees for AMC deals and 1,500 to 30,000 for repairs, **assumed**): Indian
  government price-bid documents, for example https://sbi.co.in/webfiles/uploads/files_2425/150220251042-Price%20Bid%20AMC%20of%20ACs.pdf
  (search-result summary only).
- Wholesale credit terms (kept: vendors often give 7 days of credit, some sell cash on delivery, a platform offers up
  to 14 interest-free days; I used 0 to 45 days, **assumed**): https://entrackr.com/?p=108620 and
  https://madhyamamonline.com/amp/business/flipkart-wholesale-announces-credit-programs-to-help-kiranas-grow-their-business-839987
  (search-result summaries only).
- Indian mobile number format (kept: ten digits starting 6 to 9; leading 0 is the in-country prefix): web-search summary of
  https://sent.dm/resources/IN and similar pages; low-quality sources, which is why section 3 does not depend on a
  reserved range.
