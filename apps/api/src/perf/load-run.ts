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
  /** Open-loop mixed traffic at this many requests per second; 0 means one scenario at a time. */
  readonly rate: number;
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

  // A path this user may not call (the audit log, for a rep) answers 403 by design. Say so once
  // rather than counting every request as an error or leaving a hole in the table.
  const probe = await fetch(`${options.baseUrl}${scenario.path(context, 0)}`, { headers });
  await probe.arrayBuffer();
  if (probe.status === 403) {
    return {
      name: `${scenario.name} (403: not permitted for this user)`,
      requests: 0,
      errors: 0,
      rps: 0,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      max: Number.NaN,
      budgetP95: null,
    };
  }

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

/** What people do all day, and how often: mostly lists and records, some search, a little reporting. */
const MIX: readonly { readonly match: RegExp; readonly weight: number }[] = [
  { match: /^(contacts|accounts|leads|deals): first page/, weight: 40 },
  {
    match: /^(contacts: sorted|accounts: sorted|contacts: filter surname|leads: filter)/,
    weight: 8,
  },
  { match: /^(contact|account|deal): one record/, weight: 20 },
  { match: /^search: (a common surname|full name|a rare term)/, weight: 10 },
  { match: /^(dashboard|my day|deals: pipeline board)/, weight: 8 },
  { match: /^activities:/, weight: 6 },
  { match: /^notifications:/, weight: 8 },
];

/**
 * Open-loop traffic: requests are issued on a schedule, whether or not the last one has answered,
 * which is how a crowd behaves. A closed loop (the other mode) slows down as the server does and so
 * can never show a queue building; this can.
 */
async function runMix(options: Options, token: string, context: Context): Promise<void> {
  const weighted: { scenario: Scenario; weight: number }[] = [];
  for (const scenario of SCENARIOS) {
    const rule = MIX.find((entry) => entry.match.test(scenario.name));
    if (rule !== undefined) weighted.push({ scenario, weight: rule.weight });
  }
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  const choose = (): Scenario => {
    let point = Math.random() * total;
    for (const entry of weighted) {
      point -= entry.weight;
      if (point <= 0) return entry.scenario;
    }
    const last = weighted.at(-1);
    if (last === undefined) throw new Error('empty mix');
    return last.scenario;
  };

  const headers = { authorization: `Bearer ${token}` };
  const byScenario = new Map<string, number[]>();
  const all: number[] = [];
  let errors = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let n = 0;
  const interval = 1000 / options.rate;
  const started = performance.now();
  const end = started + options.seconds * 1000;
  const pending: Promise<void>[] = [];

  for (let tick = 0; ; tick += 1) {
    const due = started + tick * interval;
    if (due >= end) break;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const scenario = choose();
    const url = `${options.baseUrl}${scenario.path(context, n)}`;
    n += 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    // Latency is from when the request was due, not when it left: a client that was kept waiting
    // by a busy event loop still waited.
    pending.push(
      fetch(url, { headers })
        .then(async (response) => {
          await response.arrayBuffer();
          const ms = performance.now() - due;
          if (response.ok) {
            all.push(ms);
            byScenario.set(scenario.name, [...(byScenario.get(scenario.name) ?? []), ms]);
          } else if (response.status !== 403) {
            errors += 1;
          }
        })
        .catch(() => {
          errors += 1;
        })
        .finally(() => {
          inFlight -= 1;
        }),
    );
  }
  await Promise.all(pending);
  const elapsed = (performance.now() - started) / 1000;

  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      n: sorted.length,
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted.at(-1) ?? Number.NaN),
    };
  };
  const overall = stats(all);
  const lines = [
    `### ${options.label} (open loop, ${String(options.rate)} requests/s for ${String(options.seconds)} s)`,
    '',
    `Served ${String(overall.n)} requests at ${String(Math.round(overall.n / elapsed))} req/s with ${String(errors)} errors; at most ${String(peakInFlight)} in flight at once.`,
    '',
    '| Path | Requests | p50 ms | p95 ms | p99 ms | max ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| **all traffic** | ${String(overall.n)} | ${String(overall.p50)} | ${String(overall.p95)} | ${String(overall.p99)} | ${String(overall.max)} |`,
  ];
  for (const [name, values] of [...byScenario.entries()].sort()) {
    const row = stats(values);
    lines.push(
      `| ${name} | ${String(row.n)} | ${String(row.p50)} | ${String(row.p95)} | ${String(row.p99)} | ${String(row.max)} |`,
    );
  }
  process.stdout.write(`\n${lines.join('\n')}\n`);
  process.stdout.write(
    `\n${JSON.stringify({ overall, errors, peakInFlight, rate: options.rate })}\n`,
  );
}

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
    rate: Number(flag('--rate') ?? '0'),
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

  if (options.rate > 0) {
    await runMix(options, token, context);
    return;
  }

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
