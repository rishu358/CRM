# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/). Nothing has been tagged yet: `0.1.0` in `package.json` is
a working version, and the first tag will be cut from a green `master` (see
[`CONTRIBUTING.md`](CONTRIBUTING.md#versioning-and-releases)).

## [Unreleased]

### Added

- **Deployment to DigitalOcean (Bangalore) with the web app on Vercel (Mumbai):** an App Platform spec
  and a secret renderer, a Vercel region pin, a script that verifies and bootstraps a managed Postgres
  cluster, and a runbook section (ADR-0042, ADR-0043).
- **`DATABASE_CA_CERT`:** verified TLS to a managed Postgres whose certificate is signed by the
  provider's own CA, across the API, worker, migration runner and scripts.
- **Startup guard:** the API and worker refuse to start in production if a database connection runs as a
  role that is a superuser or has `BYPASSRLS` (CLAUDE.md §5.1).
- **Repository guardrails:** a proprietary `LICENSE` placeholder, `SECURITY.md`, `CONTRIBUTING.md`,
  CODEOWNERS, a pull-request template, secret scanning (gitleaks) in a pre-commit hook and in CI,
  and a Conventional Commits check.

### Changed

- **One configuration registry (`@crm/env`, ADR-0044):** every environment variable is declared once, with
  its scopes, secrecy, default and where to get it. The API, worker, web app and scripts load only their
  own scope; the web app refuses to start outside local development if it holds a secret meant for
  another process. `.env.example`, `deploy/staging.env.example`, `deploy/production.env.example` and
  `docs/CONFIGURATION.md` are generated from it and checked in CI. An empty variable now means "not set".
  `.env.example` no longer lists nine variables no code reads.
- **Branding is configuration (ADR-0045):** `APP_NAME`, logo, favicon, a primary colour for each theme (refused
  at start-up unless it clears WCAG AA in that theme), support, terms and privacy links. The name is no
  longer compiled into the page title, sign-in screen, navigation, emails or authenticator issuer. What a new
  workspace and its first user start with (currency, time zone, locale, financial year, region label) is
  configured too. All defaults are unchanged. The "you already have an account" email is reworded.
- `process.env` is forbidden everywhere except the registry's one reader (lint rule tightened).
- CLAUDE.md gains section 13 (configuration, secrets and vendors).

- **Deployment modes (ADR-0046):** `DEPLOYMENT_MODE=single_tenant` closes public sign-up (the API answers
  `403 SIGN_UP_DISABLED` identically for everyone, and first-time Google sign-in no longer creates an
  account) and the web app hides the link. Default is `multi_tenant`, so nothing changes unless set.
  Row-level security and tenant isolation are identical in both modes.
- **`pnpm tenant:create`:** creates a workspace and its founding owner through the same provisioning code
  sign-up uses. The password is prompted for with nothing echoed, or piped with `--password-stdin`; there is
  no `--password`. On a single-tenant installation it creates the one workspace and refuses a second.
- **Entitlements (ADR-0047):** `entitlements.has(feature)` is answered from a plan catalogue plus
  per-workspace overrides, and enforced by the API (`402 ENTITLEMENT_REQUIRED`) on `POST /imports` and
  `POST /exports`. A single-tenant installation has every feature. The catalogue ships with no differences
  between plans, so nothing changes for any workspace. Overrides are written only by the operator
  (`pnpm tenant:entitlements`), never by a request: the application role can read them and nothing else
  (migration 0022).
- **Amazon SES (ADR-0048):** `EMAIL_PROVIDER=ses` sends through SES's REST API, signed with Signature Version 4 on
  `node:crypto` and sent through the guarded outbound client pinned to the region host, with no SDK. The API and the
  worker build email providers from one shared factory. `docs/PROVIDERS.md` lists the settings for each email and
  storage choice. `EMAIL_PROVIDER=smtp` sends through any SMTP server with `nodemailer` (a new dependency, MIT-0), requiring TLS: STARTTLS by default, never plain text in production, certificates verified.
- **Rotating `AUTH_SECRET` without losing authenticators (ADR-0049):** stored authenticator secrets now record
  which key wrote them, `AUTH_SECRET_PREVIOUS` holds earlier keys during a rotation, and `pnpm auth:rotate-keys`
  re-encrypts what is stored (safe to repeat, safe while serving, `--dry-run` to look first). `docs/SECRETS.md`
  lists every secret and how to rotate it, with a test that fails if a secret is missing from it. Rotating
  `AUTH_SECRET` never signed anyone out, contrary to what the runbook said; a test now proves it.
- **Argon2id password hashing (ADR-0050):** new passwords are hashed with Argon2id using Node's built-in
  `crypto.argon2` (no new dependency; Node 24.7 or later is now required). Existing scrypt hashes keep working
  and are upgraded at their owner's next successful sign-in, never overwriting a password changed in the
  meantime. Cost is configurable (`PASSWORD_HASH_MEMORY_KIB`, `PASSWORD_HASH_PASSES`,
  `PASSWORD_HASH_PARALLELISM`) with floors at the OWASP minimum, and raising it upgrades hashes the same way.

### Security

- Production configuration now also refuses `doadmin`, the managed-database administrator role, by
  name.

## [0.1.0] - not released

The MVP: accounts, contacts, deals and pipelines, leads and conversion, activities and tasks, global
search, import and export, attachments, audit log and recycle bin, data-rights (DPDP/GDPR), roles and
permissions, invitations and onboarding, the dashboard, and customization; hardened in two passes
(ADR-0040, ADR-0041). See [`docs/MVP_SPEC.md`](docs/MVP_SPEC.md) and the ADRs for what each decided.
