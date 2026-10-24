import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  isFeature,
  isUuid,
  isPlan,
  newId,
  NotFoundError,
  resolveEntitlements,
  ValidationError,
  type Feature,
} from '@crm/core';
import { and, eq, tenantEntitlements, tenants, type Tx } from '@crm/db';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';

export interface WorkspaceEntitlements {
  readonly slug: string;
  readonly name: string;
  readonly plan: string;
  /** Whether the plan is one the catalogue knows; a value it does not know includes nothing. */
  readonly planKnown: boolean;
  readonly overrides: readonly {
    readonly feature: string;
    readonly enabled: boolean;
    readonly reason: string;
  }[];
  readonly effective: Readonly<Record<Feature, boolean>>;
}

/**
 * What the operator can do to a workspace's entitlements (ADR-0047): choose its plan, and switch a
 * feature on or off for it with a reason.
 *
 * Runs as the auth role (`crm_auth`), the only role that can write `tenant_entitlements` or a
 * workspace's `plan`. **No controller injects this class.** It is reached from the operator command
 * (`pnpm tenant:entitlements`) and from tests, so a request can never grant a workspace a feature,
 * whatever bug it carries.
 */
@Injectable()
export class EntitlementsOperator {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  show(slug: string): Promise<WorkspaceEntitlements> {
    return this.database.runAsAuth(async (tx) => this.describe(tx, await this.workspace(tx, slug)));
  }

  /** Move a workspace to a plan the catalogue knows. A mistyped plan would include nothing. */
  async setPlan(slug: string, plan: string): Promise<WorkspaceEntitlements> {
    if (!isPlan(plan)) {
      throw new ValidationError([{ path: 'plan', message: `Unknown plan "${plan}"` }]);
    }
    return this.database.runAsAuth(async (tx) => {
      const found = await this.workspace(tx, slug);
      await tx.update(tenants).set({ plan, updatedAt: new Date() }).where(eq(tenants.id, found.id));
      return this.describe(tx, { ...found, plan });
    });
  }

  /** Switch one feature on or off for one workspace, whatever its plan says. Replaces any earlier decision. */
  async setOverride(
    slug: string,
    feature: string,
    enabled: boolean,
    reason: string,
  ): Promise<WorkspaceEntitlements> {
    if (!isFeature(feature)) {
      throw new ValidationError([{ path: 'feature', message: `Unknown feature "${feature}"` }]);
    }
    const why = reason.trim();
    if (why === '' || why.length > 500) {
      throw new ValidationError([
        {
          path: 'reason',
          message: 'Say why, in 1 to 500 characters: an exception nobody can explain gets lost',
        },
      ]);
    }
    return this.database.runAsAuth(async (tx) => {
      const found = await this.workspace(tx, slug);
      if (this.env.DEPLOYMENT_MODE === 'single_tenant') {
        // Not an error that corrupts anything, but a decision that would silently do nothing: say so.
        throw new ConflictError(
          'This installation is single-tenant, where every feature is on. An override would have no effect.',
        );
      }
      const now = new Date();
      await tx
        .insert(tenantEntitlements)
        .values({
          id: newId(),
          tenantId: found.id,
          feature,
          enabled,
          reason: why,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [tenantEntitlements.tenantId, tenantEntitlements.feature],
          set: { enabled, reason: why, updatedAt: now },
        });
      return this.describe(tx, found);
    });
  }

  /** Remove a workspace's exception, so its plan decides again. */
  async clearOverride(slug: string, feature: string): Promise<WorkspaceEntitlements> {
    if (!isFeature(feature)) {
      throw new ValidationError([{ path: 'feature', message: `Unknown feature "${feature}"` }]);
    }
    return this.database.runAsAuth(async (tx) => {
      const found = await this.workspace(tx, slug);
      const removed = await tx
        .delete(tenantEntitlements)
        .where(
          and(eq(tenantEntitlements.tenantId, found.id), eq(tenantEntitlements.feature, feature)),
        )
        .returning({ id: tenantEntitlements.id });
      if (removed.length === 0) {
        throw new NotFoundError(`Override for ${feature}`);
      }
      return this.describe(tx, found);
    });
  }

  private async workspace(
    tx: Tx,
    slug: string,
  ): Promise<{ id: string; slug: string; name: string; plan: string }> {
    const [found] = await tx
      .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, plan: tenants.plan })
      .from(tenants)
      .where(isUuid(slug) ? eq(tenants.id, slug) : eq(tenants.slug, slug))
      .limit(1);
    if (found === undefined) throw new NotFoundError('Workspace');
    return found;
  }

  private async describe(
    tx: Tx,
    found: { id: string; slug: string; name: string; plan: string },
  ): Promise<WorkspaceEntitlements> {
    const overrides = await tx
      .select({
        feature: tenantEntitlements.feature,
        enabled: tenantEntitlements.enabled,
        reason: tenantEntitlements.reason,
      })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, found.id))
      .orderBy(tenantEntitlements.feature);

    return {
      slug: found.slug,
      name: found.name,
      plan: found.plan,
      planKnown: isPlan(found.plan),
      overrides,
      effective: resolveEntitlements({
        mode: this.env.DEPLOYMENT_MODE,
        plan: found.plan,
        overrides,
      }).snapshot(),
    };
  }
}
