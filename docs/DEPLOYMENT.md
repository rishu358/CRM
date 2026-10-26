# Deploying

What a production installation needs, and the order to bring it up, without assuming a host. The exact commands
are in [RUNBOOK.md](RUNBOOK.md); this page says what must be true, so you can map it onto any host. One host's
worth of specifics (DigitalOcean for the API and worker, Vercel for the web app, in India) is worked through in
[RUNBOOK.md](RUNBOOK.md) §9.

## What you provide

| Need                              | Requirement                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postgres 16**                   | A managed service or your own. Five roles, created once by an administrator (below). Row-level security must apply to the application's roles.                                                                |
| **An S3-compatible bucket**       | Private (no public access, no public listing), with **CORS allowing `PUT` and `GET` from your web origin only**, or uploads fail while everything else works. Values per store: [PROVIDERS.md](PROVIDERS.md). |
| **A way to send email**           | Resend, Amazon SES or an SMTP server, with the sending domain verified (SPF and DKIM). [PROVIDERS.md](PROVIDERS.md).                                                                                          |
| **A place to run three programs** | The API and the worker as long-running containers; the web app as a Next.js server (a container or a host such as Vercel). One-shot jobs for migrations.                                                      |
| **TLS and DNS**                   | HTTPS for the web app and the API. A reverse proxy such as Caddy ([`deploy/Caddyfile.example`](../deploy/Caddyfile.example)) or the host's own.                                                               |
| **Redis**                         | Optional today; nothing reads it yet.                                                                                                                                                                         |

## The images

`deploy/Dockerfile` has one target per program: `api`, `worker`, `web` and `migrate`.

```bash
docker build -f deploy/Dockerfile --target api .
```

They run as an unprivileged user, contain no environment file, and take every setting from the environment.

## Configuration

Every setting is an environment variable, listed with its scopes, secrecy and default in
[CONFIGURATION.md](CONFIGURATION.md). Start from `deploy/production.env.example` (or `staging.env.example`), both
generated from the same registry. Each program loads **only its own scope**, so give each program only its own
variables: the web app in particular must not be given a database credential or any secret, and refuses to start
outside local development if it is.

The API and the worker **refuse to start in production** with a development value: a placeholder `AUTH_SECRET`,
`console` or `memory` email, memory storage, `http` or `localhost` URLs, plain-text SMTP, or a database connection
that can bypass row-level security. They print the name of each wrong variable and never its value.

The choices that make an installation what it is:

- **`DEPLOYMENT_MODE`**: `multi_tenant` (anyone may sign up and get a workspace) or `single_tenant` (no sign-up;
  one workspace, created by the operator). [ADR-0046](adr/0046-deployment-modes-and-the-setup-command.md).
- **Branding**: `APP_NAME`, logo, colours, support and legal links. [ADR-0045](adr/0045-instance-branding-and-new-workspace-defaults.md).
- **Email and storage providers**: [PROVIDERS.md](PROVIDERS.md).
- **Data region**: where the data lives is a deployment decision. [RUNBOOK.md](RUNBOOK.md) §9.10 sets out what is
  and is not in a single country for the worked example.

## Bringing it up

1. **Create the database roles and extensions**, once, as an administrator, with real passwords
   (`packages/db/sql/bootstrap/01-extensions-and-roles.sql` is the file; copy it and replace its development
   passwords; never run it as it is against anything but a laptop). Details and the managed-database caveat:
   [RUNBOOK.md](RUNBOOK.md) §2 and §9.4.
2. **Build and push the images**, tagged with the release.
3. **Set the environment** for each program from the templates; generate `AUTH_SECRET` with `openssl rand -base64 48`.
   Keep every secret in the host's secret store ([SECRETS.md](SECRETS.md)).
4. **Run the migrations** once, as `crm_migrator`, with the `migrate` image. They are forward-only and safe to repeat.
5. **Start the API, the worker and the web app.** The API reports healthy at `/api/v1/health`.
6. **Create the first workspace** from the API image: `node dist/cli/create-workspace-main.js --password-stdin ...`
   (the password is piped in, never an argument). On a single-tenant installation this is the only way a workspace
   comes into being. [RUNBOOK.md](RUNBOOK.md) §2 has the command.
7. **Check it**: sign in, create a contact, upload an attachment, run an export. If email does not arrive, or an
   upload is refused with a CORS or CSP error and nothing in the API log, it is the sending domain or the bucket's
   CORS.

## Operating it

| Task                                                     | Where                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Release, roll back, migrate                              | [RUNBOOK.md](RUNBOOK.md) §3                                                                    |
| Capacity, and what overload looks like                   | [RUNBOOK.md](RUNBOOK.md) §4                                                                    |
| Backups and the restore drill                            | [RUNBOOK.md](RUNBOOK.md) §5                                                                    |
| Incidents                                                | [RUNBOOK.md](RUNBOOK.md) §6                                                                    |
| Rotating any secret                                      | [SECRETS.md](SECRETS.md)                                                                       |
| Choosing a plan, or enabling a feature for one workspace | `pnpm tenant:entitlements` ([ADR-0047](adr/0047-entitlements-plans-features-and-overrides.md)) |
| Moving everyone's authenticators to a new key            | `pnpm auth:rotate-keys` ([ADR-0049](adr/0049-key-ids-and-rotating-auth-secret.md))             |

## What is specific to one host

Only the files in `deploy/` that name a host: `do-app-platform.yaml` and `render-do-app-spec.sh` (DigitalOcean App
Platform), `apps/web/vercel.json` (Vercel), `verify-managed-postgres.sh` (managed Postgres), and the example
compose file and Caddyfile (one machine). Application code names no host: a vendor appears only inside its adapter
([CLAUDE.md](../CLAUDE.md) §13). To deploy somewhere else, you write the host's equivalent of those files and
nothing else changes.

## Known limits

[RUNBOOK.md](RUNBOOK.md) §8 lists them. Two to know before scaling out: rate limits are counted per process (several
API instances multiply them), and there is no queue between the API and the worker (the worker polls the outbox table).
