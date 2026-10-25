# ADR-0051: The setup command

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** ADR-0044 (configuration registry), ADR-0046 (deployment modes), ADR-0049 (key rotation), CLAUDE.md §13

## Context

Getting from a clone to a running stack took seven commands and a file copy, with the order and the one
secret to change living in the README. A buyer's developer should get a working local system in one step, and
be told plainly what is missing when they cannot.

## Decision

### 1. One command, `pnpm run setup`, with no dependencies

`scripts/setup.mjs` is plain Node with no packages, like the commit hooks and the commit-message check, so it
works before `pnpm install` has produced anything to depend on and adds nothing to audit.

The script is run as `pnpm run setup`. `pnpm setup` without `run` is a built-in pnpm command that configures
pnpm itself; it cannot be shadowed, so the README says which to type.

### 2. Every step is idempotent and says what it did

In order: check the machine (Node 24.7 or later, because password hashing uses Node's built-in Argon2id,
ADR-0050; pnpm; a running Docker); create `.env`; start the services; apply the migrations; create the demo
workspace; build. Each prints one line saying what it did or why it skipped. A failing step stops the run,
names the command that failed, and says it is safe to run again.

- **`.env` is created only if absent, and never overwritten.** A new one is a copy of `.env.example` with
  `AUTH_SECRET` replaced by 48 random bytes (base64) from the system's random source.
- **An existing `.env` is never edited, even if `AUTH_SECRET` is still the development placeholder.** That
  secret encrypts enrolled authenticators; changing it under an existing database would make them unreadable
  (docs/SECRETS.md). The script warns instead.
- **The demo workspace is created on the first run only** (the run that created `.env`), because the seed adds a
  workspace every time it runs. `--seed` asks for another; `--no-seed` skips it.
- **Migrations are applied every run:** they are forward-only and a no-op when current.
- **It never prints a secret**, including the one it generates, and the file is written owner-only where the
  system supports it.

### 3. A check mode

`pnpm run setup -- --check` runs the machine checks and looks for `.env`, and changes and starts nothing. It
exits non-zero with the reason, so the same script is the diagnosis when something does not work.

### 4. Testable without Docker

Every outside effect (files, commands, randomness, output) is a parameter of `runSetup`. The tests run it
against a fake filesystem and a fake command runner: they cover the order of the steps, that `.env` is never
overwritten, that the secret is generated, never printed and kept literal when it contains `$`, that a repeat
run changes nothing, what each missing prerequisite says, and that a failing step stops the run. They are part of
the repository-script tests that CI already runs. A mutation check (always recreating `.env`) fails three of them.

### 5. Commands are constants

The script runs commands through a shell, because `pnpm` is `pnpm.cmd` on Windows and Node will not start a
batch file without one. Every command and argument is a literal in the file; nothing a user typed reaches a
shell, and the command line is joined into one string rather than passed as an argument array to a shell
(deprecated and easy to misuse).

## Not here

- **A local mail inbox (Mailpit).** Verification and reset mail is still printed to the API log in development.
  Adding the container needs an image pinned by digest and probably mirrored, as MinIO had to be (its upstream
  stopped being publicly pullable), which needs network access and a decision. It is the next piece of this work.
- **A minimal seed** (one workspace and owner, no sample data). `--no-seed` followed by `pnpm tenant:create` does
  that today; a seed profile would be a convenience on top.
- The real commands were not run against Docker in this change; the tests prove the script's decisions, not
  that `pnpm infra:up` starts. A first real run on a clean machine is the check.

## Alternatives considered

- **A shell script and a PowerShell script.** Two languages for the same logic, and tests for neither.
- **A `postinstall` hook.** Runs on every install for every consumer of every package, creates files nobody
  asked for, and cannot ask a question. Setup is something a person chooses to run.
- **Generating `AUTH_SECRET` into an existing `.env`.** See §2.
- **Making `db:seed` idempotent and running it every time.** A larger change to a script that currently makes a
  fresh demo workspace each run on purpose (it is how a developer gets a clean one).
