import { Inject, Injectable } from '@nestjs/common';
import { compilePermissions, ForbiddenError, type Actor, type Uuid } from '@crm/core';
import type { FieldPermissionRow, RolePermissionRow } from '@crm/core';
import { DatabaseService } from '../database/database.service.js';
import { sql } from '@crm/db';

/**
 * Builds the Actor that `can()` reasons about (ADR-0008).
 *
 * Every value is read from the database inside a tenant-scoped transaction.
 * Nothing comes from the request body, a query parameter or a header
 * (CLAUDE.md §5.2) — an Actor assembled from client input would defeat the
 * entire permission engine, so this is the only place Actors are made.
 *
 * Membership is what proves the user belongs to the tenant at all. A user who
 * has a valid session but no active membership is refused here, which is why a
 * stale session cannot outlive someone being removed from a company.
 */
@Injectable()
export class ActorService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async resolve(userId: string, tenantId: string): Promise<Actor> {
    return this.database.runInTenant({ tenantId, userId }, async (tx) => {
      const membership = (
        await tx.execute(sql`
          select role_id
          from memberships
          where user_id = ${userId}
            and tenant_id = ${tenantId}
            and status = 'active'
          limit 1
        `)
      ).rows as unknown as { role_id: string }[];

      const roleId = membership[0]?.role_id;
      if (roleId === undefined) {
        // Indistinguishable from "tenant does not exist", because RLS returned
        // nothing either way. Nothing here reveals whether the tenant is real.
        throw new ForbiddenError('You do not have access to this workspace');
      }

      // Sequential, not Promise.all: a transaction is a single connection, and
      // issuing concurrent queries on one pg client is deprecated and will throw
      // in pg 9. They are three indexed lookups on small tables, so the saving
      // would have been negligible anyway.
      const grants = await tx.execute(sql`
        select role_id, object_type, action, scope
        from role_permissions
        where role_id = ${roleId}
      `);
      const fieldRules = await tx.execute(sql`
        select role_id, object_type, field_key, access
        from field_permissions
        where role_id = ${roleId}
      `);
      const teams = await tx.execute(sql`
        select team_id from team_members where user_id = ${userId}
      `);

      const rolePermissions = (
        grants.rows as unknown as {
          role_id: string;
          object_type: string;
          action: string;
          scope: string;
        }[]
      ).map(
        (row) =>
          ({
            roleId: row.role_id,
            objectType: row.object_type,
            action: row.action,
            scope: row.scope,
          }) as RolePermissionRow,
      );

      const fieldPermissions = (
        fieldRules.rows as unknown as {
          role_id: string;
          object_type: string;
          field_key: string;
          access: string;
        }[]
      ).map(
        (row) =>
          ({
            roleId: row.role_id,
            objectType: row.object_type,
            fieldKey: row.field_key,
            access: row.access,
          }) as FieldPermissionRow,
      );

      const teamIds = (teams.rows as unknown as { team_id: string }[]).map(
        (row) => row.team_id as Uuid,
      );

      return {
        userId: userId as Uuid,
        tenantId: tenantId as Uuid,
        teamIds,
        permissions: compilePermissions(rolePermissions, fieldPermissions),
      } satisfies Actor;
    });
  }
}
