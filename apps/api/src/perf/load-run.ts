/**
 * Load runner: `pnpm --filter @crm/api perf:run -- --url http://localhost:3011 --email … --password …`
 * (MVP_SPEC §9, docs/PERF.md).
 *
 * Measures the **real HTTP API** with real sessions against a database loaded by
 * `pnpm --filter @crm/db perf:seed`: sign in, learn some real ids, then hit each
 * read path the product's screens use and report latency percentiles. Percentiles, not an
 * average, because the spec's budget is p95 and p99 and a mean hides the slow tail that
 * users feel.
 *
 * Deliberately small and dependency-free: it is a measuring tape, and one more thing that
 * could be wrong about the number. Each scenario runs a warm-up (so a cold plan or a cold
 * connection pool is not charged to it), then `--concurrency` workers issue requests
 * back to back for `--seconds`. Errors are counted and shown, never dropped from the
 * numbers: a path that is fast because it returns 500 has not met a budget.
 *
 * It is a tool for a scratch environment and takes its target and credentials as flags.
 * It is not imported by the service and is excluded from the production build.
 */

interface Options {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly concurrency: number;
  readonly seconds: number;
  readonly warmup: number;
  readonly only: RegExp | null;
  readonly label: string;
}

interface Context {
  readonly contactIds: string[];
  readonly accountIds: string[];
  readonly dealIds: string[];
  readonly userId: string | null;
  readonly deepCursor: string | null;
}

interface Scenario {
  readonly name: string;
  /** The budget in ms for p95, from MVP_SPEC §9, or null where the spec sets none. */
  readonly budgetP95: number | null;
  readonly path: (context: Context, n: number) => string;
}

export interface Measurement {
  readonly name: string;
  readonly requests: number;
  readonly errors: number;
  readonly rps: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly budgetP95: number | null;
}

const API = '/api/v1';

/** Pick a value by request number, so successive requests do not hit one cached row. */
function pick<T>(values: readonly T[], n: number): T {
  const value = values[n % values.length];
  if (value === undefined) throw new Error('No sample to pick from');
  return value;
}

const SURNAMES = ['Sharma', 'Patel', 'Khan', 'Nair', 'Smith', 'Desai', 'Reddy', 'Joshi'];
const RARE_TERMS = ['perf-user-7', 'Heritage Gems 4242', 'a.sharma', 'Ruby'];

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'contacts: first page, newest first',
    budgetP95: 200,
    path: () => `${API}/contacts?limit=50`,
  },
  {
    name: 'contacts: a page 4,000 rows deep (keyset)',
    budgetP95: 200,
    path: (c) => `${API}/contacts?limit=50&cursor=${c.deepCursor ?? ''}`,
  },
  {
    name: 'contacts: sorted by surname',
    budgetP95: 200,
    path: () => `${API}/contacts?limit=50&sort=last_name`,
  },
  {
    name: 'contacts: filter surname starts with',
    budgetP95: 200,
    path: (_c, n) =>
      `${API}/contacts?limit=50&filter=last_name:starts_with:${pick(['Sh', 'Pa', 'Kh', 'Na'], n)}`,
  },
  {
    name: 'contacts: filter by email (duplicate lookup)',
    budgetP95: 200,
    path: (_c, n) =>
      `${API}/contacts?limit=5&filter=email:eq:aarav.sharma${String(1 + (n % 900))}@example.com`,
  },
  {
    name: 'contacts: free-text q=surname',
    budgetP95: 200,
    path: (_c, n) => `${API}/contacts?limit=50&q=${pick(SURNAMES, n)}`,
  },
  {
    name: 'contacts: q matches nothing (worst case)',
    budgetP95: 200,
    path: (_c, n) =>
      `${API}/contacts?limit=50&q=${pick(['zzqx', 'qqzz', 'xxyyzz', 'nomatchhere'], n)}`,
  },
  {
    name: 'leads: q matches nothing (worst case)',
    budgetP95: 200,
    path: (_c, n) =>
      `${API}/leads?limit=50&q=${pick(['zzqx', 'qqzz', 'xxyyzz', 'nomatchhere'], n)}`,
  },
  {
    name: 'accounts: q matches nothing (worst case)',
    budgetP95: 200,
    path: (_c, n) =>
      `${API}/accounts?limit=50&q=${pick(['zzqx', 'qqzz', 'xxyyzz', 'nomatchhere'], n)}`,
  },
  {
    name: 'contact: one record',
    budgetP95: 200,
    path: (c, n) => `${API}/contacts/${pick(c.contactIds, n)}`,
  },
  { name: 'accounts: first page', budgetP95: 200, path: () => `${API}/accounts?limit=50` },
  {
    name: 'accounts: sorted by name',
    budgetP95: 200,
    path: () => `${API}/accounts?limit=50&sort=name`,
  },
  {
    name: 'account: one record',
    budgetP95: 200,
    path: (c, n) => `${API}/accounts/${pick(c.accountIds, n)}`,
  },
  { name: 'leads: first page', budgetP95: 200, path: () => `${API}/leads?limit=50` },
  {
    name: 'leads: filter status=new',
    budgetP95: 200,
    path: () => `${API}/leads?limit=50&filter=status:eq:new`,
  },
  { name: 'deals: first page', budgetP95: 200, path: () => `${API}/deals?limit=50` },
  {
    name: 'deal: one record',
    budgetP95: 200,
    path: (c, n) => `${API}/deals/${pick(c.dealIds, n)}`,
  },
  { name: 'deals: pipeline board', budgetP95: 200, path: () => `${API}/deals/board` },
  {
    name: 'activities: my open tasks',
    budgetP95: 200,
    path: (c) => `${API}/activities?limit=50&status=open&assignedTo=${c.userId ?? ''}`,
  },
  {
    name: 'activities: on one contact',
    budgetP95: 200,
    path: (c, n) =>
      `${API}/activities?limit=50&objectType=contact&recordId=${pick(c.contactIds, n)}`,
  },
  { name: 'my day', budgetP95: 200, path: () => `${API}/my-day` },
  { name: 'dashboard: pipeline', budgetP95: 200, path: () => `${API}/dashboard/pipeline` },
  { name: 'dashboard: won this month', budgetP95: 200, path: () => `${API}/dashboard/won` },
  {
    name: 'dashboard: leads by source',
    budgetP95: 200,
    path: () => `${API}/dashboard/leads-by-source`,
  },
  {
    name: 'dashboard: overdue tasks',
    budgetP95: 200,
    path: () => `${API}/dashboard/overdue-tasks`,
  },
  { name: 'dashboard: leaderboard', budgetP95: 200, path: () => `${API}/dashboard/leaderboard` },
  { name: 'audit log: first page', budgetP95: 200, path: () => `${API}/audit-logs?limit=50` },
  {
    name: 'audit log: one record’s history',
    budgetP95: 200,
    path: (c, n) => `${API}/audit-logs?limit=50&recordId=${pick(c.contactIds, n)}`,
  },
  {
    name: 'search: a common surname',
    budgetP95: 300,
    path: (_c, n) => `${API}/search?q=${pick(SURNAMES, n)}`,
  },
  {
    name: 'search: full name',
    budgetP95: 300,
    path: (_c, n) =>
      `${API}/search?q=${pick(SURNAMES, n)}+${pick(['Aarav', 'Priya', 'Rohan', 'Neha'], n)}`,
  },
  {
    name: 'search: a rare term',
    budgetP95: 300,
    path: (_c, n) => `${API}/search?q=${encodeURIComponent(pick(RARE_TERMS, n))}`,
  },
  {
    name: 'search: a typo (fuzzy)',
    budgetP95: 300,
    path: (_c, n) => `${API}/search?q=${pick(['Sharmaa', 'Patell', 'Kahn', 'Reedy'], n)}`,
  },
  {
    name: 'notifications: unread count',
    budgetP95: 200,
    path: () => `${API}/notifications/unread-count`,
  },
];

/** Nearest-rank percentile on a sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  const value = sorted[index];
  if (value === undefined) return Number.NaN;
  return value;
}

async function getJson(options: Options, token: string, path: string): Promise<unknown> {
  const response = await fetch(`${options.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}`);
  return response.json();
}

interface ListBody {
  readonly data: readonly { readonly id: string }[];
  readonly meta?: { readonly nextCursor?: string | null };
}

async function signIn(options: Options): Promise<{ token: string }> {
  const response = await fetch(`${options.baseUrl}${API}/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  const body = (await response.json()) as { data?: { token?: string } };
  if (!response.ok || body.data?.token === undefined) {
    throw new Error(`Sign-in failed with ${String(response.status)}`);
  }
  return { token: body.data.token };
}

async function discover(options: Options, token: string): Promise<Context> {
  const ids = async (path: string): Promise<string[]> =>
    ((await getJson(options, token, path)) as ListBody).data.map((row) => row.id);

  // Walk 80 pages of 50 to get a cursor 4,000 rows deep: what a person scrolling gets.
  let cursor: string | null = null;
  let deepCursor: string | null = null;
  for (let page = 0; page < 80; page += 1) {
    const url: string = `${API}/contacts?limit=50${cursor === null ? '' : `&cursor=${cursor}`}`;
    const body = (await getJson(options, token, url)) as ListBody;
    cursor = body.meta?.nextCursor ?? null;
    if (cursor === null) break;
    deepCursor = cursor;
  }

  const me = (await getJson(options, token, `${API}/auth/me`).catch(() => null)) as {
    data?: { user?: { id?: string }; id?: string };
  } | null;
  const userId = me?.data?.user?.id ?? me?.data?.id ?? null;

  return {
    contactIds: await ids(`${API}/contacts?limit=100`),
    accountIds: await ids(`${API}/accounts?limit=100`),
    dealIds: await ids(`${API}/deals?limit=100`),
    userId,
    deepCursor,
  };
}

async function measure(
  options: Options,
  token: string,
  context: Context,
  scenario: Scenario,
): Promise<Measurement> {
  const headers = { authorization: `Bearer ${token}` };
  let counter = 0;
  const once = async (): Promise<{ ms: number; ok: boolean }> => {
    const n = counter;
    counter += 1;
    const started = performance.now();
    try {
      const response = await fetch(`${options.baseUrl}${scenario.path(context, n)}`, { headers });
      await response.arrayBuffer();
      return { ms: performance.now() - started, ok: response.ok };
    } catch {
      return { ms: performance.now() - started, ok: false };
    }
  };

  for (let i = 0; i < options.warmup; i += 1) await once();

  const latencies: number[] = [];
  let errors = 0;
  const stopAt = performance.now() + options.seconds * 1000;
  const begun = performance.now();
  const worker = async (): Promise<void> => {
    while (performance.now() < stopAt) {
      const result = await once();
      if (result.ok) latencies.push(result.ms);
      else errors += 1;
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  const elapsed = (performance.now() - begun) / 1000;

  latencies.sort((a, b) => a - b);
  return {
    name: scenario.name,
    requests: latencies.length + errors,
    errors,
    rps: Math.round((latencies.length + errors) / elapsed),
    p50: round(percentile(latencies, 50)),
    p95: round(percentile(latencies, 95)),
    p99: round(percentile(latencies, 99)),
    max: round(latencies.at(-1) ?? Number.NaN),
    budgetP95: scenario.budgetP95,
  };
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function formatTable(label: string, rows: readonly Measurement[]): string {
  const lines = [
    `### ${label}`,
    '',
    '| Path | Requests | Errors | req/s | p50 ms | p95 ms | p99 ms | max ms | Budget p95 | |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const r of rows) {
    const verdict =
      r.errors > 0 ? 'errors' : r.budgetP95 === null ? '' : r.p95 <= r.budgetP95 ? 'ok' : 'OVER';
    lines.push(
      `| ${r.name} | ${String(r.requests)} | ${String(r.errors)} | ${String(r.rps)} | ${String(r.p50)} | ${String(r.p95)} | ${String(r.p99)} | ${String(r.max)} | ${r.budgetP95 === null ? '' : String(r.budgetP95)} | ${verdict} |`,
    );
  }
  return lines.join('\n');
}

export function parseOptions(argv: readonly string[]): Options {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const required = (name: string): string => {
    const value = flag(name);
    if (value === undefined) throw new Error(`Missing ${name}`);
    return value;
  };
  const only = flag('--only');
  return {
    baseUrl: flag('--url') ?? 'http://localhost:3011',
    email: required('--email'),
    password: required('--password'),
    concurrency: Number(flag('--concurrency') ?? '1'),
    seconds: Number(flag('--seconds') ?? '8'),
    warmup: Number(flag('--warmup') ?? '10'),
    only: only === undefined ? null : new RegExp(only, 'i'),
    label: flag('--label') ?? 'run',
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const options = parseOptions(argv);
  if (!(options.concurrency >= 1 && options.concurrency <= 200)) {
    throw new Error('--concurrency must be between 1 and 200');
  }
  const { token } = await signIn(options);
  const context = await discover(options, token);
  process.stdout.write(
    `signed in; ${String(context.contactIds.length)} contacts, ${String(context.accountIds.length)} accounts, ${String(context.dealIds.length)} deals sampled; deep cursor ${context.deepCursor === null ? 'MISSING' : 'ok'}\n`,
  );

  const rows: Measurement[] = [];
  for (const scenario of SCENARIOS) {
    if (options.only !== null && !options.only.test(scenario.name)) continue;
    const row = await measure(options, token, context, scenario);
    rows.push(row);
    process.stderr.write(
      `${scenario.name}: p95 ${String(row.p95)} ms, ${String(row.errors)} errors\n`,
    );
  }
  process.stdout.write(
    `\n${formatTable(`${options.label} (concurrency ${String(options.concurrency)})`, rows)}\n`,
  );
  process.stdout.write(`\n${JSON.stringify(rows)}\n`);
}
