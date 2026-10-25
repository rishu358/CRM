# Handover: what changes hands, and what to do first

For the person or team taking over this codebase. Status as of **2026-10-25**; the [CHANGELOG](../CHANGELOG.md)
and the [ADRs](adr/README.md) say what has changed since. Where a statement here depends on something that could
not be checked, it says so.

## What you are getting

A multi-tenant CRM (accounts, contacts, leads, deals and pipelines, activities, search, import and export,
attachments, audit log and recycle bin, data-rights tooling, roles and permissions, invitations, dashboard,
customisation) that can also be installed as one company's own single-tenant system. How it fits together:
[ARCHITECTURE.md](ARCHITECTURE.md). What it was meant to do: [MVP_SPEC.md](MVP_SPEC.md). The rules every change
follows: [CLAUDE.md](../CLAUDE.md).

Nothing in the repository ties it to the previous owner's infrastructure except the items under "Things that name
the previous owner" below. No secret is committed: secret scanning runs on every commit and in CI.

## Do these first

1. **Put your own name on it.**
   - `LICENSE` is a **placeholder** ("all rights reserved", the owner's legal name left blank). Replace it with
     the confirmed licence text before any copy leaves your control.
   - `SECURITY.md` has a placeholder contact for reporting a vulnerability. Set it.
   - `.github/CODEOWNERS` names one person for everything. Replace or extend it with the real maintainers.
2. **Rotate every secret you were given or can see.** Nothing is committed, but a deployment holds database
   passwords, an `AUTH_SECRET`, email and storage keys. [SECRETS.md](SECRETS.md) lists each, what it protects and
   how to rotate it (and `AUTH_SECRET` can be rotated without anyone losing their authenticator).
3. **Choose how it is installed.** `DEPLOYMENT_MODE=multi_tenant` (a product: strangers sign up) or
   `single_tenant` (one company's system: no sign-up, the operator creates the workspace). Then
   [DEPLOYMENT.md](DEPLOYMENT.md).
4. **Set the branding.** The name, logo, colours and support and legal links are configuration, not code:
   [CONFIGURATION.md](CONFIGURATION.md), the "Branding and identity" section. A colour that would be unreadable is refused at
   start-up.
5. **Pick the email and storage providers**, and verify the sending domain: [PROVIDERS.md](PROVIDERS.md).
6. **Decide what plans mean.** Plans exist in the code, but **every plan currently includes every feature**,
   because the pricing model was an open question ([MVP_SPEC.md](MVP_SPEC.md) §14). Changing that is one file
   (`packages/core/src/entitlements`) and, for one workspace, `pnpm tenant:entitlements`
   ([ADR-0047](adr/0047-entitlements-plans-features-and-overrides.md)). There is no billing.
7. **Get the legal documents reviewed.** Everything in [`docs/legal`](legal/README.md) (terms, privacy policy,
   data-processing agreement for the DPDP Act) is an **unreviewed draft written by engineers from the code**. Do
   not publish them, or show them to a customer, until qualified counsel has reviewed them.

## Things that name the previous owner

- **The local file-store image.** `docker-compose.yml` and CI pull MinIO from `ghcr.io/rishu358/crm-minio`, a copy
  made because MinIO stopped publishing images anyone can pull. `.github/workflows/ci.yml` describes that package
  as private and pulls it with a `GHCR_PULL_TOKEN` secret. **Check that it pulls for you.** If it does not, either
  publish your own copy (`deploy/minio-mirror.Dockerfile` has the commands) and change the image in both files, or
  replace MinIO with another S3-compatible server for development; the application only ever speaks the S3 protocol.
  Until this is settled, `pnpm infra:up`, and so `pnpm run setup`, cannot start the file store on a machine that
  cannot pull it. The local mail inbox, by contrast, pulls anonymously.
- **CI secrets**: `GHCR_PULL_TOKEN` above. Nothing else is required.
- **Reviewers**: `CODEOWNERS`, above.

## What was verified, and what was not

The test suites are extensive (unit, integration against a real Postgres with row-level security on, security
suites for tenant isolation and permissions, Playwright end to end), and hardening was done in two reviewed
passes ([ADR-0040](adr/0040-outbound-requests-and-browser-hardening.md), [ADR-0041](adr/0041-hardening-b-search-at-scale-and-deploy-readiness.md)). These things were
written and checked as far as is stated, but **never exercised against the real thing**:

- **A real deployment.** The DigitalOcean and Vercel configuration was written and its scripts tested, and the
  application has **never been deployed** from it.
- **Amazon SES and Cloudflare R2.** SES was tested against a signing test vector and fakes; the R2 values in
  [PROVIDERS.md](PROVIDERS.md) were written from its documentation. Neither has run against a live account.
- **SMTP over TLS.** Delivery and every refusal path are tested against a local server; a successful TLS
  handshake with a real server is not.
- **Anything added after 2026-10-24 that is not yet merged** (Argon2id password hashing, the setup command, the
  local mail inbox, the minimal seed): the unit and integration tests written with them pass where they were run,
  but the full API suite and a real run of the compose service had not been completed when this was written. Check
  the CHANGELOG and the commit messages for what has been verified since.

## Known gaps

- [RUNBOOK.md](RUNBOOK.md) §8 lists them. The ones that matter most: rate limits are counted per process; there is
  no queue between the API and the worker (it polls the outbox table; see
  [ARCHITECTURE.md](ARCHITECTURE.md#where-the-code-differs-from-what-you-may-have-read)); a list's search matches
  words by their start, not substrings, and shows at most the 300 most recent matches.
- **A tenant cannot yet export or delete its own data on request.** Per-person erasure exists
  ([ADR-0032](adr/0032-erasure-against-an-append-only-audit-log.md)); the wider tenant export and deletion is
  planned work.
- **There is no `THIRD_PARTY_LICENSES` file or licence gate yet.** A few dependencies need a licence review before
  any sale: `sharp` (its image library is LGPL), `jszip` (offered as MIT or GPL: choose MIT), `lightningcss` (MPL-2.0).

## Where decisions are recorded

Every decision that would be expensive to reverse has an [ADR](adr/README.md); read the one before changing the
thing it covers. The security rules are [CLAUDE.md](../CLAUDE.md) section 5 and the configuration rules section 13;
a change that conflicts with either should stop and ask. [CONTRIBUTING.md](../CONTRIBUTING.md) explains how to
make a change, and what a pull request must show.
