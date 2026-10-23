# Performance

Measured on 2026-10-22, against one company holding **1,000,000 contacts** (and 100,000 accounts,
200,000 leads, 200,000 deals, 500,000 activities, 1,000,000 audit rows and 5,600,000 search rows),
through the real HTTP API with real sessions. Budgets are MVP_SPEC §9: list p95 < 200 ms, search
< 300 ms. Method and caveats are in §6; **read them before quoting a number**, because this is one
laptop, not a production environment.

## 1. The short version

- **Every list, record, dashboard and audit read is inside budget at a million contacts**, for a user
  who sees everything and for a rep who sees about 2% (§2). Keyset pagination and the indexes do what
  they were built to: a page 4,000 rows deep costs the same as the first.
- **Global search was not.** It took 3 to 6 seconds at a million contacts and, under load, held every
  database connection and failed everything else. It is now about 0.1 s for a common surname (§4).
  Two terms are still borderline: a typo (fuzzy fallback) and a rare term, at p95 of 320 to 370 ms
  against a 300 ms budget.
- **Free-text `q` on a list is not inside budget and is not fixed.** A term that matches nothing scans
  the whole table: 3.7 s on contacts at a million. It cannot be indexed under row-level security. This
  needs a decision (§5).
- **One API process sustains about 30 requests/s of mixed traffic** (p95 about 210 ms), degrades at 40
  and collapses at 50, answering `503 SERVICE_BUSY` rather than hanging (§3).
- The load test found **a security hole** (list `q` searched fields the caller may not read) and **a
  silent full-table scan** (exact email lookups). Both are fixed and tested (§4).

## 2. One request at a time

p95 in milliseconds. "Everything" is a user who sees all records; "a rep" sees their own, about 2% of
the company. Bold is over budget. The 250k column is the same code on a quarter of the data, to show
how each path scales; its search rows predate the search changes in §4.

| Path                                         | Budget p95 | 250k p95 | **1M p95, everything** | 1M p95, a rep (own records) | 1M p50, everything |
| -------------------------------------------- | ---------: | -------: | ---------------------: | --------------------------: | -----------------: |
| contacts: first page, newest first           |        200 |     61.1 |                   52.1 |                        61.1 |               38.6 |
| contacts: a page 4,000 rows deep (keyset)    |        200 |     72.4 |                     79 |                       111.4 |               49.7 |
| contacts: sorted by surname                  |        200 |     59.6 |                   77.9 |                        86.5 |               43.1 |
| contacts: filter surname starts with         |        200 |       50 |                   73.1 |                        91.1 |               42.8 |
| contacts: filter by email (duplicate lookup) |        200 |     41.4 |                     67 |                        55.5 |               47.4 |
| contacts: free-text q=surname                |        200 |     53.9 |                   92.6 |                     **449** |               66.4 |
| contacts: q matches nothing (worst case)     |        200 |    801.6 |             **3701.3** |                   **683.6** |             3476.6 |
| leads: q matches nothing (worst case)        |        200 |    223.6 |                **843** |                        92.7 |              774.1 |
| accounts: q matches nothing (worst case)     |        200 |    130.9 |              **397.3** |                          68 |              336.2 |
| contact: one record                          |        200 |     41.4 |                   50.8 |                          58 |               36.2 |
| accounts: first page                         |        200 |     58.2 |                   46.5 |                        75.8 |               34.3 |
| accounts: sorted by name                     |        200 |     61.8 |                   45.3 |                          65 |               34.2 |
| account: one record                          |        200 |     47.7 |                   42.9 |                        45.3 |               30.8 |
| leads: first page                            |        200 |     45.2 |                   46.5 |                        52.5 |               36.4 |
| leads: filter status=new                     |        200 |     62.3 |                   44.9 |                        58.2 |               32.8 |
| deals: first page                            |        200 |     62.1 |                   48.6 |                        61.4 |               36.1 |
| deal: one record                             |        200 |     54.8 |                   42.1 |                        53.5 |                 32 |
| deals: pipeline board                        |        200 |     72.6 |                  110.5 |                        85.8 |               92.9 |
| activities: my open tasks                    |        200 |     79.6 |                   69.6 |                        63.1 |               44.8 |
| activities: on one contact                   |        200 |     62.2 |                   50.1 |                        63.4 |               34.8 |
| my day                                       |        200 |    108.8 |                   97.7 |                       109.6 |                 79 |
| dashboard: pipeline                          |        200 |     73.5 |                  105.5 |                        88.3 |               84.8 |
| dashboard: won this month                    |        200 |       68 |                   76.2 |                        70.2 |               52.8 |
| dashboard: leads by source                   |        200 |      129 |              **233.6** |                        94.1 |              159.1 |
| dashboard: overdue tasks                     |        200 |    122.5 |                    143 |                       120.1 |                107 |
| dashboard: leaderboard                       |        200 |    110.3 |                   85.4 |                        97.3 |                 58 |
| audit log: first page                        |        200 |     60.6 |                   46.7 |               not permitted |                 32 |
| audit log: one record’s history              |        200 |     84.2 |                  169.8 |               not permitted |              135.6 |
| search: a common surname                     |        300 |      198 |                  107.4 |                   **427.4** |               82.1 |
| search: full name                            |        300 |    279.1 |                   92.3 |                       179.1 |               70.8 |
| search: a rare term                          |        300 |      256 |              **318.6** |                       174.1 |              101.9 |
| search: a typo (fuzzy)                       |        300 |    222.2 |                **372** |                       158.6 |              168.4 |
| notifications: unread count                  |        200 |     49.9 |                   43.3 |                        51.8 |               31.9 |

Reading it: the paths that read an index by key (first page, deep page, sort, filter, one record) are
flat from 250k to a million. The ones that grow are those that aggregate or filter a large share of the
data: the pipeline board, the audit history of one record, overdue tasks and **leads by source, at
234 ms the one read outside search and `q` that is over its 200 ms budget** (it counts every lead by
source in one pass; a cached or incrementally maintained count is the usual fix and has not been built).

## 3. Many requests at once

An open loop: requests are issued on a schedule whether or not the last one has answered, which is how
a crowd behaves, so a queue can build. Mixed traffic, weighted towards lists and records (40% first
pages, 20% single records, 10% search, 8% sorted or filtered lists, 8% dashboards, 8% notifications, 6%
activities). One API process (pool of 10 connections), one Postgres container, the load generator on
the same machine.

| Offered load |   Served | Errors | In flight (peak) |       p50 |       p95 |        p99 |
| -----------: | -------: | -----: | ---------------: | --------: | --------: | ---------: |
|     20 req/s | 20 req/s |      0 |               17 |   60.2 ms |  267.7 ms |   730.9 ms |
|     30 req/s | 30 req/s |      0 |               11 |   61.4 ms |  209.4 ms |   400.8 ms |
|     40 req/s | 38 req/s |      0 |               49 |   66.2 ms |  907.1 ms |  1384.8 ms |
|     50 req/s | 34 req/s |     76 |              435 | 8196.3 ms | 9627.4 ms | 11329.4 ms |

- **About 30 requests/s is the sustainable rate for one process here**: roughly 100 to 150 active people.
- At 40 it queues; at 50 requests wait for a database connection and time out. Every one of the 76
  failures at 50 requests/s was the same error, a connection-pool timeout, and is now reported as
  `503 SERVICE_BUSY` with `Retry-After: 2` instead of a generic 500.
- A closed loop of 20 clients with no think time (the other mode of the runner) puts every path at
  160 to 300 ms, even a trivial count. That is a throughput ceiling of about 100 requests/s for cheap
  endpoints, with the API process and Postgres each using about one core. It is not a statement about
  any one query. The per-request fixed cost behind it (about 10 ms of API CPU and 10 ms of Postgres CPU
  for a trivial endpoint) has **not** been investigated and is the next thing to look at for capacity.
- Scaling is by instances behind the proxy. Rate limits are still counted per process (§7).

## 4. What the load test found, and what changed

### 4.1 Free-text `q` searched fields the caller may not read (security)

`sort` and `filter` refuse a field the caller cannot read, because comparing or ordering by a hidden
column reads it a character at a time. `q` matched first name, last name, email and phone on every list,
and in exports, regardless of field permissions: `q=@gmail` answered as a list of rows is the same leak.
Found by reading the SQL while looking for why `q` was slow. Fixed in all five lists and in exports:
`q` searches only the searchable fields the caller may read, and matches nothing if they may read none.
`apps/api/src/common/search-fields.security.spec.ts` covers each object; with the leak put back, all
seven tests fail.

### 4.2 Exact email lookups read the whole table

`WHERE email = 'x'` took 161 ms at 250k and grew linearly although an index existed. `email` is
`citext`, whose equality function is not marked leakproof; with row-level security on, Postgres will not
use a non-leakproof function as an index condition, and every role the application uses is subject to
RLS. The index was built and maintained on every write and used by nobody. Migration 0020 compares as
`text` against a lower-cased value (a CHECK now guarantees the column holds nothing else) and indexes
`email::text`. The duplicate check on create, lead conversion, the import matcher and the list's email
filter all use it: 161 ms became 41 ms, and the plan reads the index. A canary test records the reason, so
if a future Postgres makes `citext` equality leakproof the workaround can be retired.

### 4.3 Global search

At a million contacts a surname shared by one record in sixty matches 67,000 index rows, and fetching and
ranking all of them took 3 to 6 seconds. Three changes (migration 0021 and `search/postgres.ts`):

1. **Only the newest 600 matches are ranked** (`SEARCH_CANDIDATE_CAP`), taken newest first from a new
   index in that order. A selective term (fewer than 600 matches, which is nearly everything typed after
   a second keystroke) is unchanged. A broad term is ranked among its most recently updated matches, so
   an older match of a higher-weighted field can lose to a newer one of a lower-weighted field.
   **That is a behaviour change**, argued in ADR-0041 §4.
2. **The two GIN indexes now lead with `(tenant_id, owner_id)`.** A rep's search is an index condition on
   both and reads the rep's rows; the same indexes are no bigger than before (213 MB against 214 MB,
   156 MB against 194 MB).
3. **A shared owner restriction is stated at the top of the predicate**, not only inside the per-object
   OR, because only a top-level condition can become an index condition.

p95, one request at a time, 1M contacts:

| Search                   | Everything, before | Everything, after | A rep, before | A rep, after |
| ------------------------ | -----------------: | ----------------: | ------------: | -----------: |
| search: a common surname |          3117.3 ms |          107.4 ms |     3134.9 ms |     427.4 ms |
| search: full name        |          2705.3 ms |           92.3 ms |     6082.1 ms |     179.1 ms |
| search: a rare term      |          3187.2 ms |          318.6 ms |     2065.2 ms |     174.1 ms |
| search: a typo (fuzzy)   |          3319.8 ms |            372 ms |     5795.6 ms |     158.6 ms |

The rare-term and typo rows are the fuzzy fallback on near misses; after subtracting the load
generator's overhead they sit around 250 to 400 ms on this I/O-constrained machine. They are over
budget and are reported as such.

### 4.4 Overload now says so

Past the pool's capacity the API answered a generic 500 and logged a stack trace per request. Overload is
not an unexpected failure: it is now `503 SERVICE_BUSY` with `Retry-After: 2` and one warning line, so a
client waits instead of reporting an error. This does not stop one slow endpoint from using the whole pool
(§5); it makes that failure honest.

## 5. Not fixed: list `q` on a term that matches nothing

`GET /contacts?q=…` is `ILIKE '%term%'` across four columns. For a term with matches it stops early
(newest first, 50 rows) and costs 40 to 90 ms. For a term that matches **nothing** it reads the whole
table. p95 at a million contacts: **contacts 3.7 s, leads 0.84 s, accounts 0.40 s**; already 0.8 s on
contacts at a quarter of that. It is the realistic case of a typo.

It cannot be indexed through the application role: `texticlike` is not leakproof, so a trigram index is
never an index condition under RLS (the same rule as §4.2). Three ways out, none free:

| Option                                                                                               | What it costs                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A.** Mark the ILIKE functions leakproof in the bootstrap script, and add a trigram index per table | Needs a superuser (like ADR-0028 §7, which already needs one), and widens a deliberate weakening of a Postgres safety default. Keeps substring semantics.                             |
| **B.** Serve `q` from the search index                                                               | Fast, and field permissions are correct by construction. Changes what `q` means from substring to word-prefix plus typo tolerance. Depends on the same two leakproof marks as search. |
| **C.** Leave it and document it                                                                      | Costs nothing. A typo in a list's search box takes seconds, and a few of them at once can exhaust the pool.                                                                           |

I recommend **B** (it makes the list box behave like the command palette, which is what people expect),
but it is a product decision, so it is waiting for one.

## 6. How this was measured, and how far to trust it

- **Hardware:** one Windows laptop, 12 logical CPUs. Postgres 16.6 in Docker with 3.7 GB for the VM,
  default `shared_buffers` (128 MB), against a 4.7 GB database: part of every large read comes from
  disk, which is pessimistic for a production instance with enough RAM and optimistic about nothing.
- **The load generator, the API and Postgres share the machine.** Latency includes the generator's own
  overhead; throughput numbers are lower than a dedicated box would give.
- **One company**, 43 users, data shaped like a company three years old (created times spread over three
  years, time-ordered UUIDv7 keys, surnames repeating across about sixty values so common terms match
  thousands of rows). One tenant is the design's worst case for a single tenant's queries and says nothing
  about a thousand tenants sharing tables.
- **Reads only.** No writes, no imports, no exports, no worker activity. Write throughput, the outbox
  backlog and the import of a large file are not measured here.
- **No browser.** MVP_SPEC §9's "list page interactive < 1 s" needs a rendered page; this is API time.
- **Warm and cold:** each path ran a warm-up first. After a restart or an index build the first minutes
  are slower (one 30-second mixed run at 20 requests/s, cold, had a p95 of 6 s; the warm rerun had 270 ms).
- **Variance is real.** Repeated runs of the same scenario differed by 20 to 50% at the tail. Treat a
  p95 within about 30% of a budget as "at the budget", in either direction.

### Reproducing it

```bash
# 1. a scratch database, migrated and seeded with the demo tenant
pnpm db:migrate && pnpm db:seed
# 2. load it (a million contacts takes about 30 minutes; 250000 about 6)
PERF_ADMIN_URL=postgres://postgres:…@localhost:15432/crm_perf \
  pnpm --filter @crm/db perf:seed -- --contacts 1000000 --reset
# 3. start the API on it, then measure one request at a time...
pnpm --filter @crm/api perf:run -- --email owner-…@example.com --password … --concurrency 1
# ...or mixed traffic at a fixed rate
pnpm --filter @crm/api perf:run -- --email owner-…@example.com --password … --rate 30 --seconds 30
```

The seed refuses a database whose name does not contain `perf`, `load`, `scratch`, `e2e` or `test`.

## 7. Known gaps

- Rate limits are per process; with several API instances the effective limit is multiplied.
- The per-request fixed cost (§3) is uninvestigated.
- Search needs a database where a superuser can run the bootstrap script. Without the two leakproof
  marks, at a million contacts: a rare term took 13.6 s and a typo 31.6 s. See [RUNBOOK](RUNBOOK.md) §0.
- Writes, imports, exports and many tenants are unmeasured.
