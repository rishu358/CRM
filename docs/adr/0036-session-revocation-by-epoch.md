# ADR-0036: Sessions are revoked by an epoch counter, not by comparing clocks

- **Status:** Accepted
- **Date:** 2026-10-20

## Context

ADR-0014 made a password change revoke every other session in one write:
`users.sessions_valid_from` was set to `now()`, and `SessionService.verify`
refused any session whose `created_at` was earlier.

That compares two `now()` values taken in **different transactions**, and
`now()` is the transaction's start time on the database host's wall clock. The
rule is only correct while that clock never moves backwards between the two.
It does. On the machine this suite runs on, the Docker VM's clock steps back by
0.4–1.2 s about every thirty seconds (measured with a `clock_timestamp()` loop
in the Postgres container while the suite ran: five backward steps in 75 s,
the largest 1222 ms). A production host being corrected by NTP, or a VM
migrated between hosts, does the same thing less often.

Two consequences, one of which was observed:

- `users.sessions_valid_from` defaults to `now()` at sign-up, so a step landing
  between sign-up and sign-in left the new session _older than its own user_
  and `GET /api/v1/auth/sessions` answered 401 to a token issued a moment
  earlier. The API security suite failed one test per run this way, a
  different test each time, because the victim is whichever freshly created
  account straddles a step. Instrumenting `verify` showed
  `created_at = …11.027`, `sessions_valid_from = …11.335`, and the same user's
  `signup` audit event at `…10.719` — a row stamped after events that happened
  after it committed.
- "Change password" bumps the column and then issues the replacement session in
  a later transaction, so the user changing their password could be signed out
  by the same step.

A second kind of failure had the same cause: three security specs asserted the
order of audit rows with `order by occurred_at`, which a step reorders.

## Decision

- `users.session_epoch integer NOT NULL DEFAULT 0` and
  `sessions.epoch integer NOT NULL DEFAULT 0` (migration 0015).
- A password change or reset **adds one** to `users.session_epoch`.
- `SessionService.issue` copies the owner's current epoch into the new session
  in the same `INSERT … SELECT`, and `verify` requires
  `sessions.epoch >= users.session_epoch`.
- No clock takes part in deciding whether a session is valid. A session created
  while a bump commits is issued under the old epoch (invalid, correctly) or
  the new one (valid, correctly); there is no third outcome.
- `users.sessions_valid_from` is no longer read. It stays for one release so an
  API instance still on the previous version keeps working during a rolling
  deploy, and a later migration drops it.
- Specs that assert the order of audit rows order by `id`. Those ids are UUIDv7
  minted in the API process, which is monotonic whatever the database clock
  does.

## Consequences

- Sessions already issued stay valid: every existing row is `0 = 0`. A password
  change has always also set `revoked_at` on the other sessions explicitly, so
  no live session predates a bump it should not survive.
- Two regression tests in `auth.security.spec.ts`: one sets the timestamps to
  say "user born tomorrow, session a day old" and requires the session to work;
  one checks that a password change ends the other devices and keeps the one in
  use.
- **Not fixed, and worth knowing:** `audit_logs.occurred_at` and every other
  `now()` default are still wall-clock and can be out of order by a clock step.
  That is acceptable for an audit trail's _timestamps_, but anything that needs
  the order things happened in must not derive it from them. The audit viewer
  sorts by `occurred_at`, so two entries written within a step of each other
  can appear reversed.

## Alternatives considered

- **A tolerance on the comparison** (`created_at >= sessions_valid_from -
interval '2 seconds'`). Rejected: it moves the threshold rather than removing
  the dependency, and it would re-admit a session created in the tolerance
  window before a real password change.
- **`clock_timestamp()` for both values.** Rejected: it is still the wall clock
  and a step between two statements still reorders them.
- **Default `sessions_valid_from` to `-infinity`.** Fixes the observed case and
  none of the password-change one.
- **Retrying the failing tests, or marking them flaky.** Rejected outright
  (CLAUDE.md §11.6): the failure was a real defect that a user could meet.
