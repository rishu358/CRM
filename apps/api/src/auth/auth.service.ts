import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  EmailNotVerifiedError,
  generateOneTimeToken,
  hashOneTimeToken,
  InvalidCredentialsError,
  InvalidTokenError,
  MfaInvalidError,
  TOKEN_TTL_SECONDS,
  type Actor,
} from '@crm/core';
import type {
  Accepted,
  CurrentUser,
  MembershipSummary,
  SessionSummary,
  SignInResult,
} from '@crm/contracts';
import { FOUNDING_ROLE_NAME, provisionTenantDefaults } from '@crm/db/seed';
import { API_ENV_TOKEN, type ApiEnv } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { AuditService } from '../platform/audit.service.js';
import { EMAIL_PROVIDER, type EmailProvider } from '../platform/email/email.provider.js';
import { currentRequestContext } from '../common/request-context.js';
import { AuthRepository, type UserRow } from './auth.repository.js';
import { AuthThrottleService } from './auth-throttle.service.js';
import { MfaService } from './mfa.service.js';
import { SessionService } from './session.service.js';
import { PASSWORD_HASHER, type PasswordHasher } from './crypto/password.hasher.js';
import { mfaRequiredFor } from './tenant-settings.js';

/**
 * The authentication flows (MVP_SPEC M1, ADR-0014, ADR-0017).
 *
 * The cryptography is Better Auth's; the sequencing is ours. That split is
 * ADR-0017, and it is why this file is about *order* — what is checked before
 * what, what is written in the same transaction as what, and what the response
 * says in each case — rather than about hashing.
 *
 * ## The rule that shapes most of this file
 *
 * **No response may reveal whether an address has an account.** Sign-up,
 * resend-verification and forgot-password all return the same acknowledgement
 * whatever happened, and sign-in returns one error for "no such user" and
 * "wrong password". Doing otherwise turns the login form into a query
 * interface over our customers' staff directories.
 *
 * That rule costs real usability — someone who mistypes their address at
 * sign-up gets no warning — and it is still the right trade, because the
 * alternative leaks every address that has ever signed up.
 */
const CREDENTIAL_PROVIDER = 'credential';

interface SignInContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(AuthThrottleService) private readonly throttle: AuthThrottleService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(API_ENV_TOKEN) private readonly env: ApiEnv,
  ) {}

  // -------------------------------------------------------------------------
  // Sign-up
  // -------------------------------------------------------------------------

  /**
   * Create an account and its first workspace.
   *
   * Always returns the same acknowledgement. An address that already has an
   * account gets an email saying so — which is useful to the person who owns
   * it and useless to anyone else, because the HTTP response is identical.
   *
   * ## Why a workspace is created here
   *
   * Full onboarding is M2. But a user with no membership cannot get past
   * `AuthGuard`, so an M1 that only created the identity would produce
   * accounts that can sign in and do nothing. This calls the same
   * `provisionTenantDefaults` M2 will use, and nothing more — no sample data,
   * no checklist, no business rules invented here.
   */
  async signUp(input: {
    email: string;
    password: string;
    name: string;
    companyName?: string | undefined;
  }): Promise<Accepted> {
    const existing = await this.repository.findUserByEmail(input.email);

    if (existing !== null) {
      await this.throttle.recordEvent('signup_duplicate', false, { email: input.email });
      await this.sendAccountExists(input.email);
      return { accepted: true };
    }

    const passwordHash = await this.passwords.hash(input.password);
    const workspaceName = input.companyName ?? `${input.name}'s workspace`;

    // 1. Identity and its workspace shell, in one identity transaction. The
    //    tenant starts as 'provisioning' because it has no roles yet, so a
    //    failure in step 2 leaves something visibly unfinished rather than
    //    something that looks healthy and is not.
    const { userId, tenantId } = await this.repository.transaction(async (tx) => {
      const tenant = await this.repository.createTenant(
        { name: workspaceName, slug: this.uniqueSlug(workspaceName), status: 'provisioning' },
        tx,
      );
      const user = await this.repository.createUser({ email: input.email, name: input.name }, tx);
      await this.repository.upsertCredential(
        {
          userId: user,
          providerId: CREDENTIAL_PROVIDER,
          accountId: input.email,
          passwordHash,
        },
        tx,
      );
      return { userId: user, tenantId: tenant };
    });

    try {
      // 2. Roles and field metadata, as crm_app inside the new tenant's
      //    context. A different role and therefore a different connection, so
      //    this cannot be the same transaction as step 1 — the role split
      //    (ADR-0002) is worth more than the atomicity here, because step 3
      //    makes the result self-correcting.
      const roleIds = await this.database.runInTenant({ tenantId, userId }, (tx) =>
        provisionTenantDefaults(tx, tenantId, userId),
      );
      const ownerRoleId = roleIds.roleIdsByName.get(FOUNDING_ROLE_NAME);
      if (ownerRoleId === undefined) throw new Error('Provisioning produced no founding role');

      // 3. Membership and activation, back as crm_auth and atomic: until this
      //    commits the user has no workspace, and after it they have a
      //    complete one.
      await this.repository.transaction(async (tx) => {
        await this.repository.createMembership({ tenantId, userId, roleId: ownerRoleId }, tx);
        await this.repository.activateTenant(tenantId, tx);
      });
    } catch (error) {
      // Leave nothing half-made that would block a retry: without this, a
      // transient failure here would permanently reserve the address, and the
      // no-enumeration rule means the user would never be told why.
      await this.repository.transaction((tx) => this.repository.deleteUser(userId, tx));
      throw error;
    }

    await this.throttle.recordEvent('signup', true, { email: input.email, userId });
    await this.issueEmailVerification(userId, input.email, input.name);
    return { accepted: true };
  }

  // -------------------------------------------------------------------------
  // Email verification
  // -------------------------------------------------------------------------

  async resendVerification(email: string): Promise<Accepted> {
    const user = await this.repository.findUserByEmail(email);
    // Same answer either way. A 404 here would confirm the address is unknown.
    if (user !== null && user.deleted_at === null && user.email_verified_at === null) {
      await this.issueEmailVerification(user.id, user.email, user.name);
    }
    return { accepted: true };
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.repository.consumeVerification(
      hashOneTimeToken(token),
      'email_verification',
    );
    if (record === null || record.user_id === null) throw new InvalidTokenError();

    await this.repository.markEmailVerified(record.user_id);
    await this.throttle.recordEvent('email_verified', true, {
      userId: record.user_id,
      email: record.identifier,
    });
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  /**
   * Check a password and either sign the user in or challenge for MFA.
   *
   * The order here matters and is deliberate:
   *   1. wait out any back-off, before touching the password
   *   2. hash-compare — against a dummy hash when there is no user, so the
   *      timing is the same either way
   *   3. only then branch on verification state and MFA
   */
  async signIn(
    input: { email: string; password: string },
    context: SignInContext,
  ): Promise<SignInResult> {
    await this.throttle.applyDelay(input.email);

    const user = await this.repository.findUserByEmail(input.email);

    if (user === null || user.deleted_at !== null) {
      // Burn comparable time so an unknown address is not identifiable by how
      // quickly it is refused.
      await this.passwords.verifyDummy(input.password);
      await this.throttle.recordEvent('login_failed', false, { email: input.email });
      throw new InvalidCredentialsError();
    }

    const credential = await this.repository.findCredential(user.id, CREDENTIAL_PROVIDER);
    const hash = credential?.password_hash ?? null;

    // A Google-only account has no password hash. Same dummy-verify, same
    // error: "this account exists but uses Google" is still enumeration.
    if (hash === null) {
      await this.passwords.verifyDummy(input.password);
      await this.throttle.recordEvent('login_failed', false, {
        email: input.email,
        userId: user.id,
      });
      throw new InvalidCredentialsError();
    }

    if (!(await this.passwords.verify(hash, input.password))) {
      await this.throttle.recordEvent('login_failed', false, {
        email: input.email,
        userId: user.id,
      });
      throw new InvalidCredentialsError();
    }

    if (user.email_verified_at === null) {
      await this.throttle.recordEvent('login_unverified', false, {
        email: input.email,
        userId: user.id,
      });
      throw new EmailNotVerifiedError();
    }

    if (await this.mfa.isEnrolled(user.id)) {
      const challengeToken = await this.issueChallenge(user);
      await this.throttle.recordEvent('mfa_challenged', true, {
        email: user.email,
        userId: user.id,
      });
      return { status: 'mfa_required', challengeToken };
    }

    return this.completeSignIn(user, context);
  }

  /** Second step of a sign-in that was challenged for MFA. */
  async verifyMfaChallenge(
    input: { challengeToken: string; code: string },
    context: SignInContext,
  ): Promise<SignInResult> {
    const record = await this.repository.consumeVerification(
      hashOneTimeToken(input.challengeToken),
      'mfa_challenge',
    );
    if (record === null || record.user_id === null) throw new InvalidTokenError();

    const user = await this.repository.findUserById(record.user_id);
    if (user === null) throw new InvalidTokenError();

    await this.throttle.applyDelay(user.email);

    if (!(await this.mfa.verify(user.id, input.code))) {
      // Counted as a failed login so repeated code guessing is throttled by
      // the same mechanism as password guessing.
      await this.throttle.recordEvent('login_failed', false, {
        email: user.email,
        userId: user.id,
      });
      throw new MfaInvalidError();
    }

    return this.completeSignIn(user, context);
  }

  /**
   * Issue the session and write the audit entry.
   *
   * The audit entry is written as `crm_app` inside the tenant the user lands
   * in, because `audit_logs` is tenant-owned and `crm_auth` has no grant on
   * it. A user with no active membership gets a session with no tenant — and
   * so no audit row, because there is no tenant for it to belong to.
   */
  private async completeSignIn(user: UserRow, context: SignInContext): Promise<SignInResult> {
    const memberships = await this.repository.listMemberships(user.id);
    const tenantId = memberships[0]?.tenant_id ?? null;

    const { token, sessionId } = await this.sessions.issue(user.id, {
      tenantId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    await this.throttle.recordEvent('login_succeeded', true, {
      email: user.email,
      userId: user.id,
    });

    if (tenantId !== null) {
      await this.auditLogin(tenantId, user.id, sessionId, 'login');
    }

    return { status: 'signed_in', token, tenantId };
  }

  /**
   * Finish a sign-in that came through an identity provider.
   *
   * No password and no MFA challenge: the provider has already authenticated
   * the person, and a user who signs in with Google has no password here to
   * step up with. Workspace-level MFA enforcement still applies on the next
   * request, through `AuthGuard` — so a Google user in a workspace that
   * requires MFA gets a session and is immediately sent to enrol, rather than
   * being refused with nothing to act on.
   */
  async completeSocialSignIn(userId: string): Promise<string> {
    const user = await this.repository.findUserById(userId);
    if (user === null) throw new InvalidCredentialsError();

    const context = currentRequestContext();
    const result = await this.completeSignIn(user, {
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });

    if (result.status !== 'signed_in' || result.token === undefined) {
      throw new InvalidCredentialsError();
    }
    return result.token;
  }

  // -------------------------------------------------------------------------
  // Identity, for the invitations module (MVP_SPEC M2, ADR-0019)
  //
  // Four narrow methods rather than letting another module import
  // `AuthRepository`: modules talk through services (CLAUDE.md §3), and the
  // identity tables are the last place to make an exception. Each one answers
  // exactly one question the invitation flow has to ask.
  // -------------------------------------------------------------------------

  /**
   * Is there an account at this address, and what is the person called?
   *
   * Server-side only. Nothing derived from this may reach a response except
   * to somebody holding an invitation token mailed to that very address
   * (ADR-0019) — anywhere else it is the enumeration oracle this module
   * spends most of its effort avoiding.
   */
  async findAccountByEmail(email: string): Promise<{ userId: string; name: string } | null> {
    const user = await this.repository.findUserByEmail(email);
    if (user === null || user.deleted_at !== null) return null;
    return { userId: user.id, name: user.name };
  }

  async emailForUser(userId: string): Promise<string | null> {
    const user = await this.repository.findUserById(userId);
    return user?.email ?? null;
  }

  /**
   * Create the account an invitation's recipient does not have yet.
   *
   * The address is marked verified on creation, because the invitation token
   * arrived in that mailbox and was redeemed from it — the same proof the
   * verification link exists to collect. Sending a second link to confirm
   * what has just been confirmed would strand new team members behind an
   * email they have no reason to expect.
   *
   * No workspace is provisioned: the invitation supplies one. That is the
   * difference between this and `signUp`.
   */
  async createInvitedAccount(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<string> {
    const passwordHash = await this.passwords.hash(input.password);

    const userId = await this.repository.transaction(async (tx) => {
      const id = await this.repository.createUser(
        { email: input.email, name: input.name, emailVerified: true },
        tx,
      );
      await this.repository.upsertCredential(
        {
          userId: id,
          providerId: CREDENTIAL_PROVIDER,
          accountId: input.email,
          passwordHash,
        },
        tx,
      );
      return id;
    });

    await this.throttle.recordEvent('signup', true, { email: input.email, userId });
    return userId;
  }

  /**
   * Undo `createInvitedAccount` when the acceptance it was made for fails.
   *
   * Same compensation as `signUp`'s: leaving a half-made account behind would
   * permanently reserve the address, and the no-enumeration rule means the
   * person would never be told why their next attempt did nothing.
   */
  async discardInvitedAccount(userId: string): Promise<void> {
    await this.repository.transaction((tx) => this.repository.deleteUser(userId, tx));
  }

  /** Issue a session in a named workspace. Used once an invitation is accepted. */
  async startSessionIn(userId: string, tenantId: string): Promise<string> {
    const context = currentRequestContext();
    const { token, sessionId } = await this.sessions.issue(userId, {
      tenantId,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });
    await this.throttle.recordEvent('login_succeeded', true, { userId });
    await this.auditLogin(tenantId, userId, sessionId, 'login');
    return token;
  }

  /** Point an existing session at the workspace its owner has just joined. */
  async switchSessionTo(sessionId: string, tenantId: string): Promise<void> {
    await this.repository.setSessionTenant(sessionId, tenantId);
  }

  // -------------------------------------------------------------------------
  // Sign-out
  // -------------------------------------------------------------------------

  async signOut(actor: Actor, sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
    await this.throttle.recordEvent('logout', true, { userId: actor.userId });
    await this.auditLogin(actor.tenantId, actor.userId, sessionId, 'logout');
  }

  // -------------------------------------------------------------------------
  // Passwords
  // -------------------------------------------------------------------------

  async forgotPassword(email: string): Promise<Accepted> {
    const user = await this.repository.findUserByEmail(email);

    if (user !== null && user.deleted_at === null) {
      const token = generateOneTimeToken();
      await this.repository.transaction(async (tx) => {
        // Retire any outstanding link first, so recovering an account also
        // invalidates a link an attacker triggered moments earlier.
        await this.repository.consumeOutstanding(user.id, 'password_reset', tx);
        await this.repository.createVerification(
          {
            identifier: user.email,
            valueHash: hashOneTimeToken(token),
            purpose: 'password_reset',
            userId: user.id,
            expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS.password_reset * 1000),
          },
          tx,
        );
      });

      await this.email.send({
        to: user.email,
        subject: 'Reset your CRM password',
        text:
          `Hello ${user.name},\n\n` +
          `Open this link to choose a new password. It expires in one hour and ` +
          `can be used once:\n\n${this.env.WEB_URL}/reset-password?token=${token}\n\n` +
          `If you did not ask for this, you can ignore this email — your password ` +
          `has not changed.\n`,
      });
      await this.throttle.recordEvent('password_reset_requested', true, {
        email: user.email,
        userId: user.id,
      });
    } else {
      await this.throttle.recordEvent('password_reset_requested', false, { email });
    }

    return { accepted: true };
  }

  /**
   * Set a new password from a reset link.
   *
   * Revokes every session, including the one that may be making this request:
   * a reset is what someone does when they think the account is compromised,
   * and leaving the attacker's session alive would defeat the point.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    const record = await this.repository.consumeVerification(
      hashOneTimeToken(token),
      'password_reset',
    );
    if (record === null || record.user_id === null) throw new InvalidTokenError();

    const userId = record.user_id;
    const passwordHash = await this.passwords.hash(password);

    await this.repository.transaction(async (tx) => {
      await this.repository.setPassword(userId, passwordHash, tx);
      await this.repository.bumpSessionsValidFrom(userId, tx);
      await this.repository.revokeOtherSessions(userId, null, tx);
      // An address someone has just proved they can read is a verified
      // address, so a user who never clicked the first link is not stranded.
      await this.repository.markEmailVerified(userId, tx);
    });

    await this.throttle.recordEvent('password_reset', true, {
      email: record.identifier,
      userId,
    });
    await this.auditPasswordChange(userId, 'password_reset');
  }

  /**
   * Change the password while signed in (MVP_SPEC M1 acceptance).
   *
   * > Changing the password revokes all other sessions.
   *
   * Implemented by bumping `sessions_valid_from`, which `SessionService.verify`
   * already checks on every request — one write, no sweep, and no window in
   * which a session created mid-change survives.
   */
  async changePassword(
    actor: Actor,
    sessionId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ token: string }> {
    const credential = await this.repository.findCredential(actor.userId, CREDENTIAL_PROVIDER);
    const hash = credential?.password_hash ?? null;
    if (hash === null || !(await this.passwords.verify(hash, input.currentPassword))) {
      await this.throttle.recordEvent('password_change_failed', false, { userId: actor.userId });
      throw new InvalidCredentialsError();
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.repository.transaction(async (tx) => {
      await this.repository.setPassword(actor.userId, passwordHash, tx);
      await this.repository.bumpSessionsValidFrom(actor.userId, tx);
      await this.repository.revokeOtherSessions(actor.userId, sessionId, tx);
    });

    // The caller's own session was issued before the bump, so it is invalid
    // now too. Rather than signing them out of the device in their hand —
    // "change my password" does not mean "log me out of this browser" — issue
    // a replacement and revoke the old one.
    //
    // Returned, not stashed on the service: this is a singleton, and a field
    // holding the last token would hand one user another user's session the
    // moment two password changes overlapped.
    const context = currentRequestContext();
    const replacement = await this.sessions.issue(actor.userId, {
      tenantId: actor.tenantId,
      ipAddress: context?.ipAddress ?? null,
      userAgent: context?.userAgent ?? null,
    });
    await this.sessions.revoke(sessionId);

    await this.throttle.recordEvent('password_changed', true, { userId: actor.userId });
    await this.auditPasswordChange(actor.userId, 'password_changed', actor.tenantId);

    return { token: replacement.token };
  }

  // -------------------------------------------------------------------------
  // Sessions and profile
  // -------------------------------------------------------------------------

  async currentUser(actor: Actor): Promise<CurrentUser> {
    const user = await this.repository.findUserById(actor.userId);
    if (user === null) throw new InvalidCredentialsError();

    const memberships = await this.repository.listMemberships(actor.userId);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      locale: user.locale,
      timezone: user.timezone,
      emailVerified: user.email_verified_at !== null,
      mfaEnabled: user.mfa_enabled,
      activeTenantId: actor.tenantId,
      memberships: memberships.map((row): MembershipSummary => ({
        tenantId: row.tenant_id,
        name: row.name,
        slug: row.slug,
        roleName: row.role_name,
        mfaRequired: mfaRequiredFor(row.settings),
      })),
    };
  }

  async listSessions(actor: Actor, currentSessionId: string): Promise<SessionSummary[]> {
    const rows = await this.repository.listSessions(actor.userId);
    return rows.map((row): SessionSummary => ({
      id: row.id,
      current: row.id === currentSessionId,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
    }));
  }

  /** "Sign out other devices" (MVP_SPEC M1). Keeps the caller signed in. */
  async signOutOtherSessions(actor: Actor, currentSessionId: string): Promise<number> {
    const revoked = await this.repository.revokeOtherSessions(actor.userId, currentSessionId);
    await this.throttle.recordEvent('sessions_revoked', true, { userId: actor.userId });
    await this.auditLogin(actor.tenantId, actor.userId, currentSessionId, 'logout', {
      revoked: { new: revoked },
    });
    return revoked;
  }

  /** Revoke one named session. Refuses silently for one that is not theirs. */
  async revokeSession(actor: Actor, sessionId: string): Promise<boolean> {
    return this.repository.revokeSessionForUser(sessionId, actor.userId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async issueEmailVerification(userId: string, email: string, name: string): Promise<void> {
    const token = generateOneTimeToken();
    await this.repository.transaction(async (tx) => {
      await this.repository.consumeOutstanding(userId, 'email_verification', tx);
      await this.repository.createVerification(
        {
          identifier: email,
          valueHash: hashOneTimeToken(token),
          purpose: 'email_verification',
          userId,
          expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS.email_verification * 1000),
        },
        tx,
      );
    });

    await this.email.send({
      to: email,
      subject: 'Confirm your email address',
      text:
        `Hello ${name},\n\n` +
        `Confirm your address to finish setting up your CRM account. This link ` +
        `expires in 24 hours:\n\n${this.env.WEB_URL}/verify-email?token=${token}\n`,
    });
  }

  private async sendAccountExists(email: string): Promise<void> {
    await this.email.send({
      to: email,
      subject: 'You already have a CRM account',
      text:
        `Somebody tried to create a CRM account with this address, and one ` +
        `already exists.\n\n` +
        `If that was you, sign in instead: ${this.env.WEB_URL}/sign-in\n` +
        `If you have forgotten your password: ${this.env.WEB_URL}/forgot-password\n\n` +
        `If it was not you, no action is needed — nothing has changed.\n`,
    });
  }

  private async issueChallenge(user: UserRow): Promise<string> {
    const token = generateOneTimeToken();
    await this.repository.transaction(async (tx) => {
      await this.repository.consumeOutstanding(user.id, 'mfa_challenge', tx);
      await this.repository.createVerification(
        {
          identifier: user.email,
          valueHash: hashOneTimeToken(token),
          purpose: 'mfa_challenge',
          userId: user.id,
          expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS.mfa_challenge * 1000),
        },
        tx,
      );
    });
    return token;
  }

  /**
   * A slug nothing else is using.
   *
   * Collisions are expected — two "Acme" workspaces is normal — so this adds a
   * short random suffix rather than looping on a counter, which would both
   * leak how many similarly named workspaces exist and race under concurrency.
   */
  private uniqueSlug(name: string): string {
    const base =
      name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';
    return `${base}-${randomBytes(4).toString('hex')}`;
  }

  private async auditLogin(
    tenantId: string,
    userId: string,
    sessionId: string,
    action: 'login' | 'logout',
    changes?: Record<string, { old?: unknown; new?: unknown }>,
  ): Promise<void> {
    await this.database.runInTenant({ tenantId, userId }, (tx) =>
      this.audit.record(
        tx,
        { tenantId, userId },
        {
          action,
          objectType: 'session',
          recordId: sessionId,
          ...(changes === undefined ? {} : { changes }),
        },
      ),
    );
  }

  /**
   * Audit a password change in every workspace the user belongs to.
   *
   * A password change is not scoped to one tenant — it affects access to all
   * of them — so an administrator of any of those workspaces has a legitimate
   * reason to see it in their audit log (CLAUDE.md §5.10).
   */
  private async auditPasswordChange(
    userId: string,
    action: string,
    preferredTenantId?: string,
  ): Promise<void> {
    const memberships = await this.repository.listMemberships(userId);
    const tenantIds =
      preferredTenantId === undefined
        ? memberships.map((row) => row.tenant_id)
        : [
            preferredTenantId,
            ...memberships.map((row) => row.tenant_id).filter((id) => id !== preferredTenantId),
          ];

    for (const tenantId of tenantIds) {
      await this.database.runInTenant({ tenantId, userId }, (tx) =>
        this.audit.record(
          tx,
          { tenantId, userId },
          {
            action: 'update',
            objectType: 'user',
            recordId: userId,
            changes: { password: { new: action } },
          },
        ),
      );
    }
  }
}
