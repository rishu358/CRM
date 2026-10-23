# ADR-0042: Deployment target: DigitalOcean App Platform in BLR1, the web app on Vercel in bom1

- **Status:** Accepted (the platform choice is the owner's); the configuration is **written and partly
  rehearsed, never deployed**. §Open questions need an owner decision before real personal data goes in.
- **Date:** 2026-10-23
- **Related:** ADR-0041 (deploy images, production config validation, no superuser), ADR-0043
  (bootstrap on a managed database), `docs/RUNBOOK.md` §9

## Context

The product is for Indian businesses; three to five pilots are planned. The owner compared hosts and chose
**DigitalOcean App Platform, Bangalore (`blr1`)** for the API and worker, with the **Next.js app on
Vercel pinned to Mumbai (`bom1`)**. Railway and Render have no India region and Fly.io's Mumbai region was
judged unreliable. This ADR records how that choice is configured, the one defaulting trap in it, and what
is still open. It does not revisit the choice.

## Decision

### 1. What runs where

| Piece                 | Where                               | Region                 | Config                                        |
| --------------------- | ----------------------------------- | ---------------------- | --------------------------------------------- |
| Web (Next.js)         | Vercel                              | `bom1` (ap-south-1)    | `apps/web/vercel.json`                        |
| API                   | App Platform **service**            | `blr`                  | `deploy/do-app-platform.yaml`                 |
| Worker (outbox relay) | App Platform **worker** (no HTTP)   | `blr`                  | same                                          |
| Migrations            | App Platform `PRE_DEPLOY` **job**   | `blr`                  | same                                          |
| Postgres 16           | DigitalOcean Managed Databases      | `blr1`                 | created by hand; `verify-managed-postgres.sh` |
| Valkey                | DigitalOcean Managed Databases      | `blr1`                 | created by hand                               |
| Files                 | DigitalOcean Spaces (S3-compatible) | `blr1`                 | created by hand                               |
| Images                | DigitalOcean Container Registry     | n/a (no personal data) | `deploy/Dockerfile`, four targets             |

The web app reaches the API only over its **public URL** (`API_URL`, https), through the same
`/api/proxy` route it uses everywhere. It has no database credential and cannot get one: it is a different
platform with its own environment, and `apps/web` never imports the database package (CLAUDE.md §3).

### 2. Images, not source builds

App Platform runs prebuilt images from DOCR. Each of the four `deploy/Dockerfile` targets is built once and
promoted by tag; the same bytes that passed CI are what run. (App Platform's own Dockerfile build offered no
way to pick one stage of a multi-stage file that I could find; promoting an image is the better release
anyway.) The tag is a release identifier, never `latest`; the renderer refuses `latest`.

### 3. Secrets: rendered, never stored

`deploy/do-app-platform.yaml` is a template with `@@NAME@@` placeholders; `deploy/render-do-app-spec.sh`
fills them from a git-ignored file and prints to a pipe for `doctl`. It refuses missing, malformed or
placeholder values, **refuses any database URL whose user is not the role that variable is for** (and
`doadmin`, `postgres`, `admin`, `root` outright), prints no value, and writes nothing to disk. The spec has
**no `databases:` component** on purpose: attaching the cluster would put `${db.DATABASE_URL}`, the
administrative role's string, one reference away from the API.

### 4. The administrative role must never be a runtime connection

DigitalOcean's `doadmin` is not a superuser but has `BYPASSRLS`, so it reads every tenant's rows with no
error and no log. It is correct for bootstrap and migrations and fatal at run time. Three layers, each
cheap:

1. **The renderer** refuses a database URL for the wrong role (§3).
2. **The production config** (`packages/core/src/config/production.ts`) refuses `doadmin` by name, next to
   `postgres`, `root` and `admin`, with the same rule that already refuses development passwords.
3. **A startup assertion**, new here: in production the API (`DatabaseService.onModuleInit`) and the worker
   (`main.ts`) ask the server what each of their connections' roles can do (`readPoolRole`, from
   `pg_roles`) and **refuse to start** if any is a superuser or has `BYPASSRLS`
   (`assertConnectedRoles`). It looks at the fact, not the name, so a renamed admin role is caught too. The
   pure rule is in `packages/core/src/config/production.ts` because that file already owns "what production
   refuses to run with" and is tested exhaustively without a database; the query is in `packages/db` because
   only that package may open a connection (ADR-0002). Fails closed: if the database cannot be reached at
   boot the process does not listen.

   Rehearsed, not just unit-tested: against a real Postgres the API exits 1 with
   `DATABASE_URL connects as role "…", which has BYPASSRLS` for a BYPASSRLS role with an innocuous name, and
   serves `/api/v1/health` and `/health/ready` for the normal roles; the worker does the same.

### 5. Vercel: the region default is the trap

Vercel Functions default to `iad1` (Washington, D.C.) for new projects. Unpinned, every Indian request
would be served from the United States and every call from the web app to the API would cross the planet
and back. `apps/web/vercel.json` sets `"regions": ["bom1"]`. The plan constraint, as Vercel documents it:
Hobby is limited to a single function region, Pro to five, Enterprise to all, and **automatic failover to
another region is Enterprise-only**. So Hobby can run `bom1` alone (it is not strictly a Pro feature), but
Vercel's terms restrict Hobby to non-commercial use (check the current wording) and the pilots are commercial: use **Pro**, and expect that a `bom1`
outage is an outage of the web app (the API in `blr1` stays up; sessions are intact). The build commands
in `vercel.json` build only the web app and what it depends on.

## Open questions (an owner decision is needed)

1. **TLS to the database does not verify against DigitalOcean's certificate, and the API will not connect.**
   Measured on the installed `pg` 8.23.1: `sslmode=require` is treated as `verify-full`, and a certificate
   from a private CA fails with `DEPTH_ZERO_SELF_SIGNED_CERT` (reproduced against a self-signed server;
   DigitalOcean's cluster CA is a private one, so I expect the same; that part is inferred, not observed). The same library prints a warning that in
   `pg` 9 `require` will become libpq's weaker, non-verifying meaning, so the meaning of the URL we ship
   will change under us on an upgrade. Options, with a recommendation:
   - **A (recommended): accept the provider's CA explicitly.** Add `DATABASE_CA_CERT` (the PEM, which is
     public) and have `createDbClient` pass it as `ssl: { ca, rejectUnauthorized: true }`, stripping `sslmode`
     from the URL (as I understand `pg`, the URL's parameters are merged over the `ssl` option; confirm when implementing). ~20 lines in `packages/db/src/client.ts`, no
     new dependency, tested by `deploy/check-app-connection.mjs` and a TLS test. Server identity is
     verified.
   - **B:** bake the CA file into the images and set `NODE_EXTRA_CA_CERTS`. No code change, but the CA
     rotating means rebuilding every image.
   - **C: `sslmode=require&uselibpqcompat=true`.** Encrypted but the server is not authenticated. Acceptable
     for a throwaway staging smoke test only; not for personal data.

   Until one is chosen the system cannot be deployed. `check-app-connection.mjs` reports which of these
   you are in on the real cluster. This needs a change in `packages/db`, which this task did not make.

2. **Public endpoints with trusted sources, or a VPC?** The spec uses public hostnames, TLS, and the
   cluster's **Trusted Sources** restricted to the app. App Platform can join a VPC for private hostnames;
   whether that is available and sensible in `blr1` was not verified. Worth doing before the first customer,
   not before the first rehearsal.
3. **Valkey is provisioned but unused until Redis-backed rate limiting lands** (the worker uses none; the
   API only warns when `REDIS_URL` is empty). It costs money from the moment it exists; create it when that
   work merges, not before.

## Found on the way, not fixed here (each needs an owner)

- **The web proxy never forwards the end user's IP to the API** (`FORWARDED_REQUEST_HEADERS` has three
  entries). Behind Vercel the API sees Vercel's egress addresses, so the per-IP limit on sign-in, sign-up
  and reset counts many strangers as one client, and the audit log's `ip_address` is Vercel's. Separately
  the API runs Fastify with `trustProxy: true`, which trusts a client-supplied `X-Forwarded-For`. Fixing it
  properly means the proxy forwarding Vercel's client address and the API trusting exactly one hop; that is
  application code in two apps and a security decision, not configuration.
- **The worker logs a "REDIS_URL is not set" warning** although it uses no Redis (it shares the API's
  production config). Harmless noise; the spec does not give it the variable.

## Consequences

- A fresh cluster can be proven (or shown not to work) in minutes with `verify-managed-postgres.sh probe`,
  which leaves nothing behind. Nothing here provisions anything; every cloud action is the owner's.
- Rollback of code is a redeploy of the previous tag; the schema stays (forward-only, RUNBOOK §3).
- The platform is cheap to leave: nothing outside `deploy/` knows it exists, and the images, the env
  contract and the role model are the same as the compose example.
