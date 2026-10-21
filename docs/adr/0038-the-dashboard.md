# ADR-0038: The dashboard — figures come from the module that owns the records, and a hidden field is `null`, not zero

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

MVP_SPEC M10 asks for a home dashboard: pipeline value by stage, deals won this
month, leads by source, overdue tasks and a rep leaderboard. It is the first
screen that is made entirely of **sums and counts over other modules' records**,
and that changes what can go wrong.

A list shows a record the reader may see. A total is every record's amount added
up, and it can be read back to learn what the list would have hidden:

- a role that cannot read `amount` can still learn it from "pipeline: ₹12,40,000";
- a rep with `own` scope can learn a colleague's deal from a team total that is
  one deal bigger than their own;
- grouping leads by `source` is a way to read `source` for a role that is
  refused it, and "3 overdue" is a way to read due dates;
- "this month" is a statement about a clock, and the machines this runs on
  disagree about the time (ADR-0036 found them several seconds apart).

Two further facts shaped it. Every other module may be reached only through its
public service (ADR-0001), and there is no second place where "who may see this
record" is written.

## Decision

### 1. One endpoint per widget, each authorized against what it summarises

`GET /api/v1/dashboard/{pipeline,won,leads-by-source,overdue-tasks,leaderboard}`.
Not one `GET /dashboard` for the page. A role that may read leads and not deals
gets a working leads card and a 403 on the pipeline, and a slow or refused widget
cannot blank the rest. Each is authorized by `can()` against its own object
(`deal`, `lead`, `activity`); there is no `dashboard` object and no grant to hold
for it, because a grant that said "may see the dashboard" would be a second
opinion about the same records.

### 2. The dashboard module owns no table and no query

`DashboardModule` has a controller and a service and nothing else. The figures
are computed by a **reports service in the module that owns the records**
(`DealsReportsService`, `LeadsReportsService`, `ActivitiesReportsService`), using
that module's repository, which no one else may. The dashboard calls their public
methods and adds only composition — today, names on the leaderboard.

So the rules a list applies — the actor's scope as a `WHERE` clause (ADR-0008),
`notDeleted()`, field permissions — are applied by the same module's code, beside
the list's. Parity tests assert that a dashboard figure equals what the list of
the same records adds up to for the same person.

One reach across a module boundary was needed: "which stages are won". The deals
module cannot join to `pipeline_stages`, so it asks `PipelinesService.stageIdsOfKind`
and filters on the ids it is given.

### 3. A field the reader cannot see makes the figure `null`, never zero

| Figure                | Needs                           | Without it                                         |
| --------------------- | ------------------------------- | -------------------------------------------------- |
| Pipeline by stage     | `stage_id`                      | 403 for the widget: a count by stage is `stage_id` |
| …its totals           | `amount`                        | counts only, `total: null`                         |
| Won this month / last | `closed_at`                     | `current` and `previous` are `null`                |
| …its totals           | `amount`                        | counts only                                        |
| Leads by source       | `status` (to exclude converted) | `total: null`, `sources: null`                     |
| …the breakdown        | `source`                        | `sources: null`, total still given                 |
| Overdue tasks         | `type`, `due_at` and `status`   | `count: null`, no items                            |
| Leaderboard           | `closed_at`, `owner_id`         | `rows: null`                                       |
| …its money            | `amount`                        | ranked by deals won, `total: null` on every row    |

The screen says "not available to you" for a `null` rather than drawing a zero
that looks like a fact. The company's reporting currency is shown regardless: it
is a fact about the company, not about any deal, and the board already does.

Counts that do not depend on the hidden field are still given (how many deals sit
in a stage), as the board has always done.

### 4. Time is the database's, and the calendar is the company's

"Now" is `now()` inside the request's transaction, and a month's boundaries are
computed in SQL from the company's IANA zone (`TenantClock`), never from a
`Date` in the API process. The window is read once and passed to the query as
instants, so one request cannot straddle a boundary. A stored zone the runtime
does not know falls back to UTC rather than failing the widget.

The month is the **company's**, not the viewer's: a figure everybody in a company
sees has to mean the same thing to all of them. My Day is the opposite on purpose
— it is one person's day, cut on their own zone (ADR-0011).

**Overdue** here means a task is open and `due_at < now()`. My Day's _Overdue_
bucket means due before the start of the viewer's today. They differ for a task
due at 09:00 and viewed at 15:00 the same day, and a team-wide count has to mean
"it is late", not "it is from a previous day".

### 5. Money converts once per currency, and the shortfall is reported

Totals use `CurrencyConverter.totalIn` over **per-currency subtotals**, as the
board does, so the number does not depend on how the deals were grouped. A
currency with no rate is left out of the total, counted, and named in
`unconverted`; a leaderboard row whose deals were partly unconvertible is marked
`partial`. The month-on-month change is computed in basis points on `bigint`, so
a large total cannot lose its low digits to a float.

### 6. People are named by one narrow door

The leaderboard must say whose number it is, and `GET /members` is
administrator-only. The access module exports `MemberDirectory.displayNames`,
which takes the ids it is given and returns **only display names of active
members**: no address, role or status, and no way to list or search. The ids
come from deals inside the reader's scope, so a rep with `own` scope sees only
themselves, and a person who has since left appears as "Former member" rather
than under a stale or erased name. The row also says `isYou`, so the screen can
mark the caller without knowing who they are.

### 7. The definitions

- **Pipeline value**: open stages of one pipeline (the default if none is named);
  won and lost deals are not pipeline.
- **Won**: the deal is in a won stage and `closed_at` is within the window. The
  stage decides the closed state (ADR-0020), so there is no other way to be won.
- **Open leads**: every current lead that is not converted and not deleted. A
  converted lead is a contact now and is counted there.
- **Lead sources** are compared case-insensitively and without surrounding
  spaces, because people type them ("Website", "website "); the label is one of
  the spellings. A blank source is the same as none. The eight biggest are named
  and the rest folded into one number so the rows always add up to the total.
- **Leaderboard**: wins this month by owner, converted value descending, then
  deals won, then id; the top ten.

### 8. `/dashboard` is where you land, and My Day stays

Signing in, accepting an invitation and finishing setup land on `/dashboard`,
which is also the first item in the sidebar (`G` then `H`). My Day remains the
home for one person's own work. The dashboard shows the getting-started
checklist (the same component the setup page uses) to anybody `GET /onboarding`
answers, until it is complete.

### 9. One index

Migration 0018 adds `deals_tenant_closed_idx (tenant_id, closed_at, id)` where
the deal is live and closed. Without it "won this month" read every deal a
company had ever won and discarded most of them, a cost that grows with the age
of the company. `dashboard.perf.spec.ts` asserts on the plan, not on a stopwatch.

## Consequences

- A new dashboard widget is a new reports method in the module that owns the
  records plus one route; it inherits scope, field gating and parity testing
  rather than re-deriving them.
- Every figure is computed on request. Leads by source and open pipeline read
  every open record of the company; the board already did the latter. At a
  million open leads that will want a maintained count (an outbox-driven
  projection) or a short cache. Neither is built, because neither is needed yet
  and both add a place where a total can disagree with a list.
- A role that is given a custom field-permission set must be given `closed_at`,
  `owner_id`, `stage_id`, `due_at`, `status` and `type` as well as `amount` and
  `source` to see the whole dashboard. A role missing one sees that figure as
  "not available to you", which is the safe direction to be wrong in.
- The leaderboard shows names to a reader who could not list members. That is a
  deliberate, narrow disclosure (display name of a person whose deals the reader
  can already see) and is tested not to widen.

## Alternatives considered

- **One `GET /dashboard` returning everything.** Simpler for the client, and one
  query's failure or refusal would take down the page. A refusal on `deal` would
  have to be either a 403 for a page that is mostly fine, or a partial body that
  needs its own convention for "this part is absent".
- **A `dashboard` object in the permission catalogue.** A third opinion about
  records that already have a scope and field rules, and a way for the two to
  disagree.
- **Aggregating in the dashboard module with its own SQL.** It would have had to
  read `deals`, `leads` and `activities` directly, which is the boundary
  violation the module rule exists to prevent, and would have copied each module's
  scope rule.
- **Viewer's time zone for "this month".** Two colleagues would see two different
  numbers for the same month.
