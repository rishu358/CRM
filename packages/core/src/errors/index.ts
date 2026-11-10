/**
 * Domain errors with stable, machine-readable codes (CLAUDE.md §8).
 *
 * Codes are part of the public API contract: clients branch on them, so they may
 * be added but never renamed or repurposed. Messages are for humans and may change.
 *
 * Nothing here ever carries a secret, a token or raw PII — these objects are
 * serialised into responses and logs.
 */

export const ErrorCode = {
  /** Authentication missing or invalid. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Authenticated, but `can()` denied the action. */
  FORBIDDEN: 'FORBIDDEN',
  /**
   * Record absent, or outside the caller's tenant or visibility scope.
   *
   * Deliberately indistinguishable from a genuine miss: returning 403 for a
   * record in another tenant would confirm that the id exists (CLAUDE.md §5.5).
   */
  NOT_FOUND: 'NOT_FOUND',
  /** Input failed Zod validation at the API boundary. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Optimistic lock lost: the record changed since the caller read it. */
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  /** A uniqueness rule was violated (duplicate email, slug, field key). */
  CONFLICT: 'CONFLICT',
  /** Per-user or per-tenant rate limit exceeded. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** The tenant's plan does not include this capability. */
  ENTITLEMENT_REQUIRED: 'ENTITLEMENT_REQUIRED',
  /** This installation does not let strangers create workspaces (`DEPLOYMENT_MODE=single_tenant`). */
  SIGN_UP_DISABLED: 'SIGN_UP_DISABLED',
  /** A write referenced a field the caller may not write, or that does not exist. */
  FIELD_NOT_WRITABLE: 'FIELD_NOT_WRITABLE',
  /**
   * Sign-in failed.
   *
   * Deliberately one code for "no such address" and "wrong password": two
   * codes would turn sign-in into a directory of who banks here
   * (MVP_SPEC M1).
   */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** A one-time token was wrong, already used, or past its expiry. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** The address has not been confirmed yet. */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  /** The workspace requires a second factor and this user has not enrolled. */
  MFA_ENROLMENT_REQUIRED: 'MFA_ENROLMENT_REQUIRED',
  /** The submitted second factor was wrong. */
  MFA_INVALID: 'MFA_INVALID',
  /**
   * The invited address already has an account, so the recipient must sign in
   * before the invitation can be accepted (ADR-0019).
   */
  INVITATION_SIGN_IN_REQUIRED: 'INVITATION_SIGN_IN_REQUIRED',
  /** Somebody other than the invited address tried to accept (ADR-0019). */
  INVITATION_RECIPIENT_MISMATCH: 'INVITATION_RECIPIENT_MISMATCH',
  /**
   * The write would create a record that looks like one already there, and
   * the caller has not said that is intended (ADR-0023).
   *
   * Distinct from `CONFLICT`: nothing is wrong with the request, so the client
   * reacts by showing the matches and offering "link to existing", not by
   * reporting an error.
   */
  DUPLICATE_RECORDS: 'DUPLICATE_RECORDS',
  /**
   * The change would leave the workspace with nobody who can manage roles and
   * members (MVP_SPEC M3). Nothing is wrong with the request in isolation; the
   * client reacts by explaining the lock-out, not by reporting a failure.
   */
  LAST_ADMINISTRATOR: 'LAST_ADMINISTRATOR',
  /** A role still has members, so it cannot be deleted until they are moved. */
  ROLE_IN_USE: 'ROLE_IN_USE',
  /**
   * A retry carried the `Idempotency-Key` of a request that did create its record, but that record has
   * since been deleted or can no longer be read by the caller (ADR-0060). Said plainly rather than as a
   * 404, which would look as though the first request never created anything.
   */
  IDEMPOTENT_RECORD_UNAVAILABLE: 'IDEMPOTENT_RECORD_UNAVAILABLE',
  /**
   * An `Idempotency-Key` was used before for a different request (another body, route or record).
   * The client has a bug or a key collision; it is not a race and retrying will not help (ADR-0060).
   */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /**
   * A request with the same `Idempotency-Key` is still being carried out. Nothing is wrong: wait for
   * `Retry-After` and send the same request again, which will then be answered as a replay.
   */
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  /**
   * The change hands out more than the person making it holds. Distinct from
   * `FORBIDDEN`: they may edit roles, just not beyond their own reach (ADR-0033).
   */
  PERMISSION_ESCALATION: 'PERMISSION_ESCALATION',
  /**
   * The service is at capacity and could not take this request in time (every database
   * connection was busy). Nothing is wrong with the request: the client waits (see
   * `Retry-After`) and tries again, rather than reporting a failure or giving up.
   */
  SERVICE_BUSY: 'SERVICE_BUSY',
  /**
   * A search could not be answered within its time limit (ADR-0041 §1). Nothing is wrong with the
   * request and waiting will not help: the client asks the person for a more specific search.
   * Distinct from `SERVICE_BUSY`, whose remedy is to wait.
   */
  SEARCH_TIMEOUT: 'SEARCH_TIMEOUT',
  /**
   * A website lead form was submitted too soon after its page was drawn, or the page is too old to
   * be trusted (ADR-0065 4.1). Nothing is lost: the visitor reloads the page and sends it again.
   */
  FORM_EXPIRED: 'FORM_EXPIRED',
  /**
   * The id names a record that was merged into another (ADR-0064). The answer for an old link or API
   * id: 410, with the id of the surviving record in `details`, when the caller may read it.
   */
  RECORD_MERGED: 'RECORD_MERGED',
  /**
   * The record to merge away was already merged, into the record the caller named. A second, concurrent
   * or repeated merge of the same pair lands here: nothing is wrong, the merge has been done (ADR-0064).
   */
  RECORD_ALREADY_MERGED: 'RECORD_ALREADY_MERGED',
  /** The records carry more linked rows than one merge may move (ADR-0064). */
  MERGE_TOO_LARGE: 'MERGE_TOO_LARGE',
  /**
   * The pair cannot be merged as it stands: one sits above the other in an account hierarchy, or a
   * request to erase one of them is open (ADR-0064). The message says which.
   */
  MERGE_BLOCKED: 'MERGE_BLOCKED',
  /**
   * The record has no email address the caller may use: none is stored, or the field is hidden from
   * them. One answer for both, so the error cannot be used to learn that a hidden field has a value
   * (CLAUDE.md §5.4, ADR-0073).
   */
  NO_EMAIL_ADDRESS: 'NO_EMAIL_ADDRESS',
  /** The person has withdrawn consent to email, so the CRM will not send to them (ADR-0073). */
  CONSENT_WITHDRAWN: 'CONSENT_WITHDRAWN',
  /** The address bounced, or its owner complained or unsubscribed, so it is not written to (ADR-0075). */
  ADDRESS_SUPPRESSED: 'ADDRESS_SUPPRESSED',
  /** The company's email is paused after a bad run of bounces or complaints (ADR-0075). */
  EMAIL_PAUSED: 'EMAIL_PAUSED',
  /** Unexpected failure. Details are logged, never returned. */
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Structured, safe-to-serialise detail about what went wrong. */
export interface ErrorDetail {
  readonly path?: string;
  readonly message: string;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: readonly ErrorDetail[];

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    details: readonly ErrorDetail[] = [],
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required') {
    super(ErrorCode.UNAUTHENTICATED, message, 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action') {
    super(ErrorCode.FORBIDDEN, message, 403);
  }
}

export class NotFoundError extends DomainError {
  /**
   * Takes only the object type, never the id: echoing an id the caller may not
   * see turns the 404 into a weak existence oracle.
   */
  constructor(objectType: string) {
    super(ErrorCode.NOT_FOUND, `${objectType} not found`, 404);
  }
}

export class ValidationError extends DomainError {
  constructor(details: readonly ErrorDetail[], message = 'Validation failed') {
    super(ErrorCode.VALIDATION_FAILED, message, 422, details);
  }
}

export class VersionConflictError extends DomainError {
  constructor(objectType: string) {
    super(
      ErrorCode.VERSION_CONFLICT,
      `This ${objectType} was changed by someone else. Reload and try again.`,
      409,
    );
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details: readonly ErrorDetail[] = []) {
    super(ErrorCode.CONFLICT, message, 409, details);
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  constructor() {
    super(
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      'This Idempotency-Key was already used for a different request',
      409,
    );
  }
}

export class IdempotencyInProgressError extends DomainError {
  constructor(
    /** Whole seconds to wait before sending the same request again. Sent as `Retry-After`. */
    readonly retryAfterSeconds: number,
  ) {
    super(
      ErrorCode.IDEMPOTENCY_IN_PROGRESS,
      'A request with this Idempotency-Key is still being carried out. Try again shortly.',
      409,
    );
  }
}

export class IdempotentRecordUnavailableError extends DomainError {
  constructor() {
    super(
      ErrorCode.IDEMPOTENT_RECORD_UNAVAILABLE,
      'This request was already carried out and created a record, which has since been deleted or is no longer visible to you. Use a new Idempotency-Key to create another.',
      409,
    );
  }
}

export class RecordMergedError extends DomainError {
  /**
   * `mergedIntoId` is sent only when the caller may read the surviving record; otherwise the answer is
   * a plain `NotFoundError`, so an old id cannot be used to find out what exists (CLAUDE.md §5.5).
   */
  constructor(objectType: string, mergedIntoId: string) {
    super(
      ErrorCode.RECORD_MERGED,
      `This ${objectType} was merged into another record. Use the surviving record instead.`,
      410,
      [{ path: 'mergedIntoId', message: mergedIntoId }],
    );
  }
}

export class RecordAlreadyMergedError extends DomainError {
  constructor() {
    super(
      ErrorCode.RECORD_ALREADY_MERGED,
      'This record has already been merged into the one you chose.',
      409,
    );
  }
}

export class MergeTooLargeError extends DomainError {
  constructor(moved: number, limit: number) {
    super(
      ErrorCode.MERGE_TOO_LARGE,
      `These records carry ${moved} linked items and one merge moves at most ${limit}. Remove or move some of them first.`,
      422,
      [{ path: 'loserId', message: 'Too many linked items', meta: { moved, limit } }],
    );
  }
}

export class MergeBlockedError extends DomainError {
  constructor(message: string) {
    super(ErrorCode.MERGE_BLOCKED, message, 422, [{ path: 'loserId', message }]);
  }
}

export class DuplicateRecordsError extends DomainError {
  constructor(details: readonly ErrorDetail[]) {
    super(
      ErrorCode.DUPLICATE_RECORDS,
      'This looks like a record that already exists. Link to it, or confirm you want a new one.',
      409,
      details,
    );
  }
}

export class SearchTimeoutError extends DomainError {
  constructor() {
    super(
      ErrorCode.SEARCH_TIMEOUT,
      'That search is too broad to answer quickly. Try a more specific search.',
      503,
    );
  }
}

export class FormExpiredError extends DomainError {
  constructor() {
    super(ErrorCode.FORM_EXPIRED, 'Please reload the page and send the form again.', 422);
  }
}

export class NoEmailAddressError extends DomainError {
  constructor() {
    super(
      ErrorCode.NO_EMAIL_ADDRESS,
      'This record has no email address you can send to. Add one to the record first.',
      422,
      [{ path: 'recordId', message: 'No email address' }],
    );
  }
}

export class ConsentWithdrawnError extends DomainError {
  constructor() {
    super(
      ErrorCode.CONSENT_WITHDRAWN,
      'This person has withdrawn consent to receive email, so it cannot be sent.',
      422,
      [{ path: 'recordId', message: 'Consent to email was withdrawn' }],
    );
  }
}

export class AddressSuppressedError extends DomainError {
  constructor(reason: 'hard_bounce' | 'complaint' | 'unsubscribed') {
    super(
      ErrorCode.ADDRESS_SUPPRESSED,
      'This address is blocked: it cannot be written to from here.',
      422,
      [{ path: 'recordId', message: 'Address blocked', meta: { reason } }],
    );
  }
}

export class EmailPausedError extends DomainError {
  constructor() {
    super(
      ErrorCode.EMAIL_PAUSED,
      'Email is paused for your company. An administrator can resume it.',
      409,
    );
  }
}

export class RateLimitedError extends DomainError {
  constructor(
    message = 'Too many requests',
    /** Whole seconds until the limit's window ends. Sent as `Retry-After`, never in the body. */
    readonly retryAfterSeconds?: number,
  ) {
    super(ErrorCode.RATE_LIMITED, message, 429);
  }
}

export class EntitlementRequiredError extends DomainError {
  constructor(feature: string) {
    super(
      ErrorCode.ENTITLEMENT_REQUIRED,
      'This feature is not included in your current plan',
      402,
      [{ message: 'Missing entitlement', meta: { feature } }],
    );
  }
}

export class FieldNotWritableError extends DomainError {
  constructor(fieldKeys: readonly string[]) {
    super(
      ErrorCode.FIELD_NOT_WRITABLE,
      'One or more fields cannot be written',
      403,
      fieldKeys.map((path) => ({ path, message: 'Field is not writable' })),
    );
  }
}

/**
 * Sign-in failed, without saying which half failed.
 *
 * One message and one code for a missing account and a wrong password. Telling
 * them apart is a user-enumeration oracle, and the only people it helps are
 * the ones trying addresses (MVP_SPEC M1).
 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super(ErrorCode.INVALID_CREDENTIALS, 'Incorrect email address or password', 401);
  }
}

/** A one-time token was wrong, already redeemed, or expired. */
export class InvalidTokenError extends DomainError {
  constructor(message = 'This link is invalid or has expired') {
    super(ErrorCode.INVALID_TOKEN, message, 400);
  }
}

/**
 * Public sign-up is closed on a single-tenant installation (ADR-0046). 403, not 404: the fact is
 * public (the sign-in screen does not offer the link) and a client that is told why can say why,
 * where a 404 would read as "this server is broken". It reveals nothing about any account.
 */
export class SignUpDisabledError extends DomainError {
  constructor() {
    super(
      ErrorCode.SIGN_UP_DISABLED,
      'Sign-up is not open on this installation. Ask an administrator to invite you.',
      403,
    );
  }
}

export class EmailNotVerifiedError extends DomainError {
  constructor() {
    super(ErrorCode.EMAIL_NOT_VERIFIED, 'Confirm your email address before signing in', 403);
  }
}

/**
 * The workspace requires MFA and this user has not enrolled.
 *
 * Distinct from `MFA_INVALID`: the client reacts by sending the user to
 * enrolment, not by asking for another code.
 */
export class MfaEnrolmentRequiredError extends DomainError {
  constructor() {
    super(
      ErrorCode.MFA_ENROLMENT_REQUIRED,
      'This workspace requires two-factor authentication. Set it up to continue.',
      403,
    );
  }
}

export class MfaInvalidError extends DomainError {
  constructor() {
    super(ErrorCode.MFA_INVALID, 'That code is not valid', 401);
  }
}

/**
 * The invited address already has an account (ADR-0019).
 *
 * An emailed link never issues a session for an account that already exists:
 * doing so would walk straight past a second factor the owner deliberately
 * enrolled. The recipient signs in — through MFA, if their account has it —
 * and the still-unconsumed invitation is accepted from that session.
 */
export class InvitationSignInRequiredError extends DomainError {
  constructor() {
    super(
      ErrorCode.INVITATION_SIGN_IN_REQUIRED,
      'This invitation was sent to an address that already has an account. Sign in to accept it.',
      401,
    );
  }
}

/**
 * Someone other than the invited address tried to accept (ADR-0019).
 *
 * The invitation is left untouched — not consumed, not transferred — so the
 * real recipient can still use it after signing in as themselves.
 */
export class InvitationRecipientMismatchError extends DomainError {
  constructor() {
    super(
      ErrorCode.INVITATION_RECIPIENT_MISMATCH,
      'This invitation was sent to a different address. Sign in as that person to accept it.',
      403,
    );
  }
}

export class LastAdministratorError extends DomainError {
  constructor() {
    super(
      ErrorCode.LAST_ADMINISTRATOR,
      'This would leave nobody able to manage roles and members. Keep at least one administrator.',
      409,
    );
  }
}

export class RoleInUseError extends DomainError {
  constructor(memberCount: number) {
    super(
      ErrorCode.ROLE_IN_USE,
      'Move this role’s members to another role before deleting it.',
      409,
      [{ message: 'Role has members', meta: { memberCount } }],
    );
  }
}

export class PermissionEscalationError extends DomainError {
  constructor(grants: readonly string[]) {
    super(
      ErrorCode.PERMISSION_ESCALATION,
      'You cannot grant access beyond what you hold yourself.',
      403,
      grants.map((path) => ({ path, message: 'Beyond your own access' })),
    );
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
