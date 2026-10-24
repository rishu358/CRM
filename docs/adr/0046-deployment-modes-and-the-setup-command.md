# ADR-0046: Deployment modes: who may create a workspace, and the command that creates the first

- **Status:** Accepted
- **Date:** 2026-10-24
- **Related:** ADR-0044 (configuration registry), ADR-0045 (branding), ADR-0002 (roles), CLAUDE.md §13.7

## Context

The product was built as a service anyone can sign up to. To be sold, or installed by one company for its
own use, it has to run in two ways from the same code and the same data model:

- **multi-tenant**: strangers sign up and each gets a workspace (a product);
- **single-tenant**: one company owns the installation; nobody signs up; there is exactly one workspace,
  and people arrive by invitation.

The risk in "single-tenant" is that it becomes a different product: a mode where isolation is "off because
it is only one company", a second way to read data, a second set of bugs. This ADR is mostly about not
letting that happen.

## Decision

### 1. The mode decides who may create a workspace, and nothing else

`DEPLOYMENT_MODE` (`multi_tenant`, the default, or `single_tenant`) controls exactly one thing: whether a
stranger can bring a workspace into being. Row-level security is on in both. Every request still carries a
tenant. The application database role is the same, with no `BYPASSRLS`. A single-tenant installation is **one
tenant**, never a different way of reading data, and there is no code path that checks the mode when data is
read or written. The rules live in one place (`packages/core/src/deployment`), two pure functions
(`publicSignUpOpen`, `mayCreateWorkspace`) shared by the API, the setup command and the web app.

The default is `multi_tenant`, so every existing installation behaves as before.

### 2. What a single-tenant installation closes

An audit of every place a workspace or an account can come from found three:

| Path                                                                      | Single-tenant                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `POST /auth/sign-up` (creates account + workspace)                        | Refused: `403 SIGN_UP_DISABLED`, before anything is looked up or sent |
| Google sign-in for an address with no account                             | Refused with the same error; **no account is created**                |
| Accepting an invitation (creates an account **in an existing workspace**) | Unchanged: this is how a single-tenant installation's people arrive   |

Google sign-in of an account that already exists (linked, or the same verified address) is unaffected.
Password reset, sign-in, MFA, and everything inside a workspace are unaffected.

**The closed door answers identically for everyone.** The refusal is checked first, so it does not depend on
whether the address has an account, and no "you already have an account" email is sent. Otherwise a closed
sign-up would double as an oracle for who has an account here (a test sends the same request for a known and
an unknown address and compares). It is `403` rather than `404`, with a stable code, because the fact is
public (the sign-in screen does not offer the link) and a client that is told why can say why.

The web app hides the "create an account" link and redirects `/sign-up` to sign-in. That is courtesy: the API
is what refuses.

### 3. The first workspace is created by an operator command

`pnpm tenant:create` (or `node dist/cli/create-workspace-main.js` in a deployed image):

```
pnpm tenant:create --workspace "Acme Ltd" --owner-email you@example.com --owner-name "Your Name"
```

- **It uses the one provisioning path** (`AuthService.provisionWorkspace`), extracted from sign-up and used
  by both. A workspace made by the command is indistinguishable from one made by the form: same roles, field
  metadata, tenant defaults, row-level security. Sign-up's behaviour is unchanged (its tests pass untouched).
- **The password is never an argument or an environment variable.** An argument ends up in shell history, `ps`
  and CI logs; an environment variable is inherited by every child process. It is prompted for on a terminal
  (nothing echoed, asked twice), or read from standard input with `--password-stdin`. `--password` is refused
  with an explanation, not treated as an unknown flag, because someone will try it. It is checked against the
  sign-up form's own policy, hashed by the same hasher, and appears in no output; a test runs success and
  every failure and searches the output for it.
- **The owner's address is marked verified.** The operator vouches for it, and mail may not be configured on
  the day the first workspace is made.
- **It refuses a second workspace on a single-tenant installation**, saying that people join the first by
  invitation, and refuses an address that already has an account. On a multi-tenant installation it creates
  as many as it is asked for (an operator creating a customer's workspace).
- **It needs no credential the API does not already hold.** It boots the same application with the same
  configuration and the same database roles, so production's start-up checks apply (it refuses a role that
  bypasses row-level security, ADR-0042). `--help` and a mistyped flag work with no environment at all.
- **Arguments are parsed, the password obtained and checked, and only then is the application started**, so
  a typo costs nothing.

## Alternatives considered

- **A `PLAN`/mode check wherever data is touched.** Rejected: that is the second code path this ADR exists to
  forbid.
- **Seeding the owner from environment variables** (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) at start-up. Common, and
  convenient for a container, but it puts a password in the environment and creates accounts as a side effect
  of starting. An explicit command, run once, is safer and says what it did.
- **A one-time setup web page.** A public page that creates the owner is an unauthenticated account-creation
  endpoint that has to switch itself off; the command has no such window.
- **Printing a generated password.** Avoided: an output that holds a credential ends up in logs.

## Consequences and limits

- Switching a running installation from `multi_tenant` to `single_tenant` closes sign-up and leaves every
  existing workspace as it is. It does not merge or remove workspaces; a single-tenant installation that has
  several simply refuses to create more.
- **Not here:** entitlements (what a tenant's plan includes) are a separate change. Single-tenant mode will
  enable every feature, because the operator owns the installation, and that belongs with the entitlement
  service rather than in this switch.
- pnpm prints the command line it runs, so a password typed after `--password` appears on the screen before
  the command refuses it. The refusal still prevents it from reaching history-less places like logs; the safe
  forms never put it on a command line at all.
- The "creates the one workspace while there is none" test replaces the count of existing workspaces, because
  every suite shares one database that is never empty. Everything else in that test is the real path, and the
  process itself was run end to end against an empty, freshly bootstrapped and migrated database.
