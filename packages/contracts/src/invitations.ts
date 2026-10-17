import { emailSchema, passwordSchema } from '@crm/core/auth';
import { z } from 'zod';

/**
 * Team invitation contracts (MVP_SPEC M2, ADR-0007, ADR-0019).
 *
 * Note what is **not** in any request here: no tenant id and no role name. The
 * workspace an invitation joins and the role it confers live on the
 * invitation's own row and are read from there at acceptance (CLAUDE.md §5.2).
 * A token that could be redeemed into a workspace or a role named by the
 * caller would not be an invitation, it would be a self-service admin button.
 *
 * Every object is `.strict()`, so a body carrying `tenantId`, `roleId` or
 * `status` on the accept call is a 422 rather than something quietly ignored.
 */

/** `{workspaceId}.{secret}` — see `generateInvitationToken` in @crm/core. */
export const invitationTokenSchema = z.string().min(40).max(512);

export const invitationCreateSchema = z
  .object({
    email: emailSchema,
    /** A role in the inviting workspace. Checked against it under RLS. */
    roleId: z.uuid(),
  })
  .strict();

export type InvitationCreateInput = z.infer<typeof invitationCreateSchema>;

export const invitationParamsSchema = z.object({ id: z.uuid() }).strict();

/**
 * Pending invitations are bounded by their nature — a workspace has a handful
 * at a time, not a million — so this is a capped list rather than a keyset
 * page. If that ever stops being true it gets the same cursor contacts uses
 * (ADR-0012); what it must never get is an OFFSET.
 */
export const invitationListQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

export type InvitationListQuery = z.infer<typeof invitationListQuerySchema>;

/**
 * One row of the admin list.
 *
 * Carries no token and no digest: this list is readable by every
 * administrator, and an invitation token is a key to a seat in the workspace.
 * Resending is therefore re-inviting, which mints a fresh token and retires
 * the old one.
 */
export const invitationSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  roleId: z.uuid(),
  roleName: z.string(),
  invitedByName: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export type InvitationSummary = z.infer<typeof invitationSummarySchema>;

/**
 * A role somebody may be invited as.
 *
 * Every role in the workspace, including Owner. An administrator who can
 * invite can already do everything that role could, so withholding it from
 * the list would be theatre rather than a control — and it would make handing
 * over a company to its new owner impossible without a database console.
 *
 * Served by the invitations module because the invite form is the only screen
 * that needs it. It moves to the roles module when M3 builds one.
 */
export const invitationRoleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
});

export type InvitationRole = z.infer<typeof invitationRoleSchema>;

/**
 * What the acceptance screen is told about a link before anything is consumed.
 *
 * `requiresAccount` and `signedInAs` tell the page which of the three states
 * to render. Both are shown only to somebody holding a token that was mailed
 * to the address in question, so neither is a user-enumeration oracle: the
 * person who chose the address — the inviter — never sees the token, and the
 * person who has the token already controls that mailbox (ADR-0019).
 */
export const invitationPreviewSchema = z.object({
  workspaceName: z.string(),
  email: z.string(),
  roleName: z.string(),
  /** True when the invited address has no account and must create one. */
  requiresAccount: z.boolean(),
  /** The address of the current session, when there is one. */
  signedInAs: z.string().nullable(),
  /** True when accepting right now would succeed. */
  canAccept: z.boolean(),
});

export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/**
 * Accept an invitation.
 *
 * `name` and `password` appear together or not at all: they are the new
 * account the invited address does not yet have. When the address already has
 * one, acceptance happens from that account's session and this body is the
 * token alone.
 */
export const invitationAcceptSchema = z
  .object({
    token: invitationTokenSchema,
    name: z.string().trim().min(1).max(120).optional(),
    password: passwordSchema.optional(),
  })
  .strict()
  .refine((value) => (value.name === undefined) === (value.password === undefined), {
    message: 'Provide both a name and a password, or neither',
    path: ['password'],
  });

export type InvitationAcceptInput = z.infer<typeof invitationAcceptSchema>;

/**
 * The outcome of accepting.
 *
 * `token` is present only when a brand-new account was created, because that
 * is the only path on which an emailed link produces a session (ADR-0019). The
 * browser never reads it: the web app's `/api/session` route turns it into an
 * httpOnly cookie before the page sees a response.
 */
export const invitationAcceptResultSchema = z.object({
  tenantId: z.uuid(),
  workspaceName: z.string(),
  token: z.string().optional(),
});

export type InvitationAcceptResult = z.infer<typeof invitationAcceptResultSchema>;
