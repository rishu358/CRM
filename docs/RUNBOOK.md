# Runbook

How to deploy, operate, back up and recover the CRM. Written for the person on call, so it is
procedures first and reasons second. The reasons are in the ADRs it links.

> **Status:** drafted from a rehearsal on a development machine, not from a production incident.
> Every command here was run; the numbers were measured (see [PERF.md](PERF.md)). Nothing has been
> deployed, and no pilot has used it. Treat the first real deployment as a second drill and correct
> this document where it is wrong.

## 0. Read this before choosing a database

**The database must allow a superuser to run `packages/db/sql/bootstrap/01-extensions-and-roles.sql`.**

Global search relies on two functions being marked `LEAKPROOF` (ADR-0028 §7), and only a superuser
can mark a function. Without them Postgres cannot use the search indexes under row-level security.
Measured at a million contacts, with the marks removed:

| Search | With the marks | Without |
| --- | ---: | ---: |
| A common surname (everyone) | 0.1 s | 0.1 s |
| A rare term (everyone) | 0.3 s | **13.6 s** |
| A typo (everyone) | 0.4 s | **31.6 s** |
| A common surname (a rep) | 0.4 s | 0.4 s |
| A typo (a rep) | 0.2 s | **6.0 s** |

Most managed Postgres services (AWS RDS and Aurora, Google Cloud SQL, Azure Database, Supabase, Neon)
do not give you a real superuser, and I have not verified that any of them lets you mark a function
leakproof. **Confirm with the provider before choosing one.** Options if it cannot be done:

1. Run Postgres yourself (a VM or Kubernetes with a persistent volume) and take on its backups,
   patching and failover. This is the supported path today.
2. Use a provider that does grant it (ask for it by name: "can a customer run
   `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF`?").
3. Move search out of Postgres (Meilisearch is the planned swap, behind `SearchProvider`). That is a
   build, not a configuration change, and nothing here prepares for it beyond the interface.

Nothing else in the product needs a superuser. The migrations run as `crm_migrator`, which is not one.

## 1. What runs where

| Piece | Image target | Needs |
| --- | --- | --- |
| API | `api` | Postgres (`crm_app`, `crm_auth`), the object store, Resend, optionally Redis |
| Worker | `worker` | Postgres (`crm_worker`, optionally `crm_erasure`), the object store, Resend |
| Web | `web` | The API (private network) and nothing else |
| Migrations | `migrate` | Postgres as `crm_migrator`. A one-shot job, not a service |
| TLS and routing | Caddy (example) | Ports 80 and 443 |

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
2. **Create the roles and extensions**, once, as a superuser, with real passwords:
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

- **One API process sustains about 30 requests/s of mixed traffic** at a p95 of about 210 ms. That
  is roughly 100 to 150 active users. At 40 requests/s the tail degrades (p95 about 0.9 s); at 50 it
  collapses.
- **When it collapses it answers `503 SERVICE_BUSY` with `Retry-After: 2`**, not a generic 500. The
  cause is the database connection pool (`DATABASE_POOL_MAX`, default 10) running out. The web
  client retries 5xx responses with backoff.
- **Scale out, not up:** run more API instances behind the proxy. **Until rate limits move to Redis
  each instance counts its own**, so the effective limit is the configured one times the number of
  instances (the API logs a warning at startup when `REDIS_URL` is unset). Setting
  `DATABASE_POOL_MAX` higher helps only if Postgres has the connections to give: size the database's
  `max_connections` to instances x pool.
- A single slow endpoint can still consume the whole pool. The one known case, free-text `q` on a list
  with a term that matches nothing, is described in PERF.md §5 and is a **decision waiting to be
  made**, not something solved.

Alert on: API 5xx rate; `SERVICE_BUSY` count; p95 latency per route; Postgres connections near
`max_connections`; outbox backlog (rows in `outbox_events` with `processed_at` null and a due time in
the past); disk on the database volume.

## 5. Backups and recovery

**Objectives (MVP_SPEC §9):** RPO 15 minutes, RTO 4 hours.

| Layer | What protects it | Recovers to |
| --- | --- | --- |
| Postgres | The provider's continuous archiving and point-in-time recovery, **plus** a daily logical dump (`pg_dump -Fc`) kept in a bucket in another account or region | Any second within the retention window (PITR); the last dump (logical) |
| Object store | Bucket versioning and a lifecycle rule that keeps previous versions 30 days | A deleted or overwritten file |
| Secrets | Your secret manager's own history | The previous value |
| Configuration | This repository and the env file's source of truth | Any release |

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

DRILL_RESULTS_PLACEHOLDER

### Restoring after a loss, step by step

1. **Decide the target time.** For corruption or a bad deploy, the moment before it. Write it down.
2. **Stop writers:** scale the API and worker to zero. A restore underneath a running app invites
   split state.
3. **Restore into a new database** (PITR to a new instance, or `pg_restore` of the dump). Never restore
   over the broken one: you lose the evidence and the way back.
4. **Roles first.** A dump does not carry roles. On a new cluster run the bootstrap script (with real
   passwords, as in §2.2) before `pg_restore`, or ownership and grants fail to apply.
5. **Run the checks**: `deploy/backup-drill.sh` against the restored database, or at least: counts,
   `select count(*) from pg_class where relrowsecurity and relforcerowsecurity`, the migration count.
6. **Point the apps at it** (change `DATABASE_*_URL`), start the worker first, then the API, then the
   web.
7. **Re-run the outbox** is not needed: unprocessed events in the restored table are processed as the
   worker starts, and every handler is idempotent (CLAUDE.md §6). Search is a projection and can be
   rebuilt: `pnpm db:reindex`.
8. **Tell the customers** what time they are restored to. Anything they wrote after it is gone; there
   is no merge.

## 6. Incidents

**Everything is failing with 503s.** The database pool is exhausted. Check Postgres first (is it up,
how many connections, any long-running statement: `select pid, now() - query_start, left(query, 80) from
pg_stat_activity where state = 'active' order by 2 desc`). A slow free-text `q` or a search is the usual
cause. Terminate the offending backend (`pg_terminate_backend`), then scale the API out if the load is
real.

**Nobody receives email.** Check the worker and API logs for `Email was not sent`: the line carries the
HTTP status and Resend's error name and nothing else (the message, recipient and key are never
logged). `validation_error` or 403: the sender domain is not verified in Resend. 401: the API key is
wrong. 429 or 5xx: Resend is limiting or down; sending retries.

**Search is slow or times out.** First check the LEAKPROOF marks (§0):
`select proname, proleakproof from pg_proc where proname in ('ts_match_vq', 'word_similarity_op')`,
both must be `t`. A database restored into a new cluster from a dump **loses them**: they are not part
of the dump of a user database, they are applied by the bootstrap script. Re-run it as a superuser.

**A user says they see data they should not.** Treat it as a security incident. Capture the request id
from the response, pull the audit log (`/api/v1/audit-logs`), and confirm the role and field
permissions. Do not "fix" it by widening anything. Contact the owner of the product's security review.

**A secret was exposed.** Rotate it (§7), then check the audit log and the provider's own log for use
of it between exposure and rotation.

## 7. Secrets and rotation

| Secret | Held by | Rotating it |
| --- | --- | --- |
| `AUTH_SECRET` | API | **Signs everyone out** (cookies are signed with it) **and makes enrolled authenticator secrets unreadable** (MFA secrets are encrypted with it). Rotate only with a plan: announce it, and expect every MFA user to re-enrol. There is no dual-key rotation yet. |
| Database passwords (five roles) | API, worker, migrate | `ALTER ROLE … PASSWORD`, update the env, restart. No downtime if done role by role behind a rolling restart. |
| `RESEND_API_KEY` | API, worker | Create a new key in Resend, set it, restart, delete the old key. |
| Object store keys | API, worker | Create a new key pair, set both, restart, delete the old pair. |
| `GOOGLE_CLIENT_SECRET` | API | Rotate in the Google console, set, restart. |

Never put a secret in the repository, an image layer, a log line or a ticket. The images contain no
env file; `.dockerignore` and `.gitignore` both exclude them.

## 8. Known gaps (so nobody is surprised)

- **Rate limits are per process** until they move to Redis; scale-out multiplies them.
- **`AUTH_SECRET` rotation signs everyone out and breaks MFA enrolments**; there is no key versioning.
- **Free-text `q` on lists is an unindexed substring scan** and takes seconds for a term that matches
  nothing at a million contacts (PERF.md §5).
- **Search needs a superuser-marked database** (§0) until it is moved out of Postgres.
- **Outbound mail has no idempotency key**, so a retry after an ambiguous failure can send a message
  twice.
- **Nothing here has been run in production or against a managed Postgres.**
