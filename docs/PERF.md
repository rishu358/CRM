# Performance

Measured on 2026-10-22 and 23, against one company holding **1,000,000 contacts** (and 100,000
accounts, 200,000 leads, 200,000 deals, 500,000 activities, 1,000,000 audit rows and 5,600,000 search
rows), through the real HTTP API with real sessions. Budgets are MVP_SPEC §9: list p95 < 200 ms,
search < 300 ms. Method and caveats are in §6; **read them before quoting a number**, because this is
one laptop, not a production environment.

## 1. The short version

- **Every list, record, dashboard and audit read is inside budget at a million contacts**, for a user
  who sees everything and for a rep who sees about 2% (§2). Keyset pagination and the indexes do what they were built to: a page 4,000 rows deep costs the
  same as the first.
- **The load test found three real problems and all are fixed** (§4): global search took 3 to 6
  seconds at a million contacts and under load starved the whole API; a list's search box scanned the
  whole table for a word that matched nothing (3.7 s on contacts) and, separately, **searched fields
  the caller may not read**; and exact email lookups, including every duplicate check, read the whole
  table.
- **One API process now sustains about 40 requests per second of mixed traffic comfortably (p95
  125 ms) and about 60 at a p95 near 370 ms**; it queues at 80 and fails past about 65, answering
  `503 SERVICE_BUSY` rather than hanging (§3).
- **A known limitation, by decision: search is fast only on a database where a superuser could mark two
  functions `LEAKPROOF`.** Without that (most managed Postgres) a rare or misspelled word is slow. It is
  bounded by a two-second limit so it cannot take the API down, and the planned remedy is another
  engine behind the same seam, not more database privileges (§5).

## 2. One request at a time

p95 in milliseconds. "Everything" is a user who sees all records; "a rep" sees their own, about 2% of
the company. Bold is over budget. The 250k column is the same code on a quarter of the data, to show
how each path scales; its search and `q` rows are from before the changes in §4.

| Path                                         | Budget p95 | 250k p95 | **1M p95, everything** | 1M p95, a rep (own records) | 1M p50, everything |
| -------------------------------------------- | ---------: | -------: | ---------------------: | --------------------------: | -----------------: |
| contacts: first page, newest first           |        200 |     61.1 |                   74.1 |                        49.9 |               46.7 |
| contacts: a page 4,000 rows deep (keyset)    |        200 |     72.4 |                   59.6 |                        92.9 |               36.3 |
| contacts: sorted by surname                  |        200 |     59.6 |                   79.5 |                        49.6 |               49.8 |
| contacts: filter surname starts with         |        200 |       50 |                   50.9 |                        70.6 |               37.1 |
| contacts: filter by email (duplicate lookup) |        200 |     41.4 |                   45.6 |                          43 |               32.7 |
| contacts: free-text q=surname                |        200 |     53.9 |                  149.2 |                       171.3 |                113 |
| contacts: q matches nothing (worst case)     |        200 |    801.6 |                   89.2 |                          67 |               61.3 |
| leads: q matches nothing (worst case)        |        200 |    223.6 |                   85.7 |                        77.2 |               53.7 |
| accounts: q matches nothing (worst case)     |        200 |    130.9 |                   89.2 |                        71.4 |               61.8 |
| contact: one record                          |        200 |     41.4 |                   71.5 |                        47.6 |               46.6 |
| accounts: first page                         |        200 |     58.2 |                     68 |                        46.7 |               40.2 |
| accounts: sorted by name                     |        200 |     61.8 |                   63.2 |                        47.2 |               38.5 |
| account: one record                          |        200 |     47.7 |                   74.5 |                        49.3 |                 51 |
| leads: first page                            |        200 |     45.2 |                   57.5 |                          55 |               37.9 |
| leads: filter status=new                     |        200 |     62.3 |                   62.3 |                        59.2 |               42.3 |
| deals: first page                            |        200 |     62.1 |                   73.9 |                        49.9 |               42.7 |
| deal: one record                             |        200 |     54.8 |                   49.1 |                        45.7 |               31.8 |
| deals: pipeline board                        |        200 |     72.6 |                  123.2 |                        60.9 |               98.5 |
| activities: my open tasks                    |        200 |     79.6 |                     65 |                        54.5 |               45.5 |
| activities: on one contact                   |        200 |     62.2 |                   67.3 |                        49.5 |               40.5 |
| my day                                       |        200 |    108.8 |                  123.2 |                        74.7 |               87.4 |
| dashboard: pipeline                          |        200 |     73.5 |                    102 |                        53.2 |               80.5 |
| dashboard: won this month                    |        200 |       68 |                   66.1 |                        48.2 |               44.2 |
| dashboard: leads by source                   |        200 |      129 |                  157.1 |                        56.3 |              137.3 |
| dashboard: overdue tasks                     |        200 |    122.5 |                  147.2 |                        55.6 |              110.8 |
| dashboard: leaderboard                       |        200 |    110.3 |                   60.3 |                        59.3 |               45.2 |
| audit log: first page                        |        200 |     60.6 |                   49.8 |               not permitted |                 32 |
| audit log: one record’s history              |        200 |     84.2 |                  126.6 |               not permitted |              107.5 |
| search: a common surname                     |        300 |      198 |                  105.8 |                       151.8 |               78.7 |
| search: full name                            |        300 |    279.1 |                   82.6 |                       178.6 |               68.5 |
| search: a rare term                          |        300 |      256 |              **307.6** |                         148 |               91.9 |
| search: a typo (fuzzy)                       |        300 |    222.2 |              **304.2** |                       124.8 |              164.1 |
| notifications: unread count                  |        200 |     49.9 |                   45.8 |                        41.4 |               30.9 |

Reading it: the paths that read an index by key (first page, deep page, sort, filter, one record) are
flat from 250k to a million. The ones that grow are those that aggregate or filter a large share of the
data: the pipeline board, the audit history of one record, overdue tasks and leads by source, the
slowest at 123 to 157 ms. They count a large share of the table in one pass, so they will keep growing;
a cached or incrementally maintained count is the usual fix and has not been built. The
search rows over budget are the palette's rare-term and typo paths at p95 of about 305 ms against 300,
which is at the budget given the variance in §6.

## 3. Many requests at once

An open loop: requests are issued on a schedule whether or not the last one has answered, which is how
a crowd behaves, so a queue can build. Mixed traffic, weighted towards lists and records (40% first
pages, 20% single records, 10% search, 8% sorted or filtered lists, 8% dashboards, 8% notifications, 6%
activities). One API process (pool of 10 connections), one Postgres container, the load generator on
the same machine.

| Offered load |   Served | Errors | In flight (peak) |       p50 |        p95 |        p99 |
| -----------: | -------: | -----: | ---------------: | --------: | ---------: | ---------: |
|     20 req/s | 20 req/s |      0 |                6 |   50.8 ms |   168.8 ms |   310.8 ms |
|     30 req/s | 30 req/s |      0 |               14 |   55.3 ms |   170.4 ms |   421.7 ms |
|     40 req/s | 40 req/s |      0 |                7 |   48.9 ms |   124.6 ms |   183.6 ms |
|     50 req/s | 50 req/s |      0 |               25 |   80.2 ms |   341.8 ms |   545.8 ms |
|     60 req/s | 60 req/s |      0 |               29 |   84.3 ms |   366.8 ms |   471.6 ms |
|     80 req/s | 67 req/s |      0 |              479 | 4722.5 ms |  6043.7 ms |  6165.8 ms |
|    100 req/s | 66 req/s |    394 |              951 | 8718.6 ms | 10082.2 ms | 10190.2 ms |

- **About 40 requests/s is comfortable for one process here** (p95 125 ms), roughly 120 to 200 active
  people. It holds 60 with a p95 near 370 ms. At 80 it queues (a request waits seconds); at 100 it
  fails, and every failure is a connection-pool timeout, reported as `503 SERVICE_BUSY` with
  `Retry-After: 2` instead of a generic 500.
- **These numbers are higher than the first run's** (which degraded at 40) because the full-table scans
  of §5 were what saturated the database: removing them moved the ceiling from about 40 to about 65.
- A closed loop of 20 clients with no think time (the other mode of the runner) puts every path at
  160 to 300 ms, even a trivial count: a throughput ceiling of about 100 requests/s for cheap
  endpoints, with the API process and Postgres each using about one core. The per-request fixed cost
  behind it (about 10 ms of API CPU and 10 ms of Postgres CPU for a trivial endpoint) has **not** been
  investigated and is the next thing to look at for capacity.
- Scaling is by instances behind the proxy. Rate limits are shared through Redis (§8).

## 4. What the load test found, and what changed

### 4.1 A list's search box searched fields the caller may not read (security)

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
if a future Postgres makes `citext` equality leakproof the workaround can be retired. This fix needs no
superuser, which is why it was chosen over marking `citext_eq` leakproof.

### 4.3 Global search (the command palette)

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
| search: a common surname |          3117.3 ms |          105.8 ms |     3134.9 ms |     151.8 ms |
| search: full name        |          2705.3 ms |           82.6 ms |     6082.1 ms |     178.6 ms |
| search: a rare term      |          3187.2 ms |          307.6 ms |     2065.2 ms |       148 ms |
| search: a typo (fuzzy)   |          3319.8 ms |          304.2 ms |     5795.6 ms |     124.8 ms |

### 4.4 A list's search box now goes through the search seam

`GET /contacts?q=…` (and accounts, leads, deals, and an export's search) used to run
`ILIKE '%term%'` over a few columns of the table. For a word that matches something it stopped early; for
a word that matches **nothing**, which is what a typo is, it read the whole table. It cannot be indexed
through the application role (`texticlike` is not leakproof, the same rule as §4.2), and marking it so
needs a superuser. The user decided not to require one, and to route the search box through the search
index instead. It now asks the `SearchProvider` which records match (as ids), and the list applies its
own sort, filters, record scope and paging to them, so it works with whichever engine is behind the seam.

p95, one request at a time, 1M contacts:

| List search                              | Everything, before | Everything, after | A rep, before | A rep, after |
| ---------------------------------------- | -----------------: | ----------------: | ------------: | -----------: |
| contacts: free-text q=surname            |            92.6 ms |          149.2 ms |        449 ms |     171.3 ms |
| contacts: q matches nothing (worst case) |          3701.3 ms |           89.2 ms |      683.6 ms |        67 ms |
| leads: q matches nothing (worst case)    |             843 ms |           85.7 ms |       92.7 ms |      77.2 ms |
| accounts: q matches nothing (worst case) |           397.3 ms |           89.2 ms |         68 ms |      71.4 ms |

What it means for the person typing (ADR-0041 §5): words are matched **by their start**, every word must
match, results are the most recently updated first, and a list shows at most the 300 most recent matches
(with a note saying so). `deep` finds Deepak but `eep` no longer does; when nothing matches exactly, a
near match for the longest word is tried, so most typos still find the record. The cost of the box is
now bounded by the cap, not by how much of the table a word appears in.

### 4.5 Overload now says so

Past the pool's capacity the API answered a generic 500 and logged a stack trace per request. Overload is
not an unexpected failure: it is now `503 SERVICE_BUSY` with `Retry-After: 2` and one warning line, so a
client waits instead of reporting an error.

## 5. The known limitation: search without a superuser

Search is fast only where two functions (`ts_match_vq`, `word_similarity_op`) are marked `LEAKPROOF`, which
needs a superuser (ADR-0028 §7). Most managed Postgres services do not give you one, and the user has
decided that must not be required: the bootstrap script now **warns and continues** when it cannot, and
the remedy for a company that outgrows it is to move search to an engine behind the seam (Meilisearch is
the planned one), not to ask for more database privilege. What that costs today, at a million contacts,
with the marks removed (p95, one request at a time):

| Path                                                       | With the marks | Without, before the time limit |                       Without, now |
| ---------------------------------------------------------- | -------------: | -----------------------------: | ---------------------------------: |
| List search, a word that matches nothing (contacts)        |          89 ms |                  **28,754 ms** | stops at 2 s: `503 SEARCH_TIMEOUT` |
| List search, a word that matches nothing (leads, accounts) |      86, 89 ms |             2,775 and 1,493 ms |                          2 s limit |
| List search, a rep, a word that matches nothing            |    67 to 77 ms |                940 to 1,520 ms |                    under the limit |
| Palette: a rare term                                       |         308 ms |                       2,244 ms |                          2 s limit |
| Palette: a typo                                            |         304 ms |                   **8,297 ms** |                          2 s limit |
| Palette or list: a common word                             |  106 to 149 ms |                  154 to 165 ms |                          unchanged |

So **without the marks, a common word is fine and a word that matches little is not**, which is exactly
what a typo is. Because a single such search would hold a database connection for up to half a minute, and
a few at once would leave the API with none, **every search statement now runs under a two-second limit**
(`DEFAULT_SEARCH_TIMEOUT_MS`), inside a savepoint so the request's transaction survives, and past it the
answer is `503 SEARCH_TIMEOUT` ("That search is too broad to answer quickly. Try a more specific
search.") rather than a wait. The web client does not retry it and offers to clear the search. This is a
bound on harm, not a fix: on such a database a mistyped search returns an error after two seconds.

## 6. How this was measured, and how far to trust it

- **Hardware:** one Windows laptop, 12 logical CPUs. Postgres 16.6 in Docker with 3.7 GB for the VM,
  default `shared_buffers` (128 MB), against a 4.7 GB database: part of every large read comes from
  disk, which is pessimistic for a production instance with enough RAM.
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
Its closing `VACUUM` runs without parallel workers because a container's default 64 MB of shared memory
cannot hold a parallel vacuum of the large tables.

## 7. Known gaps

- Sharing rate limits through Redis costs a little per request, and its effect on the tail under load was not
  resolved on this machine (§8).
- The per-request fixed cost (§3) is uninvestigated.
- Without a superuser, search on a very large company is slow and bounded, not fast (§5).
- A list's search shows at most the 300 most recently updated matches, and an export of a search refuses
  more than 5,000; a broad word is narrowed by typing more, or by a filter.
- The aggregating dashboards (leads by source 157 ms, overdue tasks 147 ms) grow with the data and have
  no cache; they are the first reads to cross 200 ms as a company grows past a million records.
- Writes, imports, exports, many tenants and a browser are unmeasured.

## 8. What sharing rate limits costs (ADR-0050)

Every request now makes one or two Redis calls (the address, and for a signed-in request the user and tenant
together). The same traffic was run against the 1M-contact database with the counters in the API process and with
them in Redis (the compose Redis, on the same laptop, so a round trip is a loopback hop into Docker).

**One request at a time** (contact: one record, p50): in the process 25.2 and 26.5 ms, Redis 28.1 and 28.5 ms. The
other paths overlap within noise. That is **about 2 to 3 ms per request**, which is two round trips.

**Under open-loop load**, all traffic, p50 / p95 / p99 in ms:

| Rate     | Pass | In the process                 | In Redis                       |
| -------- | ---- | ------------------------------ | ------------------------------ |
| 20 req/s | 1    | 64 / 310 / 754                 | 83 / 3,204 / 4,747 (10 errors) |
| 20 req/s | 2    | 73 / 1,056 / 1,368 (12 errors) | 50 / 144 / 381 (9 errors)      |
| 30 req/s | 1    | 54 / 342 / 862                 | 56 / 304 / 520 (3 errors)      |
| 30 req/s | 2    | 48 / 154 / 286 (6 errors)      | 48 / 134 / 196 (1 error)       |
| 40 req/s | 1    | 49 / 169 / 355                 | 56 / 310 / 562                 |
| 40 req/s | 2    | 50 / 175 / 346                 | 53 / 230 / 466                 |

**How to read it, honestly.** The p50 moves by a few milliseconds, as the one-at-a-time figure says. The tails do not
give an answer: at 20 and 30 req/s the in-process runs alone ranged from a p95 of 154 ms to 1,056 ms, as
sessions sharing this machine started and stopped heavy work, and the Redis runs ranged from 134 ms to 3,204 ms. At
40 req/s, where nothing else was disturbing it, both Redis passes were worse than both in-process passes (p95 230 to
310 ms against 169 to 175 ms), which is what a small fixed cost per request looks like close to the API's ceiling. The
errors in the lower-rate runs are the two-second search limit (§5) firing on a cold cache and a busy machine, in both
modes. **What this supports:** a cost of about 2 to 3 ms per request, and a likely loss of some of the ceiling near
40 req/s. **What it does not:** a figure for either, on a quiet machine or on separate hosts.

**If it matters.** The easy saving is one round trip instead of two: the address count is made before the session is
known, so it is a separate call; counting it in the same call as the user and tenant would need the check deferred
into the guard for signed-in requests. Not done, because the cost has not been shown to need it. Re-measure on
hardware that is doing nothing else before deciding.
