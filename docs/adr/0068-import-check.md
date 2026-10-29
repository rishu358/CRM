# ADR-0068: An import can be checked first

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

F7, the second of five import changes. A business moving in uploads a file of thousands of rows. Today the
only way to learn that a column is mapped wrongly, that a hundred rows name an account that does not exist, or
that the duplicate rule skips half the file is to run the import and read the result afterwards, by which time
the records exist. The people who do this are the ones we most want to keep.

## Decision

A **check** runs the file through the real import and writes nothing.

- **A check is a job of its own.** `POST /api/v1/imports/{id}/check` takes the same body as `start`, validates
  it with the same function (`assertRunnable`, so a check cannot accept a mapping an import would refuse),
  and makes a second `import_jobs` row beside the one waiting for its mapping: same file, same mapping, same
  duplicate rule, `dry_run = true`. The import being checked stays in `awaiting_mapping`, so the person can
  change the mapping and check again, or press Start. Checks are not listed among a person's imports.
- **The same code, rolled back.** The worker runs each chunk through `processChunk` inside a savepoint it then
  rolls back (`processChunkWithoutWriting`). There is no second implementation of "what an import does": the
  permission checks, the field rules, the owner and account lookups, the duplicate matching, the Zod schemas and
  the database's own constraints all run. Records, audit rows and outbox events written by the chunk disappear
  with the savepoint, so nothing downstream (search, notifications, automations) ever hears of a check. The job's
  own counters, checkpoint and error rows are written outside it.
- **The result is the job.** The counts are what an import would create, update, skip and fail. A failing row
  appears in an error file with its reason, written under a name of its own (`...check.errors.csv`), because the
  import that follows writes the usual one next to the same stored file.
- **The file is shared and is not deleted by a check.** `removeUpload` does nothing for a check, however it
  ends. Only the end of the real import deletes the upload. 0012 made `storage_key` unique across all jobs so
  that one job's end could not delete another's file; it becomes unique among real imports (a partial index
  `WHERE NOT dry_run`), which are the only jobs that delete, and a check may share the key. CI found this: the
  first version inserted the check job and the database refused it.
- **A check cannot become an import.** `dry_run` is part of the job's identity, which the transition trigger
  already guards, so an `UPDATE` that flips it in either direction is refused by the database.
- **Audited.** Starting a check writes an `import` audit entry carrying `dryRun` and the id of the job it
  checked; finishing writes the same completion entry an import does, marked `dryRun`. It does not emit
  `import.completed.v1`.

## What a check cannot tell you

Each chunk is rolled back, so a later chunk cannot see an earlier one's creates. A row that repeats a value
from more than a chunk (500 rows) earlier is counted as new by the check and as a duplicate by the real
import. The screen says so for files larger than one chunk. Everything within a chunk, and everything against
records that already exist, is exact (a test runs the same file both ways and compares).

A check also costs what the import costs apart from the commit: it is a full pass over the file. It uses the
same queues and the same per-tenant limits.

## Consequences

- Migration `0029_import_dry_run.sql`: one column with a constant default, and the transition function replaced
  with the same rules plus `dry_run` immutability. (0026 to 0028 are held by other branches; the migration
  numbering test lists them as reserved here, and the list is trimmed as they land.)
- `ImportJob` gains `dryRun`. The mapping screen has a "Check the file first" button and shows the result under
  it, marked stale if the mapping changes afterwards.
- A check of a very large file keeps the staged rows and the file until it finishes, like an import; both are
  removed (rows) or kept for the import that follows (file) when it does.
