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
   * The change hands out more than the person making it holds. Distinct from
   * `FORBIDDEN`: they may edit roles, just not beyond their own reach (ADR-0031).
   */
  PERMISSION_ESCALATION: 'PERMISSION_ESCALATION',
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

export class RateLimitedError extends DomainError {
  constructor(message = 'Too many requests') {
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
