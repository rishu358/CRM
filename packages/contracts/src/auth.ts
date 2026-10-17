import { emailSchema, passwordSchema } from '@crm/core/auth';
import { z } from 'zod';

/**
 * Authentication API contracts (MVP_SPEC M1, ADR-0007, ADR-0017).
 *
 * Shared by the API and the sign-in screens, so the form and the endpoint
 * agree on what a valid password is. Every object is `.strict()`: an unknown
 * key is a 422 (CLAUDE.md §5.6), which on these endpoints also means a client
 * cannot smuggle in `tenantId`, `role` or `emailVerified` and hope something
 * reads it.
 *
 * Note what is **not** here: no request carries a user id, a tenant id or a
 * role. All three come from the session on the server (CLAUDE.md §5.2).
 */

/** A six-digit TOTP code, or a backup code like `A2C4-E6G8`. */
const mfaCodeSchema = z.string().trim().min(6).max(20);

const tokenSchema = z.string().min(16).max(512);

export const signUpSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().trim().min(1).max(120),
    /** Optional: names the workspace created alongside the account. */
    companyName: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z
  .object({
    email: emailSchema,
    // Not `passwordSchema`: an existing password that predates a policy change
    // must still be usable to sign in, and validating it here would also leak
    // the policy's shape to anyone probing.
    password: z.string().min(1).max(200),
  })
  .strict();

export type SignInInput = z.infer<typeof signInSchema>;

/**
 * Sign-in outcome.
 *
 * `mfa_required` is a success, not an error: credentials were correct and the
 * flow continues. It carries a short-lived challenge token rather than leaving
 * the browser to re-send the password with the code.
 */
export const signInResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('signed_in'),
    /** Present only for non-browser clients; the browser gets a cookie. */
    token: z.string().optional(),
    tenantId: z.uuid().nullable(),
  }),
  z.object({
    status: z.literal('mfa_required'),
    challengeToken: z.string(),
  }),
]);

export type SignInResult = z.infer<typeof signInResultSchema>;

export const mfaVerifySchema = z
  .object({
    challengeToken: tokenSchema,
    code: mfaCodeSchema,
  })
  .strict();

export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const verifyEmailSchema = z.object({ token: tokenSchema }).strict();
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const resendVerificationSchema = z.object({ email: emailSchema }).strict();
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({ token: tokenSchema, password: passwordSchema })
  .strict();
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  })
  .strict();
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Returned once, at enrolment. The secret is never readable again. */
export const mfaEnrolmentSchema = z.object({
  secret: z.string(),
  /** `otpauth://totp/...`, for the QR code. */
  otpauthUrl: z.string(),
  backupCodes: z.array(z.string()),
});
export type MfaEnrolment = z.infer<typeof mfaEnrolmentSchema>;

export const mfaActivateSchema = z.object({ code: mfaCodeSchema }).strict();
export type MfaActivateInput = z.infer<typeof mfaActivateSchema>;

export const mfaDisableSchema = z.object({ password: z.string().min(1).max(200) }).strict();
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;

/**
 * A session on the "your devices" screen.
 *
 * No token, not even a prefix: this list is readable by anyone holding one
 * session, and a fragment of another session's token is a head start on it.
 * `current` is what lets someone tell which row is the device in their hand.
 */
export const sessionSummarySchema = z.object({
  id: z.uuid(),
  current: z.boolean(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  expiresAt: z.string(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** A workspace this user belongs to. */
export const membershipSummarySchema = z.object({
  tenantId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  roleName: z.string(),
  mfaRequired: z.boolean(),
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

export const currentUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
  activeTenantId: z.uuid().nullable(),
  memberships: z.array(membershipSummarySchema),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

/**
 * Acknowledgement for flows that must not say whether the address exists.
 *
 * Sign-up, resend-verification and forgot-password all return this, always,
 * whatever happened (MVP_SPEC M1).
 */
export const acceptedSchema = z.object({ accepted: z.literal(true) });
export type Accepted = z.infer<typeof acceptedSchema>;
