import { Inject, Injectable } from '@nestjs/common';
import {
  EntitlementRequiredError,
  resolveEntitlements,
  type Entitlements,
  type Feature,
} from '@crm/core';
import { eq, tenantEntitlements, tenants, type Tx } from '@crm/db';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';

/**
 * `entitlements.has(tenant, feature)`: which features this workspace has (ADR-0047, ADR-0010).
 *
 * Read inside the caller's own transaction, as the application role: a workspace's plan and its
 * overrides are two small indexed reads, and doing them in the request's transaction means the answer
 * and the work it permits see the same moment. Nothing is cached, so withdrawing a feature takes
 * effect on the next request; the places that ask are creation endpoints, not hot paths. If that
 * changes, the cache belongs here and nowhere else.
 *
 * **Enforced in the API**, never only by hiding a button (CLAUDE.md §9). Ask *after* `can()`: a person
 * who may not do something is told so (403) before they learn anything about the plan (402).
 *
 * The application role can only read the overrides. The operator writes them
 * (`EntitlementsOperator`), and no request path reaches that class.
 */
@Injectable()
export class EntitlementsService {
  constructor(@Inject(API_ENV_TOKEN) private readonly env: ApiEnv) {}

  async forTenant(tx: Tx, tenantId: string): Promise<Entitlements> {
    const [tenant] = await tx
      .select({ plan: tenants.plan })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    // No visible workspace row means the session names none it may read: nothing is included.
    const plan = tenant?.plan ?? '';

    const overrides = await tx
      .select({ feature: tenantEntitlements.feature, enabled: tenantEntitlements.enabled })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenantId));

    return resolveEntitlements({ mode: this.env.DEPLOYMENT_MODE, plan, overrides });
  }

  async has(tx: Tx, tenantId: string, feature: Feature): Promise<boolean> {
    return (await this.forTenant(tx, tenantId)).has(feature);
  }

  /** Refuse with 402 `ENTITLEMENT_REQUIRED` unless the workspace has the feature. */
  async require(tx: Tx, tenantId: string, feature: Feature): Promise<void> {
    if (!(await this.has(tx, tenantId, feature))) throw new EntitlementRequiredError(feature);
  }
}
