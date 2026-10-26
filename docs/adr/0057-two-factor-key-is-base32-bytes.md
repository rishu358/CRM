# ADR-0057: The two-factor key is read as base32 bytes, the way an authenticator app reads it

- **Status:** Accepted
- **Date:** 2026-10-26

## Context

The pilot simulation (finding F1) found that two-factor sign-in could not be set up from the key the
Security screen shows. The screen shows a base32 text key and no QR code. Typing it into an authenticator
app gave six-digit codes the server always refused (401 `MFA_INVALID`).

The cause: `createOTP(secret)` from `@better-auth/utils/otp` uses the secret string as the _text_ of the
HMAC key, and its `url()` base32-encodes that text again for the `otpauth://` link. We generated a base32
string, stored it, showed it, and passed it as that text. An app that is given the shown key decodes it to
20 bytes and computes with those. The server computed with the 32 characters of the text. Only the QR link,
which carried the base32 of the text (52 characters), matched, so only people who scanned a link could ever
get in, and the web app has no QR code.

## Decision

- **The key is 160 random bits.** It is shown to the person as RFC 4648 base32 (32 characters), and the
  `otpauth://` link carries that same string. The server decodes it to bytes before computing a code.
  The algorithm is written out over `node:crypto` (HMAC-SHA1, RFC 4226 dynamic truncation, six digits,
  30-second steps) instead of through the library, whose API cannot take bytes. The link now also says
  `algorithm=SHA1` explicitly.
- **The window is unchanged:** one 30-second step either side, no more. All three steps are compared
  every time, in constant time.
- **The stored text says how to read it.** New secrets are stored (encrypted under the key ring,
  ADR-0049, exactly as before) as `base32:<key>`. A stored secret with no marker was written before this
  change, when the characters of the base32 text were the key; an app enrolled from the QR link holds
  exactly that, so such a person keeps signing in. Each stored secret is checked by exactly one rule, so
  the number of codes that can succeed for one person is the same as before. A person who sets
  two-factor up again gets the standard form. The old rule can be deleted once nobody has an unmarked
  secret; `mfa_factors.secret` is encrypted, so that cannot be counted from SQL.
- **Tests use an independent reference** (`apps/api/src/testing/totp-reference.ts`) checked against the RFC
  4226 Appendix D values, and the RFC 6238 Appendix B values, so a test never asks the code under test what
  the right code is.

## Consequences

- Key rotation (ADR-0049) is untouched: the marker is inside the encrypted text, which the rotation
  decrypts and re-encrypts as one string.
- Backup codes are untouched.
- Not checked in a real phone app (no phone on this machine); the reference follows the RFCs that the
  authenticator apps implement.
