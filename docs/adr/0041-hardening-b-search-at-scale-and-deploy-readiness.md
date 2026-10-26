# ADR-0041: Hardening B — what the load test found, search through one seam, and what production refuses to run with

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

Week 6 of the build plan (MVP_SPEC §11) asks for a load test at a million records, a restore drill,
deploy readiness and an accessibility pass. The load test was the one that mattered: it found a
security hole, a silent full-table scan on the hottest lookup in the product, a search that took seconds
and starved the API, and a list search box that read the whole table. This ADR records those findings,
the decisions that fixed them, two decisions the product owner made on the way, and the smaller
deploy-readiness decisions that went in alongside.

Method and numbers are in `docs/PERF.md`; operations are in `docs/RUNBOOK.md`; the accessibility pass is
in `docs/ACCESSIBILITY.md`. The data was one company of 1,000,000 contacts (and 5.6 million search
rows) on one laptop, read through the real API. It says what scales and what does not; it is not a
production capacity plan.

## Decision

### 1. The product does not require a superuser, and says what that costs

ADR-0028 §7 marks two functions (`ts_match_vq`, `word_similarity_op`) `LEAKPROOF`, which only a
superuser can do, because without it Postgres cannot use an index under row-level security. That made a
superuser a requirement, and most managed Postgres services do not give one. **The owner decided
managed hosting must stay open**, and that the remedy for a company that outgrows it is a different
engine behind `SearchProvider`, not more database privilege.

So the bootstrap script's two statements are wrapped: a missing privilege is a warning, not a failed
bootstrap (`bootstrap.nonsuperuser.spec.ts` runs that very block as a role that is not a superuser and
demands it neither throws nor changes the marks). What this costs, measured at a million contacts
without the marks: a common word is unaffected; a word that matches little is slow (28 s for a list's
search box, 8 s for the palette's typo path). Because one such search would hold a database connection for
that long, and a few at once would leave the API with none, **every search statement runs under a
two-second limit** (`withSearchTimeout`), inside a savepoint (so the request's transaction, which
holds the tenant for RLS, survives) with the previous limit restored. Past it the answer is
`503 SEARCH_TIMEOUT`, "that search is too broad, try a more specific one", which the web client does not
retry and which offers to clear the search. This is a bound on harm, not a fix: on such a database a
mistyped search returns an error after two seconds.

### 2. The seam is real: a conformance suite, and nothing reaches search except through it

CLAUDE.md §2 says Postgres search sits behind a `SearchProvider` so Meilisearch can replace it. Until now
that was a promise with one implementation, so the interface meant whatever Postgres did. Three things
make it checkable:

- **A conformance suite** (`packages/core/src/search/provider-contract.ts`, exported as
  `@crm/core/search-contract`), vendor-neutral and run today by
  `packages/db/src/search/provider.contract.spec.ts`. Sixteen behaviours: a word matches by its start and
  case-insensitively; indexing is idempotent and replaces; remove and clear forget (clear only the one
  tenant); tenant isolation; record scope; field permissions (a hidden field is neither searchable nor
  quoted); every word must match, in different fields; newest first; limit and an honest `truncated`; one
  object type at a time; a typed email address and a phone number's digits find the record; hostile input
  answers with nothing instead of throwing. A second provider is acceptable when it passes the same suite
  with its own harness (which has a `settle` hook for an eventually consistent engine).
- **`matchRecordIds`**, added to the interface (§5), so a list and an export reach search the same way
  the palette does.
- **The provider is provided by the platform module** (`SEARCH_PROVIDER`, `platform/search/`), not the
  search module, because the five record modules now use it and the search module depends on them: a
  provider in the search module would have made a cycle. Swapping the engine is one line there.

What the seam does not settle, and a new engine must decide: how it isolates tenants without a shared
transaction (ADR-0028 §6), how it keeps a record's owner fresh on reassignment, and how it indexes
asynchronously.

### 3. Free-text `q` only searches fields the caller may read (security)

`sort` and `filter` refuse a field the caller may not read, because comparing or ordering by a hidden
column reads it a character at a time (`common/field-queries.ts` says so). `q` matched first name, last
name, email and phone on contacts, leads and accounts (and name or subject on deals and activities, and
the same in exports) whatever the caller could see, so `q=@gmail` answered as a list of rows was the same
leak by another door. It was found by reading the SQL while looking for why `q` was slow. Fixed in all five
lists and in exports: the searchable fields come from one list in `@crm/core`
(`searchableFieldKeys`) intersected with `canReadField`, and a caller who may read none is told there
are no matches. `apps/api/src/common/search-fields.security.spec.ts` covers each object, with an
administrator as the control (so "found nothing" cannot mean "the search is broken for everyone"); with
the leak put back, all seven tests fail.

### 4. Search that costs what it returns, not what it matches

At a million contacts a surname shared by one record in sixty matches 67,000 index rows; fetching and
ranking them took 3 to 6 seconds, and a sales rep, who sees about 2% of the company, paid the same
because their owner restriction was applied after the fetch. Migration 0021 and `search/postgres.ts`:

- **Only the newest `SEARCH_CANDIDATE_CAP` (600) matching index rows are ranked**, read from a new index
  in `record_updated_at` order (`search_documents_recent_idx`). A term with fewer matches is unchanged and
  still uses the full-text index. **A behaviour change, and a trade:** for a broad term the results are the
  best of the most recently updated matches, so an older match of a higher-weighted field can lose to a newer
  match of a lower-weighted one. For a broad term nearly all matches rank alike, so "the best ten" was
  already "the ten most recent of the best weight"; typing more narrows it, which is what a palette is for.
  The cap applies after the visibility predicate, so it counts only rows the caller may see.
- **The two GIN indexes lead with `(tenant_id, owner_id)`** and a rep's own-scope predicate is also stated
  at the top level of the query (only a top-level condition can become an index condition), so a rep's
  search reads the rep's rows. The new indexes are no larger than the old (213 MB against 214 MB;
  156 MB against 194 MB).
- Result, 1M contacts, p95: a common surname 3,117 to 106 ms for everyone and 3,135 to 152 ms for a rep.

### 5. A list's search box and an export's search go through the seam

`GET /contacts?q=…` and its siblings ran `ILIKE '%term%'` over a few columns. For a word that matches
nothing, which is what a typo is, that read the whole table (3.7 s on contacts, 0.8 s on leads, 0.4 s on
accounts at a million); `texticlike` is not leakproof, so no index could ever answer it through the
application role, and marking it so needs the superuser §1 declines to require. **The owner chose to route
it through the search index and accepted the semantic change.**

The list now asks `SearchProvider.matchRecordIds` for the ids of this object's records that match, and
applies its own sort, filters, record scope and paging to them (`id in (…)`). Doing it as ids rather than
as a join is what keeps it working with any engine: a join between a list's table and an index exists only
while the index is in the same database. The meaning (written in `RecordMatchRequest` and checked by the
suite):

- **Every word must match, and each word matches by its start**, in any field the caller may read. `john
smith` finds the record with `john` in the first name and `smith` in the last. **`ndeep` no longer
  finds `Sandeep`**: substring matching is gone. (The index translates `@ . _ / + -` to spaces, so a typed
  email address matches word by word and a phone number matches by its digits, country code included.)
- **When nothing matches exactly, a near match for the longest word is tried**, so most typos still find
  the record, and a local ten-digit number finds `+91…`. It is never tried when something matches.
- **Newest first, at most 300**, `meta.truncated: true` when there were more, shown as a note under the
  list. A word too short to search (one character) narrows nothing, rather than emptying the list on the
  first keystroke. A search that cannot be answered in two seconds is `503 SEARCH_TIMEOUT` (§1).
- **An export of a searched view** uses the same call with a limit of 5,000, is **refused** when the
  search matches more ("narrow it with filters, then export again"), and is therefore exactly the rows the
  list shows (the parity test runs both).

Checked for anything that promised substring matching: no spec line, ADR or UI copy did; the one test
that depended on it (a multi-word `q` in `deals.spec.ts`) was rewritten for the new meaning, and gained a
test that documents the change. The placeholder copy ("Name, email or phone") is still true.

Result at a million contacts, p95: a word that matches nothing, contacts 3,701 to 89 ms, leads 843 to 86,
accounts 397 to 89; a rep 684 to 67 ms. A word that matches a lot costs a little more than it did (93 to
149 ms) and is bounded.

### 6. Exact email lookups use a text index, guarded by a CHECK

`WHERE email = 'x'` read every contact a company has (161 ms at 250k, linear) although
`contacts_tenant_email_idx` existed. `email` is `citext`, whose equality function is not leakproof, so
under RLS it cannot be an index condition; the index was maintained on every write and read by nobody.
This affected every duplicate check on create, lead conversion, the import matcher and the list's email
filter. Migration 0020 adds `(tenant_id, (email::text))` partial indexes on contacts and leads, a CHECK
that the column holds only lower case (`NOT VALID` then `VALIDATE`, safe on a large table) and drops the
two dead indexes; the lookups compare `email::text = lower($1)`. The contracts have always lower-cased an
email on the way in, so this makes true of every writer what was true of the product. Marking `citext_eq`
leakproof was the alternative and was rejected for needing a superuser. A canary test records why, so that
if Postgres makes citext equality leakproof the workaround can be retired. 161 ms became 41 ms.

### 7. Overload says so

Past the pool's capacity the API answered a generic 500 and logged a stack trace per request. A pool
timeout is now `503 SERVICE_BUSY` with `Retry-After: 2` and one warning line, so a client waits rather
than reports an error. It does not stop one slow endpoint using the pool (the search limit in §1 does that
for search).

### 8. Production refuses to start with development values

`packages/core/src/config/production.ts`, called by the API and the worker before they listen, in
production only. It reports every problem at once, naming the variable and never the value: `AUTH_SECRET`
unset, short, low in distinct characters or placeholder-like; `console` or `memory` email, or a sender on
`localhost`; memory storage, missing S3 keys, a plain-http or local public storage endpoint; `WEB_URL`,
`API_URL` and CORS origins that are not https origins of a real host (or are `*`); a database URL that
uses the superuser, has no password or a development one, or points at this machine. It warns (and does
not refuse) when `REDIS_URL` is unset, because rate limits are then per process. The worker is not asked
for what only the API has. The web app is not checked, because the end-to-end suite runs a production
build of it against a local API, and a check it would fail is a check it would have to be exempted
from.

### 9. Email is sent through Resend's REST API, with no SDK

`ResendEmailProvider` in `@crm/outbound` (ADR-0040): one POST through the guarded client, pinned to
`api.resend.com` over https on 443, so a mis-set URL cannot send the API key to another host and the
client will not carry an `Authorization` header across a redirect. Failures are a status and Resend's own
error name, classified retryable (408, 409, 429, 5xx, timeout, DNS, network) or not; nothing is logged
that could carry a recipient, a subject, a token or the key (a hostile or confused response that echoes
the request is tested). There is no idempotency key, so a retry after an ambiguous failure can send a
message twice.

### 10. Deploy artifacts, and the restore drill

`deploy/Dockerfile` (targets `api`, `worker`, `web`, `migrate`; one shared build stage; runtime as the
unprivileged user, production dependencies only, a health check), `docker-compose.prod.example.yml` (one
host; Postgres, Redis and the object store are managed services and are not in it),
`Caddyfile.example`, `production.env.example`, `.dockerignore`, and a `.gitignore` rule for
`deploy/*.env` (the filled-in file would otherwise have been committable).

`deploy/backup-drill.sh` dumps, restores into a new database and checks what a restore can silently
lose: counts and checksums of every record table; RLS enabled **and forced** on every tenant table; the
same policies, grants, indexes, triggers and constraints; no role with `BYPASSRLS`; the application role
seeing its own tenant, none of another's and none with no tenant set; the migration version; the LEAKPROOF
marks, when the source has them; and then the real API on the restored database, signing in with an
original password. At a million contacts (4.7 GB): dump 73 s, restore 247 s, `ANALYZE` 22 s, API up in
10 s, about six minutes. It found three things now in the procedure: a dump does not carry the LEAKPROOF
marks (the bootstrap script does); a restore has no planner statistics until `ANALYZE`; and its own wait
for the API once misread a healthy API as down for seven minutes because a Windows shell setting broke
`curl`. The RPO is not demonstrated by a logical dump; it depends on the provider's continuous archiving.

### 11. `pnpm db:reindex`

The code and docs said the search index could be rebuilt with `pnpm db:reindex`, and the command did not
exist. It does now (`search/reindex-all.ts`): it lists companies as `crm_auth` (the worker role sees only
its own tenant under RLS) and rebuilds each as `crm_worker`, one transaction per company, so one company's
failure leaves every other's index as it was. One transaction per company is also its limit: at a million
contacts it is minutes and a long-held transaction, to be run off-peak.

### 12. Accessibility

`apps/web/e2e/accessibility.spec.ts`, no new dependency: names, landmarks, headings, title and language,
focus order and visible focus, and text contrast computed from painted colours, on twelve screens in light
and dark mode, with self-tests that plant known violations and demand they are caught. It found one
defect (the audit log had no `h1`), fixed. It is a floor: no screen reader or person has used the
product. `docs/ACCESSIBILITY.md` lists what must be done by hand. A scanner (`@axe-core/playwright`) was
not added without asking.

## Consequences

- **Search behaves differently in lists**: by word start, newest first, capped at 300. People who typed
  the middle of a name will notice. The footer says when a list is capped.
- **A database without the LEAKPROOF marks has slow rare-word searches, bounded at two seconds**, and the
  whole fix for a company that outgrows it is another engine, which is now a defined piece of work rather
  than a rewrite.
- **A very common word finds the most recently updated records first** rather than the best. Acceptable
  for a palette; for a list it is the same set, newest first.
- **The migrations (0020, 0021) take locks while building indexes** (the runner wraps each file in one
  transaction). Fine while tables are small; on a large live table they must be built `CONCURRENTLY` outside
  the runner (RUNBOOK §3). Measured: 0021 on 5.6 million rows took 2.5 minutes.
- **The list `q` and the palette now share one engine's behaviour**, which is a simplification, and one
  failure mode: an index that is stale (a reassignment not yet processed) is visible in the list as well.
  ADR-0028 §5 describes the window.
- **Capacity**: one API process sustains about 40 requests/s of mixed traffic comfortably (p95 125 ms),
  60 at a p95 near 370 ms, and fails past about 65; the per-request fixed cost behind that ceiling is not
  investigated. Rate limits are still per process.

## Alternatives considered

- **Mark `texticlike` and `citext_eq` leakproof too** (extend ADR-0028 §7). It is the smallest change and
  keeps substring matching. It also needs a superuser, which the owner declined to require, and widens a
  deliberate weakening of a Postgres safety default.
- **Join the list's table to `search_documents` in SQL** for `q`. Faster to write and not swappable: it
  only exists while the index is in the same database.
- **A trigram index on the list's columns.** Cannot be used under RLS for the same reason, and ILIKE
  across four columns needs one expression and a rewritten predicate.
- **Cap the search results with a timeout alone**, with no candidate cap. A timeout turns a slow search
  into an error; the cap makes the common slow search fast. Both are used, for different failures.
- **Retry the search on timeout.** A search that timed out will time out again and each attempt holds a
  connection for the whole limit.
- **Fail the bootstrap without a superuser** (the previous behaviour). It would have made most managed
  databases unusable.
- **A database-wide statement timeout** instead of one scoped to search. It would cut off imports,
  exports and migrations, which legitimately run long.
- **Add `@axe-core/playwright` now.** It would add a dependency without asking (CLAUDE.md §11.4); the
  hand-rolled checks were enough to find what a first pass finds, and the scanner remains an offer.
