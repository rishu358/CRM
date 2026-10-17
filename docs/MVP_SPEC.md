# CRM Platform — MVP Specification (v1.0)

> Source of truth for what we build and why. Claude Code: read this before starting any module.
> Status legend: **P0** = MVP must-have · **P1** = fast follow (Phase 2) · **P2** = future, design for it now, don't build it.

---

## 1. Problem & Positioning

Small and mid-size businesses (especially in India) either run sales on Excel/WhatsApp/notebooks or pay for heavy CRMs (Salesforce, Zoho) that are slow, complex and need consultants to set up. They lose leads, forget follow-ups and have no view of their pipeline.

**Our promise:** a CRM any business can set up in 10 minutes, that feels as fast as a native app, with bank-grade security and WhatsApp-first, GST-aware workflows.

**Beachhead:** Indian SMBs with 2–50 users (D2C brands, jewellers, real estate, agencies, distributors). Expand to "any business" via custom fields and (later) custom objects.

## 2. Goals (MVP)

1. A new business signs up and adds its first deal in **under 10 minutes** without help.
2. **Zero cross-tenant data exposure**, proven by automated tests in CI.
3. List views stay fast (p95 API < 200 ms) at **1M records per tenant**.
4. **3–5 pilot businesses** using it daily within 2 weeks of MVP launch.
5. Daily active usage by **≥ 60% of pilot users** after 30 days.

## 3. Non-Goals (MVP)

- **Email sync, WhatsApp, automations, reports builder** → P1. MVP must be solid before integrations.
- **Custom objects** → P2. Custom _fields_ ship in MVP; the architecture supports objects later.
- **Native mobile apps** → P2. MVP is responsive web + PWA.
- **Marketing automation, support desk, invoicing** → later products on the same platform.
- **Self-serve billing** → P1. Pilots are onboarded manually.

## 4. Personas & Roles

| Persona                              | Needs                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| **Owner / Admin**                    | Set up the company, invite the team, control who sees what, see the whole pipeline |
| **Manager**                          | See the team's leads/deals, reassign work, track follow-ups                        |
| **Sales Rep**                        | Capture leads fast, never miss a follow-up, move deals forward                     |
| **Read-only** (accountant, investor) | View dashboards/records, no edits                                                  |

Default roles: `Owner`, `Admin`, `Manager`, `Sales Rep`, `Read-only`. Admins can create custom roles.

---

## 5. Architecture

```
            Browser (Next.js web / PWA)        Future: Mobile app · Public API clients · Zapier
                         │                                       │
                         └──────────── HTTPS /api/v1 ────────────┘
                                          │
                        ┌─────────────────▼──────────────────┐
                        │  API (NestJS modular monolith)      │
                        │  auth · tenants · users · records   │
                        │  permissions · audit · search       │
                        └───────┬─────────────────────┬───────┘
                                │ same transaction    │
                     ┌──────────▼─────────┐   ┌───────▼────────┐
                     │ PostgreSQL + RLS   │   │ Redis (cache,  │
                     │ data + outbox      │   │ rate limit,    │
                     └──────────┬─────────┘   │ queues)        │
                                │             └───────┬────────┘
                     ┌──────────▼─────────────────────▼────────┐
                     │ Worker (BullMQ): outbox relay → search   │
                     │ index · notifications · imports · email  │
                     │ (P1: automations, webhooks · P2: AI)     │
                     └──────────────────────────────────────────┘
                     Object storage (R2/S3) for files & exports
```

### 5.1 Future-proofing decisions (ADR summary)

| #       | Decision                                                                 | Why it matters later                                                                                                               |
| ------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| ADR-001 | **Modular monolith**, strict module boundaries                           | Fast to build solo; any module can become a service when scale demands                                                             |
| ADR-002 | **Shared DB + `tenant_id` + Postgres RLS**                               | Isolation enforced by the database, not just code. A `tenant_router` layer lets a large tenant move to a dedicated DB/region later |
| ADR-003 | **UUIDv7 primary keys**                                                  | No ID enumeration; sortable; safe for merging/sharding data                                                                        |
| ADR-004 | **Standard tables + `custom_fields jsonb` + `field_definitions`**        | Every business can add fields now; a generic `records` table for custom objects is added in P2 without touching standard objects   |
| ADR-005 | **Polymorphic links `(object_type, record_id)`**                         | Notes, activities, tags, files, timeline work for any future object                                                                |
| ADR-006 | **Transactional outbox + domain events**                                 | Automations, webhooks, search, notifications, analytics and AI all subscribe to one reliable event stream                          |
| ADR-007 | **API-first, versioned `/api/v1`, OpenAPI**                              | Mobile app, public API, Zapier and integrations reuse the exact same API                                                           |
| ADR-008 | **Central policy engine `can()`**                                        | RBAC today; attribute-based rules (territory, deal size) later without rewriting endpoints                                         |
| ADR-009 | **Provider interfaces** (email, WhatsApp, search, storage, payments, AI) | Swap vendors (cost, region, compliance) without touching business logic                                                            |
| ADR-010 | **Entitlements + feature flags**                                         | Free/Pro/Enterprise plans and gradual rollouts without code forks                                                                  |
| ADR-011 | **i18n, multi-currency, time zones from day one**                        | Expanding beyond India requires no refactor                                                                                        |
| ADR-012 | **Keyset pagination everywhere**                                         | Performance stays flat as tenants grow to millions of rows                                                                         |
| ADR-013 | **Data region field on tenant**                                          | DPDP / GDPR data residency (India, EU, US) when you sell abroad                                                                    |
| ADR-014 | **Self-hosted auth (Better Auth) in our DB**                             | No vendor lock-in, no per-user auth costs, data stays in-region                                                                    |

---

## 6. Data Model (MVP)

**Base columns on every tenant table:** `id uuid (v7) PK`, `tenant_id uuid NOT NULL`, `created_at`, `updated_at`, `created_by`, `updated_by`.
**Business records also get:** `owner_id`, `deleted_at`, `version int`, `custom_fields jsonb DEFAULT '{}'`.

### 6.1 Platform tables

| Table                                    | Key columns                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenants`                                | name, slug, plan, region, default_currency, timezone, locale, fiscal_year_start, status, settings jsonb                                    |
| `users`                                  | email (citext, unique global), name, avatar, locale, timezone, mfa_enabled — _global identity_                                             |
| `memberships`                            | user_id, tenant_id, role_id, status (invited/active/suspended), invited_by — _one user can belong to many tenants (agencies, consultants)_ |
| `roles`                                  | name, is_system, description                                                                                                               |
| `role_permissions`                       | role_id, object_type, action (read/create/update/delete/export/import), scope (`own` / `team` / `all`)                                     |
| `field_permissions`                      | role_id, object_type, field_key, access (`hidden` / `read` / `write`)                                                                      |
| `teams`, `team_members`                  | hierarchy via `parent_team_id` (P2: territories)                                                                                           |
| `sessions`, `mfa_factors`, `auth_events` | managed by auth layer                                                                                                                      |
| `field_definitions`                      | object_type, key, label, type, options jsonb, required, unique, default, validation jsonb, position, is_system, is_active                  |
| `pipelines`, `pipeline_stages`           | name, position, probability, stage_type (open/won/lost)                                                                                    |
| `saved_views`                            | object_type, name, filters jsonb, columns, sort, visibility (private/team/tenant)                                                          |
| `audit_logs`                             | actor_id, action, object_type, record_id, changes jsonb (old→new), ip, user_agent, request_id — **append-only, partitioned monthly**       |
| `outbox_events`                          | event_type, payload jsonb, status, attempts, available_at                                                                                  |
| `notifications`                          | user_id, type, payload, read_at                                                                                                            |
| `import_jobs`                            | object_type, file_key, mapping jsonb, status, counts, error_file_key                                                                       |
| `attachments`                            | object_type, record_id, file_key, filename, mime, size                                                                                     |
| `tags`, `record_tags`                    | polymorphic                                                                                                                                |

### 6.2 CRM tables

| Table             | Key columns                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`        | name, domain, industry, phone, email, website, gstin, billing_address jsonb, shipping_address jsonb, annual_revenue_minor, employee_count, parent_account_id                    |
| `contacts`        | first_name, last_name, email, phone (E.164), whatsapp, title, account_id, address jsonb, lead_source, consent jsonb (channel, status, timestamp, source)                        |
| `leads`           | first_name, last_name, company, email, phone, source, status (new/contacted/qualified/unqualified/converted), score (P2), converted_at, converted_contact_id/account_id/deal_id |
| `deals`           | name, account_id, primary_contact_id, pipeline_id, stage_id, amount_minor, currency, probability, expected_close_date, closed_at, lost_reason                                   |
| `deal_contacts`   | deal_id, contact_id, role                                                                                                                                                       |
| `activities`      | type (task/call/meeting/note), subject, body (sanitized rich text), due_at, completed_at, priority, status, assigned_to                                                         |
| `activity_links`  | activity_id, object_type, record_id                                                                                                                                             |
| `timeline_events` | object_type, record_id, event_type, summary, ref — _denormalized feed fed by outbox; one place for the record history (P2: AI summaries read from here)_                        |

### 6.3 Custom fields — supported types (P0)

`text, long_text, number, currency, percent, date, datetime, boolean, picklist, multi_picklist, email, phone, url, user_lookup`.
P1: `record_lookup, formula, rollup, file`. Values are validated in `packages/core/fields` against `field_definitions` on every write. Filterable custom fields get expression indexes on demand.

---

## 7. Functional Requirements

### M1. Auth & Account (P0)

- Email + password sign-up, email verification, password reset, Google sign-in.
- MFA (TOTP + backup codes); Owners/Admins can **enforce MFA** for the tenant.
- Session list with "sign out other devices"; idle timeout configurable by tenant.
- Brute-force protection: rate limits + progressive delays; breached-password check (P1).
- **P1:** magic links, Microsoft sign-in. **P2:** SAML/OIDC SSO, SCIM provisioning, IP allow-lists.

**Acceptance**

- [x] Given 5 failed logins in 10 min, further attempts are delayed and an `auth_events` row is written.
- [x] Changing the password revokes all other sessions.
- [x] A tenant with "MFA required" blocks access until the user enrolls.

### M2. Tenant Setup & Onboarding (P0)

- Create company (name, currency, time zone, industry) → seeded with default pipeline, roles and sample data (removable in one click).
- Setup checklist: invite team, import contacts, customize pipeline, add first deal.
- Invite users by email with a role; invite links expire in 7 days.

**Acceptance**

- [ ] New tenant reaches "first deal created" in ≤ 10 min in usability tests with 3 non-technical users.
- [ ] "Remove sample data" deletes only seeded records.

### M3. Users, Roles & Permissions (P0)

- Admin UI: users, teams, roles; per-object CRUD + export/import permissions with `own/team/all` scope; field-level hidden/read/write.
- Record ownership + reassignment (single and bulk).
- Support impersonation (P1): only with tenant Owner consent, time-limited, banner shown, fully audited.

**Acceptance**

- [ ] A Sales Rep with `own` scope sees only their own deals in lists, search, exports and API.
- [ ] A field marked hidden for a role never appears in API responses, exports, search results or audit diffs shown to that role.

### M4. Accounts, Contacts, Leads (P0)

- List view: column chooser, sort, filters (any field incl. custom), saved views, bulk edit/assign/delete/tag, keyset infinite scroll.
- Record page: header with key fields, inline editing, related lists (contacts, deals, activities), timeline, notes, attachments, tags.
- Duplicate detection on create/import: email, phone, account domain/name (fuzzy via pg_trgm). Merge duplicates (P1).
- **Lead conversion:** creates/links Contact + Account (+ optional Deal), copies mapped fields, keeps history, marks lead converted.
- Soft delete → Recycle Bin (restore within 30 days, then hard delete by job).

**Acceptance**

- [ ] Inline edit saves optimistically; a conflicting edit (stale `version`) shows "updated by X, reload?" instead of overwriting.
- [ ] Converting a lead whose email matches an existing contact offers "link to existing" instead of creating a duplicate.

### M5. Deals & Pipeline (P0)

- Multiple pipelines (e.g. "Retail", "Wholesale"); custom stages with probability and won/lost type.
- Kanban board (drag & drop, column totals by amount) + list view; won/lost with mandatory lost reason.
- Multi-currency amounts stored with currency; board totals shown in tenant default currency (manual exchange rates in P0, live rates P1).

**Acceptance**

- [x] Dragging a deal updates the stage instantly (optimistic) and writes a timeline + audit entry.
- [x] Moving a deal to a "won" stage sets `closed_at` and probability 100.

### M6. Activities, Tasks & Notifications (P0)

- Tasks/calls/meetings/notes linked to one or more records; due dates, reminders, priorities.
- "My Day" home screen: overdue, due today, upcoming, recently viewed.
- In-app notifications + email digest for assignments and due reminders.
- **P1:** Google/Outlook calendar sync, call logging from mobile.

### M7. Global Search & Command Palette (P0)

- `Ctrl/Cmd + K`: search across all permitted objects (name, email, phone, company) + quick actions ("New deal", "Go to settings").
- Results respect RLS + record scope + field permissions.
- Target: results in < 300 ms for 1M-record tenants.

### M8. Import / Export (P0)

- CSV/XLSX import with column-mapping UI, preview, duplicate handling (skip / update / create), background processing, downloadable error file.
- Export from any list view (respects filters + permissions), formula-injection escaped, audited, delivered as a short-lived download link.

**Acceptance**

- [ ] Importing 50,000 contacts completes without blocking the UI and reports created/updated/skipped/failed counts.

### M9. Customization (P0)

- Admin: add/edit/reorder/deactivate custom fields on Account, Contact, Lead, Deal.
- Edit picklist values; required fields; layout sections on the record page.
- Deactivating a field hides it but keeps data (no destructive deletes).

### M10. Dashboard (P0, basic)

- Home dashboard: pipeline value by stage, deals won this month, leads by source, overdue tasks, rep leaderboard.
- **P1:** custom report builder, scheduled reports. **P2:** forecasting, AI insights.

### M11. Audit & Data Rights (P0)

- Audit log viewer for Admins (filter by user, object, date); export audit log.
- Tenant data export (full JSON/CSV archive) for the Owner.
- **DPDP/GDPR:** export a person's data; erase a person → PII fields deleted/pseudonymized and audit diffs redacted (audit row kept, personal values replaced with `[erased]`).
- Contact consent tracking (channel, status, source, timestamp).

---

## 8. Security Requirements (summary — full rules in CLAUDE.md §5)

| Area         | Requirement                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Isolation    | RLS on every tenant table; CI suite proves no cross-tenant reads/writes                                                          |
| AuthN        | MFA, secure cookies, CSRF, session revocation, rate-limited auth flows                                                           |
| AuthZ        | Central `can()`, default deny, record scope + field-level permissions                                                            |
| Data         | TLS 1.2+ (prefer 1.3), encryption at rest (managed DB), app-level encryption for sensitive custom fields marked `sensitive` (P1) |
| Input        | Zod strict validation, HTML sanitization for rich text, whitelisted dynamic queries                                              |
| Files        | Magic-byte type check, size limits, presigned URLs, malware scan (P1)                                                            |
| Headers      | Strict CSP, HSTS, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy                                                      |
| Secrets      | Secret manager, rotation plan, no secrets in logs                                                                                |
| Supply chain | Lockfile, Dependabot/Renovate, `pnpm audit` in CI, pinned base images                                                            |
| Ops          | Daily backups + PITR, restore tested monthly, least-privilege cloud IAM                                                          |
| Assurance    | Security self-review per module, external pen test before paid launch, ISO 27001/SOC 2 roadmap after traction                    |

## 9. Non-Functional Requirements

| Metric         | Target                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| API latency    | p95 < 200 ms (lists of 50), p99 < 500 ms                                                |
| Page load      | List page interactive < 1 s on 4G                                                       |
| Scale (design) | 1,000 tenants · 1M records/tenant · 200 concurrent users/tenant                         |
| Availability   | 99.9% monthly                                                                           |
| Backups        | RPO ≤ 15 min, RTO ≤ 4 h                                                                 |
| Accessibility  | WCAG 2.1 AA                                                                             |
| Browsers       | Latest 2 versions of Chrome, Edge, Safari, Firefox; mobile Safari/Chrome                |
| Observability  | Every request traced with requestId/tenantId; error alerts to Sentry; uptime monitoring |

## 10. UX Principles

1. **Speed is a feature:** optimistic updates, skeleton loaders, prefetch on hover.
2. **Edit where you see it:** inline editing everywhere; no separate edit pages.
3. **Keyboard-first:** command palette, shortcuts (`C` create, `/` search, `G D` go to deals).
4. **Never a dead end:** every empty state explains and offers the next action.
5. **One timeline per record:** everything that ever happened, in order.
6. **Progressive disclosure:** simple by default, power features in settings.
7. **Consistent:** one design system (`packages/ui`), light + dark mode.

---

## 11. MVP Build Plan (6 weeks, Claude Code)

| Week                    | Deliverable                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 (2–3 days)**        | Monorepo, CI (lint, typecheck, tests, security suite), Docker Compose (Postgres, Redis), env/secrets setup, design tokens, ADRs 001–014                                            |
| **1 — Foundation**      | Auth + MFA, tenants, memberships, roles/permissions engine, RLS framework + tenant-isolation tests, audit log, outbox + worker skeleton, app shell (sidebar, command palette stub) |
| **2 — Template module** | Contacts end-to-end (list, record page, inline edit, timeline, notes, attachments) + field metadata + custom fields engine. **This becomes the template for all other objects.**   |
| **3 — Sales core**      | Accounts, Leads + conversion, Deals + pipelines + Kanban, duplicate detection                                                                                                      |
| **4 — Productivity**    | Activities/tasks, My Day, notifications, global search, saved views, bulk actions                                                                                                  |
| **5 — Admin & data**    | Import/export, users/roles/field-permissions UI, customization UI, onboarding + sample data, dashboard                                                                             |
| **6 — Hardening**       | Security review of every module, load test with 1M seeded records, accessibility pass, backups/restore drill, production deploy, pilot onboarding                                  |

## 12. Roadmap After MVP

**Phase 2 (P1, ~6–8 weeks):** Gmail/Outlook two-way email sync, WhatsApp Business API, workflow automation builder (trigger → condition → action, built on outbox events), report builder, quotes with GST + PDF, products & price books, public API keys + webhooks, self-serve billing (Razorpay/Stripe), record merge, calendar sync.

**Phase 3 (P2):** custom objects + relationships, territories, approval processes, AI (lead scoring, email/call summaries, next-best-action, natural-language search via pgvector), mobile apps (React Native), SSO/SCIM, data residency regions, integration marketplace, support desk module.

## 13. Success Metrics

| Type    | Metric                                     | Target                     |
| ------- | ------------------------------------------ | -------------------------- |
| Leading | Signup → first deal created                | ≥ 70% within first session |
| Leading | Time to first deal                         | < 10 min median            |
| Leading | Weekly active users / total users (pilots) | ≥ 60%                      |
| Lagging | Pilot → paid conversion                    | ≥ 3 of 5 pilots            |
| Lagging | 90-day logo retention                      | ≥ 80%                      |
| Quality | Cross-tenant security incidents            | 0                          |
| Quality | p95 API latency                            | < 200 ms                   |

## 14. Open Questions

| Question                                                                           | Owner       | Blocking?              |
| ---------------------------------------------------------------------------------- | ----------- | ---------------------- |
| Product name, domain and branding                                                  | Founder     | Before launch          |
| Hosting region and provider (AWS Mumbai vs DigitalOcean BLR vs Hetzner + India DR) | Founder/Eng | Week 0                 |
| Pricing model (per user vs per tenant tiers) and free tier limits                  | Founder     | Before Phase 2 billing |
| Which 3–5 pilot businesses, and their must-have fields/workflows                   | Founder     | Week 2                 |
| Legal: Terms of Service, Privacy Policy, DPA (DPDP Act) — get a lawyer review      | Legal       | Before pilots          |
| WhatsApp provider (direct Meta Cloud API vs BSP)                                   | Founder/Eng | Before Phase 2         |
