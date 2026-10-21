import { Injectable } from '@nestjs/common';
import { isTimeZone } from '@crm/core';
import { eq, tenants, type Tx } from '@crm/db';

/**
 * The company's calendar (ADR-0038).
 *
 * "This month" on a screen everybody in the company sees has to mean the same
 * thing to all of them, so it is cut on the **company's** time zone, not on each
 * viewer's browser (My Day is the opposite on purpose: it is one person's day).
 *
 * Only the zone lives here. The instant is the database's, read inside the
 * request's transaction, so this class has no `Date` that could disagree with the
 * rows being compared against it.
 */
@Injectable()
export class TenantClock {
  /**
   * The company's IANA zone. A stored value the runtime does not recognise falls
   * back to UTC rather than failing every widget: the setup screen only accepts
   * known zones, so this can only be a value written before that rule.
   */
  async timeZone(tx: Tx, tenantId: string): Promise<string> {
    const rows = await tx
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const stored = rows[0]?.timezone;
    return stored !== undefined && isTimeZone(stored) ? stored : 'UTC';
  }
}
