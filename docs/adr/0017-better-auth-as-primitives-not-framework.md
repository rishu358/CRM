# ADR-0017: Better Auth as primitives, not as the session framework

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0014](0014-self-hosted-auth.md) (still accepted; its decision to
  self-host identity in our own Postgres is unchanged)

## Context

ADR-0014 chose Better Auth, self-hosted, with identity data in our database. It did
not say how much of Better Auth we adopt: the library is both a set of
authentication primitives and a framework that owns the session table, the HTTP
routes and the database access.

Before building M1 we integrated Better Auth 1.7.10 against the real schema and ran
sign-up and sign-in against a real Postgres. The integration got further than
expected, and then failed on one specific thing.

### What worked

Model and field mapping handled the snake_case difference without trouble. With
`user.modelName`, `session.modelName`, `account.modelName` and `verification.modelName`
pointed at our tables, and `account.fields.password` mapped to `password_hash`,
Better Auth's Drizzle adapter accepted our schema. `signUpEmail` and `signInEmail`
both succeeded and wrote correct rows.

### What did not

**1. Better Auth stores the session token in plaintext.** This is the blocker.

`internalAdapter.findSession(token)` resolves a session with
`findOne({ model: 'session', where: [{ field: 'token', value: token }] })` — an
equality match against the stored column. The value in the cookie and the value in
the database are necessarily the same string. Mapping `token` to our `token_hash`
column does not hash anything; it just writes the raw token into a column whose name
promises otherwise. The probe confirmed it directly:

```
SESSION ROW: [{"token_hash":"SwHWhyUqZywZtHMe8pTqOdMm7H8J0e4o","len":32}]
```

32 characters, not a 64-character SHA-256 digest. Migration 0005 renamed that column
precisely so nobody would do this, and `session.service.ts` and `packages/core/sessions`
exist to guarantee a stolen backup yields no usable sessions. Adopting Better Auth's
session store would give that property up.

The only way to keep it would be a custom adapter that hashes on write and
intercepts `where` clauses on `session.token` to hash the comparand. That is
undocumented internal query shape, on the single hottest security path in the
system, with a silent failure mode — sessions that simply stop matching, or worse,
stop being hashed after a minor version bump. It is not a defensible place for
cleverness.

**2. `emailVerified` is a boolean; our column is a timestamp.** Better Auth declares
`emailVerified` as `type: 'boolean', required: true`. `fields` remaps names, not
types, so the probe failed with `value.toISOString is not a function` when it wrote
`false` into `email_verified_at timestamptz`. Keeping both a boolean and a timestamp
means two columns asserting one fact, which is how they drift.

**3. Transactions are the library's, not ours.** The adapter exposes
`transaction(cb)` for Better Auth's own internal operations. There is no way to hand
it our `Tx`. ADR-0014 lists as a consequence that "a signup, its membership, its audit
entry and its outbox event commit atomically" — that is not achievable through the
adapter.

**4. The route handler is a second API shape.** Better Auth owns `/api/auth/*` with
its own request and response bodies and its own error codes. Mounting it bypasses the
global `AuthGuard` and `@Public()` discipline, the Zod `.strict()` boundary
(CLAUDE.md §5.6), the `{ data, meta }` envelope and stable error codes (§8), the
per-tenant rate limit (§5.14) and the request-context logging. ADR-0007 says the web
app uses the same versioned REST API as the public API; a second, differently-shaped
surface inside it is exactly what that decision rules out.

Separately, none of what M1 actually requires comes from the framework layer:
`active_tenant_id`, `sessions_valid_from`, membership resolution, tenant-level MFA
enforcement, `auth_events` and progressive delays are all ours either way.

## Decision

**Use Better Auth's primitives and its OAuth providers. Do not use its session
store, its database adapter or its HTTP handler.**

Specifically, we depend on:

| From                           | Used for                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `better-auth/crypto`           | `symmetricEncrypt`; `verifyPassword` for old scrypt hashes only (new passwords are Argon2id, ADR-0050) |
| `better-auth/crypto`           | `symmetricEncrypt` / `symmetricDecrypt` for TOTP secrets                                               |
| `better-auth/crypto`           | `constantTimeEqual`                                                                                    |
| `@better-auth/utils/otp`       | TOTP generation, verification and `otpauth://` URLs                                                    |
| `@better-auth/utils/base32`    | TOTP secret encoding                                                                                   |
| `better-auth/social-providers` | Google: authorization URL, code exchange, user info                                                    |

Everything else — sessions, routes, validation, errors, audit — stays in our own
layers, where the rest of the system's rules already apply. Password hashing, TOTP
and the OAuth dance, the three things ADR-0014 warned against hand-rolling, all come
from the library.

These are public, typed, documented exports, not internals. Each is reached through
a small adapter (`PasswordHasher`, `TotpProvider`, `OAuthProvider`) in keeping with
ADR-0009, so a future swap touches one file.

## Consequences

- Session tokens stay hashed at rest. `sessions_valid_from`, `active_tenant_id` and
  the existing tested `SessionService` survive unchanged.
- Sign-up writes the user, the tenant, the membership, the audit entry and the
  outbox event in transactions we control.
- One API shape, one envelope, one set of error codes, one guard.
- **We own more of the flow logic than ADR-0014 implied**: the sequencing of
  sign-in, MFA challenge, verification and reset is ours, and so is its security
  review. The cryptography underneath is not.
- Upgrading Better Auth is lower risk than it would have been — we use a narrow,
  stable surface — but we do not get new flows for free when the library adds them.
- If Better Auth later supports hashed session tokens, revisit: the mapping work is
  already proven, and only the session store was ever in the way.

## Alternatives considered

- **Full Better Auth, accepting plaintext session tokens.** Rejected: gives up a
  security property this codebase deliberately built, tested and documented.
- **Full Better Auth with a token-hashing custom adapter.** Rejected: undocumented
  internals on the hot security path, silent failure mode.
- **Drop Better Auth and hand-roll everything.** Rejected for the reason ADR-0014
  gave. Password hashing, TOTP and OAuth are where hand-rolled auth goes wrong, and
  we use the library for exactly those.
