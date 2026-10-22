import { formatMinor, type ExportableObjectType } from '@crm/core';
import { and, asc, desc, eq, getTableColumns, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { accounts, contacts, deals, leads } from '../schema/crm.js';

/**
 * How each object's table is read and written by import and export
 * (MVP_SPEC §M8, ADR-0029, ADR-0004).
 *
 * The rules about *what* may be imported or exported are metadata and live in
 * `@crm/core`. This file is only the Drizzle binding: which column holds what,
 * so the worker can build a query or an insert without a `switch` on object
 * type in every handler.
 *
 * It sits in `@crm/db` beside the search projection for the same reason that
 * one does: it reads and writes the record tables directly, runs in the worker
 * and never inside a request, and returns nothing to anybody but the job that
 * asked. Drizzle stays behind this package (ADR-0017).
 *
 * Every table here shares the shape CLAUDE.md §7 gives business records —
 * `id, tenant_id, owner_id, created_at, deleted_at, version, custom_fields` —
 * which is what lets one set of closures serve four objects. The TypeScript
 * union of four table types does not compose through Drizzle's generics, so
 * each closure names `contacts` as the representative type and is handed the
 * real table at runtime. That cast is type-level only; the columns it touches
 * exist on all four, and `descriptors.spec.ts` exercises every object.
 */

export type RecordRow = Readonly<Record<string, unknown>>;

type RecordTable = typeof contacts | typeof accounts | typeof leads | typeof deals;

/** Columns a list may be sorted or filtered on, by field key, as SQL. */
export type ColumnMap = Readonly<Record<string, SQL>>;

export interface ObjectDescriptor {
  readonly objectType: ExportableObjectType;
  /** `QUERY_COLUMNS[objectType]` keys, resolved to this table's columns. */
  readonly columns: ColumnMap;
  readonly customFields: SQL;
  readonly ownerId: SQL;
  readonly id: SQL;
  /** The searchable field keys, which a free-text search may look in. */
  readonly searchKeys: readonly string[];
  /**
   * Free-text search over `readable` columns only: what a caller may search is what they may read
   * (CLAUDE.md §5.4). With none readable the predicate is false.
   */
  search(pattern: string, readable: readonly string[]): SQL;
  /**
   * The expression a row is matched to an existing record on.
   *
   * For `email` this is `email::text`, compared with the lower-cased value: `citext` equality is
   * not leakproof, so under row-level security an index on the column itself is never used, and
   * matching 500 rows against a million-row tenant would read the whole tenant per chunk, the
   * difference between a 50,000-row import taking a minute and taking an hour. The text
   * expression has its own index (migration 0020, ADR-0041).
   */
  matchExpression(field: string): SQL;
  /**
   * A page of live rows, scoped by the caller's own predicates.
   *
   * `cursorValue` is the sort expression rendered to text *by Postgres* and
   * carried verbatim — deriving it from the JavaScript value would lose the
   * microseconds a `timestamptz` holds and re-serve the boundary row (ADR-0012).
   */
  selectPage(
    tx: Tx,
    options: {
      tenantId: string;
      where: readonly SQL[];
      sort: SQL;
      direction: 'asc' | 'desc';
      limit: number;
    },
  ): Promise<(RecordRow & { cursorValue: string | null })[]>;
  /** Live rows whose match expression equals one of `values`, inside `scope`. */
  selectByMatch(
    tx: Tx,
    options: { tenantId: string; matchExpression: SQL; values: readonly string[]; scope?: SQL },
  ): Promise<RecordRow[]>;
  insertMany(tx: Tx, rows: readonly RecordRow[]): Promise<void>;
  /** Version-guarded; null when somebody saved first. */
  updateOne(
    tx: Tx,
    options: { tenantId: string; id: string; expectedVersion: number; patch: RecordRow },
  ): Promise<RecordRow | null>;
  /** A single value of a *system* field, as it should appear in an export. */
  exportValue(row: RecordRow, key: string): unknown;
  /**
   * Reference and bookkeeping columns an export may carry that are not in
   * `field_definitions` (there is no field type for a reference, see
   * `seed/fields.ts`). Each is still gated by `canReadField` on its own key.
   */
  readonly extraExportColumns: readonly { key: string; label: string }[];
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function iso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** Money held as `bigint` minor units + a currency, shown as one exact string. */
function money(minor: unknown, currency: unknown): unknown {
  if (minor === null || minor === undefined || typeof currency !== 'string') return null;
  return formatMinor(BigInt(minor as bigint | number | string), currency);
}

function defineDescriptor(
  objectType: ExportableObjectType,
  table: RecordTable,
  options: {
    columns: ColumnMap;
    searchColumns: ColumnMap;
    match?: ColumnMap;
    exportValue?: (row: RecordRow, key: string) => unknown;
    extraExportColumns?: readonly { key: string; label: string }[];
  },
): ObjectDescriptor {
  // See the file comment: the representative type, not a claim that all four
  // tables are one table.
  const t = table as typeof contacts;

  return {
    objectType,
    columns: options.columns,
    customFields: sql`${t.customFields}`,
    ownerId: sql`${t.ownerId}`,
    id: sql`${t.id}`,
    searchKeys: Object.keys(options.searchColumns),
    search(pattern, readable) {
      const parts = readable.map((key) => {
        const column = options.searchColumns[key];
        return column === undefined ? undefined : like(column, pattern);
      });
      return or(...parts) ?? sql`false`;
    },
    matchExpression(field) {
      const expression = options.match?.[field];
      if (expression === undefined) throw new Error(`${objectType} cannot be matched on ${field}`);
      return expression;
    },
    extraExportColumns: options.extraExportColumns ?? [],

    async selectPage(tx, { tenantId, where, sort, direction, limit }) {
      const rows = await tx
        .select({
          ...getTableColumns(t),
          cursorValue: sql<string | null>`(${sort})::text`,
        })
        .from(t)
        .where(and(eq(t.tenantId, tenantId), isNull(t.deletedAt), ...where))
        .orderBy(
          direction === 'asc' ? asc(sort) : desc(sort),
          direction === 'asc' ? asc(t.id) : desc(t.id),
        )
        .limit(limit);
      return rows;
    },

    async selectByMatch(tx, { tenantId, matchExpression, values, scope }) {
      if (values.length === 0) return [];
      const rows = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.tenantId, tenantId),
            isNull(t.deletedAt),
            sql`${matchExpression} in (${sql.join(
              values.map((value) => sql`${value}`),
              sql`, `,
            )})`,
            ...(scope === undefined ? [] : [scope]),
          ),
        )
        // Oldest first and id as the tiebreak, so "the first match" is stable.
        .orderBy(asc(t.createdAt), asc(t.id));
      return rows;
    },

    async insertMany(tx, rows) {
      if (rows.length === 0) return;
      await tx.insert(t).values(rows as unknown as (typeof contacts.$inferInsert)[]);
    },

    async updateOne(tx, { tenantId, id, expectedVersion, patch }) {
      const rows = await tx
        .update(t)
        .set({
          ...(patch as Partial<typeof contacts.$inferInsert>),
          version: expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(t.tenantId, tenantId),
            eq(t.id, id),
            eq(t.version, expectedVersion),
            isNull(t.deletedAt),
          ),
        )
        .returning();
      return (rows[0] as unknown as RecordRow | undefined) ?? null;
    },

    exportValue(row, key) {
      const special = options.exportValue?.(row, key);
      if (special !== undefined) return special;
      return iso(row[snakeToCamel(key)]);
    },
  };
}

const LIKE_ESCAPE = '!';

/** Same escape the list's search box uses: `!`, so no backslash has to survive three layers. */
function like(expression: SQL, pattern: string): SQL {
  return sql`${expression} ilike ${pattern} escape ${LIKE_ESCAPE}`;
}

const CONTACT = defineDescriptor('contact', contacts, {
  columns: {
    first_name: sql`${contacts.firstName}`,
    last_name: sql`${contacts.lastName}`,
    email: sql`${contacts.email}::text`,
    phone: sql`${contacts.phone}`,
    whatsapp: sql`${contacts.whatsapp}`,
    title: sql`${contacts.title}`,
    account_id: sql`${contacts.accountId}`,
    lead_source: sql`${contacts.leadSource}`,
    owner_id: sql`${contacts.ownerId}`,
    created_at: sql`${contacts.createdAt}`,
    updated_at: sql`${contacts.updatedAt}`,
  },
  searchColumns: {
    first_name: sql`${contacts.firstName}`,
    last_name: sql`${contacts.lastName}`,
    email: sql`${contacts.email}::text`,
    phone: sql`${contacts.phone}`,
  },
  match: { email: sql`${contacts.email}::text`, phone: sql`${contacts.phone}` },
  extraExportColumns: [{ key: 'account_id', label: 'Account ID' }],
});

const ACCOUNT = defineDescriptor('account', accounts, {
  columns: {
    name: sql`${accounts.name}`,
    domain: sql`${accounts.domain}`,
    industry: sql`${accounts.industry}`,
    phone: sql`${accounts.phone}`,
    email: sql`${accounts.email}::text`,
    website: sql`${accounts.website}`,
    gstin: sql`${accounts.gstin}`,
    annual_revenue: sql`${accounts.annualRevenueMinor}`,
    employee_count: sql`${accounts.employeeCount}`,
    parent_account_id: sql`${accounts.parentAccountId}`,
    owner_id: sql`${accounts.ownerId}`,
    created_at: sql`${accounts.createdAt}`,
    updated_at: sql`${accounts.updatedAt}`,
  },
  searchColumns: {
    name: sql`${accounts.name}`,
    domain: sql`${accounts.domain}`,
    email: sql`${accounts.email}::text`,
    phone: sql`${accounts.phone}`,
  },
  exportValue: (row, key) =>
    key === 'annual_revenue'
      ? money(row['annualRevenueMinor'], row['annualRevenueCurrency'])
      : undefined,
  // Exact name match, not case-insensitive: `lower(name)` would defeat
  // `accounts_tenant_name_idx`. Domain is the better key and is lower-cased on write.
  match: { domain: sql`${accounts.domain}`, name: sql`${accounts.name}` },
  extraExportColumns: [{ key: 'parent_account_id', label: 'Parent account ID' }],
});

const LEAD = defineDescriptor('lead', leads, {
  columns: {
    first_name: sql`${leads.firstName}`,
    last_name: sql`${leads.lastName}`,
    company: sql`${leads.company}`,
    email: sql`${leads.email}::text`,
    phone: sql`${leads.phone}`,
    source: sql`${leads.source}`,
    status: sql`${leads.status}`,
    owner_id: sql`${leads.ownerId}`,
    converted_at: sql`${leads.convertedAt}`,
    created_at: sql`${leads.createdAt}`,
    updated_at: sql`${leads.updatedAt}`,
  },
  searchColumns: {
    first_name: sql`${leads.firstName}`,
    last_name: sql`${leads.lastName}`,
    company: sql`${leads.company}`,
    email: sql`${leads.email}::text`,
    phone: sql`${leads.phone}`,
  },
  match: { email: sql`${leads.email}::text`, phone: sql`${leads.phone}` },
  extraExportColumns: [{ key: 'converted_at', label: 'Converted at' }],
});

const DEAL = defineDescriptor('deal', deals, {
  columns: {
    name: sql`${deals.name}`,
    amount: sql`${deals.amountMinor}`,
    probability: sql`${deals.probability}`,
    expected_close_date: sql`${deals.expectedCloseDate}`,
    closed_at: sql`${deals.closedAt}`,
    lost_reason: sql`${deals.lostReason}`,
    account_id: sql`${deals.accountId}`,
    primary_contact_id: sql`${deals.primaryContactId}`,
    pipeline_id: sql`${deals.pipelineId}`,
    stage_id: sql`${deals.stageId}`,
    owner_id: sql`${deals.ownerId}`,
    created_at: sql`${deals.createdAt}`,
    updated_at: sql`${deals.updatedAt}`,
  },
  searchColumns: { name: sql`${deals.name}` },
  exportValue: (row, key) =>
    key === 'amount' ? money(row['amountMinor'], row['currency']) : undefined,
  extraExportColumns: [
    { key: 'account_id', label: 'Account ID' },
    { key: 'primary_contact_id', label: 'Primary contact ID' },
    { key: 'pipeline_id', label: 'Pipeline ID' },
    { key: 'stage_id', label: 'Stage ID' },
    { key: 'closed_at', label: 'Closed at' },
  ],
});

export const OBJECT_DESCRIPTORS: Readonly<Record<ExportableObjectType, ObjectDescriptor>> = {
  contact: CONTACT,
  account: ACCOUNT,
  lead: LEAD,
  deal: DEAL,
};

export { LIKE_ESCAPE };
