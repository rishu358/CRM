# Runbook

How to deploy, operate, back up and recover the CRM. Written for the person on call, so it is
procedures first and reasons second. The reasons are in the ADRs it links.

> **Status:** drafted from a rehearsal on a development machine, not from a production incident.
> Every command here was run; the numbers were measured (see [PERF.md](PERF.md)). Nothing has been
> deployed, and no pilot has used it. Treat the first real deployment as a second drill and correct
> this document where it is wrong.

## 0. Choosing a database: what a superuser buys

**The product runs on any Postgres 16 you can create roles and extensions in. It does not require a
superuser** (a decision, ADR-0041 §1). A superuser buys one thing, and it matters only for large
companies.

Global search and a list's search box rely on two functions being marked `LEAKPROOF`
(`ts_match_vq`, `word_similarity_op`; ADR-0028 §7), which only a superuser can do. The bootstrap script
(`packages/db/sql/bootstrap/01-extensions-and-roles.sql`) tries, and if it may not it prints a warning
and carries on. With the marks, search is fast. Without them it is fast for a common word and slow for a
word that matches little, which is what a typo is. Measured at a million contacts (PERF.md §5):

| Search                                 | With the marks |                                                Without |
| -------------------------------------- | -------------: | -----------------------------------------------------: |
| A common word (list or palette)        |  0.1 to 0.15 s |                                         0.15 to 0.17 s |
| A word that matches nothing, in a list |         0.09 s | 29 s, **now stopped at 2 s** with `503 SEARCH_TIMEOUT` |
| A rare term or a typo, in the palette  |          0.3 s |                   2.2 to 8.3 s, **now stopped at 2 s** |

**Why that is tolerable:** every search statement runs under a two-second limit (inside a savepoint, so
the request survives), and past it the answer is a clear "that search is too broad, try a more specific
one", not a connection held for half a minute. So on a database without the marks, a mistyped search
returns an error after two seconds; nothing else is affected. How many companies reach the size where
that is common has not been measured: at a million contacts it is every miss, at fifty thousand it is not
noticeable (the plan reads a tenth of the index).

**What to do about it, in order:**

1. **Do nothing** while companies are small. Check the marks only if someone reports slow searches:
   `select proname, proleakproof from pg_proc where proname in ('ts_match_vq', 'word_similarity_op')`.
2. **If your provider lets a superuser (or an equivalent) run it**, run the two statements from the
   bootstrap script and the problem goes away. Ask the provider by name: "can a customer run
   `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF`?". I have not verified that any of the usual
   managed services (RDS, Aurora, Cloud SQL, Azure Database, Supabase, Neon) does or does not.
3. **The planned remedy is another engine behind `SearchProvider`**, Meilisearch being the one named in
   CLAUDE.md §2. That is a build, not a configuration change, but it is a bounded one, because the
   seam is real rather than nominal:
   - the interface is `packages/core/src/search/index.ts` (`search`, `matchRecordIds`, `index`, `remove`,
     `clear`) and carries no SQL, tsquery or index name;
   - **a provider is acceptable when it passes `describeSearchProviderContract`**
     (`packages/core/src/search/provider-contract.ts`, 16 behaviours: word-prefix matching, every word
     must match, newest first, limits and truncation, tenant isolation, record scope, field permissions,
     removal, idempotent indexing, hostile input). `packages/db/src/search/provider.contract.spec.ts` is
     the template: hand the same suite your own harness;
   - the five record modules, the exports and the palette all reach search only through
     `SEARCH_PROVIDER` (`apps/api/src/platform/search/search.tokens.ts`, provided in
     `platform.module.ts`); swapping the engine is that one line, plus the worker's handlers, which
     already take a `SearchProvider`;
   - `pnpm db:reindex` rebuilds any engine's index from the records through the same interface;
   - what a new engine must still decide: tenant isolation without a shared transaction (ADR-0028 §6:
     it ignores the handle and must enforce `tenantId` itself), eventual consistency (the harness has a
     `settle` hook), and how it keeps `ownerId` fresh when a record is reassigned.

Nothing else in the product needs a superuser. The migrations run as `crm_migrator`, which is not one.
Creating the roles needs the ability to create roles (on a managed service, its administrative role).

## 1. What runs where

| Piece           | Image target    | Needs                                                                       |
| --------------- | --------------- | --------------------------------------------------------------------------- |
| API             | `api`           | Postgres (`crm_app`, `crm_auth`), the object store, Resend, Redis (§4.1)    |
| Worker          | `worker`        | Postgres (`crm_worker`, optionally `crm_erasure`), the object store, Resend |
| Web             | `web`           | The API (private network) and nothing else                                  |
| Migrations      | `migrate`       | Postgres as `crm_migrator`. A one-shot job, not a service                   |
| TLS and routing | Caddy (example) | Ports 80 and 443                                                            |

Postgres 16, Redis and the object store are **managed services**, not containers in the compose file
(CLAUDE.md §2). `deploy/docker-compose.prod.example.yml` shows one host's layout and is an example to
copy, not something to run unchanged.

The API and the worker **refuse to start** in production with a development value (a default or
placeholder `AUTH_SECRET`, `console` or `memory` email, memory storage, `http` or `localhost` URLs, the
database superuser, a development password) and print the name of each variable that is wrong, never
its value. If one will not start, read its log first: the answer is in it. The rules are
`packages/core/src/config/production.ts`; ADR-0041 §6 says why each exists.

## 2. First deployment

1. **Provision** Postgres 16 (see §0), an S3-compatible bucket (private, no public ACLs), a Resend
   account with the sending domain verified (SPF and DKIM, or mail is not delivered), and DNS for the
   app and API hosts.
2. **Create the roles and extensions**, once, as a role that may create them (a superuser, or a managed
   service's administrative role), with real passwords:
   `packages/db/sql/bootstrap/01-extensions-and-roles.sql`. The file creates the five roles
   (`crm_migrator`, `crm_app`, `crm_auth`, `crm_worker`, `crm_erasure`) with **development**
   passwords: copy it, replace each password with a generated one, and run the copy. Never run the
   file as it is against anything but a laptop. None of the roles has `BYPASSRLS` or owns a table.
3. **Build the images** (`docker build -f deploy/Dockerfile --target <api|worker|web|migrate> .`),
   tag them with the release, and push them to your registry.
4. **Fill in the environment**: copy `deploy/production.env.example` to `deploy/production.env` (git
   ignores it) and set every value. Generate `AUTH_SECRET` with `openssl rand -base64 48`.
5. **Migrate**: `docker compose … --profile ops run --rm migrate`. It prints the migrations it applied.
6. **Start**: `docker compose … up -d`. The API reports healthy at `/api/v1/health`.
7. **Check it**: sign up, confirm the verification email arrives, sign in, create a contact, upload
   an attachment, run an export. If email does not arrive, see §6.

## 3. Releasing

1. Merge to the release branch only with CI green: lint, typecheck, format, `pnpm openapi:check`,
   unit tests, `pnpm test:security`, Playwright.
2. Build and tag all four images from the same commit.
3. **Migrate first**, then deploy the API and worker, then the web. Migrations are forward-only and
   additive (CLAUDE.md §7), so the previous API keeps working against the new schema for as long as
   the rollout takes. A migration that cannot be run that way is not ready to ship.
4. Large tables: a migration that builds an index on a table holding millions of rows must be built
   outside the migration runner, `CONCURRENTLY`, as migration 0016 describes. The runner wraps each
   file in a transaction, which blocks writes for the length of the build. Measured on this machine:
   0021 (two GIN indexes and one btree on 5.6 million rows) took 2.5 minutes.
5. Watch the API's error rate and the `SERVICE_BUSY` (503) count for ten minutes.

### Rolling back

There is no down-migration. To roll back **code**, redeploy the previous images: the schema is
compatible by construction (step 3). To roll back **data**, restore a backup (§5); that loses what was
written since it. If a migration itself was wrong, fix it forward with a new migration, never by
editing one that has been applied.

## 4. Capacity and what overload looks like

Measured on one laptop (API and Postgres in Docker sharing 12 cores; the load generator on the same
machine), against 1,000,000 contacts in one company, 5.6 million search rows and 1,000,000 audit rows
(full numbers in [PERF.md](PERF.md)):

- **One API process sustains about 40 requests/s of mixed traffic comfortably** (p95 125 ms), roughly
  120 to 200 active people, and holds 60 at a p95 near 370 ms. At 80 it queues (a request waits
  seconds); at 100 it fails.
- **When it collapses it answers `503 SERVICE_BUSY` with `Retry-After: 2`**, not a generic 500. The
  cause is the database connection pool (`DATABASE_POOL_MAX`, default 10) running out. The web
  client retries 5xx responses with backoff.
- **Scale out, not up:** run more API instances behind the proxy. Rate limits are counted in Redis,
  so they hold across instances (§4.1). Setting
  `DATABASE_POOL_MAX` higher helps only if Postgres has the connections to give: size the database's
  `max_connections` to instances x pool.
- A single slow endpoint can still consume the pool. Search was the case that did (3 to 31 seconds
  per request at a million contacts); it is now fast where the `LEAKPROOF` marks exist and **capped at
  two seconds per search** where they do not (§0), so a mistyped search cannot hold a connection for
  longer than that. Other endpoints have no such cap.

Alert on: API 5xx rate; `SERVICE_BUSY` count; p95 latency per route; Postgres connections near
`max_connections`; outbox backlog (rows in `outbox_events` with `processed_at` null and a due time in
the past); disk on the database volume.

### 4.1 Rate limits and Redis

Four limits are counted, all in Redis, so each means the same however many API instances run (ADR-0042):

| Limit          | Setting (default)                                | Applies to                                          |
| -------------- | ------------------------------------------------ | --------------------------------------------------- |
| Per user       | `RATE_LIMIT_MAX_PER_USER` (300 per window)       | A signed-in person, from any address                |
| Per tenant     | `RATE_LIMIT_MAX_PER_TENANT` (3,000 per window)   | Everyone in one workspace together                  |
| Per address    | `RATE_LIMIT_MAX_PER_IP` (1,000 per window)       | Everything one address sends, signed in or not      |
| Sign-in routes | `AUTH_RATE_LIMIT_MAX_PER_IP` (50 per 15 minutes) | Sign-in, sign-up, reset and invitation, per address |

The window is `RATE_LIMIT_WINDOW_SECONDS` (60). `/api/v1/health` is not limited. A refused request is a `429` with a
`Retry-After` header; its message says whose budget it is ("this workspace", "you", "this address") and nothing else.

**What the Redis needs.**

- A password and TLS (`rediss://`), on a private network. Production refuses a `REDIS_URL` with no password or on
  this machine, and warns on an unencrypted one.
- **No eviction of counters.** Use `maxmemory-policy noeviction` or a `volatile-*` policy, never `allkeys-*`: an evicted
  counter silently resets a limit. It may be shared with other things (keys are `crm:rl:v1:*`), but not with a cache that
  evicts.
- Very little memory: one small key per active user, workspace and address per window.

**When Redis is down** the API keeps serving and keeps limiting, per process, and logs one warning every 30 seconds
(`Redis is not answering: rate limits are per process until it is`) and one line when it is back (`Redis is answering again`).
While it is down each instance counts alone, so N instances allow up to N times a limit. There is nothing to replay and
nothing to restart: instances reconnect by themselves and the limits are shared again within a few seconds.

**One instance and no Redis.** Production refuses to start without `REDIS_URL`. If exactly one API instance runs and you
accept per-process counting, set `RATE_LIMIT_ALLOW_PER_PROCESS=true`; it starts and warns on every boot. Do not set it
and then add a second instance.

**Someone is being refused and should not be.** The message says which limit it was. Raise the setting and restart the
API, or clear one subject's counter (keys are `crm:rl:v1:user:<user id>`, `…:tenant:<tenant id>`, `…:ip:<address>`,
`…:auth-ip:<address>`):

```bash
redis-cli --scan --pattern 'crm:rl:v1:user:<user id>' | xargs -r redis-cli del
```

## 5. Backups and recovery

**Objectives (MVP_SPEC §9):** RPO 15 minutes, RTO 4 hours.

| Layer         | What protects it                                                                                                                                            | Recovers to                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Postgres      | The provider's continuous archiving and point-in-time recovery, **plus** a daily logical dump (`pg_dump -Fc`) kept in a bucket in another account or region | Any second within the retention window (PITR); the last dump (logical) |
| Object store  | Bucket versioning and a lifecycle rule that keeps previous versions 30 days                                                                                 | A deleted or overwritten file                                          |
| Secrets       | Your secret manager's own history                                                                                                                           | The previous value                                                     |
| Configuration | This repository and the env file's source of truth                                                                                                          | Any release                                                            |

PITR is the provider's feature and is drilled through its console (restore to a new instance at a
chosen time, point a staging stack at it, run the checks below). The logical dump is the one this
repository can rehearse, and it is the one that survives the provider.

### The drill

`deploy/backup-drill.sh` dumps a database, restores it into a new one, and checks the things a restore
can silently lose: row counts and an order-independent checksum of every record table; row-level
security enabled **and forced** on every table with a `tenant_id`; the policies, grants, indexes,
triggers and constraints; that no application role can bypass RLS; that the restored database is at
the repository's migration version; and then boots the real API on it, signs a user in with their
original password, lists records, and checks another tenant's id still answers 404.

```bash
DRILL_API_ENV=/path/to/api.env deploy/backup-drill.sh crm_perf
```

**Run it monthly, and after any change to a role, a grant or a migration that touches security.**
A failing check is a stop-ship for the restore procedure, not a note.

**Measured** (dev machine, local Docker, 4 parallel restore jobs): see §5.1.

### 5.1 Last rehearsal

2026-10-23, on the 1,000,000-contact database used for the load test (4.7 GB on disk, 5.6 million
search rows, 1 million audit rows), Postgres 16.6 in Docker on a development laptop:

| Step                                                |                Time |
| --------------------------------------------------- | ------------------: |
| `pg_dump -Fc` (421 MB file)                         |                73 s |
| `pg_restore`, 4 parallel jobs                       |               247 s |
| `ANALYZE` (a restore carries no planner statistics) |                22 s |
| API start against the restored database             |                10 s |
| **Dump to serving traffic**                         | **about 6 minutes** |

All 18 checks passed: row counts and checksums of every record table, RLS enabled and forced on all 35
tables with a `tenant_id`, identical policies, grants, indexes, triggers and constraints, no role with
`BYPASSRLS`, the application role seeing its own tenant's 1,000,000 contacts and **none** with another
tenant's id or with no tenant set, the migration version, a sign-in with an original password, and a
list.

What this does and does not tell you:

- It is a **logical** restore of a database that fits in cache, on fast local disk. A managed instance's
  PITR restore will be slower to start and is not covered. The RTO of 4 hours has a lot of room at this
  size; the number to watch is how it grows with data (dump and restore were roughly linear in size).
- **The cross-tenant 404 check was skipped**: only one company in this database holds contacts, so
  there was no foreign id to request. The same property is proved by the RLS checks and by the security
  suite; the drill prints "skipped" rather than passing silently. Seed a second company to make it run.
- The **RPO of 15 minutes is not demonstrated** by a logical dump (it is as old as the last dump). It is
  the provider's continuous archiving that has to deliver it, and that has not been exercised.

Three things the drill found while it was being written, now part of the procedure and the script: the
two search functions' `LEAKPROOF` marks are **not** carried by a dump (they come from the bootstrap
script, so a restore that skips it is silently slow, and the drill now checks for them); a restored
database has **no planner statistics** until `ANALYZE` (47 of 58 tables had none ten minutes after the
restore, with autovacuum competing for I/O), so the procedure analyses before traffic; and the script's
own wait for the API once misread a healthy API as down for seven minutes (a Windows shell setting broke
`curl`'s output), a reminder that a drill's failure is as likely to be the drill as the restore.

### Restoring after a loss, step by step

1. **Decide the target time.** For corruption or a bad deploy, the moment before it. Write it down.
2. **Stop writers:** scale the API and worker to zero. A restore underneath a running app invites
   split state.
3. **Restore into a new database** (PITR to a new instance, or `pg_restore` of the dump). Never restore
   over the broken one: you lose the evidence and the way back.
4. **Roles first.** A dump does not carry roles. On a new cluster run the bootstrap script (with real
   passwords, as in §2.2) before `pg_restore`, or ownership and grants fail to apply.
5. **`ANALYZE`** (`vacuumdb --analyze-only`, or `psql -c analyze`): 22 seconds at 4.7 GB. A restore
   carries no planner statistics, and traffic sent before they exist gets bad plans.
6. **Run the checks**: `deploy/backup-drill.sh` against the restored database, or at least: counts,
   `select count(*) from pg_class where relrowsecurity and relforcerowsecurity` (35 today), the
   migration count, and `select proname, proleakproof from pg_proc where proname in ('ts_match_vq',
'word_similarity_op')` (both `t`, or search is slow, §0).
7. **Point the apps at it** (change `DATABASE_*_URL`), start the worker first, then the API, then the
   web.
8. **Nothing needs re-running**: unprocessed outbox events in the restored table are processed as the
   worker starts, and every handler is idempotent (CLAUDE.md §6). Search is a projection and can be
   rebuilt if it is suspect: `pnpm db:reindex`.
9. **Tell the customers** what time they are restored to. Anything they wrote after it is gone; there
   is no merge.

## 6. Incidents

**Everything is failing with 503s.** The database pool is exhausted. Check Postgres first (is it up,
how many connections, any long-running statement: `select pid, now() - query_start, left(query, 80) from
pg_stat_activity where state = 'active' order by 2 desc`). A search that matches little on a
database without the `LEAKPROOF` marks (§0) is the usual cause, though it is now capped at two seconds. Terminate the offending backend (`pg_terminate_backend`), then scale the API out if the load is
real.

**Nobody receives email.** Check the worker and API logs for `Email was not sent`: the line carries the
HTTP status and Resend's error name and nothing else (the message, recipient and key are never
logged). `validation_error` or 403: the sender domain is not verified in Resend. 401: the API key is
wrong. 429 or 5xx: Resend is limiting or down; sending retries.

**Search is slow or times out.** First check the LEAKPROOF marks (§0):
`select proname, proleakproof from pg_proc where proname in ('ts_match_vq', 'word_similarity_op')`,
both must be `t`. A database restored into a new cluster from a dump **loses them**: they are not part
of the dump of a user database, they are applied by the bootstrap script. Re-run it as a superuser if the provider allows one (§0); if not, expect slow rare-word searches.

**A user says they see data they should not.** Treat it as a security incident. Capture the request id
from the response, pull the audit log (`/api/v1/audit-logs`), and confirm the role and field
permissions. Do not "fix" it by widening anything. Contact the owner of the product's security review.

**A secret was exposed.** Rotate it (§7), then check the audit log and the provider's own log for use
of it between exposure and rotation.

## 7. Secrets and rotation

| Secret                          | Held by              | Rotating it                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                   | API                  | **Signs everyone out** (cookies are signed with it) **and makes enrolled authenticator secrets unreadable** (MFA secrets are encrypted with it). Rotate only with a plan: announce it, and expect every MFA user to re-enrol. There is no dual-key rotation yet. |
| Database passwords (five roles) | API, worker, migrate | `ALTER ROLE … PASSWORD`, update the env, restart. No downtime if done role by role behind a rolling restart.                                                                                                                                                     |
| `RESEND_API_KEY`                | API, worker          | Create a new key in Resend, set it, restart, delete the old key.                                                                                                                                                                                                 |
| Object store keys               | API, worker          | Create a new key pair, set both, restart, delete the old pair.                                                                                                                                                                                                   |
| `GOOGLE_CLIENT_SECRET`          | API                  | Rotate in the Google console, set, restart.                                                                                                                                                                                                                      |

Never put a secret in the repository, an image layer, a log line or a ticket. The images contain no
env file; `.dockerignore` and `.gitignore` both exclude them.

## 8. Known gaps (so nobody is surprised)

- **Rate limits are fixed windows**, so a caller can send up to twice the limit across a window boundary.
  While Redis is unreachable each API instance counts alone (§4.1), so N instances allow up to N times the limit.
- **`AUTH_SECRET` rotation signs everyone out and breaks MFA enrolments**; there is no key versioning.
- **A list's search matches words by their start, not substrings, and shows at most the 300 most
  recently updated matches** (ADR-0041 §5); an export of a search refuses more than 5,000.
- **Search without the `LEAKPROOF` marks is slow for a word that matches little** and is bounded by a
  two-second limit (`503 SEARCH_TIMEOUT`), not fast (§0), until it is moved out of Postgres.
- **Outbound mail has no idempotency key**, so a retry after an ambiguous failure can send a message
  twice.
- **Nothing here has been run in production or against a managed Postgres.**
