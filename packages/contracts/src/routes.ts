import { ErrorCode } from '@crm/core';
import { z } from 'zod';

import { listMetaSchema } from './envelope.js';
import {
  acceptedSchema,
  changePasswordSchema,
  currentUserSchema,
  forgotPasswordSchema,
  googleCallbackQuerySchema,
  healthStatusSchema,
  mfaActivateSchema,
  mfaDisableSchema,
  mfaEnrolmentSchema,
  mfaStatusSchema,
  mfaVerifySchema,
  resendVerificationSchema,
  resetPasswordSchema,
  revokedSessionsSchema,
  sessionRevokeQuerySchema,
  sessionSummarySchema,
  signInResultSchema,
  signInSchema,
  signUpSchema,
  verifyEmailSchema,
} from './auth.js';
import {
  accountCreateSchema,
  accountDeleteQuerySchema,
  accountListQuerySchema,
  accountParamsSchema,
  accountSchema,
  accountUpdateSchema,
} from './accounts.js';
import {
  activityCreateSchema,
  activityDeleteQuerySchema,
  activityLinkSchema,
  activityListQuerySchema,
  activityParamsSchema,
  activitySchema,
  activityUnlinkQuerySchema,
  activityUpdateSchema,
  myDayQuerySchema,
  myDaySchema,
  recordViewCreateSchema,
} from './activities.js';
import {
  contactCreateSchema,
  contactDeleteQuerySchema,
  contactListQuerySchema,
  contactParamsSchema,
  contactSchema,
  contactUpdateSchema,
} from './contacts.js';
import {
  dealBoardQuerySchema,
  dealBoardSchema,
  dealCreateSchema,
  dealDeleteQuerySchema,
  dealListQuerySchema,
  dealParamsSchema,
  dealSchema,
  dealUpdateSchema,
  pipelineSchema,
} from './deals.js';
import {
  invitationAcceptQuerySchema,
  invitationAcceptResultSchema,
  invitationAcceptSchema,
  invitationCreateSchema,
  invitationListQuerySchema,
  invitationParamsSchema,
  invitationPreviewSchema,
  invitationRoleSchema,
  invitationSummarySchema,
} from './invitations.js';
import {
  duplicateCheckSchema,
  duplicateMatchSchema,
  leadConversionResultSchema,
  leadConvertSchema,
  leadCreateSchema,
  leadDeleteQuerySchema,
  leadListQuerySchema,
  leadParamsSchema,
  leadSchema,
  leadUpdateSchema,
} from './leads.js';
import {
  markAllReadSchema,
  notificationListQuerySchema,
  notificationParamsSchema,
  notificationSchema,
  unreadCountSchema,
} from './notifications.js';

/**
 * The route registry: one entry per endpoint the API actually serves.
 *
 * It lives beside the schemas it points at so the two move together, and it
 * exists because OpenAPI needs facts Zod cannot know — which schema validates
 * which part of which request, and what a handler returns.
 *
 * **This list is hand-maintained, so on its own it would rot.** It does not,
 * because `apps/api/src/openapi/route-drift.spec.ts` enumerates the routes
 * Fastify has actually registered and fails when they and this list disagree
 * in either direction. A new endpoint with no entry here fails the build; an
 * entry here with no endpoint fails it too. Keeping this file current is
 * therefore not a matter of discipline.
 *
 * It documents; it decides nothing. Authentication, tenancy and permissions
 * are enforced in the guards, the services and the serializers, and nothing
 * here is read at request time. An endpoint must never be written against
 * this file (ADR-0027).
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Whether a route can be reached without a session.
 *
 * `public` does not mean unauthenticated in the looser sense: `/invitations/
 * accept` and the password-reset pair all carry a one-time token that *is* the
 * credential (ADR-0019). It means only that the global `AuthGuard` does not
 * demand a session cookie or bearer token, which is a fact about the route
 * that the document has to state correctly.
 */
export type RouteAuth = 'session' | 'public';

/** The success response, before the `{ data, meta }` envelope is applied. */
export type RouteResponse =
  | {
      /** No body at all: 204, or a 302 redirect. */
      readonly kind: 'empty';
      readonly status: 204 | 302;
      readonly description: string;
    }
  | {
      /** `{ data: <schema>, meta?: … }`. */
      readonly kind: 'object';
      readonly status: number;
      readonly description: string;
      /** Component name for the whole response body. */
      readonly name: string;
      readonly data: z.ZodType;
      /** Extra `meta`, when the handler returns more than the envelope's. */
      readonly meta?: z.ZodType;
    }
  | {
      /** `{ data: <schema>[], meta: ListMeta }` — a keyset page (ADR-0012). */
      readonly kind: 'list';
      readonly status: number;
      readonly description: string;
      readonly name: string;
      readonly data: z.ZodType;
      /** Replaces the default `ListMeta` when a list carries more. */
      readonly meta?: z.ZodType;
    }
  | {
      /**
       * A body that is deliberately not enveloped.
       *
       * Only `/openapi.json`, which has to be an OpenAPI document because that
       * is what every piece of tooling reads.
       */
      readonly kind: 'raw';
      readonly status: number;
      readonly description: string;
      readonly contentType: string;
    };

export interface RouteDefinition {
  readonly method: HttpMethod;
  /**
   * OpenAPI-style and relative to the `/api/v1` server base: `/contacts/{id}`.
   * The drift test converts Fastify's `:id` form to this one before comparing.
   */
  readonly path: string;
  readonly operationId: string;
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  readonly auth: RouteAuth;
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: { readonly name: string; readonly schema: z.ZodType };
  readonly response: RouteResponse;
  /**
   * Failures *particular to this route*. The generator adds the ones every
   * route can produce — validation, rate limiting, internal — and the 401/403
   * pair for routes that require a session, so listing them here would be
   * sixty-six copies of the same four lines.
   */
  readonly errors: readonly ErrorCode[];
}

/** A record addressed by id can always be absent or out of scope. */
const RECORD: readonly ErrorCode[] = [ErrorCode.NOT_FOUND];

/** A write that carries `version` can lose the optimistic lock (CLAUDE.md §7). */
const VERSIONED: readonly ErrorCode[] = [ErrorCode.NOT_FOUND, ErrorCode.VERSION_CONFLICT];

/** A write through the field layer can name a field the caller may not write. */
const WRITABLE: readonly ErrorCode[] = [ErrorCode.FIELD_NOT_WRITABLE];

/**
 * The five routes of a standard object (CLAUDE.md §6: list, read, create,
 * update, soft-delete), spelled out once rather than in five near-identical
 * copies per module.
 */
function standardObjectRoutes(object: {
  readonly tag: string;
  readonly plural: string;
  readonly singular: string;
  readonly name: string;
  readonly record: z.ZodType;
  readonly listQuery: z.ZodType;
  readonly params: z.ZodType;
  readonly create: z.ZodType;
  readonly update: z.ZodType;
  readonly deleteQuery: z.ZodType;
  /** Extra failures on create, such as duplicate detection (ADR-0023). */
  readonly createErrors?: readonly ErrorCode[];
  /** The `meta` a create returns, when it returns one — a lead returns its duplicates. */
  readonly createMeta?: z.ZodType;
}): RouteDefinition[] {
  const { plural, singular, name } = object;
  return [
    {
      method: 'GET',
      path: `/${plural}`,
      operationId: `list${name}s`,
      tag: object.tag,
      summary: `List ${plural}`,
      description:
        'Keyset-paginated. `sort`, `filter` and `fields` are validated against the ' +
        "tenant's field metadata, so a custom field is filterable the moment it exists.",
      auth: 'session',
      query: object.listQuery,
      response: {
        kind: 'list',
        status: 200,
        name: `${name}ListResponse`,
        description: `A page of ${plural}.`,
        data: object.record,
      },
      errors: [],
    },
    {
      method: 'GET',
      path: `/${plural}/{id}`,
      operationId: `get${name}`,
      tag: object.tag,
      summary: `Fetch one ${singular}`,
      description:
        'Returns 404, never 403, for a record in another tenant or outside the ' +
        "caller's visibility scope (CLAUDE.md §5.5).",
      auth: 'session',
      params: object.params,
      response: {
        kind: 'object',
        status: 200,
        name: `${name}Response`,
        description: `The ${singular}.`,
        data: object.record,
      },
      errors: RECORD,
    },
    {
      method: 'POST',
      path: `/${plural}`,
      operationId: `create${name}`,
      tag: object.tag,
      summary: `Create a ${singular}`,
      auth: 'session',
      body: { name: `${name}Create`, schema: object.create },
      response: {
        kind: 'object',
        status: 201,
        name: `${name}Response`,
        description: `The created ${singular}.`,
        data: object.record,
        ...(object.createMeta === undefined ? {} : { meta: object.createMeta }),
      },
      errors: [...WRITABLE, ...(object.createErrors ?? [])],
    },
    {
      method: 'PATCH',
      path: `/${plural}/{id}`,
      operationId: `update${name}`,
      tag: object.tag,
      summary: `Update a ${singular}`,
      description:
        '`version` is required: a write against a stale read is refused with 409 ' +
        'rather than silently overwriting someone else (CLAUDE.md §7).',
      auth: 'session',
      params: object.params,
      body: { name: `${name}Update`, schema: object.update },
      response: {
        kind: 'object',
        status: 200,
        name: `${name}Response`,
        description: `The updated ${singular}.`,
        data: object.record,
      },
      errors: [...VERSIONED, ...WRITABLE],
    },
    {
      method: 'DELETE',
      path: `/${plural}/{id}`,
      operationId: `delete${name}`,
      tag: object.tag,
      summary: `Delete a ${singular}`,
      description: 'Soft delete. Carries `version` for the same reason PATCH does.',
      auth: 'session',
      params: object.params,
      query: object.deleteQuery,
      response: { kind: 'empty', status: 204, description: 'Deleted.' },
      errors: VERSIONED,
    },
  ];
}

const healthRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/health',
    operationId: 'liveness',
    tag: 'Health',
    summary: 'Liveness',
    description:
      'The only route in the API with no session (CLAUDE.md §5.3). Deliberately ' +
      'carries no version, hostname or dependency detail.',
    auth: 'public',
    response: {
      kind: 'object',
      status: 200,
      name: 'HealthResponse',
      description: 'The process is up.',
      data: healthStatusSchema,
    },
    errors: [],
  },
  {
    method: 'GET',
    path: '/health/ready',
    operationId: 'readiness',
    tag: 'Health',
    summary: 'Readiness',
    description: '`degraded` when the database is unreachable. Still 200, for the balancer.',
    auth: 'public',
    response: {
      kind: 'object',
      status: 200,
      name: 'HealthResponse',
      description: 'The process is up, and whether it can reach its database.',
      data: healthStatusSchema,
    },
    errors: [],
  },
];

const metaRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/openapi.json',
    operationId: 'openApiDocument',
    tag: 'Meta',
    summary: 'This document',
    description:
      'Generated from the Zod contracts, never hand-written (ADR-0007). Public, ' +
      'because an integrator reads it before they have credentials, and it describes ' +
      'only the shape of a surface the web bundle already names (ADR-0027). It is not ' +
      'wrapped in the `{ data, meta }` envelope: it is an OpenAPI document, and tooling ' +
      'expects the document itself.',
    auth: 'public',
    response: {
      kind: 'raw',
      status: 200,
      contentType: 'application/json',
      description: 'The OpenAPI 3.1 document.',
    },
    errors: [],
  },
];

const authRoutes: RouteDefinition[] = [
  {
    method: 'POST',
    path: '/auth/sign-up',
    operationId: 'signUp',
    tag: 'Authentication',
    summary: 'Create an account and its workspace',
    description:
      'Always 202 with the same body, whether or not the address was already ' +
      'taken: a different answer would turn sign-up into a directory of who banks here.',
    auth: 'public',
    body: { name: 'SignUp', schema: signUpSchema },
    response: {
      kind: 'object',
      status: 202,
      name: 'AcceptedResponse',
      description: 'Accepted. Check the address for a verification link.',
      data: acceptedSchema,
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/auth/resend-verification',
    operationId: 'resendVerification',
    tag: 'Authentication',
    summary: 'Resend the verification email',
    description: 'Always 202, for the same reason sign-up is.',
    auth: 'public',
    body: { name: 'ResendVerification', schema: resendVerificationSchema },
    response: {
      kind: 'object',
      status: 202,
      name: 'AcceptedResponse',
      description: 'Accepted.',
      data: acceptedSchema,
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/auth/verify-email',
    operationId: 'verifyEmail',
    tag: 'Authentication',
    summary: 'Confirm an email address',
    auth: 'public',
    body: { name: 'VerifyEmail', schema: verifyEmailSchema },
    response: { kind: 'empty', status: 204, description: 'Verified.' },
    errors: [ErrorCode.INVALID_TOKEN],
  },
  {
    method: 'POST',
    path: '/auth/sign-in',
    operationId: 'signIn',
    tag: 'Authentication',
    summary: 'Sign in',
    description:
      'A browser receives the session in an httpOnly cookie; every other client ' +
      'reads `token` from the body. `mfa_required` is a success, not an error: the ' +
      'credentials were right and the flow continues at `/auth/mfa/verify`.',
    auth: 'public',
    body: { name: 'SignIn', schema: signInSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'SignInResponse',
      description: 'Signed in, or a second factor is required.',
      data: signInResultSchema,
    },
    errors: [
      ErrorCode.INVALID_CREDENTIALS,
      ErrorCode.EMAIL_NOT_VERIFIED,
      ErrorCode.MFA_ENROLMENT_REQUIRED,
    ],
  },
  {
    method: 'POST',
    path: '/auth/mfa/verify',
    operationId: 'verifyMfa',
    tag: 'Authentication',
    summary: 'Complete sign-in with a second factor',
    description: 'Takes the `challengeToken` from the `mfa_required` response, plus a code.',
    auth: 'public',
    body: { name: 'MfaVerify', schema: mfaVerifySchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'SignInResponse',
      description: 'Signed in.',
      data: signInResultSchema,
    },
    errors: [ErrorCode.INVALID_TOKEN, ErrorCode.MFA_INVALID],
  },
  {
    method: 'POST',
    path: '/auth/sign-out',
    operationId: 'signOut',
    tag: 'Authentication',
    summary: 'Sign out this device',
    auth: 'session',
    response: { kind: 'empty', status: 204, description: 'Signed out.' },
    errors: [],
  },
  {
    method: 'POST',
    path: '/auth/forgot-password',
    operationId: 'forgotPassword',
    tag: 'Authentication',
    summary: 'Start a password reset',
    description: 'Always 202, whether or not the address is known.',
    auth: 'public',
    body: { name: 'ForgotPassword', schema: forgotPasswordSchema },
    response: {
      kind: 'object',
      status: 202,
      name: 'AcceptedResponse',
      description: 'Accepted.',
      data: acceptedSchema,
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/auth/reset-password',
    operationId: 'resetPassword',
    tag: 'Authentication',
    summary: 'Finish a password reset',
    description: 'Every session issued before the change is revoked (CLAUDE.md §5.9).',
    auth: 'public',
    body: { name: 'ResetPassword', schema: resetPasswordSchema },
    response: { kind: 'empty', status: 204, description: 'Password changed.' },
    errors: [ErrorCode.INVALID_TOKEN],
  },
  {
    method: 'POST',
    path: '/auth/change-password',
    operationId: 'changePassword',
    tag: 'Authentication',
    summary: 'Change your password',
    description:
      'Returns the replacement session, like sign-in does. The change revokes every ' +
      'session issued before it, this one included, so a 204 here would sign the caller ' +
      'out of the device they are standing at.',
    auth: 'session',
    body: { name: 'ChangePassword', schema: changePasswordSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'SignInResponse',
      description: 'The replacement session.',
      data: signInResultSchema,
    },
    errors: [ErrorCode.INVALID_CREDENTIALS],
  },
  {
    method: 'GET',
    path: '/auth/me',
    operationId: 'currentUser',
    tag: 'Authentication',
    summary: 'The signed-in user and their workspaces',
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'CurrentUserResponse',
      description: 'The current user.',
      data: currentUserSchema,
    },
    errors: [],
  },
  {
    method: 'GET',
    path: '/auth/sessions',
    operationId: 'listSessions',
    tag: 'Authentication',
    summary: 'Your signed-in devices',
    description:
      'Carries no token, not even a prefix: this list is readable by anyone holding ' +
      'one session, and a fragment of another session is a head start on it.',
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'SessionListResponse',
      description: 'Every live session for this user.',
      data: sessionSummarySchema.array(),
    },
    errors: [],
  },
  {
    method: 'DELETE',
    path: '/auth/sessions/others',
    operationId: 'signOutOtherSessions',
    tag: 'Authentication',
    summary: 'Sign out every other device',
    description: 'The caller stays signed in.',
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'RevokedSessionsResponse',
      description: 'How many sessions were revoked.',
      data: revokedSessionsSchema,
    },
    errors: [],
  },
  {
    method: 'DELETE',
    path: '/auth/sessions',
    operationId: 'revokeSession',
    tag: 'Authentication',
    summary: 'Revoke one device',
    description:
      "404, not 403, for a session that is not the caller's: a 403 would confirm the " +
      'id names a real session belonging to somebody else.',
    auth: 'session',
    query: sessionRevokeQuerySchema,
    response: { kind: 'empty', status: 204, description: 'Revoked.' },
    errors: RECORD,
  },
  {
    method: 'POST',
    path: '/auth/mfa/enroll',
    operationId: 'enrollMfa',
    tag: 'Authentication',
    summary: 'Begin MFA enrolment',
    description:
      'Returns the secret and the backup codes once. They are never readable again, ' +
      'and the enrolment is not active until `/auth/mfa/activate` confirms a code.',
    auth: 'session',
    response: {
      kind: 'object',
      status: 201,
      name: 'MfaEnrolmentResponse',
      description: 'The secret, its otpauth URL and the backup codes.',
      data: mfaEnrolmentSchema,
    },
    errors: [ErrorCode.INVALID_CREDENTIALS],
  },
  {
    method: 'POST',
    path: '/auth/mfa/activate',
    operationId: 'activateMfa',
    tag: 'Authentication',
    summary: 'Activate MFA with a code',
    auth: 'session',
    body: { name: 'MfaActivate', schema: mfaActivateSchema },
    response: { kind: 'empty', status: 204, description: 'Activated.' },
    errors: [ErrorCode.MFA_INVALID],
  },
  {
    method: 'GET',
    path: '/auth/mfa',
    operationId: 'mfaStatus',
    tag: 'Authentication',
    summary: 'Whether MFA is on, and how many backup codes are left',
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'MfaStatusResponse',
      description: 'The current enrolment state.',
      data: mfaStatusSchema,
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/auth/mfa/disable',
    operationId: 'disableMfa',
    tag: 'Authentication',
    summary: 'Turn MFA off',
    description:
      'Requires the password, not just the session: removing a second factor with ' +
      'nothing but a stolen session cookie would make the second factor worth very little. ' +
      'A POST rather than a DELETE because it carries a body, and bodies on DELETE are ' +
      'dropped all the way along the path.',
    auth: 'session',
    body: { name: 'MfaDisable', schema: mfaDisableSchema },
    response: { kind: 'empty', status: 204, description: 'Disabled.' },
    errors: [ErrorCode.INVALID_CREDENTIALS],
  },
  {
    method: 'GET',
    path: '/auth/google',
    operationId: 'startGoogleSignIn',
    tag: 'Authentication',
    summary: 'Begin Google sign-in',
    description: 'Redirects to Google and sets a signed state cookie.',
    auth: 'public',
    response: { kind: 'empty', status: 302, description: 'Redirect to Google.' },
    errors: [],
  },
  {
    method: 'GET',
    path: '/auth/google/callback',
    operationId: 'completeGoogleSignIn',
    tag: 'Authentication',
    summary: 'Finish Google sign-in',
    description:
      'Reached by a browser redirect, so it answers with another redirect rather than ' +
      'a JSON body. The session arrives in the cookie.',
    auth: 'public',
    query: googleCallbackQuerySchema,
    response: { kind: 'empty', status: 302, description: 'Redirect back to the app.' },
    errors: [ErrorCode.INVALID_TOKEN],
  },
];

const invitationRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/invitations/accept',
    operationId: 'previewInvitation',
    tag: 'Invitations',
    summary: 'Read an invitation without consuming it',
    description:
      'Public because the recipient may have no account yet. The token in the link ' +
      '*is* the credential and is checked against the invitation row (ADR-0019).',
    auth: 'public',
    query: invitationAcceptQuerySchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'InvitationPreviewResponse',
      description: 'What the link is for.',
      data: invitationPreviewSchema,
    },
    errors: [ErrorCode.INVALID_TOKEN],
  },
  {
    method: 'POST',
    path: '/invitations/accept',
    operationId: 'acceptInvitation',
    tag: 'Invitations',
    summary: 'Accept an invitation',
    description:
      'An emailed link never issues a session for an address that already has an ' +
      'account: that would walk past a second factor the owner enrolled. Such a recipient ' +
      'gets `INVITATION_SIGN_IN_REQUIRED` and accepts from a real session instead (ADR-0019).',
    auth: 'public',
    body: { name: 'InvitationAccept', schema: invitationAcceptSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'InvitationAcceptResponse',
      description: 'The membership, and a session when one was issued.',
      data: invitationAcceptResultSchema,
    },
    errors: [
      ErrorCode.INVALID_TOKEN,
      ErrorCode.INVITATION_SIGN_IN_REQUIRED,
      ErrorCode.INVITATION_RECIPIENT_MISMATCH,
    ],
  },
  {
    method: 'GET',
    path: '/invitations/roles',
    operationId: 'listAssignableRoles',
    tag: 'Invitations',
    summary: 'Roles this administrator may hand out',
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'InvitationRoleListResponse',
      description: 'The assignable roles.',
      data: invitationRoleSchema.array(),
    },
    errors: [],
  },
  {
    method: 'GET',
    path: '/invitations',
    operationId: 'listInvitations',
    tag: 'Invitations',
    summary: 'Pending invitations',
    description: 'Carries no token and no digest: an invitation token is a key to a seat.',
    auth: 'session',
    query: invitationListQuerySchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'InvitationListResponse',
      description: 'The pending invitations.',
      data: invitationSummarySchema.array(),
      meta: z.object({ hasMore: z.boolean() }),
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/invitations',
    operationId: 'createInvitation',
    tag: 'Invitations',
    summary: 'Invite somebody',
    description: 'Re-inviting an address mints a fresh token and retires the old one.',
    auth: 'session',
    body: { name: 'InvitationCreate', schema: invitationCreateSchema },
    response: {
      kind: 'object',
      status: 201,
      name: 'InvitationResponse',
      description: 'The invitation.',
      data: invitationSummarySchema,
    },
    errors: [ErrorCode.CONFLICT],
  },
  {
    method: 'DELETE',
    path: '/invitations/{id}',
    operationId: 'revokeInvitation',
    tag: 'Invitations',
    summary: 'Revoke an invitation',
    auth: 'session',
    params: invitationParamsSchema,
    response: { kind: 'empty', status: 204, description: 'Revoked.' },
    errors: RECORD,
  },
];

const dealRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/deals/board',
    operationId: 'getDealBoard',
    tag: 'Deals',
    summary: 'The Kanban board for a pipeline',
    description:
      'Columns in stage order, each with its own totals. Defaults to the first pipeline.',
    auth: 'session',
    query: dealBoardQuerySchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'DealBoardResponse',
      description: 'The board.',
      data: dealBoardSchema,
    },
    errors: RECORD,
  },
];

const pipelineRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/pipelines',
    operationId: 'listPipelines',
    tag: 'Deals',
    summary: 'Pipelines and their stages',
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'PipelineListResponse',
      description: "The tenant's pipelines, each with its stages in order.",
      data: pipelineSchema.array(),
    },
    errors: [],
  },
];

const leadRoutes: RouteDefinition[] = [
  {
    method: 'POST',
    path: '/leads/duplicate-check',
    operationId: 'checkLeadDuplicates',
    tag: 'Leads',
    summary: 'Look for records that match a draft',
    description:
      'A POST because it carries the draft, not because it writes anything (ADR-0023). ' +
      'Nothing is created.',
    auth: 'session',
    body: { name: 'DuplicateCheck', schema: duplicateCheckSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'DuplicateMatchListResponse',
      description: 'Matching leads, contacts and accounts the caller may see.',
      data: duplicateMatchSchema.array(),
    },
    errors: [],
  },
  {
    method: 'GET',
    path: '/leads/{id}/conversion-matches',
    operationId: 'listLeadConversionMatches',
    tag: 'Leads',
    summary: 'Records this lead could be linked to instead of duplicated',
    auth: 'session',
    params: leadParamsSchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'DuplicateMatchListResponse',
      description: 'Candidate contacts and accounts.',
      data: duplicateMatchSchema.array(),
    },
    errors: RECORD,
  },
  {
    method: 'POST',
    path: '/leads/{id}/convert',
    operationId: 'convertLead',
    tag: 'Leads',
    summary: 'Convert a lead',
    description:
      'One transaction: contact, account and optional deal, then the lead is marked ' +
      'converted (ADR-0022). Converting twice is refused, not repeated.',
    auth: 'session',
    params: leadParamsSchema,
    body: { name: 'LeadConvert', schema: leadConvertSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadConversionResponse',
      description: 'What the conversion created or linked.',
      data: leadConversionResultSchema,
    },
    errors: [...VERSIONED, ErrorCode.CONFLICT],
  },
];

const activityRoutes: RouteDefinition[] = [
  {
    method: 'POST',
    path: '/activities/{id}/links',
    operationId: 'linkActivity',
    tag: 'Activities',
    summary: 'Attach an activity to a record',
    description:
      'Polymorphic `(objectType, recordId)`, so a custom object plugs in later ' +
      'without a schema change (ADR-0005).',
    auth: 'session',
    params: activityParamsSchema,
    body: { name: 'RecordLink', schema: activityLinkSchema },
    response: {
      kind: 'object',
      status: 201,
      name: 'ActivityResponse',
      description: 'The activity, with its links.',
      data: activitySchema,
    },
    errors: [...RECORD, ErrorCode.CONFLICT],
  },
  {
    method: 'DELETE',
    path: '/activities/{id}/links',
    operationId: 'unlinkActivity',
    tag: 'Activities',
    summary: 'Detach an activity from a record',
    description: 'Names the pair rather than a link id: it is the natural key.',
    auth: 'session',
    params: activityParamsSchema,
    query: activityUnlinkQuerySchema,
    response: { kind: 'empty', status: 204, description: 'Detached.' },
    errors: RECORD,
  },
];

const myDayRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/my-day',
    operationId: 'getMyDay',
    tag: 'Activities',
    summary: "Today's work for the signed-in user",
    description:
      'Overdue, due today, upcoming and recently viewed, cut on day boundaries in the ' +
      "viewer's own zone. An unknown `timeZone` is a 422, never a silent fall back to UTC, " +
      "which would shift everybody's tasks by a day.",
    auth: 'session',
    query: myDayQuerySchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'MyDayResponse',
      description: 'The buckets, plus the date and zone they were cut on.',
      data: myDaySchema,
      meta: z.object({ timeZone: z.string(), date: z.iso.date() }),
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/record-views',
    operationId: 'recordView',
    tag: 'Activities',
    summary: '"I opened this record"',
    description: 'Checked against what the caller may read, so it cannot be used as a probe.',
    auth: 'session',
    body: { name: 'RecordLink', schema: recordViewCreateSchema },
    response: { kind: 'empty', status: 204, description: 'Recorded.' },
    errors: RECORD,
  },
];

const notificationRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/notifications',
    operationId: 'listNotifications',
    tag: 'Notifications',
    summary: 'Your notifications',
    description:
      'No route here takes a user id: the signed-in person is the only person they can be about.',
    auth: 'session',
    query: notificationListQuerySchema,
    response: {
      kind: 'list',
      status: 200,
      name: 'NotificationListResponse',
      description: 'A page of notifications, with the unread count alongside.',
      data: notificationSchema,
      meta: listMetaSchema.extend({ unread: z.number().int().nonnegative() }),
    },
    errors: [],
  },
  {
    method: 'GET',
    path: '/notifications/unread-count',
    operationId: 'unreadNotificationCount',
    tag: 'Notifications',
    summary: "The bell's badge",
    description: 'Its own route so polling it costs one indexed count.',
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'UnreadCountResponse',
      description: 'How many are unread.',
      data: unreadCountSchema,
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/notifications/read-all',
    operationId: 'markAllNotificationsRead',
    tag: 'Notifications',
    summary: 'Mark everything read',
    auth: 'session',
    response: {
      kind: 'object',
      status: 201,
      name: 'MarkAllReadResponse',
      description: 'How many rows were touched.',
      data: markAllReadSchema,
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/notifications/{id}/read',
    operationId: 'markNotificationRead',
    tag: 'Notifications',
    summary: 'Mark one read',
    auth: 'session',
    params: notificationParamsSchema,
    response: { kind: 'empty', status: 204, description: 'Marked read.' },
    errors: RECORD,
  },
];

/**
 * Every route the API serves, in no particular order.
 *
 * The generator sorts; the drift test compares sets. Order here is for
 * readers only.
 */
export const API_ROUTES: readonly RouteDefinition[] = [
  ...healthRoutes,
  ...metaRoutes,
  ...authRoutes,
  ...standardObjectRoutes({
    tag: 'Accounts',
    plural: 'accounts',
    singular: 'account',
    name: 'Account',
    record: accountSchema,
    listQuery: accountListQuerySchema,
    params: accountParamsSchema,
    create: accountCreateSchema,
    update: accountUpdateSchema,
    deleteQuery: accountDeleteQuerySchema,
    createErrors: [ErrorCode.CONFLICT],
  }),
  ...standardObjectRoutes({
    tag: 'Contacts',
    plural: 'contacts',
    singular: 'contact',
    name: 'Contact',
    record: contactSchema,
    listQuery: contactListQuerySchema,
    params: contactParamsSchema,
    create: contactCreateSchema,
    update: contactUpdateSchema,
    deleteQuery: contactDeleteQuerySchema,
  }),
  ...dealRoutes,
  ...standardObjectRoutes({
    tag: 'Deals',
    plural: 'deals',
    singular: 'deal',
    name: 'Deal',
    record: dealSchema,
    listQuery: dealListQuerySchema,
    params: dealParamsSchema,
    create: dealCreateSchema,
    update: dealUpdateSchema,
    deleteQuery: dealDeleteQuerySchema,
    createErrors: [ErrorCode.CONFLICT],
  }),
  ...pipelineRoutes,
  ...leadRoutes,
  ...standardObjectRoutes({
    tag: 'Leads',
    plural: 'leads',
    singular: 'lead',
    name: 'Lead',
    record: leadSchema,
    listQuery: leadListQuerySchema,
    params: leadParamsSchema,
    create: leadCreateSchema,
    update: leadUpdateSchema,
    deleteQuery: leadDeleteQuerySchema,
    createErrors: [ErrorCode.DUPLICATE_RECORDS],
    createMeta: z.object({
      /** Records the new lead resembles, so the UI can offer "link to existing". */
      duplicates: duplicateMatchSchema.array(),
    }),
  }),
  ...activityRoutes,
  ...standardObjectRoutes({
    tag: 'Activities',
    plural: 'activities',
    singular: 'activity',
    name: 'Activity',
    record: activitySchema,
    listQuery: activityListQuerySchema,
    params: activityParamsSchema,
    create: activityCreateSchema,
    update: activityUpdateSchema,
    deleteQuery: activityDeleteQuerySchema,
  }),
  ...myDayRoutes,
  ...notificationRoutes,
  ...invitationRoutes,
];

/** `GET /contacts/{id}` — how the drift test and the generator name a route. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
