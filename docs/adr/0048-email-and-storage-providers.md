# ADR-0048: Email and storage providers

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** ADR-0009 (provider interfaces), ADR-0040/0041 (the guarded outbound client), ADR-0044 (configuration registry), CLAUDE.md §13.5

## Context

To be sold or handed over, the application must run against whatever mail and file services the buyer already
has, chosen by configuration. Email supported `console`, `memory` and `resend`; storage supported `s3` (any
S3-compatible store) and `memory`. The brief asked for SMTP and SES on email, and presets for storage.

## Decision

### 1. Amazon SES, with no SDK

`EMAIL_PROVIDER=ses` sends through SES's v2 REST API. The adapter follows the Resend adapter's design: one
request, sent through the guarded outbound client (`OutboundHttp`) pinned to `email.<region>.amazonaws.com` over
https on 443, no redirects, no logging of the message, address or keys, and an error that is a status plus SES's
own error type.

The request is signed with AWS Signature Version 4, implemented in `packages/outbound/src/sigv4.ts` on
`node:crypto` (about fifty lines, pure, clock as a parameter). It is checked against the signature AWS publishes
for its own `get-vanilla` test vector, which a wrong canonicalisation or key derivation cannot match by accident.

Why not `@aws-sdk/client-sesv2`: a large dependency tree to audit, and an HTTP client outside the one guarded
door every outbound call goes through. The signing algorithm is stable and small.

The region is validated against the shape of an AWS region name before it becomes part of a host name, so a
mis-set value cannot send the signed request somewhere else. The China regions (a different domain) and
temporary credentials with a session token are not supported; both are additive if needed.

### 2. One factory for both processes

The API and the worker each built the Resend provider themselves. `createRemoteEmailProvider` in
`@crm/outbound` now builds every provider that really sends, from the same settings, and both call it, so they
cannot disagree about what a provider needs. A missing setting is reported by the variable's name, never its
value. `console` and `memory` stay in each process, with their own refusal to run in production. The
production guard (`@crm/core`) knows what SES needs.

### 3. SMTP: not decided yet

SMTP is a protocol, not a request: STARTTLS negotiation, authentication, dot-stuffing, MIME and the encoding of
non-ASCII headers. Writing it by hand is how header-injection and encoding bugs are made, and a mail library is
the usual answer. That is a new runtime dependency, which CLAUDE.md §11.4 says to ask about, so it is **not
added here**. The decision, and the options, are with the owner. Until then `EMAIL_PROVIDER=smtp` is refused as
not a provider this build can send with, in the validator and at start-up.

### 4. Storage: documented recipes, not presets in code

The storage adapter already speaks to any S3-compatible store through five settings. A "preset" (`aws`, `r2`,
`spaces`) would derive some of them from a vendor name, and so would put vendor hostnames into application code,
which CLAUDE.md §13.5 forbids outside an adapter, to save an operator setting three variables once. It would also
encode hostname patterns that cannot be checked here against a live service. Instead, `docs/PROVIDERS.md` gives
the values for each store, and says plainly which were verified and which were written from documentation.

## Alternatives considered

- **The AWS SDK for SES.** See §1.
- **A hand-written SMTP client.** See §3.
- **Storage presets.** See §4. If the number of stores grows, a preset belongs inside the storage package, which
  is an adapter, never in the registry or the apps.
- **Duplicating the factory per app, as before.** It had already drifted: the worker's carried its own copy of
  the missing-key message.

## Consequences and limits

- SES needs a verified identity in the same region and an account out of the SES sandbox before it delivers to
  anyone. The adapter cannot detect either; the documentation says so.
- SES delivery was verified against fakes and the published signing vector. **It has not been run against a live
  SES account.** A real send is the first thing to try on deploying with it.
- The deploy templates (`deploy/`) still show Resend, which is the combination they were written and checked
  for. Using SES means changing those variables; `docs/PROVIDERS.md` lists them.
