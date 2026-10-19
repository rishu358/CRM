import { Injectable } from '@nestjs/common';
import { and, sql, type SQL, type Tx } from '@crm/db';
import { keysetPredicate } from '../../common/keyset.js';
import type { Cursor } from '../../common/cursor.js';

/**
 * Reads of the audit log (MVP_SPEC M11).
 *
 * The audit log is the largest table in the database and is partitioned monthly
 * by `occurred_at` (migration 0003), so the shape of this query is the whole
 * performance story and is written deliberately rather than assembled by an ORM
 * convenience:
 *
 *   - **the time bound is always present.** `AuditLogService` defaults it, and
 *     both ends are bound literals in the WHERE clause, which is what lets the
 *     planner prune to the partitions that can contain the range. Without it a
 *     query on a four-year-old tenant reads forty-eight partitions to return
 *     fifty rows.
 *   - **`tenant_id` leads every index** (0003 and 0016), so inside a partition
 *     the scan starts at this tenant's rows rather than filtering to them.
 *   - **the filters are closed sets.** `object_type` and `action` are validated
 *     by Zod against enumerations before they arrive, and every value is bound
 *     as a parameter (CLAUDE.md §5.7).
 *   - **keyset, never OFFSET** (ADR-0012), ordered `(occurred_at desc, id desc)`
 *     — which is also the leading edge of `audit_logs_tenant_time_idx`.
 *
 * `apps/api/src/modules/audit/audit-log.plan.spec.ts` asserts the resulting plan
 * actually prunes partitions and uses an index, because a comment claiming it
 * does is not evidence.
 */
@Injectable()
export class AuditLogRepository {
  async list(
    tx: Tx,
    tenantId: string,
    filters: {
      readonly from: Date;
      readonly to: Date;
      readonly actorId?: string | undefined;
      readonly objectType?: string | undefined;
      readonly action?: string | undefined;
      readonly recordId?: string | undefined;
      /** Business object types this reader has no `read` grant on. */
      readonly deniedObjectTypes: readonly string[];
    },
    page: { readonly limit: number; readonly cursor: Cursor | null },
  ): Promise<AuditLogRow[]> {
    const where = this.predicates(tenantId, filters);
    const cursor = page.cursor;
    if (cursor !== null) {
      where.push(
        keysetPredicate(
          sql`a.occurred_at`,
          sql`a.id`,
          'desc',
          // `occurred_at` is NOT NULL, so the null branches of the predicate are
          // unreachable here; it is used anyway so there is one keyset
          // implementation in the codebase rather than two.
          cursor,
        ),
      );
    }

    // `limit + 1` is how every list in this API decides `hasMore` without a
    // count: counting a partitioned log would cost more than the page itself.
    //
    // `cursor_value` is `occurred_at` rendered by **Postgres** and carried
    // verbatim. A timestamptz holds microseconds; a JavaScript Date holds
    // milliseconds. A cursor built from `occurred_at.toISOString()` is
    // therefore *earlier* than the row it came from, and the next page's
    // `(occurred_at, id) < (cursor, id)` excludes every row between the
    // truncated value and the real one — rows nobody has been served yet.
    // Silently skipped rows is the worst bug an audit log can have, so the
    // string the comparison uses is the string the database produced (the rule
    // the export pager already follows, ADR-0012).
    const rows = await tx.execute(sql`
      select a.id,
             a.occurred_at,
             a.actor_id,
             a.action,
             a.object_type,
             a.record_id,
             a.changes,
             a.ip_address,
             a.request_id,
             u.name as actor_name,
             a.occurred_at::text as cursor_value
      from audit_logs a
      left join users u on u.id = a.actor_id
      where ${and(...where)}
      order by a.occurred_at desc, a.id desc
      limit ${page.limit + 1}
    `);

    return rows.rows as unknown as AuditLogRow[];
  }

  /**
   * Build the WHERE clause.
   *
   * Split out so the plan test can assert on the same predicates the endpoint
   * uses rather than on a hand-written copy of them.
   */
  private predicates(
    tenantId: string,
    filters: {
      readonly from: Date;
      readonly to: Date;
      readonly actorId?: string | undefined;
      readonly objectType?: string | undefined;
      readonly action?: string | undefined;
      readonly recordId?: string | undefined;
      readonly deniedObjectTypes: readonly string[];
    },
  ): SQL[] {
    const where: SQL[] = [
      sql`a.tenant_id = ${tenantId}::uuid`,
      // The partition key. Inclusive lower, exclusive upper, so consecutive
      // windows neither overlap nor drop a row on the boundary.
      sql`a.occurred_at >= ${filters.from.toISOString()}::timestamptz`,
      sql`a.occurred_at < ${filters.to.toISOString()}::timestamptz`,
    ];

    if (filters.actorId !== undefined) {
      where.push(sql`a.actor_id = ${filters.actorId}::uuid`);
    }
    if (filters.objectType !== undefined) {
      where.push(sql`a.object_type = ${filters.objectType}`);
    }
    if (filters.action !== undefined) {
      where.push(sql`a.action = ${filters.action}`);
    }
    if (filters.recordId !== undefined) {
      where.push(sql`a.record_id = ${filters.recordId}::uuid`);
    }

    // The reader's own visibility, applied in SQL rather than after the fetch.
    // A reader who may not see `deal` rows must not have them counted against
    // their page size, or a page of fifty could come back with three
    // (ADR-0012, the same reason record scope is a WHERE clause).
    //
    // Expressed as an exclusion rather than an inclusion on purpose: the
    // `object_type` of an audit row is wider than the permission registry —
    // sessions, users, export jobs, the tenant row — and an inclusion list
    // would have to enumerate every one of those and would silently hide the
    // next one somebody adds.
    if (filters.deniedObjectTypes.length > 0) {
      where.push(
        sql`a.object_type not in (${sql.join(
          filters.deniedObjectTypes.map((value) => sql`${value}`),
          sql`, `,
        )})`,
      );
    }

    return where;
  }
}

export interface AuditLogRow {
  readonly id: string;
  readonly occurred_at: Date;
  /** `occurred_at` as Postgres renders it, for the keyset cursor. */
  readonly cursor_value: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly object_type: string;
  readonly record_id: string | null;
  readonly changes: Record<string, { old?: unknown; new?: unknown }> | null;
  readonly ip_address: string | null;
  readonly request_id: string | null;
  readonly actor_name: string | null;
}
