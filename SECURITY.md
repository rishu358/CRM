# Security policy

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately to **`[SECURITY CONTACT: set before this repository is shared or published]`**.
Include what you found, where (endpoint, page or file), the steps to reproduce it, and what an
attacker gains. Do not include real customer data in the report; if you came across some, say so and
stop there.

What to expect (targets, not guarantees; the owner confirms them before publishing):

- an acknowledgement within 3 working days;
- an initial assessment within 10 working days;
- a fix or a mitigation plan for confirmed issues, prioritised by severity, with credit to you if you
  want it once a fix is released.

Please give us reasonable time to fix a problem before disclosing it, and do not access, change or
delete data that is not yours while testing. Testing against your own tenant on a local or staging
instance is fine; testing against anyone else's production data is not.

## Supported versions

Only the latest commit on `master` and the most recent tagged release receive security fixes. The
product is pre-1.0.

## What is in scope

The API (`apps/api`), the worker (`apps/worker`), the web app (`apps/web`), the database schema, row
level security policies and bootstrap SQL (`packages/db`), the shared packages, and the deployment
configuration (`deploy/`). Of special interest, because the product is multi-tenant:

- reading or changing another tenant's data (any isolation failure);
- bypassing a permission, a field-level restriction, or record scope;
- authentication, session, MFA, password-reset or invitation flaws;
- injection (SQL, CSV formula, HTML), SSRF through outbound requests, unsafe file handling;
- secrets exposure, in the code, history, images or logs.

Out of scope: findings that need a compromised administrator or device, denial of service by raw
volume, missing hardening that has no demonstrated effect, and vulnerabilities in a dependency with no
way to reach it from this product (report those upstream).

## How security is built in

The non-negotiable rules are in [`CLAUDE.md`](CLAUDE.md) section 5, and each module is reviewed
against them in [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md). In short: tenant isolation by
row-level security with a runtime role that cannot bypass it; every endpoint authorised through one
function; field-level permissions applied in the serializer; validated input; an append-only audit
log; secrets only from the environment; and secret scanning on every commit and in CI.

## If you committed a secret

1. **Treat it as exposed.** Removing it from the latest commit does not remove it from history, forks,
   caches or anyone's clone. **Rotate it first**: the steps for each secret are in
   [`docs/RUNBOOK.md`](docs/RUNBOOK.md) §7.
2. Tell the repository owner. If it was ever pushed, check the issuing service's own logs for use
   between the exposure and the rotation.
3. Remove it from the code and, if the history must be rewritten, do it deliberately with the owner
   (a force-push is not a casual fix).
4. A reviewed false positive is recorded as a narrow allowlist entry in `.gitleaks.toml` with a
   reason. A real secret never is.

## Secret scanning

`gitleaks` runs in the `pre-commit` hook (staged files) and in CI over the whole history of every ref
(`scripts/scan-secrets.sh`, which fails closed). Rules and the two reviewed exceptions are in
`.gitleaks.toml`.
