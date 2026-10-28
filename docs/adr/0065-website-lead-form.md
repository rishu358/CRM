# ADR-0065: The website lead form: a public door into a multi-tenant system, and the rules that keep it narrow

- **Status:** Accepted (2026-10-28). The owner approved the plan and all seven decisions in section 15, each as recommended
  (no CAPTCHA in v1 with an adapter ready; key shown once and stored hashed with a grace window; hosted page, iframe and link
  in v1 with direct post and per-form CORS later; no address stored; a matching submission still creates a lead, flagged and
  notified; `web_form` added to every workspace's lead `source` picklist; the exception to CLAUDE.md §10(d) allowed, worded as
  in section 1, with the test that every other endpoint still answers 401). Part A (forms, the public door, the hosted page,
  the admin screens) is built in draft PR A; part B (assignment rules) follows. "Implementation notes" at the end lists where
  the build differs from the plan above.
- **Date:** 2026-10-28
- **Related:** ADR-0002 (roles and RLS), ADR-0019 (invitation tokens), ADR-0023 (duplicates), ADR-0040 (outbound and
  browser hardening), ADR-0047 (entitlements), ADR-0053 (shared rate limits), ADR-0060 (idempotency key), CLAUDE.md §5, §10, §13
- **Migrations:** `0027_lead_forms.sql` (PR A), `0028_lead_assignment_rules.sql` (PR B). **Re-check both numbers, and this ADR's, after
  `git fetch` right before pushing and at merge:** the tags-and-merge session holds 0025 (tags) and 0026 (merge) and may take
  ADR 0064 and 0065; this ADR is renumbered to the next free one if theirs land first.

## 1. What this is, and why it needs a plan of its own

A company creates a form in Settings, puts it on its own website, and every submission becomes a **lead** in the CRM, owned
by a person chosen by simple rules. Zoho gives this on its free plan, and the gap analysis ranks it third in the Phase 2
order. The difficulty is not the form. It is that **this is the first endpoint that anybody on the internet, with no account,
can use to write into a tenant's data.** Everything else in the API sits behind the `AuthGuard`; this does not.

CLAUDE.md §10(d) says "unauthenticated requests get 401". **This feature is a deliberate, narrowly defined exception**, and the
exception is stated here so it is a decision and not a drift:

> Exactly two API routes (`GET` and `POST` under `/api/v1/public/forms/:key`) and exactly two web paths (`/f/:key` and its
> assets) may be reached without a session. The only thing a caller can do through them is read one form's public definition
> and add **one lead, with source `web_form`, in that form's own workspace**, through a schema built from the form's own
> field whitelist. Every other route still answers `401`, and a test enumerates the whole route table to prove it (§9).

Proposed one-line amendment to CLAUDE.md §10(d) (the owner's file, so not edited by this change): "(d) unauthenticated requests
get 401, except the routes listed in ADR-0065, which a test keeps to that list."

## 2. Verified facts this plan stands on

Each was read in the code, not assumed.

| Fact                                                                                                                                                                                                                                                                                              | Where                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Every route is behind `AuthGuard` unless the handler (not the class) carries `@Public()`. Three places use it today: auth, the invitation accept routes, health/OpenAPI.                                                                                                                          | `auth.guard.ts`                                           |
| A request runs `withTenant` = a transaction with `SET LOCAL app.tenant_id` / `app.user_id`; `runAsAuth` runs as `crm_auth` with no tenant. `crm_app` is not the owner and has no `BYPASSRLS`; every tenant table is `FORCE ROW LEVEL SECURITY`.                                                   | `database.service.ts`, `0004_rls_policies.sql`            |
| **The invitation accept route already solves "a public request needs a narrow DB path":** the token carries the tenant id as a _routing hint_, the row is then found by the SHA-256 of the whole token inside that tenant's RLS context, with `userId: null`. No new role, no `SECURITY DEFINER`. | `invitations.service.ts` `loadPending`                    |
| `crm_auth` is the platform role that already reads across tenants for routing (sessions, `tenants`), and ADR-0047 says a new database role is "an infrastructure change for every deployment" and chose to reuse it.                                                                              | `0004`, ADR-0047 §3                                       |
| `LeadsService.create` needs an `Actor` and calls `assertCan`, `resolveOwner` (an actor may only assign to themselves unless `update:all`), writes audit and outbox in the same transaction, and returns duplicate matches **scoped by that actor's visibility**.                                  | `leads.service.ts:192`                                    |
| `AuditService` and `OutboxService` accept a narrower `WriterIdentity { tenantId, userId: string \| null }`; the invitation flow uses it because "a fake `Actor` in the codebase is worth avoiding". `audit_logs` records `ip_address` and `user_agent` from the request context.                  | `audit.service.ts`, `outbox.service.ts`                   |
| **Leads have no consent column.** `consent jsonb` exists on contacts only, is empty everywhere, and the API does not expose it (ADR-0061 §6). The lead `source` column is free text, but its field definition is a picklist with `website`, not `web_form`.                                       | `0009`, `0002`, `seed/fields.ts`                          |
| Idempotency (ADR-0060) is keyed by **person and workspace** in `bulk_operations`: it cannot serve a caller with no person.                                                                                                                                                                        | `idempotency.service.ts`                                  |
| Rate limits (ADR-0053): the user and tenant budgets are spent in the `AuthGuard`; the only pre-session limit is a global per-address `onRequest` hook (1,000 a minute). `trustProxy: true`, so the address is trustworthy only while the API is reachable from the proxy alone (RUNBOOK §1).      | `rate-limit.service.ts`, `bootstrap.ts`                   |
| API CORS is **global**, `credentials: true`, with an allow-list from `CORS_ORIGINS`; `bodyLimit` is 2 MB globally.                                                                                                                                                                                | `bootstrap.ts`                                            |
| Web CSP is nonce-based (`script-src 'self' 'nonce-…' 'strict-dynamic'`), `frame-ancestors 'none'`, `form-action 'self'`, `connect-src 'self'`; `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` on every path. The proxy gates everything except a short `PUBLIC_PREFIXES` list.        | `proxy.ts`, `csp.ts`, `next.config.ts`, `session-gate.ts` |
| The credential proxy (`/api/proxy/*`) refuses a state-changing request whose `Origin` is not its own, forwards only `content-type`, `x-tenant-id`, `idempotency-key`, attaches the session as a bearer token if there is one, and builds the path under `/api/v1` only.                           | `api/proxy/[...path]/route.ts`, `proxy-path.ts`           |
| Notifications and digests are written by the worker from outbox events, once per `source_event_id`; HTML is escaped with `escapeHtml`.                                                                                                                                                            | `worker/handlers/notifications.ts`                        |
| Entitlements: `FEATURES = ['imports','exports']`, `EntitlementsService.require(tx, tenantId, feature)`; "a feature is added in the change that adds its check".                                                                                                                                   | ADR-0047                                                  |
| There is **no libphonenumber** and no property-testing library (`fast-check`) in the repository.                                                                                                                                                                                                  | grep                                                      |

## 3. Decision: how the public endpoint learns the tenant (and what database path it uses)

### 3.1 The form key

- **Format:** `lfk_` + 32 bytes from `crypto.randomBytes`, base64url (256 bits; 47 characters). Checked against
  `^lfk_[A-Za-z0-9_-]{43}$` before anything else, so a malformed value never reaches the database or a counter.
- **It is a capability identifier, not a confidential secret, and the plan says so.** It is printed in the customer's web page
  and in the snippet, exactly as Zoho's form key is. Anyone who can see the website can post to the form. That is the product.
  What the key buys is: nobody can post to a form they have not seen, a leaked key can be killed, and **the key is the only
  thing that selects a tenant.**
- **Stored hashed.** The database holds `SHA-256(key)` (`bytea`, unique) and a 4-character hint. The key is shown **once**, at
  creation and at rotation, with the link and the snippet. After that the screen shows the hint and "Rotate to get a new link".
  Recorded cost: a customer who lost the snippet must rotate (the old key can be given a grace window, below). Considered and
  rejected for v1: reversible storage (encryption at rest) so the snippet can be re-shown; it needs key management for a value
  that is public by design.
- **Rotation** adds a new key and sets `retires_at` on the old one (default 24 hours, 0 to retire at once, so a company can
  update its website without a gap). **Revocation** sets `revoked_at` and is immediate. A form can have at most two live keys.
- **A client-supplied tenant id or user id is never read.** The body schema is `.strict()` and has no such field; headers
  `X-Tenant-Id`, `Authorization` and cookies are ignored on the public routes (not parsed, not logged); the query string is
  rejected if it contains anything. Tests inject all of them (§9).

### 3.2 Which database role and policy path

**Recommendation: two steps, both with roles that already exist, RLS on in both.**

1. **Route the key** as `crm_auth` (the platform role that already does cross-tenant routing). A new table
   `lead_form_keys (tenant_id, form_id, key_hash, hint, retires_at, revoked_at, …)` is granted to `crm_auth` as
   **`SELECT (tenant_id, form_id, key_hash, retires_at, revoked_at)` only, column-limited**, behind a policy
   `FOR SELECT TO crm_auth USING (true)`. One query: key hash → `(tenant_id, form_id)` joined to `tenants.status = 'active'`.
   `crm_auth` still has no grant on `lead_forms`, `leads`, `contacts` or anything else, so it cannot read a form's definition,
   let alone customer data. `crm_app` has the ordinary tenant-isolation policy on the table, so a request in tenant A can never
   read tenant B's key rows.
2. **Do the work** as `crm_app` through `runInTenant({ tenantId: <from the row, never from the request>, userId: null })`. Load
   the form (RLS-scoped), check `status = 'enabled'` and the entitlement, then insert the lead, the submission row, the audit
   entry and the outbox event **in one transaction**. RLS is on for every statement, and the transaction can only ever touch the
   one tenant the database row named.

Why this and not the alternatives:

| Option                                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Routing row read by `crm_auth` (column-limited), then `crm_app` in the row's tenant**        | **Chosen.** No new role (ADR-0047's precedent), no `SECURITY DEFINER`, no cross-tenant read for `crm_app`, the tenant comes from a database row found by a 256-bit hash, and every business statement is under normal RLS. Honest limit: during step 2 the code runs with `crm_app`'s grants for one tenant, so the narrowing is by code discipline plus a boundary test (§3.3), not by the database alone. |
| Tenant id as a prefix of the key, verified by the hash inside that tenant (the invitation way) | Sound and it is the existing pattern; **kept as the fallback** if the reviewer prefers not to touch `crm_auth`. Rejected as default because it puts the tenant id in every public page and snippet (a UUIDv7 also reveals when the tenant was created) and the owner's rule is that the tenant never comes from the client.                                                                                 |
| A `SECURITY DEFINER` function that inserts the lead                                            | Rejected. It would have to reproduce lead creation in SQL (field validation, duplicates, audit, outbox, search, assignment) and stay in sync with the service forever. `FORCE ROW LEVEL SECURITY` also applies to the function's owner, so it would need its own bypass policy, which is the thing we promised never to write.                                                                              |
| A new `crm_public` role with INSERT-only grants                                                | Rejected. It would need INSERT on `leads`, `audit_logs`, `outbox_events`, `timeline_events`, `notifications`, SELECT on `contacts` and `leads` for duplicates: nearly `crm_app`'s grants, so no narrowing, plus a new role in every deployment (ADR-0043: roles on managed Postgres are an administrator's job).                                                                                            |
| A restrictive RLS policy keyed on a GUC the code sets (`app.public_form_id`)                   | Considered as a tripwire (it would turn a code bug into a database error). Deferred: it is only as strong as the code that sets the GUC, and it touches every lead policy. Revisit if review wants a database-level guard.                                                                                                                                                                                  |

### 3.3 Keeping the `crm_app` step narrow

- All public code lives in one module, `apps/api/src/modules/public-forms/`. Its **only** database entry point is
  `PublicFormsService.submit/definition`; nothing else in the module imports a `Tx` or a repository.
- It calls other modules only through two new, explicit, `Identity`-based (not `Actor`-based) service methods:
  `LeadsService.createFromWebFormInTx(identity, tx, input)` (no `assertCan`: the form _is_ the authorization; owner is chosen
  by the assigner, not by the caller; source is fixed) and `LeadAssigner.pickOwner`. No `Actor` is fabricated.
- A **boundary test** (like ADR-0040's) reads the module's imports and fails if it imports another module's repository, a
  table, `runAsAuth` outside the one routing function, `fetch`, or the credential proxy. The list of allowed calls is in the test.

### 3.4 Uniform answers

An unknown key, a malformed key, a revoked or retired key, a disabled form, a deleted form, a paused workspace
(`lead_forms_paused`), a suspended tenant, and a withdrawn `web_forms` entitlement **all return the same response**:
`404 { error: { code: 'NOT_FOUND', message: 'This form is not available', details: [], requestId } }`, same headers, no
`Retry-After`. The entitlement's `402` is mapped to this on the public path (the public must not learn plan facts). A key is
256 bits, so existence is not discoverable by guessing and no timing equalisation is attempted; the case that matters (a
disabled form versus a wrong key, told apart only by someone who once knew the key) gets the same body and the same path.
Answers that mean "accepted" are also identical: created, honeypot-dropped, cooldown-repeat, and an idempotent replay all return
`201 { data: { received: true } }` (§6), with no lead id.

## 4. Abuse and spam

### 4.1 Order of checks (cheapest first, nothing written until the end)

1. Method, path and **query string must be empty**. `Content-Type` must be `application/json` (an optional `charset=utf-8`),
   else `415`. **No cookies are read and none are set** (`Set-Cookie` is asserted absent).
2. **Body size.** Public prefix capped at **16 KB** (global limit is 2 MB): `Content-Length` over the cap is refused before
   reading, and a `preParsing` byte counter stops a chunked body that lies. Implementation detail to verify while building:
   Nest on Fastify does not expose a per-route `bodyLimit` decorator, so this is a hook scoped to the prefix.
3. The existing global per-address ceiling (1,000 a minute) still runs first. **New public limits** through the same shared
   Redis `RateLimitCounter` (ADR-0053), with their own key kinds so they never touch the staff budgets:
   - per **address and form**: 10 per 10 minutes
   - per **address across forms**: 30 per 10 minutes
   - per **form**: 200 per 10 minutes
   - per **tenant, all public forms together**: 1,000 per hour (a global cap so one form cannot use up the tenant's allowance)
   - a separate, tighter per-address bucket for **bad keys** (so key guessing is throttled harder than real use)
   - all numbers are proposals, each an entry in the env registry (`PUBLIC_FORM_RATE_*`), default values in the registry
   - **Redis keys are `crm:rl:v1:pform:…`, `pformaddr`, `ptenant`, never `user:` or `tenant:`.** A flood on a form therefore cannot
     lock the company's own staff out of the CRM, and staff traffic cannot starve the form.
4. **Hard daily caps, in the database**, independent of Redis (a Redis outage degrades limits to per-process, ADR-0053 §3):
   `lead_form_daily_counts (tenant_id, form_id, day)` with one atomic `INSERT … ON CONFLICT DO UPDATE SET count = count + 1
WHERE count < cap RETURNING`, so concurrent submissions cannot slip past the cap. Defaults: 1,000 a day per form, 2,000 per
   tenant (registry: `LEAD_FORM_MAX_PER_FORM_PER_DAY`, `LEAD_FORM_MAX_PER_TENANT_PER_DAY`), and at most 10 forms per tenant
   (`LEAD_FORMS_MAX_PER_TENANT`). Over the cap: `429 RATE_LIMITED`, `Retry-After` until the next UTC midnight.
5. Resolve the key (§3), check enabled / paused / entitlement.
6. **Parse with the form's own strict schema** (§4.2). `.strict()`: an unknown key is rejected with one generic `422` that does
   not echo the unknown name or any value back.
7. **Honeypot** field `website_url` (name chosen to look tempting): must be absent or an empty string. If filled: return the
   normal `201` **and write nothing** (a human cannot see the field, so a person never loses a lead this way).
8. **Minimum fill time**, via a stateless fill token (§4.3). Submitted in under 3 seconds, or with a missing, malformed or
   forged token: a `422 FORM_EXPIRED` ("please reload the page and try again"), **not a silent drop**, because a password
   manager can legitimately fill and submit in under 3 seconds and a lost lead is worse than a retry. Honest note: this slows a
   bot, it does not stop one that fetches the definition first; the limits above are the real defence.
9. Idempotency and duplicate handling (§6), then the transaction.

### 4.2 The schema is built from the form, never from the request

`buildFormSubmissionSchema(form, fieldMetadata)` in `packages/core` produces a Zod object containing **only** the form's
whitelisted fields plus `consent`, `website_url`, `fillToken`. A field can be offered on a form only if it is an **active lead
field** whose type is in a short allow-list: `text`, `long_text`, `number`, `date`, `boolean`, `picklist`, `multi_picklist`,
`email`, `phone`, `url`. Never offered: `status`, `owner_id`, `source`, the `converted_*` columns, `version`, `currency`,
`user_lookup`, and any rich text (ADR-0024's sanitiser is not for the public). Caps: name fields 120, company 200, `email` 254,
phone 20 after normalisation, `text` 500, `long_text` 2,000 characters, picklist values must be one of the options, a form has
at most 25 fields. Control characters (other than newline in `long_text`), NUL and lone surrogates are rejected; values are
trimmed and Unicode-normalised (NFC). `last_name` must be on every form and required (a lead needs a surname, ADR-0022); the
label is the company's own ("Your name"). **At least one of `email` or `phone` must be on the form and at least one of those
present must be filled**, so no lead arrives that nobody can answer.

- **Email:** lowercased, `z.email`, max 254, a dot in the domain, no display-name form. Everything else obviously junk is rejected.
- **Phone:** normalised to E.164 by a small pure function in `packages/core` (strip spaces, dashes, dots, brackets; `00` to `+`;
  leading trunk `0` dropped; the form's `phoneCountryCode` prefixed when no `+`). For India (`+91`) the national number must
  match `^[6-9]\d{9}$`, otherwise generic E.164 length rules. **No new dependency** (libphonenumber is not in the repository and
  CLAUDE.md §11.4 says to ask first); the cost is weaker per-country validation outside India. The default country code is
  chosen in the form editor, prefilled from the workspace's default (to be wired to ADR-0045's workspace defaults; not
  hard-coded).
- **No HTML, ever.** Nothing is stripped or "sanitised": a visitor who types `<script>alert(1)</script>` gets exactly that text
  stored. It is rendered through React's escaping, through `escapeHtml` in the digest e-mail, and through the existing CSV
  formula protection in exports (§5.11). The notification row stores **ids only** (lead id, form id), never the visitor's
  words. Tests push stored-XSS strings through list, detail, search, export and the notification e-mail (§9).
- **Validation errors never echo submitted values.** Field errors name the form-defined field and a fixed message.

### 4.3 The fill token

Stateless: `v1.<issuedAtSeconds>.<formId>.<HMAC-SHA256>` where the HMAC key is derived (HKDF, fixed label) from the existing
`AUTH_SECRET`, so **no new secret and no new environment variable**. Issued by `GET /public/forms/:key`, valid from 3 seconds to
4 hours after issue and only for that form. A key rotation does not need to invalidate it (it names the form id, not the key).

### 4.4 CAPTCHA: not in v1 (for the owner to decide)

**Proposal: no CAPTCHA in v1; ship a `HumanCheckProvider` adapter interface (default `none`) so one can be added without
touching the form code** (CLAUDE.md §13.5: vendors only behind an adapter selected by an env variable; and ask first). The
layered limits above are what stands in until spam proves otherwise. If it does, the options are, in the order I would pick:

| Option                                                   | Privacy cost                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted proof-of-work challenge (for example ALTCHA) | Nothing leaves our servers. Needs one new dependency (asked first) and a little client work; stops cheap bots, not a determined one.                                                                                                                                       |
| Cloudflare Turnstile                                     | Visitor's address and browser signals go to Cloudflare, so it is a sub-processor to name in the DPA/privacy notice; the `/f/*` pages would need `script-src`/`frame-src` for `challenges.cloudflare.com`, **only on those pages** (CSP for the rest of the app unchanged). |
| Google reCAPTCHA                                         | Worst privacy position, third-party cookies; not recommended for DPDP-conscious customers.                                                                                                                                                                                 |

## 5. How a customer's website sends the form (browser access)

### 5.1 v1: a hosted page, an iframe snippet and a plain link. No cross-origin calls to the API.

- **`/f/<key>`** in the web app: a server-rendered page with its own minimal layout (no app shell, no session lookup). It is
  added to `PUBLIC_PREFIXES` in `session-gate.ts`. The public base URL comes from configuration (`PUBLIC_FORMS_BASE_URL`,
  defaulting to the web URL), so the pages can move to a separate domain later without a code change; a separate registrable
  domain is the better home once hosting exists, because it keeps visitors off the app's origin entirely.
- **The form posts to `/api/proxy/public/forms/:key/submissions`.** The proxy gets one rule: a path starting `public/` **never
  forwards any credential** (no session, no `Authorization`), forwards only `content-type` and the client address, and refuses a
  body over 16 KB before reading it. The proxy's existing same-origin check still applies, which also means a page on any
  other site cannot post through it.
- **Snippet:** `<iframe src="…/f/<key>" title="…" loading="lazy" style="border:0;width:100%;height:640px">` and a plain link.
  Both are shown with a copy button. This works on any site builder that allows an iframe or a link. Cost: the iframe cannot
  auto-size to its content without a script on the customer's site; v1 offers a fixed height with scrolling.
- **Framing is opt-in per form.** The form carries `allowedOrigins` (https origins only, no wildcards, no paths, at most 10, each
  normalised). **Empty list = nobody may frame it** (`frame-ancestors 'none'`); only the direct link works. A listed origin
  becomes `frame-ancestors https://that.origin` for that form's page, and nothing else changes.
- **The CSP of the rest of the app is not loosened.** `proxy.ts` builds the policy per request; for `/f/:key` only it looks up
  the form's allowed origins (a cached, short-lived call to the public definition endpoint) and swaps the `frame-ancestors`
  directive. `next.config.ts`'s `X-Frame-Options: DENY` is carved out for `/f/*` only (that header cannot express an allow-list)
  and `frame-ancestors` carries it. A test asserts every **other** path still sends `X-Frame-Options: DENY` and `frame-ancestors
'none'`, and that the script, style, connect and form-action directives of `/f/*` are identical to the app's. An unknown or
  disabled key gets the "not available" page with `frame-ancestors 'none'`.
- **Headers on the page and the API:** `Cache-Control: no-store` (a disabled form must stop working at once), `Referrer-Policy:
no-referrer` (already global), `X-Content-Type-Options: nosniff`, no `Set-Cookie`. The page renders labels, help text and
  consent text as plain text through React. There is no `dangerouslySetInnerHTML` on it, and a lint-level test fails if one is
  added under `app/f/`.
- **Success:** a message (plain text, max 500) or, optionally, a redirect to an https URL **whose origin is one of the form's
  allowed origins** (set by the admin, never read from the request, so it is not an open redirect). When the page is framed, the
  message is shown instead.

### 5.2 Later, if a customer needs a native-looking embed: direct post with per-form CORS (designed, not built in v1)

The same `allowedOrigins` list would drive CORS on the two public routes: the response reflects the request's `Origin` **only if
it is in that form's list**, never `*`, **never `Access-Control-Allow-Credentials`**, `Vary: Origin`, preflight answered per form,
and the global CORS delegate switched to a function that returns no CORS headers for the `/api/v1/public/` prefix so the global
`credentials: true` list never applies there. Nest's `enableCors` accepts a delegate function; whether it can answer the preflight
per form without a second code path is to be verified when this is built. Because a browser on a non-listed origin gets no CORS
approval, and the endpoint takes no cookies and sets none, a cross-site page cannot make a visitor's browser do anything useful
with it. (A non-browser client ignores CORS completely; CORS is not an anti-spam control and is not described as one.)

## 6. Privacy and consent (DPDP)

- **Each form has a consent text (required, 20 to 1,000 characters, plain text) and a consent checkbox that is always required.**
  There is no setting to turn it off. An optional `privacyNoticeUrl` (https) renders as a link with `rel="noopener noreferrer"`.
- **Consent is versioned.** Every edit of the consent text increments `consent_version` and appends the text to
  `lead_form_consent_texts` (append-only: `SELECT, INSERT` only), so what version 3 said can always be shown.
- **What is recorded per submission** (`lead_form_submissions`): form id, lead id, consent **version** and **timestamp**, the
  source `web_form`, the outcome, and a hash of the Idempotency-Key. **No copy of the submitted values** (the lead is the record),
  **no IP address, no user agent, no referrer.**
- **The submitter's IP address is not stored in the database.** The request context normally puts the address and user agent into
  `audit_logs`; for the public routes both are written as `NULL` (the audit entry still says who and when: the form). The address
  exists only in the Redis rate-limit counters for the length of their window (10 minutes to 1 hour), which ADR-0053 already
  documents as the retention. **Cost, stated:** we cannot trace an abuser from our own records after the fact; the form owner can
  disable the form and rotate the key. If spam turns out to need it, the next step is a keyed hash of the address with a 30-day
  purge, decided then, not now.
- **A submission never subscribes anyone to marketing.** It writes no `email` or `whatsapp` consent channel anywhere. The consent
  recorded is for answering the enquiry, in words the visitor saw.
- **Personal data is never logged and never in a URL.** Public routes log `requestId`, `tenantId`, `formId`, outcome code and
  status. Never the body, the headers, the address, or the key; the key sits in the path, so the log uses the route pattern
  (`/public/forms/:key/…`), not the raw URL. The query string must be empty.
- **Erasure.** `lead_form_submissions` has a foreign key to the lead (`ON DELETE CASCADE`), and the erasure worker deletes a data
  subject's submission rows for any lead it erases (`crm_worker` gets `DELETE` on that table only); the existing erasure security
  test is extended to assert none remain. The data-subject export is checked and extended to include the consent record.
  Consent is **not copied onto the contact at conversion** in v1 (it is consent to answer an enquiry, not a marketing channel).

## 7. Duplicates and double-submits

- **Double click / retry:** the page sends an `Idempotency-Key` (one per page load, reused for retries). It is stored as
  `SHA-256` in `lead_form_submissions` with a unique index per form; a replay returns the same `201` and writes nothing. The
  hash is cleared by the existing daily sweep after `IDEMPOTENCY_WINDOW_HOURS` (24 h). ADR-0060's mechanism is not reused
  because it is keyed by person; the contract (same key, same answer, no second record) is the same.
- **Impatient resubmission without a key:** the same email or phone to the same form within 60 seconds is answered `201` and
  creates nothing (a 60-second Redis marker holding a keyed hash, not the value).
- **A submission that matches something already in the CRM** (PR 16 / ADR-0023: exact email or phone against leads and contacts,
  fuzzy company against accounts) **still creates the lead.** Duplicates are offered, never imposed, and a customer who writes
  twice must not vanish. The new lead gets a timeline entry "Possible duplicate of <record> (matched on email)" and the matched
  record's owner gets an in-app notification "<form> was submitted again by someone matching this record". The match is computed
  **without an actor's visibility scope** (there is no actor, and the point is to catch everything) and is used **only
  internally**: the public answer never reveals that anything matched.

## 8. Tenant protection

- **Entitlement.** New feature `web_forms` (added to `FEATURES`, to the plan catalogue for every plan today, and checked in the
  same change at form creation and at submission, per ADR-0047). A withdrawn feature stops new submissions at once (the public
  path answers the uniform 404).
- **Caps** as in §4.1 (forms per tenant, submissions per form and tenant per day).
- **Kill switches:** per-form enable/disable (immediate, no cache), a workspace-wide **"Pause all web forms"** switch
  (the `lead_form_settings` table; the application role may not write `tenants.settings`, so the switch has a table of its own, read by the public path in its own transaction), and the operator's
  `tenant:entitlements revoke web_forms`.
- **Audit and outbox.** `lead_form.created / updated / key_rotated / key_revoked / enabled / disabled / deleted` (audit entries and
  `lead_form.*.v1` outbox events, never containing a key or a key hash), and `lead.created.v1` with payload
  `{ ownerId, source: 'web_form', formId }`. The assignment decision and any assignment failure are audited (§10).
- **Notification.** A new worker handler turns `lead.created.v1` with `source = web_form` into an in-app notification for the
  assigned owner (`lead.web_form_new`, ids only, idempotent on `source_event_id`). The existing digest e-mail, which uses the
  existing provider interface and `escapeHtml`, carries it; **no new e-mail path, no new vendor.** Lead `source` gets a `web_form`
  option added to every workspace's `source` picklist by the migration (a small forward-only jsonb update) and to the seed.
- **Permissions (through `can()`):** new administrative object types `lead_form` (read, create, update, delete) in PR A and
  `lead_assignment` (read, create, update, delete) in PR B, `all` scope only, granted to the system **Owner and Admin** roles by
  the migration (existing workspaces) and the seed (new ones), listed in the grant catalogue so the role editor can show them.
  Everything in the admin API is authorised through `can()`, with `404` for records outside the tenant, as everywhere.

## 9. Testing

**The four mandatory security tests, for the admin API** (`lead_forms`, keys, assignment rules): (a) tenant A cannot list, read,
update, rotate or delete tenant B's forms, keys or rules; (b) a role without the grant gets 403 and an `own`-scope user cannot
see forms; (c) hidden fields: the key hash and the consent history are absent from every admin response, and a write that names
`keyHash` is rejected; (d) every admin route answers 401 without a session.

**Database tests (real Postgres, RLS on):** `crm_auth` can read **only** the five granted columns of `lead_form_keys` (a `SELECT *`
and a read of `lead_forms`, `leads`, `contacts` all fail); `crm_app` cannot read another tenant's keys; `crm_auth`/`crm_app`
cannot `UPDATE`/`DELETE` where not granted; the daily-cap statement holds under 25 concurrent takers.

**With no user (`runInTenant({ userId: null })`, which is how the public step runs).** Checked by reading every policy that
uses `current_app_user_id()` (`users`, the `saved_views` and `bulk_operations` restrictive policies, the erasure window): none
is on a table the public step writes, and the lead's "own" and "team" visibility is applied by the service's SQL from an
`Actor`, not by a policy, so a lead made with no user is simply visible by its owner and by anyone whose scope reaches it.
Tested in the database spec (as `crm_app` with a null user: the lead, the submission, the audit row, the outbox event and the
daily count are all written, `created_by` and `actor_id` are null, and a later reader with `own` scope sees the lead only if
they own it) and in the API spec (the lead made by a stranger is visible to its owner, to an admin, and not to another rep; the
owner gets the notification, which the worker spec checks).

**Public-endpoint tests:** a key from another tenant resolves only to its own tenant and a body naming the other tenant is a
`422`; a rotated key (old key in grace, old key after retirement); a revoked key; a disabled form; a paused workspace; a
suspended tenant; a withdrawn entitlement (**all byte-identical `404`**); over each limit (per address, per form, per tenant,
daily cap, Redis down); an oversize body (declared and chunked); honeypot (201, nothing written); too fast and missing and
forged fill token (`422 FORM_EXPIRED`); unknown field; `tenantId`, `userId`, `ownerId`, `status`, `source`, `version` in the
body, `X-Tenant-Id`, `Authorization`, cookie and query string (none has any effect, and a session cookie is not read); wrong
content type (`415`: `text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`); no `Set-Cookie`; no CORS header;
10,000-character values in every field; control characters; consent missing or false; stored-XSS strings pushed through the
list, detail, search, export (with formula strings), the notification row and the digest e-mail; Idempotency-Key replay; 60-second
repeat; duplicate flagging without leaking the match; concurrent submissions.

**A seeded, hand-rolled fuzz test of the schema builder** (random keys, nesting, types, lengths, unicode; **no new dependency**:
`fast-check` is not in the repository, and CLAUDE.md §11.4 says to ask first): it must never throw anything but a validation
result, never accept an unknown key, and never exceed a cap.

**The route-inventory test (the explicit exception to §10(d)):** it enumerates every route in the running Fastify instance, and
asserts that (1) every route **not** in a frozen `PUBLIC_ROUTES` list answers `401 UNAUTHENTICATED` with no credentials, and
(2) the two public routes accept only the strict schema (a request with any extra key gets `422`). The list contains today's
public routes (auth, invitation accept, health, OpenAPI) and the two new ones; adding a `@Public()` handler without listing it
fails the test.

**Web tests:** the CSP of `/f/*` equals the app's except `frame-ancestors`; every other path keeps `frame-ancestors 'none'` and
`X-Frame-Options: DENY`; `/f/*` sends `no-store`; no `dangerouslySetInnerHTML` under `app/f/`; the proxy forwards no credential
for `public/`; the proxy refuses a 17 KB body.

**Playwright E2E:** the owner builds a form in Settings (fields, consent, allowed origin) and copies the link; a signed-out
browser opens `/f/<key>`, submits; the lead appears in the owner's lead list, assigned, with a "web form" source and a
notification; a signed-out visit with a disabled form shows "not available"; a framed page from a listed origin loads and from
an unlisted one is blocked.

**Not claimed:** a mutation-testing pass over the public module (as done for ADR-0040) is planned; results will be reported, not
assumed.

## 10. Assignment rules (PR B)

- **A pure function in `packages/core`:** `evaluateAssignment(rules, lead, context) → { ownerId, ruleId | null, reason,
pointerUpdate | null }`. No I/O, so it is unit-tested exhaustively. Rules are an ordered list per company; **first match
  wins**. A rule has an `appliesTo` set (`web_form` first; designed so `manual` and `import` can be switched on later), at most
  10 conditions (all must match), and one action.
- **Conditions** over any lead field (the standard ones, `source`, `form_id`, and custom fields by key from the field metadata):
  `equals`, `not_equals`, `in`, `contains` (case-insensitive substring), `starts_with`, `is_empty`, `is_not_empty`. **No regular
  expressions** (ReDoS), no scripting. At most 50 rules per workspace.
- **Actions:** assign to a user; assign to a **team round-robin**; assign to the default owner.
- **Eligible owner:** an **active** membership (not invited, not suspended, user not deactivated) **whose role grants
  `lead:read` and `lead:update`**. Anybody else is skipped; a rule whose target is no longer eligible falls through to the next
  rule, then to the default owner.
- **Round-robin with a persistent pointer and fairness under concurrency:** `lead_assignment_pointers (tenant_id, rule_id,
last_user_id)`; eligible members are ordered by user id; the next owner is the first eligible after the pointer, wrapping. The
  pointer row is **locked `FOR UPDATE` inside the lead-creation transaction** (with a 2-second `lock_timeout`), so two
  simultaneous submissions get different people and the pointer moves exactly once per assignment. A test runs 100 concurrent
  submissions over 4 people and asserts a spread of 25 each.
- **Default owner:** the `default_owner_id` of `lead_assignment_settings` (a table of PR B, for the same reason) if still eligible, else the longest-standing active Owner. If nobody
  is eligible at all the lead is created **unassigned** and the failure is audited.
- **Never throws, never blocks a submission.** The evaluation runs inside a **savepoint**: a database error (a lock timeout, a
  deleted team) rolls back to the savepoint, not the whole transaction, so the lead is still inserted, goes to the default owner,
  and an audit entry `lead_assignment_failed` records why (no personal data in it).
- **Testing a rule set:** `POST /lead-assignment/test` takes a sample lead and returns the decision **without** moving a
  pointer. The UI shows "this lead would go to Priya (rule 2)".
- PR A already routes through an `LeadAssigner` interface whose only implementation is "default owner"; PR B swaps in the rules.

## 11. The admin screens

Settings, in the existing settings layout, `packages/ui` components only, every string through `t()`, keyboard reachable (field
reordering by up/down buttons as well as drag), visible focus, WCAG AA, light and dark, with loading, empty, error and
no-permission states:

- **Web forms:** list (name, status, submissions today / 7 days / total, last submission), create, edit. Editor: choose fields from
  the lead field metadata (only the allowed types), label, required, order, consent text and optional privacy link, success message
  or redirect, allowed origins, phone country code, enable/disable, **rotate key** (shows the new key once; grace period option),
  copy link, copy snippet, **live preview** using the very same component the hosted page renders, and the workspace-wide
  "Pause all web forms" switch.
- **Lead assignment (PR B):** ordered rule list (add, edit, reorder, enable/disable, delete), condition builder over the field
  metadata, team picker, default-owner picker, and a "test with a sample lead" panel.

## 12. Migrations

- **`0027_lead_forms.sql` (PR A):** `lead_forms`, `lead_form_keys`, `lead_form_consent_texts`, `lead_form_submissions`,
  `lead_form_daily_counts`; RLS enabled and forced with the standard tenant policy on each; grants written out per table (§3.2,
  §6); the `crm_auth` column grant and policy on `lead_form_keys`; `lead_form` role grants for system roles; the `web_form`
  option added to each workspace's lead `source` picklist. Built empty, so no long lock. The runner wraps the file in
  `BEGIN/COMMIT`: nothing in it needs to run outside a transaction.
- **`0028_lead_assignment_rules.sql` (PR B):** `lead_assignment_rules`, `lead_assignment_pointers`, `lead_assignment` role grants.
- Every table has `id, tenant_id, created_at, updated_at, created_by, updated_by`; mutable ones `version` and soft delete;
  composite indexes begin with `tenant_id`; the key table is unique on `key_hash`.

## 13. Threat table

| Who                                                 | What they can do                                                             | What we do about it                                                                                                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone who sees the customer's page                 | Post leads to that form                                                      | That is the product. Rate limits, daily caps, honeypot, fill-time check, strict schema; the owner can pause, disable or rotate in one click.                                                       |
| A bot flooding one form                             | Fill the lead list with rubbish                                              | Per-address, per-form and per-tenant limits; hard daily cap in the database; the staff budget is separate so staff are never locked out; lead list can be bulk-deleted (Recycle Bin).              |
| A bot rotating addresses                            | Get past the per-address limit                                               | Per-form and per-tenant limits and the daily cap do not depend on the address. Stated limit: with no CAPTCHA a determined bot is slowed, not stopped.                                              |
| Someone guessing keys                               | Find another company's form                                                  | 256-bit keys; malformed keys rejected before any lookup; a tighter bad-key limit; identical answers for every non-working key.                                                                     |
| Someone with a valid key for tenant A               | Write to tenant B                                                            | Impossible by construction: the tenant comes from a database row found by the key hash; no tenant or user id is read from the request; RLS on for every statement; tested with injection attempts. |
| Someone who finds the key in a database dump        | Use a key                                                                    | Only the SHA-256 is stored; a hash of 256 random bits cannot be reversed.                                                                                                                          |
| An ex-employee who knows the key                    | Keep posting after leaving                                                   | Rotate (optional grace) or revoke; effective at once.                                                                                                                                              |
| A visitor entering `<script>` or a formula          | Stored XSS in the CRM, the e-mail digest, or a spreadsheet                   | Stored as text, escaped on output everywhere, notification rows hold ids only, CSV formula protection unchanged; tested through list, detail, search, export and e-mail.                           |
| A visitor sending huge or malformed bodies          | Exhaust memory or CPU                                                        | 16 KB cap before reading, strict content type, per-field caps, no regex in rules, `422` without echo.                                                                                              |
| A page on another site                              | Make a visitor's browser post to the form or frame our page for clickjacking | Proxy refuses cross-origin posts; no CORS on the API in v1; `frame-ancestors` only for the form's listed origins; the endpoint takes no cookies.                                                   |
| A visitor who wants their data removed              | (a right, not an attack)                                                     | Erasure removes the lead and its submission/consent rows; test extended.                                                                                                                           |
| A compromised admin account                         | Create a form that redirects visitors elsewhere, or spam leads               | Redirect target must be on the form's own allowed origins; permission via `can()`, Owner/Admin only, MFA and audit apply; every form change is audited.                                            |
| A bug in the public module                          | Read or write outside the form's tenant                                      | One narrow module, identity-based service calls, a boundary test on its imports, the tenant fixed by the database row, and RLS on. Residual risk stated: the step runs with `crm_app`'s grants.    |
| An attacker spoofing `X-Forwarded-For`              | Defeat per-address limits                                                    | Only if the API is reachable without the proxy; RUNBOOK §1 keeps it private. Per-form, per-tenant and daily caps hold regardless.                                                                  |
| Redis down                                          | Limits weaken                                                                | Counters fall back to per-process (ADR-0053); the daily cap is in Postgres.                                                                                                                        |
| A leaked staff session on the same origin as `/f/*` | Cross-use                                                                    | The public page never reads cookies; the CSP is the app's; a separate domain for public pages is configured by `PUBLIC_FORMS_BASE_URL` when hosting exists.                                        |

## 14. Configuration (CLAUDE.md §13)

New registry entries (api scope, none secret, none in the web scope except where stated), then `pnpm config:docs`:
`PUBLIC_FORMS_BASE_URL` (web and api), `PUBLIC_FORM_RATE_PER_ADDRESS_FORM`, `PUBLIC_FORM_RATE_PER_ADDRESS`, `PUBLIC_FORM_RATE_PER_FORM`,
`PUBLIC_FORM_RATE_PER_TENANT_HOUR`, `PUBLIC_FORM_RATE_BAD_KEY_PER_ADDRESS`, `LEAD_FORMS_MAX_PER_TENANT`,
`LEAD_FORM_MAX_PER_FORM_PER_DAY`, `LEAD_FORM_MAX_PER_TENANT_PER_DAY`, `PUBLIC_FORM_BODY_MAX_BYTES`, `HUMAN_CHECK_PROVIDER`
(`none`). No product name, domain or address is a literal in code; test fixtures use `*.example`. No new vendor, no new
dependency, no new secret.

## 15. Decisions for the owner (each has a recommendation)

1. **No CAPTCHA in v1** (adapter ready); the self-hosted proof-of-work option first if spam appears. _Recommended._
2. **Key shown once, stored hashed**, with a rotation grace window. Alternative: re-showable snippet, at the cost of reversible storage.
3. **v1 embed = hosted page + iframe + link; direct post with per-form CORS later.** Alternative: build the CORS snippet now.
4. **No IP address stored.** Alternative: a keyed hash with a 30-day purge, for abuse tracing.
5. **A submission that matches an existing record still creates a lead**, flagged and notified. Alternative: attach a note to the existing record instead.
6. **Add `web_form` to the lead `source` picklist** of every workspace (a migration touching existing field metadata).
7. **Allow the exception to CLAUDE.md §10(d)** in the one-line form in §1.

## 16. Implementation notes (part A)

Where the build differs from the plan, or settles something the plan left open. Nothing here loosens a rule above.

- **Routing role.** Exactly as §3.2: `crm_auth` holds `SELECT (tenant_id, form_id, key_hash, retires_at, revoked_at)` on
  `lead_form_keys` and a read-only policy; `crm_app` does all other work in the workspace the row names. The database spec
  (`packages/db/src/lead-forms.security.spec.ts`) asserts that `crm_auth` is refused `select *`, every other column, every other
  table named in the plan, and every write.
- **The boundary test is built** (`public-door.boundary.spec.ts`): the two public files may import only a listed set, `runAsAuth`
  appears once, no `Actor` appears, and exactly two handlers carry `@Public()`.
- **Browser cross-origin approval.** The API's CORS is now a per-request delegate (`@fastify/cors`'s `delegator`): the credentialed
  allow-list everywhere, no approval at all under `/api/v1/public/`. A test sends an `Origin` and a preflight and asserts no
  `Access-Control-*` header.
- **Body cap** is a `preParsing` hook on the public prefix (declared length refused before reading; a counter stops a body that
  lies or is chunked) and the web proxy refuses over 16 KB too. Body-parser failures (`FST_ERR_CTP_*`) now answer 4xx with fixed
  words instead of 500; a small addition to the global error filter.
- **Limits.** The per-address ceiling for page views is the existing global one (1,000 a minute); a view spends only a per-form
  budget (`PUBLIC_FORM_RATE_VIEWS_PER_FORM`, new, because a popular page is read far more than it is filled in). The other limits
  are as in §4.1. `HUMAN_CHECK_PROVIDER` was **not** added: a variable nothing reads is a promise the code does not keep, and the
  adapter arrives with the first provider (§4.4).
- **Duplicates.** The comparison is exact email and phone against leads and contacts, by the system, ignoring the reader's
  visibility; the fuzzy company match against accounts is not run (a name typed by a stranger is a weak signal). The match goes
  to a timeline entry on the new lead, a notification to the matched record's owner, and the submission row; the visitor's
  answer is identical.
- **Owner.** In part A the owner is the form's creator if they can still read and update leads, else the longest-standing
  active member whose role can update web forms and work leads, else nobody. A person is recognised by capability, never by role
  name. Part B replaces this behind `LEAD_ASSIGNER` without touching the public side. The call runs in a savepoint; a failure
  there is audited and the lead is made unassigned rather than lost.
- **Erasure.** Erasing a lead deletes its `lead_form_submissions` row in the same statement block (`erasePersonalColumns`);
  `crm_worker` holds `DELETE` on that table and nothing else. **Not done:** the data-subject _export_ does not yet include the
  consent record. It is listed as a follow-up in the PR.
- **Fill-time trap.** A submission within three seconds of the page being drawn answers `422 FORM_EXPIRED` (a new error code),
  not a silent drop; the hosted page tells the visitor to reload and send again. A password manager that fills and submits in
  under three seconds therefore costs a retry, never a lead. Risk to watch: a browser that auto-fills the hidden trap field would
  make a real visitor's submission vanish; the field is `aria-hidden`, `tabindex=-1` and `autocomplete=off`, and nothing is made
  of that risk beyond that.
- **Hosted page and framing.** `/f/<key>` is in the session gate's public list. `proxy.ts` asks the API for the form's allowed
  origins (the same public definition the page reads, so a view costs two reads) and builds `frame-ancestors` from them for that
  one path; every other path keeps `frame-ancestors 'none'` and `X-Frame-Options: DENY` (the header is excluded for `/f/`).
  The CSP's script, style, connect and form directives are identical to the app's.
- **Not in v1 and said so:** CORS direct-post embed (§5.2), CAPTCHA, the assignment rules (part B), the export of consent
  records, a keyed-hash address for abuse tracing.

## 17. Delivery

- **PR A (draft):** forms, keys, the two public routes, the hosted page and snippet, the proxy and CSP changes, entitlement,
  caps, kill switches, audit and outbox events, notification handler, default-owner assignment, admin screens, tests and E2E.
- **PR B (draft):** the rules engine, round-robin, the rule screens and the test panel.
- Nothing public is merged without the owner's yes. No deployment is implied: the app still runs only on the owner's laptop, and
  nothing here is reachable from the internet until hosting exists.
