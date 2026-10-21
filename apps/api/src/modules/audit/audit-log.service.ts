import { Inject, Injectable } from '@nestjs/common';
import {
  assertCan,
  AUDIT_DEFAULT_WINDOW_MS,
  BUSINESS_OBJECT_TYPES,
  canViewAuditObjectType,
  ForbiddenError,
  ValidationError,
  type Actor,
} from '@crm/core';
import type { AuditEntry, AuditListQuery } from '@crm/contracts';
import { sql } from 'drizzle-orm';
import type { Tx } from '@crm/db';
import { decodeCursor, encodeCursor, type Cursor } from '../../common/cursor.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { serializeAuditEntries } from './audit-log.serializer.js';

/**
 * The audit log viewer (MVP_SPEC M11).
 *
 * Named `AuditLogService` to keep it apart from `platform/audit.service.ts`,
 * which **writes** the log. They are deliberately different objects with
 * different grants behind them: everything writes, almost nothing reads.
 *
 * Three decisions worth knowing before changing this:
 *
 * **1. The capability is a row, not a role check.** Reaching the viewer needs
 * `read` on the `audit_log` object type, which Owner and Admin are seeded with
 * (`SYSTEM_ROLES`). Everybody else is denied by the absence of a row, exactly
 * as every other denial in this engine works — there is no `if (admin)` here
 * (CLAUDE.md §5.3, ADR-0008).
 *
 * **2. `all` scope or nothing.** `own` and `team` scope have no meaning on a
 * log: an audit row is not owned by anyone, and resolving "whose record was
 * this about" would mean joining to five tables for records that may have been
 * purged since. A narrower grant is therefore refused outright rather than
 * silently treated as `all` — the same reasoning that makes `invitation` an
 * `all`-only grant.
 *
 * **3. The window is always bounded.** `occurred_at` is the partition key, so
 * the date range is what keeps this query off every month the tenant has ever
 * had. The default is the last 30 days; a caller who wants more asks for it.
 */
@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditLogRepository) private readonly repository: AuditLogRepository,
  ) {}

  async list(
    actor: Actor,
    query: AuditListQuery,
  ): Promise<{ data: AuditEntry[]; meta: { nextCursor: string | null; hasMore: boolean } }> {
    this.assertMayRead(actor);

    const cursor = resolveCursor(query.cursor);

    return this.inTenant(actor, async (tx) => {
      const window = await resolveWindow(tx, query);
      const rows = await this.repository.list(
        tx,
        actor.tenantId,
        {
          from: window.from,
          to: window.to,
          actorId: query.actorId,
          objectType: query.objectType,
          action: query.action,
          recordId: query.recordId,
          deniedObjectTypes: deniedObjectTypes(actor),
        },
        { limit: query.limit, cursor },
      );

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];

      return {
        // The one place the diff is filtered. Every row leaves through here.
        data: serializeAuditEntries(actor, page),
        meta: {
          nextCursor:
            hasMore && last !== undefined
              ? encodeCursor({ value: last.cursor_value, id: last.id })
              : null,
          hasMore,
        },
      };
    });
  }

  /**
   * May this actor read history at all?
   *
   * Public because the data-rights module asks the same question before
   * queueing an audit-log archive, and asking it in two places with two
   * answers is how an export becomes a way around a viewer.
   */
  assertMayRead(actor: Actor): void {
    const decision = assertCan(actor, 'read', { objectType: 'audit_log' });
    if (decision.allowed && decision.scope !== 'all') {
      // Not a 404: the caller holds a grant, it is simply too narrow to mean
      // anything here, and saying so is not an existence oracle for any record.
      throw new ForbiddenError(
        'Reading the audit log requires workspace-wide access, not a limited scope',
      );
    }
  }

  private inTenant<T>(actor: Actor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runInTenant({ tenantId: actor.tenantId, userId: actor.userId }, work);
  }
}

/**
 * Business object types this reader has no `read` grant on.
 *
 * Rows about them are excluded in SQL. Holding the audit capability is
 * permission to read *history*, not permission to read objects the role was
 * never granted: an Admin whose deal access was deliberately removed should not
 * recover it by reading the log.
 *
 * Exported for the security suite, which asserts the list is what the SQL
 * actually receives.
 */
export function deniedObjectTypes(actor: Actor): string[] {
  return BUSINESS_OBJECT_TYPES.filter((objectType) => !canViewAuditObjectType(actor, objectType));
}

/**
 * How far past the database's clock the default window reaches.
 *
 * A clock can move backwards. The Docker VM these suites run on does it by up
 * to about 1.2 s every half minute (ADR-0036), NTP corrections do it on real
 * hosts, and a VM migrated between machines does it by more. A row stamped just
 * before a step is then *ahead of the database's own clock* when the next request
 * reads it, so a bound of "the database's now" still excludes the newest entries
 * — which is how this was seen failing: a freshly written audit row missing from
 * the one view that exists to show it. No row can be stamped in the future by
 * anything except clock correction, so reaching a minute past "now" can only ever
 * include real, recent entries. It is a bound on the window, not a promise about
 * time.
 */
export const CLOCK_CORRECTION_ALLOWANCE_MS = 60_000;

async function databaseNow(tx: Tx): Promise<Date> {
  const row = (await tx.execute(sql`select clock_timestamp()::text as now`)).rows[0] as unknown as {
    now: string;
  };
  return new Date(new Date(row.now).getTime() + CLOCK_CORRECTION_ALLOWANCE_MS);
}

/**
 * The window the viewer reads.
 *
 * A caller who names no `to` means "up to now", and *now* has to be the
 * **database's**: `occurred_at` is stamped by Postgres's `now()`, so an upper
 * bound taken from this process's clock is a comparison between two clocks. When
 * the database is ahead of the API by even a few hundred milliseconds — a VM
 * clock being stepped, an NTP correction, two hosts that disagree — the newest
 * rows fall outside the window, and an audit log that quietly omits the last
 * thing that happened is the worst thing it can do. The Recycle Bin sweep
 * already takes its cutoff from the database for the same reason; an explicit
 * `to` from the caller is theirs and is used as given.
 *
 * Exported for the security suite, which hands it a database clock far from
 * this process's.
 */
export async function resolveWindow(
  tx: Tx,
  query: AuditListQuery,
): Promise<{ from: Date; to: Date }> {
  const to = query.to === undefined ? await databaseNow(tx) : new Date(query.to);
  const from =
    query.from === undefined
      ? new Date(to.getTime() - AUDIT_DEFAULT_WINDOW_MS)
      : new Date(query.from);

  if (from.getTime() >= to.getTime()) {
    throw new ValidationError([{ path: 'from', message: '`from` must be before `to`' }]);
  }
  return { from, to };
}

function resolveCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  const cursor = decodeCursor(raw);
  if (cursor === null) {
    throw new ValidationError([{ path: 'cursor', message: 'Malformed cursor' }]);
  }
  return cursor;
}
