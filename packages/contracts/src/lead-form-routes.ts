import { ErrorCode } from '@crm/core';
import {
  leadFormCreateSchema,
  leadFormDeleteQuerySchema,
  leadFormIssuedSchema,
  leadFormParamsSchema,
  leadFormPauseSchema,
  leadFormRevokeSchema,
  leadFormRotateSchema,
  leadFormSchema,
  leadFormSetupSchema,
  leadFormUpdateSchema,
  publicFormDefinitionSchema,
  publicFormParamsSchema,
  publicFormQuerySchema,
  publicSubmissionBodySchema,
  publicSubmissionResultSchema,
} from './lead-forms.js';
import type { RouteDefinition } from './routes.js';

const VERSIONED: readonly ErrorCode[] = [ErrorCode.NOT_FOUND, ErrorCode.VERSION_CONFLICT];

const LEAD_FORM_NOTE =
  'Needs the `lead_form` grant for the action (`read` to look, `create` to add a form, `update` to ' +
  'edit one, switch it on or off, rotate or revoke its key or pause every form, `delete` to remove ' +
  'one); Owner and Admin have all four. A form is a door onto the public internet, so none of the ' +
  'lead permissions imply it (ADR-0063).';

const PUBLIC_NOTE =
  'One of the only two routes in the API that need no session, and the only ones a stranger can ' +
  'write through (ADR-0063; the `PUBLIC_ROUTES` list in the test suite keeps the set closed). The ' +
  'key in the path selects the workspace and the form; nothing the caller sends can. A wrong key, ' +
  'a revoked key, a disabled form, a paused workspace and a withdrawn feature all answer the same ' +
  '404. No cookie is read or set, there is no CORS approval, and the query string must be empty.';

/**
 * The website lead form routes (ADR-0063), kept beside their schemas and spread into `API_ROUTES`.
 */
export const leadFormRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/lead-forms/setup',
    operationId: 'getLeadFormSetup',
    tag: 'Lead forms',
    summary: 'What a form may ask for, and whether forms are paused',
    description:
      'The lead fields a form may offer (the surname is mandatory), the workspace-wide pause, ' +
      'the calling code to pre-fill and how many forms a workspace may have. ' +
      LEAD_FORM_NOTE,
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadFormSetupResponse',
      description: "The builder's options.",
      data: leadFormSetupSchema,
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/lead-forms/pause',
    operationId: 'pauseLeadForms',
    tag: 'Lead forms',
    summary: 'Pause or resume every web form of the workspace',
    description:
      'The kill switch: while paused, every public form answers as though it did not exist, and ' +
      'nothing is lost or deleted. ' +
      LEAD_FORM_NOTE,
    auth: 'session',
    body: { name: 'LeadFormPause', schema: leadFormPauseSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadFormPauseResponse',
      description: "The builder's options, with the new state.",
      data: leadFormSetupSchema,
    },
    errors: [],
  },
  {
    method: 'GET',
    path: '/lead-forms',
    operationId: 'listLeadForms',
    tag: 'Lead forms',
    summary: 'List the web forms',
    description:
      'Every form of the workspace (a workspace has few), with how many leads each has made. ' +
      'Never carries a key. ' +
      LEAD_FORM_NOTE,
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadFormListResponse',
      description: 'The forms.',
      data: leadFormSchema.array(),
    },
    errors: [],
  },
  {
    method: 'POST',
    path: '/lead-forms',
    operationId: 'createLeadForm',
    tag: 'Lead forms',
    summary: 'Create a web form',
    description:
      'Makes the form and its first key. **The key, the link and the embed snippet are in this ' +
      'answer and nowhere else**: only a digest of the key is kept. The form must ask for the last ' +
      'name (required) and for an email or a phone number; only active lead fields of a safe type ' +
      'can be added; the consent text is required and versioned. A form name is unique ignoring ' +
      'case, and a workspace has at most `maxForms` forms. Needs the `web_forms` feature. ' +
      LEAD_FORM_NOTE,
    auth: 'session',
    body: { name: 'LeadFormCreate', schema: leadFormCreateSchema },
    response: {
      kind: 'object',
      status: 201,
      name: 'LeadFormCreateResponse',
      description: 'The form, and its key, shown once.',
      data: leadFormIssuedSchema,
    },
    errors: [ErrorCode.CONFLICT, ErrorCode.ENTITLEMENT_REQUIRED],
  },
  {
    method: 'GET',
    path: '/lead-forms/{id}',
    operationId: 'getLeadForm',
    tag: 'Lead forms',
    summary: 'Read one web form',
    description: LEAD_FORM_NOTE,
    auth: 'session',
    params: leadFormParamsSchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadFormResponse',
      description: 'The form.',
      data: leadFormSchema,
    },
    errors: [ErrorCode.NOT_FOUND],
  },
  {
    method: 'PATCH',
    path: '/lead-forms/{id}',
    operationId: 'updateLeadForm',
    tag: 'Lead forms',
    summary: 'Edit a web form, or switch it on or off',
    description:
      'Carries `version`; a stale one is a 409. Changing the consent text starts a new consent ' +
      'version (the old wording is kept, and every lead says which version its visitor accepted). ' +
      "A success redirect must be an https page on one of the form's own allowed origins. " +
      'Switching a form off takes effect at once. ' +
      LEAD_FORM_NOTE,
    auth: 'session',
    params: leadFormParamsSchema,
    body: { name: 'LeadFormUpdate', schema: leadFormUpdateSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadFormUpdateResponse',
      description: 'The form after the change.',
      data: leadFormSchema,
    },
    errors: [...VERSIONED, ErrorCode.CONFLICT],
  },
  {
    method: 'DELETE',
    path: '/lead-forms/{id}',
    operationId: 'deleteLeadForm',
    tag: 'Lead forms',
    summary: 'Delete a web form',
    description:
      'Stops the form for good (its keys stop working at once). Leads it already made stay. ' +
      LEAD_FORM_NOTE,
    auth: 'session',
    params: leadFormParamsSchema,
    query: leadFormDeleteQuerySchema,
    response: { kind: 'empty', status: 204, description: 'The form is deleted.' },
    errors: VERSIONED,
  },
  {
    method: 'POST',
    path: '/lead-forms/{id}/key/rotate',
    operationId: 'rotateLeadFormKey',
    tag: 'Lead forms',
    summary: 'Issue a new key for a web form',
    description:
      'Makes a new key, shown once in this answer. The old key keeps working for `graceHours` ' +
      '(24 by default, 0 retires it at once), so the website can be updated without a gap. ' +
      'A form has at most two live keys: rotating again retires the older one at once. ' +
      LEAD_FORM_NOTE,
    auth: 'session',
    params: leadFormParamsSchema,
    body: { name: 'LeadFormRotate', schema: leadFormRotateSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadFormRotateResponse',
      description: 'The form, and its new key, shown once.',
      data: leadFormIssuedSchema,
    },
    errors: VERSIONED,
  },
  {
    method: 'POST',
    path: '/lead-forms/{id}/key/revoke',
    operationId: 'revokeLeadFormKeys',
    tag: 'Lead forms',
    summary: 'Revoke every key of a web form',
    description:
      'Every key stops working at once. The form stays, and rotating issues a fresh key. ' +
      LEAD_FORM_NOTE,
    auth: 'session',
    params: leadFormParamsSchema,
    body: { name: 'LeadFormRevoke', schema: leadFormRevokeSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'LeadFormRevokeResponse',
      description: 'The form, with no live key.',
      data: leadFormSchema,
    },
    errors: VERSIONED,
  },
  {
    method: 'GET',
    path: '/public/forms/{key}',
    operationId: 'getPublicLeadForm',
    tag: 'Public forms',
    summary: "A web form's public definition",
    description:
      'What the hosted page needs to draw the form: its fields, consent wording, success ' +
      'message, the origins that may frame it, and a fill token to send back. ' +
      PUBLIC_NOTE,
    auth: 'public',
    params: publicFormParamsSchema,
    query: publicFormQuerySchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'PublicLeadFormResponse',
      description: "The form's public definition.",
      data: publicFormDefinitionSchema,
    },
    errors: [ErrorCode.NOT_FOUND],
  },
  {
    method: 'POST',
    path: '/public/forms/{key}/submissions',
    operationId: 'submitPublicLeadForm',
    tag: 'Public forms',
    summary: 'Submit a web form',
    description:
      "Makes one lead, with source `web_form`, in the form's own workspace, owned by the person " +
      'the assignment rules choose. The body is `application/json`, at most 16 KB, and is checked ' +
      "against a strict schema **built from the form's own fields** plus `consent` (must be " +
      '`true`), `fillToken` (from the definition) and the hidden `website_url` (must be empty): ' +
      'any other key is a 422. Accepts an `Idempotency-Key` header (1 to 128 of letters, digits ' +
      'and `_ . : -`); a repeat with the same key answers the same and makes no second lead. ' +
      'Every accepted outcome answers `{ received: true }` and nothing more, so the answer never ' +
      'reveals whether the visitor matched an existing record. A page submitted within three ' +
      'seconds of being drawn, or more than four hours after, answers 422 `FORM_EXPIRED`. ' +
      PUBLIC_NOTE,
    auth: 'public',
    params: publicFormParamsSchema,
    query: publicFormQuerySchema,
    body: { name: 'PublicLeadFormSubmission', schema: publicSubmissionBodySchema },
    response: {
      kind: 'object',
      status: 201,
      name: 'PublicLeadFormSubmissionResponse',
      description: 'The submission was accepted.',
      data: publicSubmissionResultSchema,
    },
    errors: [ErrorCode.NOT_FOUND, ErrorCode.FORM_EXPIRED],
  },
];
