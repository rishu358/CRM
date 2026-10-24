import {
  defaultedChecked,
  defaultedChoice,
  defaultedFlag,
  defaultedInt,
  defaultedText,
  defaultedUrl,
  optionalAssetUrl,
  optionalEmail,
  optionalHexColor,
  optionalText,
  optionalUrl,
  requiredText,
} from './helpers.js';

/**
 * Every environment variable the system reads, declared once (CLAUDE.md §5.8, §13, ADR-0044).
 *
 * This file is the source of truth for three things that used to be written by hand in five places
 * and drift apart: what each process validates at start-up, `.env.example` and the staging and
 * production templates, and `docs/CONFIGURATION.md`. The last two are GENERATED from this file
 * (`pnpm config:docs`); CI fails if they are stale.
 *
 * To add a variable:
 *   1. add it here, with the scopes that read it, whether it is secret, and where to get it;
 *   2. read it through `loadEnv(scope)`; never `process.env` (a lint rule enforces this);
 *   3. run `pnpm config:docs` and commit the regenerated files.
 *
 * Choosing `scopes` is a security decision. A variable is validated and typed only for the scopes
 * it lists, and the web app additionally refuses to start (outside local development) if it is
 * handed any registered secret that is not in its scope. So a database credential can be set on
 * the API and the worker and is rejected on Vercel by construction.
 */
export const REGISTRY = {
  // ---- runtime -----------------------------------------------------------------------------
  NODE_ENV: defaultedChoice(
    {
      scopes: ['api', 'worker', 'web', 'db', 'perf'],
      group: 'runtime',
      description:
        'Whether this is a development, test or production process. Production refuses development values (a default secret, console email, localhost URLs, the database superuser).',
      local: 'development',
      example: 'production',
      note: 'Staging is also `production` here; say which with `APP_ENV`. Next.js requires this to be `production` for `next build`.',
    },
    { values: ['development', 'test', 'production'], default: 'development' },
  ),
  APP_ENV: defaultedChoice(
    {
      scopes: ['api', 'worker', 'web', 'db'],
      group: 'runtime',
      description:
        'Which deployment this is: `local`, `staging` or `production`. Separate from `NODE_ENV`, which only says whether the build is optimised.',
      local: 'local',
      example: 'production',
      note: 'Unset, it is `production` when `NODE_ENV=production` and `local` otherwise, so set it to `staging` explicitly on a staging deployment. Outside `local`, the web app refuses to start if it is given any secret meant for another process.',
    },
    { values: ['local', 'staging', 'production'], default: 'local' },
  ),
  LOG_LEVEL: defaultedChoice(
    {
      scopes: ['api', 'worker'],
      group: 'runtime',
      description: 'Minimum level written to the structured JSON log.',
      local: 'debug',
      example: 'info',
    },
    { values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], default: 'info' },
  ),

  // ---- deployment mode ---------------------------------------------------------------------
  DEPLOYMENT_MODE: defaultedChoice(
    {
      scopes: ['api', 'web'],
      group: 'deployment',
      description:
        'How this installation is used. `multi_tenant`: anyone can sign up and gets a workspace of their own (a product). `single_tenant`: public sign-up is closed, one workspace is created by the operator with `pnpm tenant:create`, and people join it by invitation (an installation run by a single company).',
      local: 'multi_tenant',
      example: 'multi_tenant',
      note: 'Row-level security and tenant isolation are identical in both modes: a single-tenant installation is one tenant, never a different way of reading data. The API and the web app must agree. Changing a running installation from `multi_tenant` to `single_tenant` closes sign-up and leaves every existing workspace as it is.',
    },
    { values: ['multi_tenant', 'single_tenant'], default: 'multi_tenant' },
  ),

  // ---- addresses ---------------------------------------------------------------------------
  API_PORT: defaultedInt(
    {
      scopes: ['api'],
      group: 'addresses',
      description: 'Port the API listens on.',
    },
    { default: 3001, sign: 'positive' },
  ),
  API_HOST: defaultedText(
    {
      scopes: ['api'],
      group: 'addresses',
      description: 'Interface the API binds to. `0.0.0.0` inside a container.',
    },
    { default: '0.0.0.0' },
  ),
  API_URL: defaultedUrl(
    {
      scopes: ['api', 'web'],
      group: 'addresses',
      requirement: 'production',
      description:
        "The API's own public origin. The API uses it to build the Google OAuth redirect URI, which Google compares byte for byte; the web app forwards every API call to it.",
      local: 'http://localhost:3001',
      example: 'https://api.example.com',
      note: 'Must be `https` in production. The web app reaches the API only over this public URL.',
    },
    { default: 'http://localhost:3001' },
  ),
  WEB_URL: defaultedUrl(
    {
      scopes: ['api', 'worker'],
      group: 'addresses',
      requirement: 'production',
      description:
        "The web app's public origin. Links in email point here, and it is the one origin the API accepts cross-origin calls from.",
      local: 'http://localhost:3000',
      example: 'https://app.example.com',
      note: 'Must be `https` in production.',
    },
    { default: 'http://localhost:3000' },
  ),
  CORS_ORIGINS: defaultedText(
    {
      scopes: ['api'],
      group: 'addresses',
      requirement: 'production',
      description:
        'Comma-separated origins allowed to call the API with credentials. Normally just `WEB_URL`.',
      local: 'http://localhost:3000',
      example: 'https://app.example.com',
      note: 'Never `*`; every entry must be https in production.',
    },
    { default: 'http://localhost:3000' },
  ),

  // ---- branding and identity ---------------------------------------------------------------
  APP_NAME: defaultedChecked(
    {
      scopes: ['api', 'worker', 'web'],
      group: 'branding',
      description:
        'What this installation calls itself: page titles, the sign-in screen, the navigation, every email, and the issuer shown in authenticator apps.',
      local: 'CRM',
      example: 'Acme CRM',
      note: '1 to 60 characters, no angle brackets. It applies to every email sent and every new authenticator enrolment from the next start; an authenticator entry already enrolled keeps the name it was enrolled under.',
    },
    {
      default: 'CRM',
      check: (value) =>
        value.length >= 1 &&
        value.length <= 60 &&
        [...value].every((character) => character !== '<' && character !== '>' && character >= ' '),
      message: 'must be 1 to 60 characters, without < or > or control characters',
    },
  ),
  SUPPORT_EMAIL: optionalEmail({
    scopes: ['web'],
    group: 'branding',
    description:
      'Where people are told to write for help. Shown as a link in the footer of the sign-in screens when set.',
    example: 'support@example.com',
  }),
  TERMS_URL: optionalAssetUrl({
    scopes: ['web'],
    group: 'branding',
    description:
      'Link to your terms of service, shown in the footer of the sign-in screens when set: an https URL, or a path on the web app.',
    example: 'https://example.com/terms',
  }),
  PRIVACY_URL: optionalAssetUrl({
    scopes: ['web'],
    group: 'branding',
    description:
      'Link to your privacy policy, shown in the footer of the sign-in screens when set: an https URL, or a path on the web app.',
    example: 'https://example.com/privacy',
  }),
  BRAND_LOGO_URL: optionalAssetUrl({
    scopes: ['web'],
    group: 'branding',
    description:
      'Logo shown in the navigation and on the sign-in screens in place of the name: an https URL, or a path such as `/brand/logo.svg` served from `apps/web/public`.',
    example: 'https://cdn.example.com/logo.svg',
    note: 'An https URL on another host is added to the content security policy for images, and only that host. Give it a transparent background: it is shown on light and dark themes.',
  }),
  BRAND_FAVICON_URL: optionalAssetUrl({
    scopes: ['web'],
    group: 'branding',
    description: 'The browser tab icon: an https URL, or a path served from `apps/web/public`.',
    example: 'https://cdn.example.com/favicon.png',
  }),
  BRAND_COLOR: optionalHexColor({
    scopes: ['web'],
    group: 'branding',
    description:
      'Primary colour of the light theme (buttons, links, focus rings), written #rrggbb. Unset keeps the built-in teal.',
    example: '#0b6b73',
    note: 'The web app refuses to start if the colour is too light to read as text on the light background (WCAG AA, 4.5:1). The text on it is chosen automatically, black or white.',
  }),
  BRAND_COLOR_DARK: optionalHexColor({
    scopes: ['web'],
    group: 'branding',
    description:
      'Primary colour of the dark theme, written #rrggbb. Unset keeps the built-in dark-theme colour: a colour that works on a light page is rarely the one that works on a dark one, so the two are separate.',
    example: '#3ad0d8',
    note: 'Must be light enough to read as text on the dark background (4.5:1), or the web app refuses to start.',
  }),

  // ---- defaults for new workspaces ---------------------------------------------------------
  DEFAULT_CURRENCY: defaultedChecked(
    {
      scopes: ['api'],
      group: 'tenantDefaults',
      description: "A new workspace's currency, as an ISO 4217 code.",
      local: 'INR',
      example: 'INR',
    },
    {
      default: 'INR',
      check: (value) => /^[A-Z]{3}$/.test(value),
      message: 'must be a three-letter ISO 4217 currency code in capitals, such as INR or USD',
    },
  ),
  DEFAULT_TIMEZONE: defaultedChecked(
    {
      scopes: ['api'],
      group: 'tenantDefaults',
      description:
        'A new workspace\'s time zone, and its first user\'s: an IANA name. It decides what "today" is for due dates and reports.',
      local: 'Asia/Kolkata',
      example: 'Asia/Kolkata',
    },
    {
      default: 'Asia/Kolkata',
      check: (value) => {
        // Area/City or UTC. `Intl` also accepts legacy abbreviations such as IST, which are
        // ambiguous (Postgres reads the same letters differently) and not what the rest of the
        // system stores.
        if (value !== 'UTC' && !value.includes('/')) return false;
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      },
      message:
        'must be an IANA time zone name in Area/City form (or UTC), such as Asia/Kolkata or America/New_York',
    },
  ),
  DEFAULT_LOCALE: defaultedChecked(
    {
      scopes: ['api'],
      group: 'tenantDefaults',
      description:
        "A new workspace's locale, and its first user's: a BCP 47 tag. It decides number grouping (`en-IN` gives lakh and crore), date order and month names.",
      local: 'en-IN',
      example: 'en-IN',
    },
    {
      default: 'en-IN',
      check: (value) => {
        try {
          return Intl.getCanonicalLocales(value).length === 1;
        } catch {
          return false;
        }
      },
      message: 'must be a BCP 47 language tag, such as en-IN or en-US',
    },
  ),
  DEFAULT_FISCAL_YEAR_START_MONTH: defaultedChoice(
    {
      scopes: ['api'],
      group: 'tenantDefaults',
      description:
        "The month a new workspace's financial year starts, 1 (January) to 12. 4 is April, the Indian financial year.",
      local: '4',
      example: '4',
    },
    {
      values: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
      default: '4',
    },
  ),
  DEFAULT_REGION: defaultedText(
    {
      scopes: ['api'],
      group: 'tenantDefaults',
      description:
        'The data-residency label recorded on a new workspace: where this installation keeps its data (for example the cloud region of the database). A label for reporting and contracts; it does not move anything.',
      local: 'ap-south-1',
      example: 'ap-south-1',
    },
    { default: 'ap-south-1', min: 1 },
  ),

  // ---- database ----------------------------------------------------------------------------
  DATABASE_URL: requiredText(
    {
      scopes: ['api', 'worker', 'db'],
      group: 'database',
      secret: true,
      description:
        'Connection string for `crm_app`: tenant-scoped through row-level security, no BYPASSRLS, owns nothing. Every API request runs as this role.',
      obtain:
        'Created by the bootstrap SQL (`packages/db/sql/bootstrap`), or `deploy/verify-managed-postgres.sh bootstrap` on a managed database.',
      local: 'postgres://crm_app:crm_app_dev@localhost:15432/crm',
      example: 'postgres://crm_app:CHANGE_ME@db.example.com:5432/crm',
      note: 'Never the database superuser or an administrative role such as `doadmin`: the API and worker refuse to start if the role can bypass row-level security.',
    },
    { min: 1 },
  ),
  DATABASE_AUTH_URL: optionalText(
    {
      scopes: ['api', 'db'],
      group: 'database',
      secret: true,
      requirement: 'production',
      description:
        'Connection string for `crm_auth`: identity tables only, no business data. Falls back to `DATABASE_URL` when unset, which production should not rely on.',
      local: 'postgres://crm_auth:crm_auth_dev@localhost:15432/crm',
      example: 'postgres://crm_auth:CHANGE_ME@db.example.com:5432/crm',
    },
    { min: 1 },
  ),
  DATABASE_WORKER_URL: optionalText(
    {
      scopes: ['worker', 'db'],
      group: 'database',
      secret: true,
      requirement: 'production',
      description:
        'Connection string for `crm_worker`: like `crm_app` plus the cross-tenant outbox reads the relay needs. Falls back to `DATABASE_URL` when unset.',
      local: 'postgres://crm_worker:crm_worker_dev@localhost:15432/crm',
      example: 'postgres://crm_worker:CHANGE_ME@db.example.com:5432/crm',
    },
    { min: 1 },
  ),
  DATABASE_ERASURE_URL: optionalText(
    {
      scopes: ['worker'],
      group: 'database',
      secret: true,
      description:
        'Connection string for `crm_erasure` (ADR-0032): the one role allowed to rewrite the `changes` column of audit rows for a subject with an in-flight erasure request. Only the worker holds it; the API never does.',
      local: 'postgres://crm_erasure:crm_erasure_dev@localhost:15432/crm',
      example: 'postgres://crm_erasure:CHANGE_ME@db.example.com:5432/crm',
      note: 'Leave unset and erasure requests fail with "not configured" instead of erasing a record and silently leaving its history readable.',
    },
    { min: 1 },
  ),
  DATABASE_MIGRATION_URL: optionalText(
    {
      scopes: ['db'],
      group: 'database',
      secret: true,
      description:
        'Connection string for `crm_migrator`, which owns the schema. Used only by the migrate job and by `pnpm db:migrate`; the API and worker never hold it. Falls back to `DATABASE_URL` when unset.',
      local: 'postgres://crm_migrator:crm_migrator_dev@localhost:15432/crm',
      example: 'postgres://crm_migrator:CHANGE_ME@db.example.com:5432/crm',
    },
    { min: 1 },
  ),
  DATABASE_POOL_MAX: defaultedInt(
    {
      scopes: ['api', 'worker', 'db'],
      group: 'database',
      description:
        "Most connections one process keeps open per pool. Size the database's `max_connections` to instances x pools x this.",
      local: '10',
      note: 'Default 10 for the API and scripts, 5 for the worker. The API also opens an auth pool a quarter of this size (minimum 2).',
    },
    { default: 10, scopeDefaults: { worker: 5 }, sign: 'positive', max: 100 },
  ),
  DATABASE_CA_CERT: optionalText(
    {
      scopes: ['api', 'worker', 'db'],
      group: 'database',
      description:
        "The database provider's CA certificate, as PEM or as one line of base64. Needed when the provider's certificate is signed by its own CA (DigitalOcean's is). The server is verified against it, hostname included.",
      obtain:
        "Download the CA certificate from the cluster's page in the provider's console, then `base64 -w0 ca-certificate.crt`.",
      example: '',
      note: 'A public certificate, not a secret. When set, any `sslmode` in the database URLs is ignored (ADR-0042). Never use `sslmode=no-verify`.',
    },
    { min: 1 },
  ),

  // ---- sessions and authentication ---------------------------------------------------------
  AUTH_SECRET: requiredText(
    {
      scopes: ['api'],
      group: 'auth',
      secret: true,
      description:
        'Signs session cookies and encrypts authenticator (MFA) secrets. At least 32 characters of randomness.',
      obtain: '`openssl rand -base64 48`. Generate one per environment; never reuse.',
      local: 'dev-only-insecure-secret-replace-me-with-48-random-bytes',
      note: 'Rotating it signs everyone out and makes enrolled authenticator secrets unreadable; there is no dual-key rotation yet (docs/RUNBOOK.md §7). Production refuses a value that looks like a placeholder.',
    },
    { min: 32, message: 'AUTH_SECRET must be at least 32 characters' },
  ),
  SESSION_COOKIE_NAME: defaultedText(
    {
      scopes: ['api', 'web'],
      group: 'auth',
      description: 'Name of the httpOnly session cookie. The API and the web app must agree.',
    },
    { default: 'crm_session', min: 1 },
  ),
  SESSION_TTL_DAYS: defaultedInt(
    {
      scopes: ['api', 'web'],
      group: 'auth',
      description:
        'How long a session lasts, in days (at most 90). The API and the web app must agree.',
    },
    { default: 14, sign: 'positive', max: 90 },
  ),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: defaultedInt(
    {
      scopes: ['api'],
      group: 'auth',
      description:
        'Window for the per-address ceiling on sign-in, sign-up, password reset and invitation acceptance, which have no user to key a limit on (CLAUDE.md §5.14).',
    },
    { default: 900, sign: 'positive' },
  ),
  AUTH_RATE_LIMIT_MAX_PER_IP: defaultedInt(
    {
      scopes: ['api'],
      group: 'auth',
      description: 'Most such attempts one address may make per window.',
      note: 'The end-to-end suite signs in dozens of times from one address, which this ceiling rightly refuses on a second run inside the window. Raise it locally before running `pnpm test:e2e` repeatedly, or restart the API between runs (the counter is in-process).',
    },
    { default: 50, sign: 'positive' },
  ),
  AUTH_THROTTLE_MAX_DELAY_MS: defaultedInt(
    {
      scopes: ['api'],
      group: 'auth',
      description:
        'Cap on the progressive delay after repeated failed sign-ins. Every delayed request is a connection held open, so the back-off is bounded (at most 60000).',
    },
    { default: 8000, sign: 'nonnegative', max: 60_000 },
  ),

  // ---- rate limits -------------------------------------------------------------------------
  RATE_LIMIT_WINDOW_SECONDS: defaultedInt(
    {
      scopes: ['api'],
      group: 'limits',
      description: 'Window for the per-user and per-tenant request limits.',
    },
    { default: 60, sign: 'positive' },
  ),
  RATE_LIMIT_MAX_PER_USER: defaultedInt(
    {
      scopes: ['api'],
      group: 'limits',
      description: 'Most requests one signed-in user may make per window.',
    },
    { default: 300, sign: 'positive' },
  ),
  RATE_LIMIT_MAX_PER_TENANT: defaultedInt(
    {
      scopes: ['api'],
      group: 'limits',
      description: 'Most requests one tenant may make per window, across all its users.',
      note: 'Applied per tenant AND per user, not only per address (CLAUDE.md §5.14). Counted per process until Redis-backed limiting lands, so N instances allow N times this.',
    },
    { default: 3000, sign: 'positive' },
  ),

  // ---- email -------------------------------------------------------------------------------
  EMAIL_PROVIDER: defaultedChoice(
    {
      scopes: ['api', 'worker'],
      group: 'email',
      requirement: 'production',
      description:
        'How outgoing mail is sent. `console` prints the message, links included, to the log; `memory` keeps messages in memory for the test suite; `resend` sends through Resend.',
      local: 'console',
      example: 'resend',
      note: '`console` and `memory` are refused when `NODE_ENV=production`, so a deployment that forgot to configure a real provider fails loudly instead of writing reset links into a log file.',
    },
    { values: ['console', 'memory', 'resend'], default: 'console' },
  ),
  EMAIL_FROM: defaultedText(
    {
      scopes: ['api', 'worker'],
      group: 'email',
      requirement: 'production',
      description:
        'The sender address, optionally with a display name: `Name <no-reply@mail.example.com>`.',
      local: 'no-reply@localhost',
      example: 'App <no-reply@mail.example.com>',
      note: 'Must be on a domain verified with the email provider (SPF and DKIM), or mail is not delivered.',
    },
    { default: 'no-reply@localhost' },
  ),
  RESEND_API_KEY: optionalText(
    {
      scopes: ['api', 'worker'],
      group: 'email',
      secret: true,
      requirement: 'production',
      description: 'API key for Resend. Required when `EMAIL_PROVIDER=resend`.',
      obtain: 'Resend dashboard, API Keys. Create one per environment with sending access only.',
      example: 'CHANGE_ME',
    },
    { min: 1 },
  ),

  // ---- object storage ----------------------------------------------------------------------
  STORAGE_PROVIDER: defaultedChoice(
    {
      scopes: ['api', 'worker'],
      group: 'storage',
      description:
        'Where uploaded files, imports and exports live. `s3` is any S3-compatible store (AWS S3, DigitalOcean Spaces, Cloudflare R2, MinIO); `memory` is for tests.',
      local: 's3',
      example: 's3',
      note: '`memory` cannot work across the API and the worker (each would hold its own empty store) and is refused in production.',
    },
    { values: ['s3', 'memory'], default: 's3' },
  ),
  S3_BUCKET: defaultedText(
    {
      scopes: ['api', 'worker'],
      group: 'storage',
      description: 'Bucket name. Private: no public ACLs and no public listing.',
      local: 'crm-files',
      example: 'your-bucket',
    },
    { default: 'crm-files', min: 1 },
  ),
  S3_REGION: defaultedText(
    {
      scopes: ['api', 'worker'],
      group: 'storage',
      description: 'Region used to sign requests.',
      local: 'us-east-1',
      example: 'us-east-1',
      note: 'For DigitalOcean Spaces keep `us-east-1`: the endpoint, not this, chooses the datacenter.',
    },
    { default: 'us-east-1', min: 1 },
  ),
  S3_ENDPOINT: optionalUrl({
    scopes: ['api', 'worker'],
    group: 'storage',
    description:
      'Address the API and worker use to reach an S3-compatible store. Leave unset for AWS S3 itself.',
    local: 'http://localhost:19000',
    example: 'https://blr1.digitaloceanspaces.com',
  }),
  S3_PUBLIC_ENDPOINT: optionalUrl({
    scopes: ['api', 'worker', 'web'],
    group: 'storage',
    description:
      'Address a browser uploads to (presigned URLs). Must be reachable from the browser and, in production, https. The web app uses only its origin, to allow it in the content security policy.',
    local: 'http://localhost:19000',
    example: 'https://blr1.digitaloceanspaces.com',
    note: '`pnpm infra:up` starts MinIO on 19000 (API) and 19001 (console), off the default ports. Files move browser to store and never through the API. Leave unset on AWS S3 or R2 with their own public hostnames.',
  }),
  S3_ACCESS_KEY_ID: optionalText(
    {
      scopes: ['api', 'worker'],
      group: 'storage',
      secret: true,
      requirement: 'production',
      description: 'Access key ID for the store.',
      obtain:
        "The storage provider's console (Spaces: Access Keys; S3 and R2: an access key limited to this bucket).",
      local: 'crm_minio',
      example: 'CHANGE_ME',
    },
    { min: 1 },
  ),
  S3_SECRET_ACCESS_KEY: optionalText(
    {
      scopes: ['api', 'worker'],
      group: 'storage',
      secret: true,
      requirement: 'production',
      description: 'Secret access key for the store.',
      obtain: 'Shown once, when the access key is created.',
      local: 'crm_minio_dev_secret',
      example: 'CHANGE_ME',
    },
    { min: 1 },
  ),
  S3_FORCE_PATH_STYLE: defaultedFlag(
    {
      scopes: ['api', 'worker'],
      group: 'storage',
      description:
        'Use `endpoint/bucket/key` URLs instead of `bucket.endpoint/key`. MinIO needs it; AWS S3 and R2 do not.',
      local: 'true',
      example: 'true',
      note: "On DigitalOcean Spaces set it to `true`: the presigned URL's host must equal `S3_PUBLIC_ENDPOINT` for the browser's content security policy to allow the upload.",
    },
    { default: false },
  ),

  // ---- redis -------------------------------------------------------------------------------
  REDIS_URL: optionalText(
    {
      scopes: ['api'],
      group: 'cache',
      secret: true,
      description:
        'Redis or Valkey connection string, for counters shared across API instances. Use the `rediss://` (TLS) form in production.',
      local: 'redis://localhost:16379',
      note: 'Optional today: nothing reads it until Redis-backed rate limiting lands, and the API logs a warning while it is empty in production. Leave it unset for a single instance.',
    },
    { min: 1 },
  ),

  // ---- sign in with Google -----------------------------------------------------------------
  GOOGLE_CLIENT_ID: optionalText(
    {
      scopes: ['api'],
      group: 'oauth',
      description:
        'OAuth client ID. With both Google values unset, the Google endpoints answer 404 instead of failing confusingly at the redirect.',
      obtain:
        'Google Cloud console, APIs & Services, Credentials, OAuth client ID (web application).',
      note: 'Authorised redirect URI: `${API_URL}/api/v1/auth/google/callback`.',
    },
    { min: 1 },
  ),
  GOOGLE_CLIENT_SECRET: optionalText(
    {
      scopes: ['api'],
      group: 'oauth',
      secret: true,
      description: 'OAuth client secret. Set both Google values or neither.',
      obtain: 'Shown with the client ID in the Google Cloud console.',
    },
    { min: 1 },
  ),

  // ---- worker ------------------------------------------------------------------------------
  OUTBOX_POLL_INTERVAL_MS: defaultedInt(
    {
      scopes: ['worker'],
      group: 'worker',
      description: 'How often the outbox relay polls when its queue is empty, in milliseconds.',
    },
    { default: 1000, sign: 'positive' },
  ),
  OUTBOX_BATCH_SIZE: defaultedInt(
    {
      scopes: ['worker'],
      group: 'worker',
      description: 'Most outbox events the relay takes per tick (at most 500).',
    },
    { default: 50, sign: 'positive', max: 500 },
  ),
  DIGEST_WINDOW_MINUTES: defaultedInt(
    {
      scopes: ['worker'],
      group: 'worker',
      description:
        'How long after the first notification a digest email goes out (at most 1440). Short enough to be useful, long enough that a burst of assignments is one email (ADR-0025).',
    },
    { default: 15, sign: 'positive', max: 1440 },
  ),

  // ---- tooling -----------------------------------------------------------------------------
  PERF_ADMIN_URL: optionalText(
    {
      scopes: ['perf'],
      group: 'tooling',
      secret: true,
      description:
        'A superuser connection to a SCRATCH database, used only by the load-test seed (`packages/db/src/perf`), which refuses any database whose name does not say it is a scratch one.',
      note: 'Kept out of every application scope so no service can ever be configured with a superuser URL. Never set outside a throwaway local database.',
    },
    { min: 1 },
  ),
  PERF_ROWS: defaultedInt(
    {
      scopes: ['perf'],
      group: 'tooling',
      description: 'Rows the import performance test generates.',
    },
    { default: 50_000, sign: 'positive' },
  ),
} as const;

export type Registry = typeof REGISTRY;
