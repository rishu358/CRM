# ADR-0049: Key ids, and rotating `AUTH_SECRET` without losing authenticators

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** ADR-0017 (auth module), ADR-0044 (configuration registry), CLAUDE.md §5.8, §13.6

## Context

A handed-over system needs a way to change its secrets. Most can be swapped at the provider with no memory of
the old value (an API key, a password). `AUTH_SECRET` cannot: it **encrypts authenticator (MFA) secrets and
backup codes at rest**, so changing it makes every enrolled authenticator unreadable and every MFA user must
re-enrol. The runbook said so, and that rotating it "signs everyone out" because "cookies are signed with it".

An audit of every use of the secret found that second claim to be wrong. A session is a random token stored
hashed in the database; nothing in the application signs a cookie (the cookie plugin is registered with the
secret and never asked to sign). Rotating `AUTH_SECRET` did not sign anyone out; it only broke MFA. A test now
proves a session survives a rotation.

## Decision

### 1. Each stored value says which key wrote it

Encrypted values are stored as `k1.<key id>.<ciphertext>`. The key id is eight hex characters of a
domain-separated SHA-256 of the key: it identifies a key and reveals nothing usable, and it is **derived**, not
configured, so there is no second setting to keep in step with the first. Writing always uses the current key;
reading finds the key by id.

A value written before this format has no id. It is tried against each key held, current first. The cipher is
authenticated, so a wrong key fails instead of producing noise, and nothing is mistaken for plaintext.

### 2. A key ring: `AUTH_SECRET` and `AUTH_SECRET_PREVIOUS`

`AUTH_SECRET` is the current key. `AUTH_SECRET_PREVIOUS` is a comma-separated list of earlier keys, newest first,
at most three, each at least 32 characters. The process refuses to start on a malformed list or on a previous key
equal to the current one, naming the variable and never a key. Production applies the same quality checks to a
previous key as to the current one: a retired key still opens stored data.

The cookie plugin is given the whole ring, so if something signs a cookie one day, a rotation does not invalidate
it.

### 3. Rotation is a procedure with a command

1. Deploy the new `AUTH_SECRET` with the old one as `AUTH_SECRET_PREVIOUS`. Nothing is lost.
2. `pnpm auth:rotate-keys` re-encrypts what is stored under the current key, in pages, as the auth role (the only
   role that reads `mfa_factors`). `--dry-run` reports and changes nothing.
3. When it reports nothing left under an old key, remove `AUTH_SECRET_PREVIOUS`.

The command is **safe to repeat and safe while serving**. Each row is rewritten only if it is still exactly what
was read (a compare-and-swap in the `UPDATE`), so a user spending a backup code at that instant is never
overwritten with a stale list; such a row is counted and picked up by the next run. `last_used_at` is not
touched. It exits non-zero while anything is left under an old key or unreadable, so a script can wait for zero.
Its output is counts and key ids, never a secret.

It is not injectable from any controller or service (its module does not export it); like the entitlements
command, it is reached only from the operator's shell.

### 4. The inventory is a document with a test

`docs/SECRETS.md` lists every secret, what it protects, who holds it, how to rotate it and what to do if it is
exposed. A test reads the registry and fails if a secret is not on that page, so a new secret cannot be added
without saying how it is rotated.

## Alternatives considered

- **A configured key id** (`AUTH_SECRET_ID=2026-10`). One more value to forget to change, and nothing checks it
  agrees with the key. Deriving it from the key cannot disagree.
- **Re-encrypting lazily, when a value is next used.** Leaves values under the old key indefinitely, so the old key
  can never be safely removed. The command gives a clear "done".
- **Envelope encryption (a data key per row, wrapped by a master key).** The standard answer when keys are held by
  a KMS and rotated frequently. It adds a key-management dependency this product does not otherwise have; the key
  ring is the same idea at the size that fits, and the stored format leaves room (`k1`) to move to it.
- **Doing nothing and documenting that rotation breaks MFA.** What the runbook did. Unacceptable for something a
  buyer's security team will ask about in the first meeting.

## Consequences and limits

- **Existing values are upgraded by the command, not by deploying.** Until it is run once, stored values are in the
  old format; they still work (they are read as legacy), and the first run converts them.
- **A key that is truly lost loses what it encrypted.** The command reports those values as unreadable and leaves
  them untouched; those users re-enrol their authenticator. Nothing else about their account is affected.
- **Only MFA material is encrypted with this key.** If another use is added, it should go through the same ring.
- **The other secrets** (database passwords, provider keys) have no application-side key history: they are swapped
  at the provider and in the host's secret store, and `docs/SECRETS.md` says how, one at a time and without an
  outage.
- The race-safety is tested by making a request-like write land between the read and the write; the test fails if
  the compare is removed.
