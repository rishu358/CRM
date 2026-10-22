import pg from 'pg';

/**
 * Load-test data: `pnpm --filter @crm/db perf:seed` (MVP_SPEC §11 week 6, docs/PERF.md).
 *
 * Fills the demo tenant of an already-migrated, already-seeded database with the volume
 * the spec's design target asks for, so the timings in `docs/PERF.md` come from the real
 * API reading real rows rather than from a fixture that fits in cache.
 *
 * Written as set-based SQL (`generate_series`) run as a superuser, because a million rows
 * inserted one request at a time is a different experiment: it measures write throughput
 * and takes a day. What matters for reads is the shape of the data, so the shape is made
 * to look like a company that has been using the product for three years:
 *
 * - **Ids are UUIDv7**, time-ordered like the application's own (ADR-0003). `gen_random_uuid`
 *   would give random B-tree locality that production never has and flatter or punish the
 *   indexes for the wrong reason.
 * - **`created_at` runs across three years** in id order, so keyset pagination and the
 *   dashboard's "this month" windows face a realistic spread.
 * - **Ownership is spread over 43 users**, so a rep on `own` scope sees about 2% of the
 *   tenant, as in a team of that size, and not nearly everything or nearly nothing.
 * - **Names are drawn from a small list**, on purpose. A surname shared by one record in
 *   150 means a search term that matches thousands of rows, which is the expensive case
 *   (ADR-0028 §4) and the one a test with unique random names never exercises.
 * - **The search index is written with the records**, in the same statement, because the
 *   outbox relay would take hours and is not what is being measured.
 *
 * Guards: it refuses to run against a database that is not named like a scratch one, and
 * refuses to add to a tenant that already holds data unless `--reset` is given, which
 * deletes this tenant's CRM rows (never the tenant, its users or its configuration).
 */

const FIRST_NAMES = [
  'Aarav',
  'Aditi',
  'Aisha',
  'Ananya',
  'Arjun',
  'Ayesha',
  'Bhavna',
  'Chetan',
  'Deepa',
  'Dev',
  'Divya',
  'Farhan',
  'Gauri',
  'Harsh',
  'Isha',
  'Jatin',
  'Kavya',
  'Kunal',
  'Lakshmi',
  'Manish',
  'Meera',
  'Mohan',
  'Nandini',
  'Neha',
  'Nikhil',
  'Pooja',
  'Pranav',
  'Priya',
  'Rahul',
  'Rajesh',
  'Rekha',
  'Rohan',
  'Sagar',
  'Sana',
  'Sanjay',
  'Shreya',
  'Sneha',
  'Suresh',
  'Tanvi',
  'Uday',
  'Varun',
  'Vikram',
  'Yash',
  'Zoya',
  'Anna',
  'Ben',
  'Chloe',
  'Daniel',
  'Emma',
  'Frank',
  'Grace',
  'Henry',
  'Irene',
  'Jack',
  'Katie',
  'Liam',
  'Maya',
  'Noah',
  'Olivia',
  'Peter',
];

const LAST_NAMES = [
  'Sharma',
  'Verma',
  'Gupta',
  'Singh',
  'Patel',
  'Shah',
  'Mehta',
  'Jain',
  'Agarwal',
  'Reddy',
  'Nair',
  'Iyer',
  'Menon',
  'Pillai',
  'Rao',
  'Kapoor',
  'Malhotra',
  'Chopra',
  'Bose',
  'Das',
  'Ghosh',
  'Mukherjee',
  'Banerjee',
  'Chatterjee',
  'Joshi',
  'Kulkarni',
  'Deshmukh',
  'Patil',
  'Pawar',
  'Shinde',
  'Khan',
  'Ansari',
  'Qureshi',
  'Siddiqui',
  'Sheikh',
  'Fernandes',
  'DSouza',
  'Pereira',
  'Gomes',
  'Rodrigues',
  'Smith',
  'Brown',
  'Taylor',
  'Wilson',
  'Clark',
  'Walker',
  'Hall',
  'Young',
  'King',
  'Wright',
  'Thakur',
  'Yadav',
  'Mishra',
  'Pandey',
  'Tiwari',
  'Dubey',
  'Saxena',
  'Bhatt',
  'Trivedi',
  'Desai',
];

const COMPANY_PREFIXES = [
  'Lotus',
  'Royal',
  'Golden',
  'Silver',
  'Heritage',
  'Modern',
  'Classic',
  'Elite',
  'Prime',
  'Star',
  'Sunrise',
  'Emerald',
  'Ruby',
  'Pearl',
  'Diamond',
  'Crown',
  'Regal',
  'Imperial',
  'Grand',
  'Noble',
];
const COMPANY_KINDS = [
  'Jewellers',
  'Gold House',
  'Designs',
  'Traders',
  'Exports',
  'Studio',
  'Retail',
  'Wholesale',
  'Crafts',
  'Gems',
];
const INDUSTRIES = [
  'Jewellery retail',
  'Interior design',
  'Wholesale',
  'Export',
  'Manufacturing',
  'Hospitality',
];
const LEAD_SOURCES = ['referral', 'website', 'walk_in', 'exhibition', 'campaign'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified'];
const TITLES = ['Owner', 'Manager', 'Buyer', 'Director', 'Purchase head', 'Designer'];
const DEAL_THINGS = [
  'Bridal set',
  'Bulk order',
  'Showroom fit-out',
  'Festival stock',
  'Custom design',
  'Annual contract',
];
const ACTIVITY_SUBJECTS = [
  'Follow up call',
  'Send quotation',
  'Site visit',
  'Share catalogue',
  'Confirm order',
  'Collect payment',
];

export interface LoadSeedOptions {
  readonly contacts: number;
  readonly reset: boolean;
}

export interface LoadSeedSummary {
  readonly tenantId: string;
  readonly users: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly seconds: number;
}

const CHUNK = 100_000;

/** Scratch databases only: the guard that stops this being pointed at something that matters. */
export function assertScratchDatabase(connectionString: string): void {
  const name = new URL(connectionString).pathname.replace(/^\//, '');
  if (!/(^|_)(perf|load|scratch|e2e|test)(_|$)/.test(name)) {
    throw new Error(
      `Refusing to load-test "${name}": the database name must contain perf, load, scratch, e2e or test.`,
    );
  }
}

/**
 * `pg_temp.uuid7(ts)`: a UUIDv7 whose time part is `ts`, as the application's `newId` makes
 * (ADR-0003). Lives for the session only, so nothing is left behind in the schema.
 */
const UUID7_FUNCTION = `
  create or replace function pg_temp.uuid7(ts timestamptz) returns uuid
  language sql volatile as $$
    select encode(
      set_bit(set_bit(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send(floor(extract(epoch from ts) * 1000)::bigint) from 3)
                from 1 for 6),
        52, 1), 53, 1), 'hex')::uuid
  $$`;

/** A record's created time: strictly increasing with its number, over three years. */
const CREATED_AT = (n: string, total: string) =>
  `(now() - make_interval(secs => (${total} - ${n}) * (94608000.0 / ${total})))`;

export async function loadSeed(
  pool: pg.Pool,
  options: LoadSeedOptions,
  log: (message: string) => void = () => undefined,
): Promise<LoadSeedSummary> {
  const started = Date.now();
  const client = await pool.connect();
  const total = options.contacts;
  const accountsTotal = Math.max(1, Math.floor(total / 10));
  const leadsTotal = Math.max(1, Math.floor(total / 5));
  const dealsTotal = Math.max(1, Math.floor(total / 5));
  const activitiesTotal = Math.max(1, Math.floor(total / 2));
  const auditTotal = total;

  const run = async (label: string, text: string, values: unknown[] = []): Promise<void> => {
    const t = Date.now();
    const result = await client.query(text, values);
    log(`${label}: ${String(result.rowCount ?? 0)} rows in ${String(Date.now() - t)} ms`);
  };

  try {
    await client.query(UUID7_FUNCTION);

    const tenant = await client.query<{ id: string }>(
      `select id from tenants where slug like 'demo-%' order by created_at limit 1`,
    );
    const tenantId = tenant.rows[0]?.id;
    if (tenantId === undefined) throw new Error('No demo tenant. Run `pnpm db:seed` first.');

    const existing = await client.query<{ n: string }>(
      'select count(*)::text as n from contacts where tenant_id = $1',
      [tenantId],
    );
    const present = Number(existing.rows[0]?.n ?? 0);
    if (present > 1000 && !options.reset) {
      throw new Error(
        `The tenant already holds ${String(present)} contacts. Use --reset to replace them.`,
      );
    }
    if (options.reset) {
      log('resetting this tenant’s CRM rows');
      for (const table of [
        'search_documents',
        'activity_links',
        'activities',
        'deal_contacts',
        'deals',
        'leads',
        'contacts',
        'accounts',
        'audit_logs',
      ]) {
        // A superuser deletes the append-only audit log as well; nothing in the product can.
        await client.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
      }
    }

    // 40 extra users with a membership each (no credentials: nobody signs in as them), so that
    // ownership is spread the way a team's is.
    const salesRole = await client.query<{ id: string }>(
      `select id from roles where tenant_id = $1 and name = 'Sales Rep'`,
      [tenantId],
    );
    const roleId = salesRole.rows[0]?.id;
    if (roleId === undefined) throw new Error('The demo tenant has no Sales Rep role.');
    await client.query(
      `insert into users (id, email, name, email_verified_at)
       select pg_temp.uuid7(now()), 'perf-user-' || g || '@example.com', 'Perf User ' || g, now()
       from generate_series(1, 40) g
       on conflict (email) do nothing`,
    );
    await client.query(
      `insert into memberships (id, tenant_id, user_id, role_id, status, joined_at)
       select pg_temp.uuid7(now()), $1, u.id, $2, 'active', now()
       from users u
       where u.email like 'perf-user-%@example.com'
         and not exists (select 1 from memberships m where m.tenant_id = $1 and m.user_id = u.id)`,
      [tenantId, roleId],
    );
    const ownerRows = await client.query<{ user_id: string }>(
      `select user_id from memberships where tenant_id = $1 and status = 'active' order by user_id`,
      [tenantId],
    );
    const owners = ownerRows.rows.map((row) => row.user_id);

    const pipeline = await client.query<{ id: string }>(
      `select id from pipelines where tenant_id = $1 and is_default order by created_at limit 1`,
      [tenantId],
    );
    const pipelineId = pipeline.rows[0]?.id;
    if (pipelineId === undefined) throw new Error('The demo tenant has no default pipeline.');
    const stages = await client.query<{ id: string; stage_type: string }>(
      `select id, stage_type from pipeline_stages where tenant_id = $1 and pipeline_id = $2 order by position`,
      [tenantId, pipelineId],
    );
    const openStages = stages.rows.filter((s) => s.stage_type === 'open').map((s) => s.id);
    const wonStage = stages.rows.find((s) => s.stage_type === 'won')?.id;
    const lostStage = stages.rows.find((s) => s.stage_type === 'lost')?.id;
    if (openStages.length === 0 || wonStage === undefined || lostStage === undefined) {
      throw new Error('The default pipeline needs open, won and lost stages.');
    }

    // ---- accounts ----------------------------------------------------------------
    for (let from = 1; from <= accountsTotal; from += CHUNK) {
      const to = Math.min(accountsTotal, from + CHUNK - 1);
      await run(
        'accounts',
        `with made as (
           select g,
                  ${CREATED_AT('g', '$5::int')} as ts,
                  ($6::text[])[1 + (g * 7) % cardinality($6::text[])] as prefix,
                  ($7::text[])[1 + (g * 3) % cardinality($7::text[])] as kind
           from generate_series($2::int, $3::int) g
         ), ins as (
           insert into accounts (id, tenant_id, owner_id, name, domain, industry, phone, email,
                                 created_at, updated_at, created_by)
           select pg_temp.uuid7(ts), $1, ($4::uuid[])[1 + (g * 31) % cardinality($4::uuid[])],
                  prefix || ' ' || kind || ' ' || g,
                  lower(prefix || kind || g) || '.example',
                  ($8::text[])[1 + g % cardinality($8::text[])],
                  '+9122' || lpad(g::text, 8, '0'),
                  'hello@' || lower(prefix || kind || g) || '.example',
                  ts, ts, ($4::uuid[])[1]
           from made
           returning id, owner_id, name, domain, email::text as email, phone, updated_at
         )
         insert into search_documents (id, tenant_id, object_type, record_id, field_key, owner_id,
                                       value, weight, record_updated_at, created_at, updated_at)
         select pg_temp.uuid7(i.updated_at), $1, 'account', i.id, f.key, i.owner_id, f.val, f.w,
                i.updated_at, i.updated_at, i.updated_at
         from ins i
         cross join lateral (values ('name', i.name, 'A'), ('domain', i.domain, 'B'),
                                    ('email', i.email, 'B'), ('phone', i.phone, 'C')) f(key, val, w)
         where f.val is not null`,
        [tenantId, from, to, owners, accountsTotal, COMPANY_PREFIXES, COMPANY_KINDS, INDUSTRIES],
      );
    }
    const accountIds = (
      await client.query<{ id: string }>(
        'select id from accounts where tenant_id = $1 order by id',
        [tenantId],
      )
    ).rows.map((row) => row.id);

    // ---- contacts ----------------------------------------------------------------
    for (let from = 1; from <= total; from += CHUNK) {
      const to = Math.min(total, from + CHUNK - 1);
      await run(
        'contacts',
        `with made as (
           select g,
                  ${CREATED_AT('g', '$5::int')} as ts,
                  ($6::text[])[1 + (g * 13) % cardinality($6::text[])] as fn,
                  ($7::text[])[1 + (g * 7) % cardinality($7::text[])] as ln
           from generate_series($2::int, $3::int) g
         ), ins as (
           insert into contacts (id, tenant_id, owner_id, first_name, last_name, email, phone, title,
                                 account_id, lead_source, created_at, updated_at, created_by)
           select pg_temp.uuid7(ts), $1, ($4::uuid[])[1 + (g * 37) % cardinality($4::uuid[])],
                  fn, ln, lower(fn || '.' || ln || g || '@example.com'),
                  '+919' || lpad(g::text, 9, '0'),
                  ($8::text[])[1 + g % cardinality($8::text[])],
                  case when g % 5 = 0 then null else ($9::uuid[])[1 + (g * 17) % cardinality($9::uuid[])] end,
                  ($10::text[])[1 + g % cardinality($10::text[])],
                  ts, ts, ($4::uuid[])[1]
           from made
           returning id, owner_id, first_name, last_name, email::text as email, phone, updated_at
         )
         insert into search_documents (id, tenant_id, object_type, record_id, field_key, owner_id,
                                       value, weight, record_updated_at, created_at, updated_at)
         select pg_temp.uuid7(i.updated_at), $1, 'contact', i.id, f.key, i.owner_id, f.val, f.w,
                i.updated_at, i.updated_at, i.updated_at
         from ins i
         cross join lateral (values ('first_name', i.first_name, 'A'), ('last_name', i.last_name, 'A'),
                                    ('email', i.email, 'B'), ('phone', i.phone, 'C')) f(key, val, w)
         where f.val is not null`,
        [
          tenantId,
          from,
          to,
          owners,
          total,
          FIRST_NAMES,
          LAST_NAMES,
          TITLES,
          accountIds,
          LEAD_SOURCES,
        ],
      );
    }
    const contactSample = (
      await client.query<{ id: string }>(
        `select id from contacts where tenant_id = $1 and abs(hashtext(id::text)) % 10 = 0 limit 100000`,
        [tenantId],
      )
    ).rows.map((row) => row.id);

    // ---- leads -------------------------------------------------------------------
    for (let from = 1; from <= leadsTotal; from += CHUNK) {
      const to = Math.min(leadsTotal, from + CHUNK - 1);
      await run(
        'leads',
        `with made as (
           select g,
                  ${CREATED_AT('g', '$5::int')} as ts,
                  ($6::text[])[1 + (g * 11) % cardinality($6::text[])] as fn,
                  ($7::text[])[1 + (g * 5) % cardinality($7::text[])] as ln,
                  ($8::text[])[1 + (g * 3) % cardinality($8::text[])] as prefix
           from generate_series($2::int, $3::int) g
         ), ins as (
           insert into leads (id, tenant_id, owner_id, first_name, last_name, company, email, phone,
                              source, status, created_at, updated_at, created_by)
           select pg_temp.uuid7(ts), $1, ($4::uuid[])[1 + (g * 29) % cardinality($4::uuid[])],
                  fn, ln, prefix || ' Traders ' || g, lower(fn || '.' || ln || g || '@lead.example'),
                  '+918' || lpad(g::text, 9, '0'),
                  ($9::text[])[1 + g % cardinality($9::text[])],
                  ($10::text[])[1 + g % cardinality($10::text[])],
                  ts, ts, ($4::uuid[])[1]
           from made
           returning id, owner_id, first_name, last_name, company, email::text as email, phone, updated_at
         )
         insert into search_documents (id, tenant_id, object_type, record_id, field_key, owner_id,
                                       value, weight, record_updated_at, created_at, updated_at)
         select pg_temp.uuid7(i.updated_at), $1, 'lead', i.id, f.key, i.owner_id, f.val, f.w,
                i.updated_at, i.updated_at, i.updated_at
         from ins i
         cross join lateral (values ('first_name', i.first_name, 'A'), ('last_name', i.last_name, 'A'),
                                    ('company', i.company, 'B'), ('email', i.email, 'B'),
                                    ('phone', i.phone, 'C')) f(key, val, w)
         where f.val is not null`,
        [
          tenantId,
          from,
          to,
          owners,
          leadsTotal,
          FIRST_NAMES,
          LAST_NAMES,
          COMPANY_PREFIXES,
          LEAD_SOURCES,
          LEAD_STATUSES,
        ],
      );
    }

    // ---- deals -------------------------------------------------------------------
    for (let from = 1; from <= dealsTotal; from += CHUNK) {
      const to = Math.min(dealsTotal, from + CHUNK - 1);
      await run(
        'deals',
        `with made as (
           select g,
                  ${CREATED_AT('g', '$5::int')} as ts,
                  ($6::text[])[1 + (g * 7) % cardinality($6::text[])] as thing,
                  g % 10 as bucket
           from generate_series($2::int, $3::int) g
         ), ins as (
           insert into deals (id, tenant_id, owner_id, name, account_id, primary_contact_id,
                              pipeline_id, stage_id, amount_minor, currency, probability,
                              expected_close_date, closed_at, lost_reason, created_at, updated_at, created_by)
           select pg_temp.uuid7(ts), $1, ($4::uuid[])[1 + (g * 23) % cardinality($4::uuid[])],
                  thing || ' ' || g,
                  ($7::uuid[])[1 + (g * 19) % cardinality($7::uuid[])],
                  ($8::uuid[])[1 + (g * 41) % cardinality($8::uuid[])],
                  $9, case when bucket < 6 then ($10::uuid[])[1 + g % cardinality($10::uuid[])]
                           when bucket < 9 then $11::uuid else $12::uuid end,
                  (50000 + (g * 7919) % 5000000) * 100, 'INR',
                  case when bucket < 6 then 30 when bucket < 9 then 100 else 0 end,
                  (ts + interval '30 days')::date,
                  case when bucket < 6 then null else ts + interval '20 days' end,
                  case when bucket = 9 then 'Price' else null end,
                  ts, ts, ($4::uuid[])[1]
           from made
           returning id, owner_id, name, updated_at
         )
         insert into search_documents (id, tenant_id, object_type, record_id, field_key, owner_id,
                                       value, weight, record_updated_at, created_at, updated_at)
         select pg_temp.uuid7(i.updated_at), $1, 'deal', i.id, 'name', i.owner_id, i.name, 'A',
                i.updated_at, i.updated_at, i.updated_at
         from ins i`,
        [
          tenantId,
          from,
          to,
          owners,
          dealsTotal,
          DEAL_THINGS,
          accountIds,
          contactSample,
          pipelineId,
          openStages,
          wonStage,
          lostStage,
        ],
      );
    }

    // ---- activities (and the link to a contact for each) -------------------------
    for (let from = 1; from <= activitiesTotal; from += CHUNK) {
      const to = Math.min(activitiesTotal, from + CHUNK - 1);
      await run(
        'activities',
        `with made as (
           select g,
                  ${CREATED_AT('g', '$5::int')} as ts,
                  ($6::text[])[1 + (g * 7) % cardinality($6::text[])] as subject
           from generate_series($2::int, $3::int) g
         ), ins as (
           insert into activities (id, tenant_id, assigned_to, type, subject, due_at, completed_at,
                                   priority, status, created_at, updated_at, created_by)
           select pg_temp.uuid7(ts), $1, ($4::uuid[])[1 + (g * 43) % cardinality($4::uuid[])],
                  (array['task','call','meeting','note'])[1 + g % 4],
                  subject || ' ' || g,
                  case when g % 4 = 3 then null else ts + interval '3 days' + make_interval(hours => g % 200) end,
                  case when g % 3 = 0 and g % 4 <> 3 then ts + interval '2 days' else null end,
                  (array['low','normal','high'])[1 + g % 3],
                  case when g % 3 = 0 and g % 4 <> 3 then 'completed' else 'open' end,
                  ts, ts, ($4::uuid[])[1]
           from made
           returning id, created_at
         ), numbered as (
           select id, created_at, row_number() over (order by id) as rn from ins
         )
         insert into activity_links (id, tenant_id, activity_id, object_type, record_id, created_at, updated_at)
         select pg_temp.uuid7(created_at), $1, id, 'contact',
                ($7::uuid[])[1 + (rn::int * 13) % cardinality($7::uuid[])], created_at, created_at
         from numbered`,
        [tenantId, from, to, owners, activitiesTotal, ACTIVITY_SUBJECTS, contactSample],
      );
    }

    // ---- audit log (the last 50 days, the span the monthly partitions cover) ------
    for (let from = 1; from <= auditTotal; from += CHUNK) {
      const to = Math.min(auditTotal, from + CHUNK - 1);
      await run(
        'audit_logs',
        `insert into audit_logs (id, tenant_id, occurred_at, actor_id, action, object_type, record_id,
                                 changes, ip_address, user_agent, request_id)
         select pg_temp.uuid7(ts), $1, ts, ($4::uuid[])[1 + (g * 47) % cardinality($4::uuid[])],
                (array['create','update','update','update','delete'])[1 + g % 5],
                (array['contact','account','lead','deal'])[1 + g % 4],
                ($6::uuid[])[1 + (g * 53) % cardinality($6::uuid[])],
                jsonb_build_object('phone', jsonb_build_object('from', null, 'to', '+919000000000')),
                '203.0.113.' || (g % 250), 'perf-seed', 'req-' || g
         from (select g, now() - make_interval(secs => ($5::int - g) * (4320000.0 / $5::int)) as ts
               from generate_series($2::int, $3::int) g) s`,
        [tenantId, from, to, owners, auditTotal, contactSample],
      );
    }

    // Statistics and the visibility map, or the planner and index-only scans are guessing.
    for (const table of [
      'accounts',
      'contacts',
      'leads',
      'deals',
      'activities',
      'activity_links',
      'search_documents',
      'audit_logs',
    ]) {
      const t = Date.now();
      // `parallel 0`: a parallel vacuum needs shared memory, and a container's default 64 MB
      // /dev/shm is far too small for the million-row tables ("No space left on device").
      await client.query(`vacuum (analyze, parallel 0) ${table}`);
      log(`vacuum analyze ${table}: ${String(Date.now() - t)} ms`);
    }

    // Real table counts, not the rows a statement reported: the record insert also writes search rows.
    const final: Record<string, number> = {};
    for (const table of [
      'accounts',
      'contacts',
      'leads',
      'deals',
      'activities',
      'search_documents',
      'audit_logs',
    ]) {
      const result = await client.query<{ n: string }>(
        `select count(*)::text as n from ${table} where tenant_id = $1`,
        [tenantId],
      );
      final[table] = Number(result.rows[0]?.n ?? 0);
    }

    return {
      tenantId,
      users: owners.length,
      counts: final,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } finally {
    client.release();
  }
}

/** CLI: `pnpm --filter @crm/db perf:seed -- --contacts 250000 [--reset]`. */
export async function main(argv: readonly string[], adminUrl: string | undefined): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const contacts = Number(flag('--contacts') ?? '250000');
  if (!Number.isInteger(contacts) || contacts < 1000 || contacts > 5_000_000) {
    throw new Error('--contacts must be an integer between 1,000 and 5,000,000');
  }
  if (adminUrl === undefined) {
    throw new Error(
      'Set PERF_ADMIN_URL to a superuser connection string for the scratch database.',
    );
  }
  assertScratchDatabase(adminUrl);
  const pool = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    const summary = await loadSeed(pool, { contacts, reset: argv.includes('--reset') }, (m) => {
      process.stdout.write(`${m}\n`);
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}
