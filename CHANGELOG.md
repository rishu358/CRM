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
- `process.env` is forbidden everywhere except the registry's one reader (lint rule tightened).
- CLAUDE.md gains section 13 (configuration, secrets and vendors).

### Security

- Production configuration now also refuses `doadmin`, the managed-database administrator role, by
  name.

## [0.1.0] - not released

The MVP: accounts, contacts, deals and pipelines, leads and conversion, activities and tasks, global
search, import and export, attachments, audit log and recycle bin, data-rights (DPDP/GDPR), roles and
permissions, invitations and onboarding, the dashboard, and customization; hardened in two passes
(ADR-0040, ADR-0041). See [`docs/MVP_SPEC.md`](docs/MVP_SPEC.md) and the ADRs for what each decided.
