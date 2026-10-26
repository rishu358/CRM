# ADR-0050: Argon2id password hashing, on Node's own implementation

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** ADR-0017 (Better Auth as primitives), ADR-0009 (provider interfaces), ADR-0049 (key rotation), CLAUDE.md §5.8, §5.9, §11.4

## Context

Passwords were hashed with Better Auth's scrypt (ADR-0017), which the ADR named as one file to change when
the time came ("a rehash-on-login, not a search across the codebase"). Argon2id is the algorithm current
guidance (OWASP, RFC 9106) recommends for new password storage, it is what a buyer's security review will
look for, and a hash that records its own cost can be strengthened later without a reset.

bcrypt was considered and rejected: it truncates at 72 bytes, is not memory-hard, and gains nothing over
what is here.

## Decision

### 1. Argon2id, by `node:crypto`, with no new dependency

Node 24.7 added `crypto.argon2`. The project already runs Node 24 (the Docker image, CI and local setup), so
the implementation is the platform's own: **nothing to install, audit, or build as a native add-on**, and no
vendor in the sign-in path. `engines` is raised from `>=22.0.0` to `>=24.7.0` to say what is already true.

The alternative, `@node-rs/argon2` (MIT, a prebuilt native binary per platform), would have added the first
native binary executing inside the API process for no capability the platform lacks. It remains the fallback if
the project ever has to run on an older Node.

The primitive was checked against the specification, not only against itself: Node's Argon2id reproduces the
RFC 9106 §5.3 test vector (a test pins it), and its Argon2i variant reproduces the reference implementation's
published example. The hasher's own encoding is checked by a hash pinned from this release, so a later change
cannot silently stop verifying what is already stored.

### 2. The stored form carries its cost

A standard PHC string: `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>`. A random 16-byte salt per
hash, a 32-byte tag, constant-time comparison. Because the parameters are in the string, a password hashed
last year verifies at last year's cost, and raising the cost never strands anyone.

### 3. The cost is configuration, with floors

`PASSWORD_HASH_MEMORY_KIB` (default and floor 19456, i.e. 19 MiB), `PASSWORD_HASH_PASSES` (default and floor 2)
and `PASSWORD_HASH_PARALLELISM` (default 1). The floor is the OWASP minimum for Argon2id: a deployment can make
hashing slower and cannot make it weaker. Measured on the development machine, the default costs about 127 ms
a hash, against about 148 ms for the scrypt it replaces.

Memory is the number to plan around: each hash holds its memory for its duration, and Node's thread pool runs at
most four at once by default, so sign-in traffic costs at most four times the setting. The sign-in route is
rate-limited per address and per user (CLAUDE.md §5.14) and throttled after failures.

### 4. Existing passwords keep working, and are upgraded as people sign in

`verify` accepts both formats: an Argon2id string is verified here; anything else is the old `salt:key` form
and is verified by Better Auth's own verifier, unchanged. No account needs a reset.

`needsRehash` says a hash that has just verified should be replaced: it is in the old format, or made with
weaker settings than are configured now. It never says so for a hash that is stronger than the setting, so a
hash is never weakened by an application still running a lower one.

After a **successful** sign-in (the one moment the plaintext of a correct password is in hand), the service
writes the new hash:

- **Only if the stored hash is still the one that verified** (`UPDATE … WHERE password_hash = <old>`). Without
  that, a sign-in that verified the old password could write its upgrade after the owner had changed the
  password, and put the old one back. A refusal is not an error; the next sign-in tries again.
- **Best effort.** A failure to upgrade is logged by user id (never the password or a hash) and does not fail a
  sign-in the person has just passed.
- **Not a password change.** It does not bump the session epoch or revoke anything: nothing about who may sign
  in has changed. A test signs in again during an upgrade and shows an earlier session survives.
- A wrong password changes nothing.

Changing or resetting a password always writes the current format.

### 5. Unknown addresses cost the same

`verifyDummy` verifies against an Argon2id hash made at the current settings, so an unknown address takes about
what a known one does (a test compares the two). A known account still on the old format takes scrypt time, in
the same range; the difference narrows as accounts are upgraded and is within what the existing throttle already
blurs.

### 6. A stored hash cannot ask for unbounded work

Parameters are read out of the stored string, so they are bounded (memory up to 1 GiB, passes up to 10, lanes up
to 8) and a hash outside the bounds, or malformed, is a failed sign-in rather than a request for gigabytes. The
hash comes from our own database, so this is protection against corruption and a bad restore more than an
attacker.

## Alternatives considered

- **`@node-rs/argon2`.** See §1.
- **bcrypt.** See Context.
- **Re-hashing everyone in a batch.** Impossible: the plaintext is not known. Upgrading at sign-in is the only
  moment it can be done, and accounts that never sign in again stay on the old format, which is still sound.
- **Failing the sign-in if the upgrade fails.** Turns a storage hiccup into a login outage for someone with the
  right password.
- **A pepper (the `secret` parameter).** A second secret to store, rotate and lose, which makes every hash
  unverifiable if it is lost. The key ring (ADR-0049) is how such a secret would be managed if added; it is not
  needed to meet current guidance.

## Consequences and limits

- **Node 24.7 or later is required**, and the README, CONTRIBUTING and `engines` say so. A host on Node 22 will
  not start the API's hasher.
- **The demo seed** still writes an old-format hash for the demo user (the seed uses Better Auth's utility
  directly); it is upgraded on that user's first sign-in, like any other.
- **Accounts that never sign in stay on the old format**, which is not weak, only not current.
- The two settings that can raise hash cost are per deployment; they apply to **new** hashes and to upgrades, so
  raising them does not slow existing sign-ins until the owner next signs in and is upgraded (once).
- Timing across formats is not identical (see §5). Measuring and equalising it fully would mean verifying every
  unknown address against both formats, which doubles the cost of every probe for a gap that closes as accounts
  are upgraded.
