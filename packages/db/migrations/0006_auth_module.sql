-- Authentication module (MVP_SPEC M1, ADR-0014, ADR-0017).
--
-- Additive only: new nullable columns, new defaults, new indexes. Nothing here
-- rewrites a row or holds a long lock, so it is safe on a large live table
-- (CLAUDE.md §7).

-- ---------------------------------------------------------------------------
-- sessions
--
-- `last_seen_at` powers the "your devices" list, where the useful question is
-- "when was this last used", not "when was it created". Nullable: existing
-- sessions genuinely have no answer, and inventing one would be a lie on a
-- screen whose whole job is helping someone spot a session that is not theirs.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz;

COMMENT ON COLUMN sessions.last_seen_at IS
  'Last request made with this session, updated at most once a minute.';

-- ---------------------------------------------------------------------------
-- verifications
--
-- One table serves email verification, password reset and the short-lived
-- token that carries a half-finished sign-in across the MFA challenge. Without
-- `purpose`, a token minted for one of those would be accepted by the others:
-- a password-reset link would verify an email address, and worse, an email
-- verification token would reset a password. The CHECK makes a new purpose a
-- deliberate migration rather than a typo.
--
-- `value` holds the SHA-256 of the token, never the token, for the same reason
-- `sessions.token_hash` does (migration 0005): a stolen backup must not hand
-- over working password-reset links.
-- ---------------------------------------------------------------------------
ALTER TABLE verifications
  ADD COLUMN purpose text NOT NULL DEFAULT 'email_verification',
  ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE verifications
  ADD CONSTRAINT verifications_purpose_chk
  CHECK (purpose IN ('email_verification', 'password_reset', 'mfa_challenge'));

-- Lookup is by hash alone, and a hash collision across purposes would be a
-- confused-deputy bug, so uniqueness is global rather than per purpose.
CREATE UNIQUE INDEX verifications_value_key ON verifications (value);
CREATE INDEX verifications_user_purpose_idx ON verifications (user_id, purpose);

COMMENT ON COLUMN verifications.value IS
  'SHA-256 of the token. The token itself is never stored.';
COMMENT ON COLUMN verifications.consumed_at IS
  'Set the first time the token is redeemed. Tokens are single-use.';

-- ---------------------------------------------------------------------------
-- mfa_factors
--
-- One factor of each type per user. Without this, a second enrolment would add
-- a row rather than replace one, and a user who re-enrolled would end up with
-- an old secret still accepted — an authenticator they thought they had
-- removed would keep working.
-- ---------------------------------------------------------------------------
ALTER TABLE mfa_factors ADD COLUMN last_used_at timestamptz;

CREATE UNIQUE INDEX mfa_factors_user_type_key ON mfa_factors (user_id, type);

COMMENT ON COLUMN mfa_factors.secret IS
  'TOTP: the encrypted base32 secret. backup_codes: encrypted JSON of SHA-256 code hashes.';

-- ---------------------------------------------------------------------------
-- auth_events
--
-- Brute-force protection counts recent failures per address and per source
-- address (MVP_SPEC M1). The per-address index exists; the per-IP one does
-- not, and without it every sign-in attempt would sequentially scan a table
-- that only ever grows.
-- ---------------------------------------------------------------------------
CREATE INDEX auth_events_ip_time_idx ON auth_events (ip_address, occurred_at);

-- Append-only, like audit_logs: enforced by withholding the grants rather than
-- by a policy, because a policy can be dropped by a later migration without
-- anything looking wrong. crm_auth was granted UPDATE and DELETE here in 0004
-- along with the rest of the identity tables; it never needed either.
REVOKE UPDATE, DELETE ON auth_events FROM crm_auth;

-- ---------------------------------------------------------------------------
-- tenants
--
-- A tenant exists before it has been equipped with roles and field metadata,
-- and before its founder has a membership. `status` already carries that, but
-- nothing wrote the intermediate value, so a signup that died midway left a
-- tenant indistinguishable from a healthy one. Now it is visible.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants
  ADD CONSTRAINT tenants_status_chk
  CHECK (status IN ('provisioning', 'active', 'suspended', 'cancelled'));

-- ---------------------------------------------------------------------------
-- Sessions are revoked in bulk when a password changes, and listed per user.
-- Both read by user and skip the revoked rows; the existing index on user_id
-- alone makes that a filter rather than a seek.
-- ---------------------------------------------------------------------------
CREATE INDEX sessions_user_active_idx ON sessions (user_id, revoked_at, expires_at);
