# Secrets: what exists, who holds it, how to rotate it

A secret is a value that, in the wrong hands, lets someone act as the application or read what it protects.
This page lists every secret the application uses, what each one protects, how to make a good one, how to
change it without an outage, and what to do if one is exposed. A test fails if a secret is added to the
configuration registry and not listed here.

[`CONFIGURATION.md`](CONFIGURATION.md) lists every variable; [`RUNBOOK.md`](RUNBOOK.md) §7 is the short
checklist for an incident. [`SECURITY.md`](../SECURITY.md) says how to report a leak.

## Rules that do not bend

- **Never in the repository, an image, a log, a test, a ticket or a chat.** Secret scanning (gitleaks) runs on
  every commit and in CI. If one is committed, **rotate it first**, then clean up: removing it from history does
  not un-leak it.
- **One of each per environment.** Local, staging and production never share a secret, so a leak in one is not a
  leak in all.
- **Only the process that needs it holds it.** The web app is registered for a handful of variables and refuses
  to start outside local development if it holds any secret meant for another process (ADR-0044). The worker has
  no session secret; the web app has no database credential.
- **Generated, not chosen.** Use `openssl rand -base64 48` for anything the application generates for itself.
  Production refuses a value that looks like a placeholder.
- **Held in a secret store**, not a file on a laptop: the host's secret manager, or a password manager for the
  few that only a person uses (the database administrator).

## What each secret protects

| Secret                                       | Held by             | Protects                                                                                       |
| -------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                               | API, worker         | The application database role: every tenant's business data, behind row-level security.        |
| `DATABASE_AUTH_URL`                          | API                 | The identity role: users, password hashes, sessions, authenticator secrets.                    |
| `DATABASE_WORKER_URL`                        | worker              | The background role: the event relay, with cross-tenant reads of the outbox.                   |
| `DATABASE_ERASURE_URL`                       | worker              | The one role that may redact audit history for an erasure request (ADR-0032).                  |
| `DATABASE_MIGRATION_URL`                     | migration job only  | The role that owns the schema. Never given to a running service.                               |
| `AUTH_SECRET`                                | API                 | Authenticator (MFA) secrets and backup codes at rest, and the cookie signer.                   |
| `AUTH_SECRET_PREVIOUS`                       | API                 | The same, for stored values written under an earlier `AUTH_SECRET`. Only during rotation.      |
| `RESEND_API_KEY`                             | API, worker         | Sending mail as the application, through Resend.                                               |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | API, worker         | Sending mail as the application, through Amazon SES.                                           |
| `SMTP_PASSWORD`                              | API, worker         | Sending mail as the application, through an SMTP server.                                       |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`   | API, worker         | Every uploaded file, import and export in the bucket.                                          |
| `REDIS_URL`                                  | API                 | Rate-limit counters (nothing sensitive is stored; the password is still a secret).             |
| `GOOGLE_CLIENT_SECRET`                       | API                 | Sign in with Google for this application.                                                      |
| `PERF_ADMIN_URL`                             | a developer's shell | A privileged database connection for load tests against a scratch environment. Never deployed. |

Also secret, and not in the registry because the application never holds them: the **managed-database
administrator** credential (RUNBOOK §9.4), which belongs in a password manager and is used by a person, once,
to bootstrap; and the **CI and deployment tokens** held by the host.

## Rotating

Rotate on a schedule (at least yearly, and when a person who held one leaves), and **immediately** after any
exposure. Every rotation below is done one secret at a time, in a quiet period, and checked afterwards (sign in,
upload a file, send a test email, run an export).

### `AUTH_SECRET`: with no one losing their authenticator

`AUTH_SECRET` encrypts what makes a second factor work. Changing it naively would leave every enrolled
authenticator unreadable, so each stored value records which key wrote it (a short key id, never the key;
ADR-0049), and the application can hold the old key beside the new one while the stored values are moved.

1. **Generate the new key**: `openssl rand -base64 48`.
2. **Deploy with both**: set `AUTH_SECRET` to the **new** key and `AUTH_SECRET_PREVIOUS` to the **old** one.
   Nothing is lost: values under the old key still open, and new ones are written under the new key. (To rotate
   again before finishing, list older keys too, newest first, separated by commas; at most three.)
3. **Check what is stored**: `pnpm auth:rotate-keys --dry-run` (in a deployed image,
   `node dist/cli/rotate-keys-main.js --dry-run`). It prints how many values are under each key id and what
   would change, and changes nothing.
4. **Re-encrypt**: `pnpm auth:rotate-keys`. Safe to run while the application is serving and to repeat. A row
   changed by a request at that instant is skipped and picked up by the next run.
5. **Remove the old key**: when it reports _nothing is left under an old key_, delete `AUTH_SECRET_PREVIOUS`
   and redeploy. Destroy the old key.

If it reports **UNREADABLE** values, they were written under a key that is not in `AUTH_SECRET` or
`AUTH_SECRET_PREVIOUS`. Find that key (an old backup of the configuration), add it to `AUTH_SECRET_PREVIOUS`, and
run again. If the key is truly gone, those users must re-enrol their authenticator; nothing else about their
account is affected.

**Does not sign anyone out.** A session is a random token stored hashed in the database; it is not keyed by
`AUTH_SECRET`, and a test proves a session survives a rotation.

### Database passwords (five roles)

`ALTER ROLE <role> PASSWORD '…'` in the database, update that role's connection string in the host's secret
store, and redeploy that service. Do one role at a time. Because API instances restart in a rolling deploy there
is no downtime. Check `DATABASE_*` URLs for the new password only in the secret store, never a ticket.

### Email

Create a new key or credential in the provider, set it, redeploy, **then** delete the old one in the provider's
console, so there is no moment with neither. For SES, create the new IAM access key beside the old, and deactivate
before deleting. The IAM user should be allowed `ses:SendEmail` only.

### Object storage

Create a new access key pair limited to the bucket, set both variables, redeploy, then delete the old pair. A
presigned URL already issued under the old key stops working when the old key is deleted; they last minutes.

### `GOOGLE_CLIENT_SECRET`

Add a new secret in the Google console (it allows two at once), set it, redeploy, then delete the old one.

### `REDIS_URL`

Change the password at the provider, set the new URL, redeploy. A brief reset of rate-limit counters is the only
effect.

## If one is exposed

1. **Rotate it now**, following the section above, before investigating.
2. **Check for use** between the exposure and the rotation: the audit log (`/api/v1/audit-logs`) for the
   application's own activity, and the provider's log for the service behind the secret (the database's connection
   log, the email provider's sending log, the bucket's access log).
3. If the secret protected personal data (a database role, the storage keys), treat it as a possible personal-data
   incident: see [`docs/legal`](legal/) for the breach-notification steps.
4. **Remove it from where it leaked**, and add what let it leak to the lessons in the postmortem. A secret scanner
   false positive is allowlisted by its exact fake value in `.gitleaks.toml`, with a reason; a rule is never loosened.
5. If it was committed: the secret is burned whether or not history is rewritten.

## For a developer

- Local values live in an untracked `.env`; `.env.example` holds placeholders, generated from the registry.
- Test fixtures use obviously fake values (`*.example`, `CHANGE_ME`).
- A new secret variable is added to the registry with `secret: true`, **and a row to the table above** (the test
  that reads this page will tell you).
