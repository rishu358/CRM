# ADR-0019: Who may accept an invitation, and where its token lives

- **Status:** Accepted
- **Date:** 2026-10-17
- **Relates to:** [ADR-0002](0002-shared-db-tenant-id-rls.md), [ADR-0014](0014-self-hosted-auth.md), [ADR-0017](0017-better-auth-as-primitives-not-framework.md)

## Context

MVP_SPEC M2 asks for "invite users by email with a role; invite links expire in
7 days". The permission engine, record scope and field permissions were all
built and tested before this, but nothing in the product ever wrote a second
`memberships` row — a workspace could only ever contain the person who signed
up. Invitations are what make the rest of the authorization work reachable.

Two decisions here would be expensive to reverse: one about identity, one about
where the token is stored. Both are security decisions rather than product
ones, so neither was left to the spec.

## Decision 1: acceptance always matches the accepting identity to the invited address

An invitation link proves one thing: whoever holds it can read the mailbox it
was sent to. That is the same proof a password-reset link collects, and it is
worth exactly as much — no more.

| Who opens the link                       | What happens                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Nobody signed in, address has no account | Account created **at that address**, membership active, session issued |
| Nobody signed in, address has an account | Refused, `INVITATION_SIGN_IN_REQUIRED` (401). The link is untouched    |
| Signed in as the invited address         | Membership linked, no new session, the session switches workspace      |
| Signed in as anybody else                | Refused, `INVITATION_RECIPIENT_MISMATCH` (403). The link is untouched  |

### Why an existing account must sign in first

The tempting behaviour — recognise the address, link the membership, sign them
in — is a second-factor bypass. A person who enrolled TOTP did so to make a
stolen password useless. If an emailed link can produce a session for their
account, then anybody who reads their mail for thirty seconds gets one without
ever meeting the authenticator. Note that nothing else in this codebase issues
a session from an emailed token either: `resetPassword` sets the password and
returns no session precisely so that the next sign-in goes through MFA.

Worse, the invited address is chosen by the _inviter_. Without this rule, any
administrator of any workspace could invite `someone@victim.example`, and the
link would be a ready-made session for that account the moment it reached a
mailbox the attacker could read. The rule makes an invitation worth no more
than mailbox access already is.

The cost is real: a consultant joining their fourth workspace has to sign in
before the link works. The acceptance screen says so and links to sign-in, and
the invitation is still pending when they come back.

### Why a new account is different

There is no account to protect and no second factor to walk past. Creating one
at the invited address, from a token delivered only to that address, is the
same proof sign-up collects with its verification link — so the address is
marked verified and a session is issued. Anything stricter would mean mailing a
second link to confirm what the first one just confirmed.

### Why a mismatch refuses rather than redirects

A refused attempt consumes nothing. Every identity check happens before the
redeeming `UPDATE`, so an administrator who opens a colleague's link, or an
attacker who guesses at one, leaves it exactly as it was for the person it was
sent to. The response says which address the invitation is for, which is safe:
only somebody already holding the token sees it, and they obtained it from that
mailbox.

### The preview is allowed to say whether the address has an account

The acceptance screen has to know which of three forms to draw, so
`GET /invitations/accept` returns `requiresAccount`. Everywhere else in the
product that would be user enumeration (MVP_SPEC M1), and it is not here for
one reason: the answer is only given to somebody holding a secret that was
mailed to that address. The person who _chose_ the address — the inviter —
never sees the token, because the API never returns it.

## Decision 2: the invitation token lives on the `invitations` row, not in `verifications`

`verifications` holds the one-time tokens for email verification, password
reset and the MFA hand-off. Reusing it for invitations was the obvious move and
is the wrong one, because an invitation is **tenant-owned data**: it names a
workspace, carries the role it confers, records who sent it, and has to be
listable and revocable by that workspace's administrators and nobody else.
`verifications` is global, reachable only by `crm_auth`, and has nowhere to put
a tenant or a role. Adding those columns would put tenant data in a table with
no RLS policy, which ADR-0002 exists to prevent; keeping them in a second table
would mean two rows that can disagree about when an invitation expires and
whether it has been used.

So `invitations` is a tenant table with RLS like any other, and it carries
`token_hash` — the same way `sessions` carries its own digest rather than
borrowing `verifications`. What is reused is the part that matters: only the
SHA-256 is stored, and redemption is a single
`UPDATE ... WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING ...`,
so two concurrent acceptances cannot both win.

### The workspace prefix on the token

Redeeming a token means opening a transaction for some tenant, and under RLS
the tenant must be known _before_ the row can be read. The token is therefore
`{workspaceId}.{secret}`, and the prefix is a **routing hint, never an
authorization**: the row is still found by the digest of the whole token inside
that workspace's RLS context, so editing the prefix just selects a context
where the digest matches nothing, and guessing a workspace id buys nothing
without a secret. A security test asserts exactly this.

The alternative was a `SELECT` grant for `crm_auth` on `invitations`, or a
`SECURITY DEFINER` function, to turn a digest into a tenant id outside any
tenant context. Both widen a database role's reach permanently to save a dotted
prefix in a URL. The prefix costs nothing and keeps the role split intact.

## Decision 3: no membership row exists while an invitation is pending

`memberships.status` has an `invited` value, and the obvious reading is that an
invitation is a membership waiting to be activated. It cannot be: `user_id` is
`NOT NULL`, and most invitees have no user row yet. Creating one at invite time
would let anybody with the invite permission reserve any address on the
platform, which sign-up would then silently refuse to use — and the
no-enumeration rule means the person would never be told why.

Writing a pending membership **only** for addresses that already have accounts
is worse: the workspace's own member list would then distinguish invitees who
have accounts from those who do not, handing every administrator an enumeration
oracle for any address they care to invite.

So the membership is created at acceptance, already `active`, with `invited_by`
and `invited_at` copied from the invitation so the provenance MVP_SPEC §6.1
asks for survives. `status = 'invited'` keeps its meaning for a member an
administrator has not yet activated, and `ActorService` continues to refuse
anything that is not `active` — now with a test that says so.

## Consequences

- An invitation can never join a workspace other than the one it was issued
  for, or confer a role other than the one it was issued with: both are read
  from the row, and the contracts are `.strict()` so a request that names
  either is a 422.
- A person who already has an account meets one extra sign-in. In exchange, an
  emailed link is never a way around their second factor.
- Invitations are ordinary tenant data: isolated by the same policy as contacts,
  listed and revoked through the same `can()` engine, audited in the same
  transaction as the change.
- `invitation` joins the object-type registry as an administrative object with
  no owner, so the only meaningful scope on it is `all`. Owner and Admin hold
  it; every other role is denied by the absence of a grant.
- When M3 builds the users and roles module, membership writes and the
  assignable-roles endpoint move there. They live in the invitations module
  today because it is the only thing that needs them, not because they belong
  to it.

## Alternatives considered

- **Link the membership and sign the recipient in, for an address that already
  has an account.** Rejected: an MFA bypass, and a way for any administrator to
  mint a session for an address they chose.
- **Require a signed-in session for every acceptance, including new users.**
  Rejected: there is no account to sign in to, so it describes a flow that
  cannot complete.
- **Put the invitation token in `verifications` with a new purpose.** Rejected:
  no tenant and no role can live there, and splitting one invitation across two
  tables gives two sources of truth for its expiry and its single use.
- **Grant `crm_auth` a read on `invitations` to resolve the tenant.**
  Rejected: a permanent widening of the auth role to avoid a prefix in a URL.

## Numbering note

This record was written as ADR-0018. The Accounts module independently claimed
that number on a parallel branch, and it was renumbered to 0019 when the two
were merged. Everything in the tree that cites it now says ADR-0019 — except one
comment in `packages/db/migrations/0007_team_invitations.sql`, which still says
ADR-0018. That migration was already applied by the time the collision was
found, and the migration runner rejects a file whose checksum has changed, so
the comment cannot be corrected without a new migration to carry a comment.
Read "ADR-0018" in that one file as this record.
