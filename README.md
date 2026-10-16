# CRM Platform

A multi-tenant, web-based SaaS CRM. See [`docs/MVP_SPEC.md`](docs/MVP_SPEC.md)
for what it does and [`CLAUDE.md`](CLAUDE.md) for the rules every change follows.

Priorities, in order: **Security → Correctness → Speed/UX → Features.**

## Getting started

Requires Node 24+, pnpm 9, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # Postgres on 15432, Redis on 16379
pnpm db:migrate
pnpm db:seed           # prints session tokens for the demo users
pnpm build             # shared packages compile to dist; apps resolve them from there
pnpm dev               # web :3000, api :3001, worker
```

Then open http://localhost:3000/sign-in and paste one of the tokens the seed
printed. Signing in as the **Owner** shows every contact; the **Sales rep** sees
only their own, which is record scope working end to end.

> Email-and-password sign-in, MFA and Google sign-in are not built yet
> (MVP_SPEC M1). The sign-in screen takes a session token so the app is usable
> before that lands; it does not authenticate anybody. See
> [ADR-0014](docs/adr/0014-self-hosted-auth.md).

### Ports

Postgres and Redis are published on **15432** and **16379**, not their defaults,
because a machine that already runs either of them would otherwise end up with
two listeners on one port and connections landing somewhere surprising.

## Commands

| Command                             | What it does                                                  |
| ----------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                          | Web, API and worker together                                  |
| `pnpm build`                        | Compiles shared packages and builds the apps                  |
| `pnpm test`                         | Unit and integration tests                                    |
| `pnpm test:security`                | Tenant isolation and permission suites — **must always pass** |
| `pnpm test:e2e`                     | Playwright, against a running stack                           |
| `pnpm lint` / `pnpm typecheck`      | Static checks                                                 |
| `pnpm db:migrate` / `pnpm db:seed`  | Schema and demo data                                          |
| `pnpm infra:up` / `pnpm infra:down` | Local Postgres and Redis                                      |

## How it fits together

```
apps/web      Next.js. Talks only to /api/v1, through a proxy route that
              attaches the session token server-side so it never reaches JS.
apps/api      NestJS modular monolith. The only thing that touches the database.
apps/worker   Drains the transactional outbox; projects timelines.

packages/core        Permissions engine, field metadata, money, dates, ids.
packages/db          Drizzle schema, SQL migrations, RLS policies, seed.
packages/contracts   Zod schemas shared by API and web.
packages/ui          Design system.
packages/config      ESLint, tsconfig and Tailwind presets.
```

Decisions that would be expensive to reverse are recorded in
[`docs/adr/`](docs/adr/README.md) — read ADR-0002 (tenant isolation) and
ADR-0008 (the permission engine) before touching either.

## The things that must stay true

Four mechanisms carry tenant isolation, and all four are required:

1. Every tenant table has `ENABLE` **and** `FORCE ROW LEVEL SECURITY`.
2. Its policy compares `tenant_id` to `current_tenant_id()`.
3. That value comes from a `SET LOCAL` issued by `withTenant()`, which is the
   only way to open a transaction.
4. No application role owns a table, is a superuser, or has `BYPASSRLS`.

A test in `packages/db` fails if a table carrying `tenant_id` is ever added
without the first point. `pnpm test:security` is a required CI gate and is never
made optional.
