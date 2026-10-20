import { ACTIONS, FIELD_ACCESS_LEVELS, OBJECT_TYPES, SCOPES } from '@crm/core';
import { z } from 'zod';

/**
 * Users, roles, teams, ownership and the access explainer (MVP_SPEC M3,
 * ADR-0033).
 *
 * Every request object is `.strict()` (CLAUDE.md §5.6). Note what is absent
 * from all of them: no tenant id, no acting user. Those come from the session.
 * A role id, a user id or a team id in a body is only ever a *reference*, and
 * is resolved under row-level security, so an id from another workspace reads
 * as absent.
 */

// ---------------------------------------------------------------------------
// Vocabulary shared with the engine
// ---------------------------------------------------------------------------

export const accessObjectSchema = z.enum(OBJECT_TYPES);
export const accessActionSchema = z.enum(ACTIONS);
export const accessScopeSchema = z.enum(SCOPES);
export const fieldAccessSchema = z.enum(FIELD_ACCESS_LEVELS);

/** The objects that have an owner, and so can be reassigned and explained. */
export const OWNED_OBJECTS = ['account', 'contact', 'lead', 'deal', 'activity'] as const;
export const ownedObjectSchema = z.enum(OWNED_OBJECTS);
export type OwnedObject = z.infer<typeof ownedObjectSchema>;

/** The `field_definitions` key space: snake_case, as the serializers check it. */
const fieldKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

// ---------------------------------------------------------------------------
// The grant catalogue: what the role editor renders
// ---------------------------------------------------------------------------

export const catalogueFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
});

export const catalogueObjectSchema = z.object({
  objectType: accessObjectSchema,
  kind: z.enum(['record', 'administrative']),
  /** The actions it makes sense to grant. */
  actions: z.array(accessActionSchema),
  /** The scopes a grant may take. Administrative objects only have `all`. */
  scopes: z.array(accessScopeSchema),
  /** Per-field rules apply to record objects only. */
  fields: z.array(catalogueFieldSchema),
});

export const catalogueSchema = z.object({ objects: z.array(catalogueObjectSchema) });
export type AccessCatalogue = z.infer<typeof catalogueSchema>;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const roleParamsSchema = z.object({ id: z.uuid() }).strict();

export const roleSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  grantCount: z.number().int().nonnegative(),
});
export type RoleSummary = z.infer<typeof roleSummarySchema>;

export const roleGrantSchema = z.object({
  objectType: accessObjectSchema,
  action: accessActionSchema,
  scope: accessScopeSchema,
});
export type RoleGrant = z.infer<typeof roleGrantSchema>;

export const fieldRuleSchema = z.object({
  objectType: accessObjectSchema,
  fieldKey: z.string(),
  access: fieldAccessSchema,
});
export type FieldRule = z.infer<typeof fieldRuleSchema>;

export const roleDetailSchema = roleSummarySchema.extend({
  grants: z.array(roleGrantSchema),
  fieldRules: z.array(fieldRuleSchema),
  /**
   * A fingerprint of the role's permissions as they are now.
   *
   * Sent back with a change so that what an administrator **previewed** is what
   * gets saved: if another administrator edited the role in between, the digest
   * no longer matches and the save is refused rather than applied to a state
   * nobody looked at.
   */
  digest: z.string(),
});
export type RoleDetail = z.infer<typeof roleDetailSchema>;

export const roleCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullish(),
    /** Start from another role's permissions rather than from nothing. */
    copyFromRoleId: z.uuid().nullish(),
  })
  .strict();
export type RoleCreateInput = z.infer<typeof roleCreateSchema>;

export const roleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'Provide a name or a description',
  });
export type RoleUpdateInput = z.infer<typeof roleUpdateSchema>;

/**
 * A proposed change to a role's permissions, as a **patch**.
 *
 * Cells, not the whole matrix: a grant with `scope: null` removes it, a field
 * rule with `access: null` removes the rule (the field inherits from the object
 * grant). Patching means saving one cell cannot quietly delete a row the
 * screen did not know to show, and the audit entry records exactly the cells
 * that moved.
 */
export const permissionPatchSchema = z
  .object({
    grants: z
      .array(
        z
          .object({
            objectType: accessObjectSchema,
            action: accessActionSchema,
            scope: accessScopeSchema.nullable(),
          })
          .strict(),
      )
      .max(300)
      .default([]),
    fieldRules: z
      .array(
        z
          .object({
            objectType: accessObjectSchema,
            fieldKey: fieldKeySchema,
            access: fieldAccessSchema.nullable(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict()
  .refine((value) => value.grants.length + value.fieldRules.length > 0, {
    message: 'Propose at least one change',
  });
export type PermissionPatch = z.infer<typeof permissionPatchSchema>;

export const permissionApplySchema = z
  .object({
    grants: permissionPatchSchema.shape.grants,
    fieldRules: permissionPatchSchema.shape.fieldRules,
    /** The `digest` the preview was computed against. */
    expectedDigest: z.string().min(8).max(128),
  })
  .strict()
  .refine((value) => value.grants.length + value.fieldRules.length > 0, {
    message: 'Propose at least one change',
  });
export type PermissionApplyInput = z.infer<typeof permissionApplySchema>;

// ---------------------------------------------------------------------------
// The effect of a change (shown **before** it is saved)
// ---------------------------------------------------------------------------

export const effectDirectionSchema = z.enum(['granted', 'revoked', 'widened', 'narrowed']);

export const effectScopeChangeSchema = z.object({
  objectType: accessObjectSchema,
  action: accessActionSchema,
  before: accessScopeSchema.nullable(),
  after: accessScopeSchema.nullable(),
  direction: effectDirectionSchema,
  /**
   * How many records this person could act on before and after, and the
   * difference. `null` when the count is not available to you — counts are
   * information about records, so you only get them for objects you can read
   * in full yourself.
   */
  recordsBefore: z.number().int().nonnegative().nullable(),
  recordsAfter: z.number().int().nonnegative().nullable(),
  recordsLost: z.number().int().nonnegative().nullable(),
  recordsGained: z.number().int().nonnegative().nullable(),
});

export const effectFieldChangeSchema = z.object({
  objectType: accessObjectSchema,
  fieldKey: z.string(),
  fieldLabel: z.string(),
  before: fieldAccessSchema,
  after: fieldAccessSchema,
});

export const effectPersonSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  scopeChanges: z.array(effectScopeChangeSchema),
  fieldChanges: z.array(effectFieldChangeSchema),
});

export const effectSummarySchema = z.object({
  objectType: accessObjectSchema,
  action: accessActionSchema,
  direction: effectDirectionSchema,
  peopleAffected: z.number().int().positive(),
  /** The most any one person loses. */
  recordsLostMax: z.number().int().nonnegative().nullable(),
  /** Summed over people: "record-views" removed. */
  recordViewsLost: z.number().int().nonnegative().nullable(),
  recordsGainedMax: z.number().int().nonnegative().nullable(),
  recordViewsGained: z.number().int().nonnegative().nullable(),
});

export const effectPreviewSchema = z.object({
  subject: z.object({
    kind: z.enum(['role', 'member']),
    id: z.uuid(),
    name: z.string(),
  }),
  /** The role's digest now; send it back with the change. */
  digest: z.string(),
  /** People whose access actually changes. */
  people: z.array(effectPersonSchema),
  /** People the change was aimed at whose access does not change. */
  unaffectedCount: z.number().int().nonnegative(),
  summary: z.array(effectSummarySchema),
  /** True when saving would leave nobody able to manage roles and members. */
  removesLastAdministrator: z.boolean(),
  /** Proposed grants wider than you hold yourself. Saving is refused while any remain. */
  beyondYourAccess: z.array(roleGrantSchema),
});
export type EffectPreview = z.infer<typeof effectPreviewSchema>;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const memberParamsSchema = z.object({ userId: z.uuid() }).strict();

export const memberListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict();
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

export const memberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  roleId: z.uuid(),
  roleName: z.string(),
  status: z.enum(['active', 'suspended']),
  teams: z.array(z.object({ id: z.uuid(), name: z.string() })),
  joinedAt: z.string().nullable(),
  isYou: z.boolean(),
});
export type Member = z.infer<typeof memberSchema>;

export const memberUpdateSchema = z
  .object({
    roleId: z.uuid().optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict()
  .refine((value) => value.roleId !== undefined || value.status !== undefined, {
    message: 'Provide a role or a status',
  });
export type MemberUpdateInput = z.infer<typeof memberUpdateSchema>;

export const memberRolePreviewSchema = z.object({ roleId: z.uuid() }).strict();

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export const teamParamsSchema = z.object({ id: z.uuid() }).strict();

export const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  parentTeamId: z.uuid().nullable(),
  members: z.array(z.object({ userId: z.uuid(), name: z.string(), email: z.string() })),
});
export type Team = z.infer<typeof teamSchema>;

export const teamCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    parentTeamId: z.uuid().nullish(),
  })
  .strict();
export type TeamCreateInput = z.infer<typeof teamCreateSchema>;

export const teamUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    parentTeamId: z.uuid().nullish(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.parentTeamId !== undefined, {
    message: 'Provide a name or a parent team',
  });
export type TeamUpdateInput = z.infer<typeof teamUpdateSchema>;

/** The whole membership of a team, set at once. */
export const teamMembersSchema = z
  .object({ userIds: z.array(z.uuid()).max(500) })
  .strict();
export type TeamMembersInput = z.infer<typeof teamMembersSchema>;

// ---------------------------------------------------------------------------
// Ownership and reassignment
// ---------------------------------------------------------------------------

export const REASSIGN_MAX_RECORDS = 500;
export const REASSIGN_MAX_PER_OBJECT = 2000;

/**
 * Move records to a new owner, one at a time, in a handful, or all of one
 * person's (MVP_SPEC M3 — "single and bulk").
 *
 * `records` names the records; `owner` names a person whose records move, for
 * when somebody leaves. Neither can name a record the caller may not update:
 * such records are skipped, and the count says how many, without saying why.
 */
export const reassignSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('records'),
      objectType: ownedObjectSchema,
      recordIds: z.array(z.uuid()).min(1).max(REASSIGN_MAX_RECORDS),
      toOwnerId: z.uuid(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('owner'),
      fromOwnerId: z.uuid(),
      objectTypes: z.array(ownedObjectSchema).min(1).max(OWNED_OBJECTS.length).optional(),
      toOwnerId: z.uuid(),
    })
    .strict(),
]);
export type ReassignInput = z.infer<typeof reassignSchema>;

export const reassignPreviewSchema = z.object({
  toOwner: z.object({ userId: z.uuid(), name: z.string() }),
  items: z.array(
    z.object({
      objectType: ownedObjectSchema,
      /** Records that would change owner. */
      willMove: z.number().int().nonnegative(),
      /** Named records that will not move: out of your reach, gone, or already theirs. */
      skipped: z.number().int().nonnegative(),
    }),
  ),
});
export type ReassignPreview = z.infer<typeof reassignPreviewSchema>;

export const reassignResultSchema = z.object({
  moved: z.array(z.object({ objectType: ownedObjectSchema, count: z.number().int().nonnegative() })),
  skipped: z.number().int().nonnegative(),
  /** More left to move than one request handles; call again. */
  remaining: z.number().int().nonnegative(),
});
export type ReassignResult = z.infer<typeof reassignResultSchema>;

// ---------------------------------------------------------------------------
// The explainer
// ---------------------------------------------------------------------------

/**
 * Why somebody can or cannot reach a record.
 *
 * Stable codes, not sentences: the words live in the web app's i18n layer, and
 * a translator improving a phrase must not be an API change.
 */
export const accessBasisSchema = z.enum([
  'owner',
  'shared_team',
  'all_records',
  'no_grant',
  'not_owner',
  'no_shared_team',
  'unowned',
]);
export type AccessBasis = z.infer<typeof accessBasisSchema>;

export const recordAccessParamsSchema = z
  .object({ objectType: ownedObjectSchema, id: z.uuid() })
  .strict();

export const recordAccessPersonSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  roleId: z.uuid(),
  roleName: z.string(),
  /** Whether they can open this record. */
  allowed: z.boolean(),
  scope: accessScopeSchema.nullable(),
  basis: accessBasisSchema,
  /** The team that makes it visible, when that is the reason. */
  sharedTeamName: z.string().nullable(),
  /**
   * Of the fields **you** can read, the ones this person cannot. Present only
   * when they can open the record. Everything not listed here or in
   * `readOnlyFields` is writable by them.
   */
  hiddenFields: z.array(z.string()),
  readOnlyFields: z.array(z.string()),
});

export const recordAccessSchema = z.object({
  objectType: ownedObjectSchema,
  id: z.uuid(),
  /** `name` is null when the owner is no longer a member of this workspace. */
  owner: z.object({ userId: z.uuid(), name: z.string().nullable() }).nullable(),
  /** The fields you can read, which is all the explainer will talk about. */
  fields: z.array(catalogueFieldSchema),
  people: z.array(recordAccessPersonSchema),
  /** More people than one response carries. */
  truncated: z.boolean(),
});
export type RecordAccess = z.infer<typeof recordAccessSchema>;

export const reachActionSchema = z.object({
  action: accessActionSchema,
  allowed: z.boolean(),
  scope: accessScopeSchema.nullable(),
  /** The role that grants it. */
  viaRoleName: z.string().nullable(),
});

export const reachFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  access: fieldAccessSchema,
  /** Why it is not fully available: the object grant, or a rule on this field. */
  narrowedBy: z.enum(['object', 'field_rule']).nullable(),
});

export const reachObjectSchema = z.object({
  objectType: accessObjectSchema,
  kind: z.enum(['record', 'administrative']),
  actions: z.array(reachActionSchema),
  /** How many records `read` reaches. `null` for roles, and where you cannot count. */
  readableRecords: z.number().int().nonnegative().nullable(),
  fields: z.array(reachFieldSchema),
});

export const reachSchema = z.object({
  subject: z.object({
    kind: z.enum(['member', 'role']),
    id: z.uuid(),
    name: z.string(),
    roleName: z.string().nullable(),
  }),
  objects: z.array(reachObjectSchema),
});
export type Reach = z.infer<typeof reachSchema>;

export const reachMemberParamsSchema = z.object({ userId: z.uuid() }).strict();
export const reachRoleParamsSchema = z.object({ id: z.uuid() }).strict();
