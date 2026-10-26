# ADR-0052: The handover documentation set, and the checker that keeps it true

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** ADR-0044 (generated configuration docs), ADR-0051 (setup command)

## Context

A handed-over system is read by people who were not there. The repository had good documents (a runbook, an
ADR for every large decision, generated configuration and API references) but no way in: nothing said which to
read first, how the pieces fit, what a new owner must change, or what had never been exercised. And a document
that was right when written stops being right when a file is renamed or a script is removed, with nobody
noticing until a reader follows a dead link or types a command that no longer exists.

## Decision

### 1. A small set of documents, each with one job, linked from one index

`docs/README.md` is the index, organised by what the reader is trying to do. New documents:

- **ARCHITECTURE.md**: one page on how the three programs and the packages fit, tenant isolation, authorization,
  events, configuration, providers and secrets, linking to the ADR for each rather than copying it.
- **SETUP.md**: a development machine, from nothing to signed in, and what to do when it does not work.
- **DEPLOYMENT.md**: what a production installation needs and the order to bring it up, without assuming a host.
  It points at the runbook for commands and does not repeat them: two copies of one procedure disagree within a
  month.
- **HANDOVER.md**: what changes hands, what to do first, what names the previous owner, what was and was not
  verified, and the known gaps.

Existing documents (the runbook, the ADRs, `CONFIGURATION.md`, `PROVIDERS.md`, `SECRETS.md`) are linked, not
rewritten. Every statement in a new document was checked against the code; where the code differs from an older
document, the new one says what is built (`ARCHITECTURE.md` notes that there is no BullMQ queue, although
`CLAUDE.md` lists one).

### 2. HANDOVER.md says what was not verified, and is dated

A handover that sounds more finished than it is costs the next owner more than one that says plainly what was
never run against the real thing. `HANDOVER.md` lists those items and carries a date, and sends the reader to the
changelog for what has changed since.

### 3. A checker, run in CI

`scripts/check-docs.mjs` (zero dependencies, like the other repository scripts) reads every Markdown file, tracked
or new, and fails on:

- a link to a file or directory that does not exist;
- a link to a heading that is not in the file it names (using GitHub's anchor rules, including `-1` suffixes for
  repeated headings);
- a `pnpm` command quoted in code (inline or fenced) that is not a script in the root `package.json`, or, with
  `--filter`, in that package's. pnpm's own commands (`install`, `exec`, `audit`, ...) are always accepted.

Links inside code fences, web and mail addresses, and prose are left alone. The checks are pure functions of the
file texts and the scripts that exist, tested without the disk (15 tests), and CI runs the checker in the
repository-scripts job.

The first run found one real error that had been in the specification since the load test was written: two
load-test commands quoted without their package (`perf:seed` and `perf:run` are scripts of `@crm/db` and
`@crm/api`, not of the root). It was fixed.

## Not covered

- The checker proves a link points somewhere, not that the page says what the link text claims, and that a command
  exists, not that it still does what the document says. Prose can still go stale; this removes the cheapest way.
- It does not check links into code (`apps/api/src/...`) written as file names in prose or backticks, only Markdown links.
- The statement of what has not been verified (`HANDOVER.md`) is written by a person and goes stale by itself. It
  carries its date for that reason.
