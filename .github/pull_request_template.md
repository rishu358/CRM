## What and why

<!-- One or two sentences: what changes, and the problem it solves. Link the ADR or spec section. -->

## Type

<!-- feat / fix / docs / refactor / perf / test / build / ci / chore (the commit type) -->

## Definition of done (CLAUDE.md §12)

- [ ] Types, lint and format pass; all tests pass, including `pnpm test:security`
- [ ] New table: RLS policy **and** a tenant-isolation test
- [ ] New endpoint: authorised through `can()`; unauthenticated gets 401; another tenant's id gets 404
- [ ] State changes emit audit and outbox events
- [ ] UI has loading, empty, error and no-permission states; strings use i18n; dates and money use the shared formatters
- [ ] OpenAPI regenerated (`pnpm openapi:generate`) if an endpoint changed; spec updated if behaviour changed
- [ ] ADR added for any decision that is expensive to reverse

## Configuration, secrets and dependencies

- [ ] No hardcoded domain, email, name, URL, region, bucket or brand text: it comes from configuration
- [ ] No `process.env` outside the configuration package; any new variable is in the registry with its docs
- [ ] A new vendor sits behind a provider adapter
- [ ] No secret, token or real personal data in the diff, tests, docs or logs (the pre-commit hook and CI scan for it)
- [ ] No new dependency, or it was approved first (CLAUDE.md §11.4) and its licence is permissive

## Migrations

- [ ] None, **or** forward-only, additive, safe on a large live table (no long locks; columns added nullable, backfilled in batches)

## How it was tested

<!-- Commands run and what they showed. Say what you did NOT verify. -->

## Risk and rollback

<!-- What could go wrong in production, and how to back out (usually: redeploy the previous image; schema stays). -->
