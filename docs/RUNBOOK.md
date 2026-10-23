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

| Piece           | Image target    | Needs                                                                        |
| --------------- | --------------- | ---------------------------------------------------------------------------- |
| API             | `api`           | Postgres (`crm_app`, `crm_auth`), the object store, Resend, optionally Redis |
| Worker          | `worker`        | Postgres (`crm_worker`, optionally `crm_erasure`), the object store, Resend  |
| Web             | `web`           | The API (private network) and nothing else                                   |
| Migrations      | `migrate`       | Postgres as `crm_migrator`. A one-shot job, not a service                    |
| TLS and routing | Caddy (example) | Ports 80 and 443                                                             |

Postgres 16, Redis and the object store are **managed services**, not containers in the compose file
(CLAUDE.md §2). `deploy/docker-compose.prod.example.yml` shows one host's layout and is an example to
copy, not something to run unchanged.

The API and the worker **refuse to start** in production with a development value (a default or
placeholder `AUTH_SECRET`, `console` or `memory` email, memory storage, `http` or `localhost` URLs, the
database superuser, a development password) and print the name of each variable that is wrong, never
its value. If one will not start, read its log first: the answer is in it. The rules are
`packages/core/src/config/production.ts`; ADR-0041 §6 says why each exists.

## 2. First deployment

_For DigitalOcean (Bangalore) with the web app on Vercel, follow §9 instead: it has the same steps with the
specifics, and a verification script for the managed-database step._

1. **Provision** Postgres 16 (see §0), an S3-compatible bucket (private, no public ACLs), a Resend
   account with the sending domain verified (SPF and DKIM, or mail is not delivered), and DNS for the
   app and API hosts.
2. **Create the roles and extensions**, once, as a role that may create them (a superuser, or a managed
   service's administrative role), with real passwords:
   `packages/db/sql/bootstrap/01-extensions-and-roles.sql`. The file creates the five roles
   (`crm_migrator`, `crm_app`, `crm_auth`, `crm_worker`, `crm_erasure`) with **development**
   passwords: copy it, replace each password with a generated one, and run the copy. Never run the
   file as it is against anything but a laptop. None of the roles has `BYPASSRLS` or owns a table.
   **On a managed service whose administrative role is not a superuser, the file as written stops at
   `ALTER SCHEMA public OWNER TO crm_migrator`** (ADR-0043); `deploy/verify-managed-postgres.sh bootstrap`
   does the password substitution and the one grant that fixes it (§9.4).
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
- **Scale out, not up:** run more API instances behind the proxy. **Until rate limits move to Redis
  each instance counts its own**, so the effective limit is the configured one times the number of
  instances (the API logs a warning at startup when `REDIS_URL` is unset). Setting
  `DATABASE_POOL_MAX` higher helps only if Postgres has the connections to give: size the database's
  `max_connections` to instances x pool.
- A single slow endpoint can still consume the pool. Search was the case that did (3 to 31 seconds
  per request at a million contacts); it is now fast where the `LEAKPROOF` marks exist and **capped at
  two seconds per search** where they do not (§0), so a mistyped search cannot hold a connection for
  longer than that. Other endpoints have no such cap.

Alert on: API 5xx rate; `SERVICE_BUSY` count; p95 latency per route; Postgres connections near
`max_connections`; outbox backlog (rows in `outbox_events` with `processed_at` null and a due time in
the past); disk on the database volume.

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

| Secret                                     | Held by                      | Rotating it                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                              | API                          | **Signs everyone out** (cookies are signed with it) **and makes enrolled authenticator secrets unreadable** (MFA secrets are encrypted with it). Rotate only with a plan: announce it, and expect every MFA user to re-enrol. There is no dual-key rotation yet. |
| `doadmin` (managed-database administrator) | You only: a password manager | Never an app, CI or Vercel credential (§9.4). Rotate in the provider's console; nothing in this repository holds it.                                                                                                                                             |
| Database passwords (five roles)            | API, worker, migrate         | `ALTER ROLE … PASSWORD`, update the env, restart. No downtime if done role by role behind a rolling restart.                                                                                                                                                     |
| `RESEND_API_KEY`                           | API, worker                  | Create a new key in Resend, set it, restart, delete the old key.                                                                                                                                                                                                 |
| Object store keys                          | API, worker                  | Create a new key pair, set both, restart, delete the old pair.                                                                                                                                                                                                   |
| `GOOGLE_CLIENT_SECRET`                     | API                          | Rotate in the Google console, set, restart.                                                                                                                                                                                                                      |

Never put a secret in the repository, an image layer, a log line or a ticket. The images contain no
env file; `.dockerignore` and `.gitignore` both exclude them.

## 8. Known gaps (so nobody is surprised)

- **Rate limits are per process** until they move to Redis; scale-out multiplies them.
- **`AUTH_SECRET` rotation signs everyone out and breaks MFA enrolments**; there is no key versioning.
- **A list's search matches words by their start, not substrings, and shows at most the 300 most
  recently updated matches** (ADR-0041 §5); an export of a search refuses more than 5,000.
- **Search without the `LEAKPROOF` marks is slow for a word that matches little** and is bounded by a
  two-second limit (`503 SEARCH_TIMEOUT`), not fast (§0), until it is moved out of Postgres.
- **Outbound mail has no idempotency key**, so a retry after an ambiguous failure can send a message
  twice.
- **Nothing here has been run in production.** §9.11 lists what was rehearsed against a local stand-in for
  DigitalOcean's Postgres and what could not be.
- **The API cannot yet connect to DigitalOcean's Postgres**: node-postgres verifies the certificate and the
  provider's CA is private (§9.6, ADR-0042). Needs a decision and a small change in `packages/db`.
- **The web proxy does not forward the end user's IP to the API**, so the per-IP limits and the audit log's
  address are the proxy's, not the user's, and the API's `trustProxy: true` trusts a client-supplied
  `X-Forwarded-For` (ADR-0042).

## 9. Deploying to DigitalOcean (BLR1) with the web app on Vercel (bom1)

> **Status:** configuration written and **partly rehearsed on a local PostgreSQL 16 stand-in, never run
> on DigitalOcean or Vercel.** Nothing in this section has created a cloud resource; every step below is
> yours, with your accounts. What was and was not verified is listed in §9.11. Decisions and open
> questions: [ADR-0042](adr/0042-deployment-digitalocean-blr1-and-vercel-bom1.md) and
> [ADR-0043](adr/0043-managed-postgres-schema-ownership.md). **Read ADR-0042's first open question
> (TLS to the database) before provisioning anything: as the code stands, the API cannot connect to
> DigitalOcean's Postgres.**

### 9.1 The layout

| Piece         | Where                         | Region | Defined in                                        |
| ------------- | ----------------------------- | ------ | ------------------------------------------------- |
| Web (Next.js) | Vercel                        | `bom1` | `apps/web/vercel.json`                            |
| API           | App Platform service          | `blr`  | `deploy/do-app-platform.yaml`                     |
| Worker        | App Platform worker (no HTTP) | `blr`  | same                                              |
| Migrations    | App Platform `PRE_DEPLOY` job | `blr`  | same                                              |
| Postgres 16   | Managed Database              | `blr1` | by hand, then `deploy/verify-managed-postgres.sh` |
| Valkey        | Managed Database              | `blr1` | by hand (not needed yet, §9.2)                    |
| Files         | Spaces                        | `blr1` | by hand                                           |

The browser talks to the web app; the web app talks to the API **only over its public https URL**
(`API_URL`); the API and worker talk to Postgres, Spaces and Resend. **The web app has no database
credential and none may ever be set on Vercel** (§9.8).

### 9.2 Provisioning order

Do these in order; each needs the one before. Nothing here is automated on purpose: you hold the
accounts, and each step is a place to look at what you are about to pay for.

1. **Accounts and DNS.** A DigitalOcean account and a Vercel **Pro** team (§9.8). A domain you control,
   with hostnames for the app (`app.…`, Vercel) and the API (`api.…`, App Platform), and a Resend account
   with the sending domain verified (SPF and DKIM, or mail is not delivered).
2. **Postgres.** A Managed PostgreSQL **16** cluster in **`blr1`**. Create a database named `crm`. Note
   `max_connections` for the plan you pick (§9.7). Leave Trusted Sources as they are for now; you will
   add your own address and the app in a later step.
3. **Spaces.** A bucket in **`blr1`**, **private** (no public ACLs, no public listing), and an access key
   limited to that bucket if the console lets you. Then set the bucket's **CORS** to allow `PUT` and `GET`
   from your web origin only (`https://app.…`): without it the browser's upload to the presigned URL is
   refused and attachments and imports fail while everything else looks fine. Whether Spaces offers
   versioning and lifecycle rules in `blr1` (§5 assumes them) was **not verified**; check the bucket's
   settings before relying on it.
4. **Valkey: wait.** Nothing reads `REDIS_URL` until Redis-backed rate limiting merges (the API only logs a
   warning while it is empty; the worker uses no Redis). A Valkey cluster costs from the minute it exists.
   When the time comes: `blr1`, TLS, and give the API the `rediss://` URL.
5. **Container Registry.** A DigitalOcean Container Registry, and `doctl registry login`.
6. **Verify the database, then bootstrap it** (§9.3, §9.4). Add your own address to the cluster's Trusted
   Sources first or you cannot connect.
7. **Build and push the four images** (§9.5).
8. **Create the app** from the rendered spec (§9.6). The **first deployment will fail** at the `migrate`
   job, because the database does not yet trust the app: that is expected. In the cluster's **Trusted
   Sources** add the app, then redeploy. (Do not open the cluster to the world to avoid this.)
9. **Vercel**: create the project, set the root directory, region and environment (§9.8), deploy.
10. **Point DNS** at both, set `WEB_URL` and `API_URL` to the final https origins, and run §9.9.

### 9.3 Verify the managed database before trusting it

`deploy/verify-managed-postgres.sh probe` creates a **throwaway database and throwaway roles** on the
cluster, runs the repository's bootstrap SQL there **exactly as shipped**, prints a pass or fail per
check, and drops everything it made. It needs `psql`; on Windows, or anywhere without it, run it in a
container so nothing needs installing:

```powershell
$env:ADMIN_DATABASE_URL = '<the doadmin connection string from the DigitalOcean console>'  # this session only
docker run --rm -it -e ADMIN_DATABASE_URL -v "${PWD}:/repo:ro" postgres:16 bash /repo/deploy/verify-managed-postgres.sh probe
```

(`-e ADMIN_DATABASE_URL` with no value passes it from your session, so it is neither on the command line
nor in a file. The script never prints it or any password. Add `-v C:\path\ca.crt:/ca.crt:ro -e
DB_CA_CERT=/ca.crt` to verify the server's certificate with DigitalOcean's CA.)

What it checks and what each answer means:

| Check                                                                      | If it fails                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connects; PostgreSQL 16 or later; the admin can create roles and databases | Wrong cluster or credentials, or the version is too old                                                                                                              |
| `ALTER SCHEMA public OWNER TO crm_migrator` (line 133), as shipped         | **The likely failure.** The script then tries the fix in ADR-0043 and says whether it works; the VERDICT line at the end says which of the three outcomes you are in |
| The whole bootstrap runs end to end                                        | Read the line number and statement it prints                                                                                                                         |
| Five roles exist, each `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`   | Stop. Do not run the app against this cluster                                                                                                                        |
| `public` owned by the migrator; no app role can create in it               | Stop, as above                                                                                                                                                       |
| RLS binds a non-admin role, and the admin walks through it                 | Stop. This is the property the whole product rests on                                                                                                                |
| The LEAKPROOF step degrades to a warning instead of aborting               | A `WARN` here is **expected and accepted** (ADR-0041 §1, §0 above); a `FAIL` means the bootstrap would abort                                                         |

Two things the script cannot tell you, and nothing else can until the real service is in front of you:
whether `doadmin` behaves like the stand-in (the probe is exactly the test of that), and whether DigitalOcean
has changed anything since the documentation this was written from.

### 9.4 Bootstrap, and the one connection that must never run the app

When `probe` is clean (or clean with the ADR-0043 grant):

```powershell
docker run --rm -it -e ADMIN_DATABASE_URL -v "${PWD}:/repo:ro" -v "${PWD}/deploy:/out" postgres:16 `
  bash /repo/deploy/verify-managed-postgres.sh bootstrap --db crm --out /out/do-app.secrets.env
```

This runs the bootstrap in `crm` with **generated** passwords (the file's development passwords are
replaced; the script refuses to continue if one survives), applies the ADR-0043 grant only if it is needed
and revokes it afterwards, writes the five role connection strings and a generated `AUTH_SECRET` to a
file only you can read (`deploy/*.env` is git-ignored), and then audits. It refuses to run if the `crm_*`
roles already exist, because their passwords would not be the ones it generated. Then
`verify-managed-postgres.sh audit --db crm` at any time re-checks the roles, the schema ownership, the
extensions, the LEAKPROOF state, and **tries each role's development password** (the passwords in the
bootstrap file are public; a role that still accepts one fails the audit).

> **`doadmin` has `BYPASSRLS`. It is correct for bootstrap and migrations and it must never be a
> runtime connection.** Row-level security is the tenant wall (CLAUDE.md §5.1); a role that bypasses it
> reads every company's data with no error and no log line, and DigitalOcean's console shows that role's
> connection string first. The application connects as `crm_app` (API), `crm_auth` (the auth pool),
> `crm_worker` and `crm_erasure` (worker); `crm_migrator` is used by the `migrate` job and by you for a
> hand-run migration, nowhere else. Four independent guards enforce it:
>
> 1. the app spec has **no `databases:` binding** (it would offer `${db.DATABASE_URL}`, the admin string);
> 2. `deploy/render-do-app-spec.sh` refuses a database URL whose user is not the role that variable is for;
> 3. `packages/core/src/config/production.ts` refuses `doadmin` by name, with `postgres`, `root` and `admin`;
> 4. the API and the worker **ask the database what their connections' roles can do and refuse to start**
>    if any is a superuser or has `BYPASSRLS` (`assertConnectedRoles`). A start-up log line reading
>    `connects as role "…", which has BYPASSRLS` means a connection string is wrong; fix the string, never
>    the check.
>
> After bootstrap, keep the `doadmin` string only in your password manager. It belongs in no app, no CI
> variable and no Vercel setting.

### 9.5 Build and push the images

Build each target once from the commit you are releasing, and tag with the commit (never `latest`; the
renderer refuses it):

```bash
V=$(git rev-parse --short=12 HEAD)
REG=registry.digitalocean.com/<your-registry>
for t in api worker migrate; do docker build -f deploy/Dockerfile --target $t -t $REG/crm-$t:$V . ; done
doctl registry login
for t in api worker migrate; do docker push $REG/crm-$t:$V; done
```

The images contain no personal data and no secret, so where the registry sits is not a residency
question. There is no `web` image in this layout: Vercel builds the web app from the repository (§9.8).

### 9.6 Render and apply the app spec

`deploy/do-app-platform.yaml` is a template (secrets are `@@NAME@@`). Fill in the rest of the secrets
file (`WEB_URL`, `API_URL`, `EMAIL_FROM`, `RESEND_API_KEY`, the Spaces bucket and keys, `CRM_VERSION`; the
bootstrap wrote the database URLs, `AUTH_SECRET` and the Spaces endpoint), then:

```bash
deploy/render-do-app-spec.sh --check deploy/do-app.secrets.env            # validate only, prints nothing secret
deploy/render-do-app-spec.sh deploy/do-app.secrets.env | doctl apps create --spec -
deploy/render-do-app-spec.sh deploy/do-app.secrets.env | doctl apps update <app-id> --spec -
```

The rendered spec exists only on the pipe. App Platform encrypts every `SECRET` on first submission.

**TLS to Postgres (blocks the first real deployment).** The database URLs the bootstrap writes carry
`sslmode=require`. The installed node-postgres reads that as full verification, and DigitalOcean's
certificate is signed by a private CA, so the API will not connect (reproduced locally against a
self-signed server). Run, from a machine on the cluster's Trusted Sources, with the `crm_app` URL:

```bash
DATABASE_URL='<the crm_app URL>' pnpm --filter @crm/db exec node ../../deploy/check-app-connection.mjs
```

`PASS` twice means the connection verifies and the role is right. A TLS `FAIL` means decide ADR-0042's
open question 1 (the recommended change is small and lives in `packages/db`); do not "fix" it with
`sslmode=no-verify`, which encrypts to whoever answers.

### 9.7 Connections

A managed Postgres has few connections to give. One API instance holds up to `DATABASE_POOL_MAX` for
`crm_app` plus a quarter of that (minimum two) for `crm_auth`; the worker holds its own pool plus two for
`crm_erasure`; the `migrate` job one. The spec sets 6 (API) and 4 (worker), so a single API and worker
hold at most 8 + 6 = 14, and **while a deploy overlaps old and new API instances, 22**. Run `show
max_connections` (the probe prints it) and keep the total, including the overlap and your own `psql`
sessions, comfortably below it. DigitalOcean's connection pooler (transaction mode) is **untested with
this application**; do not put the API, worker or migrations behind it until it has been tried (the
application sets per-transaction state with `SET LOCAL`, which should survive it, but "should" is not
verified).

### 9.8 The web app on Vercel, pinned to `bom1`

**Vercel Functions default to `iad1` (Washington, D.C.) for a new project.** Left alone, every request
from India is served from the United States, and every web-to-API call crosses the planet and back.
`apps/web/vercel.json` sets `"regions": ["bom1"]` (AWS `ap-south-1`, Mumbai). Check it took effect:
**Project, Settings, Functions** shows `Mumbai, India (bom1)`, and a response's `x-vercel-id` header has
the function's region as its second segment (`…::bom1::…`; confirm the format against Vercel's current
documentation).

**Plan.** Vercel documents Hobby as limited to **one** function region, Pro to five, and Enterprise to
all. So `bom1` alone is not strictly a Pro feature, but Vercel's terms restrict Hobby to non-commercial
use (check the current wording) and the pilots are commercial: **use Pro.** Also from Vercel's
documentation: automatic failover to another region is **Enterprise only**, so if `bom1` is down the web
app is down (the API, in `blr1`, is unaffected and sessions survive).

**Project settings** (dashboard; nothing here is secret):

- Root Directory: `apps/web`, with "Include source files outside of the Root Directory" **on** (the web app
  compiles the workspace packages). `vercel.json` sets the install and build commands; the build command
  was run locally and succeeds.
- Environment variables, **Production** (and Preview, with a staging API; never production's):
  - `API_URL` = the API's public https origin (`https://api.…`). Required.
  - `S3_PUBLIC_ENDPOINT` = `https://blr1.digitaloceanspaces.com`. Only its origin is used, to let the page
    upload there (CSP).
  - `SESSION_COOKIE_NAME`, `SESSION_TTL_DAYS`: only if you change the defaults (they must match the API's).
- **No other variable.** In particular none of `DATABASE_*`, `AUTH_SECRET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `RESEND_API_KEY`, `REDIS_URL`. The web app does not need them, and a credential
  that is not there cannot leak. The web app's environment parser ignores unknown variables rather than
  rejecting them, so **nothing in the code will tell you if one gets added**: check by hand after every
  change to the project's environment (`vercel env ls production`, read the Name column), and when you
  rotate anything.

### 9.9 Deploying, migrating, rolling back, and checking

**Releasing.** Build and push the images (§9.5), set `CRM_VERSION` in the secrets file, render and
`doctl apps update` (§9.6). App Platform runs the `migrate` job first; **if it fails, the deployment fails
and the previous version keeps serving.** Then the API and worker roll; the API is not considered up until
`/api/v1/health` answers, and it will not listen at all if its configuration is unsafe or a database role
bypasses RLS. Then deploy the web app on Vercel (§3's order: migrate, then API and worker, then web).

**Running migrations by hand** (a `CONCURRENTLY` index build on a large table, per §3 step 4; or to inspect
what is pending): from a machine on the Trusted Sources, `DATABASE_MIGRATION_URL='<the crm_migrator URL>'
DATABASE_URL='<the crm_app URL>' pnpm db:migrate`. Migrations are forward-only; a failed
one is fixed forward with a new migration (§3).

**Rolling back.** Code: re-render with the previous `CRM_VERSION` and `doctl apps update` (or use App
Platform's rollback; it redeploys the previous images and **does not undo migrations**, which is safe
because the schema is compatible by construction, §3). Web: promote the previous deployment in Vercel.
Data: restore from a backup into a **new** cluster (§5), re-run `verify-managed-postgres.sh audit` against
it (a restore carries no roles; run `bootstrap` first), then re-point the `DATABASE_*` secrets.

**After every deploy**, in this order. Stop at the first failure.

1. `curl -fsS https://api.…/api/v1/health` and `/api/v1/health/ready` both answer `{"status":"ok"}`.
2. The API and worker logs contain **no** `Refusing to start` and no `bypass row-level security`.
3. `verify-managed-postgres.sh audit --db crm` is all `PASS` (a `WARN` for LEAKPROOF is expected).
4. Sign up, receive the verification email, sign in, create a contact. (Email: a `validation_error` in the
   worker log means the Resend domain is not verified.)
5. **Upload an attachment and run an export.** Together they prove Spaces credentials, the bucket's CORS
   rule, path-style presigned URLs, and the web app's CSP all agree; if upload fails in the browser with a
   CORS or CSP error and nothing in the API log, it is one of those.
6. The worker is processing: a new contact appears in its timeline; no growing backlog of outbox rows.
7. Signed in to one company, request a record id that belongs to another: it answers 404, not 403 and not
   the record.
8. The web app is in `bom1` (§9.8) and `vercel env ls production` lists only the variables in §9.8.
9. Point an external uptime monitor at `/api/v1/health/ready` (the platform's own check is liveness only,
   deliberately: a database blip should alert you, not restart the API).

### 9.10 Data residency (DPDP): what is in India and what is not

This is a technical description for whoever drafts the data-processing agreement (`docs/legal/`). It states
where the system puts and processes personal data; whether that satisfies any law is the lawyer's question,
not this document's.

**In India, by configuration** (once §9.2 is followed as written):

- **Postgres** (the system of record), **Valkey** and **Spaces** (uploads, imports, exports): DigitalOcean
  `blr1`, Bangalore.
- **The API, the worker and the migration job:** App Platform region `blr`.
- **The web application's server side:** Vercel function region `bom1`, which Vercel documents as AWS
  `ap-south-1` (Mumbai). Pages, the session cookie and every proxied call to the API are handled there.

**Not guaranteed to be in India, and to be disclosed rather than assumed:**

- **Vercel's edge.** Vercel terminates the browser's connection at one of its worldwide points of
  presence and carries it to `bom1`; its documentation says the region then handles TLS. Static assets are
  cached at the edge by design. The web app marks its proxied API calls `no-store`, but **whether every
  dynamic page response carries a cache directive that keeps it out of a shared cache was not verified**;
  check before claiming that no personal data is ever held at an edge.
- **Vercel's logs and metadata.** Request logs record paths and query strings (a list's search box puts
  its search term in the query), and where Vercel stores them is Vercel's to say. Treat request logs as
  possibly containing personal data held outside India until Vercel's documentation or contract says
  otherwise.
- **Email.** Resend sends notification and verification email; the recipient's address, name and the
  message content pass to Resend, whose processing location is not India and was not verified here. It is
  a cross-border processor for as long as `EMAIL_PROVIDER=resend`.
- **Backups.** The provider's backups are the provider's. This runbook (§5) recommends a daily logical dump
  "in another account or region": **DigitalOcean's only Indian region is `blr1`, so a dump in another region
  is outside India.** Keep it in a second `blr1` bucket under a separate account or project if residency
  matters more than region diversity, and say which you chose.
- **People.** Staff of DigitalOcean, Vercel and Resend with administrative access, and your own staff
  wherever they work. Where data sits and who can reach it are different questions.
- **The container registry** holds images only (no personal data, §9.5).

Sign-in with Google, if enabled, sends the user to Google; it is off unless `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` are set, which this configuration does not do.

### 9.11 What was and was not verified

**Run, locally, against PostgreSQL 16.6 standing in for the provider** (a non-superuser with `CREATEROLE`,
`CREATEDB` and `BYPASSRLS`, password authentication over a network connection): the bootstrap as shipped
(it fails at line 133, as predicted), the ADR-0043 fix, the whole `probe`, `bootstrap`, `audit` and the
development-password check, the secret-leak check on the scripts' output, the API and worker refusing
to start as a `BYPASSRLS` role and starting as the real roles, the TLS failure against a self-signed server,
the spec renderer (valid YAML, no leftover placeholder, no database URL outside a secret, `doadmin`
refused), and the web build command.

**Not verifiable without the real services:** that `doadmin` behaves like the stand-in; that App Platform
accepts the spec as written (field names were taken from its documentation; `doctl apps spec validate`
is the first thing to run, and it is cheap); that the Bangalore endpoint is `blr1.digitaloceanspaces.com`
and Spaces accepts path-style requests signed as `us-east-1` (from DigitalOcean's SDK examples, not
tried); that the `PRE_DEPLOY` job's image `CMD` is used as written; that Vercel accepts the
`vercel.json` and builds there as it did locally; the `x-vercel-id` format; the connection budget on the
plan you choose; that Trusted Sources, VPC and the pooler behave as §9.2 and §9.7 assume.

**Known gaps specific to this deployment:** the TLS question above (blocking); one API instance only until
rate limits are shared; the web proxy does not forward the end user's IP, so per-IP limits and the audit
log's address are Vercel's, not the user's (ADR-0042); the worker logs a harmless Redis warning.
