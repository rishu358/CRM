import { ErrorCode } from '@crm/core';
import {
  emailContextQuerySchema,
  emailContextSchema,
  emailListQuerySchema,
  emailMessageSchema,
  emailParamsSchema,
  emailSendSchema,
  emailSettingsSchema,
  emailSettingsUpdateSchema,
} from './email.js';
import type { RouteDefinition } from './routes.js';

const IDEMPOTENT: readonly ErrorCode[] = [
  ErrorCode.IDEMPOTENCY_KEY_REUSED,
  ErrorCode.IDEMPOTENCY_IN_PROGRESS,
  ErrorCode.IDEMPOTENT_RECORD_UNAVAILABLE,
];

const NOTE =
  'Needs the `email_message` grant for the action (`create` sends, `read` reads) **and** the ordinary ' +
  'right to read the record at your own scope: you can only email, and only read the emails on, records ' +
  'you can see. A record outside that answers 404. Needs the `email` feature (ADR-0073).';

/** The email routes, kept beside their schemas and spread into `API_ROUTES`. */
export const emailRoutes: RouteDefinition[] = [
  {
    method: 'GET',
    path: '/emails',
    operationId: 'listEmails',
    tag: 'Email',
    summary: 'The emails on one record, newest first',
    description:
      'Every email sent from or about the record, with where it got to. A message is shown to you ' +
      'when you can read any record it is linked to. `sent` means the mail service accepted it, not ' +
      'that it arrived. Keyset-paginated. ' +
      NOTE,
    auth: 'session',
    query: emailListQuerySchema,
    response: {
      kind: 'list',
      status: 200,
      name: 'EmailListResponse',
      description: 'A page of emails.',
      data: emailMessageSchema,
    },
    errors: [ErrorCode.NOT_FOUND, ErrorCode.ENTITLEMENT_REQUIRED],
  },
  {
    method: 'GET',
    path: '/emails/context',
    operationId: 'getEmailContext',
    tag: 'Email',
    summary: 'What the Send dialog needs: who it goes to, as whom, and how many are left today',
    description:
      'The recipient is read from the record, never typed in: `to` is null when the record has no ' +
      'address you may use (the same answer whether none is stored or the field is hidden from you). ' +
      '`consent` is `withdrawn` when sending would be refused. ' +
      NOTE,
    auth: 'session',
    query: emailContextQuerySchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'EmailContextResponse',
      description: 'The recipient, the sender, the reply address and today’s usage.',
      data: emailContextSchema,
    },
    errors: [ErrorCode.NOT_FOUND, ErrorCode.ENTITLEMENT_REQUIRED],
  },
  {
    method: 'GET',
    path: '/emails/{id}',
    operationId: 'getEmail',
    tag: 'Email',
    summary: 'One email',
    description: NOTE,
    auth: 'session',
    params: emailParamsSchema,
    response: {
      kind: 'object',
      status: 200,
      name: 'EmailResponse',
      description: 'The email.',
      data: emailMessageSchema,
    },
    errors: [ErrorCode.NOT_FOUND, ErrorCode.ENTITLEMENT_REQUIRED],
  },
  {
    method: 'POST',
    path: '/emails',
    operationId: 'sendEmail',
    tag: 'Email',
    summary: 'Send an email from a contact, a lead or a deal',
    description:
      'Queues one plain-text email and answers 202 at once; the worker sends it and the status moves ' +
      'from `queued` to `sent` or `failed`. The recipient is the record’s own address (for a deal, the ' +
      'chosen contact’s), read through the field rules you are under; `to`, the sender address and ' +
      'the status cannot be set. Refused when the person has withdrawn consent to email (`CONSENT_WITHDRAWN`), ' +
      'when the record has no address you may use (`NO_EMAIL_ADDRESS`), and when today’s limit is reached ' +
      '(429 with `Retry-After`). Accepts an `Idempotency-Key`. ' +
      NOTE,
    auth: 'session',
    body: { name: 'EmailSend', schema: emailSendSchema },
    response: {
      kind: 'object',
      status: 202,
      name: 'EmailSendResponse',
      description: 'The queued email.',
      data: emailMessageSchema,
    },
    errors: [
      ErrorCode.NOT_FOUND,
      ErrorCode.ENTITLEMENT_REQUIRED,
      ErrorCode.NO_EMAIL_ADDRESS,
      ErrorCode.CONSENT_WITHDRAWN,
      ...IDEMPOTENT,
    ],
  },
  {
    method: 'POST',
    path: '/emails/{id}/retry',
    operationId: 'retryEmail',
    tag: 'Email',
    summary: 'Try a failed email again',
    description:
      'Queues a new email with the same subject and text, to the record’s address as it is now. The ' +
      'failed one stays as it was, marked as retried; a second retry of the same one is a 409. It ' +
      'counts against today’s limit like any send. Accepts an `Idempotency-Key`. ' +
      NOTE,
    auth: 'session',
    params: emailParamsSchema,
    response: {
      kind: 'object',
      status: 202,
      name: 'EmailRetryResponse',
      description: 'The new, queued email.',
      data: emailMessageSchema,
    },
    errors: [
      ErrorCode.NOT_FOUND,
      ErrorCode.CONFLICT,
      ErrorCode.ENTITLEMENT_REQUIRED,
      ErrorCode.NO_EMAIL_ADDRESS,
      ErrorCode.CONSENT_WITHDRAWN,
      ...IDEMPOTENT,
    ],
  },
  {
    method: 'GET',
    path: '/email-settings',
    operationId: 'getEmailSettings',
    tag: 'Email',
    summary: 'The company’s email sender: name, reply address, footer and today’s usage',
    description:
      'Needs `read` on `tenant_settings`. `sendingAddress` is set by whoever runs the installation and ' +
      'is read-only here. Until the settings are saved once, `fromName` is the company’s name.',
    auth: 'session',
    response: {
      kind: 'object',
      status: 200,
      name: 'EmailSettingsResponse',
      description: 'The sender settings.',
      data: emailSettingsSchema,
    },
    errors: [ErrorCode.ENTITLEMENT_REQUIRED],
  },
  {
    method: 'PATCH',
    path: '/email-settings',
    operationId: 'saveEmailSettings',
    tag: 'Email',
    summary: 'Save the company’s email sender',
    description:
      'Needs `update` on `tenant_settings`. The name is shown to every recipient, so it is limited to ' +
      'letters, digits and a little punctuation, with no address or brackets. The reply address is ' +
      'not verified (nobody confirms they own it). The first save omits `version`; later saves send the ' +
      'one they read, and a stale one is a 409.',
    auth: 'session',
    body: { name: 'EmailSettingsUpdate', schema: emailSettingsUpdateSchema },
    response: {
      kind: 'object',
      status: 200,
      name: 'EmailSettingsSaveResponse',
      description: 'The settings after the save.',
      data: emailSettingsSchema,
    },
    errors: [ErrorCode.VERSION_CONFLICT, ErrorCode.CONFLICT, ErrorCode.ENTITLEMENT_REQUIRED],
  },
];
