# syntax=docker/dockerfile:1.7
#
# One file, four images: `api`, `worker`, `web` and `migrate` (ADR-0041).
#
#   docker build -f deploy/Dockerfile --target api    -t crm-api .
#   docker build -f deploy/Dockerfile --target worker -t crm-worker .
#   docker build -f deploy/Dockerfile --target web    -t crm-web .
#   docker build -f deploy/Dockerfile --target migrate -t crm-migrate .
#
# They share one build stage, so the monorepo is installed and compiled once and the four images
# cannot disagree about what version of a shared package they carry.
#
# What the runtime images are: the compiled workspace with production dependencies only, run as
# the unprivileged `node` user, with no source for the tests, no editor tooling and no `.env`.
# (`.dockerignore` keeps env files and git history out of the build context entirely.)
#
# What is deliberately NOT here: secrets. Every value comes from the environment at run time
# (see deploy/production.env.example), and the apps refuse to start in production with a
# development value (packages/core/src/config/production.ts).

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV CI=true
# The version the repository pins (package.json "packageManager"), not whatever is current.
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

# ---------------------------------------------------------------------------------------------
# build: install everything, compile everything, then drop what production does not need.
# ---------------------------------------------------------------------------------------------
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# Nothing deployment-specific is baked in: the browser talks to its own origin (`/api/proxy`) and
# the web server reads API_URL and the rest at run time, so one image serves every environment.
RUN pnpm turbo run build

# Production dependencies only. The compiled output stays; the compilers, linters and test
# runners go.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod --offline \
    || pnpm install --frozen-lockfile --prod

# ---------------------------------------------------------------------------------------------
# runtime base: the compiled workspace, owned by an unprivileged user.
# ---------------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo /repo
USER node

# ---------------------------------------------------------------------------------------------
FROM runtime AS api
WORKDIR /repo/apps/api
ENV API_PORT=3001
EXPOSE 3001
# Ready when the process answers its own health route. No curl in the image: node is enough.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------------------------
FROM runtime AS worker
WORKDIR /repo/apps/worker
# The worker serves nothing; "healthy" is "still running", which the orchestrator already knows.
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------------------------
FROM runtime AS web
WORKDIR /repo/apps/web
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/sign-in').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/next/dist/bin/next", "start", "--port", "3000", "--hostname", "0.0.0.0"]

# ---------------------------------------------------------------------------------------------
# migrate: a one-shot job, run before a release and then gone. It connects as the migration role
# (DATABASE_MIGRATION_URL), which the API and worker never hold.
# ---------------------------------------------------------------------------------------------
FROM runtime AS migrate
WORKDIR /repo/packages/db
CMD ["node", "dist/migrate.js"]
