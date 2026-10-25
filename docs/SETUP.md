# Setting up a development machine

This gets the whole system running on a laptop. It changes nothing outside the repository and Docker's own
containers: it does not edit environment variables, `PATH`, Docker settings or any global configuration. If your
machine lacks something, the setup command says what; installing it is yours to do.

## You need

- **Node 24.7 or later.** (Password hashing uses the Argon2id built into Node from 24.7.)
- **pnpm 9.**
- **Docker**, running. It starts Postgres, Redis, an S3-compatible file store and a local mail inbox as containers.
- Git.

## One command

```bash
pnpm install
pnpm run setup
pnpm dev
```

Use `pnpm run setup`, not `pnpm setup`: the latter is a pnpm command that configures pnpm itself.

`pnpm run setup` is safe to run again. It checks Node, pnpm and Docker; creates `.env` from `.env.example` with a
generated `AUTH_SECRET` (never overwriting an existing `.env`); builds; starts the services; applies the migrations;
and creates the demo workspace on the first run only. The build comes first because the migration and seed commands
import the compiled packages. It stops at the first step that fails, names it, and
tells you to fix that and run it again. Every step is safe to repeat. Options:

| Option       | Effect                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `--check`    | Only check the machine and `.env`; change nothing; exit non-zero with the reason.                   |
| `--no-seed`  | Do not create the demo workspace.                                                                   |
| `--seed`     | Create another demo workspace even if this is not the first run.                                    |
| `--minimal`  | Create one empty workspace with one owner instead of the demo company (the password is shown once). |
| `--no-build` | Skip the build.                                                                                     |

The reasoning is in [ADR-0051](adr/0051-setup-command.md).

## What is running

| What                 | Address                | Notes                                                                     |
| -------------------- | ---------------------- | ------------------------------------------------------------------------- |
| Web app              | http://localhost:3000  | Sign in at `/sign-in`.                                                    |
| API                  | http://localhost:3001  | `/api/v1`; health at `/api/v1/health`.                                    |
| Mail inbox (Mailpit) | http://localhost:18025 | Verification and password-reset emails arrive here; nothing is delivered. |
| File store console   | http://localhost:19001 | MinIO. The S3 endpoint is port 19000.                                     |
| Postgres             | localhost:15432        | Database `crm`.                                                           |
| Redis                | localhost:16379        | Optional today: nothing reads it yet.                                     |

The service ports are deliberately not the defaults, so a machine that already runs Postgres or Redis does not end
up with two programs on one port.

## Signing in

`pnpm db:seed` (run by setup on the first run) prints the demo users and their password. **Owner** sees every
record; **Sales rep** sees only their own, which is record scope working end to end. **MFA demo** is a user to
practise authenticator setup on. **Fresh co** is a second company that has not finished setup, to see the
first-run screen. The seed also prints one pending invitation to accept.

For an empty start instead, run `pnpm run setup -- --minimal` (or `pnpm db:seed -- --minimal`): one workspace, one
owner, and a generated password printed once.

## Without the setup command

```bash
cp .env.example .env     # then set AUTH_SECRET to the output of: openssl rand -base64 48
pnpm build               # first: migrate and seed import the compiled packages
pnpm infra:up            # the containers, and the file-store bucket
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Everyday commands

| Command                          | What it does                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm dev`                       | Web, API and worker together.                                                          |
| `pnpm test`                      | Unit and integration tests (they start a real Postgres in Docker).                     |
| `pnpm test:security`             | The tenant-isolation and permission suites. These must always pass.                    |
| `pnpm test:e2e`                  | Playwright, against a running stack.                                                   |
| `pnpm lint` and `pnpm typecheck` | Static checks.                                                                         |
| `pnpm config:docs`               | Regenerate `.env.example` and the configuration documents after changing the registry. |
| `pnpm infra:down`                | Stop the containers (the data stays in Docker volumes).                                |
| `pnpm hooks:install`             | Once per clone: secret scanning and the commit-message check on every commit.          |

The full test suites are heavy; run one package at a time when the machine is busy, and run a failing file on its
own before believing it.

## When something goes wrong

- **"Docker is not reachable."** Start Docker and run `pnpm run setup` again.
- **A port is already in use.** Something else holds 3000, 3001 or one of the service ports above. Stop it, or
  change the published port in `docker-compose.yml` and the matching value in `.env`.
- **The web app will not start, naming a variable.** The web app refuses to run outside local development holding
  a secret meant for another program. Locally, `.env` must say `APP_ENV=local`, which `.env.example` does.
- **`TS2307` after pulling.** A new workspace package needs `pnpm install` in your checkout.
- **A test fails with a connection timeout while the machine is busy.** Run that file alone. Several database
  suites running at once on a small machine time out when they compete.
- **You want a clean slate.** `docker compose down -v` stops the containers **and deletes their data**
  (every local workspace). Then run `pnpm run setup` again.
