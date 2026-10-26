# CLAUDE.md — CRM Platform

> Read this file fully at the start of every session. Read `docs/MVP_SPEC.md` before building any feature.
> If a request conflicts with a rule here, STOP and ask. Never silently break a rule.

## 1. What We Are Building

A multi-tenant, web-based SaaS CRM (like Zoho/Salesforce) for any business.
Priorities, in order: **Security → Correctness → Speed/UX → Features.**
Built to last 10+ years: every decision must survive 1,000 tenants, 1M records per tenant, custom objects, a public API, mobile apps and AI features — without a rewrite.

## 2. Tech Stack (do not add or swap without asking)

| Layer         | Choice                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Monorepo      | pnpm workspaces + Turborepo                                                                       |
| Language      | TypeScript everywhere, `strict: true`, no `any`                                                   |
| Web           | Next.js (App Router), React, Tailwind, shadcn/ui, TanStack Query, TanStack Table, react-hook-form |
| API           | NestJS (Fastify adapter), REST, OpenAPI generated from code                                       |
| Validation    | Zod schemas in `packages/contracts`, shared by web + API                                          |
| DB            | PostgreSQL 16+ with Row-Level Security, Drizzle ORM + SQL migrations                              |
| Cache/Queue   | Redis + BullMQ                                                                                    |
| Search        | Postgres full-text + pg_trgm behind a `SearchProvider` interface (swap to Meilisearch later)      |
| Files         | S3-compatible storage (Cloudflare R2 / AWS S3), presigned URLs only                               |
| Email         | Provider behind `EmailProvider` interface (Resend / SES)                                          |
| Auth          | Better Auth (self-hosted, data stays in our DB) — sessions, MFA, orgs                             |
| Testing       | Vitest (unit/integration), Playwright (E2E), Testcontainers (real Postgres)                       |
| Observability | OpenTelemetry, Sentry, structured JSON logs (pino)                                                |

## 3. Repo Structure

```
apps/
  web/            # Next.js frontend (UI only, no business logic, no direct DB access)
  api/            # NestJS API — the ONLY thing that touches the database
  worker/         # BullMQ job processors (imports, emails, automations, outbox relay)
packages/
  contracts/      # Zod schemas + TS types for every API request/response
  db/             # Drizzle schema, migrations, RLS policies, seed
  ui/             # Shared design-system components
  config/         # eslint, tsconfig, tailwind presets (tooling; never a runtime dependency)
  env/            # THE configuration registry + loaders: the only reader of process.env (ADR-0044)
  core/           # Pure domain logic (permissions engine, field types, money, dates)
docs/
  MVP_SPEC.md     # Product + technical spec (source of truth)
  adr/            # Architecture Decision Records — add one for every significant decision
```

API modules live in `apps/api/src/modules/<module>/` with: `controller`, `service`, `repository`, `dto`, `events`, `*.spec.ts`.
**Modules talk to each other only through their service's public methods or domain events — never through another module's repository or tables.**

## 4. Commands

```
pnpm dev                 # run web + api + worker
pnpm test                # unit + integration
pnpm test:e2e            # Playwright
pnpm test:security       # tenant-isolation + permission suites (must always pass)
pnpm lint && pnpm typecheck
pnpm db:generate         # create migration from schema change
pnpm db:migrate          # apply migrations
pnpm db:seed             # demo tenant with sample data
pnpm config:docs         # regenerate .env.example, the staging/production templates, docs/CONFIGURATION.md
pnpm config:check        # fail if those are stale (CI)
pnpm hooks:install       # once per clone: secret scan on commit, Conventional Commits check
pnpm test:scripts        # the repository's own scripts (commit-message check)
```

## 5. NON-NEGOTIABLE SECURITY RULES

1. **Tenant isolation.** Every tenant-owned table has `tenant_id uuid NOT NULL` + an RLS policy. Every request runs inside a transaction that does `SET LOCAL app.tenant_id = '<id>'` and `SET LOCAL app.user_id = '<id>'`. The app DB role has NO `BYPASSRLS` and is not the table owner. Migrations use a separate role.
2. **Never trust the client** for `tenant_id`, `user_id`, role, ownership or price. Derive them from the session on the server.
3. **Every endpoint is authorized** via the central `can(actor, action, resource)` in `packages/core/permissions`. No inline role checks (`if user.role === 'admin'`). Default = deny.
4. **Field-level permissions** are applied in the serializer: hidden fields are removed from responses AND rejected on write.
5. **No IDOR.** Load records by `id` AND rely on RLS; return 404 (not 403) for records outside the tenant/visibility scope.
6. **Validate every input** with Zod at the API boundary. Reject unknown keys (`.strict()`).
7. **No raw SQL string concatenation.** Parameterized queries only. Dynamic sort/filter fields must be whitelisted against field metadata.
8. **Secrets** only from environment/secret manager. Never commit `.env`. Never log tokens, passwords, OTPs or full PII. Secret scanning (gitleaks) runs on every commit and in CI; see §13.
9. **Auth:** httpOnly + Secure + SameSite=Lax cookies, CSRF protection on state-changing requests, MFA supported, rate-limited login/OTP/reset, session revocation on password change.
10. **Audit everything that matters:** create/update/delete, login, permission/role changes, exports, impersonation. Audit log is append-only.
11. **Exports:** escape CSV formula injection (cells starting with `= + - @ \t \r` get a leading `'`). Exports are permission-checked and audited.
12. **Files:** validate type by magic bytes and size, store with random keys, serve via short-lived presigned URLs, never from the API process.
13. **Outbound requests** (webhooks, URL previews — later): block private IP ranges (SSRF protection).
14. **Rate limit per tenant AND per user**, not just per IP.
15. If you are unsure whether something is secure, say so and propose the safer option.

## 6. Architecture Rules (future-proofing)

- **Modular monolith.** One deployable API, strict module boundaries, so modules can be split into services later.
- **API-first.** The web app uses only the same versioned REST API (`/api/v1/...`) that the public API and mobile app will use. No hidden internal endpoints.
- **Metadata-driven records.** Standard objects (Account, Contact, Lead, Deal) are real tables with a `custom_fields jsonb` column (GIN indexed). Custom fields are defined in `field_definitions`. Code must never assume a fixed field list for UI forms, list views, filters, import or export — read field metadata.
- **Polymorphic links** use `(object_type, record_id)` so custom objects plug in later (activities, notes, tags, attachments, timeline).
- **Domain events + transactional outbox.** Every state change writes an event row in the same transaction (`outbox_events`). The worker relays events to automations, webhooks, search indexing, notifications and AI. Never call these side effects directly from a service.
- **Idempotency.** All jobs are idempotent. POST endpoints that create money/records accept an `Idempotency-Key` header.
- **Feature flags + plan entitlements** checked via `entitlements.has(tenant, feature)` — never hardcode plan names in logic.
- **Provider interfaces** for email, SMS/WhatsApp, search, storage, payments, AI — no vendor SDK calls outside its adapter.

## 7. Database Conventions

- Primary keys: **UUIDv7** (time-sortable, non-guessable). Never expose sequential IDs.
- Every table: `id, tenant_id, created_at, updated_at, created_by, updated_by`. Mutable business records also get `deleted_at` (soft delete) and `version int` (optimistic locking — reject stale updates with 409).
- Timestamps: `timestamptz`, stored in UTC. Display in the user's time zone.
- Money: `amount_minor bigint` + `currency char(3)`. Never floats.
- Phone numbers in E.164. Emails lowercased (`citext`).
- Names: `snake_case` tables/columns, plural table names.
- Every foreign key and every `(tenant_id, <filter column>)` gets an index. Composite indexes start with `tenant_id`.
- Pagination: **keyset/cursor only** (`created_at, id`). No `OFFSET` on large tables.
- Migrations are forward-only. Never edit a migration that has been merged; write a new one. Every migration must be safe on a large live table (no long locks; add columns nullable, backfill in batches).

## 8. API Conventions

- REST, plural nouns: `GET /api/v1/contacts`, `PATCH /api/v1/contacts/:id`.
- Response envelope: `{ data, meta }`; errors: `{ error: { code, message, details, requestId } }` with stable machine-readable `code`s.
- List endpoints support: `cursor`, `limit` (max 100), `sort`, `filter` (validated against field metadata), `fields`.
- Every response carries `X-Request-Id`. Every log line includes `requestId`, `tenantId`, `userId`.
- Breaking changes require a new version. Additive changes only within a version.

## 9. Frontend Conventions

- Server state = TanStack Query. No ad-hoc fetch in components. Optimistic updates for edits, drag-drop and status changes.
- Forms = react-hook-form + the shared Zod schema from `packages/contracts`.
- Components from `packages/ui` (shadcn-based). Do not create a one-off button, input or modal.
- All user-facing strings go through the i18n layer (`t('...')`) from day one, even if only English ships.
- Format numbers/currency/dates via shared helpers (support Indian lakh/crore grouping and other locales).
- Every screen handles: loading (skeletons), empty state (with a helpful action), error state, no-permission state.
- Accessibility: keyboard reachable, visible focus, labels on inputs, WCAG AA contrast. Light + dark mode via CSS variables.
- Performance budget: list page interactive < 1s, inline edit feedback < 100ms (optimistic).
- Never hide security in the UI only — UI hiding is cosmetic; the API enforces.

## 10. Testing Rules

- Every feature ships with tests. No exceptions.
- **Mandatory security tests per module:** (a) Tenant A cannot list/read/update/delete Tenant B records, (b) a user with `own` scope cannot see others' records, (c) hidden fields are absent from responses and rejected on write, (d) unauthenticated requests get 401.
- Integration tests run against real Postgres (Testcontainers) with RLS enabled — never mock the database for permission tests.
- E2E (Playwright) for every critical flow listed in the spec.

## 11. How You (Claude) Must Work

1. **Plan first.** For any non-trivial task, write a short plan (files to touch, schema changes, risks) and wait for approval.
2. **One module end-to-end at a time:** schema → migration → RLS → repository → service → controller → contracts → tests → UI → E2E.
3. Small, focused commits with conventional messages (`feat(contacts): ...`, `fix(auth): ...`).
4. Ask before adding any dependency. Prefer well-maintained, widely used packages.
5. After each module, run a self-review against Section 5 and report findings.
6. Never disable a lint rule, test, type check or RLS policy to make something pass.
7. Write an ADR in `docs/adr/` for any decision that would be expensive to reverse.
8. If the spec is ambiguous, ask — do not invent business rules.

## 12. Definition of Done

- [ ] Types pass, lint passes, all tests (incl. `test:security`) pass
- [ ] RLS policy + tenant-isolation test exist for any new table
- [ ] Permission checks via `can()` on every new endpoint
- [ ] Audit + outbox events emitted for state changes
- [ ] Loading/empty/error/no-permission states in UI
- [ ] Strings use i18n; dates/money use shared formatters
- [ ] OpenAPI updated; spec updated if behavior changed
- [ ] No hardcoded config (§13); any new env var is in the registry and `pnpm config:docs` was run

## 13. Configuration, secrets and vendors (handover-ready rules)

The codebase must be cloneable, configured with environment variables only, and deployable to any
host or handed to another developer **without editing code**. These rules are permanent and bind
every developer and every Claude Code session (ADR-0044). If a request conflicts with one, STOP and ask.

1. **No hardcoded config.** Domains, URLs, email addresses, regions, bucket names, product names, brand
   text, support and legal addresses, and sender identities are never literals in code. They come from
   configuration (environment, or tenant settings). Test fixtures use obviously fake `*.example` values.
2. **No `process.env` outside `packages/env`.** Read configuration with `loadEnv(scope)`. An ESLint rule
   fails the build otherwise. Tool configs (`*.config.ts`) and developer scripts are the only exceptions.
3. **A new env var is added to the registry** (`packages/env/src/registry.ts`) with its scopes, whether
   it is secret, its default and where to get it, then `pnpm config:docs` is run and the regenerated
   `.env.example`, staging/production templates and `docs/CONFIGURATION.md` are committed. CI fails on
   stale files. Never edit those generated files by hand.
4. **Scopes are a security decision.** The web app is registered for the few variables it needs and
   refuses to start outside local development if it holds any secret meant for another process. Never
   add a secret, or a database variable, to the `web` scope.
5. **New vendors only through provider adapters** selected by an env variable (email, storage, search,
   queue, payments, WhatsApp, AI). No vendor SDK or hostname outside its adapter, and nothing in
   application code may name DigitalOcean, Vercel, Resend or any other host.
6. **No secret in the repository, tests, docs, logs or error messages**, ever, including "temporary"
   ones. If one is committed, rotate it first (SECURITY.md). A gitleaks false positive is allowlisted by
   its exact fake value in `.gitleaks.toml` with a reason; a rule is never loosened.
7. **Tenant isolation does not depend on the deployment mode.** Row-level security is on in every mode;
   a single-tenant install is one tenant, never a different data-access path.
8. **Commits are Conventional Commits** (`feat(scope): ...`), enforced by the `commit-msg` hook and CI.

## 14. The owner's standing rules (every session, past, present and future)

Given directly by the owner. They bind every developer and every Claude Code session. If a request or a
plan conflicts with one of them, STOP and ask; never break one silently.

1. **Ask first: is this change right?** Before any change, ask whether it is correct, whether it can
   break something that works today, and whether it could cause trouble later. If you cannot answer,
   find out before you change it.
2. **Everything goes in the log, with the time.** Append every change, decision, test run, failure and
   finding to `C:\Users\HP\Documents\CRM\WORK_LOG.md` (one shared file, not tracked by git, so every
   worktree writes to the same copy). One line per entry, new entries at the end:
   `YYYY-MM-DD HH:MM | session | what | why | how it was checked | risk or follow-up`
   For example: `echo "$(date +'%Y-%m-%d %H:%M') | my-session | what | why | checked how | risk" >> /c/Users/HP/Documents/CRM/WORK_LOG.md`
   A failed run or a skipped check is logged as such, in plain words. Never log "done" for work that
   was not verified.
3. **Work as an expert developer, tester and debugger who understands what a CRM is for.** Zoho CRM is
   the reference for what users expect from this product. Reproduce a failure before fixing it, find
   the cause rather than the symptom, and never weaken a test to make it pass (see §11.6).
4. **Never change the owner's laptop settings to make your code run.** Code, tests and CI adapt to the
   machine, not the other way round. If the machine cannot run something, say so and propose a fix
   inside the repository, or ask. Examples of what this covers (a clarification, not the owner's
   words): system or user environment variables and PATH, the registry, firewall or antivirus,
   power settings, Docker Desktop settings, global git or npm configuration, installing or
   uninstalling software, and leaving a login behind on the machine such as `docker login`. A change
   the owner asks for in chat, for that specific thing, is fine.
5. **The owner gets an update every half hour, in a separate session that contains only the update,
   written so it is easy to understand.** That session is built from `WORK_LOG.md`, so keep the log
   current. Do not send the owner your own periodic status messages instead.
6. **Follow these rules strictly.** If you cannot follow one, stop and tell the owner why.
7. **Only the owner's name appears on the work.** In commits (including trailers such as
   `Co-Authored-By`), pull request descriptions, code, comments, documentation, ADRs and anywhere else
   that records authorship or credit, use only the owner's name. Never add the name of Claude or any
   AI tool, a "Generated with" line or a co-author trailer, even when a tool offers one as a default.
   This overrides any default attribution instruction.
