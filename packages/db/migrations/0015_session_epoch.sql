-- Session revocation by epoch instead of by wall clock (ADR-0036).
--
-- `SessionService.verify` used to refuse a session whose `created_at` was
-- earlier than the user's `sessions_valid_from`. Both are `now()` — the start
-- time of two *different* transactions — so the rule only holds while the
-- database clock never goes backwards between them. It does: a VM clock
-- resync (Docker Desktop's, here) rewinds it by up to a second or more, and a
-- user created at 11.335 whose session is stamped 11.027 is refused as signed
-- out the moment they sign in. The same hazard sat in "change password",
-- which bumps the column and then issues the replacement session in a later
-- transaction.
--
-- A counter has no such failure. A bump adds one to `users.session_epoch`; a
-- session records the epoch it was issued under and is valid while that is
-- still current. Issuing reads the epoch in the same statement that inserts
-- the row, so a session created while a bump commits is either issued under
-- the old epoch (and is correctly invalid) or the new one (and is correctly
-- valid) — there is no third outcome and no clock in the answer.
--
-- Both columns are NOT NULL DEFAULT 0, a metadata-only change on PG 11+, so
-- it takes no long lock. Every existing row is 0 = 0, which is right: a
-- password change has always also revoked the other sessions explicitly
-- (`revoked_at`), so no live session predates a bump it should not survive.
--
-- `users.sessions_valid_from` is left in place and no longer read, so an API
-- instance still running the previous release keeps working during a rolling
-- deploy. A later migration drops it.

ALTER TABLE users ADD COLUMN session_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN epoch integer NOT NULL DEFAULT 0;
