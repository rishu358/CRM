/**
 * What a production deployment must not be running with (CLAUDE.md §5.8, §5.9, ADR-0041).
 *
 * Development defaults are chosen to be convenient: a known session secret, mail printed to
 * the log, files held in memory, `http://localhost` for every URL, the database superuser.
 * Each is one environment variable away from a deployment that looks healthy and is not:
 * sessions anyone can forge, a verification link written to a log file instead of sent,
 * uploads that vanish between the API and the worker, cookies the browser will not return.
 *
 * So the API and the worker ask this before they listen, and **refuse to start** if the
 * answer is not empty. It reports the *names* of the variables and what is wrong with them,
 * never a value: a log line that says what the secret was is a leak of its own.
 *
 * Pure and dependency-free: each app reads its own environment (the only place allowed to)
 * and hands the fields here, so the rules can be tested exhaustively and cannot drift
 * between the two processes.
 */

export interface ProductionConfigInput {
  readonly nodeEnv: string;
  /**
   * Which process is asking. The worker has no session secret, no public API address and no
   * CORS list, so asking it for them would report problems it cannot have. Defaults to the API.
   */
  readonly scope?: 'api' | 'worker';
  readonly authSecret?: string | undefined;
  readonly emailProvider?: string | undefined;
  readonly emailFrom?: string | undefined;
  readonly resendApiKey?: string | undefined;
  readonly storageProvider?: string | undefined;
  readonly s3AccessKeyId?: string | undefined;
  readonly s3SecretAccessKey?: string | undefined;
  /** What a browser uploads to. A plain-http address is mixed content from an https page. */
  readonly s3PublicEndpoint?: string | undefined;
  readonly webUrl?: string | undefined;
  readonly apiUrl?: string | undefined;
  /** Comma-separated, as configured. */
  readonly corsOrigins?: string | undefined;
  /** Connection strings by the variable that holds them. */
  readonly databaseUrls?: Readonly<Record<string, string | undefined>>;
  readonly redisUrl?: string | undefined;
}

export interface ProductionConfigReport {
  /** Each is a reason not to start. */
  readonly problems: readonly string[];
  /** Each is worth a log line and no more. */
  readonly warnings: readonly string[];
}

/** Words that mark a secret as one somebody typed to get past a check. */
const PLACEHOLDER =
  /(dev|change|example|placeholder|secret|password|passwd|test|todo|insecure|default|demo|sample)/i;

/** Hosts that mean "this machine", which a deployed service is never reached at. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0'
  );
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function checkSecret(name: string, value: string | undefined, problems: string[]): void {
  if (value === undefined || value === '') {
    problems.push(`${name} is not set`);
    return;
  }
  if (value.length < 32) problems.push(`${name} must be at least 32 characters`);
  if (new Set(value).size < 12) {
    problems.push(`${name} has too few distinct characters to be random`);
  }
  if (PLACEHOLDER.test(value)) {
    problems.push(`${name} looks like a placeholder, not a generated secret`);
  }
}

function checkPublicUrl(name: string, value: string | undefined, problems: string[]): void {
  if (value === undefined || value === '') {
    problems.push(`${name} is not set`);
    return;
  }
  const url = parseUrl(value);
  if (url === null) {
    problems.push(`${name} is not a URL`);
    return;
  }
  if (url.protocol !== 'https:') problems.push(`${name} must be https in production`);
  if (isLocalHost(url.hostname)) problems.push(`${name} points at this machine`);
}

function checkDatabaseUrl(name: string, value: string, problems: string[]): void {
  const url = parseUrl(value);
  if (url === null) {
    problems.push(`${name} is not a connection string`);
    return;
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user === 'postgres' || user === 'root' || user === 'admin') {
    problems.push(`${name} connects as a superuser; it must be the role built for it`);
  }
  // DigitalOcean's administrative role is not a superuser but it does bypass row-level security,
  // which is the same hole. The name check is the cheap early catch; `connectedRoleProblems`
  // asks the database what the role really is, whatever it is called.
  if (user === 'doadmin') {
    problems.push(`${name} connects as the managed-database admin role, which bypasses RLS`);
  }
  if (password === '') problems.push(`${name} has no password`);
  if (/(_dev|dev_|^dev$|password|changeme)/i.test(password)) {
    problems.push(`${name} has a development password`);
  }
  if (isLocalHost(url.hostname)) problems.push(`${name} points at this machine`);
}

export function productionConfigProblems(input: ProductionConfigInput): ProductionConfigReport {
  if (input.nodeEnv !== 'production') return { problems: [], warnings: [] };

  const problems: string[] = [];
  const warnings: string[] = [];

  const api = (input.scope ?? 'api') === 'api';
  if (api) checkSecret('AUTH_SECRET', input.authSecret, problems);

  const email = input.emailProvider ?? 'console';
  if (email === 'console' || email === 'memory') {
    problems.push(
      `EMAIL_PROVIDER=${email} delivers nothing: verification and reset links would be logged or discarded`,
    );
  } else if (email === 'resend') {
    if (input.resendApiKey === undefined || input.resendApiKey === '') {
      problems.push('EMAIL_PROVIDER=resend requires RESEND_API_KEY');
    }
  } else {
    problems.push(`EMAIL_PROVIDER=${email} is not a provider this build can send with`);
  }
  const from = input.emailFrom ?? '';
  const fromHost = from.includes('@') ? (from.split('@').pop() ?? '') : '';
  if (fromHost === '' || isLocalHost(fromHost.replace(/>$/, ''))) {
    problems.push('EMAIL_FROM must be an address on a domain you send from');
  }

  if ((input.storageProvider ?? 's3') === 'memory') {
    problems.push(
      'STORAGE_PROVIDER=memory cannot work across the API and the worker, and loses every upload on restart',
    );
  } else if (!input.s3AccessKeyId || !input.s3SecretAccessKey) {
    problems.push('STORAGE_PROVIDER=s3 requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
  if (input.s3PublicEndpoint !== undefined && input.s3PublicEndpoint !== '') {
    const url = parseUrl(input.s3PublicEndpoint);
    if (url === null || url.protocol !== 'https:') {
      problems.push(
        'S3_PUBLIC_ENDPOINT must be https: a browser blocks http uploads from an https page',
      );
    } else if (isLocalHost(url.hostname)) {
      problems.push('S3_PUBLIC_ENDPOINT points at this machine');
    }
  }

  checkPublicUrl('WEB_URL', input.webUrl, problems);
  if (api) checkPublicUrl('API_URL', input.apiUrl, problems);

  const origins = (input.corsOrigins ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  if (api && origins.length === 0) problems.push('CORS_ORIGINS is not set');
  for (const origin of api ? origins : []) {
    const url = origin === '*' ? null : parseUrl(origin);
    if (origin === '*') problems.push('CORS_ORIGINS must name origins, not *');
    else if (url === null) problems.push('CORS_ORIGINS holds something that is not an origin');
    else if (url.protocol !== 'https:' || isLocalHost(url.hostname)) {
      problems.push('CORS_ORIGINS must be https origins of the deployed web app');
    }
  }

  for (const [name, value] of Object.entries(input.databaseUrls ?? {})) {
    if (value !== undefined && value !== '') checkDatabaseUrl(name, value, problems);
  }

  if (input.redisUrl === undefined || input.redisUrl === '') {
    warnings.push(
      'REDIS_URL is not set: rate limits are counted per process, so each API instance has its own',
    );
  }

  return { problems, warnings };
}

/** What the database says about the role a connection runs as (`pg_roles`). */
export interface ConnectedRole {
  readonly name: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
}

/**
 * Reasons a runtime connection must not run as this role (CLAUDE.md §5.1).
 *
 * Row-level security is the tenant wall, and a role with BYPASSRLS or SUPERUSER walks through it
 * without being stopped or logged. Managed Postgres makes this one typo away: the connection
 * string the provider shows first is the administrative role (DigitalOcean's `doadmin` bypasses
 * RLS). `checkDatabaseUrl` catches the name; this catches the fact, so a renamed or newly
 * privileged role is refused too. Names the variable and the role, never a password or a URL.
 */
export function connectedRoleProblems(variable: string, role: ConnectedRole): readonly string[] {
  const problems: string[] = [];
  if (role.superuser) {
    problems.push(`${variable} connects as role "${role.name}", which is a superuser`);
  }
  if (role.bypassRls) {
    problems.push(`${variable} connects as role "${role.name}", which has BYPASSRLS`);
  }
  return problems;
}

/** Throws one error naming every problem, for an app to call before it listens. */
export function assertProductionConfig(input: ProductionConfigInput): readonly string[] {
  const report = productionConfigProblems(input);
  if (report.problems.length > 0) {
    throw new Error(
      `Refusing to start in production with an unsafe configuration:\n - ${report.problems.join('\n - ')}`,
    );
  }
  return report.warnings;
}

/**
 * Throws if any connection runs as a role that can bypass row-level security. `roles` is keyed by
 * the variable that configured each connection, for the message.
 */
export function assertConnectedRoles(roles: Readonly<Record<string, ConnectedRole>>): void {
  const problems = Object.entries(roles).flatMap(([variable, role]) =>
    connectedRoleProblems(variable, role),
  );
  if (problems.length > 0) {
    throw new Error(
      `Refusing to start: a database connection can bypass row-level security:\n - ${problems.join('\n - ')}`,
    );
  }
}
