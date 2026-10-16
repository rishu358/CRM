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

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
