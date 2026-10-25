# ADR-0054: Isolation, teardown and resource budget in the database test suite

- **Status:** Accepted
- **Date:** 2026-10-25
- **Related:** ADR-0002 (shared database + RLS), ADR-0028 (search index), CLAUDE.md §10, §11.6

## Context

`@crm/db` runs against one real Postgres in one Testcontainers container (CLAUDE.md §10). Files keep to
tenants they created, which row-level security makes safe and which keeps one container enough for the
whole suite. The suite began failing intermittently on GitHub Actions and on a memory-starved development
machine, with a different symptom each time and never an assertion about the thing under test: `57P01`
(`terminating connection due to administrator command`), `Connection terminated unexpectedly`, a 30 s
timeout, and `expected 0 to be greater than 0` in `reindex-all.spec.ts`. A plain re-run of an identical
commit passed, so the failures were taken for the machine's.

They were not all the machine's. Four causes, all in the harness or its resourcing, none in the product.
The remedy was **not** retries, longer timeouts or skipped tests (CLAUDE.md §11.6).

## Decision

### 1. Closing a pool means waiting for its connections to be gone

`pool.end()` resolves when every client has been _asked_ to end, not when it has: pg-pool detaches each
client synchronously, calls `client.end()` without awaiting it, and resolves once its list is empty. The
backends outlive the promise. `onboarding.migration.security.spec.ts` followed `pool.end()` with
`drop database ... with (force)`, which terminates whatever is still connected, and the dying client emitted
an `error` nobody was listening for: an unhandled `57P01` that failed a CI run in which all 20 files passed.

`closePool` (`packages/db/src/pool-close.ts`) waits for pg-pool's `remove` event, which is emitted from the
callback of `client.end()`, once per client that existed. It is a count, not a sleep. If a connection
attempt had failed (the one client that never emits `remove`) it rejects after 30 s and says how many
connections were still open, so a dead server fails loudly and does not hang. `createDbClient().close()`
uses it, so every pool created through the data layer closes properly.

The backfill spec now closes its pools and drops its scratch database **without** `with (force)`. Forcing
hid a pool the test forgot to close and raised a FATAL on the connection it killed; without it, a leaked
connection fails the drop and names itself.

### 2. A command whose subject is every company gets a database of its own

`reindexAll` with no tenant lists every company and rebuilds each one's index in a single transaction. In
the shared database that included whatever the files beside it had created: a perf fixture's 100,000
contacts and leads, 33,000 deals, 280,000 index rows. The test's cost and result depended on file ordering,
it cleared those files' indexes underneath them, and it was fast in CI only when it happened to run first.

`createScratchDatabase` (`packages/db/src/testing/scratch-database.ts`) makes a database inside the same
container, runs the production bootstrap file and the migrations, and drops it afterwards. `reindex-all`
uses it, so "every company" means the two it made and the assertion is exact (`tenants: 2`). Use it for any
future test whose subject is the whole cluster; keep everything else in the shared database.

### 3. Tests synchronise on state, never on a sleep

The 60-custom-fields concurrency test held one transaction open, waited a fixed 600 ms and hoped the second
had reached the advisory lock. On a loaded machine it had not, and a connection-level failure surfaced as
an absent SQLSTATE. It now polls `pg_locks` until a second backend is queued behind the lock, and asserts
on the whole captured error.

### 4. The one shared Postgres is given a resource budget

The first three fixes were not enough locally: connection-level failures continued (see Evidence). Sampling
the test container during a full run showed 18 client connections of 100, so not exhaustion, but the
container at about 686 % CPU (roughly seven cores) and the Docker VM's load average near 10 on 12 CPUs.
Every file's `createDbClient` pool has a deliberate five-second connect timeout (a saturated pool should fail
fast in production), and a server that cannot start and authenticate a backend in that time produces
`Connection terminated due to connection timeout` in whichever file is unlucky. Two changes, both in
`packages/db/vitest.config.ts`:

- **`perf` is its own project**, running after `unit` and `security` and one file at a time
  (`sequence.groupOrder: 1`, `fileParallelism: false`). The four `*.perf.spec.ts` files each build tens of
  thousands of rows and their indexes. `pnpm test:security` still selects exactly the `security` project.
- **`maxWorkers: 4`** instead of vitest's default of cores minus one (eleven on the development machine).
  GitHub's two-core runners default to one worker and are unaffected.

What is _not_ known: which of the two changes did the work. They were measured together in the final
batch; the perf project alone was not enough (see Evidence), and `maxWorkers` alone was not tried. The perf
project is kept because it also stops those files' fixtures from competing with everything else, but it is
a candidate for removal if a later ablation shows `maxWorkers` is sufficient.

### 5. What was considered and not done

- **A separate CI job for the perf specs.** Not needed once they are grouped; it would only add runner time.
- **Retries, longer timeouts, skipped tests.** Each would have hidden the causes (CLAUDE.md §11.6). In
  particular the five-second connect timeout was left alone.
- **Changing pool sizes.** Pools are small (2 to 5); there was no exhaustion.
- **Giving Docker Desktop more memory or CPU, or any other change to the machine.** Not the repository's to
  make (CLAUDE.md §14.4). The machine's limits (a 3.8 GB Docker VM using swap, a 7.9 GB host often with
  under 600 MB free) are why the harness must be frugal.

## Consequences

- A spec that opens its own `pg.Pool` should close it with `closePool`, not `pool.end()`, whenever anything
  that terminates backends follows it. Existing specs whose teardown is followed only by process exit are
  unchanged.
- `reindex-all` costs one extra database creation (about 10 s of migrations).
- Wall-clock time on a many-core machine is no longer minimised. It was 94 to 153 s per full run at four
  workers against 112 to 282 s before, because the failures and the container saturation cost more than
  the parallelism saved.

## Evidence

All runs are the full `@crm/db` suite (20 files, 271 tests) on the 7.9 GB development machine with Docker
Desktop, free host memory 43 to 962 MB, with no other test suite running as far as the process list showed
before and during. Run logs are kept outside the repository.

| Configuration                                                  | Full runs | Clean | Failed                                                                                                                      |
| -------------------------------------------------------------- | --------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| Original code                                                  | 4         | 3     | 1: `customization.security` concurrency test, connection-level error                                                        |
| Fixes 1 to 3 (pool close, scratch database, lock wait)         | 5         | 2     | 3: connection timeouts in four files; the container not healthy within 120 s so no test ran; one connection timeout         |
| Fixes 1 to 3 plus the `perf` project                           | 6         | 4     | 2: connection timeouts and resets (`audit-query.perf` and `dashboard.perf`; then five tests in five security files at once) |
| Fixes 1 to 3, the `perf` project and `maxWorkers: 4` (12 runs) | 12        | 12    | 0                                                                                                                           |

- **The two failed runs in the perf-project batch were the first two of that batch.** Another session may
  have been running something at the time. The process list taken afterwards, and the orchestrating
  session's check at 13:44, showed only these runs, but nothing recorded the two failing windows, so it was
  **not shown** that another session caused them. They are counted as failures of that configuration.
- **Twelve clean runs is a bar, not a proof.** At a failure rate near 40 % the chance of twelve clean runs
  by luck is about 0.2 %. One of the twelve began with 43 MB of free host memory and passed.
- **The CI `57P01` was never reproduced locally** (zero occurrences in about thirty local runs); its cause
  rests on reading pg-pool's source and the CI log. What was demonstrated locally, in a throwaway script on an
  otherwise idle machine, is the mechanism: immediately after `await pool.end()` resolved, backends were
  still alive in 3 of 30 trials; after `await closePool(pool)`, in 0 of 30.
- **The CI `expected 0 to be greater than 0` in `reindex-all` was not reproduced and is not explained.** The
  likeliest cause is another file's reindex or clear running between this file's indexing and its count.
  Giving the file its own database removes that possibility, but it was not shown to be the cause.
- One instrumented run each: the default configuration peaked at about 686 % container CPU and VM load 9.9;
  with the `perf` project, about 466 % and 6.6. Twelve and twenty samples at two-second intervals;
  indicative only.
- **Not yet run on GitHub Actions.** The merge gate is the CI result on the pull request.
