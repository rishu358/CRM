-- Rename sessions.token to sessions.token_hash.
--
-- The column always held a hash rather than the token itself, but the name said
-- otherwise, and a column called `token` invites someone to put a token in it.
-- A stolen database backup must not hand over usable sessions.
--
-- Written as a new migration rather than an edit to 0001: migrations are
-- forward-only (CLAUDE.md §7), and the runner refuses a file whose checksum
-- changed after it was applied.

ALTER TABLE sessions RENAME COLUMN token TO token_hash;
ALTER INDEX sessions_token_key RENAME TO sessions_token_hash_key;

COMMENT ON COLUMN sessions.token_hash IS
  'SHA-256 of the session token. The token itself is never stored.';
