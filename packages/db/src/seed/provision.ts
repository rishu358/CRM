import { newId, PURGE_SWEEP_INTERVAL_HOURS } from '@crm/core';
import type { Tx } from '../client.js';
import { sql } from 'drizzle-orm';
import {
  fieldDefinitions,
  outboxEvents,
  pipelineStages,
  pipelines,
  rolePermissions,
  roles,
} from '../schema/index.js';
import { SYSTEM_FIELDS_BY_OBJECT } from './fields.js';
import { DEFAULT_PIPELINE } from './pipelines.js';
import { SYSTEM_ROLES } from './roles.js';

/**
 * Give a new tenant its default roles, grants and field metadata.
 *
 * Runs inside the caller's transaction so that creating a tenant and equipping
 * it either both happen or neither does. A half-provisioned tenant would have
 * users who can sign in and then be denied everything, which is worse than a
 * failed signup.
 *
 * Must be called inside `withTenant` for the tenant being provisioned: every
 * insert below is subject to RLS.
 */
export interface ProvisionResult {
  readonly roleIdsByName: ReadonlyMap<string, string>;
  /** The pipeline a new deal lands in when none is named. */
  readonly defaultPipelineId: string;
}

export async function provisionTenantDefaults(
  tx: Tx,
  tenantId: string,
  actorId: string | null,
): Promise<ProvisionResult> {
  const roleIdsByName = new Map<string, string>();

  for (const definition of SYSTEM_ROLES) {
    const roleId = newId();
    roleIdsByName.set(definition.name, roleId);

    await tx.insert(roles).values({
      id: roleId,
      tenantId,
      name: definition.name,
      description: definition.description,
      isSystem: true,
      createdBy: actorId,
      updatedBy: actorId,
    });

    const grantRows = definition.grants.flatMap((grant) =>
      grant.actions.map((action) => ({
        id: newId(),
        tenantId,
        roleId,
        objectType: grant.objectType,
        action,
        scope: grant.scope,
        createdBy: actorId,
        updatedBy: actorId,
      })),
    );

    if (grantRows.length > 0) {
      await tx.insert(rolePermissions).values(grantRows);
    }
  }

  const fieldRows = Object.entries(SYSTEM_FIELDS_BY_OBJECT).flatMap(([objectType, fields]) =>
    fields.map((field) => ({
      id: newId(),
      tenantId,
      objectType,
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      isUnique: false,
      options: field.options ?? null,
      validation: field.validation ?? null,
      defaultValue: null,
      position: field.position,
      isSystem: true,
      isActive: field.isActive,
      createdBy: actorId,
      updatedBy: actorId,
    })),
  );

  if (fieldRows.length > 0) {
    await tx.insert(fieldDefinitions).values(fieldRows);
  }

  // A tenant with no pipeline cannot create a single deal, so this belongs with
  // the roles rather than being something an admin has to remember to add.
  const defaultPipelineId = newId();
  await tx.insert(pipelines).values({
    id: defaultPipelineId,
    tenantId,
    name: DEFAULT_PIPELINE.name,
    position: 0,
    isDefault: true,
    createdBy: actorId,
    updatedBy: actorId,
  });
  await tx.insert(pipelineStages).values(
    DEFAULT_PIPELINE.stages.map((stage, index) => ({
      id: newId(),
      tenantId,
      pipelineId: defaultPipelineId,
      name: stage.name,
      position: (index + 1) * 10,
      probability: stage.probability,
      stageType: stage.stageType,
      createdBy: actorId,
      updatedBy: actorId,
    })),
  );

  // Arm the Recycle Bin purge sweep (MVP_SPEC M4).
  //
  // The sweep is an outbox row dated to when it is next due, and its handler
  // arms the following one, so this single insert is the whole schedule for
  // this tenant for as long as it exists (ADR-0025, ADR-0034). A partial unique
  // index keeps it at one pending row per tenant, which is also what makes
  // re-provisioning harmless.
  //
  // Dated by the database's clock, because that is the clock the relay compares
  // `available_at` against.
  await tx
    .insert(outboxEvents)
    .values({
      id: newId(),
      tenantId,
      eventType: 'recycle_bin.sweep_due.v1',
      objectType: 'tenant',
      recordId: tenantId,
      availableAt: sql`now() + make_interval(hours => ${PURGE_SWEEP_INTERVAL_HOURS})`,
      actorId: actorId,
    })
    .onConflictDoNothing();

  return { roleIdsByName, defaultPipelineId };
}

export { SYSTEM_ROLES, FOUNDING_ROLE_NAME, DEFAULT_INVITE_ROLE_NAME } from './roles.js';
export {
  SYSTEM_FIELDS_BY_OBJECT,
  CONTACT_SYSTEM_FIELDS,
  ACCOUNT_SYSTEM_FIELDS,
  LEAD_SYSTEM_FIELDS,
} from './fields.js';
