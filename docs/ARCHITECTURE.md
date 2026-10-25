# Architecture

One page on how the system is put together, for someone about to change it or run it. Each section ends with
where the decision is recorded; the [ADR index](adr/README.md) has all of them.

## The shape

Three programs, one database.

```
 browser ──► web (Next.js) ──► api (NestJS, /api/v1) ──► Postgres 16
                                     │                       ▲
                                     └─► object store        │
                                                  worker ────┘   (reads the outbox, does background work)
```

| Program  | Where         | What it does                                                                                                                                                         |
| -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`    | `apps/web`    | The user interface. No business logic and no database access. Talks only to the API.                                                                                 |
| `api`    | `apps/api`    | The only program that serves requests and the only one an end user's session reaches. REST, `/api/v1`.                                                               |
| `worker` | `apps/worker` | Reads the outbox and does what must not happen inside a request: search indexing, timeline, notifications, imports and exports, data-rights jobs, recycle-bin purge. |

The shared code is in `packages/`:

| Package          | Holds                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@crm/core`      | Pure domain rules with no I/O: the permissions engine, field types, money, dates, deployment modes, entitlements, the production-configuration guard. |
| `@crm/contracts` | Zod schemas for every API request and response, and the OpenAPI document generated from them (`docs/openapi.json`).                                   |
| `@crm/db`        | The Drizzle schema, forward-only SQL migrations, row-level-security policies, the role bootstrap, the demo seed.                                      |
| `@crm/env`       | The configuration registry and the loaders: the only code that reads `process.env`.                                                                   |
| `@crm/storage`   | The file-storage interface and its S3-compatible and in-memory implementations.                                                                       |
| `@crm/outbound`  | Outbound email providers (Resend, Amazon SES, SMTP) and the guarded HTTP client every outbound call goes through.                                     |
| `@crm/ui`        | Design-system components and the brand-colour rules.                                                                                                  |
| `@crm/config`    | Lint, TypeScript and Tailwind presets. Tooling only; never a runtime dependency.                                                                      |

API modules live in `apps/api/src/modules/<module>/` (accounts, contacts, leads, deals, pipelines, activities,
search, imports, exports, attachments, audit, recycle-bin, data-rights, access, customization, onboarding,
dashboard, notifications, invitations). **A module talks to another only through its service's public methods or
through events, never through another module's repository or tables.** The API is one deployable on purpose
([ADR-0001](adr/0001-modular-monolith.md)).

## Tenant isolation

Every company is a tenant, and every tenant-owned table has a `tenant_id` and a row-level-security policy
([ADR-0002](adr/0002-shared-db-tenant-id-rls.md)). Every request runs in a transaction that sets the tenant and
user for that transaction only, so the database itself refuses a row that belongs to someone else, even if a
query forgets a `WHERE`.

The application connects as five database roles, none of which can bypass row-level security or owns a table
(`packages/db/sql/bootstrap/01-extensions-and-roles.sql`):

| Role           | Used by                    | Can                                                                                                                                       |
| -------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `crm_app`      | the API's requests         | Tenant-scoped access to business data, through the policies.                                                                              |
| `crm_auth`     | sign-in, operator commands | The identity tables, workspace creation, and the operator-only writes (entitlement overrides, key rotation). No business data.            |
| `crm_worker`   | the worker                 | Like `crm_app`, plus reading the outbox across tenants.                                                                                   |
| `crm_erasure`  | the worker, one job        | Redacting audit history for one subject's erasure request, one column ([ADR-0032](adr/0032-erasure-against-an-append-only-audit-log.md)). |
| `crm_migrator` | migrations only            | Owns the schema. Never given to a running program.                                                                                        |

In production the API and the worker **refuse to start** if a connection runs as a role that is a superuser or can
bypass row-level security. This is the same in every deployment mode: a single-tenant installation is one tenant,
not a different way of reading data ([ADR-0046](adr/0046-deployment-modes-and-the-setup-command.md)).

## Authorization

Every endpoint asks one function, `can(actor, action, resource)`, in `@crm/core`; there are no inline role checks,
and the default is deny ([ADR-0008](adr/0008-central-policy-engine.md)). A role grants an action on an object with
a scope (own, team or all). Field-level permissions are applied when a record is serialised: a hidden field is
removed from responses and rejected on write. A record outside a person's scope is a 404, not a 403.

What a workspace's plan includes is a separate question, asked after `can()`: `entitlements.has(feature)`
([ADR-0047](adr/0047-entitlements-plans-features-and-overrides.md)).

## Events and background work

A state change writes its event into `outbox_events` in the **same transaction** as the change
([ADR-0006](adr/0006-transactional-outbox.md)). The worker polls that table and hands each event to its handlers,
inside a transaction scoped to that event's tenant, so handlers run under the same policies as the API. Delivery is
at least once, so every handler is idempotent. A service never calls a search index, an email provider or a
webhook directly.

## Configuration, branding and modes

All configuration is environment variables, declared once in the registry in `packages/env`, each with its scopes,
whether it is secret, its default and where to get it. [CONFIGURATION.md](CONFIGURATION.md), `.env.example` and the
staging and production templates are generated from it, and CI fails if they are stale
([ADR-0044](adr/0044-configuration-registry.md)). The web app may hold only the few variables it needs, and refuses
to start outside local development if it holds a secret meant for another program.

Two settings change what the installation is: `DEPLOYMENT_MODE` (`multi_tenant` lets strangers sign up and get a
workspace; `single_tenant` closes sign-up and holds one workspace, made by the operator) and the branding variables
([ADR-0045](adr/0045-instance-branding-and-new-workspace-defaults.md)).

## Providers

Everything outside the process sits behind an interface, so a vendor is a configuration choice
([ADR-0009](adr/0009-provider-interfaces.md)): email (`console`, `memory`, Resend, Amazon SES, SMTP), file storage
(any S3-compatible store), search (Postgres full-text behind a `SearchProvider`). Files go from the browser to the
store through short-lived presigned URLs and never through the API. See [PROVIDERS.md](PROVIDERS.md).

## Authentication and secrets

Sessions are random tokens stored hashed in the database; the browser holds one in an httpOnly cookie that the web
app attaches server-side, so script on a page never sees it. Passwords are hashed with Argon2id and old hashes are
upgraded at sign-in ([ADR-0050](adr/0050-argon2id-password-hashing.md)). Authenticator secrets are encrypted at
rest under a key ring that supports rotation ([ADR-0049](adr/0049-key-ids-and-rotating-auth-secret.md)). Every
secret, who holds it and how to rotate it is in [SECRETS.md](SECRETS.md).

## Where the code differs from what you may have read

`CLAUDE.md` lists **Redis and BullMQ** in the stack. Today there is **no queue**: the worker polls the outbox
table, and Redis is optional because nothing reads `REDIS_URL` yet (rate limits are counted per process, so
running several API instances multiplies them: [RUNBOOK.md](RUNBOOK.md) §8). Treat the stack table as the
direction, and this page as what is built.
